import { api } from './api.js';
import { debounce, el, fmtDate, h, toast } from './util.js';

const SEGMENTS = [
  ['', 'Все'],
  ['not_clicked', 'Не нажали'],
  ['clicked', 'Нажали'],
  ['offer', 'Досмотрели'],
  ['not_paid', 'Не купили'],
  ['paid', 'Купили'],
  ['blocked', 'Заблокировали'],
];

const EVENTS = {
  start: 'зашёл в бота', restart: 'повторный /start', sent: 'отправлено', skipped: 'пропущен',
  clicked: 'клик по видео', click: 'клик', video: 'включил видео', offer: 'дошёл до оффера',
  paid: 'оплата', blocked: 'заблокировал бота', payment_hook: 'хук оплаты',
};

const fullName = u => [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : `id ${u.tg_id}`);

function status(user) {
  if (user.blocked_at) return '<span class="badge danger">заблокировал</span>';
  if (user.paid_at) return '<span class="badge ok">купил</span>';
  if (user.offer_at) return '<span class="badge accent">досмотрел</span>';
  if (user.clicked_at) return '<span class="badge">нажал</span>';
  return '<span class="badge warn">не нажал</span>';
}

export async function render(ctx) {
  const canManage = ctx.can('botusers');
  const page = el(`<div>
    <div class="stats" id="stats"></div>
    <div class="bar">
      <input id="query" placeholder="Поиск" style="width:220px">
      <select id="segment" style="width:180px">${SEGMENTS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
    </div>
    <div id="list"></div>
  </div>`);

  const state = { query: '', segment: '', offset: 0, limit: 50 };
  let loaded = [];

  const { funnel } = await api.get('/api/stats');
  page.querySelector('#stats').innerHTML = [
    ['Зашли', funnel.users], ['Нажали', funnel.clicked], ['Досмотрели', funnel.reached_offer],
    ['Купили', funnel.paid], ['Заблокировали', funnel.blocked],
  ].map(([label, value]) => `<div><b>${value}</b><span>${label}</span></div>`).join('');

  async function reload() {
    const query = new URLSearchParams({ query: state.query, segment: state.segment, limit: state.limit, offset: state.offset });
    const { users, total } = await api.get(`/api/users?${query}`);
    loaded = users;
    page.querySelector('#list').innerHTML = users.length ? `<table>
      <thead><tr><th>Кто</th><th>Статус</th><th>Источник</th><th>Почта</th><th>Зашёл</th></tr></thead>
      <tbody>${users.map(u => `<tr data-id="${u.id}">
        <td><b>${h(fullName(u))}</b> <span class="hint mono">${h(u.tg_id)}</span></td>
        <td>${status(u)}</td>
        <td>${h([u.lead_source, u.lead_campaign].filter(Boolean).join(' / ') || '—')}</td>
        <td>${h(u.email || '—')}</td>
        <td class="hint">${fmtDate(u.created_at)}</td>
      </tr>`).join('')}</tbody></table>
      <div class="bar" style="margin-top:12px">
        <span class="hint">Всего ${total}</span><span class="grow"></span>
        <button class="small" id="prev"${state.offset ? '' : ' disabled'}>Назад</button>
        <button class="small" id="next"${state.offset + state.limit < total ? '' : ' disabled'}>Дальше</button>
      </div>` : '<div class="card empty">Никого нет</div>';
  }

  async function openPanel(id) {
    document.querySelector('.panel')?.remove();
    const user = loaded.find(u => String(u.id) === String(id)) || { id, tg_id: '' };
    const { events, jobs, leads = [] } = await api.get(`/api/users/${id}/timeline`);
    const pending = jobs.filter(j => j.status === 'pending');

    const panel = el(`<aside class="panel">
      <button class="close small">✕</button>
      <h2>${h(fullName(user))}</h2>
      <div class="hint mono" style="margin-bottom:6px">${h(user.tg_id || '')}${user.email ? ` · ${h(user.email)}` : ''}</div>
      <div style="margin-bottom:14px">${status(user)}</div>

      ${leads.length ? `<div class="field"><label>Заявка с лендинга</label>
        <div class="timeline">${leads.map(l => `<div class="item"><span class="when">${fmtDate(l.created_at)}</span>
          <span>${h([l.utm_source, l.utm_medium, l.utm_campaign].filter(Boolean).join(' / ') || 'без меток')}${l.phone ? ` · ${h(l.phone)}` : ''}</span></div>`).join('')}</div></div>` : ''}

      <div class="field"><label>В очереди</label>
        ${pending.length ? `<div class="timeline">${pending.map(j =>
          `<div class="item"><span class="when">${fmtDate(j.run_at)}</span><span>${h(j.step)}</span></div>`).join('')}</div>`
          : '<div class="hint">пусто</div>'}</div>

      <div class="field"><label>История</label>
        <div class="timeline">${events.map(e => `<div class="item">
          <span class="when">${fmtDate(e.created_at)}</span>
          <span>${h(EVENTS[e.type] || e.type)}${e.data?.step ? ` · <span class="mono">${h(e.data.step)}</span>` : ''}</span>
        </div>`).join('') || '<div class="hint">пусто</div>'}</div>

      ${canManage ? `<div class="foot">
        <button class="f-paid">Отметить оплату</button>
        <span style="flex:1"></span>
        <button class="danger f-delete">Удалить</button>
      </div>` : ''}
    </aside>`);

    const close = () => panel.remove();
    panel.querySelector('.close').onclick = close;

    const paidButton = panel.querySelector('.f-paid');
    if (paidButton) paidButton.onclick = async () => {
      if (!confirm('Отметить оплату? Дожимы отменятся, уйдёт сообщение «Вижу, что ты купил».')) return;
      try {
        await api.post(`/api/users/${id}/mark`, { what: 'paid', data: { via: 'admin' } });
        toast('Готово');
        close();
        await reload();
      } catch (err) { toast(err.message, 'error'); }
    };

    const deleteButton = panel.querySelector('.f-delete');
    if (deleteButton) deleteButton.onclick = async () => {
      if (!confirm('Удалить пользователя и его историю?')) return;
      try {
        await api.del(`/api/users/${id}`);
        toast('Удалён');
        close();
        await reload();
      } catch (err) { toast(err.message, 'error'); }
    };

    document.body.append(panel);
  }

  page.querySelector('#query').addEventListener('input', debounce(event => {
    state.query = event.target.value.trim();
    state.offset = 0;
    reload();
  }, 300));

  page.querySelector('#segment').addEventListener('change', event => {
    state.segment = event.target.value;
    state.offset = 0;
    reload();
  });

  page.addEventListener('click', async event => {
    if (event.target.id === 'prev') { state.offset = Math.max(0, state.offset - state.limit); return reload(); }
    if (event.target.id === 'next') { state.offset += state.limit; return reload(); }
    const row = event.target.closest('tr[data-id]');
    if (row) await openPanel(row.dataset.id);
  });

  await reload();
  return page;
}
