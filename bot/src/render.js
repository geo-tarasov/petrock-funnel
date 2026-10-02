// Собирает сообщение для Telegram из записи шага воронки или рассылки.

import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { displayDeadlineOf, formatDeadline } from './deadline.js';
import { load, mediaPath, thumbPath } from './store.js';

const escapeHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Не отправляем текст с дырой вместо цены: лучше пропустить шаг и увидеть это в истории.
export class MissingValueError extends Error {}

export function trackedUrl(user, key) {
  return `${config.publicUrl}/c/${user.token}/${key}`;
}

// Ссылки внутри текста: <a href="{video_link}">…</a>. Пустая ссылка — остаётся просто текст.
function links(user, cfg) {
  return {
    video_link: user ? trackedUrl(user, 'video') : '',
    channel_link: cfg.setting('channel_url') ? (user ? trackedUrl(user, 'channel') : cfg.setting('channel_url')) : '',
    offer_link: user ? trackedUrl(user, 'offer') : cfg.setting('checkout_url'),
    support_link: cfg.setting('support_url'),
    youtube_link: cfg.setting('youtube_url'),
    reviews_link: cfg.setting('reviews_url'),
  };
}

// Имя поддержки для «@{support}»: из ссылки t.me/<имя> в настройках.
function supportName(cfg) {
  const value = cfg.setting('support_url').trim();
  const m = value.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{3,})\/?$/i) || value.match(/^@?([A-Za-z0-9_]{3,})$/);
  return m ? m[1] : '';
}

// {name}, {username}, {deadline}, {price}, {email}, {support} — подстановки; значения экранируются, текст идёт как HTML.
export function renderText(text, user, cfg) {
  const name = user?.first_name || user?.username || 'Привет';
  const hrefs = links(user, cfg);
  let out = String(text ?? '')
    .replace(/<a href="\{(\w+)\}">([\s\S]*?)<\/a>/g, (_, key, inner) => (hrefs[key] ? `<a href="${escapeHtml(hrefs[key])}">${inner}</a>` : inner))
    .replaceAll('{name}', escapeHtml(name))
    .replaceAll('{first_name}', escapeHtml(user?.first_name || ''))
    .replaceAll('{last_name}', escapeHtml(user?.last_name || ''))
    .replaceAll('{username}', escapeHtml(user?.username || ''));

  if (out.includes('{deadline}')) {
    const deadline = user ? formatDeadline(displayDeadlineOf(user, cfg)) : '';
    if (!deadline) throw new MissingValueError('deadline');
    out = out.replaceAll('{deadline}', escapeHtml(deadline));
  }
  // {email} — почта человека: с лендинга (из заявки) или из хука оплаты.
  if (out.includes('{email}')) {
    const email = String(user?.email || '').trim();
    if (!email) throw new MissingValueError('email');
    out = out.replaceAll('{email}', escapeHtml(email));
  }
  if (out.includes('{support}')) {
    const support = supportName(cfg);
    if (!support) throw new MissingValueError('support');
    out = out.replaceAll('{support}', escapeHtml(support));
  }
  if (out.includes('{price}')) {
    const price = cfg.setting('price').trim();
    if (!price) throw new MissingValueError('price');
    out = out.replaceAll('{price}', escapeHtml(price));
  }
  return out.trim();
}

export function buildKeyboard(buttons, user, cfg) {
  const keyboard = new InlineKeyboard();
  let count = 0;
  for (const b of buttons || []) {
    let url = null;
    if (b.action === 'video') url = user ? trackedUrl(user, 'video') : null;
    else if (b.action === 'channel') url = cfg.setting('channel_url') ? (user ? trackedUrl(user, 'channel') : cfg.setting('channel_url')) : null;
    else if (b.action === 'offer') url = user ? trackedUrl(user, 'offer') : (cfg.setting('checkout_url') || null);
    else if (b.action === 'access') url = cfg.setting('access_url') || null;
    else url = b.url;
    if (!url) continue;
    if (count) keyboard.row();
    keyboard.url(b.text, url);
    count += 1;
  }
  return count ? keyboard : undefined;
}

// rec: шаг воронки или рассылка — {text, media_key, buttons}
export async function buildMessage(rec, user, cfg) {
  let snapshot = cfg;
  let info = rec.media_key ? snapshot.mediaInfo(rec.media_key) : null;

  // Файл могли загрузить секунду назад — снимок конфигурации обновляем принудительно.
  if (rec.media_key && !info) {
    snapshot = await load({ force: true });
    info = snapshot.mediaInfo(rec.media_key);
  }

  // Ошибку скачивания не глушим: пусть задача повторится, чем уйдёт сообщение без картинки.
  const media = info
    ? {
      key: info.key, kind: info.kind, version: info.version, path: await mediaPath(info),
      width: info.width, height: info.height, duration: info.duration, thumb: await thumbPath(info),
    }
    : null;

  return {
    text: renderText(rec.text, user, snapshot),
    media,
    missingMedia: rec.media_key && !info ? rec.media_key : null,
    keyboard: buildKeyboard(rec.buttons, user, snapshot),
  };
}
