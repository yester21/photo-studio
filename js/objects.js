/* objects.js — 그리기 개체 레이어 (스트로크·도형·텍스트).
   개체는 이미지 픽셀 좌표계의 벡터 목록(doc.objects). 매 프레임 오버레이 캔버스에
   다시 그리되 버전 카운터로 캐시. 기하 연산(자르기·회전 등) 전에 base에 베이크된다. */

const measureCanvas = document.createElement('canvas');
const measureCtx = measureCanvas.getContext('2d');

let cache = { canvas: null, w: 0, h: 0, version: -1 };

export function invalidateObjects() {
  cache.version = -1;
}

export function objectsOverlay(w, h, version, objects) {
  if (cache.version === version && cache.w === w && cache.h === h && cache.canvas) return cache.canvas;
  const c = cache.canvas && cache.w === w && cache.h === h ? cache.canvas : document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  drawObjects(ctx, objects);
  cache = { canvas: c, w, h, version };
  return c;
}

export function drawObjects(ctx, objects) {
  for (const o of objects) {
    if (o.type === 'stroke') drawStroke(ctx, o);
    else if (o.type === 'shape') drawShape(ctx, o);
    else if (o.type === 'text') drawText(ctx, o);
  }
}

function drawStroke(ctx, o) {
  if (o.pts.length < 2) return;
  ctx.save();
  ctx.globalCompositeOperation = o.erase ? 'destination-out' : 'source-over';
  ctx.globalAlpha = o.opacity ?? 1;
  ctx.strokeStyle = o.color;
  ctx.lineWidth = o.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(o.pts[0], o.pts[1]);
  for (let i = 2; i < o.pts.length; i += 2) ctx.lineTo(o.pts[i], o.pts[i + 1]);
  ctx.stroke();
  ctx.restore();
}

function drawShape(ctx, o) {
  ctx.save();
  ctx.globalAlpha = o.opacity ?? 1;
  ctx.strokeStyle = o.color;
  ctx.lineWidth = o.width;
  ctx.lineCap = 'round';
  const x1 = o.x1, y1 = o.y1, x2 = o.x2, y2 = o.y2;
  if (o.shape === 'line' || o.shape === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (o.shape === 'arrow') {
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const len = Math.max(12, o.width * 3.4);
      ctx.setLineDash([]); // 화살촉은 실선
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(ang - 0.46), y2 - len * Math.sin(ang - 0.46));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(ang + 0.46), y2 - len * Math.sin(ang + 0.46));
      ctx.stroke();
    }
  } else if (o.shape === 'rect') {
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); }
    if (!o.fill || o.color !== o.fill) {
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    }
  } else if (o.shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
    if (!o.fill || o.color !== o.fill) ctx.stroke();
  }
  ctx.restore();
}

export function textMetrics(o) {
  measureCtx.font = `${o.bold ? '700 ' : ''}${o.size}px ${o.font}`;
  const lines = String(o.text ?? '').split('\n');
  let w = 0;
  for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
  const lh = o.size * 1.28;
  return { w: Math.max(8, w), h: lines.length * lh, lh, lines };
}

function drawText(ctx, o) {
  const m = textMetrics(o);
  ctx.save();
  ctx.globalAlpha = o.opacity ?? 1;
  ctx.font = `${o.bold ? '700 ' : '400 '}${o.size}px ${o.font}`;
  ctx.textBaseline = 'top';
  if (o.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = Math.max(3, o.size * 0.12);
    ctx.shadowOffsetY = Math.max(1, o.size * 0.05);
  }
  m.lines.forEach((line, i) => {
    const y = o.y + i * m.lh;
    if (o.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = o.strokeColor;
      ctx.lineWidth = o.strokeWidth;
      ctx.strokeText(line, o.x, y);
    }
    ctx.fillStyle = o.color;
    ctx.fillText(line, o.x, y);
  });
  ctx.restore();
}

/* ---------- 편집 지원: bbox, hit-test, 이동 ---------- */

export function objectBBox(o) {
  if (o.type === 'stroke') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < o.pts.length; i += 2) {
      minX = Math.min(minX, o.pts[i]); maxX = Math.max(maxX, o.pts[i]);
      minY = Math.min(minY, o.pts[i + 1]); maxY = Math.max(maxY, o.pts[i + 1]);
    }
    const pad = o.size / 2 + 2;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  if (o.type === 'shape') {
    const pad = o.width / 2 + 2;
    const x = Math.min(o.x1, o.x2) - pad, y = Math.min(o.y1, o.y2) - pad;
    return { x, y, w: Math.abs(o.x2 - o.x1) + pad * 2, h: Math.abs(o.y2 - o.y1) + pad * 2 };
  }
  if (o.type === 'text') {
    const m = textMetrics(o);
    const pad = o.strokeWidth;
    return { x: o.x - pad, y: o.y - pad, w: m.w + pad * 2, h: m.h + pad * 2 };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

export function hitObject(objects, x, y) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const b = objectBBox(objects[i]);
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
  }
  return -1;
}

export function moveObject(o, dx, dy) {
  if (o.type === 'stroke') {
    for (let i = 0; i < o.pts.length; i += 2) { o.pts[i] += dx; o.pts[i + 1] += dy; }
  } else if (o.type === 'shape') {
    o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
  } else if (o.type === 'text') {
    o.x += dx; o.y += dy;
  }
}
