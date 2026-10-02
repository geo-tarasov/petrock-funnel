import { GrammyError, InputFile } from 'grammy';
import { api } from './api.js';

const CAPTION_LIMIT = 1024;
const TEXT_LIMIT = 4096;

// file_id от Telegram: первая отправка грузит файл, дальше уходит ссылкой.
// Ключ с версией — после замены файла в админке кэш сам себя обновляет.
const fileIds = new Map();

export class UserBlockedError extends Error {}

const blocked = err => err instanceof GrammyError
  && (err.error_code === 403 || /chat not found|user is deactivated|bot was blocked/i.test(err.description));

function chunks(text) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > TEXT_LIMIT) {
    const cut = rest.lastIndexOf('\n', TEXT_LIMIT);
    const at = cut > TEXT_LIMIT / 2 ? cut : TEXT_LIMIT;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

const textOptions = reply_markup => ({ parse_mode: 'HTML', reply_markup, link_preview_options: { is_disabled: true } });

// Размеры, длительность и обложка нужны Telegram, иначе видео приходит квадратом без превью.
// Передаём их при загрузке файла; дальше file_id несёт их сам.
function videoOptions(media) {
  const out = {};
  if (media.duration) out.duration = media.duration;
  if (media.kind === 'video_note') {
    if (media.width) out.length = media.width;
    return out;
  }
  if (media.width && media.height) Object.assign(out, { width: media.width, height: media.height });
  if (media.thumb) out.thumbnail = new InputFile(media.thumb);
  out.supports_streaming = true;
  return out;
}

async function sendMediaMessage(bot, chatId, media, options) {
  const cacheKey = `${media.key}:${media.version}:${media.kind}`;
  const cached = fileIds.get(cacheKey);
  const file = cached || new InputFile(media.path);
  const extra = cached || media.kind === 'photo' ? {} : videoOptions(media);
  let message;
  if (media.kind === 'video_note') message = await bot.api.sendVideoNote(chatId, file, { ...extra, ...options });
  else if (media.kind === 'video') message = await bot.api.sendVideo(chatId, file, { ...extra, ...options });
  else message = await bot.api.sendPhoto(chatId, file, options);

  const id = message.photo?.at(-1)?.file_id ?? message.video_note?.file_id ?? message.video?.file_id;
  if (id) fileIds.set(cacheKey, id);
  return message;
}

// Одна отправка в чат. Бросает UserBlockedError, если бот заблокирован.
export async function deliver(bot, chatId, { text, media, keyboard }) {
  const parts = chunks(text);
  try {
    if (media) {
      // У кружка подписи нет, у фото и видео — до 1024 символов.
      const withCaption = media.kind !== 'video_note' && parts.length === 1 && parts[0].length <= CAPTION_LIMIT;
      if (withCaption) {
        await sendMediaMessage(bot, chatId, media, { caption: parts[0], parse_mode: 'HTML', reply_markup: keyboard });
        return;
      }
      await sendMediaMessage(bot, chatId, media, parts.length ? {} : { reply_markup: keyboard });
    }
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      await bot.api.sendMessage(chatId, part, textOptions(last ? keyboard : undefined));
    }
    if (!media && !parts.length) throw new Error('empty message');
  } catch (err) {
    if (blocked(err)) throw new UserBlockedError(err.description || 'blocked');
    throw err;
  }
}

// Шаг воронки: доставка + запись события, блокировка гасит очередь пользователя.
export async function send(bot, user, step, message) {
  const startedAt = Date.now();
  try {
    await deliver(bot, user.tg_id, message);
  } catch (err) {
    if (err instanceof UserBlockedError) {
      await api.mark(user.id, 'blocked', { step, description: err.message });
      await api.cancel(user.id);
    }
    throw err;
  }
  const telegramMs = Date.now() - startedAt;
  await api.event(user.id, 'sent', { step, telegram_ms: telegramMs });
  const totalMs = Date.now() - startedAt;
  if (totalMs > 3000) console.warn(`slow send ${step} user ${user.id}: telegram ${telegramMs}ms, total ${totalMs}ms`);
}
