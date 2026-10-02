import { api } from './api.js';
import { debounce, el, fmtDate, fmtDateFull, h, toast } from './util.js';

const GROUPS = [
  ['utm_source', 'Источник'],
  ['utm_medium', 'Тип трафика'],
  ['utm_campaign', 'Кампания'],
  ['utm_content', 'Объявление'],
  ['utm_term', 'Ключ'],
];

const STATUSES = [['', 'Все'], ['in_bot', 'Пришли в бота'], ['not_in_bot', 'Не пришли']];

const pct = (part, whole) => (whole ? `${Math.round(part / whole * 100)}%` : '');
const tags = l => [l.utm_source, l.utm_medium, l.utm_campaign].filter(Boolean).join(' / ');
const who = l => l.name || l.phone || l.email || l.id;
const botName = l => [l.first_name, l.last_name].filter(Boolean).join(' ') || (l.username ? `@${l.username}` : `id ${l.tg_id}`);

function botStatus(l) {
  if (!l.user_id) return '<span class="badge warn">не пришёл</span>';
  if (l.blocked_at) return '<span class="badge danger">заблокировал</span>';
  if (l.paid_at) return '<span class="badge ok">купил</span>';
  if (l.offer_at) return '<span class="badge accent">досмотрел</span>';
  if (l.clicked_at) return '<span class="badge">нажал на видео</span>';
  return '<span class="badge">в боте</span>';
}

export async function render(ctx) {
  const canManage = ctx.can('botusers');
  const page = el(`<div>
    <div class="stats" id="stats"></div>
    <div class="bar">
      <div class="tabs"><button data-view="list" class="active">Заявки</button><button data-view="sources">Источники</button></div>
    </div>
    <div id="view"></div>
  </div>`);

  const state = { view: 'list', query: '', status: '', by: 'utm_source', value: undefined, offset: 0, limit: 50 };
  let loaded = [];

  const { total } = await api.get('/api/leads/summary');
  page.querySelector('#stats').innerHTML = [
    ['Заявок', total.leads, ''],
    ['Пришли в бота', total.in_bot, pct(total.in_bot, total.leads)],
    ['Нажали на видео', total.clicked, ''],
    ['Досмотрели', total.offer, ''],
    ['Купили', total.paid, ''],
  ].map(([label, value, share]) => `<div><b>${value}${share ? ` <small class="hint">${share}</small>` : ''}</b><span>${label}</span></div>`).join('');

  const view = page.querySelector('#view');

  async function renderList() {
    const filter = state.value !== undefined
      ? `<span class="badge accent">${h(GROUPS.find(g => g[0] === state.by)[1])}: ${h(state.value || 'без метки')}
          <a href="#" id="clear-filter" style="text-decoration:none">✕</a></span>` : '';
    view.innerHTML = `<div class="bar">
        <input id="query" placeholder="Поиск: имя, телефон, почта, метка" style="width:280px" value="${h(state.query)}">
        <select id="status" style="width:170px">${STATUSES.map(([v, t]) => `<option value="${v}"${v === state.status ? ' selected' : ''}>${t}</option>`).join('')}</select>
        ${filter}
      </div><div id="list"></div>`;
    view.querySelector('#query').addEventListener('input', debounce(event => {
      state.query = event.target.value.trim();
      state.offset = 0;
      reloadList();
    }, 300));
    view.querySelector('#status').addEventListener('change', event => {
      state.status = event.target.value;
      state.offset = 0;
      reloadList();
    });
    await reloadList();
  }

  async function reloadList() {
    const params = { query: state.query, status: state.status, limit: state.limit, offset: state.offset };
    if (state.value !== undefined) Object.assign(params, { by: state.by, value: state.value });
    const { leads, total: count } = await api.get(`/api/leads?${new URLSearchParams(params)}`);
    loaded = leads;
    view.querySelector('#list').innerHTML = leads.length ? `<table>
      <thead><tr><th>Заявка</th><th>Кто</th><th>Метки</th><th>Бот</th></tr></thead>
      <tbody>${leads.map(l => `<tr data-id="${h(l.id)}">
        <td class="hint">${fmtDate(l.created_at)}</td>
        <td><b>${h(who(l))}</b>${l.name && l.phone ? ` <span class="hint">${h(l.phone)}</span>` : ''}</td>
        <td>${h(tags(l)) || '<span class="hint">—</span>'}</td>
        <td>${botStatus(l)}</td>
      </tr>`).join('')}</tbody></table>
      <div class="bar" style="margin-top:12px">
        <span class="hint">Всего ${count}</span><span class="grow"></span>
        <button class="small" id="prev"${state.offset ? '' : ' disabled'}>Назад</button>
        <button class="small" id="next"${state.offset + state.limit < count ? '' : ' disabled'}>Дальше</button>
      </div>` : '<div class="card empty">Заявок пока нет</div>';
  }

  async function renderSources() {
    view.innerHTML = `<div class="bar">
        <select id="by" style="width:200px">${GROUPS.map(([v, t]) => `<option value="${v}"${v === state.by ? ' selected' : ''}>${t}</option>`).join('')}</select>
        <span class="hint">клик по строке — заявки с этой меткой</span>
      </div><div id="list"></div>`;
    view.querySelector('#by').addEventListener('change', event => {
      state.by = event.target.value;
      reloadSources();
    });
    await reloadSources();
  }

  async function reloadSources() {
    const { groups } = await api.get(`/api/leads/summary?${new URLSearchParams({ by: state.by })}`);
    const cell = (value, of) => `<td>${value}${of && value ? ` <span class="hint">${pct(value, of)}</span>` : ''}</td>`;
    view.querySelector('#list').innerHTML = groups.length ? `<table>
      <thead><tr><th>${h(GROUPS.find(g => g[0] === state.by)[1])}</th><th>Заявки</th><th>В боте</th><th>Нажали</th><th>Досмотрели</th><th>Купили</th></tr></thead>
      <tbody>${groups.map(g => `<tr data-value="${h(g.value)}">
        <td><b>${h(g.value) || '<span class="hint">без метки</span>'}</b></td>
        <td>${g.leads}</td>${cell(g.in_bot, g.leads)}${cell(g.clicked, g.leads)}${cell(g.offer, g.leads)}${cell(g.paid, g.leads)}
      </tr>`).join('')}</tbody></table>
      <div class="hint" style="margin-top:8px">Проценты — от числа заявок.</div>` : '<div class="card empty">Заявок пока нет</div>';
  }

  function openPanel(id) {
    document.querySelector('.panel')?.remove();
    const l = loaded.find(x => x.id === id);
    if (!l) return;
    const utm = GROUPS.filter(([k]) => l[k]).map(([k]) => `<div class="item"><span class="when">${k}</span><span>${h(l[k])}</span></div>`).join('');
    const extra = Object.entries(l.data || {}).map(([k, v]) =>
      `<div class="item"><span class="when">${h(k)}</span><span style="word-break:break-all">${h(typeof v === 'object' ? JSON.stringify(v) : v)}</span></div>`).join('');

    const panel = el(`<aside class="panel">
      <button class="close small">✕</button>
      <h2>${h(who(l))}</h2>
      <div class="hint mono" style="margin-bottom:6px">${h(l.id)}</div>
      <div style="margin-bottom:14px">${botStatus(l)}</div>
      ${l.phone || l.email ? `<div class="field"><label>Контакты</label>${[l.phone, l.email].filter(Boolean).map(h).join('<br>')}</div>` : ''}
      <div class="field"><label>Заявка</label>${fmtDateFull(l.created_at)}</div>
      <div class="field"><label>Бот</label>${l.user_id
        ? `${h(botName(l))} <span class="hint mono">${h(l.tg_id)}</span><div class="hint">открыл ${fmtDateFull(l.started_at)}</div>`
        : '<span class="hint">не открывал бота по ссылке</span>'}</div>
      <div class="field"><label>Метки</label>${utm ? `<div class="timeline">${utm}</div>` : '<span class="hint">нет</span>'}</div>
      ${extra ? `<div class="field"><label>Остальное</label><div class="timeline">${extra}</div></div>` : ''}
      ${canManage ? `<div class="foot"><span style="flex:1"></span><button class="danger f-delete">Удалить заявку</button></div>` : ''}
    </aside>`);

    panel.querySelector('.close').onclick = () => panel.remove();
    const deleteButton = panel.querySelector('.f-delete');
    if (deleteButton) deleteButton.onclick = async () => {
      if (!confirm('Удалить заявку? Человек в боте останется.')) return;
      try {
        await api.del(`/api/leads/${encodeURIComponent(id)}`);
        toast('Удалена');
        panel.remove();
        await reloadList();
      } catch (err) { toast(err.message, 'error'); }
    };
    document.body.append(panel);
  }

  async function show(name) {
    state.view = name;
    for (const b of page.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.view === name);
    document.querySelector('.panel')?.remove();
    if (name === 'list') await renderList();
    else await renderSources();
  }

  page.addEventListener('click', async event => {
    const tab = event.target.closest('.tabs button');
    if (tab) return show(tab.dataset.view);
    if (event.target.id === 'clear-filter') {
      event.preventDefault();
      state.value = undefined;
      state.offset = 0;
      return renderList();
    }
    if (event.target.id === 'prev') { state.offset = Math.max(0, state.offset - state.limit); return reloadList(); }
    if (event.target.id === 'next') { state.offset += state.limit; return reloadList(); }
    const source = event.target.closest('tr[data-value]');
    if (source) {
      state.value = source.dataset.value;
      state.offset = 0;
      return show('list');
    }
    const row = event.target.closest('tr[data-id]');
    if (row) openPanel(row.dataset.id);
  });

  await show('list');
  return page;
}
