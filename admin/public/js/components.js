// Конструктор сообщения: текст, медиа, кнопки, предпросмотр.
// Используют и шаги схемы, и рассылки.

import { api } from './api.js';
import { el, h, previewHtml, toast } from './util.js';

const ACTIONS = [['video', 'видео'], ['offer', 'оплата'], ['channel', 'канал'], ['access', 'обучение'], ['url', 'ссылка']];
const CAPTION_LIMIT = 1024;
const TEXT_LIMIT = 4096;

const randomKey = () => `m_${Math.random().toString(36).slice(2, 8)}`;

// Обложка видео для Telegram: кадр на первой секунде, до 320 px по большей стороне.
// Без неё видео в чате приходит без превью. Не вышло (браузер не читает формат) — не страшно.
async function videoThumb(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  const wait = (event, ms = 15000) => new Promise((resolve, reject) => {
    video.addEventListener(event, resolve, { once: true });
    video.addEventListener('error', reject, { once: true });
    setTimeout(reject, ms);
  });
  try {
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    await wait('loadeddata');
    video.currentTime = Math.min(1, (video.duration || 2) / 2);
    await wait('seeked');
    const scale = 320 / Math.max(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function buttonRow(button, canEdit) {
  const options = ACTIONS.map(([value, title]) =>
    `<option value="${value}"${button.action === value ? ' selected' : ''}>${title}</option>`).join('');
  return `<div class="row btn-row" style="margin-bottom:6px">
    <input class="b-text" value="${h(button.text || '')}" placeholder="Текст кнопки"${canEdit ? '' : ' disabled'}>
    <select class="b-action" style="width:110px"${canEdit ? '' : ' disabled'}>${options}</select>
    <input class="b-url" value="${h(button.url || '')}" placeholder="https://"
      style="${button.action === 'url' ? '' : 'display:none'}"${canEdit ? '' : ' disabled'}>
    <button type="button" class="small b-del"${canEdit ? '' : ' disabled'}>✕</button>
  </div>`;
}

export function messageEditor({ record, media = [], canEdit = true, onChange = () => {} }) {
  let files = [...media];

  const node = el(`<div>
    <div class="field">
      <label>Текст</label>
      <div class="row" style="margin-bottom:6px">
        <button type="button" class="small" data-tag="b"><b>Ж</b></button>
        <button type="button" class="small" data-tag="i"><i>К</i></button>
        <button type="button" class="small" data-insert="{name}">{name}</button>
        <button type="button" class="small" data-link="1">Ссылка</button>
        <span class="grow" style="flex:1"></span>
        <span class="hint counter"></span>
      </div>
      <textarea class="m-text" rows="9"${canEdit ? '' : ' disabled'}>${h(record.text || '')}</textarea>
    </div>

    <div class="field">
      <label>Медиа</label>
      <div class="row">
        <select class="m-media"${canEdit ? '' : ' disabled'}></select>
        ${canEdit ? '<button type="button" class="small m-upload">Загрузить</button>' : ''}
        ${canEdit ? '<button type="button" class="small danger m-remove">Удалить</button>' : ''}
      </div>
    </div>

    <div class="field">
      <label>Кнопки</label>
      <div class="m-buttons"></div>
      ${canEdit ? '<button type="button" class="small m-add">+ кнопка</button>' : ''}
    </div>

    <div class="field">
      <label>Предпросмотр</label>
      <div class="preview"><div class="bubble"></div></div>
    </div>
  </div>`);

  const textArea = node.querySelector('.m-text');
  const mediaSelect = node.querySelector('.m-media');
  const buttonsBox = node.querySelector('.m-buttons');
  const bubble = node.querySelector('.bubble');
  const counter = node.querySelector('.counter');
  let buttons = Array.isArray(record.buttons) ? record.buttons.map(b => ({ ...b })) : [];
  let uploading = false;

  function drawMediaOptions(selected) {
    // Файл может быть выбран, но отсутствовать в списке (загрузили в другой панели) —
    // добавляем его строкой, иначе сохранение молча отцепит вложение.
    const known = files.some(m => m.key === selected);
    mediaSelect.innerHTML = [
      '<option value="">нет</option>',
      ...files.map(m => `<option value="${h(m.key)}">${h(m.filename)}${m.kind === 'video_note' ? ' (кружок)' : ''}</option>`),
      selected && !known ? `<option value="${h(selected)}">${h(selected)}</option>` : '',
    ].join('');
    mediaSelect.value = selected || '';
  }

  const value = () => ({
    text: textArea.value,
    media_key: mediaSelect.value || null,
    buttons: readButtons(),
  });

  function readButtons() {
    return [...buttonsBox.querySelectorAll('.btn-row')].map(row => {
      const action = row.querySelector('.b-action').value;
      const out = { text: row.querySelector('.b-text').value.trim(), action };
      if (action === 'url') out.url = row.querySelector('.b-url').value.trim();
      return out;
    }).filter(b => b.text);
  }

  function drawButtons() {
    buttonsBox.innerHTML = buttons.map(b => buttonRow(b, canEdit)).join('');
  }

  function drawPreview() {
    const current = value();
    const info = files.find(m => m.key === current.media_key);
    const src = info ? `/api/media/${encodeURIComponent(info.key)}/file?v=${info.version}` : null;
    let mediaHtml = '';
    if (info && info.kind === 'video_note') mediaHtml = `<video class="note" src="${src}" muted autoplay loop playsinline></video>`;
    else if (info && info.kind === 'video') mediaHtml = `<video src="${src}" controls playsinline></video>`;
    else if (info) mediaHtml = `<img src="${src}" alt="">`;

    const keys = current.buttons.map(b => `<span>${h(b.text)}</span>`).join('');
    bubble.innerHTML = `${mediaHtml}<div>${previewHtml(current.text) || '<span class="hint">пусто</span>'}</div>
      ${keys ? `<div class="kbd">${keys}</div>` : ''}`;

    const len = current.text.length;
    const overCaption = info && info.kind !== 'video_note' && len > CAPTION_LIMIT;
    counter.textContent = len > TEXT_LIMIT ? `${len} — длиннее лимита Telegram`
      : (overCaption ? `${len} — уйдёт отдельным сообщением` : String(len));
    counter.style.color = len > TEXT_LIMIT ? 'var(--danger)' : (overCaption ? 'var(--warn)' : '');
  }

  function changed() {
    drawPreview();
    onChange(value());
  }

  function wrapSelection(tag) {
    const { selectionStart: from, selectionEnd: to, value: text } = textArea;
    const selected = text.slice(from, to) || 'текст';
    textArea.value = `${text.slice(0, from)}<${tag}>${selected}</${tag}>${text.slice(to)}`;
    textArea.focus();
    textArea.setSelectionRange(from + tag.length + 2, from + tag.length + 2 + selected.length);
    changed();
  }

  async function upload() {
    const picker = el('<input type="file" accept="image/*,video/*" style="display:none">');
    document.body.append(picker);
    picker.onchange = async () => {
      const file = picker.files[0];
      picker.remove();
      if (!file) return;
      let kind = 'photo';
      if (file.type.startsWith('video')) {
        kind = confirm('Это кружок (круглое видеосообщение)?\n\nОК — кружок, Отмена — обычное видео') ? 'video_note' : 'video';
      }
      const button = node.querySelector('.m-upload');
      uploading = true;
      button.disabled = true;
      button.textContent = 'Загружаю…';
      try {
        let { media: uploaded } = await api.upload(file, { key: randomKey(), kind });
        if (kind === 'video') {
          const thumb = await videoThumb(file);
          if (thumb) ({ media: uploaded } = await api.uploadThumb(uploaded.key, thumb));
        }
        files = [...files.filter(m => m.key !== uploaded.key), uploaded];
        drawMediaOptions(uploaded.key);
        changed();
        toast('Файл прикреплён');
      } catch (err) {
        toast(err.message, 'error');
      }
      uploading = false;
      button.disabled = false;
      button.textContent = 'Загрузить';
    };
    picker.click();
  }

  node.addEventListener('click', async event => {
    const tagButton = event.target.closest('[data-tag]');
    if (tagButton) return wrapSelection(tagButton.dataset.tag);

    const insert = event.target.closest('[data-insert]');
    if (insert) {
      const at = textArea.selectionStart;
      const token = insert.dataset.insert;
      textArea.value = textArea.value.slice(0, at) + token + textArea.value.slice(at);
      textArea.focus();
      textArea.setSelectionRange(at + token.length, at + token.length);
      return changed();
    }

    if (event.target.closest('[data-link]')) {
      const url = prompt('Адрес ссылки', 'https://');
      if (!url) return;
      const { selectionStart: from, selectionEnd: to, value: text } = textArea;
      const label = text.slice(from, to) || 'ссылка';
      textArea.value = `${text.slice(0, from)}<a href="${url}">${label}</a>${text.slice(to)}`;
      return changed();
    }

    if (event.target.closest('.m-upload')) return upload();

    if (event.target.closest('.m-remove')) {
      const key = mediaSelect.value;
      if (!key || !confirm('Удалить файл? Он пропадёт во всех шагах, где стоит.')) return;
      try {
        await api.del(`/api/media/${encodeURIComponent(key)}`);
        files = files.filter(m => m.key !== key);
        drawMediaOptions('');
        changed();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    if (event.target.closest('.m-add')) {
      buttons = [...readButtons(), { text: 'Смотреть видео', action: 'video' }];
      drawButtons();
      return changed();
    }

    const remove = event.target.closest('.b-del');
    if (remove) {
      remove.closest('.btn-row').remove();
      buttons = readButtons();
      return changed();
    }
  });

  node.addEventListener('input', changed);
  node.addEventListener('change', event => {
    if (event.target.classList.contains('b-action')) {
      event.target.closest('.btn-row').querySelector('.b-url').style.display = event.target.value === 'url' ? '' : 'none';
    }
    changed();
  });

  drawMediaOptions(record.media_key);
  drawButtons();
  drawPreview();

  return { node, value, isUploading: () => uploading };
}
