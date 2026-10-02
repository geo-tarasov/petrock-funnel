import { Bot, GrammyError } from 'grammy';
import { isAdminId } from './access.js';
import { api } from './api.js';
import { config } from './config.js';
import { onOffer, onPaid, onStart } from './funnel.js';
import { createHttpServer } from './http.js';
import { UserBlockedError } from './sender.js';
import { loadWithRetry } from './store.js';
import { startBroadcastWorker, startWorker } from './worker.js';

const bot = new Bot(config.botToken);
const isAdmin = ctx => isAdminId(ctx.from?.id);

function profile(ctx, extra = {}) {
  return {
    tg_id: ctx.from.id,
    username: ctx.from.username,
    first_name: ctx.from.first_name,
    last_name: ctx.from.last_name,
    ...extra,
  };
}

bot.command('start', async ctx => {
  if (ctx.chat.type !== 'private') return;
  const { user, isNew, wasBlocked } = await api.start(profile(ctx, { start_param: ctx.match || null }));
  await onStart(bot, user, { isNew, wasBlocked });
});

// Тестовый режим для админа: забыть себя и пройти воронку с задержками ×0.01.
bot.command('test', async ctx => {
  if (!await isAdmin(ctx)) return;
  await api.resetByTg(ctx.from.id);
  const { user } = await api.start(profile(ctx, { start_param: 'test', time_scale: 0.01 }));
  await ctx.reply('🧪 Тестовый режим: все задержки ×0.01. Команды: /offer — досмотрел до оффера, /paid — оплатил, /reset — выйти.');
  await onStart(bot, user, { isNew: true });
});

bot.command('offer', async ctx => {
  if (!await isAdmin(ctx)) return;
  const user = await api.userByTg(ctx.from.id);
  if (!user) return ctx.reply('Тебя нет в базе. Жми /test');
  await onOffer(user, { via: 'admin' });
  await ctx.reply('✅ Засчитано: досмотрел до оффера');
});

bot.command('paid', async ctx => {
  if (!await isAdmin(ctx)) return;
  const user = await api.userByTg(ctx.from.id);
  if (!user) return ctx.reply('Тебя нет в базе. Жми /test');
  const { user: updated, first } = await api.mark(user.id, 'paid', { via: 'admin' });
  if (!first) return ctx.reply('Уже отмечен как оплативший');
  await onPaid(updated);
});

bot.command('id', async ctx => {
  if (!await isAdmin(ctx)) return;
  await ctx.reply(`Твой Telegram id: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' });
});

bot.command('stats', async ctx => {
  if (!await isAdmin(ctx)) return;
  const { funnel, sent, jobs } = await api.stats();
  const lines = [
    '<b>Воронка Pet Rock</b>',
    `Зашли в бота: ${funnel.users} (за 24ч: ${funnel.users_24h})`,
    `Нажали на видео: ${funnel.clicked}`,
    `Открыли видео: ${funnel.video_opened}`,
    `Дошли до оффера: ${funnel.reached_offer}`,
    `Купили: ${funnel.paid}`,
    `Заблокировали бота: ${funnel.blocked}`,
    '',
    '<b>Отправлено по шагам</b>',
    ...sent.map(s => `${s.step}: ${s.count}`),
    '',
    '<b>Очередь</b>',
    ...jobs.map(j => `${j.status}: ${j.count}`),
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

// Админ: забыть себя, чтобы пройти воронку заново через /start.
bot.command('reset', async ctx => {
  if (!await isAdmin(ctx)) return;
  const { deleted } = await api.resetByTg(ctx.from.id);
  await ctx.reply(deleted ? 'Сброшено. Жми /start' : 'Тебя нет в базе. Жми /start');
});

bot.catch(({ error, ctx }) => {
  if (error instanceof UserBlockedError) return;
  const where = `update ${ctx.update.update_id}`;
  if (error instanceof GrammyError) console.error(`${where}: telegram error`, error.description);
  else console.error(`${where}:`, error);
});

const cfg = await loadWithRetry();
console.log(`config loaded: ${cfg.steps.length} steps, ${cfg.media.length} media`);

const server = createHttpServer(bot);
const stopWorker = startWorker(bot);
const stopBroadcasts = startBroadcastWorker(bot);

async function shutdown() {
  stopWorker();
  stopBroadcasts();
  await bot.stop();
  server.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await bot.api.setMyCommands([{ command: 'start', description: 'Начать' }]);
console.log(`bot starting (time scale ${config.timeScale})`);
bot.start({ allowed_updates: ['message'], onStart: me => console.log(`polling as @${me.username}`) });
