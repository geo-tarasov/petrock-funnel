import 'dotenv/config';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pool } from './db.js';
import { DEFAULT_SETTINGS, DEFAULT_STEPS } from './defaults.js';
import { hashPassword } from './password.js';

const schemaPath = new URL('../../db/schema.sql', import.meta.url);
const fallbackPath = new URL('../schema.sql', import.meta.url);

let sql;
try {
  sql = await readFile(schemaPath, 'utf8');
} catch {
  sql = await readFile(fallbackPath, 'utf8');
}

await pool.query(sql);
console.log('schema applied');

// Воронку наполняем только на пустой базе — правки из админки не трогаем.
const { rows: [{ count }] } = await pool.query('SELECT count(*)::int AS count FROM steps');
if (count === 0) {
  for (const [i, s] of DEFAULT_STEPS.entries()) {
    await pool.query(
      `INSERT INTO steps (key, title, branch, trigger, guard, text, media_key, buttons, next_key, delay_seconds, sort, enabled, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [s.key, s.title, s.branch, s.trigger ?? null, s.guard, s.text, s.media_key ?? null,
        JSON.stringify(s.buttons ?? []), s.next_key ?? null, s.delay, i, s.enabled ?? true, s.note ?? '']
    );
  }
  console.log(`steps seeded: ${DEFAULT_STEPS.length}`);
}

for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
}

// Ключ для заявок с лендинга: создаётся один раз, дальше виден и меняется в настройках админки.
await pool.query(`INSERT INTO settings (key, value) VALUES ('leads_api_key', $1) ON CONFLICT (key) DO NOTHING`,
  [crypto.randomBytes(18).toString('base64url')]);
// Отдельный ключ на чтение — для выгрузки заявок в Google Таблицу.
await pool.query(`INSERT INTO settings (key, value) VALUES ('leads_export_key', $1) ON CONFLICT (key) DO NOTHING`,
  [crypto.randomBytes(18).toString('base64url')]);

// Владелец админки. Пароль печатается один раз — дальше меняется в интерфейсе.
const login = process.env.OWNER_LOGIN || 'admin';
const { rows: [owner] } = await pool.query(`SELECT id FROM admins WHERE role = 'owner' LIMIT 1`);
if (!owner) {
  const password = process.env.OWNER_PASSWORD || crypto.randomBytes(9).toString('base64url');
  await pool.query(
    `INSERT INTO admins (login, name, password_hash, role, tg_id) VALUES ($1, $2, $3, 'owner', $4)
     ON CONFLICT (login) DO UPDATE SET role = 'owner'`,
    [login, 'Владелец', hashPassword(password), process.env.OWNER_TG_ID || null]
  );
  console.log(`owner created: ${login} / ${password}`);
}

await pool.end();
