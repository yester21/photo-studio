/* batch.js — 일괄 편집: 여러 사진에 색 보정(5종) + 텍스트 워터마크를 일괄 적용해 ZIP으로 내려준다.
   포맷 변환·리사이즈는 담당하지 않는다(각 파일 원본 포맷 유지 — 그 용도는 img-tools). */

import * as P from './pipeline.js?v=p3c';
import { createFileList, bindAddButton } from './filelist.js?v=p3c';
import { makeZip } from './zip.js?v=p3c';

const TONE_DEFS = [
  { key: 'exposure', label: '노출', min: -100, max: 100 },
  { key: 'brightness', label: '밝기', min: -100, max: 100 },
  { key: 'contrast', label: '명암', min: -100, max: 100 },
  { key: 'saturation', label: '채도', min: -100, max: 100 },
  { key: 'temp', label: '색온도', min: -100, max: 100 },
];

const state = {
  adj: { exposure: 0, brightness: 0, contrast: 0, saturation: 0, temp: 0 },
  wm: { on: true, text: '© 내 사진', size: 40, opacity: 70, color: '#ffffff', shadow: true, pos: 8 },
};

let list = null;
let previewBmp = null;

const $ = (id) => document.getElementById(id);

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

/* 워터마크: 크기 슬라이더는 600px 기준 픽셀 — 큰 이미지에는 비례 확대 */
function drawWatermark(ctx, w, h) {
  if (!state.wm.on || !state.wm.text.trim()) return;
  const scale = Math.min(w, h) / 600;
  const px = Math.max(10, Math.round(state.wm.size * Math.max(0.3, scale)));
  ctx.save();
  ctx.globalAlpha = state.wm.opacity / 100;
  ctx.font = `700 ${px}px "Malgun Gothic", "맑은 고딕", sans-serif`;
  ctx.textBaseline = 'top';
  if (state.wm.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = Math.max(3, px * 0.12);
    ctx.shadowOffsetY = Math.max(1, px * 0.05);
  }
  const lines = state.wm.text.split('\n');
  const lh = px * 1.3;
  let tw = 0;
  for (const l of lines) tw = Math.max(tw, ctx.measureText(l).width);
  const th = lines.length * lh;
  const mx = Math.round(w * 0.03), my = Math.round(h * 0.03);
  const col = state.wm.pos % 3, row = Math.floor(state.wm.pos / 3);
  let x = col === 0 ? mx : col === 1 ? (w - tw) / 2 : w - tw - mx;
  let y = row === 0 ? my : row === 1 ? (h - th) / 2 : h - th - my;
  ctx.fillStyle = state.wm.color;
  lines.forEach((l, i) => {
    ctx.fillText(l, x, y + i * lh);
    ctx.lineWidth = Math.max(1, px / 18);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    if (!state.wm.shadow) ctx.strokeText(l, x, y + i * lh);
  });
  ctx.restore();
}

function outputType(file) {
  if (file.type === 'image/png') return 'image/png';
  if (file.type === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

async function processOne(file) {
  const bmp = await createImageBitmap(file);
  const out = document.createElement('canvas');
  P.renderTo(out, bmp, { ...P.defaultAdj(), ...state.adj, mode: 'none' }, {});
  if (bmp.close) bmp.close();
  drawWatermark(out.getContext('2d'), out.width, out.height);
  const type = outputType(file);
  const blob = await new Promise((r) => out.toBlob(r, type, 0.92));
  const base = file.name.replace(/\.[^.]+$/, '');
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  return { name: `${base}_편집.${ext}`, blob };
}

async function renderPreview() {
  const cv = $('batch-preview');
  if (!previewBmp) {
    cv.width = 0; cv.height = 0;
    return;
  }
  const s = Math.min(1, 420 / Math.max(previewBmp.width, previewBmp.height));
  cv.width = Math.max(1, Math.round(previewBmp.width * s));
  cv.height = Math.max(1, Math.round(previewBmp.height * s));
  const ctx = cv.getContext('2d');
  P.renderTo(cv, previewBmp, { ...P.defaultAdj(), ...state.adj, mode: 'none' }, {});
  drawWatermark(ctx, cv.width, cv.height);
}

async function updatePreviewBmp() {
  const first = list.files[0];
  if (!first) { previewBmp = null; renderPreview(); return; }
  if (previewBmp && previewBmp.__name === first.name && previewBmp.__size === first.size) return;
  previewBmp = await createImageBitmap(first.file);
  previewBmp.__name = first.name;
  previewBmp.__size = first.size;
  renderPreview();
}

export function initBatch() {
  list = createFileList({
    mount: $('batch-list'),
    multiple: true,
    onChange: () => updatePreviewBmp(),
  });
  bindAddButton('batch-add', list);

  // 색 보정 슬라이더
  const toneMount = $('batch-tone');
  for (const def of TONE_DEFS) {
    const row = document.createElement('div');
    row.className = 'slider-row';
    const label = document.createElement('label');
    label.textContent = def.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = def.min; input.max = def.max; input.value = 0;
    const out = document.createElement('output');
    out.textContent = '0';
    input.addEventListener('input', () => {
      state.adj[def.key] = +input.value;
      out.textContent = input.value;
      renderPreview();
    });
    row.append(label, input, out);
    toneMount.appendChild(row);
  }
  $('batch-tone-reset').addEventListener('click', () => {
    state.adj = { exposure: 0, brightness: 0, contrast: 0, saturation: 0, temp: 0 };
    for (const input of toneMount.querySelectorAll('input')) {
      input.value = 0;
      input.nextElementSibling.textContent = '0';
    }
    renderPreview();
  });

  // 워터마크
  $('batch-wm-on').addEventListener('change', (e) => { state.wm.on = e.target.checked; renderPreview(); });
  $('batch-wm-text').addEventListener('input', (e) => { state.wm.text = e.target.value; renderPreview(); });
  $('batch-wm-size').addEventListener('input', (e) => { state.wm.size = +e.target.value; e.target.nextElementSibling.textContent = e.target.value; renderPreview(); });
  $('batch-wm-opacity').addEventListener('input', (e) => { state.wm.opacity = +e.target.value; e.target.nextElementSibling.textContent = e.target.value; renderPreview(); });
  $('batch-wm-color').addEventListener('input', (e) => { state.wm.color = e.target.value; renderPreview(); });
  $('batch-wm-shadow').addEventListener('change', (e) => { state.wm.shadow = e.target.checked; renderPreview(); });

  const posMount = $('batch-wm-pos');
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('button');
    cell.className = 'pos-cell' + (i === state.wm.pos ? ' active' : '');
    cell.title = ['좌상', '중상', '우상', '좌중', '중앙', '우중', '좌하', '중하', '우하'][i];
    cell.addEventListener('click', () => {
      state.wm.pos = i;
      for (const c of posMount.children) c.classList.remove('active');
      cell.classList.add('active');
      renderPreview();
    });
    posMount.appendChild(cell);
  }

  // 실행
  $('batch-run').addEventListener('click', async () => {
    const files = list.files;
    if (!files.length) { toast('먼저 사진을 추가하세요'); return; }
    const btn = $('batch-run');
    const bar = $('batch-bar');
    btn.disabled = true;
    $('batch-progress').hidden = false;
    const entries = [];
    for (let i = 0; i < files.length; i++) {
      $('batch-status').textContent = `처리 중 ${i + 1} / ${files.length} — ${files[i].name}`;
      bar.style.width = `${Math.round((i / files.length) * 100)}%`;
      try {
        entries.push(await processOne(files[i].file));
      } catch {
        toast(`건너뜀: ${files[i].name}`);
      }
      await new Promise((r) => setTimeout(r, 0)); // UI 숨 쉬기
    }
    bar.style.width = '100%';
    $('batch-status').textContent = `${entries.length}장 처리 완료 — ZIP 압축 중`;
    if (!entries.length) {
      btn.disabled = false;
      $('batch-status').textContent = '처리된 파일이 없습니다';
      return;
    }
    const zip = await makeZip(entries);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip);
    a.download = `포토스튜디오_일괄_${Date.now() % 100000}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    $('batch-status').textContent = `완료 — ${entries.length}장, ${(zip.size / 1048576).toFixed(1)}MB`;
    toast('일괄 처리를 완료했습니다');
    btn.disabled = false;
    setTimeout(() => { $('batch-progress').hidden = true; bar.style.width = '0'; }, 1500);
  });

  $('batch-clear').addEventListener('click', () => { list.clear(); previewBmp = null; renderPreview(); });
}
