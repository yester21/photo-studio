/* app.js — 포토 스튜디오 UI 배선.
   pipeline.js(순수 연산) + engine.js(상태·히스토리) + tools.js(2단계 도구)를 묻는다. */

import * as P from './pipeline.js?v=p3c';
import * as E from './engine.js?v=p3c';
import { objectsOverlay, invalidateObjects } from './objects.js?v=p3c';
import { createCurveEditor, histogram } from './curves.js?v=p3c';
import * as T from './tools.js?v=p3c';
import { initModes } from './modes.js?v=p3c';

const $ = (id) => document.getElementById(id);
const view = $('view');
const wrap = $('canvas-wrap');
const inner = $('canvas-inner');
const dropzone = $('dropzone');
const cropOverlay = $('crop-overlay');
const cropRect = $('crop-rect');
const cropBar = $('crop-bar');
const cropInfo = $('crop-info');
const hud = $('stage-hud');
const panel = $('panel');

const dpr = () => window.devicePixelRatio || 1;

/* ---------- 토스트 ---------- */
function toast(msg, ms = 2400) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toast-area').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, ms);
}

/* ---------- 색 보정·효과 슬라이더 ---------- */
const toneInputs = new Map(); // key → {input, out, def}
const committed = {}; // 마지막 히스토리 커밋값 — 같은 값 재커밋 방지

function buildSlider(def, mount, onInput) {
  const row = document.createElement('div');
  row.className = 'slider-row';
  const label = document.createElement('label');
  label.textContent = def.label;
  label.title = '더블클릭: 초기값';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = def.min; input.max = def.max; input.step = def.step || 1; input.value = def.def;
  const out = document.createElement('output');
  out.textContent = String(def.def) + (def.unit || '');
  label.addEventListener('dblclick', () => {
    input.value = def.def;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  input.addEventListener('input', () => {
    out.textContent = input.value + (def.unit || '');
    onInput(def.key, +input.value);
  });
  input.addEventListener('change', () => {
    if (E.isOpen() && committed[def.key] !== +input.value) {
      committed[def.key] = +input.value;
      E.pushHistory();
    }
  });
  row.append(label, input, out);
  mount.appendChild(row);
  toneInputs.set(def.key, { input, out, def });
}

function setSlider(key, v) {
  const t = toneInputs.get(key);
  if (!t) return;
  t.input.value = v;
  t.out.textContent = v + (t.def.unit || '');
}

for (const def of P.TONE_DEFS) buildSlider(def, $('tone-sliders'), onAdjInput);
for (const def of P.FX_DEFS) buildSlider(def, $('fx-sliders'), onAdjInput);

function onAdjInput(key, v) {
  if (!E.isOpen()) return;
  E.doc.adj[key] = v;
  clearPresetMark();
  scheduleRender();
}

/* ---------- 렌더 ---------- */
let raf = 0, rafFallback = 0, renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => {
    if (!renderQueued) return;
    renderQueued = false;
    if (raf) cancelAnimationFrame(raf);
    if (rafFallback) clearTimeout(rafFallback);
    raf = 0; rafFallback = 0;
    renderPreview();
  };
  // rAF가 스로틀링되는 가려진 창·백그라운드 탭에서도 렌더가 반드시 실행되도록 타이머 폴백
  raf = requestAnimationFrame(run);
  rafFallback = setTimeout(run, 80);
}

function viewMaxSize() {
  const px = Math.max(view.clientWidth || 0, view.clientHeight || 0) * dpr();
  return Math.max(200, Math.min(3400, Math.round(px)));
}

function renderPreview() {
  if (!E.isOpen()) return;
  if (comparing) {
    P.renderTo(view, E.doc.original, P.defaultAdj(), { maxSize: viewMaxSize() });
  } else {
    const objects = E.doc.objects.length
      ? objectsOverlay(E.doc.base.width, E.doc.base.height, E.doc.objectsVersion, E.doc.objects)
      : null;
    P.renderTo(view, E.doc.base, E.doc.adj, {
      maxSize: viewMaxSize(),
      straighten: E.doc.straighten,
      objects,
    });
  }
  hud.textContent = `${Math.round(zoom * 100)}% · ${E.doc.base.width} × ${E.doc.base.height}`;
  curveEditor.draw();
}

/* ---------- 줌 · 팬 ---------- */
let zoom = 1;
let fitZ = 1;

function availSize() {
  return {
    w: Math.max(40, wrap.clientWidth - 56),
    h: Math.max(40, wrap.clientHeight - 56),
  };
}

function computeFit() {
  if (!E.isOpen()) return 1;
  const { w, h } = availSize();
  return Math.min(w / E.doc.base.width, h / E.doc.base.height, 1);
}

function applyZoom(z) {
  if (!E.isOpen()) return;
  fitZ = computeFit();
  zoom = Math.min(Math.max(z, fitZ * 0.08), Math.max(8, fitZ));
  const w = E.doc.base.width * zoom;
  const h = E.doc.base.height * zoom;
  view.style.width = `${w}px`;
  view.style.height = `${h}px`;
  T.updateRegionUI();
  scheduleRender();
}

function fitView() {
  applyZoom(computeFit());
  wrap.scrollLeft = Math.max(0, (wrap.scrollWidth - wrap.clientWidth) / 2);
  wrap.scrollTop = Math.max(0, (wrap.scrollHeight - wrap.clientHeight) / 2);
}

wrap.addEventListener('wheel', (e) => {
  if (!E.isOpen() || crop.active) return;
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const rect = wrap.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const ix = (wrap.scrollLeft + cx - 28) / zoom;
  const iy = (wrap.scrollTop + e.clientY - rect.top - 28) / zoom;
  applyZoom(zoom * f);
  wrap.scrollLeft = Math.max(0, ix * zoom - cx + 28);
  wrap.scrollTop = Math.max(0, iy * zoom - (e.clientY - rect.top) + 28);
}, { passive: false });

let panning = false, panX = 0, panY = 0;
wrap.addEventListener('pointerdown', (e) => {
  if (!E.isOpen() || crop.active || e.button !== 0) return;
  if (T.getTool() !== 'select' || T.isBusy()) return; // 도구 제스처 중에는 팬 안 함
  if (e.target.closest('#crop-overlay, #crop-bar')) return;
  panning = true; panX = e.clientX; panY = e.clientY;
  wrap.classList.add('panning');
});
window.addEventListener('pointermove', (e) => {
  if (!panning) return;
  wrap.scrollLeft -= e.clientX - panX;
  wrap.scrollTop -= e.clientY - panY;
  panX = e.clientX; panY = e.clientY;
});
window.addEventListener('pointerup', () => {
  panning = false;
  wrap.classList.remove('panning');
});

/* ---------- 열기 ---------- */
async function openFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('이미지 파일이 아닙니다'); return; }
  try {
    const bmp = await createImageBitmap(file);
    const { downscaled } = E.openImage(bmp, file.name || '클립보드 이미지', file.size || 0);
    if (bmp.close) bmp.close();
    if (downscaled) toast('해상도가 매우 큰 이미지라 편집용으로 축소해 열었습니다');
    T.setTool('select');
    histCache.base = null;
  } catch (err) {
    toast('이미지를 열 수 없습니다');
  }
}

$('btn-open').addEventListener('click', () => $('file-open').click());
$('btn-open-dz').addEventListener('click', () => $('file-open').click());
$('file-open').addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  openFile(e.dataTransfer.files[0]);
});
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) openFile(item.getAsFile());
});

/* ---------- 자르기 ---------- */
const crop = { active: false, ratio: null, circle: false, rect: null };
const MIN_CROP = 24;

function ratioValue(r) {
  if (!r || r === 'free') return 0;
  if (r === 'orig') return E.doc.base.width / E.doc.base.height;
  const [a, b] = r.split(':').map(Number);
  return a / b;
}

function initialRect(ar) {
  const iw = E.doc.base.width, ih = E.doc.base.height;
  if (!ar) return { x: iw * 0.1, y: ih * 0.1, w: iw * 0.8, h: ih * 0.8 };
  let w = iw * 0.9, h = w / ar;
  if (h > ih * 0.9) { h = ih * 0.9; w = h * ar; }
  return { x: (iw - w) / 2, y: (ih - h) / 2, w, h };
}

function enterCrop(ratio) {
  if (!E.isOpen()) return;
  cancelCompare();
  crop.active = true;
  crop.ratio = ratio;
  if (crop.circle && ratio === 'free') {
    // 원형 유지 — 기존 rect 사용
  } else {
    crop.rect = initialRect(ratioValue(ratio));
  }
  cropOverlay.hidden = false;
  cropBar.hidden = false;
  wrap.classList.add('cropmode');
  markRatioChip(ratio);
  updateCropUI();
  renderPreview();
}

function exitCrop() {
  crop.active = false;
  crop.circle = false;
  cropOverlay.hidden = true;
  cropBar.hidden = true;
  wrap.classList.remove('cropmode');
  markRatioChip(null);
  $('chip-circle').classList.remove('active');
  renderPreview();
}

function markRatioChip(ratio) {
  for (const b of $('crop-ratios').querySelectorAll('.chip[data-ratio]')) {
    b.classList.toggle('active', b.dataset.ratio === ratio);
  }
}

function updateCropUI() {
  if (!crop.active) return;
  const r = crop.rect;
  cropRect.style.left = `${r.x * zoom}px`;
  cropRect.style.top = `${r.y * zoom}px`;
  cropRect.style.width = `${r.w * zoom}px`;
  cropRect.style.height = `${r.h * zoom}px`;
  cropOverlay.classList.toggle('circle', crop.circle);
  cropInfo.textContent = `${Math.round(r.w)} × ${Math.round(r.h)} px${crop.circle ? ' · 원형' : ''}`;
}

function clampRect(r) {
  const iw = E.doc.base.width, ih = E.doc.base.height;
  r.w = Math.max(MIN_CROP, Math.min(r.w, iw));
  r.h = Math.max(MIN_CROP, Math.min(r.h, ih));
  r.x = Math.max(0, Math.min(r.x, iw - r.w));
  r.y = Math.max(0, Math.min(r.y, ih - r.h));
  return r;
}

let cropDrag = null;
cropRect.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.target.closest('.ch')?.dataset.h || 'move';
  const r = crop.rect;
  cropDrag = {
    handle,
    sx: e.clientX, sy: e.clientY,
    orig: { ...r },
  };
});

window.addEventListener('pointermove', (e) => {
  if (!cropDrag || !crop.active) return;
  const dx = (e.clientX - cropDrag.sx) / zoom;
  const dy = (e.clientY - cropDrag.sy) / zoom;
  const iw = E.doc.base.width, ih = E.doc.base.height;
  const o = cropDrag.orig;
  const ar = ratioValue(crop.ratio);
  const r = { ...o };
  const H = cropDrag.handle;

  if (H === 'move') {
    r.x = Math.max(0, Math.min(o.x + dx, iw - r.w));
    r.y = Math.max(0, Math.min(o.y + dy, ih - r.h));
  } else {
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (H.includes('w')) x1 = Math.max(0, Math.min(o.x + dx, x2 - MIN_CROP));
    if (H.includes('e')) x2 = Math.min(iw, Math.max(o.x + o.w + dx, x1 + MIN_CROP));
    if (H.includes('n')) y1 = Math.max(0, Math.min(o.y + dy, y2 - MIN_CROP));
    if (H.includes('s')) y2 = Math.min(ih, Math.max(o.y + o.h + dy, y1 + MIN_CROP));
    r.x = x1; r.y = y1; r.w = x2 - x1; r.h = y2 - y1;

    if (ar > 0) {
      // 비율 고정: 주축에서 크기를 정하고, 이미지 경계에 맞을 때까지 상호 보정
      const horiz = H.includes('e') || H.includes('w');
      const vert = H.includes('n') || H.includes('s');
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      let w2, h2;
      if (!horiz && vert) { h2 = r.h; w2 = h2 * ar; }
      else { w2 = r.w; h2 = w2 / ar; }
      for (let k = 0; k < 2; k++) {
        if (w2 > iw) { w2 = iw; h2 = w2 / ar; }
        if (h2 > ih) { h2 = ih; w2 = h2 * ar; }
        if (vert && H.includes('n') && h2 > y2) { h2 = y2; w2 = h2 * ar; }
        if (vert && !H.includes('n') && h2 > ih - y1) { h2 = ih - y1; w2 = h2 * ar; }
        if (!vert && h2 / 2 > Math.min(cy, ih - cy)) { h2 = 2 * Math.min(cy, ih - cy); w2 = h2 * ar; }
        if (horiz && H.includes('w') && w2 > x2) { w2 = x2; h2 = w2 / ar; }
        if (horiz && !H.includes('w') && w2 > iw - x1) { w2 = iw - x1; h2 = w2 / ar; }
        if (!horiz && w2 / 2 > Math.min(cx, iw - cx)) { w2 = 2 * Math.min(cx, iw - cx); h2 = w2 / ar; }
      }
      w2 = Math.max(MIN_CROP, w2); h2 = Math.max(MIN_CROP, h2);
      if (vert) r.y = H.includes('n') ? y2 - h2 : y1; else r.y = cy - h2 / 2;
      if (horiz) r.x = H.includes('w') ? x2 - w2 : x1; else r.x = cx - w2 / 2;
      r.w = w2; r.h = h2;
    }
  }
  crop.rect = clampRect(r);
  updateCropUI();
});

window.addEventListener('pointerup', () => { cropDrag = null; });

$('crop-ratios').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-ratio]');
  if (!chip) return;
  $('chip-circle').classList.remove('active');
  crop.circle = false;
  enterCrop(chip.dataset.ratio);
});

$('chip-circle').addEventListener('click', () => {
  if (crop.active && crop.circle) { exitCrop(); return; }
  crop.circle = true;
  $('chip-circle').classList.add('active');
  if (!crop.active) {
    crop.active = true;
    crop.ratio = 'free';
    crop.rect = initialRect(1);
    cropOverlay.hidden = false;
    cropBar.hidden = false;
    wrap.classList.add('cropmode');
    markRatioChip(null);
  }
  updateCropUI();
});

$('btn-crop-apply').addEventListener('click', () => {
  if (!crop.active) return;
  const r = {
    x: Math.round(crop.rect.x), y: Math.round(crop.rect.y),
    w: Math.round(crop.rect.w), h: Math.round(crop.rect.h),
  };
  if (r.w < 2 || r.h < 2) { toast('자를 영역이 너무 작습니다'); return; }
  const circle = crop.circle;
  const hadOverlays = E.doc.objects.length > 0 || (E.doc.adj.regions && E.doc.adj.regions.length > 0);
  E.applyGeometry((b) => P.cropBase(b, r, circle));
  exitCrop();
  if (circle && $('sel-format').value === 'image/jpeg') toast('원형 자르기는 PNG 저장 시 배경이 투명하게 유지됩니다');
  if (hadOverlays) toast('자르기: 그리기·부분 보정이 이미지에 반영되었습니다');
});

$('btn-crop-cancel').addEventListener('click', exitCrop);

/* ---------- 회전 · 기울기 · 리사이즈 · 여백 ---------- */
$('btn-rot-left').addEventListener('click', () => E.applyGeometry((b) => P.rotate90(b, 'ccw')));
$('btn-rot-right').addEventListener('click', () => E.applyGeometry((b) => P.rotate90(b, 'cw')));
$('btn-flip-h').addEventListener('click', () => E.applyGeometry((b) => P.flipBase(b, 'h')));
$('btn-flip-v').addEventListener('click', () => E.applyGeometry((b) => P.flipBase(b, 'v')));

const slStraighten = $('sl-straighten');
slStraighten.addEventListener('input', () => {
  if (!E.isOpen()) return;
  E.doc.straighten = +slStraighten.value;
  slStraighten.nextElementSibling.textContent = (+slStraighten.value).toFixed(1) + '°';
  const on = E.doc.straighten !== 0;
  $('btn-straighten-apply').disabled = !on;
  $('btn-straighten-reset').disabled = !on;
  scheduleRender();
});
$('btn-straighten-apply').addEventListener('click', () => {
  if (!E.doc.straighten) return;
  const deg = E.doc.straighten;
  E.doc.straighten = 0; // 베이크했으니 프리뷰 각도는 즉시 해제 (syncAll이 슬라이더·버튼 동기화)
  E.applyGeometry((b) => P.straightenCanvas(b, deg));
  toast('기울기 보정을 적용했습니다');
});
$('btn-straighten-reset').addEventListener('click', () => {
  E.doc.straighten = 0;
  slStraighten.value = 0;
  slStraighten.nextElementSibling.textContent = '0.0°';
  $('btn-straighten-apply').disabled = true;
  $('btn-straighten-reset').disabled = true;
  scheduleRender();
});

const inW = $('in-resize-w'), inH = $('in-resize-h');
let ratioLock = true;
$('ratio-lock').addEventListener('click', () => {
  ratioLock = !ratioLock;
  $('ratio-lock').classList.toggle('on', ratioLock);
});
inW.addEventListener('input', () => {
  if (ratioLock && E.isOpen() && inW.value > 0) {
    inH.value = Math.round((E.doc.base.height / E.doc.base.width) * +inW.value);
  }
});
inH.addEventListener('input', () => {
  if (ratioLock && E.isOpen() && inH.value > 0) {
    inW.value = Math.round((E.doc.base.width / E.doc.base.height) * +inH.value);
  }
});
$('btn-resize-apply').addEventListener('click', () => {
  if (!E.isOpen()) return;
  const w = Math.round(+inW.value), h = Math.round(+inH.value);
  if (!w || !h || w < 1 || h < 1) { toast('크기를 확인해 주세요'); return; }
  if (w === E.doc.base.width && h === E.doc.base.height) return;
  if (w * h > 64e6) { toast('너무 큽니다 (최대 약 64MP)'); return; }
  E.applyGeometry((b) => P.resizeBase(b, w, h));
  toast(`${w} × ${h} px로 조정했습니다`);
});

$('btn-pad-apply').addEventListener('click', () => {
  if (!E.isOpen()) return;
  const pads = [+$('in-pad-t').value || 0, +$('in-pad-r').value || 0, +$('in-pad-b').value || 0, +$('in-pad-l').value || 0];
  if (!pads.some((v) => v > 0)) { toast('여백 값을 입력해 주세요'); return; }
  const transparent = $('in-pad-transparent').checked;
  if (transparent && pads.some((v) => v > 1200)) { toast('여백이 너무 큽니다'); return; }
  const color = transparent ? null : $('in-pad-color').value;
  E.applyGeometry((b) => P.padBase(b, pads, color));
});

/* ---------- 자동 보정 · 화이트밸런스 · 초기화 ---------- */
function channelMeans(base) {
  const tmp = document.createElement('canvas');
  const s = Math.min(1, 96 / Math.max(base.width, base.height));
  tmp.width = Math.max(1, Math.round(base.width * s));
  tmp.height = Math.max(1, Math.round(base.height * s));
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(base, 0, 0, tmp.width, tmp.height);
  const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
  let r = 0, g = 0, b = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  return [r / n, g / n, b / n];
}

$('btn-auto-level').addEventListener('click', () => {
  if (!E.autoLevels(true)) toast('이미 충분한 톤 범위입니다');
});
$('btn-auto-contrast').addEventListener('click', () => {
  if (!E.autoLevels(false)) toast('이미 충분한 톤 범위입니다');
});
$('btn-auto-wb').addEventListener('click', () => {
  if (!E.isOpen()) return;
  if (E.doc.adj.wb) {
    E.doc.adj.wb = null;
    E.pushHistory();
    return;
  }
  const [mr, mg, mb] = channelMeans(E.doc.base);
  if (mr < 8 && mg < 8 && mb < 8) { toast('너무 어두워 보정할 수 없습니다'); return; }
  // 회색 세계 가정: 채널 평균을 맞추는 게인 (초과 조임 방지로 80%만 적용)
  const gr = 1 + ((mg / mr) - 1) * 0.8;
  const gb = 1 + ((mg / mb) - 1) * 0.8;
  E.doc.adj.wb = { r: gr, g: 1, b: gb };
  E.pushHistory();
  toast('화이트밸런스를 보정했습니다 (다시 누르면 해제)');
});
$('btn-tone-reset').addEventListener('click', () => {
  if (!E.isOpen()) return;
  const keep = {
    mode: E.doc.adj.mode,
    curves: E.doc.adj.curves,
    levels: E.doc.adj.levels,
    regions: E.doc.adj.regions,
  };
  E.doc.adj = { ...P.defaultAdj(), ...keep, wb: null };
  E.pushHistory();
});

/* ---------- 커브 · 레벨 ---------- */
const histCache = { base: null, data: null };
function getHist() {
  if (!E.isOpen()) return null;
  if (histCache.base !== E.doc.base) {
    histCache.data = histogram(E.doc.base);
    histCache.base = E.doc.base;
  }
  return histCache.data;
}

let curveCh = 'm';
const curveEditor = createCurveEditor($('curve-editor'), {
  get: () => {
    const c = E.doc.adj?.curves?.[curveCh];
    return c ? c.map((p) => ({ ...p })) : null;
  },
  enabled: () => E.isOpen() && !crop.active,
  histogram: getHist,
  live: (pts) => {
    if (!E.isOpen()) return;
    E.doc.adj.curves[curveCh] = pts;
    scheduleRender();
  },
  commit: (pts) => {
    if (!E.isOpen()) return;
    E.doc.adj.curves[curveCh] = pts;
    E.pushHistory();
  },
});

$('curve-chs').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  curveCh = chip.dataset.ch;
  for (const b of $('curve-chs').querySelectorAll('.chip')) b.classList.toggle('active', b === chip);
  curveEditor.sync();
  curveEditor.draw();
});

function bindLevelSlider(id, key, fmt) {
  const el = $(id);
  const out = el.nextElementSibling;
  el.addEventListener('input', () => {
    if (!E.isOpen()) return;
    E.doc.adj.levels[key] = +el.value;
    out.textContent = fmt(+el.value);
    scheduleRender();
  });
  el.addEventListener('change', () => {
    if (E.isOpen() && committed[`lv-${key}`] !== +el.value) {
      committed[`lv-${key}`] = +el.value;
      E.pushHistory();
    }
  });
  return { el, out, fmt };
}
const lvB = bindLevelSlider('sl-lv-b', 'b', (v) => String(v));
const lvW = bindLevelSlider('sl-lv-w', 'w', (v) => String(v));
const lvM = bindLevelSlider('sl-lv-mid', 'mid', (v) => v.toFixed(2));

$('btn-curves-reset').addEventListener('click', () => {
  if (!E.isOpen()) return;
  E.doc.adj.curves = { m: null, r: null, g: null, b: null };
  E.doc.adj.levels = { b: 0, w: 255, mid: 1 };
  E.pushHistory();
});

/* ---------- 모드 · 프리셋 ---------- */
$('mode-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || !E.isOpen()) return;
  E.doc.adj.mode = chip.dataset.mode;
  E.pushHistory();
});

let presetMark = null;
function clearPresetMark() {
  if (presetMark) { presetMark.classList.remove('active'); presetMark = null; }
}
$('preset-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || !E.isOpen()) return;
  const keep = {
    mode: E.doc.adj.mode,
    curves: E.doc.adj.curves,
    levels: E.doc.adj.levels,
    regions: E.doc.adj.regions,
    wb: E.doc.adj.wb,
  };
  E.doc.adj = { ...P.defaultAdj(), ...keep, ...P.PRESETS[chip.dataset.preset] };
  clearPresetMark();
  presetMark = chip;
  chip.classList.add('active');
  E.pushHistory();
});

/* ---------- 원본 보기(비교) ---------- */
let comparing = false;
function cancelCompare() {
  if (!comparing) return;
  comparing = false;
  renderPreview();
}
$('btn-compare').addEventListener('pointerdown', () => {
  if (!E.isOpen() || crop.active) return;
  comparing = true;
  renderPreview();
});
window.addEventListener('pointerup', cancelCompare);
$('btn-compare').addEventListener('pointerleave', cancelCompare);

/* ---------- 저장 ---------- */
function saveNow() {
  if (!E.isOpen()) return;
  const format = $('sel-format').value;
  E.save(format, +$('sl-quality').value).then((blob) => {
    if (blob) toast(`저장했습니다 · ${(blob.size / 1024).toFixed(0)} KB`);
  });
}
$('btn-save').addEventListener('click', saveNow);
$('btn-save-panel').addEventListener('click', saveNow);
$('sel-format').addEventListener('change', () => {
  $('row-quality').style.display = $('sel-format').value === 'image/png' ? 'none' : '';
});
const slQ = $('sl-quality');
slQ.addEventListener('input', () => { slQ.nextElementSibling.textContent = slQ.value; });

/* ---------- 되돌리기 · 줌 버튼 · 키보드 ---------- */
$('btn-undo').addEventListener('click', () => E.undo());
$('btn-redo').addEventListener('click', () => E.redo());
$('btn-fit').addEventListener('click', fitView);
$('btn-zoom-in').addEventListener('click', () => applyZoom(zoom * 1.25));
$('btn-zoom-out').addEventListener('click', () => applyZoom(zoom / 1.25));

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const tag = e.target.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? E.redo() : E.undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); E.redo(); }
  else if (mod && e.key === '0') { e.preventDefault(); fitView(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (T.deleteSelected()) e.preventDefault(); }
  else if (e.key === 'Escape') { T.setTool('select'); }
  else if (!mod) {
    const map = { v: 'select', b: 'brush', e: 'erase', u: 'shape', t: 'text', g: 'region', h: 'heal', m: 'mosaic' };
    const tool = map[e.key.toLowerCase()];
    if (tool && E.isOpen()) T.setTool(tool);
  }
});

window.addEventListener('resize', () => {
  if (E.isOpen() && Math.abs(zoom - computeFit()) < 1e-6) fitView();
});

/* ---------- 툴 레일 · 도구 옵션 ---------- */
const toolBtns = [...document.querySelectorAll('#tool-rail .tbtn')];
const toolBlockEls = [...document.querySelectorAll('.tool-block')];
const TOOL_LABELS = Object.fromEntries(T.TOOL_DEFS.map((d) => [d.id, d.label]));

function refreshToolUI() {
  const id = T.getTool();
  for (const b of toolBtns) b.classList.toggle('active', b.dataset.tool === id);
  $('tool-name').textContent = TOOL_LABELS[id] || id;
  const hasSel = T.selection.kind !== null;
  $('sec-tool').hidden = !(E.isOpen() && (id !== 'select' || hasSel));
  for (const blk of toolBlockEls) {
    blk.style.display = blk.dataset.tool === id ? '' : 'none';
  }
  $('btn-tool-delete').hidden = !hasSel;
}

function selectedObject() {
  if (T.selection.kind !== 'object') return null;
  return E.doc.objects[T.selection.index] || null;
}
function selectedRegion() {
  if (T.selection.kind !== 'region') return null;
  return (E.doc.adj.regions || [])[T.selection.index] || null;
}
function selText() {
  const o = selectedObject();
  return o && o.type === 'text' ? o : null;
}
function selShape() {
  const o = selectedObject();
  return o && o.type === 'shape' ? o : null;
}
function commitIfSelected() {
  if (selectedObject() || selectedRegion()) E.pushHistory();
}

toolBtns.forEach((b) => b.addEventListener('click', () => T.setTool(b.dataset.tool)));
$('btn-tool-delete').addEventListener('click', () => T.deleteSelected());

/* 도구 옵션 바인딩: 선택한 개체가 있으면 그 개체에, 없으면 다음 입력용 기본값(toolOpts)에 적용 */
/* 단순 옵션(개체 대상 아님): 브러시·클론 등 다음 입력 기본값 */
function bindOpt(id, key, { int = true } = {}) {
  const el = $(id);
  const out = el.nextElementSibling;
  el.addEventListener('input', () => {
    T.toolOpts[key] = +el.value;
    if (out) out.textContent = int ? String(el.value) : el.value;
  });
}
function bindOptColor(id, key) {
  $(id).addEventListener('input', () => { T.toolOpts[key] = $(id).value; });
}

/* 개체 대상 필드: 선택 개체 우선, 없으면 toolOpts */
function bindObjectField(el, key, { isNum = false, isBool = false } = {}) {
  el.addEventListener('input', () => {
    const v = isBool ? el.checked : isNum ? +el.value : el.value;
    const o = selText() || selShape();
    if (o) {
      if (key === 'fill') o.fill = el.checked ? T.toolOpts.shapeFillColor : null;
      else if (key === 'fillColor') {
        T.toolOpts.shapeFillColor = v;
        if (o.fill) o.fill = v;
      } else o[key] = v;
      E.touchObjects();
      invalidateObjects();
      scheduleRender();
    } else {
      T.toolOpts[key] = v;
    }
    const out = el.nextElementSibling;
    if (out && el.type === 'range') out.textContent = String(el.value);
  });
  el.addEventListener('change', commitIfSelected);
}

/* 텍스트 */
bindObjectField($('op-text-text'), 'text');
bindObjectField($('op-text-font'), 'font');
bindObjectField($('op-text-size'), 'size', { isNum: true });
bindObjectField($('op-text-bold'), 'bold', { isBool: true });
bindObjectField($('op-text-color'), 'color');
bindObjectField($('op-text-strokew'), 'strokeWidth', { isNum: true });
bindObjectField($('op-text-strokecolor'), 'strokeColor');
bindObjectField($('op-text-shadow'), 'shadow', { isBool: true });

/* 브러시/지우개 */
bindOptColor('op-brush-color', 'brushColor');
bindOpt('op-brush-size', 'brushSize');
bindOpt('op-brush-opacity', 'brushOpacity', { int: false });
bindOpt('op-erase-size', 'eraseSize');

/* 도형 */
$('op-shape-kinds').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  for (const b of $('op-shape-kinds').querySelectorAll('.chip')) b.classList.toggle('active', b === chip);
  T.toolOpts.shapeKind = chip.dataset.shape;
  const o = selShape();
  if (o) { o.shape = chip.dataset.shape; E.touchObjects(); invalidateObjects(); scheduleRender(); commitIfSelected(); }
});
bindObjectField($('op-shape-color'), 'color');
bindObjectField($('op-shape-width'), 'width', { isNum: true });
$('op-shape-fill-on').addEventListener('change', () => {
  T.toolOpts.shapeFillOn = $('op-shape-fill-on').checked;
  const o = selShape();
  if (o) {
    o.fill = T.toolOpts.shapeFillOn ? T.toolOpts.shapeFillColor : null;
    E.touchObjects(); invalidateObjects(); scheduleRender(); E.pushHistory();
  }
});
$('op-shape-fill-color').addEventListener('input', () => {
  T.toolOpts.shapeFillColor = $('op-shape-fill-color').value;
  const o = selShape();
  if (o && o.fill) { o.fill = T.toolOpts.shapeFillColor; E.touchObjects(); invalidateObjects(); scheduleRender(); }
});
$('op-shape-fill-color').addEventListener('change', commitIfSelected);

/* 클론/힐링/적목/모자이크 */
bindOpt('op-clone-size', 'cloneSize');
bindOpt('op-heal-size', 'healSize');
bindOpt('op-redeye-size', 'redeyeSize');
bindOpt('op-mosaic-size', 'mosaicSize');
bindOpt('op-mosaic-block', 'mosaicBlock');

/* region/oof: 기본값 + 선택한 region 즉시 반영 */
bindOpt('op-region-brightness', 'regionBrightness');
bindOpt('op-region-exposure', 'regionExposure');
bindOpt('op-region-saturation', 'regionSaturation');
bindOpt('op-region-contrast', 'regionContrast');
bindOpt('op-region-feather', 'regionFeather', { int: false });
bindOpt('op-oof-blur', 'oofBlur');
bindOpt('op-oof-feather', 'oofFeather', { int: false });

const REGION_PARAM_MAP = [
  ['op-region-brightness', 'brightness'],
  ['op-region-exposure', 'exposure'],
  ['op-region-saturation', 'saturation'],
  ['op-region-contrast', 'contrast'],
];
for (const [id, paramKey] of REGION_PARAM_MAP) {
  $(id).addEventListener('input', () => {
    const rg = selectedRegion();
    if (rg && rg.type === 'adjust') { rg.params[paramKey] = +$(id).value; scheduleRender(); }
  });
  $(id).addEventListener('change', commitIfSelected);
}
$('op-region-feather').addEventListener('input', () => {
  const rg = selectedRegion();
  if (rg) { rg.feather = 1 - (+$('op-region-feather').value / 100) * 0.95; scheduleRender(); }
});
$('op-region-feather').addEventListener('change', commitIfSelected);
$('op-oof-blur').addEventListener('input', () => {
  const rg = selectedRegion();
  if (rg && rg.type === 'blur') { rg.blurPx = +$('op-oof-blur').value; scheduleRender(); }
});
$('op-oof-blur').addEventListener('change', commitIfSelected);
$('op-oof-feather').addEventListener('input', () => {
  const rg = selectedRegion();
  if (rg && rg.type === 'blur') { rg.feather = 1 - (+$('op-oof-feather').value / 100) * 0.95; scheduleRender(); }
});
$('op-oof-feather').addEventListener('change', commitIfSelected);

/* 선택 바뀔 때 패널 값 반영 */
function loadSelectionToPanel() {
  const o = selText();
  if (o) {
    $('op-text-text').value = o.text;
    $('op-text-font').value = o.font;
    $('op-text-size').value = o.size;
    $('op-text-size').nextElementSibling.textContent = String(o.size);
    $('op-text-bold').checked = !!o.bold;
    $('op-text-color').value = o.color;
    $('op-text-strokew').value = o.strokeWidth;
    $('op-text-strokew').nextElementSibling.textContent = String(o.strokeWidth);
    $('op-text-strokecolor').value = o.strokeColor;
    $('op-text-shadow').checked = !!o.shadow;
    return;
  }
  const rg = selectedRegion();
  if (rg && rg.type === 'adjust') {
    $('op-region-brightness').value = rg.params.brightness || 0;
    $('op-region-exposure').value = rg.params.exposure || 0;
    $('op-region-saturation').value = rg.params.saturation || 0;
    $('op-region-contrast').value = rg.params.contrast || 0;
    $('op-region-feather').value = Math.round(((1 - rg.feather) / 0.95) * 100);
  }
  if (rg && rg.type === 'blur') {
    $('op-oof-blur').value = rg.blurPx || 12;
    $('op-oof-feather').value = Math.round(((1 - rg.feather) / 0.95) * 100);
  }
}

T.initTools({
  E,
  P,
  view,
  inner,
  zoom: () => zoom,
  cropActive: () => crop.active,
  compareActive: () => comparing,
  render: renderPreview,
  toast,
  toolChanged: refreshToolUI,
  selectionChanged: () => { refreshToolUI(); loadSelectionToPanel(); },
});

/* ---------- 상태 동기화 ---------- */
function fmtSize(n) {
  if (!n) return '';
  return n > 1024 * 1024 ? ` · ${(n / 1048576).toFixed(1)}MB` : ` · ${(n / 1024).toFixed(0)}KB`;
}

let lastW = 0, lastH = 0;

function syncAll() {
  const open = E.isOpen();
  for (const id of ['btn-undo', 'btn-redo', 'btn-compare', 'btn-fit', 'btn-zoom-in', 'btn-zoom-out', 'btn-save', 'btn-save-panel']) {
    $(id).disabled = !open;
  }
  $('btn-undo').disabled = !E.canUndo();
  $('btn-redo').disabled = !E.canRedo();
  for (const b of toolBtns) b.disabled = !open;
  panel.classList.toggle('disabled', !open);
  dropzone.hidden = open;
  $('canvas-wrap').hidden = !open;
  $('stage-hud').hidden = !open;
  $('file-info').textContent = open
    ? `${E.doc.name} · ${E.doc.base.width} × ${E.doc.base.height}${fmtSize(E.doc.fileSize)}`
    : '열린 이미지 없음';
  if (open) {
    if (E.doc.base.width !== lastW || E.doc.base.height !== lastH) {
      inW.value = E.doc.base.width;
      inH.value = E.doc.base.height;
    }
    for (const d of [...P.TONE_DEFS, ...P.FX_DEFS]) {
      setSlider(d.key, E.doc.adj[d.key]);
      committed[d.key] = E.doc.adj[d.key];
    }
    for (const b of $('mode-chips').querySelectorAll('.chip')) {
      b.classList.toggle('active', b.dataset.mode === E.doc.adj.mode);
    }
    $('btn-auto-wb').classList.toggle('on', !!E.doc.adj.wb);
    // 커브·레벨
    const lv = E.doc.adj.levels;
    for (const [ctl, v] of [[lvB, lv.b], [lvW, lv.w], [lvM, lv.mid]]) {
      ctl.el.value = v;
      ctl.out.textContent = ctl.fmt(v);
      committed[`lv-${ctl === lvB ? 'b' : ctl === lvW ? 'w' : 'mid'}`] = v;
    }
    curveEditor.sync();
    // 선택 정리 (undo 등으로 사라진 개체/region)
    if (T.selection.kind === 'object' && T.selection.index >= E.doc.objects.length) T.select(null, -1);
    if (T.selection.kind === 'region' && T.selection.index >= (E.doc.adj.regions || []).length) T.select(null, -1);
    if (T.selection.kind !== null) loadSelectionToPanel();
    slStraighten.value = E.doc.straighten;
    slStraighten.nextElementSibling.textContent = E.doc.straighten.toFixed(1) + '°';
    const so = E.doc.straighten !== 0;
    $('btn-straighten-apply').disabled = !so;
    $('btn-straighten-reset').disabled = !so;
  }
  if (open && (E.doc.base.width !== lastW || E.doc.base.height !== lastH)) {
    lastW = E.doc.base.width; lastH = E.doc.base.height;
    fitView();
  }
  T.updateRegionUI();
  refreshToolUI();
  renderPreview();
}

E.onChange(syncAll);

/* ---------- 디버그/테스트 훅 ---------- */
window.__ps = {
  E, P, T, openFile, fitView, applyZoom, renderPreview,
  get zoom() { return zoom; },
  get cropState() { return crop; },
};

/* 초기 상태 */
refreshToolUI();
syncAll();

/* 3단계 모드 탭 초기화 */
initModes();
