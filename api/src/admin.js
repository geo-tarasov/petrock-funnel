// Данные для админки и рассылок. Живёт на RU рядом с остальной базой.
// Router монтируется в server.js уже за проверкой токена и IP.

import crypto from 'node:crypto';
import express from 'express';
import { pool, tx } from './db.js';
import { videoInfo } from './mp4.js';
import { hashPassword, verifyPassword } from './password.js';

export const router = express.Router();

const wrap = fn => (req, res, next) => fn(req, res).catch(next);

const ROLES = ['owner', 'editor', 'marketer', 'viewer'];
const GUARDS = ['active', 'not_clicked', 'clicked', 'offer', 'paid', 'not_watched'];
const TRIGGERS = ['start', 'restart', 'click', 'offer', 'paid'];
const MEDIA_KINDS = ['photo', 'video_note', 'video'];
const SESSION_DAYS = 30;
const KEY_RE = /^[a-z0-9_]{2,40}$/;

const SEGMENTS = {
  all: 'blocked_at IS NULL',
  clicked: 'blocked_at IS NULL AND clicked_at IS NOT NULL',
  not_clicked: 'blocked_at IS NULL AND clicked_at IS NULL',
  offer: 'blocked_at IS NULL AND offer_at IS NOT NULL',
  not_offer: 'blocked_at IS NULL AND offer_at IS NULL',
  paid: 'blocked_at IS NULL AND paid_at IS NOT NULL',
  not_paid: 'blocked_at IS NULL AND paid_at IS NULL',
  blocked: 'blocked_at IS NOT NULL',
};

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const publicAdmin = a => a && ({
  id: a.id, login: a.login, name: a.name, role: a.role, tg_id: a.tg_id == null ? null : String(a.tg_id),
  disabled: a.disabled, created_at: a.created_at, last_login_at: a.last_login_at,
});

// Кто именно правит — админка передаёт в заголовках, пишем в журнал действий.
async function audit(req, action, target, data = {}) {
  await pool.query(
    'INSERT INTO audit (admin_id, login, action, target, data) VALUES ($1,$2,$3,$4,$5)',
    [req.get('x-actor-id') || null, req.get('x-actor-login') || null, action, target ?? null, data]
  );
}

function cleanButtons(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map(b => {
    const action = ['video', 'channel', 'offer', 'access', 'url'].includes(b?.action) ? b.action : 'url';
    const out = { text: String(b?.text ?? '').slice(0, 64), action };
    if (action === 'url') out.url = String(b?.url ?? '').slice(0, 500);
    return out;
  }).filter(b => b.text && (b.action !== 'url' || /^https?:\/\//i.test(b.url)));
}

// ─── Конфигурация воронки: её читает и бот, и админка ───────────────────────

router.get('/config', wrap(async (_req, res) => {
  const [steps, settings, media] = await Promise.all([
    pool.query('SELECT * FROM steps ORDER BY sort, key'),
    pool.query('SELECT key, value FROM settings'),
    pool.query(`SELECT key, kind, filename, mime, size, version, updated_at, width, height, duration,
      thumb IS NOT NULL AS has_thumb FROM media ORDER BY key`),
  ]);
  res.json({
    steps: steps.rows,
    settings: Object.fromEntries(settings.rows.map(r => [r.key, r.value])),
    media: media.rows,
  });
}));

router.post('/steps', wrap(async (req, res) => {
  const { key, title, branch, after_key } = req.body;
  if (!KEY_RE.test(String(key || ''))) return res.status(400).json({ error: 'bad key' });

  const result = await tx(async client => {
    const exists = await client.query('SELECT 1 FROM steps WHERE key = $1', [key]);
    if (exists.rowCount) return { error: 'key exists' };

    let after = null;
    if (after_key) {
      const { rows } = await client.query('SELECT * FROM steps WHERE key = $1 FOR UPDATE', [after_key]);
      after = rows[0] || null;
      if (!after) return { error: 'after_key not found' };
    }
    const { rows } = await client.query(
      `INSERT INTO steps (key, title, branch, guard, text, next_key, delay_seconds, sort)
       VALUES ($1,$2,$3,$4,'',$5,$6,$7) RETURNING *`,
      [key, String(title || 'Новый шаг').slice(0, 200), after?.branch || branch || 'main',
        after?.guard || 'active', after?.next_key ?? null, 60, (after?.sort ?? 0) + 1]
    );
    if (after) {
      await client.query('UPDATE steps SET next_key = $2, updated_at = now() WHERE key = $1', [after.key, key]);
      await client.query('UPDATE steps SET sort = sort + 1 WHERE sort > $1 AND key <> $2', [after.sort, key]);
    }
    return { step: rows[0] };
  });

  if (result.error) return res.status(400).json(result);
  await audit(req, 'step.create', key, { after_key: after_key ?? null });
  res.json(result);
}));

router.patch('/steps/:key', wrap(async (req, res) => {
  const fields = [];
  const values = [req.params.key];
  const push = (sql, value) => { values.push(value); fields.push(`${sql} = $${values.length}`); };
  const b = req.body;

  if (b.title !== undefined) push('title', String(b.title).slice(0, 200));
  if (b.text !== undefined) push('text', String(b.text).slice(0, 4000));
  if (b.note !== undefined) push('note', String(b.note).slice(0, 4000));
  if (b.media_key !== undefined) push('media_key', b.media_key || null);
  if (b.buttons !== undefined) push('buttons', JSON.stringify(cleanButtons(b.buttons)));
  if (b.delay_seconds !== undefined) push('delay_seconds', Math.max(0, Math.min(Number(b.delay_seconds) || 0, 30 * 24 * 3600)));
  if (b.enabled !== undefined) push('enabled', !!b.enabled);
  if (b.branch !== undefined) push('branch', String(b.branch).slice(0, 40));
  if (b.guard !== undefined) {
    if (!GUARDS.includes(b.guard)) return res.status(400).json({ error: 'bad guard' });
    push('guard', b.guard);
  }
  if (b.trigger !== undefined) {
    if (b.trigger && !TRIGGERS.includes(b.trigger)) return res.status(400).json({ error: 'bad trigger' });
    push('trigger', b.trigger || null);
  }
  if (b.next_key !== undefined) push('next_key', b.next_key || null);
  if (b.pos_x !== undefined) push('pos_x', b.pos_x === null ? null : Math.round(Number(b.pos_x) || 0));
  if (b.pos_y !== undefined) push('pos_y', b.pos_y === null ? null : Math.round(Number(b.pos_y) || 0));
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });

  // Кольцо в цепочке слало бы сообщения бесконечно — не даём его собрать.
  if (b.next_key) {
    const { rows: all } = await pool.query('SELECT key, next_key FROM steps');
    const next = new Map(all.map(s => [s.key, s.next_key]));
    next.set(req.params.key, b.next_key);
    const seen = new Set([req.params.key]);
    for (let key = b.next_key; key; key = next.get(key)) {
      if (seen.has(key)) return res.status(400).json({ error: 'так шаги зациклятся — выберите другой следующий шаг' });
      seen.add(key);
    }
  }

  const { rows } = await pool.query(
    `UPDATE steps SET ${fields.join(', ')}, updated_at = now() WHERE key = $1 RETURNING *`, values
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  await audit(req, 'step.update', req.params.key, { fields: Object.keys(b) });
  res.json({ step: rows[0] });
}));

// Удаление шага: предшественники перецепляются на его next_key, чтобы цепочка не рвалась.
router.delete('/steps/:key', wrap(async (req, res) => {
  const result = await tx(async client => {
    const { rows } = await client.query('SELECT * FROM steps WHERE key = $1 FOR UPDATE', [req.params.key]);
    const step = rows[0];
    if (!step) return { error: 'not found' };
    if (step.trigger) return { error: 'у шага есть триггер — сначала перенесите его на другой шаг' };
    await client.query('UPDATE steps SET next_key = $2, updated_at = now() WHERE next_key = $1', [step.key, step.next_key]);
    await client.query('DELETE FROM steps WHERE key = $1', [step.key]);
    await client.query(`UPDATE jobs SET status = 'canceled', updated_at = now() WHERE step = $1 AND status = 'pending'`, [step.key]);
    return { ok: true };
  });
  if (result.error) return res.status(400).json(result);
  await audit(req, 'step.delete', req.params.key);
  res.json(result);
}));

router.put('/settings', wrap(async (req, res) => {
  const entries = Object.entries(req.body || {}).filter(([k]) => KEY_RE.test(k));
  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, String(value ?? '').slice(0, 2000)]
    );
  }
  await audit(req, 'settings.update', null, { keys: entries.map(([k]) => k) });
  const { rows } = await pool.query('SELECT key, value FROM settings');
  res.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
}));

// ─── Медиа ──────────────────────────────────────────────────────────────────

// Файл приходит сырым телом, метаданные — в query: так не раздуваем JSON base64.
router.post('/media', express.raw({ type: () => true, limit: '60mb' }), wrap(async (req, res) => {
  const { key, kind, filename, mime } = req.query;
  if (!KEY_RE.test(String(key || ''))) return res.status(400).json({ error: 'bad key' });
  if (!MEDIA_KINDS.includes(kind)) return res.status(400).json({ error: 'bad kind' });
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!data.length) return res.status(400).json({ error: 'empty file' });
  if (data.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'файл больше 50 МБ' });

  // Размеры и длительность видео читаем из самого файла; превью старого файла сбрасываем.
  const info = kind === 'photo' ? null : videoInfo(data);
  const { rows } = await pool.query(
    `INSERT INTO media (key, kind, filename, mime, size, data, width, height, duration) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (key) DO UPDATE SET kind = EXCLUDED.kind, filename = EXCLUDED.filename, mime = EXCLUDED.mime,
       size = EXCLUDED.size, data = EXCLUDED.data, width = EXCLUDED.width, height = EXCLUDED.height,
       duration = EXCLUDED.duration, thumb = NULL, version = media.version + 1, updated_at = now()
     RETURNING key, kind, filename, mime, size, version, updated_at, width, height, duration, false AS has_thumb`,
    [key, kind, String(filename || key).slice(0, 200), String(mime || 'application/octet-stream').slice(0, 100), data.length, data,
      info?.width ?? null, info?.height ?? null, info?.duration ?? null]
  );
  await audit(req, 'media.upload', key, { size: data.length, kind });
  res.json({ media: rows[0] });
}));

router.get('/media/:key/file', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM media WHERE key = $1', [req.params.key]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  const m = rows[0];
  res.set({
    'content-type': m.mime,
    'content-disposition': `inline; filename="${encodeURIComponent(m.filename)}"`,
    etag: `"${m.key}-${m.version}"`,
    'cache-control': 'private, max-age=60',
  }).send(m.data);
}));

// Превью видео (JPEG до 320 px, до 200 КБ — требования Telegram). Делает админка при загрузке.
router.post('/media/:key/thumb', express.raw({ type: () => true, limit: '1mb' }), wrap(async (req, res) => {
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!data.length || data[0] !== 0xff || data[1] !== 0xd8) return res.status(400).json({ error: 'нужен JPEG' });
  if (data.length > 200 * 1024) return res.status(413).json({ error: 'превью больше 200 КБ' });
  // Новая версия: бот заново загрузит видео в Telegram уже с обложкой.
  const { rows } = await pool.query(
    `UPDATE media SET thumb = $2, version = version + 1, updated_at = now() WHERE key = $1
     RETURNING key, kind, filename, mime, size, version, updated_at, width, height, duration, true AS has_thumb`,
    [req.params.key, data]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  await audit(req, 'media.thumb', req.params.key, { size: data.length });
  res.json({ media: rows[0] });
}));

router.get('/media/:key/thumb', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT thumb FROM media WHERE key = $1', [req.params.key]);
  if (!rows[0]?.thumb) return res.status(404).json({ error: 'not found' });
  res.set({ 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=60' }).send(rows[0].thumb);
}));

router.delete('/media/:key', wrap(async (req, res) => {
  await pool.query('UPDATE steps SET media_key = NULL, updated_at = now() WHERE media_key = $1', [req.params.key]);
  await pool.query('UPDATE broadcasts SET media_key = NULL WHERE media_key = $1', [req.params.key]);
  const { rowCount } = await pool.query('DELETE FROM media WHERE key = $1', [req.params.key]);
  await audit(req, 'media.delete', req.params.key);
  res.json({ deleted: rowCount });
}));

// ─── Аккаунты админки ───────────────────────────────────────────────────────

router.post('/admin/login', wrap(async (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase();
  const { rows } = await pool.query('SELECT * FROM admins WHERE lower(login) = $1', [login]);
  const admin = rows[0];
  if (!admin || admin.disabled || !verifyPassword(req.body.password, admin.password_hash)) {
    await audit(req, 'login.fail', login, { ip: req.body.ip ?? null });
    return res.status(401).json({ error: 'неверный логин или пароль' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, admin_id, ip, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [sha256(token), admin.id, req.body.ip ?? null, SESSION_DAYS]
  );
  await pool.query('UPDATE admins SET last_login_at = now() WHERE id = $1', [admin.id]);
  await pool.query(`DELETE FROM admin_sessions WHERE expires_at < now()`);
  await audit(req, 'login.ok', admin.login, { ip: req.body.ip ?? null });
  res.json({ token, admin: publicAdmin(admin) });
}));

router.post('/admin/session', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.* FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND a.disabled = false`,
    [sha256(req.body.token || '')]
  );
  if (!rows[0]) return res.status(401).json({ error: 'нет сессии' });
  await pool.query('UPDATE admin_sessions SET seen_at = now() WHERE token_hash = $1', [sha256(req.body.token)]);
  res.json({ admin: publicAdmin(rows[0]) });
}));

router.post('/admin/logout', wrap(async (req, res) => {
  await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256(req.body.token || '')]);
  res.json({ ok: true });
}));

router.get('/admin/accounts', wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM admins ORDER BY id');
  res.json({ accounts: rows.map(publicAdmin) });
}));

router.post('/admin/accounts', wrap(async (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-z0-9._-]{3,40}$/.test(login)) return res.status(400).json({ error: 'логин: 3-40 символов a-z 0-9 . _ -' });
  if (password.length < 8) return res.status(400).json({ error: 'пароль от 8 символов' });
  if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'bad role' });
  const exists = await pool.query('SELECT 1 FROM admins WHERE lower(login) = $1', [login]);
  if (exists.rowCount) return res.status(400).json({ error: 'такой логин уже есть' });

  const { rows } = await pool.query(
    'INSERT INTO admins (login, name, password_hash, role, tg_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [login, String(req.body.name || '').slice(0, 100), hashPassword(password), req.body.role, req.body.tg_id || null]
  );
  await audit(req, 'account.create', login, { role: req.body.role });
  res.json({ account: publicAdmin(rows[0]) });
}));

router.patch('/admin/accounts/:id', wrap(async (req, res) => {
  const fields = [];
  const values = [req.params.id];
  const push = (sql, value) => { values.push(value); fields.push(`${sql} = $${values.length}`); };
  if (req.body.name !== undefined) push('name', String(req.body.name).slice(0, 100));
  if (req.body.tg_id !== undefined) push('tg_id', req.body.tg_id || null);
  if (req.body.disabled !== undefined) push('disabled', !!req.body.disabled);
  if (req.body.role !== undefined) {
    if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'bad role' });
    push('role', req.body.role);
  }
  if (req.body.password !== undefined) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: 'пароль от 8 символов' });
    push('password_hash', hashPassword(req.body.password));
  }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });

  // Последнего владельца нельзя разжаловать или отключить — иначе в админку не войти.
  const losesOwner = (req.body.role !== undefined && req.body.role !== 'owner') || req.body.disabled === true;
  if (losesOwner) {
    const { rows: [target] } = await pool.query('SELECT role FROM admins WHERE id = $1', [req.params.id]);
    const { rows: [{ n }] } = await pool.query(
      `SELECT count(*)::int AS n FROM admins WHERE role = 'owner' AND disabled = false AND id <> $1`, [req.params.id]
    );
    if (target?.role === 'owner' && n === 0) return res.status(400).json({ error: 'это последний владелец' });
  }

  const { rows } = await pool.query(
    `UPDATE admins SET ${fields.join(', ')} WHERE id = $1 RETURNING *`, values
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  if (req.body.password !== undefined || req.body.disabled) {
    await pool.query('DELETE FROM admin_sessions WHERE admin_id = $1', [req.params.id]);
  }
  await audit(req, 'account.update', rows[0].login, { fields: Object.keys(req.body).filter(k => k !== 'password') });
  res.json({ account: publicAdmin(rows[0]) });
}));

router.delete('/admin/accounts/:id', wrap(async (req, res) => {
  const { rows: [target] } = await pool.query('SELECT * FROM admins WHERE id = $1', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'not found' });
  if (target.role === 'owner') {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM admins WHERE role = 'owner' AND id <> $1`, [req.params.id]);
    if (rows[0].n === 0) return res.status(400).json({ error: 'это последний владелец' });
  }
  await pool.query('DELETE FROM admins WHERE id = $1', [req.params.id]);
  await audit(req, 'account.delete', target.login);
  res.json({ deleted: 1 });
}));

// ─── Пользователи бота ──────────────────────────────────────────────────────

router.get('/users', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const where = [];
  const values = [];
  const segment = SEGMENTS[req.query.segment];
  if (segment) where.push(segment);
  if (req.query.query) {
    values.push(`%${String(req.query.query).trim().toLowerCase()}%`);
    where.push(`(lower(coalesce(username,'')) LIKE $${values.length} OR lower(coalesce(first_name,'')) LIKE $${values.length}
      OR lower(coalesce(last_name,'')) LIKE $${values.length} OR lower(coalesce(email,'')) LIKE $${values.length}
      OR tg_id::text LIKE $${values.length} OR coalesce(gc_user_id,'') LIKE $${values.length})`);
  }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Метки первой заявки с лендинга, по которой человек пришёл в бота.
  const { rows } = await pool.query(
    `SELECT users.*, lead.utm_source AS lead_source, lead.utm_campaign AS lead_campaign FROM users
     LEFT JOIN LATERAL (SELECT utm_source, utm_campaign FROM leads WHERE leads.user_id = users.id ORDER BY leads.created_at LIMIT 1) lead ON true
     ${sql} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, values
  );
  const { rows: [{ total }] } = await pool.query(`SELECT count(*)::int AS total FROM users ${sql}`, values);
  res.json({ users: rows.map(u => ({ ...u, tg_id: String(u.tg_id) })), total });
}));

router.get('/users/:id/timeline', wrap(async (req, res) => {
  const [events, jobs, leads] = await Promise.all([
    pool.query('SELECT * FROM events WHERE user_id = $1 ORDER BY id DESC LIMIT 200', [req.params.id]),
    pool.query('SELECT * FROM jobs WHERE user_id = $1 ORDER BY id DESC LIMIT 100', [req.params.id]),
    pool.query('SELECT * FROM leads WHERE user_id = $1 ORDER BY created_at', [req.params.id]),
  ]);
  res.json({ events: events.rows, jobs: jobs.rows, leads: leads.rows });
}));

router.delete('/users/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  await audit(req, 'user.delete', req.params.id);
  res.json({ deleted: rowCount });
}));

router.get('/audience', wrap(async (req, res) => {
  const segment = SEGMENTS[req.query.segment];
  if (!segment) return res.json({ count: 0 });
  const { rows } = await pool.query(`SELECT count(*)::int AS count FROM users WHERE ${segment}`);
  res.json({ count: rows[0].count });
}));

// ─── Рассылки ───────────────────────────────────────────────────────────────

const BROADCAST_COUNTS = `
  (SELECT count(*)::int FROM broadcast_targets t WHERE t.broadcast_id = b.id) AS total,
  (SELECT count(*)::int FROM broadcast_targets t WHERE t.broadcast_id = b.id AND t.status = 'sent') AS sent,
  (SELECT count(*)::int FROM broadcast_targets t WHERE t.broadcast_id = b.id AND t.status = 'failed') AS failed,
  (SELECT count(*)::int FROM broadcast_targets t WHERE t.broadcast_id = b.id AND t.status = 'blocked') AS blocked,
  (SELECT count(*)::int FROM broadcast_targets t WHERE t.broadcast_id = b.id AND t.status IN ('pending','sending')) AS pending`;

const publicBroadcast = b => b && ({ ...b, test_tg_ids: (b.test_tg_ids || []).map(String) });

router.get('/broadcasts', wrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT b.*, ${BROADCAST_COUNTS} FROM broadcasts b ORDER BY b.id DESC LIMIT 100`);
  res.json({ broadcasts: rows.map(publicBroadcast) });
}));

router.get('/broadcasts/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT b.*, ${BROADCAST_COUNTS} FROM broadcasts b WHERE b.id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  const errors = await pool.query(
    `SELECT tg_id, status, error FROM broadcast_targets WHERE broadcast_id = $1 AND status IN ('failed','blocked') ORDER BY id LIMIT 50`,
    [req.params.id]
  );
  res.json({ broadcast: publicBroadcast(rows[0]), problems: errors.rows.map(r => ({ ...r, tg_id: String(r.tg_id) })) });
}));

const validSegment = s => (SEGMENTS[s] || s === 'test' ? s : 'all');

router.post('/broadcasts', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'INSERT INTO broadcasts (title, text, media_key, buttons, segment, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [String(req.body.title || 'Без названия').slice(0, 200), String(req.body.text || '').slice(0, 4000),
      req.body.media_key || null, JSON.stringify(cleanButtons(req.body.buttons)),
      validSegment(req.body.segment), req.get('x-actor-id') || null]
  );
  await audit(req, 'broadcast.create', String(rows[0].id));
  res.json({ broadcast: publicBroadcast(rows[0]) });
}));

router.patch('/broadcasts/:id', wrap(async (req, res) => {
  const { rows: [current] } = await pool.query('SELECT * FROM broadcasts WHERE id = $1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'not found' });
  if (current.status === 'sending') return res.status(400).json({ error: 'рассылка уже идёт' });

  const fields = [];
  const values = [req.params.id];
  const push = (sql, value) => { values.push(value); fields.push(`${sql} = $${values.length}`); };
  if (req.body.title !== undefined) push('title', String(req.body.title).slice(0, 200));
  if (req.body.text !== undefined) push('text', String(req.body.text).slice(0, 4000));
  if (req.body.media_key !== undefined) push('media_key', req.body.media_key || null);
  if (req.body.buttons !== undefined) push('buttons', JSON.stringify(cleanButtons(req.body.buttons)));
  if (req.body.segment !== undefined) {
    if (!SEGMENTS[req.body.segment] && req.body.segment !== 'test') return res.status(400).json({ error: 'bad segment' });
    push('segment', req.body.segment);
  }
  if (req.body.test_tg_ids !== undefined) {
    const ids = (Array.isArray(req.body.test_tg_ids) ? req.body.test_tg_ids : [])
      .map(v => String(v).trim()).filter(v => /^\d{3,20}$/.test(v)).slice(0, 20);
    push('test_tg_ids', ids);
  }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });

  const { rows } = await pool.query(`UPDATE broadcasts SET ${fields.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, values);
  await audit(req, 'broadcast.update', req.params.id, { fields: Object.keys(req.body) });
  res.json({ broadcast: publicBroadcast(rows[0]) });
}));

router.delete('/broadcasts/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM broadcasts WHERE id = $1 AND status <> 'sending'`, [req.params.id]);
  if (!rowCount) return res.status(400).json({ error: 'рассылка идёт — сначала остановите' });
  await audit(req, 'broadcast.delete', req.params.id);
  res.json({ deleted: rowCount });
}));

// Старт: собираем список получателей и переводим рассылку в «идёт».
router.post('/broadcasts/:id/start', wrap(async (req, res) => {
  const result = await tx(async client => {
    const { rows } = await client.query('SELECT * FROM broadcasts WHERE id = $1 FOR UPDATE', [req.params.id]);
    const b = rows[0];
    if (!b) return { error: 'not found' };
    if (b.status === 'sending') return { error: 'уже идёт' };
    if (!b.text.trim() && !b.media_key) return { error: 'пустое сообщение' };

    await client.query('DELETE FROM broadcast_targets WHERE broadcast_id = $1', [b.id]);
    if (b.segment === 'test') {
      const ids = (b.test_tg_ids || []).map(String);
      if (!ids.length) return { error: 'не указан telegram id для теста' };
      await client.query(
        `INSERT INTO broadcast_targets (broadcast_id, user_id, tg_id)
         SELECT $1, u.id, t.tg_id::bigint FROM unnest($2::text[]) AS t(tg_id)
         LEFT JOIN users u ON u.tg_id = t.tg_id::bigint
         ON CONFLICT DO NOTHING`,
        [b.id, ids]
      );
    } else {
      await client.query(
        `INSERT INTO broadcast_targets (broadcast_id, user_id, tg_id)
         SELECT $1, id, tg_id FROM users WHERE ${SEGMENTS[b.segment] || SEGMENTS.all}
         ON CONFLICT DO NOTHING`,
        [b.id]
      );
    }
    const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM broadcast_targets WHERE broadcast_id = $1', [b.id]);
    if (!count) return { error: 'в сегменте никого нет' };
    const { rows: [updated] } = await client.query(
      `UPDATE broadcasts SET status = 'sending', started_at = now(), finished_at = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`, [b.id]
    );
    return { broadcast: updated, total: count };
  });

  if (result.error) return res.status(400).json(result);
  await audit(req, 'broadcast.start', req.params.id, { total: result.total });
  res.json({ broadcast: publicBroadcast(result.broadcast), total: result.total });
}));

router.post('/broadcasts/:id/cancel', wrap(async (req, res) => {
  await pool.query(
    `UPDATE broadcast_targets SET status = 'canceled', updated_at = now()
     WHERE broadcast_id = $1 AND status IN ('pending','sending')`, [req.params.id]
  );
  const { rows } = await pool.query(
    `UPDATE broadcasts SET status = 'canceled', finished_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  await audit(req, 'broadcast.cancel', req.params.id);
  res.json({ broadcast: publicBroadcast(rows[0]) });
}));

// Бот забирает пачку получателей. Зависшие «sending» через 5 минут возвращаются в очередь.
router.post('/broadcasts/claim', wrap(async (req, res) => {
  const limit = Math.min(Number(req.body.limit) || 25, 100);
  const { rows: [active] } = await pool.query(`SELECT * FROM broadcasts WHERE status = 'sending' ORDER BY id LIMIT 1`);
  if (!active) return res.json({ broadcast: null, targets: [] });

  const { rows: targets } = await pool.query(
    `UPDATE broadcast_targets SET status = 'sending', attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM broadcast_targets
       WHERE broadcast_id = $1 AND (status = 'pending' OR (status = 'sending' AND updated_at < now() - interval '5 minutes'))
       ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED
     ) RETURNING id, user_id, tg_id, attempts`,
    [active.id, limit]
  );

  // Тексту рассылки нужны имя и токен получателя — отдаём вместе с целями.
  const userIds = targets.map(t => t.user_id).filter(Boolean);
  const { rows: users } = userIds.length
    ? await pool.query(
      `SELECT id, tg_id, token, first_name, last_name, username, created_at, time_scale, clicked_at, offer_at, paid_at
       FROM users WHERE id = ANY($1)`, [userIds])
    : { rows: [] };
  const byId = new Map(users.map(u => [String(u.id), u]));

  if (!targets.length) {
    const { rows: [{ left }] } = await pool.query(
      `SELECT count(*)::int AS left FROM broadcast_targets WHERE broadcast_id = $1 AND status IN ('pending','sending')`, [active.id]
    );
    if (!left) {
      await pool.query(`UPDATE broadcasts SET status = 'done', finished_at = now(), updated_at = now() WHERE id = $1`, [active.id]);
    }
    return res.json({ broadcast: null, targets: [] });
  }

  res.json({
    broadcast: { id: active.id, text: active.text, media_key: active.media_key, buttons: active.buttons },
    targets: targets.map(t => ({
      ...t,
      tg_id: String(t.tg_id),
      user: byId.get(String(t.user_id)) || null,
    })),
  });
}));

router.post('/broadcasts/targets/result', wrap(async (req, res) => {
  const results = Array.isArray(req.body.results) ? req.body.results : [];
  for (const r of results) {
    await pool.query(
      `UPDATE broadcast_targets SET status = $2, error = $3, updated_at = now() WHERE id = $1`,
      [r.id, ['sent', 'failed', 'blocked', 'pending'].includes(r.status) ? r.status : 'failed', String(r.error || '').slice(0, 500)]
    );
  }
  res.json({ ok: true, updated: results.length });
}));

// ─── Статистика ─────────────────────────────────────────────────────────────

router.get('/stats/daily', wrap(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
  const { rows } = await pool.query(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
       (SELECT count(*)::int FROM users u WHERE u.created_at::date = d::date) AS starts,
       (SELECT count(*)::int FROM users u WHERE u.clicked_at::date = d::date) AS clicks,
       (SELECT count(*)::int FROM users u WHERE u.offer_at::date = d::date) AS offers,
       (SELECT count(*)::int FROM users u WHERE u.paid_at::date = d::date) AS paid
     FROM generate_series(now()::date - make_interval(days => $1 - 1), now()::date, interval '1 day') AS d
     ORDER BY day`,
    [days]
  );
  res.json({ days: rows });
}));

router.get('/audit', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await pool.query('SELECT * FROM audit ORDER BY id DESC LIMIT $1', [limit]);
  res.json({ audit: rows });
}));
