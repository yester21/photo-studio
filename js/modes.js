/* modes.js — 상단 모드 탭(편집기·일괄·결합·분할·GIF·도구) 전환과 각 모드 초기화. */

import { initBatch } from './batch.js?v=p3c';
import { initCombine } from './combine.js?v=p3c';
import { initSplit } from './split.js?v=p3c';
import { initGif } from './gifmode.js?v=p3c';
import { initToolsMode } from './toolsmode.js?v=p3c';
import * as E from './engine.js?v=p3c';

let inited = false;

export function switchMode(id) {
  for (const page of document.querySelectorAll('.mode-page')) {
    page.hidden = page.id !== `mode-${id}`;
  }
  for (const btn of document.querySelectorAll('#mode-nav .mtab')) {
    btn.classList.toggle('active', btn.dataset.mode === id);
  }
}

export function initModes() {
  if (inited) return;
  inited = true;

  document.getElementById('mode-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.mtab');
    if (btn) switchMode(btn.dataset.mode);
  });

  initBatch();
  initCombine();
  initSplit();
  initGif();
  initToolsMode((canvas, name) => {
    E.openImage(canvas, name, 0);
    switchMode('editor');
  });
}
