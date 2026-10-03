/* curves.js — 톤 커브(모노톤 3차 스플라인) 평가와 커브/레벨 패널 로직.
   포인트는 [{x,y}] (0..1 정규화), 기본 [{0,0},{1,1}]. LUT 256으로 캐시. */

export const CURVE_CHS = [
  { key: 'm', label: 'RGB' },
  { key: 'r', label: 'R' },
  { key: 'g', label: 'G' },
  { key: 'b', label: 'B' },
];

export function defaultCurves() {
  return { m: null, r: null, g: null, b: null };
}

export function defaultLevels() {
  return { b: 0, w: 255, mid: 1 };
}

/* Fritsch–Carlson 모노톤 3차 보간 — 커브가 흔들리지 않음 */
export function curveLUT(points) {
  const lut = new Uint8ClampedArray(256);
  if (!points || points.length < 2) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  const pts = [...points].sort((a, b) => a.x - b.x);
  const n = pts.length;
  const xs = pts.map((p) => Math.max(0, Math.min(1, p.x)));
  const ys = pts.map((p) => Math.max(0, Math.min(1, p.y)));

  if (n === 2) {
    const [x0, x1] = xs, [y0, y1] = ys;
    const slope = x1 === x0 ? 0 : (y1 - y0) / (x1 - x0);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      const t = Math.max(0, Math.min(1, (x - x0) / (x1 - x0 || 1)));
      lut[i] = Math.round((y0 + (y1 - y0) * t) * 255);
    }
    return lut;
  }

  const dx = [], dy = [], slope = [], mArr = new Array(n);
  for (let i = 0; i < n - 1; i++) {
    dx.push(xs[i + 1] - xs[i] || 1e-6);
    dy.push(ys[i + 1] - ys[i]);
    slope.push(dy[i] / dx[i]);
  }
  mArr[0] = slope[0];
  mArr[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    mArr[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { mArr[i] = 0; mArr[i + 1] = 0; continue; }
    const a = mArr[i] / slope[i], b = mArr[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      mArr[i] = t * a * slope[i];
      mArr[i + 1] = t * b * slope[i];
    }
  }
  let seg = 0;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    while (seg < n - 2 && x > xs[seg + 1]) seg++;
    const h = dx[seg];
    const t = (x - xs[seg]) / h;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    const y = h00 * ys[seg] + h10 * h * mArr[seg] + h01 * ys[seg + 1] + h11 * h * mArr[seg + 1];
    lut[i] = Math.round(Math.max(0, Math.min(1, y)) * 255);
  }
  return lut;
}

export function applyLevelsLUT(lut, levels) {
  const { b, w, mid } = levels;
  const range = Math.max(1, w - b);
  const out = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const v = Math.pow(Math.max(0, Math.min(1, (i - b) / range)), mid);
    out[i] = Math.round(v * 255);
  }
  const merged = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) merged[i] = out[lut[i]];
  return merged;
}

/* base 캔버스의 RGB 히스토그램(64bin 축소) — 커브/레벨 패널 배경 표시용 */
export function histogram(base, bins = 64) {
  const size = 256;
  const tmp = document.createElement('canvas');
  const s = Math.min(1, 480 / Math.max(base.width, base.height));
  tmp.width = Math.max(1, Math.round(base.width * s));
  tmp.height = Math.max(1, Math.round(base.height * s));
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(base, 0, 0, tmp.width, tmp.height);
  const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
  const r = new Float32Array(bins), g = new Float32Array(bins), b = new Float32Array(bins);
  const k = bins / 256;
  for (let i = 0; i < d.length; i += 4) {
    r[Math.min(bins - 1, d[i] * k | 0)]++;
    g[Math.min(bins - 1, d[i + 1] * k | 0)]++;
    b[Math.min(bins - 1, d[i + 2] * k | 0)]++;
  }
  let max = 1;
  for (let i = 1; i < bins - 1; i++) max = Math.max(max, r[i], g[i], b[i]);
  return { r, g, b, bins, max };
}

/* 커브 편집 캔버스: 그리드·히스토그램·스플라인·포인트 렌더 + 포인터 편집.
   onChange(points)는 드래그 확정(pointerup) 시에만 호출. */
export function createCurveEditor(canvas, opts) {
  const ctx = canvas.getContext('2d');
  let points = opts.get() ? opts.get().map((p) => ({ ...p })) : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  let dragIdx = -1, dirty = true;

  function sync() {
    const cur = opts.get();
    points = cur ? cur.map((p) => ({ ...p })) : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    dirty = true;
  }

  function draw() {
    if (!dirty) return;
    dirty = false;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // 배경
    ctx.fillStyle = '#f5f5f7';
    ctx.fillRect(0, 0, w, h);
    // 히스토그램
    const hist = opts.histogram && opts.histogram();
    if (hist) {
      const bw = w / hist.bins;
      const colors = [['rgba(255,59,48,.4)', hist.r], ['rgba(52,199,89,.4)', hist.g], ['rgba(0,113,227,.4)', hist.b]];
      for (const [color, ch] of colors) {
        ctx.fillStyle = color;
        for (let i = 0; i < hist.bins; i++) {
          const bh = (ch[i] / hist.max) * h * 0.92;
          ctx.fillRect(i * bw, h - bh, Math.ceil(bw), bh);
        }
      }
    }
    // 격자
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo((w / 4) * i, 0); ctx.lineTo((w / 4) * i, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, (h / 4) * i); ctx.lineTo(w, (h / 4) * i); ctx.stroke();
    }
    // 대각선 기준
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w, 0); ctx.stroke();
    ctx.setLineDash([]);
    // 커브
    const lut = curveLUT(points);
    ctx.strokeStyle = '#1d1d1f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * w;
      const y = h - (lut[i] / 255) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    // 포인트
    for (const p of points) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#1d1d1f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x * w, h - p.y * h, 5, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
  }

  const toPoint = (e) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)),
    };
  };
  const hit = (p) => points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.05);

  canvas.addEventListener('pointerdown', (e) => {
    if (!opts.enabled()) return;
    const p = toPoint(e);
    const i = hit(p);
    if (i >= 0) dragIdx = i;
    else {
      points.push(p);
      points.sort((a, b) => a.x - b.x);
      dragIdx = points.indexOf(p);
    }
    canvas.setPointerCapture(e.pointerId);
    dirty = true;
    opts.live([...points]);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragIdx < 0) return;
    const p = toPoint(e);
    const isEnd = dragIdx === 0 || dragIdx === points.length - 1;
    points[dragIdx].x = isEnd ? points[dragIdx].x : p.x;
    points[dragIdx].y = p.y;
    if (!isEnd) points.sort((a, b) => a.x - b.x);
    dragIdx = points.indexOf(points.find((q) => q === points[dragIdx]));
    dirty = true;
    opts.live([...points]);
  });
  const endDrag = () => {
    if (dragIdx < 0) return;
    dragIdx = -1;
    opts.commit([...points]);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', (e) => {
    if (!opts.enabled()) return;
    const p = toPoint(e);
    const i = hit(p);
    if (i > 0 && i < points.length - 1) {
      points.splice(i, 1);
      dirty = true;
      opts.commit([...points]);
    }
  });

  return { draw, sync, requestDraw() { dirty = true; } };
}
