import { api } from './api.js';
import { messageEditor } from './components.js';
import { debounce, el, fmtDate, h, plural, toast } from './util.js';

const SEGMENTS = [
  ['all', 'Все'],
  ['not_clicked', 'Не нажали на видео'],
  ['clicked', 'Нажали на видео'],
  ['not_offer', 'Не досмотрели'],
  ['offer', 'Досмотрели'],
  ['not_paid', 'Не купили'],
  ['paid', 'Купили'],
  ['test', 'Тест по Telegram id'],
];

const STATUS = {
  draft: ['черновик', ''],
  sending: ['идёт', 'accent'],
  done: ['отправлена', 'ok'],
  canceled: ['остановлена', 'warn'],
};

const segmentTitle = key => (SEGMENTS.find(([k]) => k === key) || [key, key])[1];

export async function render(ctx) {
  const canSend = ctx.can('broadcast');
  const page = el(`<div>
    <div class="bar">
      <h1 style="margin:0">Рассылки</h1>
      <span class="grow"></span>
      ${canSend ? '<button class="primary" id="new">Новая</button>' : ''}
    </div>
    <div id="list"></div>
  </div>`);

  let config = await api.get('/api/config');
  let timer = null;

  async function reload() {
    const { broadcasts } = await api.get('/api/broadcasts');
    const box = page.querySelector('#list');
    box.innerHTML = broadcasts.length ? `<table>
      <thead><tr><th>Название</th><th>Кому</th><th>Статус</th><th>Отправлено</th><th>Создана</th></tr></thead>
      <tbody>${broadcasts.map(b => {
        const [label, cls] = STATUS[b.status] || [b.status, ''];
        const done = b.sent + b.failed + b.blocked;
        return `<tr data-id="${b.id}">
          <td><b>${h(b.title)}</b></td>
          <td>${h(segmentTitle(b.segment))}</td>
          <td><span class="badge ${cls}">${label}</span></td>
          <td style="min-width:150px">${b.total ? `${b.sent} из ${b.total}` : '—'}
            ${b.status === 'sending' ? `<div class="progress" style="margin-top:4px"><i style="width:${b.total ? Math.round(done / b.total * 100) : 0}%"></i></div>` : ''}</td>
          <td class="hint">${fmtDate(b.created_at)}</td>
        </tr>`;
      }).join('')}</tbody></table>` : '<div class="card empty">Пусто</div>';

    clearTimeout(timer);
    if (broadcasts.some(b => b.status === 'sending')) timer = setTimeout(reload, 3000);
  }

  async function openPanel(broadcast) {
    document.querySelector('.panel')?.remove();
    // список файлов мог пополниться в другой вкладке или панели
    config = await api.get('/api/config');
    let creating = !broadcast.id;
    const isNew = creating;
    const running = broadcast.status === 'sending';
    const editable = canSend && !running;

    const panel = el(`<aside class="panel">
      <button class="close small">✕</button>
      <h2>${isNew ? 'Новая рассылка' : h(broadcast.title)}</h2>
      <div class="hint" id="status" style="margin-bottom:12px"></div>

      <div class="field"><label>Название</label>
        <input class="f-title" value="${h(broadcast.title || '')}"${editable ? '' : ' disabled'}></div>

      <div class="field"><label>Кому</label>
        <select class="f-segment"${editable ? '' : ' disabled'}>
          ${SEGMENTS.map(([v, t]) => `<option value="${v}"${broadcast.segment === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <div class="hint" id="audience"></div></div>

      <div class="field test-ids" style="display:none"><label>Telegram id через запятую</label>
        <input class="f-test-ids" value="${h((broadcast.test_tg_ids || []).join(', '))}"${editable ? '' : ' disabled'}></div>

      <div class="msg-slot"></div>
      <div id="problems"></div>

      <div class="foot">
        ${editable ? '<button class="primary f-save">Сохранить</button>' : ''}
        ${editable ? '<button class="f-test">Тест себе</button>' : ''}
        ${editable && !isNew ? '<button class="f-start">Запустить</button>' : ''}
        ${running ? '<button class="danger f-stop">Остановить</button>' : ''}
        <span style="flex:1"></span>
        ${canSend && !isNew && !running ? '<button class="danger f-delete">Удалить</button>' : ''}
      </div>
    </aside>`);

    const editor = messageEditor({ record: broadcast, media: config.media, canEdit: editable });
    panel.querySelector('.msg-slot').replaceWith(editor.node);

    const segmentSelect = panel.querySelector('.f-segment');
    const testBox = panel.querySelector('.test-ids');
    const audience = panel.querySelector('#audience');

    const refreshAudience = debounce(async () => {
      testBox.style.display = segmentSelect.value === 'test' ? '' : 'none';
      if (segmentSelect.value === 'test') return void (audience.textContent = '');
      try {
        const { count } = await api.get(`/api/audience?segment=${encodeURIComponent(segmentSelect.value)}`);
        audience.textContent = plural(count, 'человек', 'человека', 'человек');
      } catch { audience.textContent = ''; }
    }, 120);
    segmentSelect.onchange = refreshAudience;
    refreshAudience();

    function statusLine() {
      const line = panel.querySelector('#status');
      if (isNew) return void (line.textContent = 'Черновик');
      const [label] = STATUS[broadcast.status] || [broadcast.status];
      line.textContent = broadcast.total ? `${label} · ${broadcast.sent || 0} из ${broadcast.total}` : label;
    }
    statusLine();

    async function refreshProblems() {
      if (isNew) return;
      const { broadcast: current, problems } = await api.get(`/api/broadcasts/${broadcast.id}`);
      Object.assign(broadcast, current);
      statusLine();
      panel.querySelector('#problems').innerHTML = problems.length
        ? `<div class="field"><label>Не доставлено</label><div class="hint mono">${problems.map(p =>
            `${h(p.tg_id)} — ${p.status === 'blocked' ? 'заблокировал бота' : h(p.error || 'ошибка')}`).join('<br>')}</div></div>`
        : '';
      if (current.status === 'sending' && document.body.contains(panel)) setTimeout(refreshProblems, 3000);
    }
    refreshProblems();

    const payload = () => ({
      title: panel.querySelector('.f-title').value.trim() || 'Без названия',
      ...editor.value(),
      segment: segmentSelect.value,
      test_tg_ids: panel.querySelector('.f-test-ids').value.split(',').map(s => s.trim()).filter(Boolean),
    });

    async function save() {
      if (editor.isUploading()) throw new Error('Файл ещё загружается');
      const data = payload();
      if (creating) {
        const { broadcast: created } = await api.post('/api/broadcasts', data);
        Object.assign(broadcast, created);
        creating = false;
        await api.patch(`/api/broadcasts/${created.id}`, { segment: data.segment, test_tg_ids: data.test_tg_ids });
      } else {
        const { broadcast: updated } = await api.patch(`/api/broadcasts/${broadcast.id}`, data);
        Object.assign(broadcast, updated);
      }
      await reload();
    }

    const close = () => panel.remove();
    panel.querySelector('.close').onclick = close;

    const saveButton = panel.querySelector('.f-save');
    if (saveButton) saveButton.onclick = async () => {
      saveButton.disabled = true;
      try {
        await save();
        toast('Сохранено');
        close();
      } catch (err) {
        toast(err.message, 'error');
        saveButton.disabled = false;
      }
    };

    const testButton = panel.querySelector('.f-test');
    if (testButton) testButton.onclick = async () => {
      if (!ctx.me.tg_id) return toast('Укажите свой Telegram id в разделе «Аккаунты»', 'error');
      if (editor.isUploading()) return toast('Файл ещё загружается', 'error');
      testButton.disabled = true;
      try {
        const data = payload();
        const { broadcast: created } = await api.post('/api/broadcasts', { ...data, title: `Тест: ${data.title}`, segment: 'test' });
        await api.patch(`/api/broadcasts/${created.id}`, { segment: 'test', test_tg_ids: [ctx.me.tg_id] });
        await api.post(`/api/broadcasts/${created.id}/start`);
        toast('Отправил вам в Telegram');
        await reload();
      } catch (err) {
        toast(err.message, 'error');
      }
      testButton.disabled = false;
    };

    const startButton = panel.querySelector('.f-start');
    if (startButton) startButton.onclick = async () => {
      const data = payload();
      if (data.segment !== 'test') {
        const { count } = await api.get(`/api/audience?segment=${encodeURIComponent(data.segment)}`);
        if (!count) return toast('В сегменте никого нет', 'error');
        if (!confirm(`Отправить «${data.title}» — ${plural(count, 'человеку', 'людям', 'людям')}?`)) return;
      }
      startButton.disabled = true;
      try {
        await save();
        const { total } = await api.post(`/api/broadcasts/${broadcast.id}/start`);
        toast(`Запущено: ${plural(total, 'получатель', 'получателя', 'получателей')}`);
        await reload();
        refreshProblems();
      } catch (err) {
        toast(err.message, 'error');
      }
      startButton.disabled = false;
    };

    const stopButton = panel.querySelector('.f-stop');
    if (stopButton) stopButton.onclick = async () => {
      if (!confirm('Остановить рассылку?')) return;
      await api.post(`/api/broadcasts/${broadcast.id}/cancel`);
      toast('Остановлена');
      await reload();
      close();
    };

    const deleteButton = panel.querySelector('.f-delete');
    if (deleteButton) deleteButton.onclick = async () => {
      if (!confirm('Удалить рассылку?')) return;
      try {
        await api.del(`/api/broadcasts/${broadcast.id}`);
        toast('Удалена');
        await reload();
        close();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    document.body.append(panel);
  }

  page.addEventListener('click', async event => {
    if (event.target.id === 'new') {
      return openPanel({ title: '', text: '', media_key: null, buttons: [], segment: 'all', test_tg_ids: ctx.me.tg_id ? [ctx.me.tg_id] : [] });
    }
    const row = event.target.closest('tr[data-id]');
    if (row) {
      const { broadcast } = await api.get(`/api/broadcasts/${row.dataset.id}`);
      openPanel(broadcast);
    }
  });

  await reload();
  return page;
}
