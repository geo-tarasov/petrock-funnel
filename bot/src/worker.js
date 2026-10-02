import { GrammyError } from 'grammy';
import { api } from './api.js';
import { config } from './config.js';
import { runStep } from './funnel.js';
import { buildMessage, MissingValueError } from './render.js';
import { deliver, UserBlockedError } from './sender.js';
import { load } from './store.js';

let stopped = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function processJob(bot, job) {
  const lateMs = Date.now() - new Date(job.run_at).getTime();
  if (lateMs > 15000) console.warn(`job ${job.id} ${job.step} picked up ${Math.round(lateMs / 1000)}s late`);
  try {
    await runStep(bot, job);
    await api.done(job.id);
  } catch (err) {
    if (err instanceof UserBlockedError) {
      await api.done(job.id);
      return;
    }
    const retryIn = err instanceof GrammyError && err.parameters?.retry_after
      ? err.parameters.retry_after + 1
      : 60 * job.attempts;
    console.error(`job ${job.id} ${job.step} failed (attempt ${job.attempts}):`, err.message);
    await api.fail(job.id, err.message, retryIn);
  }
}

// Очередь воронки.
export function startWorker(bot) {
  (async () => {
    while (!stopped) {
      try {
        const jobs = await api.claim(20);
        for (const job of jobs) await processJob(bot, job);
        if (jobs.length === 20) continue;
      } catch (err) {
        console.error('worker loop error:', err.message);
      }
      await sleep(config.workerIntervalMs);
    }
  })();
  return () => { stopped = true; };
}

const MAX_ATTEMPTS = 3;

async function sendToTarget(bot, cfg, broadcast, target) {
  const user = target.user;
  let message;
  try {
    message = await buildMessage(broadcast, user, cfg);
  } catch (err) {
    if (err instanceof MissingValueError) return { id: target.id, status: 'failed', error: `не заполнено: ${err.message}` };
    throw err;
  }
  try {
    await deliver(bot, Number(target.tg_id), message);
    return { id: target.id, status: 'sent' };
  } catch (err) {
    if (err instanceof UserBlockedError) {
      if (user) {
        await api.mark(user.id, 'blocked', { source: 'broadcast', broadcast_id: broadcast.id }).catch(() => {});
        await api.cancel(user.id).catch(() => {});
      }
      return { id: target.id, status: 'blocked', error: err.message };
    }
    // Telegram просит подождать — отдаём цель обратно в очередь.
    if (err instanceof GrammyError && err.parameters?.retry_after) {
      await sleep((err.parameters.retry_after + 1) * 1000);
      return { id: target.id, status: target.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', error: err.description };
    }
    console.error(`broadcast ${broadcast.id} -> ${target.tg_id}: ${err.message}`);
    return { id: target.id, status: target.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', error: err.message };
  }
}

// Один проход рассылки: пачка получателей с ограничением по скорости.
// Возвращает количество отправленных сообщений — 0 значит «отправлять нечего».
export async function broadcastPass(bot, { pace = true } = {}) {
  const { broadcast, targets } = await api.broadcastClaim(Math.max(config.broadcastPerSecond, 5));
  if (!broadcast || !targets.length) return 0;

  const pauseMs = Math.max(1000 / Math.max(config.broadcastPerSecond, 1), 20);
  const cfg = await load();
  const results = [];
  for (const target of targets) {
    if (stopped) break;
    const startedAt = Date.now();
    results.push(await sendToTarget(bot, cfg, broadcast, target));
    const rest = pauseMs - (Date.now() - startedAt);
    if (pace && rest > 0) await sleep(rest);
  }
  await api.broadcastResults(results);
  return results.length;
}

export function startBroadcastWorker(bot) {
  (async () => {
    while (!stopped) {
      let worked = 0;
      try {
        worked = await broadcastPass(bot);
      } catch (err) {
        console.error('broadcast loop error:', err.message);
      }
      if (!worked) await sleep(config.workerIntervalMs);
    }
  })();
  return () => { stopped = true; };
}
