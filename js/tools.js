/* tools.js — 2단계 편집 도구의 포인터 상태 머신.
   벡터 도구(브러시·지우개·도형·텍스트)는 doc.objects에 개체를 쌓고,
   부분 보정/아웃포커스는 adj.regions에 타원 영역을 쌓으며(비파괴),
   래스터 도구(클론·힐링·적목·모자이크)는 제스처 동안 base 사본에 직접 그리고
   pointerup에 히스토리 1스텝으로 커밋한다. */

import * as O from './objects.js?v=p3c';
import { invalidateObjects } from './objects.js?v=p3c';

export const toolOpts = {
  brushColor: '#ff3b30', brushOpacity: 1,
  shapeKind: 'line', shapeColor: '#ff3b30', shapeWidth: 8, shapeFillOn: false, shapeFillColor: '#0071e3',
  textText: '텍스트 입력',
  textFont: '"Malgun Gothic", "맑은 고딕", sans-serif',
  textSize: 72, textBold: true, textColor: '#ffffff',
  textStrokeW: 0, textStrokeColor: '#000000', textShadow: true,
  cloneSize: 40,
  healSize: 28,
  redeyeSize: 24,
  mosaicSize: 34, mosaicBlock: 14,
  brushSize: 18, eraseSize: 24,
  regionBrightness: 35, regionExposure: 0, regionSaturation: 12, regionContrast: 0, regionFeather: 0.5,
  oofBlur: 12, oofFeather: 0.5,
};

export const TOOL_DEFS = [
  { id: 'select', label: '선택·이동' },
  { id: 'region', label: '부분 보정' },
  { id: 'oof', label: '아웃포커스' },
  { id: 'brush', label: '브러시' },
  { id: 'erase', label: '지우개' },
  { id: 'shape', label: '도형' },
  { id: 'text', label: '텍스트' },
  { id: 'clone', label: '클론 스탬프' },
  { id: 'heal', label: '잡티 제거' },
  { id: 'redeye', label: '적목 제거' },
  { id: 'mosaic', label: '모자이크' },
];

let deps = null;
let active = 'select';
let cursorEl = null, regionEl = null;
const PAD = 28; // canvas-inner의 패딩(뷰 좌표 → inner 좌표 보정)

/* 선택 상태: 그리기 개체 인덱스 또는 활성 region 인덱스 */
export const selection = { kind: null, index: -1 };

export function initTools(d) {
  deps = d;
  const { view } = d;

  cursorEl = document.createElement('div');
  cursorEl.id = 'brush-cursor';
  cursorEl.hidden = true;
  d.inner.appendChild(cursorEl);

  regionEl = document.createElement('div');
  regionEl.id = 'region-overlay';
  regionEl.hidden = true;
  regionEl.innerHTML = ['nw', 'ne', 'sw', 'se'].map((h) => `<div class="rh rh-${h}" data-h="${h}"></div>`).join('');
  d.inner.appendChild(regionEl);
  // 핸들은 view 위에 덮여 있어 view의 pointerdown을 대신 받는다
  regionEl.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.rh');
    if (!h || selection.kind !== 'region' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rg = deps.E.doc.adj.regions[selection.index];
    if (!rg) return;
    g = { kind: 'resizeRegion', index: selection.index, handle: h.dataset.h, orig: { ...rg } };
  });

  view.addEventListener('pointerdown', onDown);
  view.addEventListener('pointermove', onHover);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

export function getTool() { return active; }
export function isBusy() { return !!g; }

export function setTool(id, keepSelection = false) {
  active = id;
  if (!keepSelection) select(null, -1);
  updateCursor();
  updateRegionUI();
  if (deps) deps.toolChanged(id);
}

export function select(kind, index) {
  selection.kind = kind;
  selection.index = index;
  deps.selectionChanged();
  updateRegionUI();
}

export function deleteSelected() {
  if (selection.kind === 'object' && selection.index >= 0) {
    deps.E.doc.objects.splice(selection.index, 1);
    deps.E.touchObjects();
    invalidateObjects();
    deps.E.pushHistory();
    select(null, -1);
    deps.render();
    return true;
  }
  if (selection.kind === 'region' && selection.index >= 0) {
    deps.E.doc.adj.regions.splice(selection.index, 1);
    deps.E.pushHistory();
    select(null, -1);
    deps.render();
    return true;
  }
  return false;
}

/* ---------- 커서 · region 오버레이 ---------- */

const RASTER_TOOLS = ['brush', 'erase', 'clone', 'heal', 'redeye', 'mosaic'];

function brushRadius() {
  const t = active;
  if (t === 'clone') return toolOpts.cloneSize / 2;
  if (t === 'heal') return toolOpts.healSize / 2;
  if (t === 'redeye') return toolOpts.redeyeSize / 2;
  if (t === 'mosaic') return toolOpts.mosaicSize / 2;
  if (t === 'erase') return toolOpts.eraseSize / 2;
  if (t === 'brush') return toolOpts.brushSize / 2;
  return 0;
}

function updateCursor() {
  if (!cursorEl) return;
  const show = RASTER_TOOLS.includes(active);
  cursorEl.hidden = !show;
  if (show) {
    const r = brushRadius();
    cursorEl.style.width = cursorEl.style.height = `${r * 2}px`;
  }
}

export function updateCursorPos(e) {
  if (cursorEl.hidden) return;
  // fixed 포지셔닝 — 뷰포트 좌표 그대로 쓴다(스크롤 영역 오염 없음)
  cursorEl.style.left = `${e.clientX}px`;
  cursorEl.style.top = `${e.clientY}px`;
  cursorEl.hidden = false;
}

function onHover(e) {
  if (!RASTER_TOOLS.includes(active) || !deps.E.isOpen()) { if (cursorEl) cursorEl.hidden = true; return; }
  updateCursorPos(e);
}

/* 활성 region 오버레이(타원 테두리 + 4방향 핸들) */
export function updateRegionUI() {
  if (!regionEl) return;
  const rgs = deps.E.doc.adj && deps.E.doc.adj.regions;
  const show = selection.kind === 'region' && rgs && rgs[selection.index];
  regionEl.hidden = !show;
  if (!show) return;
  const rg = rgs[selection.index];
  const z = deps.zoom();
  regionEl.style.left = `${PAD + (rg.cx - rg.rx) * z}px`;
  regionEl.style.top = `${PAD + (rg.cy - rg.ry) * z}px`;
  regionEl.style.width = `${rg.rx * 2 * z}px`;
  regionEl.style.height = `${rg.ry * 2 * z}px`;
  regionEl.classList.toggle('oof', rg.type === 'blur');
}

/* ---------- 좌표 ---------- */

function imgPos(e) {
  const rect = deps.view.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / deps.zoom(),
    y: (e.clientY - rect.top) / deps.zoom(),
  };
}

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/* ---------- 제스처 상태 ---------- */
let g = null; // 현재 제스처

function onDown(e) {
  if (!deps.E.isOpen() || deps.cropActive() || e.button !== 0) return;
  if (deps.compareActive()) return;
  const p = imgPos(e);
  const doc = deps.E.doc;
  updateCursorPos(e);

  // ── 선택·이동 도구: 개체/region 잡아 이동, 빈 곳은 팬(기본 동작에 위임)
  if (active === 'select') {
    const oi = O.hitObject(doc.objects, p.x, p.y);
    const ri = hitRegion(doc.adj.regions || [], p.x, p.y);
    if (oi >= 0 && oi >= ri) {
      select('object', oi);
      g = { kind: 'moveObject', index: oi, last: p };
      e.preventDefault();
    } else if (ri >= 0) {
      select('region', ri);
      g = { kind: 'moveRegion', index: ri, last: p };
      e.preventDefault();
    }
    return;
  }

  // ── 부분 보정 / 아웃포커스: 기존 region 드래그면 이동·핸들이면 리사이즈, 아니면 새로 만들기
  if (active === 'region' || active === 'oof') {
    const rgs = doc.adj.regions || [];
    const ri = hitRegion(rgs, p.x, p.y);
    if (ri >= 0) {
      select('region', ri);
      const rg = rgs[ri];
      const h = handleHit(rg, p);
      g = h ? { kind: 'resizeRegion', index: ri, handle: h, orig: { ...rg } } : { kind: 'moveRegion', index: ri, last: p };
      e.preventDefault();
      return;
    }
    const type = active === 'region' ? 'adjust' : 'blur';
    const rg = {
      id: `rg${Date.now().toString(36)}`,
      type,
      cx: p.x, cy: p.y, rx: 1, ry: 1,
      feather: type === 'adjust'
        ? 1 - (toolOpts.regionFeather / 100) * 0.95
        : 1 - (toolOpts.oofFeather / 100) * 0.95,
      params: type === 'adjust' ? {
        brightness: toolOpts.regionBrightness,
        exposure: toolOpts.regionExposure,
        saturation: toolOpts.regionSaturation,
        contrast: toolOpts.regionContrast,
      } : null,
      blurPx: type === 'blur' ? toolOpts.oofBlur : 0,
    };
    doc.adj.regions.push(rg);
    select('region', doc.adj.regions.length - 1);
    g = { kind: 'createRegion', index: doc.adj.regions.length - 1, start: p };
    e.preventDefault();
    return;
  }

  // ── 텍스트: 기존 텍스트 드래그면 이동, 빈 곳 클릭이면 새로 만들기
  if (active === 'text') {
    const oi = O.hitObject(doc.objects, p.x, p.y);
    if (oi >= 0 && doc.objects[oi].type === 'text') {
      select('object', oi);
      g = { kind: 'moveObject', index: oi, last: p };
    } else {
      const o = {
        id: `tx${Date.now().toString(36)}`,
        type: 'text', x: p.x, y: p.y,
        text: toolOpts.textText, font: toolOpts.textFont, size: toolOpts.textSize,
        bold: toolOpts.textBold, color: toolOpts.textColor,
        strokeColor: toolOpts.textStrokeColor, strokeWidth: toolOpts.textStrokeW,
        shadow: toolOpts.textShadow, opacity: 1,
      };
      doc.objects.push(o);
      deps.E.touchObjects();
      invalidateObjects();
      select('object', doc.objects.length - 1);
      g = { kind: 'moveObject', index: doc.objects.length - 1, last: p, pendingCommit: true };
      deps.render();
    }
    e.preventDefault();
    return;
  }

  // ── 도형: 기존 도형 드래그면 이동, 빈 곳이면 새로 만들기
  if (active === 'shape') {
    const oi = O.hitObject(doc.objects, p.x, p.y);
    if (oi >= 0 && doc.objects[oi].type === 'shape') {
      select('object', oi);
      g = { kind: 'moveObject', index: oi, last: p };
      e.preventDefault();
      return;
    }
    const o = {
      id: `sh${Date.now().toString(36)}`,
      type: 'shape', shape: toolOpts.shapeKind,
      x1: p.x, y1: p.y, x2: p.x, y2: p.y,
      color: toolOpts.shapeColor, width: toolOpts.shapeWidth,
      fill: toolOpts.shapeFillOn ? toolOpts.shapeFillColor : null,
      opacity: 1,
    };
    doc.objects.push(o);
    deps.E.touchObjects();
    invalidateObjects();
    select('object', doc.objects.length - 1);
    g = { kind: 'drawShape', index: doc.objects.length - 1 };
    e.preventDefault();
    return;
  }

  // ── 브러시·지우개: 임시 스트로크(커밋 시 히스토리)
  if (active === 'brush' || active === 'erase') {
    const o = {
      id: `st${Date.now().toString(36)}`,
      type: 'stroke', pts: [p.x, p.y, p.x + 0.01, p.y],
      color: toolOpts.brushColor, size: toolOpts.brushSize,
      opacity: toolOpts.brushOpacity, erase: active === 'erase',
    };
    doc.objects.push(o);
    deps.E.touchObjects();
    invalidateObjects();
    g = { kind: 'drawStroke', index: doc.objects.length - 1 };
    e.preventDefault();
    deps.render();
    return;
  }

  // ── 래스터 도구: base 사본에 직접
  if (active === 'clone') {
    if (e.altKey) {
      cloneSrc = p;
      cloneOffset = null;
      deps.toast('복제 지점을 정했습니다 — 이제 드래그해서 칠하세요');
      return;
    }
    if (!cloneSrc) { deps.toast('Alt+클릭으로 먼저 복제 지점을 선택하세요'); return; }
    snapshot(); // g_snap = 작업 사본(여기에 칠한다)
    cloneSrcClean = document.createElement('canvas');
    cloneSrcClean.width = doc.base.width; cloneSrcClean.height = doc.base.height;
    cloneSrcClean.getContext('2d').drawImage(doc.base, 0, 0);
    cloneOffset = { x: p.x - cloneSrc.x, y: p.y - cloneSrc.y };
    g = { kind: 'raster', tool: 'clone', last: p };
    stampClone(p);
    e.preventDefault();
    deps.render();
    return;
  }
  if (active === 'heal') {
    const snap = snapshot();
    g = { kind: 'raster', tool: 'heal' };
    healSpot(snap, p, toolOpts.healSize / 2);
    commitRaster(snap);
    e.preventDefault();
    deps.render();
    return;
  }
  if (active === 'redeye') {
    const snap = snapshot();
    g = { kind: 'raster', tool: 'redeye' };
    fixRedEye(snap, p, toolOpts.redeyeSize / 2);
    commitRaster(snap);
    e.preventDefault();
    deps.render();
    return;
  }
  if (active === 'mosaic') {
    const snap = snapshot();
    g = { kind: 'raster', tool: 'mosaic', snap, last: p };
    stampMosaic(snap, p);
    e.preventDefault();
    deps.render();
    return;
  }
}

function onMove(e) {
  updateCursorPos(e);
  if (!g) return;
  const p = imgPos(e);
  const doc = deps.E.doc;

  if (g.kind === 'moveObject' || g.kind === 'drawStroke' || g.kind === 'drawShape') {
    const o = doc.objects[g.index];
    if (g.kind === 'moveObject') {
      O.moveObject(o, p.x - g.last.x, p.y - g.last.y);
      g.last = p;
    } else if (g.kind === 'drawStroke') {
      o.pts.push(p.x, p.y);
    } else {
      o.x2 = p.x; o.y2 = p.y;
    }
    deps.E.touchObjects();
    invalidateObjects();
    deps.render();
  } else if (g.kind === 'createRegion') {
    const rg = doc.adj.regions[g.index];
    rg.rx = Math.max(6, Math.abs(p.x - g.start.x) / 2);
    rg.ry = Math.max(6, Math.abs(p.y - g.start.y) / 2);
    rg.cx = (p.x + g.start.x) / 2;
    rg.cy = (p.y + g.start.y) / 2;
    deps.render();
    updateRegionUI();
  } else if (g.kind === 'moveRegion') {
    const rg = doc.adj.regions[g.index];
    rg.cx += p.x - g.last.x;
    rg.cy += p.y - g.last.y;
    g.last = p;
    deps.render();
    updateRegionUI();
  } else if (g.kind === 'resizeRegion') {
    const rg = doc.adj.regions[g.index];
    const o = g.orig;
    const L = o.cx - o.rx, Tt = o.cy - o.ry, R = o.cx + o.rx, B = o.cy + o.ry;
    if (g.handle.includes('e')) rg.rx = Math.max(6, (p.x - L) / 2);
    if (g.handle.includes('w')) rg.rx = Math.max(6, (R - p.x) / 2);
    if (g.handle.includes('s')) rg.ry = Math.max(6, (p.y - Tt) / 2);
    if (g.handle.includes('n')) rg.ry = Math.max(6, (B - p.y) / 2);
    rg.cx = g.handle.includes('e') ? L + rg.rx : g.handle.includes('w') ? R - rg.rx : o.cx;
    rg.cy = g.handle.includes('s') ? Tt + rg.ry : g.handle.includes('n') ? B - rg.ry : o.cy;
    deps.render();
    updateRegionUI();
  } else if (g.kind === 'raster' && g.tool === 'clone') {
    // 이벤트 사이 구간을 스탬프 간격으로 보간 — 빠른 드래그 빵꾸 방지
    const r = toolOpts.cloneSize / 2;
    const d = Math.hypot(p.x - g.last.x, p.y - g.last.y);
    const steps = Math.max(1, Math.ceil(d / Math.max(2, r * 0.4)));
    for (let i = 1; i <= steps; i++) {
      stampClone({ x: g.last.x + ((p.x - g.last.x) * i) / steps, y: g.last.y + ((p.y - g.last.y) * i) / steps });
    }
    g.last = p;
    deps.render();
  } else if (g.kind === 'raster' && g.tool === 'mosaic') {
    const r = toolOpts.mosaicSize / 2;
    const d = Math.hypot(p.x - g.last.x, p.y - g.last.y);
    const steps = Math.max(1, Math.ceil(d / Math.max(2, r * 0.4)));
    for (let i = 1; i <= steps; i++) {
      stampMosaic(g.snap, { x: g.last.x + ((p.x - g.last.x) * i) / steps, y: g.last.y + ((p.y - g.last.y) * i) / steps });
    }
    g.last = p;
    deps.render();
  }
}

function onUp() {
  if (!g) return;
  const kind = g.kind;
  g = null;
  if (kind === 'raster') { commitRaster(); return; }
  if (kind === 'moveObject' || kind === 'drawStroke' || kind === 'drawShape') {
    deps.E.pushHistory();
    deps.toolChanged(active); // 텍스트 등 옵션 패널을 선택 상태로 갱신
  } else if (kind === 'createRegion' || kind === 'moveRegion' || kind === 'resizeRegion') {
    const rg = deps.E.doc.adj.regions && deps.E.doc.adj.regions[selection.index];
    if (rg && (rg.rx < 8 || rg.ry < 8)) {
      deps.E.doc.adj.regions.splice(selection.index, 1);
      select(null, -1);
      deps.render();
    } else {
      deps.E.pushHistory();
      deps.toolChanged(active);
    }
  }
}

/* ---------- 개체/region 히트 ---------- */

function hitRegion(rgs, x, y) {
  for (let i = rgs.length - 1; i >= 0; i--) {
    const rg = rgs[i];
    const nx = (x - rg.cx) / rg.rx, ny = (y - rg.cy) / rg.ry;
    if (nx * nx + ny * ny <= 1.1) return i;
  }
  return -1;
}

function handleHit(rg, p) {
  const z = deps.zoom();
  const left = (rg.cx - rg.rx) * z, top = (rg.cy - rg.ry) * z;
  const w = rg.rx * 2 * z, h = rg.ry * 2 * z;
  const rect = deps.view.getBoundingClientRect();
  const px = (p.x * z), py = (p.y * z);
  const hs = 22;
  const corners = { nw: [left, top], ne: [left + w, top], sw: [left, top + h], se: [left + w, top + h] };
  for (const [id, [cx, cy]] of Object.entries(corners)) {
    if (Math.abs(px - cx) < hs && Math.abs(py - cy) < hs) return id;
  }
  return null;
}

/* ---------- 래스터 도구 ---------- */

let cloneSrc = null;      // Alt+클릭으로 찍은 복제 원점
let cloneOffset = null;   // 원점 → 첫 붓질 벡터
let cloneSrcClean = null; // 자기복제 방지용 클린 사본(여기서 샘플)
let g_snap = null; // raster 제스처의 작업 사본

function snapshot() {
  const doc = deps.E.doc;
  const c = document.createElement('canvas');
  c.width = doc.base.width; c.height = doc.base.height;
  c.getContext('2d').drawImage(doc.base, 0, 0);
  g_snap = c;
  return c;
}

function commitRaster(snap) {
  const work = g_snap || snap;
  if (!work) return;
  deps.E.applyOp(() => work);
  g_snap = null;
}

function stampClone(p) {
  if (!g_snap || !cloneSrcClean || !cloneOffset) return;
  const ctx = g_snap.getContext('2d', { willReadFrequently: true });
  const r = toolOpts.cloneSize / 2;
  const sx = p.x - cloneOffset.x, sy = p.y - cloneOffset.y;
  const size = Math.ceil(r * 2 + 2);
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = size;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(cloneSrcClean, sx - r - 1, sy - r - 1, size, size, 0, 0, size, size);
  tctx.globalCompositeOperation = 'destination-in';
  const grad = tctx.createRadialGradient(r + 1, r + 1, r * 0.55, r + 1, r + 1, r + 1);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, size, size);
  ctx.drawImage(tmp, p.x - r - 1, p.y - r - 1);
}

function healSpot(snap, p, r) {
  const ctx = snap.getContext('2d', { willReadFrequently: true });
  const W = snap.width, H = snap.height;
  // 8방향 주변 패치와 가장 비슷한 방향을 골라 원형으로 덮는다
  let best = null, bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    const ang = (k / 8) * Math.PI * 2;
    const ox = Math.cos(ang) * r * 2.4, oy = Math.sin(ang) * r * 2.4;
    const a = ringSample(ctx, W, H, p.x + ox, p.y + oy, r);
    const b = ringSample(ctx, W, H, p.x, p.y, r);
    const score = colorDist(a, b);
    if (score < bestScore) { bestScore = score; best = { ox, oy }; }
  }
  if (!best) return;
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = Math.ceil(r * 2 + 2);
  const tctx = tmp.getContext('2d');
  tctx.filter = 'blur(1.5px)';
  tctx.drawImage(snap, p.x + best.ox - r - 1, p.y + best.oy - r - 1, r * 2 + 2, r * 2 + 2, 0, 0, r * 2 + 2, r * 2 + 2);
  tctx.globalCompositeOperation = 'destination-in';
  const grad = tctx.createRadialGradient(r + 1, r + 1, r * 0.4, r + 1, r + 1, r + 1);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(tmp, p.x - r - 1, p.y - r - 1);
}

function ringSample(ctx, W, H, cx, cy, r) {
  const x = Math.max(0, Math.min(W - 1, Math.round(cx)));
  const y = Math.max(0, Math.min(H - 1, Math.round(cy)));
  const d = ctx.getImageData(Math.max(0, x - r), Math.max(0, y - r), Math.min(W - Math.max(0, x - r), r * 2 + 1), Math.min(H - Math.max(0, y - r), r * 2 + 1));
  let rr = 0, gg = 0, bb = 0, n = 0;
  for (let i = 0; i < d.data.length; i += 4) { rr += d.data[i]; gg += d.data[i + 1]; bb += d.data[i + 2]; n++; }
  return n ? [rr / n, gg / n, bb / n] : [0, 0, 0];
}

const colorDist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

function fixRedEye(snap, p, r) {
  const ctx = snap.getContext('2d', { willReadFrequently: true });
  const x0 = Math.max(0, Math.round(p.x - r)), y0 = Math.max(0, Math.round(p.y - r));
  const w = Math.min(snap.width - x0, Math.round(r * 2)), h = Math.min(snap.height - y0, Math.round(r * 2));
  if (w < 1 || h < 1) return;
  const img = ctx.getImageData(x0, y0, w, h);
  const d = img.data;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) * 4;
      const dr = d[i], dg = d[i + 1], db = d[i + 2];
      const cx = x0 + xx - p.x, cy = y0 + yy - p.y;
      const fall = 1 - Math.min(1, Math.hypot(cx, cy) / r);
      if (dr > dg * 1.15 + 8 && dr > db * 1.15 + 8) {
        const nv = Math.max(dg, db);
        d[i] = dr + (nv - dr) * fall;
      }
    }
  }
  ctx.putImageData(img, x0, y0);
}

function stampMosaic(snap, p) {
  const ctx = snap.getContext('2d', { willReadFrequently: true });
  const r = toolOpts.mosaicSize / 2, block = Math.max(4, toolOpts.mosaicBlock);
  const W = snap.width, H = snap.height;
  const x0 = Math.max(0, Math.floor(p.x - r)), y0 = Math.max(0, Math.floor(p.y - r));
  const x1 = Math.min(W, Math.ceil(p.x + r)), y1 = Math.min(H, Math.ceil(p.y + r));
  if (x1 <= x0 || y1 <= y0) return;
  for (let by = Math.floor(y0 / block) * block; by < y1; by += block) {
    for (let bx = Math.floor(x0 / block) * block; bx < x1; bx += block) {
      const bw = Math.min(block, W - bx), bh = Math.min(block, H - by);
      const avg = blockAvg(ctx, bx, by, bw, bh);
      // 블록 중심이 브러시 원 안쪽일 때만 칠함(부드러운 가장자리)
      const ccx = bx + bw / 2, ccy = by + bh / 2;
      const t = 1 - Math.min(1, dist(ccx, ccy, p.x, p.y) / r);
      if (t <= 0) continue;
      ctx.fillStyle = `rgba(${avg[0]},${avg[1]},${avg[2]},${Math.min(1, t * 1.6)})`;
      ctx.fillRect(bx, by, bw, bh);
    }
  }
}

function blockAvg(ctx, bx, by, bw, bh) {
  const d = ctx.getImageData(bx, by, bw, bh).data;
  let rr = 0, gg = 0, bb = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; n++; }
  return [rr / n | 0, gg / n | 0, bb / n | 0];
}
