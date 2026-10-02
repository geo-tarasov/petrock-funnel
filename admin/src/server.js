import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { can, PERMISSIONS, ROLE_TITLES } from './permissions.js';
import { callApi, fetchJson, passthrough } from './upstream.js';

// За каким прокси стоит сервис: loopback — nginx на этой же машине,
// в Docker — «loopback, uniquelocal» (прокси приходит из внутренней сети).
const trustProxy = value => (value === 'true' ? true : value === 'false' ? false : /^\d+$/.test(value) ? Number(value) : value);

const PORT = Number(process.env.PORT || 3026);
const HOST = process.env.HOST || '127.0.0.1';
const COOKIE = 'w3a_sid';
const SECURE_COOKIE = process.env.SECURE_COOKIE !== 'false';
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', trustProxy(process.env.TRUST_PROXY || 'loopback'));
app.use(cookieParser());

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ─── Сессии ─────────────────────────────────────────────────────────────────

const sessionCache = new Map();  // token -> { admin, at }
const SESSION_TTL_MS = 60_000;

async function resolveSession(token) {
  if (!token) return null;
  const hit = sessionCache.get(token);
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.admin;
  try {
    const { admin } = await fetchJson('POST', '/admin/session', { json: { token } });
    sessionCache.set(token, { admin, at: Date.now() });
    return admin;
  } catch (err) {
    if (err.status === 401) {
      sessionCache.delete(token);
      return null;
    }
    throw err;
  }
}

// req.ip — адрес, который увидел наш прокси (trust proxy). Первый адрес из X-Forwarded-For
// подставляет сам клиент, по нему лимиты обходились бы.
const clientIp = req => req.ip;

// Попытки входа: 10 на IP за 15 минут.
const attempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60_000);
  attempts.set(ip, list);
  return list.length < 10;
}
const noteAttempt = ip => attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);

app.post('/api/login', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const ip = clientIp(req);
  if (!loginAllowed(ip)) return res.status(429).json({ error: 'слишком много попыток, подождите 15 минут' });
  noteAttempt(ip);
  const upstream = await callApi('POST', '/admin/login', {
    json: { login: req.body.login, password: req.body.password, ip },
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return res.status(upstream.status).json({ error: data.error || 'ошибка входа' });

  attempts.delete(ip);
  res.cookie(COOKIE, data.token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: SECURE_COOKIE,
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  });
  res.json({ me: { ...data.admin, permissions: PERMISSIONS[data.admin.role] || [] } });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const token = req.cookies[COOKIE];
  if (token) {
    sessionCache.delete(token);
    await callApi('POST', '/admin/logout', { json: { token } }).catch(() => {});
  }
  res.clearCookie(COOKIE, { path: '/' }).json({ ok: true });
}));

// ─── Заявки с лендинга ──────────────────────────────────────────────────────
// Публичный вход без сессии: ключ из настроек проверяет RU API. Принимает JSON
// (в том числе sendBeacon с text/plain) и обычную форму, CORS открыт.

const LEAD_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-api-key',
  'access-control-max-age': '86400',
};

// 120 заявок в минуту с одного IP — с запасом для сервера лендинга.
const leadHits = new Map();
function leadAllowed(ip) {
  const now = Date.now();
  const list = (leadHits.get(ip) || []).filter(t => now - t < 60_000);
  list.push(now);
  leadHits.set(ip, list);
  if (leadHits.size > 10_000) leadHits.clear();
  return list.length <= 120;
}

app.options('/hooks/lead', (_req, res) => res.set(LEAD_CORS).sendStatus(204));
app.post('/hooks/lead', express.text({ type: () => true, limit: '32kb' }), wrap(async (req, res) => {
  res.set(LEAD_CORS);
  const ip = clientIp(req);
  if (!leadAllowed(ip)) return res.status(429).json({ error: 'too many requests' });
  const raw = typeof req.body === 'string' ? req.body.trim() : '';
  let lead;
  try {
    lead = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return res.status(400).json({ error: 'body must be JSON' });
  }
  const key = req.get('x-api-key') || req.query.key || lead.key || '';
  const upstream = await callApi('POST', '/leads', { json: { key, lead } });
  const data = await upstream.json().catch(() => ({}));
  // Отказы пишем в лог: по ним видно, что не так у лендинга.
  if (!upstream.ok) console.warn(`lead rejected ${upstream.status} from ${ip}: ${data.error || ''} lead_id=${String(lead.lead_id ?? '').slice(0, 80)}`);
  res.status(upstream.status).json(data);
}));

// Выгрузка заявок для Google Таблицы: =IMPORTDATA("https://.../hooks/leads.csv?key=...").
app.get('/hooks/leads.csv', wrap(async (req, res) => {
  const upstream = await callApi('GET', `/leads/export?${new URLSearchParams({ key: String(req.query.key || '') })}`);
  const body = await upstream.text();
  res.status(upstream.status).set('cache-control', 'no-store')
    .type(upstream.headers.get('content-type') || 'text/plain').send(body);
}));

// Всё ниже — только для вошедших. Заголовок x-admin отсекает запросы с чужих сайтов.
app.use('/api', express.json({ limit: '1mb' }), wrap(async (req, res, next) => {
  const admin = await resolveSession(req.cookies[COOKIE]);
  if (!admin) return res.status(401).json({ error: 'нужен вход' });
  if (req.method !== 'GET' && req.get('x-admin') !== '1') return res.status(403).json({ error: 'bad request' });
  req.admin = admin;
  req.actor = { id: admin.id, login: admin.login };
  next();
}));

const need = permission => (req, res, next) => {
  if (!can(req.admin.role, permission)) return res.status(403).json({ error: 'нет прав на это действие' });
  next();
};

app.get('/api/me', (req, res) => {
  res.json({ me: { ...req.admin, permissions: PERMISSIONS[req.admin.role] || [] }, roles: ROLE_TITLES });
});

app.post('/api/password', wrap(async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'пароль от 8 символов' });
  await fetchJson('PATCH', `/admin/accounts/${req.admin.id}`, { json: { password }, actor: req.actor });
  res.clearCookie(COOKIE, { path: '/' }).json({ ok: true });
}));

// ─── Воронка ────────────────────────────────────────────────────────────────

app.get('/api/config', wrap((req, res) => passthrough(res, 'GET', '/config')));
app.post('/api/steps', need('flow'), wrap((req, res) => passthrough(res, 'POST', '/steps', { json: req.body, actor: req.actor })));
app.patch('/api/steps/:key', need('flow'), wrap((req, res) =>
  passthrough(res, 'PATCH', `/steps/${encodeURIComponent(req.params.key)}`, { json: req.body, actor: req.actor })));
app.delete('/api/steps/:key', need('flow'), wrap((req, res) =>
  passthrough(res, 'DELETE', `/steps/${encodeURIComponent(req.params.key)}`, { actor: req.actor })));
app.put('/api/settings', need('settings'), wrap((req, res) => passthrough(res, 'PUT', '/settings', { json: req.body, actor: req.actor })));

// ─── Медиа ──────────────────────────────────────────────────────────────────

app.post('/api/media', need('media'), express.raw({ type: () => true, limit: '60mb' }), wrap(async (req, res) => {
  const query = new URLSearchParams({
    key: String(req.query.key || ''),
    kind: String(req.query.kind || 'photo'),
    filename: String(req.query.filename || ''),
    mime: String(req.query.mime || req.get('content-type') || 'application/octet-stream'),
  });
  await passthrough(res, 'POST', `/media?${query}`, {
    body: req.body,
    contentType: 'application/octet-stream',
    actor: req.actor,
    timeout: 180000,
  });
}));

// Превью видео — JPEG, его делает браузер при загрузке.
app.post('/api/media/:key/thumb', need('media'), express.raw({ type: () => true, limit: '1mb' }), wrap((req, res) =>
  passthrough(res, 'POST', `/media/${encodeURIComponent(req.params.key)}/thumb`, {
    body: req.body, contentType: 'image/jpeg', actor: req.actor,
  })));

app.delete('/api/media/:key', need('media'), wrap((req, res) =>
  passthrough(res, 'DELETE', `/media/${encodeURIComponent(req.params.key)}`, { actor: req.actor })));

// Превью файла в интерфейсе.
app.get('/api/media/:key/file', wrap(async (req, res) => {
  const upstream = await callApi('GET', `/media/${encodeURIComponent(req.params.key)}/file`, { timeout: 120000 });
  if (!upstream.ok) return res.status(upstream.status).end();
  res.set('content-type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.set('cache-control', 'private, max-age=300');
  res.send(Buffer.from(await upstream.arrayBuffer()));
}));

// ─── Пользователи бота ──────────────────────────────────────────────────────

app.get('/api/users', wrap((req, res) => passthrough(res, 'GET', `/users?${new URLSearchParams(req.query)}`)));
app.get('/api/users/:id/timeline', wrap((req, res) => passthrough(res, 'GET', `/users/${encodeURIComponent(req.params.id)}/timeline`)));
app.post('/api/users/:id/mark', need('botusers'), wrap((req, res) =>
  passthrough(res, 'POST', `/users/${encodeURIComponent(req.params.id)}/mark`, { json: req.body, actor: req.actor })));
app.delete('/api/users/:id', need('botusers'), wrap((req, res) =>
  passthrough(res, 'DELETE', `/users/${encodeURIComponent(req.params.id)}`, { actor: req.actor })));

// ─── Заявки ─────────────────────────────────────────────────────────────────

app.get('/api/leads', wrap((req, res) => passthrough(res, 'GET', `/leads?${new URLSearchParams(req.query)}`)));
app.get('/api/leads/summary', wrap((req, res) => passthrough(res, 'GET', `/leads/summary?${new URLSearchParams(req.query)}`)));
app.delete('/api/leads/:id', need('botusers'), wrap((req, res) =>
  passthrough(res, 'DELETE', `/leads/${encodeURIComponent(req.params.id)}`, { actor: req.actor })));

// ─── Рассылки ───────────────────────────────────────────────────────────────

app.get('/api/broadcasts', wrap((req, res) => passthrough(res, 'GET', '/broadcasts')));
app.get('/api/broadcasts/:id', wrap((req, res) => passthrough(res, 'GET', `/broadcasts/${encodeURIComponent(req.params.id)}`)));
app.post('/api/broadcasts', need('broadcast'), wrap((req, res) => passthrough(res, 'POST', '/broadcasts', { json: req.body, actor: req.actor })));
app.patch('/api/broadcasts/:id', need('broadcast'), wrap((req, res) =>
  passthrough(res, 'PATCH', `/broadcasts/${encodeURIComponent(req.params.id)}`, { json: req.body, actor: req.actor })));
app.delete('/api/broadcasts/:id', need('broadcast'), wrap((req, res) =>
  passthrough(res, 'DELETE', `/broadcasts/${encodeURIComponent(req.params.id)}`, { actor: req.actor })));
app.post('/api/broadcasts/:id/start', need('broadcast'), wrap((req, res) =>
  passthrough(res, 'POST', `/broadcasts/${encodeURIComponent(req.params.id)}/start`, { json: {}, actor: req.actor })));
app.post('/api/broadcasts/:id/cancel', need('broadcast'), wrap((req, res) =>
  passthrough(res, 'POST', `/broadcasts/${encodeURIComponent(req.params.id)}/cancel`, { json: {}, actor: req.actor })));
app.get('/api/audience', wrap((req, res) => passthrough(res, 'GET', `/audience?${new URLSearchParams(req.query)}`)));

// ─── Статистика и журнал ────────────────────────────────────────────────────

app.get('/api/stats', wrap((req, res) => passthrough(res, 'GET', '/stats')));
app.get('/api/stats/daily', wrap((req, res) => passthrough(res, 'GET', `/stats/daily?${new URLSearchParams(req.query)}`)));
app.get('/api/audit', wrap((req, res) => passthrough(res, 'GET', `/audit?${new URLSearchParams(req.query)}`)));

// ─── Аккаунты ───────────────────────────────────────────────────────────────

app.get('/api/accounts', need('accounts'), wrap((req, res) => passthrough(res, 'GET', '/admin/accounts')));
app.post('/api/accounts', need('accounts'), wrap((req, res) => passthrough(res, 'POST', '/admin/accounts', { json: req.body, actor: req.actor })));
app.patch('/api/accounts/:id', need('accounts'), wrap(async (req, res) => {
  sessionCache.clear();
  await passthrough(res, 'PATCH', `/admin/accounts/${encodeURIComponent(req.params.id)}`, { json: req.body, actor: req.actor });
}));
app.delete('/api/accounts/:id', need('accounts'), wrap(async (req, res) => {
  if (String(req.params.id) === String(req.admin.id)) return res.status(400).json({ error: 'нельзя удалить себя' });
  sessionCache.clear();
  await passthrough(res, 'DELETE', `/admin/accounts/${encodeURIComponent(req.params.id)}`, { actor: req.actor });
}));

// ─── Статика ────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));
// Статика маленькая: пусть браузер каждый раз сверяет версию, иначе после выкатки висит старый интерфейс.
app.use(express.static(publicDir, {
  index: 'index.html',
  etag: true,
  maxAge: 0,
  setHeaders: res => res.set('cache-control', 'no-cache'),
}));
app.get('*', (_req, res) => res.sendFile(`${publicDir}index.html`));

app.use((err, _req, res, _next) => {
  console.error('admin error:', err);
  res.status(err.status || 500).json({ error: err.message || 'internal error' });
});

app.listen(PORT, HOST, () => console.log(`w3a-funnel-admin listening on ${HOST}:${PORT}`));
