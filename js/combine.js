/* combine.js — 결합: 여러 사진을 가로·세로·그리드로 한 장에 이어 붙인다.
   가로=높이 통일, 세로=너비 통일, 그리드=균등 셀에 맞춰 중앙 배치. */

import { createFileList, bindAddButton } from './filelist.js?v=p3c';

const $ = (id) => document.getElementById(id);

const state = { layout: 'h', gap: 8, bg: '#ffffff', cols: 2 };
let list = null;
const bmpCache = new Map(); // item.id → bitmap

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

async function getBitmap(item) {
  let bmp = bmpCache.get(item.id);
  if (!bmp) {
    bmp = await createImageBitmap(item.file);
    bmpCache.set(item.id, bmp);
  }
  return bmp;
}

function invalidateCache() {
  bmpCache.clear();
}

export function computeLayout(bitmaps) {
  // bitmaps: [{width, height}] → { width, height, cells: [{bmp, x, y, w, h}] }
  const gap = state.gap;
  const n = bitmaps.length;
  if (!n) return null;

  if (state.layout === 'h') {
    const H = Math.max(...bitmaps.map((b) => b.height));
    const cells = bitmaps.map((b, i) => {
      const w = Math.max(1, Math.round((b.width / b.height) * H));
      return { i, x: 0, y: 0, w, h: H };
    });
    let x = gap;
    for (const c of cells) { c.x = x; x += c.w + gap; }
    return { width: x, height: H + gap * 2, cells };
  }
  if (state.layout === 'v') {
    const W = Math.max(...bitmaps.map((b) => b.width));
    const cells = bitmaps.map((b, i) => {
      const h = Math.max(1, Math.round((b.height / b.width) * W));
      return { i, x: 0, y: 0, w: W, h };
    });
    let y = gap;
    for (const c of cells) { c.y = y; y += c.h + gap; }
    return { width: W + gap * 2, height: y, cells };
  }
  // 그리드
  const cols = Math.min(state.cols, n);
  const rows = Math.ceil(n / cols);
  const cellW = Math.max(...bitmaps.map((b) => b.width));
  const cellH = Math.max(...bitmaps.map((b) => b.height));
  const s = Math.min(1, 4000 / (cellW * cols)); // 전체 4000px 상한
  const cw = Math.max(1, Math.round(cellW * s));
  const chh = Math.max(1, Math.round(cellH * s));
  const cells = bitmaps.map((b, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const s2 = Math.min(cw / b.width, chh / b.height);
    const w = Math.max(1, Math.round(b.width * s2));
    const h = Math.max(1, Math.round(b.height * s2));
    return {
      i,
      x: gap + col * (cw + gap) + Math.round((cw - w) / 2),
      y: gap + row * (chh + gap) + Math.round((chh - h) / 2),
      w, h,
    };
  });
  return {
    width: gap * 2 + cols * cw + (cols - 1) * gap,
    height: gap * 2 + rows * chh + (rows - 1) * gap,
    cells,
  };
}

async function renderPreview() {
  const cv = $('combine-preview');
  const items = list.files;
  if (!items.length) { cv.width = 0; cv.height = 0; return; }
  const bitmaps = [];
  for (const it of items) bitmaps.push(await getBitmap(it));
  const layout = computeLayout(bitmaps);
  const s = Math.min(1, 420 / Math.max(layout.width, layout.height));
  cv.width = Math.max(1, Math.round(layout.width * s));
  cv.height = Math.max(1, Math.round(layout.height * s));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = state.bg;
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.imageSmoothingQuality = 'high';
  for (const c of layout.cells) {
    ctx.drawImage(bitmaps[c.i], Math.round(c.x * s), Math.round(c.y * s), Math.round(c.w * s), Math.round(c.h * s));
  }
}

export function initCombine() {
  list = createFileList({
    mount: $('combine-list'),
    multiple: true,
    reorder: true,
    onChange: () => { invalidateCache(); renderPreview(); },
  });
  bindAddButton('combine-add', list);
  $('combine-clear').addEventListener('click', () => { list.clear(); invalidateCache(); renderPreview(); });

  $('combine-layout').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    for (const b of $('combine-layout').querySelectorAll('.chip')) b.classList.toggle('active', b === chip);
    state.layout = chip.dataset.layout;
    $('combine-cols-row').hidden = state.layout !== 'grid';
    renderPreview();
  });
  $('combine-cols').addEventListener('input', (e) => {
    state.cols = +e.target.value;
    e.target.nextElementSibling.textContent = e.target.value;
    renderPreview();
  });
  $('combine-gap').addEventListener('input', (e) => {
    state.gap = Math.max(0, Math.min(200, +e.target.value || 0));
    renderPreview();
  });
  $('combine-bg').addEventListener('input', (e) => { state.bg = e.target.value; renderPreview(); });

  $('combine-download').addEventListener('click', async () => {
    const items = list.files;
    if (!items.length) { toast('먼저 사진을 추가하세요'); return; }
    const bitmaps = [];
    for (const it of items) bitmaps.push(await getBitmap(it));
    const layout = computeLayout(bitmaps);
    const out = document.createElement('canvas');
    out.width = layout.width; out.height = layout.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = state.bg;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingQuality = 'high';
    for (const c of layout.cells) ctx.drawImage(bitmaps[c.i], c.x, c.y, c.w, c.h);
    const format = $('combine-format').value;
    const blob = await new Promise((r) => out.toBlob(r, format, 0.92));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `결합_${Date.now() % 100000}.${format === 'image/png' ? 'png' : 'jpg'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`결합 완료 — ${out.width} × ${out.height}`);
  });
}
