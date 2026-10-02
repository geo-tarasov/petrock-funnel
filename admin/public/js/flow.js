import { api } from './api.js';
import { messageEditor } from './components.js';
import { el, fmtDuration, h, splitDuration, toast } from './util.js';

const W = 200;
const H = 58;
const GAP_X = 96;
const GAP_Y = 52;

const BRANCHES = [
  ['main', 'Старт'],
  ['not_clicked', 'Не нажал на видео'],
  ['clicked', 'Нажал, но не досмотрел'],
  ['offer', 'Досмотрел, но не купил'],
  ['closed', 'Дедлайн'],
  ['paid', 'Купил'],
  ['service', 'Служебные'],
];

const TRIGGERS = {
  start: 'от /start',
  restart: 'повторный /start',
  click: 'после клика',
  offer: 'после оффера',
  paid: 'после оплаты',
};

const GUARDS = {
  active: 'всем, кто не купил',
  not_clicked: 'кто не нажал на видео',
  clicked: 'кто нажал, но не досмотрел',
  offer: 'кто досмотрел, но не купил',
  paid: 'купившим',
  not_watched: 'кто не досмотрел (старое)',
};

const UNITS = [[1, 'сек'], [60, 'мин'], [3600, 'ч'], [86400, 'дн']];
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const randomKey = () => `step_${Math.random().toString(36).slice(2, 8)}`;

function chainsOf(steps, branchKey) {
  const inBranch = steps.filter(s => s.branch === branchKey).sort((a, b) => a.sort - b.sort);
  const byKey = new Map(inBranch.map(s => [s.key, s]));
  const referenced = new Set(inBranch.map(s => s.next_key).filter(k => byKey.has(k)));
  const used = new Set();
  const chains = [];

  for (const head of inBranch.filter(s => !referenced.has(s.key))) {
    const chain = [];
    for (let step = head; step && !used.has(step.key); step = byKey.get(step.next_key)) {
      used.add(step.key);
      chain.push(step);
    }
    chains.push(chain);
  }
  for (const step of inBranch) if (!used.has(step.key)) chains.push([step]);
  return chains;
}

// Для веток от /start считаем время от Т0: «Т0 + 6 ч» читается проще, чем цепочка пауз.
function offsetsFromT0(steps) {
  const byKey = new Map(steps.map(s => [s.key, s]));
  const offsets = new Map();
  for (const head of steps.filter(s => s.trigger === 'start')) {
    let total = 0;
    const seen = new Set();
    for (let step = head; step && !seen.has(step.key); step = byKey.get(step.next_key)) {
      seen.add(step.key);
      total += step.delay_seconds;
      if (!offsets.has(step.key)) offsets.set(step.key, total);
    }
  }
  return offsets;
}

function layout(steps) {
  const pos = new Map();
  const rows = [];
  const known = new Set(BRANCHES.map(([key]) => key));
  const extra = [...new Set(steps.filter(s => !known.has(s.branch)).map(s => s.branch))].map(b => [b, b]);
  let y = 0;

  for (const [branch, title] of [...BRANCHES, ...extra]) {
    const chains = chainsOf(steps, branch);
    if (!chains.length) continue;
    rows.push({ title, y });
    for (const chain of chains) {
      chain.forEach((step, i) => pos.set(step.key, { x: i * (W + GAP_X), y }));
      y += H + GAP_Y;
    }
    y += 16;
  }

  // ручные координаты перекрывают автоматические
  for (const step of steps) {
    if (step.pos_x !== null && step.pos_y !== null) pos.set(step.key, { x: step.pos_x, y: step.pos_y });
  }
  return { pos, rows };
}

export async function render(ctx) {
  const canEdit = ctx.can('flow');
  const canvas = el(`<div class="canvas">
    <div class="world">
      <svg><defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="#b6bcc7"></path></marker></defs><g class="edges"></g></svg>
      <div class="nodes"></div>
    </div>
    <div class="zoom">
      <button class="icon" data-zoom="-">−</button>
      <span class="level">100%</span>
      <button class="icon" data-zoom="+">+</button>
      <button class="small" data-zoom="fit">По размеру</button>
    </div>
  </div>`);

  const world = canvas.querySelector('.world');
  const svg = canvas.querySelector('svg');
  const edges = canvas.querySelector('.edges');
  const nodes = canvas.querySelector('.nodes');
  const level = canvas.querySelector('.level');

  let config = null;
  let places = new Map();
  let offsets = new Map();
  let selected = null;
  let scale = 1;
  let tx = 40;
  let ty = 40;

  function applyTransform() {
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    canvas.style.backgroundSize = `${22 * scale}px ${22 * scale}px`;
    canvas.style.backgroundPosition = `${tx}px ${ty}px`;
    level.textContent = `${Math.round(scale * 100)}%`;
  }

  function bounds() {
    const list = [...places.values()];
    if (!list.length) return { x: 0, y: 0, w: W, h: H };
    const minX = Math.min(...list.map(p => p.x));
    const minY = Math.min(...list.map(p => p.y)) - 24;
    const maxX = Math.max(...list.map(p => p.x)) + W;
    const maxY = Math.max(...list.map(p => p.y)) + H;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function fit() {
    const box = bounds();
    const pad = 48;
    const k = Math.min((canvas.clientWidth - pad * 2) / box.w, (canvas.clientHeight - pad * 2) / box.h, 1);
    scale = clamp(k, 0.2, 1);
    tx = pad - box.x * scale;
    ty = pad - box.y * scale;
    applyTransform();
  }

  function blockHtml(step) {
    const place = places.get(step.key);
    const meta = [];
    const t0 = offsets.get(step.key);
    if (t0 !== undefined) meta.push(t0 ? `Т0 + ${fmtDuration(t0)}` : 'Т0');
    else if (step.trigger) meta.push(step.delay_seconds ? `${TRIGGERS[step.trigger] || step.trigger} + ${fmtDuration(step.delay_seconds)}` : (TRIGGERS[step.trigger] || step.trigger));
    if (step.media_key) {
      const info = config.media.find(m => m.key === step.media_key);
      meta.push(info?.kind === 'video_note' ? 'кружок' : (info?.kind === 'video' ? 'видео' : 'фото'));
    }
    if ((step.buttons || []).length) meta.push(`${step.buttons.length} кноп.`);
    if (!step.enabled) meta.push('выключен');

    return `<div class="block${step.trigger ? ' entry' : ''}${step.enabled ? '' : ' off'}${selected === step.key ? ' selected' : ''}"
      data-key="${h(step.key)}" style="left:${place.x}px; top:${place.y}px">
      <div class="name">${h(step.title || step.key)}</div>
      ${meta.length ? `<div class="meta">${meta.map(m => `<span>${h(m)}</span>`).join('')}</div>` : ''}
      ${canEdit ? '<button class="add" title="Добавить шаг после">+</button>' : ''}
    </div>`;
  }

  // Высота блока зависит от содержимого — меряем по факту, чтобы стрелки попадали в края.
  const heights = new Map();
  function measure() {
    for (const block of nodes.querySelectorAll('.block')) heights.set(block.dataset.key, block.offsetHeight);
  }
  const heightOf = key => heights.get(key) || H;

  // Соседний блок справа — плавная дуга, переход на другую ветку — колено сверху вниз.
  function edgeGeometry(step, next) {
    const from = places.get(step.key);
    const to = places.get(next.key);
    const fh = heightOf(step.key);
    const th = heightOf(next.key);
    const straight = to.x >= from.x + W - 10 && Math.abs(to.y - from.y) < 30;

    if (straight) {
      const x1 = from.x + W;
      const y1 = from.y + fh / 2;
      const x2 = to.x;
      const y2 = to.y + th / 2;
      const dx = Math.max(40, (x2 - x1) / 2);
      return { d: `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 };
    }

    const sx = from.x + W / 2;
    const sy = from.y + fh;
    const tx = to.x + W / 2;
    const ty = to.y;
    const midY = Math.min(sy + 26, Math.max(sy + 12, ty - 14));
    const r = 10;
    const dir = tx > sx ? 1 : -1;
    const d = Math.abs(tx - sx) < 4
      ? `M${sx} ${sy} L${tx} ${ty}`
      : `M${sx} ${sy} L${sx} ${midY - r} Q${sx} ${midY} ${sx + dir * r} ${midY} L${tx - dir * r} ${midY} Q${tx} ${midY} ${tx} ${midY + r} L${tx} ${ty}`;
    return { d, lx: (sx + tx) / 2, ly: midY };
  }

  function drawEdges() {
    const paths = [];
    const labels = [];
    for (const step of config.steps) {
      const next = step.next_key ? config.steps.find(s => s.key === step.next_key) : null;
      if (!next || !places.has(step.key) || !places.has(next.key)) continue;
      const geo = edgeGeometry(step, next);
      paths.push(`<path class="edge" d="${geo.d}" marker-end="url(#arrow)"></path>`);
      if (next.delay_seconds) {
        labels.push(`<div class="edge-label" style="left:${geo.lx}px; top:${geo.ly}px">${h(fmtDuration(next.delay_seconds))}</div>`);
      }
    }
    edges.innerHTML = paths.join('');
    nodes.querySelectorAll('.edge-label.delay').forEach(node => node.remove());
    nodes.insertAdjacentHTML('beforeend', labels.map(l => l.replace('class="edge-label"', 'class="edge-label delay"')).join(''));
  }

  function draw() {
    offsets = offsetsFromT0(config.steps);
    const result = layout(config.steps);
    places = result.pos;

    const box = bounds();
    svg.setAttribute('width', box.x + box.w + 200);
    svg.setAttribute('height', box.y + box.h + 200);

    nodes.innerHTML = config.steps.filter(s => places.has(s.key)).map(blockHtml).join('')
      + result.rows.map(row => `<div class="row-title" style="left:2px; top:${row.y - 24}px">${h(row.title)}</div>`).join('');

    measure();
    drawEdges();
  }

  async function reload() {
    config = await api.get('/api/config');
    draw();
  }

  // ── панель редактирования ────────────────────────────────────────────────

  async function openPanel(key) {
    document.querySelector('.panel')?.remove();
    // забираем свежий список файлов: могли загрузить в другой панели
    config = await api.get('/api/config');
    const step = config.steps.find(s => s.key === key);
    if (!step) return;
    selected = key;
    draw();

    const { value: delayValue, unit } = splitDuration(step.delay_seconds);
    const others = config.steps.filter(s => s.key !== step.key);

    const panel = el(`<aside class="panel">
      <button class="close small">✕</button>
      <h2>${h(step.title || step.key)}</h2>

      <div class="field"><label>Название</label>
        <input class="f-title" value="${h(step.title || '')}"${canEdit ? '' : ' disabled'}></div>

      <div class="row" style="gap:10px; align-items:flex-start">
        <div class="field" style="flex:1">
          <label>Пауза перед шагом</label>
          <div class="row">
            <input class="f-delay" type="number" min="0" value="${delayValue}"${canEdit ? '' : ' disabled'}>
            <select class="f-unit" style="width:84px"${canEdit ? '' : ' disabled'}>
              ${UNITS.map(([v, t]) => `<option value="${v}"${v === unit ? ' selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field" style="width:130px">
          <label>Шаг</label>
          <select class="f-enabled"${canEdit ? '' : ' disabled'}>
            <option value="1"${step.enabled ? ' selected' : ''}>включён</option>
            <option value="0"${step.enabled ? '' : ' selected'}>выключен</option>
          </select>
        </div>
      </div>

      <div class="field"><label>Кому</label>
        <select class="f-guard"${canEdit ? '' : ' disabled'}>
          ${Object.entries(GUARDS).map(([v, t]) => `<option value="${v}"${step.guard === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select></div>

      <div class="msg-slot"></div>

      <div class="field"><label>Заметка для команды (в Telegram не уходит)</label>
        <textarea class="f-note" rows="3"${canEdit ? '' : ' disabled'}>${h(step.note || '')}</textarea></div>

      <div class="field"><label>Дальше</label>
        <select class="f-next"${canEdit ? '' : ' disabled'}>
          <option value="">конец</option>
          ${others.map(s => `<option value="${h(s.key)}"${step.next_key === s.key ? ' selected' : ''}>${h(s.title || s.key)}</option>`).join('')}
        </select></div>

      <div class="foot">
        ${canEdit ? '<button class="primary f-save">Сохранить</button>' : ''}
        <button class="f-test">Тест себе</button>
        <span style="flex:1"></span>
        ${canEdit && !step.trigger ? '<button class="danger f-delete">Удалить</button>' : ''}
      </div>
    </aside>`);

    const editor = messageEditor({ record: step, media: config.media, canEdit });
    panel.querySelector('.msg-slot').replaceWith(editor.node);

    const close = () => { panel.remove(); selected = null; draw(); };
    panel.querySelector('.close').onclick = close;

    const saveButton = panel.querySelector('.f-save');
    if (saveButton) saveButton.onclick = async () => {
      if (editor.isUploading()) return toast('Файл ещё загружается', 'error');
      saveButton.disabled = true;
      try {
        const message = editor.value();
        await api.patch(`/api/steps/${encodeURIComponent(step.key)}`, {
          title: panel.querySelector('.f-title').value,
          delay_seconds: Number(panel.querySelector('.f-delay').value || 0) * Number(panel.querySelector('.f-unit').value),
          enabled: panel.querySelector('.f-enabled').value === '1',
          guard: panel.querySelector('.f-guard').value,
          next_key: panel.querySelector('.f-next').value || null,
          note: panel.querySelector('.f-note').value,
          text: message.text,
          media_key: message.media_key,
          buttons: message.buttons,
        });
        toast('Сохранено');
        await reload();
        close();
      } catch (err) {
        toast(err.message, 'error');
        saveButton.disabled = false;
      }
    };

    panel.querySelector('.f-test').onclick = async event => {
      if (!ctx.me.tg_id) return toast('Укажите свой Telegram id в разделе «Аккаунты»', 'error');
      event.target.disabled = true;
      try {
        const message = editor.value();
        const { broadcast } = await api.post('/api/broadcasts', {
          title: `Тест: ${step.title || step.key}`, ...message, segment: 'test',
        });
        await api.patch(`/api/broadcasts/${broadcast.id}`, { segment: 'test', test_tg_ids: [ctx.me.tg_id] });
        await api.post(`/api/broadcasts/${broadcast.id}/start`);
        toast('Отправил вам в Telegram');
      } catch (err) {
        toast(err.message, 'error');
      }
      event.target.disabled = false;
    };

    const deleteButton = panel.querySelector('.f-delete');
    if (deleteButton) deleteButton.onclick = async () => {
      if (!confirm('Удалить шаг? Соседние свяжутся между собой.')) return;
      try {
        await api.del(`/api/steps/${encodeURIComponent(step.key)}`);
        toast('Удалено');
        panel.remove();
        selected = null;
        await reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    document.body.append(panel);
  }

  // ── мышь: панорама, зум, перетаскивание блоков ───────────────────────────

  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const next = clamp(scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), 0.2, 2);
    tx = mx - (mx - tx) * (next / scale);
    ty = my - (my - ty) * (next / scale);
    scale = next;
    applyTransform();
  }, { passive: false });

  canvas.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.target.closest('.zoom')) return;
    const block = event.target.closest('.block');
    const startX = event.clientX;
    const startY = event.clientY;

    if (block && canEdit && !event.target.closest('.add')) {
      const step = config.steps.find(s => s.key === block.dataset.key);
      const place = places.get(step.key);
      const originX = place.x;
      const originY = place.y;
      let moved = false;

      const move = e => {
        const dx = (e.clientX - startX) / scale;
        const dy = (e.clientY - startY) / scale;
        if (Math.abs(dx) > 3 / scale || Math.abs(dy) > 3 / scale) moved = true;
        place.x = Math.round(originX + dx);
        place.y = Math.round(originY + dy);
        block.style.left = `${place.x}px`;
        block.style.top = `${place.y}px`;
        if (moved) drawEdgesOnly();
      };
      const up = async () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (!moved) return void openPanel(step.key);
        step.pos_x = place.x;
        step.pos_y = place.y;
        try {
          await api.patch(`/api/steps/${encodeURIComponent(step.key)}`, { pos_x: place.x, pos_y: place.y });
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      return;
    }

    if (block) return;

    const originTx = tx;
    const originTy = ty;
    canvas.classList.add('panning');
    const move = e => {
      tx = originTx + (e.clientX - startX);
      ty = originTy + (e.clientY - startY);
      applyTransform();
    };
    const up = () => {
      canvas.classList.remove('panning');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  const drawEdgesOnly = drawEdges;

  canvas.addEventListener('click', async event => {
    const add = event.target.closest('.add');
    if (!add) return;
    event.stopPropagation();
    const after = add.closest('.block').dataset.key;
    const title = prompt('Название шага', 'Новое сообщение');
    if (!title) return;
    try {
      const { step } = await api.post('/api/steps', { key: randomKey(), title, after_key: after });
      await reload();
      openPanel(step.key);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  canvas.querySelector('.zoom').addEventListener('click', event => {
    const action = event.target.closest('[data-zoom]')?.dataset.zoom;
    if (!action) return;
    if (action === 'fit') return fit();
    const next = clamp(scale * (action === '+' ? 1.2 : 1 / 1.2), 0.2, 2);
    const cx = canvas.clientWidth / 2;
    const cy = canvas.clientHeight / 2;
    tx = cx - (cx - tx) * (next / scale);
    ty = cy - (cy - ty) * (next / scale);
    scale = next;
    applyTransform();
  });

  await reload();
  requestAnimationFrame(fit);
  return canvas;
}
