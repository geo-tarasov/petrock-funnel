// Полностью заменяет воронку в базе на api/src/defaults.js.
// Запуск: node src/replace-funnel.js --yes
// Правки, сделанные в админке, при этом теряются — поэтому без флага скрипт ничего не делает.

import 'dotenv/config';
import { pool, tx } from './db.js';
import { DEFAULT_SETTINGS, DEFAULT_STEPS } from './defaults.js';

if (!process.argv.includes('--yes')) {
  console.log('Заменит все шаги воронки. Для запуска добавьте --yes');
  process.exit(1);
}

const result = await tx(async client => {
  const { rows: old } = await client.query('SELECT key FROM steps ORDER BY sort');
  const { rowCount: canceled } = await client.query(
    `UPDATE jobs SET status = 'canceled', updated_at = now() WHERE status = 'pending'`
  );
  await client.query('DELETE FROM steps');
  for (const [i, s] of DEFAULT_STEPS.entries()) {
    await client.query(
      `INSERT INTO steps (key, title, branch, trigger, guard, text, media_key, buttons, next_key, delay_seconds, sort, enabled, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [s.key, s.title, s.branch, s.trigger ?? null, s.guard, s.text, s.media_key ?? null,
        JSON.stringify(s.buttons ?? []), s.next_key ?? null, s.delay, i, s.enabled ?? true, s.note ?? '']
    );
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await client.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
  }
  await client.query(
    `INSERT INTO audit (action, target, data) VALUES ('funnel.replace', 'defaults', $1)`,
    [{ removed: old.map(r => r.key), added: DEFAULT_STEPS.map(s => s.key), canceled_jobs: canceled }]
  );
  return { removed: old.length, added: DEFAULT_STEPS.length, canceled };
});

console.log(`шагов было ${result.removed}, стало ${result.added}; отменено задач в очереди: ${result.canceled}`);
await pool.end();
