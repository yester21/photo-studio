/* pipeline.js — 픽셀 파이프라인 (순수 캔버스 연산, DOM 없음)
   구성: LUT 톤보정(WB·틴트·커브·레벨 포함) → 크로스채널(색조·채도·자연 선명도·모드) →
   공간 효과(샤픈 언샵마스크·소프트 포커스·블룸·비네트) → 부분 보정/아웃포커스 마스크 →
   그리기 개체 오버레이 → 지오메트리 연산.
   미리보기와 내려받기가 같은 함수를 쓰므로 결과가 항상 동일하다. */

import { curveLUT } from './curves.js?v=p3c';

export const TONE_DEFS = [
  { key: 'exposure', label: '노출', min: -100, max: 100, def: 0 },
  { key: 'brightness', label: '밝기', min: -100, max: 100, def: 0 },
  { key: 'contrast', label: '명암', min: -100, max: 100, def: 0 },
  { key: 'saturation', label: '채도', min: -100, max: 100, def: 0 },
  { key: 'vibrance', label: '자연 선명도', min: -100, max: 100, def: 0 },
  { key: 'hue', label: '색조', min: -180, max: 180, def: 0, step: 1, unit: '°' },
  { key: 'gamma', label: '감마', min: -100, max: 100, def: 0 },
  { key: 'highlights', label: '하이라이트', min: -100, max: 100, def: 0 },
  { key: 'shadows', label: '섀도', min: -100, max: 100, def: 0 },
  { key: 'temp', label: '색온도', min: -100, max: 100, def: 0 },
  { key: 'tint', label: '틴트', min: -100, max: 100, def: 0 },
];

export const FX_DEFS = [
  { key: 'sharpen', label: '선명하게', min: 0, max: 100, def: 0 },
  { key: 'soften', label: '부드럽게', min: 0, max: 100, def: 0 },
  { key: 'vignette', label: '비네트', min: 0, max: 100, def: 0 },
  { key: 'bloom', label: '블룸', min: 0, max: 100, def: 0 },
  { key: 'backlight', label: '역광 보정', min: 0, max: 100, def: 0 },
];

export function defaultAdj() {
  const a = { mode: 'none' };
  for (const d of [...TONE_DEFS, ...FX_DEFS]) a[d.key] = d.def;
  a.curves = { m: null, r: null, g: null, b: null };
  a.levels = { b: 0, w: 255, mid: 1 };
  a.wb = null;
  a.regions = [];
  return a;
}

export const PRESETS = {
  vivid:    { saturation: 18, vibrance: 26, contrast: 12, sharpen: 10 },
  filmwarm: { temp: 26, exposure: 6, contrast: 8, shadows: 14, highlights: -8, saturation: 6, vignette: 20, bloom: 8 },
  airy:     { exposure: 14, brightness: 4, temp: -14, shadows: 20, contrast: -4, saturation: -4, bloom: 14 },
  vintage:  { temp: 18, contrast: -8, shadows: 16, highlights: -6, saturation: -22, vibrance: 10, gamma: 6, vignette: 30, bloom: 6 },
  mood:     { exposure: -10, contrast: 14, temp: -8, saturation: -12, highlights: -10, vignette: 34 },
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/* 톤 파라미터 → 채널별 256 LUT. WB 배수 → 노출/밝기/명암/감마/하이라이트/섀도/역광 →
   색온도·틴트 → 채널 커브 → RGB 커브 → 레벨. 픽셀 루프 밖에서 1회 계산. */
export function buildLUTs(a) {
  const wb = a.wb || null;
  const ex = Math.pow(2, (a.exposure / 100) * 1.0);
  const br = (a.brightness / 100) * 0.42;
  const c = a.contrast * 1.28;
  const co = (259 * (c + 255)) / (255 * (259 - c));
  const gamma = 1 - (a.gamma / 100) * 0.5;
  const hi = a.highlights / 100;
  const sh = a.shadows / 100;
  const bl = (a.backlight || 0) / 100;
  const dT = a.temp / 100;
  const dN = (a.tint || 0) / 100;

  const cm = a.curves && a.curves.m ? curveLUT(a.curves.m) : null;
  const cr = a.curves && a.curves.r ? curveLUT(a.curves.r) : null;
  const cg = a.curves && a.curves.g ? curveLUT(a.curves.g) : null;
  const cb = a.curves && a.curves.b ? curveLUT(a.curves.b) : null;

  let lv = null;
  if (a.levels && (a.levels.b !== 0 || a.levels.w !== 255 || a.levels.mid !== 1)) {
    const range = Math.max(1, a.levels.w - a.levels.b);
    lv = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      const v = Math.pow(Math.max(0, Math.min(1, (i - a.levels.b) / range)), a.levels.mid);
      lv[i] = Math.round(v * 255);
    }
  }

  const mk = (tempDelta, tintDelta, wbGain, chCurve) => {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      let v = (i * (wbGain ?? 1)) / 255;
      v *= ex;
      v += br;
      v = (v - 0.5) * co + 0.5;
      v = Math.pow(clamp01(v), gamma);
      v += hi * 0.55 * smoothstep(0.45, 1.05, v) * (hi > 0 ? 1 : 0.9);
      v += sh * 0.5 * smoothstep(0.55, -0.05, v) * (sh > 0 ? 1 : 0.9);
      if (bl > 0) v += bl * 0.42 * Math.pow(1 - clamp01(v), 2);
      v += (tempDelta + tintDelta) * 0.10 * (1 - 0.35 * clamp01(v));
      let out = Math.round(clamp01(v) * 255);
      if (chCurve) out = chCurve[out];
      if (cm) out = cm[out];
      if (lv) out = lv[out];
      lut[i] = out;
    }
    return lut;
  };
  return {
    r: mk(dT, dN * 0.5, wb && wb.r, cr),
    g: mk(0, -dN, wb && wb.g, cg),
    b: mk(-dT, dN * 0.5, wb && wb.b, cb),
  };
}

function hueMatrix(deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}

/* 톤 패스: LUT + 크로스채널 + 언샵마스크(sharpSrc=블러 사본) 를 한 루프에 융합. */
export function applyTone(src, dst, a, sharpSrc) {
  const lut = buildLUTs(a);
  const mode = a.mode;
  const sat = 1 + a.saturation / 100;
  const vib = a.vibrance / 100;
  const hm = a.hue ? hueMatrix(a.hue) : null;
  const amt = (a.sharpen / 100) * 1.25;
  const s = src.data, d = dst.data;
  const bl = sharpSrc ? sharpSrc.data : null;
  const neutral = mode !== 'none';
  for (let i = 0; i < s.length; i += 4) {
    let r = lut.r[s[i]], g = lut.g[s[i + 1]], b = lut.b[s[i + 2]];
    if (hm) {
      const nr = hm[0] * r + hm[1] * g + hm[2] * b;
      const ng = hm[3] * r + hm[4] * g + hm[5] * b;
      const nb = hm[6] * r + hm[7] * g + hm[8] * b;
      r = nr; g = ng; b = nb;
    }
    if (neutral) {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      if (mode === 'gray') { r = g = b = y; }
      else if (mode === 'sepia') {
        r = y * 1.14 + 20; g = y * 0.98 + 8; b = y * 0.72;
      } else { r = 255 - r; g = 255 - g; b = 255 - b; }
    } else {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      if (sat !== 1) { r = y + (r - y) * sat; g = y + (g - y) * sat; b = y + (b - y) * sat; }
      if (vib !== 0) {
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const f = 1 + vib * (1 - (mx - mn) / 255) * 1.6;
        r = y + (r - y) * f; g = y + (g - y) * f; b = y + (b - y) * f;
      }
      if (bl) {
        r += (r - bl[i]) * amt; g += (g - bl[i + 1]) * amt; b += (b - bl[i + 2]) * amt;
      }
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = s[i + 3];
  }
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/* 파이프라인 전체를 base → target 캔버스에 렌더.
   opts: { straighten(°), maxSize(px), objects(오버레이 캔버스) } */
export function renderTo(target, base, a, opts = {}) {
  const sw = base.width, sh = base.height;
  let w = sw, h = sh, scale = 1;
  if (opts.maxSize && Math.max(sw, sh) > opts.maxSize) {
    scale = opts.maxSize / Math.max(sw, sh);
    w = Math.max(1, Math.round(sw * scale));
    h = Math.max(1, Math.round(sh * scale));
  }
  target.width = w; target.height = h;
  const ctx = target.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';

  const deg = opts.straighten || 0;
  if (deg) {
    const rad = (Math.abs(deg) * Math.PI) / 180;
    const cs = Math.cos(rad), sn = Math.sin(rad);
    const cover = Math.max((sw * cs + sh * sn) / sw, (sw * sn + sh * cs) / sh);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.scale(cover, cover);
    ctx.drawImage(base, -sw / 2, -sh / 2);
    ctx.restore();
  } else {
    ctx.drawImage(base, 0, 0, w, h);
  }

  // 톤 패스 (변경점이 없으면 생략 — 부분 보정·개체는 계속 진행)
  if (!isNeutral(a)) {
    const src = ctx.getImageData(0, 0, w, h);
    const dst = ctx.createImageData(w, h);
    let sharpSrc = null;
    if (a.sharpen > 0) {
      const bc = makeCanvas(w, h);
      const bctx = bc.getContext('2d', { willReadFrequently: true });
      bctx.filter = `blur(${Math.max(1, Math.round(scale < 1 ? 1 : 1.2))}px)`;
      bctx.drawImage(target, 0, 0);
      sharpSrc = bctx.getImageData(0, 0, w, h);
    }
    applyTone(src, dst, a, sharpSrc);
    ctx.putImageData(dst, 0, 0);
  }

  // 소프트 포커스
  if (a.soften > 0) {
    const fc = makeCanvas(w, h);
    const fctx = fc.getContext('2d');
    fctx.filter = `blur(${Math.max(2, Math.round(Math.max(w, h) / 220))}px)`;
    fctx.drawImage(target, 0, 0);
    ctx.save();
    ctx.globalAlpha = (a.soften / 100) * 0.75;
    ctx.drawImage(fc, 0, 0);
    ctx.restore();
  }

  // 블룸: 밝은 부분만 추출(축소본) → 블러 → 스크린 합성
  if (a.bloom > 0) {
    const bw = Math.max(1, Math.round(w / 4)), bh = Math.max(1, Math.round(h / 4));
    const sc = makeCanvas(bw, bh);
    const sctx = sc.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(target, 0, 0, bw, bh);
    const sim = sctx.getImageData(0, 0, bw, bh);
    const sd = sim.data;
    for (let i = 0; i < sd.length; i += 4) {
      const v = Math.max(sd[i], sd[i + 1], sd[i + 2]);
      const t = 168;
      const k = v <= t ? 0 : Math.min(1, (v - t) / (255 - t));
      sd[i] *= k; sd[i + 1] *= k; sd[i + 2] *= k;
    }
    sctx.putImageData(sim, 0, 0);
    const bc = makeCanvas(bw, bh);
    const bctx = bc.getContext('2d');
    bctx.filter = `blur(${Math.max(3, Math.round(bw / 60))}px)`;
    bctx.drawImage(sc, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = (a.bloom / 100) * 0.85;
    ctx.drawImage(bc, 0, 0, w, h);
    ctx.restore();
  }

  // 비네트
  if (a.vignette > 0) {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
    g.addColorStop(0.55, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${(a.vignette / 100) * 0.72})`);
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // 부분 보정 / 아웃포커스 (region 좌표는 base 픽셀 — 미리보기 축적 반영)
  if (a.regions && a.regions.length) applyRegions(target, a.regions, sw);

  // 그리기 개체 오버레이 (톤 보정 영향 없음)
  if (opts.objects) ctx.drawImage(opts.objects, 0, 0, w, h);
  return target;
}

/* regions를 target 캔버스(현재 상태)에 합성. baseW = 원본 base 폭(스케일 환산용).
   engine의 베이크와 renderTo가 함께 쓴다. */
export function applyRegions(target, regions, baseW) {
  const w = target.width, h = target.height;
  const ctx = target.getContext('2d', { willReadFrequently: true });
  const s = w / baseW;
  for (const rg of regions) {
    const cx = rg.cx * s, cy = rg.cy * s, rx = Math.max(2, rg.rx * s), ry = Math.max(2, rg.ry * s);
    const f = Math.max(0.02, Math.min(0.95, 1 - (rg.feather ?? 0.5)));
    if (rg.type === 'adjust') {
      const tmp = makeCanvas(w, h);
      const tctx = tmp.getContext('2d', { willReadFrequently: true });
      tctx.drawImage(target, 0, 0);
      const src = tctx.getImageData(0, 0, w, h);
      const dst = ctx.createImageData(w, h);
      applyTone(src, dst, regionalAdj(rg.params), null);
      tctx.putImageData(dst, 0, 0);
      const maskC = makeCanvas(w, h);
      const mctx = maskC.getContext('2d');
      mctx.drawImage(tmp, 0, 0);
      mctx.globalCompositeOperation = 'destination-in';
      ellipseMask(mctx, cx, cy, rx, ry, f, 'in');
      ctx.drawImage(maskC, 0, 0);
    } else if (rg.type === 'blur') {
      const tmp = makeCanvas(w, h);
      const tctx = tmp.getContext('2d');
      tctx.filter = `blur(${Math.max(2, Math.round((rg.blurPx || 10) * s))}px)`;
      tctx.drawImage(target, 0, 0);
      // 타원 내부를 파내 바깥만 남김 (아웃포커스)
      tctx.globalCompositeOperation = 'destination-out';
      ellipseMask(tctx, cx, cy, rx, ry, f, 'out');
      ctx.drawImage(tmp, 0, 0);
    }
  }
}

function ellipseMask(c, cx, cy, rx, ry, feather, mode) {
  c.save();
  c.translate(cx, cy);
  c.scale(rx, ry);
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  if (mode === 'in') {
    g.addColorStop(feather, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    g.addColorStop(feather, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
  }
  c.fillStyle = g;
  c.fillRect(-1 / rx, -1 / ry, 2 / rx, 2 / ry);
  c.restore();
}

export function isNeutral(a) {
  for (const d of [...TONE_DEFS, ...FX_DEFS]) if (a[d.key] !== d.def) return false;
  if (a.mode !== 'none') return false;
  if (a.wb) return false;
  if (a.curves && (a.curves.m || a.curves.r || a.curves.g || a.curves.b)) return false;
  if (a.levels && (a.levels.b !== 0 || a.levels.w !== 255 || a.levels.mid !== 1)) return false;
  return true;
}

/* 부분 보정 영역에 적용할 지역 톤 adj (전역 adj와 무관한 부분집합) */
export function regionalAdj(p = {}) {
  return {
    ...defaultAdj(),
    exposure: p.exposure || 0,
    brightness: p.brightness || 0,
    contrast: p.contrast || 0,
    saturation: p.saturation || 0,
  };
}

/* ---------- 지오메트리 연산 (새 base 캔버스 반환) ---------- */

export function rotate90(base, dir) {
  const c = makeCanvas(base.height, base.width);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(dir === 'cw' ? Math.PI / 2 : -Math.PI / 2);
  ctx.drawImage(base, -base.width / 2, -base.height / 2);
  return c;
}

export function flipBase(base, axis) {
  const c = makeCanvas(base.width, base.height);
  const ctx = c.getContext('2d');
  ctx.translate(axis === 'h' ? base.width : 0, axis === 'v' ? base.height : 0);
  ctx.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1);
  ctx.drawImage(base, 0, 0);
  return c;
}

export function cropBase(base, rect, circle = false) {
  const c = makeCanvas(Math.round(rect.w), Math.round(rect.h));
  const ctx = c.getContext('2d');
  if (circle) {
    ctx.beginPath();
    ctx.ellipse(c.width / 2, c.height / 2, c.width / 2, c.height / 2, 0, 0, Math.PI * 2);
    ctx.clip();
  }
  ctx.drawImage(base, -Math.round(rect.x), -Math.round(rect.y));
  return c;
}

export function straightenCanvas(base, deg) {
  const c = makeCanvas(base.width, base.height);
  renderTo(c, base, defaultAdj(), { straighten: deg });
  return c;
}

export function resizeBase(base, w, h) {
  // 큰 축소는 단계별 축소로 계단 현상 방지
  let cur = base;
  while (cur.width > w * 2 && cur.height > h * 2) {
    const half = makeCanvas(Math.max(1, Math.ceil(cur.width / 2)), Math.max(1, Math.ceil(cur.height / 2)));
    const hctx = half.getContext('2d');
    hctx.imageSmoothingQuality = 'high';
    hctx.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const c = makeCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, c.width, c.height);
  return c;
}

export function padBase(base, pads, color) {
  const [t, r, b, l] = pads;
  const c = makeCanvas(base.width + l + r, base.height + t + b);
  const ctx = c.getContext('2d');
  if (color) { ctx.fillStyle = color; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.drawImage(base, l, t);
  return c;
}

/* 자동 레벨/명암: 히스토그램 양끝 0.4% 클리핑 스트레칭.
   plan = { r:[lo,hi], g:[lo,hi], b:[lo,hi] } — 자동 명암은 세 채널 동일값(휘도 기준). */
export function computeLevelsPlan(base, perChannel) {
  const ctx = base.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = base;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const hists = perChannel
    ? [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
    : [new Uint32Array(256)];
  for (let i = 0; i < d.length; i += 4) {
    if (perChannel) {
      hists[0][d[i]]++; hists[1][d[i + 1]]++; hists[2][d[i + 2]]++;
    } else {
      hists[0][Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
    }
  }
  const clip = n * 0.004;
  const range = (hist) => {
    let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > clip) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > clip) { hi = i; break; } }
    if (hi - lo < 16) return null;
    return [lo, hi];
  };
  if (perChannel) {
    return { r: range(hists[0]), g: range(hists[1]), b: range(hists[2]) };
  }
  const rg = range(hists[0]);
  return { r: rg, g: rg, b: rg };
}

export function bakeLevels(base, plan) {
  const luts = ['r', 'g', 'b'].map((k) => {
    const lut = new Uint8ClampedArray(256);
    const p = plan[k];
    if (!p) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
    const [lo, hi] = p;
    const gain = 255 / (hi - lo);
    for (let i = 0; i < 256; i++) lut[i] = Math.round((i - lo) * gain);
    return lut;
  });
  const c = makeCanvas(base.width, base.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(base, 0, 0);
  const img = ctx.getImageData(0, 0, base.width, base.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = luts[0][d[i]]; d[i + 1] = luts[1][d[i + 1]]; d[i + 2] = luts[2][d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
