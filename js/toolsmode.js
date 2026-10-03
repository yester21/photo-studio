/* toolsmode.js — 도구 탭: 색상 선택기 · 화면 캡처 · 이름 바꾸기 */

import { createFileList, bindAddButton } from './filelist.js?v=p3c';
import { makeZip } from './zip.js?v=p3c';

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

/* ---------- 색상 선택기 ---------- */

let pickList = null;
let pickBmp = null;

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

function setColor(r, g, b) {
  $('picker-swatch').style.background = rgbToHex(r, g, b);
  $('pv-hex').value = rgbToHex(r, g, b).toUpperCase();
  $('pv-rgb').value = `rgb(${r}, ${g}, ${b})`;
  $('pv-hsl').value = rgbToHsl(r, g, b);
}

async function renderPickCanvas() {
  const cv = $('picker-canvas');
  if (!pickBmp) { cv.width = 0; cv.height = 0; return; }
  const s = Math.min(1, 460 / Math.max(pickBmp.width, pickBmp.height));
  cv.width = Math.max(1, Math.round(pickBmp.width * s));
  cv.height = Math.max(1, Math.round(pickBmp.height * s));
  cv.getContext('2d').drawImage(pickBmp, 0, 0, cv.width, cv.height);
}

function initPicker() {
  pickList = createFileList({
    mount: $('picker-list'),
    multiple: true,
    onChange: async (items) => {
      pickBmp = items.length ? await createImageBitmap(items[items.length - 1].file) : null;
      renderPickCanvas();
    },
  });
  bindAddButton('picker-add', pickList);

  const cv = $('picker-canvas');
  const loupe = $('picker-loupe');
  const lctx = loupe.getContext('2d');
  cv.addEventListener('click', (e) => {
    if (!pickBmp) { toast('먼저 사진을 추가하세요'); return; }
    const rect = cv.getBoundingClientRect();
    const s = cv.width / rect.width;
    const x = Math.max(0, Math.min(cv.width - 1, Math.round((e.clientX - rect.left) * s)));
    const y = Math.max(0, Math.min(cv.height - 1, Math.round((e.clientY - rect.top) * s)));
    const d = cv.getContext('2d').getImageData(x, y, 1, 1).data;
    setColor(d[0], d[1], d[2]);
  });
  cv.addEventListener('mousemove', (e) => {
    if (!pickBmp) return;
    const rect = cv.getBoundingClientRect();
    const s = cv.width / rect.width;
    const x = Math.max(0, Math.min(cv.width - 1, Math.round((e.clientX - rect.left) * s)));
    const y = Math.max(0, Math.min(cv.height - 1, Math.round((e.clientY - rect.top) * s)));
    // 루페: 주변 21×21픽셀을 7배로
    lctx.imageSmoothingEnabled = false;
    lctx.clearRect(0, 0, 150, 150);
    lctx.drawImage(cv, Math.max(0, x - 10), Math.max(0, y - 10), 21, 21, 0, 0, 147, 147);
    lctx.strokeStyle = 'rgba(255,255,255,0.9)';
    lctx.lineWidth = 1.5;
    lctx.strokeRect(63, 63, 21, 21);
  });

  if ('EyeDropper' in window) {
    $('eyedropper-avail').textContent = '· 화면 전체에서 추출 가능';
    $('picker-eyedropper').hidden = false;
    $('picker-eyedropper').addEventListener('click', async () => {
      try {
        const dropper = new EyeDropper();
        const { sRGBHex } = await dropper.open();
        const m = sRGBHex.match(/^#(..)(..)(..)$/);
        setColor(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
      } catch {
        /* 사용자가 취소함 */
      }
    });
  }

  for (const btn of document.querySelectorAll('#tool-picker .copy-btn')) {
    btn.addEventListener('click', async () => {
      const input = $(btn.dataset.copy);
      try {
        await navigator.clipboard.writeText(input.value);
        toast('복사했습니다');
      } catch {
        input.select();
        document.execCommand('copy');
        toast('복사했습니다');
      }
    });
  }
}

/* ---------- 화면 캡처 ---------- */

function initCapture(openInEditor) {
  $('capture-run').addEventListener('click', async () => {
    const status = $('capture-status');
    if (!navigator.mediaDevices?.getDisplayMedia) {
      status.textContent = '이 브라우저는 화면 캡처를 지원하지 않습니다.';
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 250)); // 첫 프레임 안정화
      const cv = document.createElement('canvas');
      cv.width = video.videoWidth || 1280;
      cv.height = video.videoHeight || 720;
      cv.getContext('2d').drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());
      openInEditor(cv, `캡처_${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`);
      toast('캡처한 화면을 편집기로 불러왔습니다');
    } catch (err) {
      status.textContent = err && err.name === 'NotAllowedError'
        ? '캡처가 취소되었거나 허용되지 않았습니다.'
        : `캡처 실패: ${err?.message || err}`;
    }
  });
}

/* ---------- 이름 바꾸기 ---------- */

let renameList = null;

function renamePreview() {
  const items = renameList.files;
  const prefix = $('rename-prefix').value || '파일';
  const start = Math.max(0, +$('rename-start').value || 1);
  const pad = Math.max(1, Math.min(5, +$('rename-pad').value || 3));
  if (!items.length) {
    $('rename-preview').textContent = '파일을 추가하면 미리보기가 표시됩니다.';
    return;
  }
  $('rename-preview').textContent = items.slice(0, 3).map((it, i) => {
    const ext = (it.name.match(/\.[^.]+$/) || [''])[0];
    const num = String(start + i).padStart(pad, '0');
    return `${it.name} → ${prefix}${num}${ext}`;
  }).join('   ·   ') + (items.length > 3 ? ` ·＋${items.length - 3}` : '');
}

export function initToolsMode(openInEditor) {
  initPicker();
  initCapture(openInEditor);

  renameList = createFileList({
    mount: $('rename-list'),
    multiple: true,
    anyType: true,
    onChange: renamePreview,
  });
  bindAddButton('rename-add', renameList, { accept: '' });
  $('rename-clear').addEventListener('click', () => { renameList.clear(); renamePreview(); });
  for (const id of ['rename-prefix', 'rename-start', 'rename-pad']) {
    $(id).addEventListener('input', renamePreview);
  }
  $('rename-run').addEventListener('click', async () => {
    const items = renameList.files;
    if (!items.length) { toast('먼저 파일을 추가하세요'); return; }
    const prefix = $('rename-prefix').value || '파일';
    const start = Math.max(0, +$('rename-start').value || 1);
    const pad = Math.max(1, Math.min(5, +$('rename-pad').value || 3));
    const entries = items.map((it, i) => {
      const ext = (it.name.match(/\.[^.]+$/) || [''])[0];
      const num = String(start + i).padStart(pad, '0');
      return { name: `${prefix}${num}${ext}`, blob: it.file };
    });
    const zip = await makeZip(entries);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip);
    a.download = `이름바꾸기_${Date.now() % 100000}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`${entries.length}개 파일의 이름을 바꿨습니다`);
  });
}
