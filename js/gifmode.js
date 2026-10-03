/* gifmode.js — GIF 만들기: 여러 사진을 프레임으로 하는 애니메이션 GIF를 만든다.
   인코딩은 gifenc.js(자체 구현 median-cut + LZW). */

import { createFileList, bindAddButton } from './filelist.js?v=p3c';
import { encodeGIF } from './gifenc.js?v=p3c';

const $ = (id) => document.getElementById(id);

let list = null;
let bmps = []; // 재생·인코딩에 쓰는 디코딩된 프레임
let playTimer = 0;
let playIdx = 0;

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

async function refreshFrames() {
  stopPlay();
  bmps = [];
  for (const it of list.files) {
    const bmp = await createImageBitmap(it.file);
    bmps.push(bmp);
  }
  drawFrame(0);
}

function targetSize() {
  if (!bmps.length) return { w: 0, h: 0 };
  const sel = +$('gif-width').value;
  let w = bmps[0].width, h = bmps[0].height;
  if (sel > 0 && w > sel) {
    h = Math.max(1, Math.round((h / w) * sel));
    w = sel;
  }
  return { w, h };
}

function drawFrame(i) {
  const cv = $('gif-preview');
  if (!bmps.length) { cv.width = 0; cv.height = 0; return; }
  const { w, h } = targetSize();
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmps[i % bmps.length], 0, 0, w, h);
}

function stopPlay() {
  if (playTimer) { clearTimeout(playTimer); playTimer = 0; }
}

function play() {
  if (bmps.length < 2) { toast('프레임을 2장 이상 추가하세요'); return; }
  stopPlay();
  const delay = Math.max(20, +$('gif-delay').value || 200);
  playIdx = 0;
  drawFrame(0);
  const tick = () => {
    playIdx = (playIdx + 1) % bmps.length;
    drawFrame(playIdx);
    playTimer = setTimeout(tick, delay); // 스로틀 환경에서는 느려질 뿐 오작동하지 않는다
  };
  playTimer = setTimeout(tick, delay);
}

async function build() {
  if (bmps.length < 2) { toast('프레임을 2장 이상 추가하세요'); return; }
  const btn = $('gif-run');
  btn.disabled = true;
  $('gif-progress').hidden = false;
  const { w, h } = targetSize();
  const frames = [];
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  for (let i = 0; i < bmps.length; i++) {
    $('gif-status').textContent = `프레임 변환 중 ${i + 1} / ${bmps.length}`;
    $('gif-bar').style.width = `${Math.round((i / bmps.length) * 90)}%`;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bmps[i], 0, 0, w, h);
    frames.push({ data: ctx.getImageData(0, 0, w, h).data, width: w, height: h });
    await new Promise((r) => setTimeout(r, 0));
  }
  $('gif-status').textContent = 'GIF 인코딩 중…';
  $('gif-bar').style.width = '95%';
  await new Promise((r) => setTimeout(r, 0));
  const blob = encodeGIF(frames, {
    delayMs: Math.max(20, +$('gif-delay').value || 200),
    repeat: +$('gif-repeat').value || 0,
  });
  $('gif-bar').style.width = '100%';
  $('gif-status').textContent = `완료 — ${w}×${h}, ${(blob.size / 1048576).toFixed(2)}MB`;
  const url = URL.createObjectURL(blob);
  const img = $('gif-result');
  img.src = url;
  img.hidden = false;
  const dl = $('gif-download');
  dl.href = url;
  dl.hidden = false;
  toast('GIF를 만들었습니다');
  btn.disabled = false;
  setTimeout(() => { $('gif-progress').hidden = true; $('gif-bar').style.width = '0'; }, 1500);
}

export function initGif() {
  list = createFileList({
    mount: $('gif-list'),
    multiple: true,
    reorder: true,
    onChange: () => refreshFrames(),
  });
  bindAddButton('gif-add', list);
  $('gif-clear').addEventListener('click', () => { stopPlay(); list.clear(); bmps = []; drawFrame(0); });
  $('gif-delay').addEventListener('input', (e) => { e.target.nextElementSibling.textContent = `${e.target.value}ms`; });
  $('gif-play').addEventListener('click', play);
  $('gif-stop').addEventListener('click', stopPlay);
  $('gif-run').addEventListener('click', build);
}
