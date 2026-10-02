import { api } from './api.js';
import { el, fmtDate, h, toast } from './util.js';

const ROLES = [
  ['owner', 'Владелец', 'всё, включая аккаунты'],
  ['editor', 'Редактор', 'схема, медиа, настройки, рассылки'],
  ['marketer', 'Маркетолог', 'рассылки и медиа'],
  ['viewer', 'Наблюдатель', 'только просмотр'],
];

const roleTitle = role => (ROLES.find(([k]) => k === role) || [role, role])[1];

export async function render(ctx) {
  const page = el(`<div style="max-width:820px">
    <div class="bar">
      <h1 style="margin:0">Аккаунты</h1>
      <span class="grow"></span>
      <button class="primary" id="new">Добавить</button>
    </div>
    <div id="list"></div>
  </div>`);

  let accounts = [];

  async function reload() {
    accounts = (await api.get('/api/accounts')).accounts;
    page.querySelector('#list').innerHTML = `<table>
      <thead><tr><th>Логин</th><th>Имя</th><th>Роль</th><th>Telegram id</th><th>Был</th></tr></thead>
      <tbody>${accounts.map(a => `<tr data-id="${a.id}">
        <td><b class="mono">${h(a.login)}</b>${a.disabled ? ' <span class="badge danger">выключен</span>' : ''}</td>
        <td>${h(a.name || '—')}</td>
        <td><span class="badge${a.role === 'owner' ? ' accent' : ''}">${h(roleTitle(a.role))}</span></td>
        <td class="mono">${h(a.tg_id || '—')}</td>
        <td class="hint">${fmtDate(a.last_login_at)}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  function openPanel(account) {
    document.querySelector('.panel')?.remove();
    const isNew = !account.id;
    const isMe = String(account.id) === String(ctx.me.id);

    const panel = el(`<aside class="panel">
      <button class="close small">✕</button>
      <h2>${isNew ? 'Новый аккаунт' : h(account.login)}</h2>

      ${isNew ? '<div class="field"><label>Логин</label><input class="f-login mono" placeholder="ivan"></div>' : ''}
      <div class="field"><label>Имя</label><input class="f-name" value="${h(account.name || '')}"></div>
      <div class="field"><label>Роль</label>
        <select class="f-role">${ROLES.map(([v, t, about]) =>
          `<option value="${v}"${account.role === v ? ' selected' : ''}>${t} — ${about}</option>`).join('')}</select></div>
      <div class="field"><label>Telegram id</label><input class="f-tg" value="${h(account.tg_id || '')}"></div>
      <div class="field"><label>${isNew ? 'Пароль' : 'Новый пароль'}</label>
        <input class="f-password" type="password" autocomplete="new-password"></div>
      ${isNew || isMe ? '' : `<div class="field"><label>Доступ</label>
        <select class="f-disabled">
          <option value="0"${account.disabled ? '' : ' selected'}>включён</option>
          <option value="1"${account.disabled ? ' selected' : ''}>выключен</option>
        </select></div>`}

      <div class="foot">
        <button class="primary f-save">Сохранить</button>
        <span style="flex:1"></span>
        ${!isNew && !isMe ? '<button class="danger f-delete">Удалить</button>' : ''}
      </div>
    </aside>`);

    const close = () => panel.remove();
    panel.querySelector('.close').onclick = close;

    panel.querySelector('.f-save').onclick = async event => {
      event.target.disabled = true;
      try {
        const password = panel.querySelector('.f-password').value;
        const body = {
          name: panel.querySelector('.f-name').value.trim(),
          role: panel.querySelector('.f-role').value,
          tg_id: panel.querySelector('.f-tg').value.trim() || null,
        };
        const disabledField = panel.querySelector('.f-disabled');
        if (disabledField) body.disabled = disabledField.value === '1';
        if (isNew) await api.post('/api/accounts', { ...body, login: panel.querySelector('.f-login').value.trim().toLowerCase(), password });
        else await api.patch(`/api/accounts/${account.id}`, password ? { ...body, password } : body);
        toast('Сохранено');
        await reload();
        close();
      } catch (err) {
        toast(err.message, 'error');
        event.target.disabled = false;
      }
    };

    const deleteButton = panel.querySelector('.f-delete');
    if (deleteButton) deleteButton.onclick = async () => {
      if (!confirm(`Удалить «${account.login}»?`)) return;
      try {
        await api.del(`/api/accounts/${account.id}`);
        toast('Удалён');
        await reload();
        close();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    document.body.append(panel);
  }

  page.addEventListener('click', event => {
    if (event.target.id === 'new') return openPanel({ role: 'editor' });
    const row = event.target.closest('tr[data-id]');
    if (row) openPanel(accounts.find(a => String(a.id) === row.dataset.id));
  });

  await reload();
  return page;
}
