// Заявки с лендинга. Лендинг шлёт заявку на публичный адрес админки (/hooks/lead),
// та передаёт её сюда вместе с ключом. id заявки стоит в ссылке на бота
// t.me/<бот>?start=<id>: по нему заявка связывается с человеком, когда он нажмёт Start.

import crypto from 'node:crypto';
import express from 'express';
import { pool, tx } from './db.js';

export const router = express.Router();

const wrap = fn => (req, res, next) => fn(req, res).catch(next);

// Так Telegram ограничивает start-параметр: латиница, цифры, _ и -, до 64 символов.
export const LEAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const FIELDS = ['name', 'phone', 'email', ...UTM];
const SKIP = new Set(['lead_id', 'key', 'created_at', 'utm', ...FIELDS]);

const clean = v => (v === undefined || v === null || typeof v === 'object' ? null : String(v).trim().slice(0, 500) || null);

function keyOk(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Заявка и Start приходят в любом порядке. Блокировка по id заявки выстраивает их
// друг за другом: второй всегда видит то, что успел записать первый.
const lockLead = (client, id) => client.query(`SELECT pg_advisory_xact_lock(hashtext('lead:' || $1))`, [id]);

// /start с параметром: если по нему есть заявка, привязываем к ней человека (первого — навсегда).
export async function linkLead(client, userId, startParam) {
  if (!startParam || !LEAD_ID_RE.test(startParam)) return;
  await lockLead(client, startParam);
  const { rows: [lead] } = await client.query(
    `UPDATE leads SET user_id = $1, started_at = now(), updated_at = now() WHERE id = $2 AND user_id IS NULL RETURNING email`,
    [userId, startParam]
  );
  await rememberEmail(client, userId, lead?.email);
}

// Почта с лендинга — в карточку человека: её показывает сообщение после оплаты ({email}),
// и по ней хук оплаты находит человека. Уже известную почту не перезаписываем.
async function rememberEmail(client, userId, email) {
  if (!userId || !email) return;
  await client.query('UPDATE users SET email = COALESCE(email, $2), updated_at = now() WHERE id = $1', [userId, email]);
}

function parseLead(body) {
  const lead = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  // UTM можно прислать и вложенным объектом: {utm: {source, medium, ...}}
  const nested = lead.utm && typeof lead.utm === 'object' ? lead.utm : {};
  const out = { id: String(lead.lead_id ?? '').trim(), data: {} };
  for (const f of FIELDS) out[f] = clean(lead[f]) ?? (f.startsWith('utm_') ? clean(nested[f.slice(4)]) : null);
  if (out.email) out.email = out.email.toLowerCase();
  const at = lead.created_at ? new Date(typeof lead.created_at === 'number' ? lead.created_at : String(lead.created_at)) : null;
  out.created_at = at && !Number.isNaN(at.getTime()) && at.getTime() <= Date.now() + 60_000 ? at.toISOString() : null;
  for (const [k, v] of Object.entries(lead).slice(0, 60)) {
    if (SKIP.has(k) || v === undefined || v === null || v === '') continue;
    out.data[k.slice(0, 64)] = typeof v === 'object' ? v : String(v).slice(0, 2000);
  }
  return out;
}

// Приём заявки. Повтор с тем же lead_id не создаёт дубль: поля обновляются, пустые не затирают старые.
router.post('/leads', wrap(async (req, res) => {
  const { rows: settings } = await pool.query(`SELECT key, value FROM settings WHERE key IN ('leads_api_key', 'bot_username')`);
  const setting = Object.fromEntries(settings.map(r => [r.key, r.value]));
  if (!keyOk(req.body?.key, setting.leads_api_key)) return res.status(401).json({ error: 'wrong api key' });

  const lead = parseLead(req.body?.lead);
  if (!lead.id) return res.status(400).json({ error: 'lead_id is required' });
  if (!LEAD_ID_RE.test(lead.id)) {
    return res.status(400).json({ error: 'lead_id: only A-Z a-z 0-9 _ -, up to 64 chars (Telegram start parameter)' });
  }

  const saved = await tx(async client => {
    await lockLead(client, lead.id);
    const { rows: [row] } = await client.query(
      `INSERT INTO leads (id, name, phone, email, utm_source, utm_medium, utm_campaign, utm_content, utm_term, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, now()))
       ON CONFLICT (id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, leads.name),
         phone = COALESCE(EXCLUDED.phone, leads.phone),
         email = COALESCE(EXCLUDED.email, leads.email),
         utm_source = COALESCE(EXCLUDED.utm_source, leads.utm_source),
         utm_medium = COALESCE(EXCLUDED.utm_medium, leads.utm_medium),
         utm_campaign = COALESCE(EXCLUDED.utm_campaign, leads.utm_campaign),
         utm_content = COALESCE(EXCLUDED.utm_content, leads.utm_content),
         utm_term = COALESCE(EXCLUDED.utm_term, leads.utm_term),
         data = leads.data || EXCLUDED.data,
         updated_at = now()
       RETURNING *`,
      [lead.id, lead.name, lead.phone, lead.email, lead.utm_source, lead.utm_medium, lead.utm_campaign,
        lead.utm_content, lead.utm_term, lead.data, lead.created_at]
    );
    if (row.user_id) {
      await rememberEmail(client, row.user_id, row.email);
      return row;
    }
    // Человек мог нажать Start раньше, чем дошла заявка.
    const { rows: [start] } = await client.query(
      `SELECT user_id, created_at FROM events
       WHERE type IN ('start', 'restart') AND data->>'start_param' = $1 AND user_id IS NOT NULL
       ORDER BY id LIMIT 1`,
      [lead.id]
    );
    if (!start) return row;
    const { rows: [linked] } = await client.query(
      `UPDATE leads SET user_id = $2, started_at = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [lead.id, start.user_id, start.created_at]
    );
    await rememberEmail(client, linked.user_id, linked.email);
    return linked;
  });

  const bot = setting.bot_username;
  res.json({
    ok: true,
    lead_id: saved.id,
    in_bot: saved.user_id !== null,
    ...(bot ? { bot_url: `https://t.me/${bot}?start=${saved.id}` } : {}),
  });
}));

// ─── Для админки ────────────────────────────────────────────────────────────

const LEAD_COLUMNS = `l.*, u.tg_id::text AS tg_id, u.first_name, u.last_name, u.username,
  u.clicked_at, u.offer_at, u.paid_at, u.blocked_at`;

function filters(query) {
  const where = [];
  const values = [];
  if (query.status === 'in_bot') where.push('l.user_id IS NOT NULL');
  if (query.status === 'not_in_bot') where.push('l.user_id IS NULL');
  if (UTM.includes(query.by) && query.value !== undefined) {
    values.push(String(query.value));
    where.push(`coalesce(l.${query.by}, '') = $${values.length}`);
  }
  if (query.query) {
    values.push(`%${String(query.query).trim().toLowerCase()}%`);
    const n = values.length;
    where.push(`(lower(l.id) LIKE $${n} OR lower(coalesce(l.name, '')) LIKE $${n} OR lower(coalesce(l.phone, '')) LIKE $${n}
      OR lower(coalesce(l.email, '')) LIKE $${n} OR lower(concat_ws(' ', ${UTM.map(u => `l.${u}`).join(', ')})) LIKE $${n})`);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
}

router.get('/leads', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { sql, values } = filters(req.query);
  const { rows } = await pool.query(
    `SELECT ${LEAD_COLUMNS} FROM leads l LEFT JOIN users u ON u.id = l.user_id ${sql}
     ORDER BY l.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    values
  );
  const { rows: [{ total }] } = await pool.query(`SELECT count(*)::int AS total FROM leads l ${sql}`, values);
  res.json({ leads: rows, total });
}));

// Воронка по меткам: сколько заявок дошло до бота, до видео, до оффера и до оплаты.
const FUNNEL = `count(*)::int AS leads, count(u.id)::int AS in_bot, count(u.clicked_at)::int AS clicked,
  count(u.offer_at)::int AS offer, count(u.paid_at)::int AS paid`;

router.get('/leads/summary', wrap(async (req, res) => {
  const by = UTM.includes(req.query.by) ? req.query.by : 'utm_source';
  const [total, groups] = await Promise.all([
    pool.query(`SELECT ${FUNNEL} FROM leads l LEFT JOIN users u ON u.id = l.user_id`),
    pool.query(`SELECT coalesce(l.${by}, '') AS value, ${FUNNEL}
      FROM leads l LEFT JOIN users u ON u.id = l.user_id GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 200`),
  ]);
  res.json({ by, total: total.rows[0], groups: groups.rows });
}));

// ─── Выгрузка для Google Таблицы ────────────────────────────────────────────
// CSV для =IMPORTDATA(...): по строке на заявку, старые сверху — новые дописываются вниз,
// поэтому пометки команды в соседних столбцах не съезжают.

const YES = v => (v ? 'да' : 'нет');
const msk = `'YYYY-MM-DD HH24:MI'`;
const csvCell = v => {
  let s = v === null || v === undefined ? '' : String(v);
  if (s.startsWith('=')) s = ` ${s}`; // не формула в таблице
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function stage(r) {
  if (!r.user_id) return 'Не открыл бота';
  const s = r.paid_at ? 'Купил' : r.offer_at ? 'Досмотрел до оффера' : r.clicked_at ? 'Нажал на видео' : 'Открыл бота, не нажал на видео';
  return r.blocked_at ? `${s} · заблокировал бота` : s;
}

router.get('/leads/export', wrap(async (req, res) => {
  const { rows: settings } = await pool.query(`SELECT key, value FROM settings WHERE key IN ('leads_export_key', 'access_hours')`);
  const setting = Object.fromEntries(settings.map(r => [r.key, r.value]));
  if (!keyOk(req.query.key, setting.leads_export_key)) return res.status(401).json({ error: 'wrong key' });
  const hours = Number(setting.access_hours) || 24;
  const { rows } = await pool.query(
    `SELECT l.id, l.email, l.user_id, ${UTM.map(u => `l.${u}`).join(', ')},
       to_char(l.created_at AT TIME ZONE 'Europe/Moscow', ${msk}) AS lead_at,
       to_char(l.started_at AT TIME ZONE 'Europe/Moscow', ${msk}) AS started,
       to_char((u.created_at + make_interval(hours => $1)) AT TIME ZONE 'Europe/Moscow', ${msk}) AS deadline,
       u.tg_id::text AS tg_id, u.username, u.first_name, u.last_name, u.clicked_at, u.offer_at, u.paid_at, u.blocked_at
     FROM leads l LEFT JOIN users u ON u.id = l.user_id
     ORDER BY l.created_at, l.id`,
    [hours]
  );
  const header = ['Дата заявки (МСК)', 'Email', 'Этап', 'Открыл бота', 'Нажал на видео', 'Досмотрел до оффера', 'Купил',
    'Заблокировал бота', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'Telegram',
    'Открыл бота (МСК)', 'Доступ до (МСК)', 'ID заявки'];
  const lines = [header, ...rows.map(r => {
    const inBot = !!r.user_id;
    const tg = !inBot ? '' : r.username ? `@${r.username}` : [r.first_name, r.last_name].filter(Boolean).join(' ') || `id ${r.tg_id}`;
    return [r.lead_at, r.email, stage(r), YES(inBot), inBot ? YES(r.clicked_at) : '', inBot ? YES(r.offer_at) : '',
      inBot ? YES(r.paid_at) : '', inBot ? YES(r.blocked_at) : '', ...UTM.map(u => r[u]), tg,
      inBot ? r.started : '', inBot ? r.deadline : '', r.id];
  })];
  res.set({ 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' })
    .send(lines.map(cols => cols.map(csvCell).join(',')).join('\r\n') + '\r\n');
}));

router.delete('/leads/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
  await pool.query(
    'INSERT INTO audit (admin_id, login, action, target) VALUES ($1, $2, $3, $4)',
    [req.get('x-actor-id') || null, req.get('x-actor-login') || null, 'lead.delete', req.params.id]
  );
  res.json({ deleted: rowCount });
}));
