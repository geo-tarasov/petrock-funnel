// Сквозной тест: настоящие API и SQL (тестовая база), настоящая логика бота и админки,
// поддельный Telegram. Запуск: TEST_DATABASE_URL=postgres://... node test/e2e.mjs
// Задержки пропускаются переводом run_at у ожидающих задач на now().

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../api/package.json', import.meta.url));
const pg = require('pg');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) throw new Error('TEST_DATABASE_URL is required');

const PORTS = { tg: 39001, api: 39002, http: 39003, admin: 39004 };
const BLOCKED_CHAT = 666000666;
const BLOCKED_BROADCAST_CHAT = 666000777;
const blockedChats = new Set([BLOCKED_CHAT, BLOCKED_BROADCAST_CHAT]);

const OWNER = { login: 'owner', password: 'owner-password-1' };

Object.assign(process.env, {
  TG_BOT_TOKEN: '123456:TEST',
  API_URL: `http://127.0.0.1:${PORTS.api}`,
  API_TOKEN: 'test-token',
  PUBLIC_URL: `http://127.0.0.1:${PORTS.http}`,
  HTTP_PORT: String(PORTS.http),
  HOOK_SECRET: 'hook-secret',
  TIME_SCALE: '1',
  BROADCAST_PER_SECOND: '50',
});

// --- поддельный Telegram Bot API: записывает каждый вызов по чатам
const sent = [];
const tg = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const method = req.url.split('/').pop();
    let params = {};
    try {
      params = JSON.parse(body || '{}');
    } catch {
      // multipart (фото или кружок из кэша медиа)
      const field = name => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
      params = { chat_id: field('chat_id'), caption: field('caption'), reply_markup: field('reply_markup') && JSON.parse(field('reply_markup')),
        meta: { width: field('width'), height: field('height'), duration: field('duration'), streaming: field('supports_streaming'),
          length: field('length'), thumbnail: /name="thumbnail"/.test(body) } };
    }
    const chatId = Number(params.chat_id);
    res.setHeader('content-type', 'application/json');
    if (blockedChats.has(chatId)) {
      res.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
      return;
    }
    sent.push({ method, chatId, text: params.text || params.caption || '', markup: params.reply_markup, meta: params.meta });
    res.end(JSON.stringify({ ok: true, result: { message_id: sent.length, date: 0, chat: { id: chatId, type: 'private' } } }));
  });
});
await new Promise(r => tg.listen(PORTS.tg, '127.0.0.1', r));

// --- чистая тестовая база со свежей схемой и стартовой воронкой
const migrateEnv = { ...process.env, DATABASE_URL: DB, OWNER_LOGIN: OWNER.login, OWNER_PASSWORD: OWNER.password };
async function migrate() {
  await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['src/migrate.js'], {
      cwd: new URL('../api/', import.meta.url),
      env: migrateEnv,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    proc.on('exit', code => (code ? reject(new Error(`migrate exited ${code}`)) : resolve()));
  });
}

await migrate();
const pool = new pg.Pool({ connectionString: DB });
await pool.query(`TRUNCATE users, events, jobs, steps, settings, media, admins, admin_sessions, audit,
  broadcasts, broadcast_targets, leads RESTART IDENTITY CASCADE`);
await migrate();
await pool.query(`UPDATE settings SET value = 'https://t.me/+channel' WHERE key = 'channel_url'`);
await pool.query(`UPDATE settings SET value = '600' WHERE key = 'offer_seconds'`);
await rm(new URL('../bot/media-cache/', import.meta.url), { recursive: true, force: true });

// --- настоящий API на тестовой базе
const apiProc = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('../api/', import.meta.url),
  env: { ...process.env, PORT: String(PORTS.api), DATABASE_URL: DB, API_TOKEN: 'test-token', ALLOWED_IPS: '' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${process.env.API_URL}/health`)).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 200));
}

// --- настоящая админка поверх того же API
const adminProc = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('../admin/', import.meta.url),
  env: { ...process.env, PORT: String(PORTS.admin), HOST: '127.0.0.1', SECURE_COOKIE: 'false' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const ADMIN_URL = `http://127.0.0.1:${PORTS.admin}`;
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${ADMIN_URL}/health`)).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 200));
}

// --- настоящие модули бота, Telegram подменён
const { Bot } = await import('../bot/node_modules/grammy/out/mod.js');
const { api } = await import('../bot/src/api.js');
const funnel = await import('../bot/src/funnel.js');
const store = await import('../bot/src/store.js');
const { createHttpServer } = await import('../bot/src/http.js');
const { UserBlockedError } = await import('../bot/src/sender.js');
const { broadcastPass } = await import('../bot/src/worker.js');
const bot = new Bot(process.env.TG_BOT_TOKEN, { client: { apiRoot: `http://127.0.0.1:${PORTS.tg}` } });
bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
const server = createHttpServer(bot);

// Прогоняет очередь по «виртуальному времени»: сдвигает ожидающие задачи так, чтобы ближайшая
// стала срочной, и выполняет только её момент. Порядок отправки — как в реальной жизни.
// Вместе с очередью сдвигается и Т0 пользователей, чтобы дедлайны шли в ногу.
async function drain({ rounds } = {}) {
  const limit = rounds ?? 80;
  for (let i = 0; i < limit; i++) {
    const { rows: [{ lag }] } = await pool.query(
      `SELECT extract(epoch FROM min(run_at) - now())::float AS lag FROM jobs WHERE status = 'pending'`
    );
    if (lag === null) return;
    if (lag > 0) {
      const shift = lag + 0.01;
      await pool.query(`UPDATE jobs SET run_at = run_at - make_interval(secs => $1) WHERE status = 'pending'`, [shift]);
      await pool.query(
        `UPDATE users SET created_at = created_at - make_interval(secs => $1),
           clicked_at = clicked_at - make_interval(secs => $1), offer_at = offer_at - make_interval(secs => $1),
           video_at = video_at - make_interval(secs => $1), paid_at = paid_at - make_interval(secs => $1)`,
        [shift]
      );
    }
    const jobs = await api.claim(50);
    for (const job of jobs) {
      try {
        await funnel.runStep(bot, job);
      } catch (err) {
        if (!(err instanceof UserBlockedError)) throw err;
      }
      await api.done(job.id);
    }
  }
  if (rounds === undefined) throw new Error('drain did not settle');
}

async function steps(userId) {
  const { rows } = await pool.query(`SELECT data->>'step' AS step FROM events WHERE user_id = $1 AND type = 'sent' ORDER BY id`, [userId]);
  return rows.map(r => r.step);
}

async function skipped(userId) {
  const { rows } = await pool.query(`SELECT data FROM events WHERE user_id = $1 AND type = 'skipped' ORDER BY id`, [userId]);
  return rows.map(r => r.data);
}

async function pending(userId) {
  const { rows } = await pool.query(`SELECT step FROM jobs WHERE user_id = $1 AND status = 'pending' ORDER BY step`, [userId]);
  return rows.map(r => r.step);
}

async function startUser(tgId, extra = {}) {
  const r = await api.start({ tg_id: tgId, first_name: 'Тест', ...extra });
  await funnel.onStart(bot, r.user, r);
  return r.user;
}

const get = path => fetch(`${process.env.PUBLIC_URL}${path}`, { redirect: 'manual' });
const chat = id => sent.filter(s => s.chatId === id);
const fresh = () => store.load({ force: true });

// Прогоняет рассылку до конца: последний проход без целей помечает её завершённой.
async function drainBroadcasts(limit = 30) {
  for (let i = 0; i < limit; i++) if (!await broadcastPass(bot, { pace: false })) return;
  throw new Error('рассылка не завершилась');
}

// --- клиент админки с cookie-сессией
async function loginAs(login, password) {
  const res = await fetch(`${ADMIN_URL}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin': '1' },
    body: JSON.stringify({ login, password }),
  });
  const cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const data = await res.json().catch(() => ({}));
  return {
    status: res.status,
    me: data.me,
    error: data.error,
    async call(method, path, body, raw) {
      const response = await fetch(`${ADMIN_URL}${path}`, {
        method,
        headers: {
          cookie,
          'x-admin': '1',
          ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
          ...(raw ? { 'content-type': raw } : {}),
        },
        body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
      });
      const payload = response.headers.get('content-type')?.includes('json')
        ? await response.json().catch(() => ({}))
        : await response.text();
      return { status: response.status, data: payload };
    },
  };
}

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push(`✅ ${name}`);
  } catch (err) {
    results.push(`❌ ${name}\n   ${(err.message || String(err)).split('\n').join('\n   ')}`);
  }
}

// ─── Воронка ────────────────────────────────────────────────────────────────
// Схема воронки: от Т0 три ветки идут параллельно,
// в каждой точке человек получает сообщение только своей ветки.

await pool.query(`UPDATE settings SET value = '9 000' WHERE key = 'price'`);
await fresh();

const NOT_CLICKED = ['s00', 's01', 'c_2h', 'c_6h', 'c_10h', 'c_20h', 'c_23h', 'closed'];
const CLICKED = ['s00', 's01', 'b_2h', 'b_6h', 'b_10h', 'b_20h', 'b_23h', 'closed'];
// a_23h_note — кружок без текста: в тестовой базе файла нет, поэтому шаг пропускается
const OFFER = ['s00', 's01', 'a_offer', 'a_6h', 'a_10h', 'a_12h', 'a_20h', 'a_20h_ps', 'a_23h', 'closed'];

await scenario('Не нажал на видео: ветка «не нажал» по точкам Т0 и «Доступ закрыт»', async () => {
  const u = await startUser(1001);
  await drain();
  assert.deepEqual(await steps(u.id), NOT_CLICKED);
  assert.deepEqual(await pending(u.id), []);
  const reasons = (await skipped(u.id)).filter(s => s.reason?.startsWith('нет файла')).map(s => s.step);
  assert.deepEqual(reasons.sort(), ['c_12h', 'c_5m'], 'кружки без записи пропущены');
  const msgs = chat(1001);
  assert.ok(msgs[0].markup?.inline_keyboard?.[0]?.[0]?.url.endsWith('/channel'), 's00: кнопка канала');
  assert.ok(msgs[1].markup?.inline_keyboard?.[0]?.[0]?.url.endsWith('/video'), 's01: кнопка видео');
});

await scenario('Нажал, но не досмотрел: ветка «нажал», «не нажал» отменена', async () => {
  const u = await startUser(1002);
  await drain({ rounds: 1 });
  assert.deepEqual(await steps(u.id), ['s00', 's01']);
  const r = await get(`/c/${u.token}/video`);
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('location').endsWith(`/w/${u.token}`));
  await drain();
  assert.deepEqual(await steps(u.id), CLICKED);
});

await scenario('Досмотрел до оффера и не купил: оффер через 10 минут и ветка «досмотрел»', async () => {
  const u = await startUser(1003);
  await drain({ rounds: 1 });
  await get(`/c/${u.token}/video`);
  const page = await (await get(`/w/${u.token}`)).text();
  assert.ok(page.includes('test-offer'), 'кнопка теста на странице-заглушке');
  const r = await fetch(`${process.env.PUBLIC_URL}/api/video`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: u.token, type: 'offer', t: 2100 }),
  });
  assert.equal(r.status, 200);
  const { rows } = await pool.query(`SELECT round(extract(epoch FROM run_at - now())) AS d FROM jobs WHERE user_id = $1 AND step = 'a_offer'`, [u.id]);
  assert.equal(Number(rows[0].d), 600, 'оффер через 10 минут');
  await drain();
  assert.deepEqual(await steps(u.id), OFFER);
  const offer = chat(1003).find(m => m.text.includes('Капитал есть'));
  assert.ok(offer.text.includes('9 000 ₽'), 'цена подставлена');
  assert.ok(offer.markup.inline_keyboard[0][0].url.endsWith(`/c/${u.token}/offer`), 'кнопка оплаты');
});

await scenario('Без цены сообщения с {price} не уходят, а помечаются пропущенными', async () => {
  await pool.query(`UPDATE settings SET value = '' WHERE key = 'price'`);
  await fresh();
  const u = await startUser(1013);
  await drain({ rounds: 1 });
  await get(`/c/${u.token}/video`);
  await funnel.onOffer(await api.user(u.id), { t: 2100 });
  await drain({ rounds: 1 });
  assert.ok(!(await steps(u.id)).includes('a_offer'));
  assert.ok((await skipped(u.id)).some(s => s.step === 'a_offer' && s.reason === 'не заполнено: price'));
  await pool.query(`UPDATE settings SET value = '9 000' WHERE key = 'price'`);
  await fresh();
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE user_id = $1`, [u.id]);
});

await scenario('Оплата хуком GC посреди ветки «досмотрел»: дальше ничего не уходит', async () => {
  const u = await startUser(1004, { start_param: 'u555' });
  await drain({ rounds: 1 });
  await get(`/c/${u.token}/video`);
  await funnel.onOffer(await api.user(u.id), { t: 2100 });
  await drain({ rounds: 2 });
  assert.deepEqual(await steps(u.id), ['s00', 's01', 'a_offer', 'a_6h']);
  const bad = await get('/hooks/gc/payment?secret=wrong&user_id=555');
  assert.equal(bad.status, 403);
  const ok = await (await get('/hooks/gc/payment?secret=hook-secret&user_id=555&email=x@y.z')).json();
  assert.equal(ok.matched, 1);
  await drain();
  assert.deepEqual(await steps(u.id), ['s00', 's01', 'a_offer', 'a_6h', 'bought'], 'после оплаты — только сообщение об оплате');
  assert.ok(chat(1004).at(-1).text.includes('Проверь почту x@y.z'), 'почта из хука оплаты');
  assert.deepEqual(await pending(u.id), []);
});

await scenario('Оплата по email из start-параметра e_<base64url>, до клика', async () => {
  const email = 'Buyer@Mail.ru';
  const u = await startUser(1005, { start_param: `e_${Buffer.from(email).toString('base64url')}` });
  await drain({ rounds: 1 });
  const ok = await (await fetch(`${process.env.PUBLIC_URL}/hooks/gc/payment`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: 'hook-secret', email: 'buyer@mail.ru' }),
  })).json();
  assert.equal(ok.matched, 1);
  await drain();
  assert.deepEqual(await steps(u.id), ['s00', 's01', 'bought'], 'купившему «Доступ закрыт» не приходит');
  assert.ok(chat(1005).at(-1).text.includes('Проверь почту buyer@mail.ru'));
});

await scenario('Повторная оплата не срабатывает второй раз', async () => {
  const again = await (await get('/hooks/gc/payment?secret=hook-secret&user_id=555')).json();
  assert.equal(again.matched, 0);
});

await scenario('Заблокировал бота → очередь очищена; вернулся → ветки встали на ближайшие точки', async () => {
  const r = await api.start({ tg_id: BLOCKED_CHAT, first_name: 'Blocked' });
  await funnel.onStart(bot, r.user, r).catch(err => { if (!(err instanceof UserBlockedError)) throw err; });
  const u = await api.user(r.user.id);
  assert.ok(u.blocked_at, 'отмечен заблокировавшим');
  assert.deepEqual(await pending(u.id), []);
  // прошёл час: Т0 в прошлом, ближайшие точки — +2 ч и дальше
  await pool.query(`UPDATE users SET tg_id = 1007, created_at = now() - interval '1 hour' WHERE id = $1`, [u.id]);
  const back = await api.start({ tg_id: 1007, first_name: 'Blocked' });
  assert.equal(back.wasBlocked, true);
  await funnel.onStart(bot, back.user, back);
  assert.deepEqual(await pending(u.id), ['a_6h', 'b_2h', 'c_2h', 'closed']);
  const { rows } = await pool.query(`SELECT round(extract(epoch FROM run_at - now()) / 60) AS m FROM jobs WHERE user_id = $1 AND step = 'c_2h' AND status = 'pending'`, [u.id]);
  assert.equal(Number(rows[0].m), 60, 'Т0 + 2 ч = через час');
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE user_id = $1`, [u.id]);
});

await scenario('Двойной быстрый /start: без ошибки, воронка стартует один раз', async () => {
  const [a, b] = await Promise.all([api.start({ tg_id: 1008 }), api.start({ tg_id: 1008 })]);
  assert.equal([a.isNew, b.isNew].filter(Boolean).length, 1);
});

await scenario('Повторный клик и повторный оффер не дублируют задачи', async () => {
  const u = await startUser(1009);
  await drain({ rounds: 1 });
  await get(`/c/${u.token}/video`);
  await get(`/c/${u.token}/video`);
  assert.deepEqual(await pending(u.id), ['a_6h', 'b_2h', 'closed']);
  await funnel.onOffer(await api.user(u.id), {});
  await funnel.onOffer(await api.user(u.id), {});
  assert.deepEqual(await pending(u.id), ['a_6h', 'a_offer', 'closed']);
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE user_id = $1`, [u.id]);
});

await scenario('Клик по кнопке канала не считается кликом по видео', async () => {
  const u = await startUser(1010);
  const r = await get(`/c/${u.token}/channel`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://t.me/+channel');
  assert.equal((await api.user(u.id)).clicked_at, null);
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE user_id = $1`, [u.id]);
});

await scenario('Тестовый режим time_scale=0.01: секунды реальные, часы сжаты до ≥60с', async () => {
  const r = await api.start({ tg_id: 1011, time_scale: 0.01 });
  await funnel.onStart(bot, r.user, r);
  const { rows } = await pool.query(`SELECT step, round(extract(epoch FROM run_at - created_at)) AS d FROM jobs WHERE user_id = $1 ORDER BY run_at`, [r.user.id]);
  assert.equal(rows[0].step, 's01');
  assert.equal(Number(rows[0].d), 5);
  assert.equal(Number(rows.find(x => x.step === 'closed').d), 864, 'сутки сжаты до 14,4 минуты');
  const { config } = await import('../bot/src/config.js');
  assert.equal(config.delay(36000, r.user), 360);
  assert.equal(config.delay(36000, { time_scale: 1 }), 36000);
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE user_id = $1`, [r.user.id]);
});

await scenario('Подстановки: дедлайн в МСК, ссылки в тексте ведут через трекинг', async () => {
  const u = await startUser(1014);
  await drain({ rounds: 1 });
  const [first, second] = chat(1014);
  assert.ok(first.text.includes(`/c/${u.token}/channel`), 'ссылка «этой ссылке» в s00 — на канал');
  assert.ok(second.text.includes(`/c/${u.token}/video`), 'ссылка «ссылка на видео» в s01');
  assert.match(second.text, /видео будет доступно 24 часа до \d{1,2} [а-я]+, \d\d:\d\d МСК/);
  assert.ok(!second.text.includes('{'), 'ни одной неподставленной переменной');
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE user_id = $1`, [u.id]);
});

await scenario('Кнопка оплаты: без ссылки на оплату ведёт на видео, со ссылкой — на оплату', async () => {
  const u = await startUser(1015);
  const toVideo = await get(`/c/${u.token}/offer`);
  assert.ok(toVideo.headers.get('location').endsWith(`/w/${u.token}`));
  await pool.query(`UPDATE settings SET value = 'https://pay.example/afk' WHERE key = 'checkout_url'`);
  await fresh();
  const toPay = await get(`/c/${u.token}/offer`);
  assert.equal(toPay.headers.get('location'), 'https://pay.example/afk');
  await pool.query(`UPDATE settings SET value = '' WHERE key = 'checkout_url'`);
  await fresh();
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE user_id = $1`, [u.id]);
});

await scenario('Через 24 часа страница с видео закрывается, до этого — таймер', async () => {
  const u = await startUser(1016);
  const open = await (await get(`/w/${u.token}`)).text();
  assert.ok(open.includes('До закрытия доступа'));
  await pool.query(`UPDATE users SET created_at = now() - interval '25 hours' WHERE id = $1`, [u.id]);
  const closed = await (await get(`/w/${u.token}`)).text();
  assert.ok(closed.includes('Доступ закрыт'));
  assert.ok(!closed.includes('test-offer'));
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE user_id = $1`, [u.id]);
});

await scenario('Неизвестный токен: 404 на ссылке и странице', async () => {
  assert.equal((await get('/c/unknowntoken123/video')).status, 404);
  assert.equal((await get('/w/unknowntoken123')).status, 404);
});

// ─── Расписание и даты ──────────────────────────────────────────────────────

// «Прошло время»: сдвигаем Т0 пользователей и очередь назад.
async function passTime(seconds) {
  await pool.query(`UPDATE users SET created_at = created_at - make_interval(secs => $1)`, [seconds]);
  await pool.query(`UPDATE users SET clicked_at = clicked_at - make_interval(secs => $1) WHERE clicked_at IS NOT NULL`, [seconds]);
  await pool.query(`UPDATE users SET offer_at = offer_at - make_interval(secs => $1) WHERE offer_at IS NOT NULL`, [seconds]);
  await pool.query(`UPDATE jobs SET run_at = run_at - make_interval(secs => $1) WHERE status = 'pending'`, [seconds]);
}

async function isolate() {
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE status = 'pending'`);
}

await scenario('Точки веток совпадают: «не нажал» и «нажал» на Т0 + 2 ч в одну и ту же секунду', async () => {
  await isolate();
  const u = await startUser(1101);
  await drain({ rounds: 2 }); // s01, c_5m
  const { rows } = await pool.query(
    `SELECT step, extract(epoch FROM run_at - $2::timestamptz)::float AS at FROM jobs WHERE user_id = $1 AND status = 'pending' AND step IN ('c_2h', 'b_2h')`,
    [u.id, (await api.user(u.id)).created_at]
  );
  const at = Object.fromEntries(rows.map(r => [r.step, Math.round(r.at)]));
  assert.equal(at.c_2h, 7200);
  assert.equal(at.b_2h, 7200);
  await isolate();
});

await scenario('Клик после Т0 + 2 ч: в точке +2 ч уходит сообщение ветки «не нажал», дальше — «нажал»', async () => {
  await isolate();
  const u = await startUser(1102);
  await drain({ rounds: 3 }); // s01, c_5m, точка +2 ч (c_2h и b_2h)
  await get(`/c/${u.token}/video`);
  await drain();
  assert.deepEqual(await steps(u.id), ['s00', 's01', 'c_2h', 'b_6h', 'b_10h', 'b_20h', 'b_23h', 'closed']);
});

await scenario('Тестовый режим: порядок как в жизни — «Доступ закрыт» после напоминаний за час', async () => {
  await isolate();
  const r = await api.start({ tg_id: 1103, time_scale: 0.01 });
  await funnel.onStart(bot, r.user, r);
  await drain();
  assert.deepEqual(await steps(r.user.id), NOT_CLICKED, 'закрытие — последним');
});

await scenario('Оффер на Т0 + 23 ч: сначала сообщение оффера, кружок ветки «досмотрел» его не обгоняет', async () => {
  await isolate();
  const u = await startUser(1104);
  await drain({ rounds: 1 });
  await get(`/c/${u.token}/video`);
  for (let i = 0; i < 40 && !(await steps(u.id)).includes('b_23h'); i++) await drain({ rounds: 1 });
  await funnel.onOffer(await api.user(u.id), { t: 2100 });
  await drain();
  const list = await steps(u.id);
  assert.deepEqual(list.slice(-3), ['b_23h', 'a_offer', 'closed']);
  assert.ok((await skipped(u.id)).some(s => s.step === 'a_23h_note' && s.reason === 'раньше сообщения оффера'));
});

await scenario('Оффер за 5 минут до конца: сообщение оффера после дедлайна не уходит, последним — «Доступ закрыт»', async () => {
  await isolate();
  const u = await startUser(1105);
  await drain({ rounds: 1 });
  await get(`/c/${u.token}/video`);
  for (let i = 0; i < 40 && !(await steps(u.id)).includes('b_23h'); i++) await drain({ rounds: 1 });
  await passTime(55 * 60); // Т0 + 23 ч 55 мин
  await funnel.onOffer(await api.user(u.id), { t: 2100 });
  await drain();
  const list = await steps(u.id);
  assert.deepEqual(list.slice(-2), ['b_23h', 'closed']);
  assert.ok((await skipped(u.id)).some(s => s.step === 'a_offer' && s.reason === 'после дедлайна'));
});

await scenario('Бот лежал 7 часов: приходит только текущая точка, а не пачка пропущенных', async () => {
  await isolate();
  const u = await startUser(1106);
  await drain({ rounds: 1 }); // s01
  await passTime(7 * 3600);
  // выполняем только то, что уже должно было уйти, без перемотки вперёд
  for (let i = 0; i < 10; i++) {
    const jobs = await api.claim(50);
    if (!jobs.length) break;
    for (const job of jobs) { await funnel.runStep(bot, job); await api.done(job.id); }
  }
  const list = await steps(u.id);
  assert.deepEqual(list, ['s00', 's01', 'c_6h']);
  const stale = (await skipped(u.id)).filter(s => s.reason?.startsWith('устарел')).map(s => s.step);
  assert.ok(stale.includes('c_2h'), 'пропущенная точка +2 ч не догоняет');
  await isolate();
});

await scenario('Даты в тексте: в тестовом режиме — честные сутки, а не 14 минут', async () => {
  await isolate();
  const r = await api.start({ tg_id: 1107, time_scale: 0.01, first_name: 'Тест' });
  await funnel.onStart(bot, r.user, r);
  await drain({ rounds: 1 });
  const text = chat(1107).at(-1).text;
  const { formatDeadline } = await import('../bot/src/deadline.js');
  const t0 = new Date((await api.user(r.user.id)).created_at).getTime();
  const expected = formatDeadline(new Date(t0 + 24 * 3600 * 1000));
  assert.ok(text.includes(`доступно 24 часа до ${expected}`), `${expected} в тексте s01`);
  await isolate();
});

await scenario('Повторный /start после дедлайна: «Доступ закрыт» вместо ссылки со вчерашней датой', async () => {
  await isolate();
  const u = await startUser(1108);
  await pool.query(`UPDATE users SET created_at = now() - interval '30 hours' WHERE id = $1`, [u.id]);
  const before = sent.length;
  const back = await api.start({ tg_id: 1108, first_name: 'Тест' });
  await funnel.onStart(bot, back.user, back);
  const mine = sent.slice(before).filter(s => s.chatId === 1108);
  assert.equal(mine.length, 1);
  assert.ok(mine[0].text.includes('Доступ закрыт'));
  await isolate();
});

// ─── Админка ────────────────────────────────────────────────────────────────

let owner = null;

await scenario('Вход в админку: неверный пароль отклонён, верный даёт сессию владельца', async () => {
  const bad = await loginAs(OWNER.login, 'wrong-password');
  assert.equal(bad.status, 401);
  owner = await loginAs(OWNER.login, OWNER.password);
  assert.equal(owner.status, 200);
  assert.equal(owner.me.role, 'owner');
  const me = await owner.call('GET', '/api/me');
  assert.equal(me.data.me.login, OWNER.login);
  assert.ok(me.data.me.permissions.includes('accounts'));
});

await scenario('Без сессии админка ничего не отдаёт', async () => {
  const res = await fetch(`${ADMIN_URL}/api/config`);
  assert.equal(res.status, 401);
});

await scenario('Правка текста шага в админке доходит до бота', async () => {
  const text = 'Новый текст первого сообщения для {name}';
  const saved = await owner.call('PATCH', '/api/steps/s00', { text });
  assert.equal(saved.status, 200);
  await fresh();
  const u = await startUser(1020, { first_name: 'Олег' });
  assert.equal(chat(1020)[0].text, 'Новый текст первого сообщения для Олег');
  await owner.call('PATCH', '/api/steps/s00', { text: 'Привет, {name}!' });
  await fresh();
  assert.ok(u.id);
});

await scenario('Вставка шага в цепочку и удаление возвращает связь', async () => {
  const created = await owner.call('POST', '/api/steps', { key: 'extra_step', title: 'Вставка', after_key: 's00' });
  assert.equal(created.status, 200);
  await owner.call('PATCH', '/api/steps/extra_step', { text: 'Вставленное сообщение', delay_seconds: 5 });
  await fresh();

  const u = await startUser(1021);
  await drain();
  assert.deepEqual((await steps(u.id)).slice(0, 3), ['s00', 'extra_step', 's01']);

  const removed = await owner.call('DELETE', '/api/steps/extra_step');
  assert.equal(removed.status, 200);
  await fresh();
  const u2 = await startUser(1022);
  await drain({ rounds: 3 });
  assert.deepEqual((await steps(u2.id)).slice(0, 2), ['s00', 's01']);
});

await scenario('Выключенный шаг пропускается, цепочка идёт дальше', async () => {
  await owner.call('PATCH', '/api/steps/c_6h', { enabled: false });
  await fresh();
  const u = await startUser(1023);
  await drain();
  const list = await steps(u.id);
  assert.ok(!list.includes('c_6h'), 'выключенный шаг не отправлен');
  assert.ok(list.includes('c_10h'), 'следующий шаг отправлен');
  await owner.call('PATCH', '/api/steps/c_6h', { enabled: true });
  await fresh();
});

await scenario('Шаг с триггером удалить нельзя', async () => {
  const res = await owner.call('DELETE', '/api/steps/s00');
  assert.equal(res.status, 400);
});

await scenario('Кольцо в цепочке шагов не сохраняется', async () => {
  const loop = await owner.call('PATCH', '/api/steps/s01', { next_key: 's00' });
  assert.equal(loop.status, 400, JSON.stringify(loop.data));
  const self = await owner.call('PATCH', '/api/steps/s01', { next_key: 's01' });
  assert.equal(self.status, 400, JSON.stringify(self.data));
  const { data } = await owner.call('GET', '/api/config');
  assert.equal(data.steps.find(s => s.key === 's01').next_key, null);
});

await scenario('Загруженное в админку медиа уходит в Telegram картинкой с подписью', async () => {
  const jpeg = Buffer.from('fake-jpeg-content');
  const upload = await owner.call('POST', '/api/media?key=test_photo&kind=photo&filename=test.jpg&mime=image/jpeg', jpeg, 'application/octet-stream');
  assert.equal(upload.status, 200);
  await owner.call('PATCH', '/api/steps/s00', { media_key: 'test_photo', text: 'Короткая подпись' });
  await fresh();

  const before = sent.length;
  await startUser(1024);
  const methods = sent.slice(before).filter(s => s.chatId === 1024).map(s => s.method);
  assert.deepEqual(methods, ['sendPhoto']);
  assert.equal(chat(1024)[0].text, 'Короткая подпись');
});

await scenario('Медиа, загруженное только что, уходит без перезагрузки конфигурации', async () => {
  // бот держит воронку в памяти 10 секунд: только что загруженный файл он обязан подхватить сам
  await owner.call('POST', '/api/media?key=hot_photo&kind=photo&filename=hot.jpg&mime=image/jpeg',
    Buffer.from('hot-jpeg'), 'application/octet-stream');
  await owner.call('PATCH', '/api/steps/s00', { media_key: 'hot_photo', text: 'Свежая картинка' });

  const before = sent.length;
  await startUser(1027);
  const mine = sent.slice(before).filter(s => s.chatId === 1027);
  assert.deepEqual(mine.map(s => s.method), ['sendPhoto'], 'картинка ушла без ручного обновления кэша');
});

await scenario('Кружок уходит видеосообщением, текст отдельно с кнопкой', async () => {
  const upload = await owner.call('POST', '/api/media?key=test_note&kind=video_note&filename=note.mp4&mime=video/mp4',
    Buffer.from('fake-mp4'), 'application/octet-stream');
  assert.equal(upload.status, 200);
  await owner.call('PATCH', '/api/steps/c_5m', {
    media_key: 'test_note', text: 'Текст под кружком', buttons: [{ text: 'Смотреть', action: 'video' }],
  });
  await fresh();

  // в общей очереди не должно быть чужих задач: прогон двигает время для всех
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE status = 'pending'`);
  const before = sent.length;
  const u = await startUser(1025);
  await drain({ rounds: 2 });
  const mine = sent.slice(before).filter(s => s.chatId === 1025);
  assert.deepEqual(mine.map(s => s.method).slice(-2), ['sendVideoNote', 'sendMessage']);
  assert.ok(mine.at(-1).markup?.inline_keyboard?.[0]?.[0]?.url.includes(u.token));
  await owner.call('PATCH', '/api/steps/c_5m', { media_key: 'note_c01', text: '', buttons: [] });
  await fresh();
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE user_id = $1`, [u.id]);
});

await scenario('Настройки из админки: смена ссылки на канал меняет редирект', async () => {
  const res = await owner.call('PUT', '/api/settings', { channel_url: 'https://t.me/defi_shashkov' });
  assert.equal(res.status, 200);
  await fresh();
  const u = await startUser(1026);
  const r = await get(`/c/${u.token}/channel`);
  assert.equal(r.headers.get('location'), 'https://t.me/defi_shashkov');
  await owner.call('PUT', '/api/settings', { channel_url: 'https://t.me/+channel' });
  await fresh();
});

await scenario('Тестировщики из настроек админки получают /test и остальные служебные команды', async () => {
  const { isAdminId } = await import('../bot/src/access.js');
  assert.equal(await isAdminId(700000002), false, 'до добавления — нет доступа');
  await owner.call('PUT', '/api/settings', { tester_tg_ids: '700000001, 700000002' });
  await fresh();
  assert.equal(await isAdminId(700000002), true);
  assert.equal(await isAdminId(700000001), true);
  assert.equal(await isAdminId(123456789), false);
  await owner.call('PUT', '/api/settings', { tester_tg_ids: '' });
  await fresh();
});

await scenario('Роли: маркетолог не трогает воронку, но шлёт рассылки; наблюдатель только смотрит', async () => {
  const created = await owner.call('POST', '/api/accounts', {
    login: 'marketer1', name: 'Маркетолог', role: 'marketer', password: 'marketer-pass', tg_id: '1030',
  });
  assert.equal(created.status, 200);
  await owner.call('POST', '/api/accounts', { login: 'viewer1', name: 'Наблюдатель', role: 'viewer', password: 'viewer-pass' });

  const marketer = await loginAs('marketer1', 'marketer-pass');
  assert.equal(marketer.status, 200);
  assert.equal((await marketer.call('PATCH', '/api/steps/s00', { text: 'нельзя' })).status, 403);
  assert.equal((await marketer.call('GET', '/api/config')).status, 200);
  assert.equal((await marketer.call('POST', '/api/broadcasts', { title: 'От маркетолога', text: 'привет' })).status, 200);
  assert.equal((await marketer.call('GET', '/api/accounts')).status, 403);

  const viewer = await loginAs('viewer1', 'viewer-pass');
  assert.equal((await viewer.call('GET', '/api/users?limit=5')).status, 200);
  assert.equal((await viewer.call('POST', '/api/broadcasts', { title: 'нельзя', text: 'нет' })).status, 403);
  assert.equal((await viewer.call('PUT', '/api/settings', { channel_url: 'x' })).status, 403);
});

await scenario('Последнего владельца нельзя разжаловать', async () => {
  const me = await owner.call('GET', '/api/me');
  const res = await owner.call('PATCH', `/api/accounts/${me.data.me.id}`, { role: 'viewer' });
  assert.equal(res.status, 400);
  assert.ok(String(res.data.error).includes('владелец'));
});

await scenario('Отключённый аккаунт больше не входит', async () => {
  const { data } = await owner.call('GET', '/api/accounts');
  const viewer = data.accounts.find(a => a.login === 'viewer1');
  assert.equal((await owner.call('PATCH', `/api/accounts/${viewer.id}`, { disabled: true })).status, 200);
  const attempt = await loginAs('viewer1', 'viewer-pass');
  assert.equal(attempt.status, 401);
});

await scenario('Журнал действий пишет, кто менял шаги', async () => {
  const { data } = await owner.call('GET', '/api/audit?limit=50');
  const entry = data.audit.find(a => a.action === 'step.update');
  assert.ok(entry, 'есть запись о правке шага');
  assert.equal(entry.login, OWNER.login);
});

// ─── Рассылки ───────────────────────────────────────────────────────────────

await scenario('Тестовая рассылка уходит только на указанный Telegram id', async () => {
  const { data } = await owner.call('POST', '/api/broadcasts', {
    title: 'Проверка себе', text: 'Тестовое сообщение <b>жирным</b>', segment: 'test',
  });
  const patched = await owner.call('PATCH', `/api/broadcasts/${data.broadcast.id}`, { segment: 'test', test_tg_ids: ['1001'] });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  assert.deepEqual(patched.data.broadcast.test_tg_ids, ['1001'], JSON.stringify(patched.data));
  const started = await owner.call('POST', `/api/broadcasts/${data.broadcast.id}/start`);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.total, 1);

  const before = sent.length;
  assert.equal(await broadcastPass(bot, { pace: false }), 1);
  const justSent = sent.slice(before);
  assert.equal(justSent.length, 1);
  assert.equal(justSent[0].chatId, 1001);
  assert.ok(justSent[0].text.includes('Тестовое сообщение'));
  await drainBroadcasts();

  const after = await owner.call('GET', `/api/broadcasts/${data.broadcast.id}`);
  assert.equal(after.data.broadcast.sent, 1);
});

await scenario('Рассылка по сегменту «не купили» не трогает купивших', async () => {
  const audience = await owner.call('GET', '/api/audience?segment=not_paid');
  assert.ok(audience.data.count > 0);

  const { data } = await owner.call('POST', '/api/broadcasts', { title: 'Дожим', text: 'Ещё можно успеть', segment: 'not_paid' });
  const started = await owner.call('POST', `/api/broadcasts/${data.broadcast.id}/start`);
  assert.equal(started.data.total, audience.data.count);

  const before = sent.length;
  await drainBroadcasts();
  const chats = new Set(sent.slice(before).map(s => s.chatId));

  const { rows: paid } = await pool.query('SELECT tg_id FROM users WHERE paid_at IS NOT NULL');
  for (const row of paid) assert.ok(!chats.has(Number(row.tg_id)), `купивший ${row.tg_id} не получил рассылку`);
  assert.ok(chats.has(1001), 'обычный пользователь получил рассылку');

  const done = await owner.call('GET', `/api/broadcasts/${data.broadcast.id}`);
  assert.equal(done.data.broadcast.status, 'done');
  assert.equal(done.data.broadcast.pending, 0);
});

await scenario('Кнопка «видео» в рассылке ведёт по персональной ссылке получателя', async () => {
  const { data } = await owner.call('POST', '/api/broadcasts', {
    title: 'С кнопкой', text: 'Смотри', segment: 'test',
    buttons: [{ text: 'Смотреть видео', action: 'video' }],
  });
  await owner.call('PATCH', `/api/broadcasts/${data.broadcast.id}`, { segment: 'test', test_tg_ids: ['1002'] });
  await owner.call('POST', `/api/broadcasts/${data.broadcast.id}/start`);

  const before = sent.length;
  await drainBroadcasts();
  const message = sent.slice(before).find(s => s.chatId === 1002);
  const { rows } = await pool.query('SELECT token FROM users WHERE tg_id = 1002');
  assert.ok(message.markup.inline_keyboard[0][0].url.endsWith(`/c/${rows[0].token}/video`));
});

await scenario('Рассылка с {deadline} и {price} подставляет дату и цену получателя', async () => {
  const { data } = await owner.call('POST', '/api/broadcasts', {
    title: 'С дедлайном', text: 'Доступ до {deadline}, цена {price} ₽', segment: 'test',
  });
  await owner.call('PATCH', `/api/broadcasts/${data.broadcast.id}`, { segment: 'test', test_tg_ids: ['1002'] });
  await owner.call('POST', `/api/broadcasts/${data.broadcast.id}/start`);
  const before = sent.length;
  await drainBroadcasts();
  const message = sent.slice(before).find(s => s.chatId === 1002);
  assert.ok(message, 'сообщение доставлено');
  assert.match(message.text, /Доступ до \d{1,2} [а-я]+, \d\d:\d\d МСК, цена 9 000 ₽/);
});

await scenario('Рассылка с медиа уходит картинкой', async () => {
  const { data } = await owner.call('POST', '/api/broadcasts', {
    title: 'С картинкой', text: 'Подпись к картинке', segment: 'test', media_key: 'test_photo',
  });
  await owner.call('PATCH', `/api/broadcasts/${data.broadcast.id}`, { segment: 'test', test_tg_ids: ['1003'] });
  await owner.call('POST', `/api/broadcasts/${data.broadcast.id}/start`);

  const before = sent.length;
  await drainBroadcasts();
  const message = sent.slice(before).find(s => s.chatId === 1003);
  assert.equal(message.method, 'sendPhoto');
  assert.equal(message.text, 'Подпись к картинке');
});

await scenario('Заблокировавший бота помечается в рассылке и в базе', async () => {
  const r = await api.start({ tg_id: BLOCKED_BROADCAST_CHAT, first_name: 'Блок' });
  await pool.query(`UPDATE jobs SET status = 'canceled' WHERE user_id = $1`, [r.user.id]);
  const { data } = await owner.call('POST', '/api/broadcasts', { title: 'В заблокированного', text: 'Привет', segment: 'test' });
  await owner.call('PATCH', `/api/broadcasts/${data.broadcast.id}`, { segment: 'test', test_tg_ids: [String(BLOCKED_BROADCAST_CHAT)] });
  await owner.call('POST', `/api/broadcasts/${data.broadcast.id}/start`);
  await drainBroadcasts();

  const after = await owner.call('GET', `/api/broadcasts/${data.broadcast.id}`);
  assert.equal(after.data.broadcast.blocked, 1);
  assert.equal(after.data.broadcast.sent, 0);
  const { rows } = await pool.query('SELECT blocked_at FROM users WHERE tg_id = $1', [BLOCKED_BROADCAST_CHAT]);
  assert.ok(rows[0].blocked_at, 'пользователь отмечен заблокировавшим');
});

await scenario('Остановленная рассылка больше ничего не отправляет', async () => {
  const { data } = await owner.call('POST', '/api/broadcasts', { title: 'Остановим', text: 'Сообщение', segment: 'all' });
  const started = await owner.call('POST', `/api/broadcasts/${data.broadcast.id}/start`);
  assert.ok(started.data.total > 1);
  assert.equal((await owner.call('POST', `/api/broadcasts/${data.broadcast.id}/cancel`)).status, 200);

  const before = sent.length;
  assert.equal(await broadcastPass(bot, { pace: false }), 0);
  assert.equal(sent.length, before);
  const after = await owner.call('GET', `/api/broadcasts/${data.broadcast.id}`);
  assert.equal(after.data.broadcast.status, 'canceled');
});

await scenario('Идущую рассылку нельзя удалить или отредактировать', async () => {
  const { data } = await owner.call('POST', '/api/broadcasts', { title: 'Идёт', text: 'Текст', segment: 'test' });
  await owner.call('PATCH', `/api/broadcasts/${data.broadcast.id}`, { segment: 'test', test_tg_ids: ['1001'] });
  await owner.call('POST', `/api/broadcasts/${data.broadcast.id}/start`);
  assert.equal((await owner.call('PATCH', `/api/broadcasts/${data.broadcast.id}`, { text: 'другой' })).status, 400);
  assert.equal((await owner.call('DELETE', `/api/broadcasts/${data.broadcast.id}`)).status, 400);
  await drainBroadcasts();
});

await scenario('Пустую рассылку запустить нельзя', async () => {
  const { data } = await owner.call('POST', '/api/broadcasts', { title: 'Пустая', text: '', segment: 'test' });
  await owner.call('PATCH', `/api/broadcasts/${data.broadcast.id}`, { segment: 'test', test_tg_ids: ['1001'] });
  const res = await owner.call('POST', `/api/broadcasts/${data.broadcast.id}/start`);
  assert.equal(res.status, 400);
});

// ─── Заявки с лендинга ──────────────────────────────────────────────────────
// Лендинг шлёт заявку на /hooks/lead админки, id заявки стоит в ссылке t.me/<бот>?start=<id>.

const { rows: [{ value: LEADS_KEY }] } = await pool.query(`SELECT value FROM settings WHERE key = 'leads_api_key'`);
const LEAD_1 = 'b3f1c2d4-0001-4a5b-9c6d-7e8f9a0b1c2d';

async function sendLead(body, { key = LEADS_KEY, type = 'application/json', raw } = {}) {
  const res = await fetch(`${ADMIN_URL}/hooks/lead`, {
    method: 'POST',
    headers: { 'content-type': type, ...(key ? { 'x-api-key': key } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
}

async function lead(id) {
  const { rows } = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
  return rows[0] || null;
}

await scenario('Заявка с лендинга, потом Start: заявка связана с человеком, воронка пошла', async () => {
  assert.ok(LEADS_KEY && LEADS_KEY.length >= 20, 'ключ создан миграцией');
  const r = await sendLead({
    lead_id: LEAD_1, name: 'Иван', phone: '+79990000001', email: 'Ivan@Example.com',
    utm_source: 'vk', utm_medium: 'cpc', utm_campaign: 'autumn',
    page_url: 'https://land.example/?utm_source=vk', created_at: '2026-10-01T10:00:00Z',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.in_bot, false);
  assert.equal(r.data.bot_url, `https://t.me/petrock_w3a_bot?start=${LEAD_1}`);
  const u = await startUser(2001, { start_param: LEAD_1 });
  const saved = await lead(LEAD_1);
  assert.equal(String(saved.user_id), String(u.id));
  assert.ok(saved.started_at);
  assert.equal(saved.email, 'ivan@example.com');
  assert.equal(saved.data.page_url, 'https://land.example/?utm_source=vk');
  assert.equal(new Date(saved.created_at).toISOString(), '2026-10-01T10:00:00.000Z');
  assert.equal((await steps(u.id))[0], 's00', 'воронка стартовала');
  await isolate();
});

await scenario('Start раньше заявки: заявка, дошедшая позже, сама находит человека', async () => {
  const id = 'late-lead-0002';
  const u = await startUser(2002, { start_param: id });
  const r = await sendLead({ lead_id: id, name: 'Пётр', utm_source: 'yandex' });
  assert.equal(r.status, 200);
  assert.equal(r.data.in_bot, true);
  const saved = await lead(id);
  assert.equal(String(saved.user_id), String(u.id));
  assert.ok(saved.started_at);
  await isolate();
});

await scenario('Повтор с тем же lead_id: без дубля, новые поля дописываются, старые не затираются', async () => {
  const id = 'repeat-lead-0003';
  await sendLead({ lead_id: id, name: 'Анна', utm_source: 'tg', form: 'main' });
  const again = await sendLead({ lead_id: id, phone: '+79990000003', step: 2 });
  assert.equal(again.status, 200);
  const { rows } = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Анна');
  assert.equal(rows[0].phone, '+79990000003');
  assert.equal(rows[0].utm_source, 'tg');
  assert.deepEqual(rows[0].data, { form: 'main', step: '2' });
});

await scenario('Знакомый человек пришёл по новой заявке: заявка связана, воронка не перезапускается', async () => {
  const u = await startUser(2004);
  await isolate();
  const id = 'returning-lead-0004';
  await sendLead({ lead_id: id, utm_source: 'insta' });
  const back = await api.start({ tg_id: 2004, first_name: 'Тест', start_param: id });
  assert.equal(back.isNew, false);
  await funnel.onStart(bot, back.user, back);
  assert.equal(String((await lead(id)).user_id), String(u.id));
  assert.deepEqual(await pending(u.id), [], 'новых шагов воронки нет');
});

await scenario('Приём заявок: чужой ключ — 401, кривой lead_id — 400; форма и text/plain принимаются; CORS открыт', async () => {
  assert.equal((await sendLead({ lead_id: 'x-1' }, { key: 'wrong' })).status, 401);
  assert.equal((await sendLead({ lead_id: 'x-1' }, { key: '' })).status, 401);
  assert.equal((await sendLead({ lead_id: 'id with spaces' })).status, 400);
  assert.equal((await sendLead({ lead_id: 'a'.repeat(65) })).status, 400);
  assert.equal((await sendLead({ name: 'без id' })).status, 400);
  assert.equal(await lead('x-1'), null);

  const form = await sendLead(null, {
    type: 'application/x-www-form-urlencoded',
    raw: new URLSearchParams({ lead_id: 'form-lead-0005', name: 'Форма', utm_source: 'site' }).toString(),
  });
  assert.equal(form.status, 200);
  assert.equal((await lead('form-lead-0005')).utm_source, 'site');
  assert.equal(form.headers.get('access-control-allow-origin'), '*');

  // sendBeacon не умеет заголовки: ключ в теле, тип text/plain
  const beacon = await sendLead(null, {
    key: '', type: 'text/plain;charset=UTF-8',
    raw: JSON.stringify({ lead_id: 'beacon-lead-0006', key: LEADS_KEY, utm: { source: 'beacon', campaign: 'c1' } }),
  });
  assert.equal(beacon.status, 200);
  const saved = await lead('beacon-lead-0006');
  assert.equal(saved.utm_source, 'beacon');
  assert.equal(saved.utm_campaign, 'c1');
  assert.equal(saved.data.key, undefined, 'ключ не сохраняется');

  const preflight = await fetch(`${ADMIN_URL}/hooks/lead`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.ok(preflight.headers.get('access-control-allow-headers').includes('x-api-key'));
});

await scenario('Заявки в админке: статус «в боте», фильтры, воронка по источникам, источник у человека', async () => {
  const all = await owner.call('GET', '/api/leads');
  assert.equal(all.status, 200);
  const first = all.data.leads.find(l => l.id === LEAD_1);
  assert.equal(first.tg_id, '2001');
  assert.ok(first.user_id);

  const notInBot = await owner.call('GET', '/api/leads?status=not_in_bot');
  assert.ok(notInBot.data.leads.length && notInBot.data.leads.every(l => !l.user_id));
  assert.ok(notInBot.data.leads.some(l => l.id === 'repeat-lead-0003'));

  const vk = await owner.call('GET', '/api/leads?by=utm_source&value=vk');
  assert.deepEqual(vk.data.leads.map(l => l.id), [LEAD_1]);
  const found = await owner.call('GET', '/api/leads?query=%2B79990000001');
  assert.deepEqual(found.data.leads.map(l => l.id), [LEAD_1]);

  const summary = await owner.call('GET', '/api/leads/summary?by=utm_source');
  const row = summary.data.groups.find(g => g.value === 'vk');
  assert.deepEqual({ leads: row.leads, in_bot: row.in_bot }, { leads: 1, in_bot: 1 });
  assert.ok(summary.data.total.leads >= 6);
  assert.ok(summary.data.total.in_bot >= 3);

  const users = await owner.call('GET', '/api/users?query=2001');
  assert.equal(users.data.users[0].lead_source, 'vk');
  assert.equal(users.data.users[0].lead_campaign, 'autumn');
  const timeline = await owner.call('GET', `/api/users/${first.user_id}/timeline`);
  assert.equal(timeline.data.leads[0].id, LEAD_1);

  assert.equal((await fetch(`${ADMIN_URL}/api/leads`)).status, 401, 'без входа список закрыт');
});

await scenario('Удаление заявки: наблюдателю нельзя, владельцу можно, человек в боте остаётся', async () => {
  await owner.call('POST', '/api/accounts', { login: 'viewer2', name: 'Наблюдатель', role: 'viewer', password: 'viewer-pass' });
  const viewer = await loginAs('viewer2', 'viewer-pass');
  assert.equal((await viewer.call('GET', '/api/leads')).status, 200);
  assert.equal((await viewer.call('DELETE', '/api/leads/form-lead-0005')).status, 403);
  assert.equal((await owner.call('DELETE', '/api/leads/late-lead-0002')).data.deleted, 1);
  assert.equal(await lead('late-lead-0002'), null);
  assert.ok(await api.userByTg(2002), 'человек остался');
});

await scenario('Человека удалили из бота — заявка остаётся, но уже «не пришёл»; новый Start по ссылке связывает снова', async () => {
  await api.resetByTg(2001);
  assert.equal((await lead(LEAD_1)).user_id, null);
  const u = await startUser(2001, { start_param: LEAD_1 });
  assert.equal(String((await lead(LEAD_1)).user_id), String(u.id));
  await isolate();
});

// ─── Видео, сообщение после оплаты, выгрузка заявок ─────────────────────────

const TINY_MP4 = Buffer.from('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', 'base64'); // 72×128, 2 секунды
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0xff, 0xd9]);
const parseCsv = text => text.trim().split('\r\n').map(line =>
  [...line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)].map(m => (m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1])));

await scenario('Видео уходит с размерами, длительностью и обложкой — в Telegram оно не квадратное и с превью', async () => {
  const upload = () => owner.call('POST', '/api/media?key=test_video&kind=video&filename=v.mp4&mime=video%2Fmp4', TINY_MP4, 'video/mp4');
  const up = await upload();
  assert.equal(up.status, 200);
  assert.deepEqual([up.data.media.width, up.data.media.height, up.data.media.duration], [72, 128, 2], 'размеры из файла');
  assert.equal((await owner.call('POST', '/api/media/test_video/thumb', Buffer.from('not a jpeg'), 'image/jpeg')).status, 400);
  const thumb = await owner.call('POST', '/api/media/test_video/thumb', FAKE_JPEG, 'image/jpeg');
  assert.equal(thumb.data.media.has_thumb, true);
  assert.equal(thumb.data.media.version, up.data.media.version + 1, 'новая версия: бот загрузит видео заново, уже с обложкой');

  const { data } = await owner.call('POST', '/api/broadcasts', { title: 'Видео', text: 'Подпись к видео', segment: 'test', media_key: 'test_video' });
  await owner.call('PATCH', `/api/broadcasts/${data.broadcast.id}`, { segment: 'test', test_tg_ids: ['1003'] });
  await owner.call('POST', `/api/broadcasts/${data.broadcast.id}/start`);
  await fresh();
  const before = sent.length;
  await drainBroadcasts();
  const message = sent.slice(before).find(s => s.chatId === 1003);
  assert.equal(message.method, 'sendVideo');
  assert.equal(message.text, 'Подпись к видео');
  assert.deepEqual(message.meta, { width: '72', height: '128', duration: '2', streaming: 'true', length: undefined, thumbnail: true });

  assert.equal((await upload()).data.media.has_thumb, false, 'новый файл — старое превью сброшено');
});

await scenario('После оплаты — «Оплата прошла»: почта из заявки, поддержка, кнопка «Перейти к обучению»', async () => {
  await isolate();
  await owner.call('PUT', '/api/settings', { access_url: 'https://learn.example/start' });
  await sendLead({ lead_id: 'paid-lead-0001', email: 'Paid.Buyer@Example.com', utm_source: 'vk' });
  const u = await startUser(3001, { start_param: 'paid-lead-0001' });
  assert.equal((await api.user(u.id)).email, 'paid.buyer@example.com', 'почта с лендинга — в карточке человека');
  await fresh();
  const ok = await (await get('/hooks/gc/payment?secret=hook-secret&email=PAID.BUYER@example.com')).json();
  assert.equal(ok.matched, 1, 'хук оплаты находит человека по почте с лендинга');
  await drain();
  const message = chat(3001).at(-1);
  assert.equal(message.text, [
    'Оплата прошла — поздравляю, ты в «Методе AFK»',
    'Как зайти:',
    '1. Проверь почту paid.buyer@example.com — туда пришёл доступ к платформе (если нет — загляни в «Спам»)',
    '2. Или сразу переходи по кнопке ниже 👇',
    'Начни с первого урока — он задаёт основу для всего остального. Рекомендую пройти первые уроки в ближайшие 1–2 дня, пока свежа мотивация.',
    'Если доступ не пришёл или что-то не открывается — напиши сюда: @W3A_Support',
  ].join('\n'));
  const button = message.markup.inline_keyboard[0][0];
  assert.deepEqual([button.text, button.url], ['Перейти к обучению', 'https://learn.example/start']);
  await owner.call('PUT', '/api/settings', { access_url: '' });
  await fresh();
  await isolate();
});

await scenario('Нет почты — сообщение после оплаты не уходит, в истории видно почему', async () => {
  await isolate();
  const u = await startUser(3002);
  await isolate();
  const { user: updated } = await api.mark(u.id, 'paid', { via: 'admin' });
  await funnel.onPaid(updated);
  await drain();
  assert.ok((await skipped(u.id)).some(s => s.step === 'bought' && s.reason === 'не заполнено: email'));
  await isolate();
});

await scenario('Выгрузка заявок для Google Таблицы: этапы и метки, только по ключу выгрузки', async () => {
  const { rows: [{ value: EXPORT_KEY }] } = await pool.query(`SELECT value FROM settings WHERE key = 'leads_export_key'`);
  assert.ok(EXPORT_KEY && EXPORT_KEY !== LEADS_KEY, 'свой ключ на чтение');
  assert.equal((await fetch(`${ADMIN_URL}/hooks/leads.csv?key=wrong`)).status, 401);
  assert.equal((await fetch(`${ADMIN_URL}/hooks/leads.csv?key=${encodeURIComponent(LEADS_KEY)}`)).status, 401, 'ключ приёма заявок выгрузку не открывает');

  await sendLead({ lead_id: 'export-lead-0001', email: 'exp@example.com', utm_source: 'vk', utm_campaign: 'осень, "тест"' });
  await sendLead({ lead_id: 'export-lead-0002', email: 'nobot@example.com', utm_source: '=HYPERLINK("x")' });
  const u = await startUser(3003, { start_param: 'export-lead-0001' });
  await get(`/c/${u.token}/video`);
  await isolate();

  const res = await fetch(`${ADMIN_URL}/hooks/leads.csv?key=${encodeURIComponent(EXPORT_KEY)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const rows = parseCsv(await res.text());
  assert.deepEqual(rows[0], ['Дата заявки (МСК)', 'Email', 'Этап', 'Открыл бота', 'Нажал на видео', 'Досмотрел до оффера', 'Купил',
    'Заблокировал бота', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'Telegram',
    'Открыл бота (МСК)', 'Доступ до (МСК)', 'ID заявки']);
  const inBot = rows.find(r => r.at(-1) === 'export-lead-0001');
  const noBot = rows.find(r => r.at(-1) === 'export-lead-0002');
  assert.deepEqual(inBot.slice(1, 14), ['exp@example.com', 'Нажал на видео', 'да', 'да', 'нет', 'нет', 'нет', 'vk', '', 'осень, "тест"', '', '', 'Тест']);
  assert.match(inBot[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(inBot[14], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(inBot[15], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(noBot.slice(1, 9), ['nobot@example.com', 'Не открыл бота', 'нет', '', '', '', '', ' =HYPERLINK("x")']);
  assert.ok(rows.indexOf(inBot) < rows.indexOf(noBot), 'старые сверху, новые дописываются вниз');
});

// ─── Итог ───────────────────────────────────────────────────────────────────

console.log(`\n${results.join('\n')}`);
const failed = results.filter(r => r.startsWith('❌')).length;

server.close();
tg.close();
apiProc.kill();
adminProc.kill();
await pool.query(`TRUNCATE users, events, jobs, steps, settings, media, admins, admin_sessions, audit,
  broadcasts, broadcast_targets, leads RESTART IDENTITY CASCADE`);
await pool.end();
await rm(new URL('../bot/media-cache/', import.meta.url), { recursive: true, force: true });
process.exit(failed ? 1 : 0);
