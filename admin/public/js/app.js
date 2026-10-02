import { api, setUnauthorizedHandler } from './api.js';
import { el, h, toast } from './util.js';

const ROUTES = [
  { path: 'flow', title: 'Схема', nav: true, flush: true, load: () => import('./flow.js') },
  { path: 'broadcasts', title: 'Рассылки', nav: true, load: () => import('./broadcasts.js') },
  { path: 'users', title: 'Люди', nav: true, load: () => import('./users.js') },
  { path: 'leads', title: 'Заявки', nav: true, load: () => import('./leads.js') },
  { path: 'settings', title: 'Настройки', load: () => import('./settings.js') },
  { path: 'accounts', title: 'Аккаунты', permission: 'accounts', load: () => import('./accounts.js') },
];

const root = document.getElementById('app');
let me = null;

const ctx = {
  get me() { return me; },
  can: permission => (me?.permissions || []).includes(permission),
  go: path => { window.location.hash = `#/${path}`; },
  toast,
};

setUnauthorizedHandler(() => {
  if (!me) return;
  me = null;
  renderLogin('Сессия закончилась');
});

function renderLogin(error = '') {
  root.className = 'login';
  root.innerHTML = `<form>
    <h1>Воронка Pet Rock</h1>
    ${error ? `<div class="error">${h(error)}</div>` : ''}
    <div class="field"><label>Логин</label><input name="login" autocomplete="username" autofocus></div>
    <div class="field"><label>Пароль</label><input name="password" type="password" autocomplete="current-password"></div>
    <button class="primary" style="width:100%" type="submit">Войти</button>
  </form>`;

  root.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    form.querySelector('button').disabled = true;
    try {
      const { me: profile } = await api.login(form.login.value.trim(), form.password.value);
      me = profile;
      if (!window.location.hash) window.location.hash = '#/flow';
      await renderShell();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

function currentRoute() {
  const path = (window.location.hash.replace(/^#\/?/, '') || 'flow').split('/')[0];
  const route = ROUTES.find(r => r.path === path) || ROUTES[0];
  return route.permission && !ctx.can(route.permission) ? ROUTES[0] : route;
}

async function renderShell() {
  root.className = '';
  const nav = ROUTES.filter(r => r.nav).map(r => `<a href="#/${r.path}" data-route="${r.path}">${r.title}</a>`).join('');

  root.innerHTML = `<div class="shell">
    <header class="top">
      <span class="logo">Pet Rock</span>
      <nav>${nav}</nav>
      <span class="grow"></span>
      <span class="who">${h(me.name || me.login)}</span>
      <span class="menu">
        <button class="icon" id="menu-button" title="Ещё">⋯</button>
      </span>
    </header>
    <div class="page" id="page"><div class="loading">Загрузка…</div></div>
  </div>`;

  const menu = root.querySelector('.menu');
  root.querySelector('#menu-button').onclick = event => {
    event.stopPropagation();
    if (menu.querySelector('.menu-list')) return menu.querySelector('.menu-list').remove();
    const items = [
      '<a href="#/settings">Настройки</a>',
      ctx.can('accounts') ? '<a href="#/accounts">Аккаунты</a>' : '',
      '<a href="#" id="logout">Выйти</a>',
    ].join('');
    const list = el(`<div class="menu-list">${items}</div>`);
    list.querySelector('#logout').onclick = async e => {
      e.preventDefault();
      await api.logout().catch(() => {});
      me = null;
      renderLogin();
    };
    menu.append(list);
  };
  document.addEventListener('click', () => menu.querySelector('.menu-list')?.remove());

  await renderPage();
}

async function renderPage() {
  if (!me) return;
  const route = currentRoute();
  const page = document.getElementById('page');
  if (!page) return;
  document.querySelector('.panel')?.remove();
  for (const link of root.querySelectorAll('.top a[data-route]')) {
    link.classList.toggle('active', link.dataset.route === route.path);
  }
  page.classList.toggle('flush', !!route.flush);
  page.innerHTML = '<div class="loading">Загрузка…</div>';
  try {
    const module = await route.load();
    page.replaceChildren(await module.render(ctx));
  } catch (err) {
    console.error(err);
    page.replaceChildren(el(`<div class="card">${h(err.message)}</div>`));
  }
}

window.addEventListener('hashchange', renderPage);

try {
  const { me: profile } = await api.get('/api/me');
  me = profile;
  await renderShell();
} catch {
  renderLogin();
}
