// Движок воронки. Сами шаги — данные из админки (таблица steps), здесь только логика.
//
// Воронка идёт по расписанию от первого /start (Т0). Несколько веток стартуют одновременно
// (trigger = start) и тикают по своим точкам: Т0 + 2 ч, Т0 + 6 ч, … В каждой точке шаг
// отправляется, только если человек сейчас в состоянии этой ветки (guard). Не подошёл — шаг
// пропускается, а ветка идёт дальше: к следующей точке человек мог в неё попасть.
//
// Время каждой точки считается от события-якоря (Т0, клик, оффер, оплата), а не от
// предыдущего шага. Поэтому точки всех веток совпадают по времени, задержка отправки
// не накапливается, а сжатие в тестовом режиме не меняет порядок.
//
// Триггеры: start — первый /start, restart — повторный, click — клик по видео,
// offer — досмотрел до оффера, paid — оплата.

import { api } from './api.js';
import { config } from './config.js';
import { deadlineOf, isExpired } from './deadline.js';
import { buildMessage, MissingValueError } from './render.js';
import { send } from './sender.js';
import { load } from './store.js';

const alive = u => !u.paid_at && !u.blocked_at;

export const GUARDS = {
  active: alive,
  not_clicked: u => alive(u) && !u.clicked_at,
  clicked: u => alive(u) && !!u.clicked_at && !u.offer_at,
  offer: u => alive(u) && !!u.offer_at,
  not_watched: u => alive(u) && !u.offer_at,
  paid: u => !!u.paid_at && !u.blocked_at,
};

const ANCHORS = { start: 'created_at', click: 'clicked_at', offer: 'offer_at', paid: 'paid_at' };

// Момент, когда шаг должен уйти. null — шаг не привязан к событию (отсчёт от предыдущего).
export function dueAt(cfg, user, step) {
  const pos = cfg.position(step.key);
  const field = pos && ANCHORS[pos.trigger];
  if (!field || !user[field]) return null;
  return new Date(user[field]).getTime() + config.delay(pos.offset, user) * 1000;
}

async function schedule(cfg, user, step) {
  const due = dueAt(cfg, user, step);
  const delay = due === null ? config.delay(step.delay_seconds, user) : Math.max(0, (due - Date.now()) / 1000);
  await api.schedule(user.id, step.key, delay);
}

// Следующий шаг планируем всегда, даже выключенный: точки ветки не должны съезжать.
async function scheduleNext(cfg, user, step) {
  const next = step.next_key ? cfg.step(step.next_key) : null;
  if (next) await schedule(cfg, user, next);
}

// После дедлайна уходит только то, что стоит на дедлайне и позже (сообщение «Доступ закрыт»).
function afterDeadline(cfg, user, step, now) {
  const deadline = deadlineOf(user, cfg);
  if (!deadline || user.paid_at || now < deadline.getTime()) return false;
  const pos = cfg.position(step.key);
  const accessSeconds = cfg.number('access_hours', 0) * 3600;
  return !(pos && pos.trigger === 'start' && pos.offset >= accessSeconds);
}

// Ветка «досмотрел» по расписанию не обгоняет сообщение оффера: сначала оффер, потом дожимы.
function beforeOfferMessage(cfg, user, step, now) {
  const pos = cfg.position(step.key);
  if (step.guard !== 'offer' || !pos || pos.trigger !== 'start') return false;
  const offerHeads = cfg.steps.filter(s => s.trigger === 'offer' && s.enabled);
  const dues = offerHeads.map(s => dueAt(cfg, user, s)).filter(d => d !== null);
  return dues.length > 0 && now < Math.min(...dues) - 1000;
}

// Точку ветки обогнала следующая (бот лежал, очередь отстала) — старую не шлём, чтобы не было пачки.
function superseded(cfg, user, step, now) {
  const next = step.next_key ? cfg.step(step.next_key) : null;
  const nextDue = next ? dueAt(cfg, user, next) : null;
  return nextDue !== null && dueAt(cfg, user, step) !== null && nextDue <= now;
}

async function sendStep(bot, cfg, user, step) {
  if (!step.enabled) return;
  let message;
  try {
    message = await buildMessage(step, user, cfg);
  } catch (err) {
    if (!(err instanceof MissingValueError)) throw err;
    await api.event(user.id, 'skipped', { step: step.key, reason: `не заполнено: ${err.message}` });
    return;
  }
  if (!message.text && !message.media) {
    await api.event(user.id, 'skipped', { step: step.key, reason: `нет файла ${message.missingMedia || ''}`.trim() });
    return;
  }
  await send(bot, user, step.key, message);
}

export async function runStep(bot, job) {
  const cfg = await load();
  const step = cfg.step(job.step);
  if (!step) {
    await api.event(job.user_id, 'skipped', { step: job.step, reason: 'шага больше нет' });
    return;
  }
  const user = await api.user(job.user_id);
  if (user.blocked_at) return;
  const now = Date.now();

  // Срок вышел — ветки дальше не идут, остаётся только «Доступ закрыт».
  if (afterDeadline(cfg, user, step, now)) {
    await api.event(user.id, 'skipped', { step: step.key, reason: 'после дедлайна' });
    return;
  }

  const guard = GUARDS[step.guard] || GUARDS.active;
  if (!guard(user)) {
    await api.event(user.id, 'skipped', { step: step.key, guard: step.guard });
  } else if (beforeOfferMessage(cfg, user, step, now)) {
    await api.event(user.id, 'skipped', { step: step.key, reason: 'раньше сообщения оффера' });
  } else if (superseded(cfg, user, step, now)) {
    await api.event(user.id, 'skipped', { step: step.key, reason: 'устарел — уже время следующего' });
  } else {
    await sendStep(bot, cfg, user, step);
  }

  // После оплаты дожимы не продолжаем — кроме веток для купивших.
  if (user.paid_at && step.guard !== 'paid') return;
  await scheduleNext(cfg, user, step);
}

// Запускает все ветки с триггером: шаги «сразу» уходят сейчас, остальные — через очередь.
async function fire(bot, cfg, user, trigger) {
  const heads = cfg.steps.filter(s => s.trigger === trigger).sort((a, b) => a.delay_seconds - b.delay_seconds || a.sort - b.sort);
  for (const head of heads) {
    if (head.delay_seconds === 0 && bot) {
      await sendStep(bot, cfg, user, head);
      await scheduleNext(cfg, user, head);
    } else {
      await schedule(cfg, user, head);
    }
  }
}

// После разблокировки: каждую ветку ставим на ближайшую точку, которая ещё впереди.
async function resume(cfg, user) {
  const now = Date.now();
  for (const head of cfg.steps.filter(s => s.trigger === 'start')) {
    const seen = new Set();
    for (let step = head; step && !seen.has(step.key); step = cfg.step(step.next_key)) {
      seen.add(step.key);
      const due = dueAt(cfg, user, step);
      if (due !== null && due > now) {
        await api.schedule(user.id, step.key, (due - now) / 1000);
        break;
      }
    }
  }
}

export async function onStart(bot, user, { isNew, wasBlocked }) {
  const cfg = await load();
  if (isNew) {
    await fire(bot, cfg, user, 'start');
    return;
  }

  // После дедлайна повторный /start не должен присылать «доступно до <вчерашняя дата>» —
  // отвечаем сообщением о закрытии доступа (шаги ветки от Т0, стоящие на дедлайне).
  if (isExpired(user, cfg)) {
    const accessSeconds = cfg.number('access_hours', 0) * 3600;
    const closing = cfg.steps.filter(s => {
      const pos = cfg.position(s.key);
      return pos && pos.trigger === 'start' && pos.offset >= accessSeconds;
    });
    for (const step of closing) await sendStep(bot, cfg, user, step);
    return;
  }

  const restart = cfg.trigger('restart');
  if (restart) await sendStep(bot, cfg, user, restart);

  // Блокировка бота гасила очередь — возвращаем человека в его точки расписания.
  if (wasBlocked && !user.paid_at) {
    await api.cancel(user.id);
    await resume(cfg, user);
  }
}

export async function onClick(user, key) {
  if (key !== 'video') {
    await api.event(user.id, 'click', { key });
    return user;
  }
  const { user: updated, first } = await api.mark(user.id, 'clicked', { key });
  if (!first) return updated;
  const cfg = await load();
  await api.cancel(user.id, cfg.keysByGuard('not_clicked'));
  if (!updated.offer_at && !updated.paid_at) await fire(null, cfg, updated, 'click');
  return updated;
}

export async function onVideoPlay(user, data) {
  if (!user.video_at) await api.mark(user.id, 'video', data);
}

export async function onOffer(user, data) {
  const { user: updated, first } = await api.mark(user.id, 'offer', data);
  if (!first) return;
  // Дошёл до оффера без учтённого клика (ссылку переслали) — клик тоже засчитываем.
  if (!updated.clicked_at) await api.mark(user.id, 'clicked', { key: 'video', via: 'offer' });
  const cfg = await load();
  await api.cancel(user.id, [...cfg.keysByGuard('not_clicked'), ...cfg.keysByGuard('clicked'), ...cfg.keysByGuard('not_watched')]);
  if (!updated.paid_at) await fire(null, cfg, updated, 'offer');
}

// Пользователь уже отмечен оплатившим (хук GetCourse или /paid).
export async function onPaid(user) {
  const cfg = await load();
  await api.cancel(user.id);
  for (const step of cfg.steps.filter(s => s.trigger === 'paid')) await api.schedule(user.id, step.key, 0);
}
