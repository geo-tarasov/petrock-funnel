// Персональный срок доступа: Т0 (первый /start) + access_hours из настроек.
// В тестовом режиме срок сжимается так же, как паузы воронки.

import { config } from './config.js';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function deadlineOf(user, cfg) {
  const hours = cfg.number('access_hours', 0);
  if (!hours || !user?.created_at) return null;
  return new Date(new Date(user.created_at).getTime() + config.delay(hours * 3600, user) * 1000);
}

// Дата для текста сообщений: всегда честные Т0 + access_hours, как у настоящего пользователя.
// В тестовом режиме сжимается только расписание, а в тексте «24 часа до …» должна стоять
// дата через сутки — иначе выходит «доступно 24 часа до сегодня, через 14 минут».
export function displayDeadlineOf(user, cfg) {
  const hours = cfg.number('access_hours', 0);
  if (!hours || !user?.created_at) return null;
  return new Date(new Date(user.created_at).getTime() + hours * 3600 * 1000);
}

export function isExpired(user, cfg, now = Date.now()) {
  const deadline = deadlineOf(user, cfg);
  return !!deadline && !user.paid_at && now >= deadline.getTime();
}

// «1 октября, 14:05 МСК» — Москва без перехода на летнее время, UTC+3.
export function formatDeadline(date) {
  if (!date) return '';
  const msk = new Date(date.getTime() + 3 * 3600 * 1000);
  const hh = String(msk.getUTCHours()).padStart(2, '0');
  const mm = String(msk.getUTCMinutes()).padStart(2, '0');
  return `${msk.getUTCDate()} ${MONTHS[msk.getUTCMonth()]}, ${hh}:${mm} МСК`;
}
