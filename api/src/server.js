import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { router as adminRouter } from './admin.js';
import { pool, tx } from './db.js';
import { linkLead, router as leadsRouter } from './leads.js';

const PORT = Number(process.env.PORT || 3014);
const API_TOKEN = process.env.API_TOKEN;
const ALLOWED_IPS = (process.env.ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!API_TOKEN) throw new Error('API_TOKEN is required');

const MARK_FIELDS = { clicked: 'clicked_at', video: 'video_at', offer: 'offer_at', paid: 'paid_at', blocked: 'blocked_at' };
const USER_FIELDS = ['username', 'first_name', 'last_name', 'start_param', 'gc_user_id', 'email'];

const app = express();
app.set('trust proxy', false);
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.use((req, res, next) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ALLOWED_IPS.length && !ALLOWED_IPS.includes(ip) && ip !== '127.0.0.1') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const auth = req.get('authorization') || '';
  const given = Buffer.from(auth.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(API_TOKEN);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// Всё, что нужно админке и рассылкам, лежит отдельным роутером.
app.use(adminRouter);
app.use(leadsRouter);

const wrap = fn => (req, res, next) => fn(req, res).catch(next);

function newToken() {
  return crypto.randomBytes(12).toString('base64url');
}

// Parses the /start payload: "u123" -> GetCourse user id, "e_<base64url>" -> email.
function parseStartParam(param) {
  const out = {};
  if (!param) return out;
  const gc = param.match(/^u(\d{1,20})$/);
  if (gc) out.gc_user_id = gc[1];
  const em = param.match(/^e_([A-Za-z0-9_-]+)$/);
  if (em) {
    const email = Buffer.from(em[1], 'base64url').toString('utf8').trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.email = email;
  }
  return out;
}

// /start: create the user or refresh profile fields. isNew tells the bot whether to launch the funnel.
app.post('/users/start', wrap(async (req, res) => {
  const { tg_id, username, first_name, last_name, start_param, time_scale } = req.body;
  if (!tg_id) return res.status(400).json({ error: 'tg_id required' });
  const parsed = parseStartParam(start_param);

  const result = await tx(async client => {
    // ON CONFLICT: two quick /start presses must not fail on the unique tg_id
    const inserted = await client.query(
      `INSERT INTO users (tg_id, username, first_name, last_name, start_param, gc_user_id, email, token, time_scale)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tg_id) DO NOTHING RETURNING *`,
      [tg_id, username ?? null, first_name ?? null, last_name ?? null, start_param ?? null,
        parsed.gc_user_id ?? null, parsed.email ?? null, newToken(), Number(time_scale) || 1]
    );
    if (inserted.rows[0]) {
      await client.query(`INSERT INTO events (user_id, type, data) VALUES ($1, 'start', $2)`, [inserted.rows[0].id, { start_param }]);
      await linkLead(client, inserted.rows[0].id, start_param);
      return { user: inserted.rows[0], isNew: true, wasBlocked: false };
    }
    const existing = await client.query('SELECT * FROM users WHERE tg_id = $1 FOR UPDATE', [tg_id]);
    const u = existing.rows[0];
    const { rows } = await client.query(
      `UPDATE users SET username = $2, first_name = $3, last_name = $4,
         gc_user_id = COALESCE(gc_user_id, $5), email = COALESCE(email, $6),
         blocked_at = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [u.id, username ?? null, first_name ?? null, last_name ?? null, parsed.gc_user_id ?? null, parsed.email ?? null]
    );
    await client.query(`INSERT INTO events (user_id, type, data) VALUES ($1, 'restart', $2)`, [u.id, { start_param }]);
    // Уже знакомый человек пришёл по новой заявке с лендинга — заявку тоже связываем.
    await linkLead(client, u.id, start_param);
    return { user: rows[0], isNew: false, wasBlocked: u.blocked_at !== null };
  });

  res.json(result);
}));

app.get('/users/by-token/:token', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE token = $1', [req.params.token]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ user: rows[0] });
}));

app.get('/users/by-tg/:tgId', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE tg_id = $1', [req.params.tgId]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ user: rows[0] });
}));

app.get('/users/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ user: rows[0] });
}));

app.patch('/users/:id', wrap(async (req, res) => {
  const sets = [];
  const values = [req.params.id];
  for (const f of USER_FIELDS) {
    if (req.body[f] !== undefined) {
      values.push(req.body[f]);
      sets.push(`${f} = $${values.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, values
  );
  res.json({ user: rows[0] });
}));

// Sets a milestone timestamp once. first=true only on the first mark, so the bot reacts once.
app.post('/users/:id/mark', wrap(async (req, res) => {
  const column = MARK_FIELDS[req.body.what];
  if (!column) return res.status(400).json({ error: 'unknown mark' });

  const result = await tx(async client => {
    const current = await client.query(`SELECT ${column} AS value FROM users WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!current.rows[0]) return null;
    const first = current.rows[0].value === null;
    const { rows } = await client.query(
      `UPDATE users SET ${column} = COALESCE(${column}, now()), updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    await client.query(`INSERT INTO events (user_id, type, data) VALUES ($1, $2, $3)`,
      [req.params.id, req.body.what, { ...(req.body.data ?? {}), first }]);
    return { user: rows[0], first };
  });

  if (!result) return res.status(404).json({ error: 'not found' });
  res.json(result);
}));

// Payment from GetCourse: matches by GetCourse user id or email, marks paid, returns users that became paid now.
app.post('/payments', wrap(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase() || null;
  const gcUserId = req.body.gc_user_id ? String(req.body.gc_user_id) : null;
  if (!email && !gcUserId) return res.status(400).json({ error: 'email or gc_user_id required' });

  const { rows } = await pool.query(
    `UPDATE users SET paid_at = now(), email = COALESCE(email, $1), updated_at = now()
     WHERE paid_at IS NULL AND (($1::text IS NOT NULL AND lower(email) = $1) OR ($2::text IS NOT NULL AND gc_user_id = $2))
     RETURNING *`,
    [email, gcUserId]
  );
  await pool.query(`INSERT INTO events (user_id, type, data) VALUES ($1, 'payment_hook', $2)`,
    [rows[0]?.id ?? null, { email, gc_user_id: gcUserId, matched: rows.map(r => r.id), raw: req.body.raw ?? null }]);
  res.json({ users: rows });
}));

app.post('/events', wrap(async (req, res) => {
  const { user_id, type, data } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });
  await pool.query(`INSERT INTO events (user_id, type, data) VALUES ($1, $2, $3)`, [user_id ?? null, type, data ?? {}]);
  res.json({ ok: true });
}));

app.post('/jobs', wrap(async (req, res) => {
  const { user_id, step, delay_sec } = req.body;
  if (!user_id || !step) return res.status(400).json({ error: 'user_id and step required' });
  const { rows } = await pool.query(
    `INSERT INTO jobs (user_id, step, run_at) VALUES ($1, $2, now() + make_interval(secs => $3)) RETURNING *`,
    [user_id, step, Number(delay_sec) || 0]
  );
  res.json({ job: rows[0] });
}));

// Cancels pending jobs of a user. steps omitted -> all pending jobs.
app.post('/jobs/cancel', wrap(async (req, res) => {
  const { user_id, steps } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const { rowCount } = await pool.query(
    `UPDATE jobs SET status = 'canceled', updated_at = now()
     WHERE user_id = $1 AND status = 'pending' AND ($2::text[] IS NULL OR step = ANY($2))`,
    [user_id, Array.isArray(steps) && steps.length ? steps : null]
  );
  res.json({ canceled: rowCount });
}));

// Claims due jobs for the worker. Jobs stuck in "running" for 10 minutes are picked up again.
app.post('/jobs/claim', wrap(async (req, res) => {
  const limit = Math.min(Number(req.body.limit) || 20, 100);
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE (status = 'pending' AND run_at <= now())
          OR (status = 'running' AND updated_at < now() - interval '10 minutes')
       ORDER BY run_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit]
  );
  res.json({ jobs: rows });
}));

app.post('/jobs/:id/done', wrap(async (req, res) => {
  await pool.query(`UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// Failed attempt: retry later, or give up after max attempts.
app.post('/jobs/:id/fail', wrap(async (req, res) => {
  const maxAttempts = Number(req.body.max_attempts) || 5;
  const retryIn = Number(req.body.retry_in_sec) || 60;
  await pool.query(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
       run_at = now() + make_interval(secs => $3),
       last_error = $4, updated_at = now()
     WHERE id = $1`,
    [req.params.id, maxAttempts, retryIn, String(req.body.error || '').slice(0, 2000)]
  );
  res.json({ ok: true });
}));

app.get('/stats', wrap(async (_req, res) => {
  const { rows: [funnel] } = await pool.query(`
    SELECT
      count(*)::int AS users,
      count(clicked_at)::int AS clicked,
      count(video_at)::int AS video_opened,
      count(offer_at)::int AS reached_offer,
      count(paid_at)::int AS paid,
      count(blocked_at)::int AS blocked,
      count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS users_24h
    FROM users`);
  const { rows: sent } = await pool.query(`
    SELECT data->>'step' AS step, count(*)::int AS count
    FROM events WHERE type = 'sent' GROUP BY 1 ORDER BY 2 DESC`);
  const { rows: jobs } = await pool.query(`SELECT status, count(*)::int AS count FROM jobs GROUP BY 1`);
  res.json({ funnel, sent, jobs });
}));

// Admin: wipe a user so the funnel can be re-tested from scratch.
app.delete('/users/by-tg/:tgId', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM users WHERE tg_id = $1', [req.params.tgId]);
  res.json({ deleted: rowCount });
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => console.log(`w3a-funnel-api listening on :${PORT}`));
