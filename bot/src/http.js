import crypto from 'node:crypto';
import express from 'express';
import { api } from './api.js';
import { config } from './config.js';
import { deadlineOf, isExpired } from './deadline.js';
import { onClick, onOffer, onPaid, onVideoPlay } from './funnel.js';
import { load } from './store.js';

// За каким прокси стоит сервис: loopback — nginx на этой же машине,
// в Docker — «loopback, uniquelocal» (прокси приходит из внутренней сети).
const trustProxy = value => (value === 'true' ? true : value === 'false' ? false : /^\d+$/.test(value) ? Number(value) : value);

const TOKEN_RE = /^[A-Za-z0-9_-]{8,40}$/;

const wrap = fn => (req, res, next) => fn(req, res).catch(next);

async function findUser(token) {
  if (!TOKEN_RE.test(token)) return null;
  try {
    return await api.userByToken(token);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

function secretOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(config.hookSecret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function closedPage(cfg) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(cfg.setting('video_page_title', 'Видео'))}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b0c; color: #eee; font-family: system-ui, sans-serif; text-align: center; padding: 24px; }
</style>
</head>
<body><main><p>${escapeHtml(cfg.setting('video_closed_text', 'Доступ закрыт'))}</p></main></body>
</html>`;
}

// Страница с плеером. Код встраивания Vturb и секунда оффера задаются в админке.
function videoPage(user, cfg) {
  const token = user.token;
  const embed = cfg.setting('vturb_embed', '').trim();
  const offerSeconds = cfg.number('offer_seconds', 0);
  // Купившим таймер не показываем: им страница не закрывается.
  const deadline = user.paid_at ? null : deadlineOf(user, cfg);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(cfg.setting('video_page_title', 'Видео'))}</title>
<style>
  body { margin: 0; background: #0b0b0c; color: #eee; font-family: system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 16px; }
  .placeholder { aspect-ratio: 16 / 9; display: grid; place-items: center; border: 1px solid #333; border-radius: 12px; color: #999; }
  .timer { text-align: center; color: #bbb; }
  .timer b { display: block; font-size: 32px; color: #fff; letter-spacing: 1px; }
</style>
</head>
<body>
<main>
<div class="offer-marker" style="display:none"></div>
${deadline ? '<p class="timer">До закрытия доступа <b id="countdown"></b></p>' : ''}
${embed || `<div class="placeholder">${escapeHtml(cfg.setting('video_page_placeholder', 'Видео скоро появится здесь'))}</div>
<p><button id="test-offer" type="button" style="font-size:16px;padding:12px 16px;border-radius:10px;border:0;cursor:pointer">Тест: досмотрел до оффера</button> <span id="test-status"></span></p>`}
</main>
<script>
(function () {
  var token = ${JSON.stringify(token)};
  var offerSeconds = ${offerSeconds};
  var deadline = ${deadline ? deadline.getTime() : 0};
  var countdown = document.getElementById('countdown');
  var timer = null;
  function tick() {
    if (!countdown || !deadline) return;
    var left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    if (!left) {
      clearInterval(timer);
      countdown.textContent = '00 : 00 : 00';
      // Перезагружаем один раз — если часы телефона спешат, не уйдём в бесконечный цикл.
      try {
        if (sessionStorage.getItem('reloaded-' + token)) return;
        sessionStorage.setItem('reloaded-' + token, '1');
      } catch (e) {}
      setTimeout(function () { location.reload(); }, 2000);
      return;
    }
    var h = Math.floor(left / 3600), m = Math.floor(left % 3600 / 60), s = left % 60;
    countdown.textContent = [h, m, s].map(function (v) { return (v < 10 ? '0' : '') + v; }).join(' : ');
  }
  timer = setInterval(tick, 1000);
  tick();
  var sent = {};
  function report(type, t) {
    if (sent[type]) return;
    sent[type] = true;
    var body = JSON.stringify({ token: token, type: type, t: Math.round(t || 0) });
    if (!(navigator.sendBeacon && navigator.sendBeacon('/api/video', new Blob([body], { type: 'application/json' })))) {
      fetch('/api/video', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true });
    }
  }
  // Документированный API Vturb: по событию «player:ready» просим плеер показать скрытый
  // элемент на секунде оффера — тем же способом он показывает кнопку оплаты.
  var marker = document.querySelector('.offer-marker');
  var player = document.querySelector('vturb-smartplayer');
  if (player && marker && offerSeconds > 0) {
    player.addEventListener('player:ready', function () {
      try {
        player.displayHiddenElements(offerSeconds, ['.offer-marker'], { persist: true });
        new MutationObserver(function () {
          if (getComputedStyle(marker).display !== 'none') report('offer', offerSeconds);
        }).observe(marker, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
      } catch (e) {}
    });
  }
  // Запасной вариант: читаем текущее время у того плеера, который окажется на странице.
  function currentTime() {
    var el = document.querySelector('vturb-smartplayer');
    var candidates = [
      el && el.currentTime,
      el && el.video && el.video.currentTime,
      el && el.shadowRoot && el.shadowRoot.querySelector('video') && el.shadowRoot.querySelector('video').currentTime,
      window.smartplayer && smartplayer.instances && smartplayer.instances[0] && smartplayer.instances[0].video && smartplayer.instances[0].video.currentTime,
      document.querySelector('video') && document.querySelector('video').currentTime
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (typeof candidates[i] === 'number' && !isNaN(candidates[i])) return candidates[i];
    }
    return null;
  }
  setInterval(function () {
    if (marker && getComputedStyle(marker).display !== 'none') report('offer', offerSeconds);
    var t = currentTime();
    if (t === null) return;
    if (t > 1) report('play', t);
    if (offerSeconds > 0 && t >= offerSeconds) report('offer', t);
  }, 1000);
  // Ручной вызов для своей страницы: window.petrockOffer()
  window.petrockOffer = function () { report('offer', currentTime()); };
  // Пока видео нет, кнопка заменяет досмотр до оффера.
  var testButton = document.getElementById('test-offer');
  if (testButton) testButton.onclick = function () {
    window.petrockOffer();
    testButton.disabled = true;
    document.getElementById('test-status').textContent = 'Засчитано — возвращайся в бота';
  };
})();
</script>
</body>
</html>`;
}

export function createHttpServer(bot) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy(process.env.TRUST_PROXY || 'loopback'));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Ссылка из кнопки бота: /c/<token>/<video|channel|offer>
  app.get('/c/:token/:key', wrap(async (req, res) => {
    const { token, key } = req.params;
    const cfg = await load();
    const user = await findUser(token);
    if (!user) return res.status(404).type('text').send(cfg.setting('link_expired_text', 'Ссылка устарела'));
    if (key === 'channel') {
      await onClick(user, 'channel');
      const url = cfg.setting('channel_url');
      return url ? res.redirect(302, url) : res.status(404).send('');
    }
    // Кнопки оплаты: своя страница оформления, если задана, иначе страница с видео и кнопкой покупки.
    if (key === 'offer') {
      await onClick(user, 'offer');
      const checkout = cfg.setting('checkout_url');
      return res.redirect(302, checkout && !isExpired(user, cfg) ? checkout : `${config.publicUrl}/w/${token}`);
    }
    if (key !== 'video') return res.status(404).send('');
    await onClick(user, 'video');
    res.redirect(302, `${config.publicUrl}/w/${token}`);
  }));

  app.get('/w/:token', wrap(async (req, res) => {
    const cfg = await load();
    const user = await findUser(req.params.token);
    if (!user) return res.status(404).type('text').send(cfg.setting('link_expired_text', 'Ссылка устарела'));
    // Срок вышел — страница с видео и оплатой закрывается, как обещают сообщения воронки.
    if (isExpired(user, cfg)) {
      return res.set('cache-control', 'no-store').type('html').send(closedPage(cfg));
    }
    res.set('cache-control', 'no-store').type('html').send(videoPage(user, cfg));
  }));

  // Прогресс просмотра со страницы видео (или с любой внешней страницы с токеном).
  app.options('/api/video', (_req, res) => {
    res.set({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' }).sendStatus(204);
  });
  app.post('/api/video', express.json({ type: () => true, limit: '10kb' }), wrap(async (req, res) => {
    res.set('access-control-allow-origin', '*');
    const { token, type, t } = req.body || {};
    const user = await findUser(String(token || ''));
    if (!user) return res.status(404).json({ error: 'not found' });
    if (type === 'play') await onVideoPlay(user, { t });
    else if (type === 'offer') await onOffer(user, { t });
    else return res.status(400).json({ error: 'unknown type' });
    res.json({ ok: true });
  }));

  // Хук оплаты из GetCourse («Вызвать URL» в процессе): ?secret=...&email=...&user_id=...
  app.all('/hooks/gc/payment', express.urlencoded({ extended: false }), express.json(), wrap(async (req, res) => {
    const params = { ...req.query, ...(req.body || {}) };
    if (!secretOk(params.secret)) return res.status(403).json({ error: 'forbidden' });
    const email = params.email || params.user_email || '';
    const gcUserId = params.user_id || params.uid || params.gc_user_id || '';
    const { secret, ...raw } = params;
    const users = await api.payment({ email, gc_user_id: gcUserId, raw });
    for (const user of users) await onPaid(user);
    res.json({ ok: true, matched: users.length });
  }));

  app.use((err, _req, res, _next) => {
    console.error('http error:', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app.listen(config.httpPort, config.httpHost, () => {
    console.log(`http listening on ${config.httpHost}:${config.httpPort}`);
  });
}
