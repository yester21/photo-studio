/* engine.js — 문서 상태·히스토리·열기/저장.
   파이프라인(pipeline.js)의 순수 연산 위에서 편집 세션을 관리한다.
   base = 파괴적 연산(자르기·회전·래스터 브러시 등)의 결과 비트맵,
   adj = 비파괴 색보정 파라미터(커브·레벨·WB·부분 보정 포함),
   objects = 그리기 개체 벡터 목록(기하 연산 시 base에 베이크).
   히스토리 엔트리는 {base 참조, adj 깊은 사본, objects 깊은 사본}. */

import * as P from './pipeline.js?v=p3c';
import { objectsOverlay } from './objects.js?v=p3c';

const MAX_PIXELS = 36e6; // 열 때 상한. 초과 시 축소 후 오픈
const MAX_HISTORY = 40;

export const doc = {
  name: null,
  fileSize: 0,
  base: null,
  original: null,
  adj: P.defaultAdj(),
  objects: [],
  objectsVersion: 0,
  straighten: 0, // 적용 전 기울기 프리뷰 값 (히스토리에 안 들어감)
};

const listeners = [];
export function onChange(fn) { listeners.push(fn); }
function emit() { for (const fn of listeners) fn(); }

let hist = [];
let hi = -1;

export function isOpen() { return !!doc.base; }
export function canUndo() { return hi > 0; }
export function canRedo() { return hi < hist.length - 1; }

export function touchObjects() { doc.objectsVersion++; }

export function pushHistory() {
  hist = hist.slice(0, hi + 1);
  hist.push({
    base: doc.base,
    adj: structuredClone(doc.adj),
    objects: structuredClone(doc.objects),
  });
  if (hist.length > MAX_HISTORY) hist.shift();
  hi = hist.length - 1;
  emit();
}

function restore(i) {
  const e = hist[i];
  doc.base = e.base;
  doc.adj = structuredClone(e.adj);
  doc.objects = structuredClone(e.objects);
  doc.objectsVersion++;
  doc.straighten = 0;
  hi = i;
  emit();
}

export function undo() { if (canUndo()) restore(hi - 1); }
export function redo() { if (canRedo()) restore(hi + 1); }

/* 파괴적 연산: fn(base) → 새 base. adj는 그대로 유지(보정 상태 보존). */
export function applyOp(fn, { resetAdj = false } = {}) {
  if (!doc.base) return;
  doc.base = fn(doc.base);
  if (resetAdj) doc.adj = P.defaultAdj();
  pushHistory();
}

/* 기하 연산: 그리기 개체·부분 보정을 먼저 base에 베이크한 뒤 변환한다.
   (개체·region 좌표는 base 픽셀 기준이라 프레임이 바뀌면 함께 굳어야 한다) */
export function applyGeometry(fn) {
  if (!doc.base) return;
  const hasObjects = doc.objects.length > 0;
  const hasRegions = doc.adj.regions && doc.adj.regions.length > 0;
  if (hasObjects || hasRegions) {
    const c = document.createElement('canvas');
    c.width = doc.base.width; c.height = doc.base.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(doc.base, 0, 0);
    if (hasObjects) {
      ctx.drawImage(objectsOverlay(c.width, c.height, doc.objectsVersion, doc.objects), 0, 0);
      doc.objects = [];
      doc.objectsVersion++;
    }
    if (hasRegions) {
      P.applyRegions(c, doc.adj.regions, doc.base.width);
      doc.adj.regions = [];
    }
    doc.base = c;
  }
  doc.base = fn(doc.base);
  pushHistory();
}

/* 자동 레벨/명암 — base에 베이크(히스토리 1스텝). 변경이 없으면 false. */
export function autoLevels(perChannel) {
  if (!doc.base) return false;
  const plan = P.computeLevelsPlan(doc.base, perChannel);
  if (!plan || (!plan.r && !plan.g && !plan.b)) return false;
  doc.base = P.bakeLevels(doc.base, plan);
  pushHistory();
  return true;
}

export function openImage(source, name, fileSize = 0) {
  let c = document.createElement('canvas');
  c.width = source.width; c.height = source.height;
  c.getContext('2d').drawImage(source, 0, 0);
  let downscaled = false;
  if (c.width * c.height > MAX_PIXELS) {
    const s = Math.sqrt(MAX_PIXELS / (c.width * c.height));
    c = P.resizeBase(c, Math.round(c.width * s), Math.round(c.height * s));
    downscaled = true;
  }
  doc.name = name;
  doc.fileSize = fileSize;
  doc.original = c;
  doc.base = c;
  doc.adj = P.defaultAdj();
  doc.objects = [];
  doc.objectsVersion++;
  doc.straighten = 0;
  hist = [{
    base: c,
    adj: structuredClone(doc.adj),
    objects: [],
  }];
  hi = 0;
  emit();
  return { canvas: c, downscaled };
}

export function closeImage() {
  doc.name = null; doc.fileSize = 0;
  doc.base = null; doc.original = null;
  doc.adj = P.defaultAdj();
  doc.objects = [];
  doc.objectsVersion++;
  doc.straighten = 0;
  hist = []; hi = -1;
  emit();
}

/* 전체 해상도 렌더 후 내려받기. JPG는 투명을 흰색으로 평탄화. */
export async function save(format, quality, nameOverride) {
  if (!doc.base) return null;
  const out = document.createElement('canvas');
  const objects = doc.objects.length
    ? objectsOverlay(doc.base.width, doc.base.height, doc.objectsVersion, doc.objects)
    : null;
  P.renderTo(out, doc.base, doc.adj, { objects });
  let final = out;
  if (format === 'image/jpeg') {
    final = document.createElement('canvas');
    final.width = out.width; final.height = out.height;
    const ctx = final.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, final.width, final.height);
    ctx.drawImage(out, 0, 0);
  }
  const blob = await new Promise((res) => final.toBlob(res, format, quality / 100));
  if (!blob) return null;
  const ext = format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg';
  const base = (nameOverride || doc.name || 'image').replace(/\.[^.]+$/, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${base}_편집.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return blob;
}
