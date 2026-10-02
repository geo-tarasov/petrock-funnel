export const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Собирает элемент из HTML-строки: у нас нет сборки, поэтому шаблоны — просто строки.
export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

export function toast(message, type = 'ok') {
  const node = el(`<div class="toast ${type}">${h(message)}</div>`);
  document.getElementById('toasts').append(node);
  setTimeout(() => node.remove(), type === 'error' ? 6000 : 3000);
}

export function fmtDuration(seconds) {
  let s = Math.max(0, Math.round(Number(seconds) || 0));
  if (!s) return 'сразу';
  // До двух суток — в часах: «Т0 + 23 ч», «1 ч 55 мин».
  const parts = [];
  if (s >= 48 * 3600) {
    parts.push(`${Math.floor(s / 86400)} дн`);
    s %= 86400;
  }
  if (s >= 3600) {
    parts.push(`${Math.floor(s / 3600)} ч`);
    s %= 3600;
  }
  if (s >= 60) {
    parts.push(`${Math.floor(s / 60)} мин`);
    s %= 60;
  }
  if (s) parts.push(`${s} сек`);
  return parts.join(' ');
}

// Для поля задержки: подбираем удобную единицу.
export function splitDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s && s % 86400 === 0) return { value: s / 86400, unit: 86400 };
  if (s && s % 3600 === 0) return { value: s / 3600, unit: 3600 };
  if (s && s % 60 === 0) return { value: s / 60, unit: 60 };
  return { value: s, unit: 1 };
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtDateFull(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

export const plural = (n, one, few, many) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
};

// Предпросмотр: экранируем всё, затем возвращаем разрешённые в Telegram теги.
export function previewHtml(text) {
  let out = h(text).replace(/\n/g, '<br>');
  out = out.replace(/&lt;(\/?)(b|strong|i|em|u|s|code|pre|blockquote)&gt;/g, '<$1$2>');
  out = out.replace(/&lt;a href=&quot;([^&"]+)&quot;&gt;/g, '<a href="$1" target="_blank" rel="noopener">');
  out = out.replace(/&lt;\/a&gt;/g, '</a>');
  return out;
}

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const confirmBox = message => window.confirm(message);
