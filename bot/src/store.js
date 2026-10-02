// Воронка, настройки и медиа живут в базе на RU. Бот держит их в памяти
// и обновляет раз в несколько секунд; если API недоступен — работает по последней копии.

import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './api.js';

const TTL_MS = 10_000;
const cacheDir = fileURLToPath(new URL('../media-cache/', import.meta.url));

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/quicktime': '.mov',
};

let snapshot = null;
let loadedAt = 0;
let inflight = null;

// Позиция шага во времени: от какого события он отсчитывается (триггер головы ветки)
// и через сколько секунд после него наступает. Это «Т0 + 6 ч» со схемы.
function positions(steps, byKey) {
  const out = new Map();
  const heads = steps.filter(s => s.trigger).sort((a, b) => a.sort - b.sort);
  for (const head of heads) {
    let offset = 0;
    const seen = new Set();
    for (let step = head; step && !seen.has(step.key); step = byKey.get(step.next_key)) {
      seen.add(step.key);
      offset += Number(step.delay_seconds) || 0;
      if (!out.has(step.key)) out.set(step.key, { trigger: head.trigger, offset });
    }
  }
  return out;
}

function index(raw) {
  const steps = (raw.steps || []).map(s => ({ ...s, buttons: Array.isArray(s.buttons) ? s.buttons : [] }));
  const byKey = new Map(steps.map(s => [s.key, s]));
  const byTrigger = new Map(steps.filter(s => s.trigger).map(s => [s.trigger, s]));
  const pos = positions(steps, byKey);
  const settings = raw.settings || {};
  const media = raw.media || [];
  return {
    steps,
    settings,
    media,
    step: key => byKey.get(key) || null,
    position: key => pos.get(key) || null,
    trigger: name => byTrigger.get(name) || null,
    byGuard: guard => steps.filter(s => s.guard === guard).sort((a, b) => a.sort - b.sort),
    keysByGuard: guard => steps.filter(s => s.guard === guard).map(s => s.key),
    setting: (key, fallback = '') => (settings[key] ?? fallback),
    number: (key, fallback = 0) => (Number(settings[key]) || fallback),
    mediaInfo: key => media.find(m => m.key === key) || null,
  };
}

export async function load({ force = false } = {}) {
  if (!force && snapshot && Date.now() - loadedAt < TTL_MS) return snapshot;
  if (inflight) return inflight;
  inflight = api.config()
    .then(raw => {
      snapshot = index(raw);
      loadedAt = Date.now();
      return snapshot;
    })
    .catch(err => {
      if (!snapshot) throw err;
      console.error('config refresh failed, using cached copy:', err.message);
      loadedAt = Date.now();
      return snapshot;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// Ждём первую загрузку на старте: без воронки бот бесполезен.
export async function loadWithRetry(attempts = 30) {
  for (let i = 1; ; i++) {
    try {
      return await load({ force: true });
    } catch (err) {
      if (i >= attempts) throw err;
      console.error(`config load failed (${i}/${attempts}): ${err.message}`);
      await new Promise(r => setTimeout(r, Math.min(1000 * i, 10_000)));
    }
  }
}

export function cached() {
  return snapshot;
}

// Файл медиа кладём на диск рядом с ботом: ключ + версия, поэтому замена файла в админке
// сама собой приводит к новому имени и свежей отправке в Telegram.
export async function mediaPath(info) {
  if (!info) return null;
  const ext = extname(info.filename || '') || EXT_BY_MIME[info.mime] || '';
  const name = `${info.key}.${info.version}${ext}`;
  const file = `${cacheDir}${name}`;
  if (existsSync(file)) return file;

  const data = await api.mediaFile(info.key);
  await mkdir(cacheDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);

  // старые версии того же ключа больше не нужны
  for (const old of await readdir(cacheDir).catch(() => [])) {
    if (old.startsWith(`${info.key}.`) && !old.startsWith(`${info.key}.${info.version}.`)) await rm(`${cacheDir}${old}`, { force: true });
  }
  return file;
}

// Обложка видео: лежит рядом с файлом, с той же версией.
export async function thumbPath(info) {
  if (!info?.has_thumb) return null;
  const file = `${cacheDir}${info.key}.${info.version}.thumb.jpg`;
  if (existsSync(file)) return file;
  const data = await api.mediaThumb(info.key);
  await mkdir(cacheDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
  return file;
}
