import { api } from './api.js';
import { el, h, toast } from './util.js';

const FIELDS = [
  ['tester_tg_ids', 'Telegram id тестировщиков через запятую — им доступны /test, /offer, /paid, /reset'],
  ['price', 'Цена программы, ₽ (подставляется вместо {price})'],
  ['checkout_url', 'Ссылка на оплату для кнопок «оплата» (пусто — ведут на страницу с видео)'],
  ['access_hours', 'Срок доступа с первого /start, часов'],
  ['video_closed_text', 'Текст на странице видео после срока'],
  ['support_url', 'Поддержка (подставляется вместо @{support})'],
  ['access_url', 'Ссылка на обучение — кнопка «Перейти к обучению» после оплаты'],
  ['youtube_url', 'YouTube Ивана'],
  ['reviews_url', 'Канал с отзывами'],
  ['channel_url', 'Ссылка на канал'],
  ['offer_seconds', 'Секунда оффера в видео'],
  ['bot_username', 'Имя бота'],
  ['leads_api_key', 'Ключ для заявок с лендинга (X-Api-Key)'],
  ['leads_export_key', 'Ключ выгрузки заявок в Google Таблицу'],
  ['video_page_title', 'Заголовок страницы с видео'],
  ['video_page_placeholder', 'Текст вместо видео'],
  ['link_expired_text', 'Текст на устаревшей ссылке'],
  ['vturb_embed', 'Код плеера Vturb', true],
];

export async function render(ctx) {
  const canEdit = ctx.can('settings');
  const { settings } = await api.get('/api/config');

  const page = el(`<div style="max-width:620px">
    <h1>Настройки</h1>
    <div class="card" style="margin-bottom:14px">
      ${FIELDS.map(([key, label, big]) => `<div class="field"><label>${h(label)}</label>
        ${big ? `<textarea data-key="${key}" rows="5" class="mono"${canEdit ? '' : ' disabled'}>${h(settings[key] || '')}</textarea>`
              : `<input data-key="${key}" value="${h(settings[key] || '')}"${canEdit ? '' : ' disabled'}>`}</div>`).join('')}
      ${canEdit ? '<button class="primary" id="save">Сохранить</button>' : ''}
    </div>

    <div class="card">
      <div class="field"><label>Новый пароль</label><input id="password" type="password" autocomplete="new-password"></div>
      <button id="change">Сменить пароль</button>
    </div>
  </div>`);

  const saveButton = page.querySelector('#save');
  if (saveButton) saveButton.onclick = async () => {
    saveButton.disabled = true;
    try {
      const payload = {};
      for (const field of page.querySelectorAll('[data-key]')) payload[field.dataset.key] = field.value;
      await api.put('/api/settings', payload);
      toast('Сохранено');
    } catch (err) {
      toast(err.message, 'error');
    }
    saveButton.disabled = false;
  };

  page.querySelector('#change').onclick = async () => {
    try {
      await api.post('/api/password', { password: page.querySelector('#password').value });
      toast('Пароль изменён, войдите заново');
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return page;
}
