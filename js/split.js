/* split.js — 분할: 한 장의 사진을 행×열 조각으로 잘라 ZIP으로 내려준다.
   나머지 픽셀은 앞쪽 조각에 1px씩 분배해 원본을 온전히 덮는다. */

import { createFileList, bindAddButton } from './filelist.js?v=p3c';
import { makeZip } from './zip.js?v=p3c';

const $ = (id) => document.getElementById(id);

let list = null;

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

/* n등분 경계 배열 — 합이 항상 total */
function boundaries(total, n) {
  const base = Math.floor(total / n);
  const rem = total % n;
  const arr = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const len = base + (i < rem ? 1 : 0);
    arr.push({ from: pos, len });
    pos += len;
  }
  return arr;
}

function computeSlices(w, h, rows, cols) {
  const xs = boundaries(w, cols);
  const ys = boundaries(h, rows);
  const slices = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slices.push({ x: xs[c].from, y: ys[r].from, w: xs[c].len, h: ys[r].len, r, c });
    }
  }
  return slices;
}

async function renderPreview() {
  const cv = $('split-preview');
  const first = list.files[0];
  if (!first) { cv.width = 0; cv.height = 0; return; }
  const bmp = await createImageBitmap(first.file);
  const s = Math.min(1, 460 / Math.max(bmp.width, bmp.height));
  cv.width = Math.max(1, Math.round(bmp.width * s));
  cv.height = Math.max(1, Math.round(bmp.height * s));
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  if (bmp.close) bmp.close();
  const rows = Math.max(1, Math.min(10, +$('split-rows').value || 1));
  const cols = Math.max(1, Math.min(10, +$('split-cols').value || 1));
  ctx.strokeStyle = 'rgba(0,113,227,0.9)';
  ctx.lineWidth = 1;
  for (let r = 1; r < rows; r++) {
    const y = Math.round((cv.height / rows) * r) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke();
  }
  for (let c = 1; c < cols; c++) {
    const x = Math.round((cv.width / cols) * c) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); ctx.stroke();
  }
}

export function initSplit() {
  list = createFileList({
    mount: $('split-list'),
    multiple: true,
    onChange: () => renderPreview(),
  });
  bindAddButton('split-add', list);
  $('split-clear').addEventListener('click', () => { list.clear(); renderPreview(); });
  $('split-rows').addEventListener('input', renderPreview);
  $('split-cols').addEventListener('input', renderPreview);

  $('split-run').addEventListener('click', async () => {
    const first = list.files[0];
    if (!first) { toast('먼저 사진을 추가하세요'); return; }
    const rows = Math.max(1, Math.min(10, +$('split-rows').value || 1));
    const cols = Math.max(1, Math.min(10, +$('split-cols').value || 1));
    const format = $('split-format').value;
    const ext = format === 'image/png' ? 'png' : 'jpg';
    const btn = $('split-run');
    btn.disabled = true;
    $('split-progress').hidden = false;

    const bmp = await createImageBitmap(first.file);
    const slices = computeSlices(bmp.width, bmp.height, rows, cols);
    const base = first.name.replace(/\.[^.]+$/, '');
    const entries = [];
    for (let i = 0; i < slices.length; i++) {
      const s = slices[i];
      const cv = document.createElement('canvas');
      cv.width = s.w; cv.height = s.h;
      const ctx = cv.getContext('2d');
      ctx.drawImage(bmp, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
      const blob = await new Promise((r2) => cv.toBlob(r2, format, 0.92));
      entries.push({ name: `${base}_${String(s.r + 1).padStart(2, '0')}x${String(s.c + 1).padStart(2, '0')}.${ext}`, blob });
      $('split-bar').style.width = `${Math.round(((i + 1) / slices.length) * 100)}%`;
      $('split-status').textContent = `조각 ${i + 1} / ${slices.length}`;
      await new Promise((r2) => setTimeout(r2, 0));
    }
    if (bmp.close) bmp.close();

    if (entries.length === 1) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(entries[0].blob);
      a.download = entries[0].name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } else {
      const zip = await makeZip(entries);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(zip);
      a.download = `${base}_분할.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    $('split-status').textContent = `완료 — ${entries.length}조각`;
    toast('분할을 완료했습니다');
    btn.disabled = false;
    setTimeout(() => { $('split-progress').hidden = true; $('split-bar').style.width = '0'; }, 1500);
  });
}
