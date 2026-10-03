/* gifenc.js — GIF89a 인코더 (의존성 0).
   프레임 RGBA → median-cut 256색 양자화(프레임별 로컬 팔레트) → LZW → GIF 바이트열.
   frames: [{ data: Uint8ClampedArray(RGBA), width, height }], opts: { delayMs, repeat }
   repeat: 0=무한, 1=1회(루프 확장 없음), N≥2 → N-1회 반복. */

/* ---------- median-cut 양자화 ---------- */

function medianCutPalette(samples, maxColors = 256) {
  // samples: Uint8Array [r,g,b, ...] (stride 3)
  const idx = [];
  for (let i = 0; i < samples.length / 3; i++) idx.push(i);
  let boxes = [{ idx }];

  const rangeOf = (box) => {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (const i of box.idx) {
      const o = i * 3;
      const r = samples[o], g = samples[o + 1], b = samples[o + 2];
      if (r < rMin) rMin = r; if (r > rMax) rMax = r;
      if (g < gMin) gMin = g; if (g > gMax) gMax = g;
      if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    }
    const dr = rMax - rMin, dg = gMax - gMin, db = bMax - bMin;
    const ch = dr >= dg && dr >= db ? 0 : dg >= db ? 1 : 2;
    return { ch, range: Math.max(dr, dg, db) };
  };

  while (boxes.length < maxColors) {
    // 가장 큰 범위의(그리고 픽셀 수가 1보다 많은) 박스를 고른다
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].idx.length < 2) continue;
      const { range } = rangeOf(boxes[i]);
      const score = range * boxes[i].idx.length;
      if (score > best) { best = score; bi = i; }
    }
    if (bi < 0 || best <= 0) break;
    const box = boxes[bi];
    const { ch } = rangeOf(box);
    const sorted = [...box.idx].sort((a, b) => samples[a * 3 + ch] - samples[b * 3 + ch]);
    const mid = sorted.length >> 1;
    boxes.splice(bi, 1, { idx: sorted.slice(0, mid) }, { idx: sorted.slice(mid) });
  }

  const palette = [];
  for (const box of boxes) {
    let r = 0, g = 0, b = 0;
    for (const i of box.idx) {
      r += samples[i * 3]; g += samples[i * 3 + 1]; b += samples[i * 3 + 2];
    }
    const n = box.idx.length || 1;
    palette.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
  }
  return palette;
}

function quantize(data, width, height) {
  // 픽셀 샘플링(최대 60000개)으로 팔레트 생성
  const total = width * height;
  const stride = Math.max(1, Math.floor(total / 60000));
  const samples = new Uint8Array(Math.ceil(total / stride) * 3);
  let n = 0;
  for (let i = 0; i < total; i += stride) {
    const o = i * 4;
    samples[n++] = data[o]; samples[n++] = data[o + 1]; samples[n++] = data[o + 2];
  }
  const palette = medianCutPalette(samples.subarray(0, n));
  // 픽셀 → 팔레트 인덱스 (캐시로 중복 탐색 제거)
  const cache = new Map();
  const indexed = new Uint8Array(total);
  const pal = palette;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
    let idx = cache.get(key);
    if (idx === undefined) {
      let best = 0, bestD = Infinity;
      for (let j = 0; j < pal.length; j++) {
        const dr = data[o] - pal[j][0], dg = data[o + 1] - pal[j][1], db = data[o + 2] - pal[j][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = j; }
      }
      idx = best;
      cache.set(key, idx);
    }
    indexed[i] = idx;
  }
  return { indexed, palette };
}

/* ---------- LZW ---------- */

function lzwEncode(indexed, minCodeSize = 8) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;

  const out = [];
  let cur = 0, curBits = 0;
  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      out.push(cur & 0xff);
      cur >>>= 8;
      curBits -= 8;
    }
  };

  let dict = new Map();
  emit(clear);
  let ib = indexed[0];
  for (let i = 1; i < indexed.length; i++) {
    const k = indexed[i];
    const key = (ib << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      ib = found;
    } else {
      emit(ib);
      if (next < 4096) {
        dict.set(key, next);
        if (next === 1 << codeSize && codeSize < 12) codeSize++;
        next++;
      } else {
        emit(clear);
        dict = new Map();
        codeSize = minCodeSize + 1;
        next = eoi + 1;
      }
      ib = k;
    }
  }
  emit(ib);
  emit(eoi);
  if (curBits > 0) out.push(cur & 0xff);
  return Uint8Array.from(out);
}

/* ---------- GIF 조립 ---------- */

function pushSubBlocks(parts, bytes) {
  for (let i = 0; i < bytes.length; i += 255) {
    const end = Math.min(bytes.length, i + 255);
    parts.push(end - i);
    for (let j = i; j < end; j++) parts.push(bytes[j]);
  }
  parts.push(0);
}

export function encodeGIF(frames, { delayMs = 200, repeat = 0 } = {}) {
  if (!frames.length) throw new Error('프레임이 없습니다');
  const delay = Math.max(2, Math.round(delayMs / 10));
  const parts = [];

  const push = (...bytes) => parts.push(...bytes);
  const push16 = (v) => push(v & 0xff, (v >> 8) & 0xff);

  // 헤더 + 논리 화면 기술자 (GCT 없음 — 프레임별 로컬 팔레트)
  push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // GIF89a
  const w = frames[0].width, h = frames[0].height;
  push16(w); push16(h);
  push(0x70, 0, 0);

  // 넷스케이프 반복 확장 (repeat 1 = 루프 없음)
  if (repeat !== 1) {
    const loops = repeat === 0 ? 0 : Math.max(0, repeat - 1);
    push(0x21, 0xff, 0x0b);
    for (const ch of 'NETSCAPE2.0') push(ch.charCodeAt(0));
    push(0x03, 0x01);
    push16(loops);
    push(0x00);
  }

  for (const frame of frames) {
    // 그래픽 제어 확장
    push(0x21, 0xf9, 0x04, 0x00);
    push16(delay);
    push(0x00, 0x00);
    // 이미지 기술자 + 로컬 팔레트
    const { indexed, palette } = quantize(frame.data, frame.width, frame.height);
    let bits = 1;
    while ((1 << bits) < palette.length) bits++;
    const tableSize = 1 << bits;
    push(0x2c);
    push16(0); push16(0); push16(frame.width); push16(frame.height);
    push(0x80 | (bits - 1));
    for (let i = 0; i < tableSize; i++) {
      const c = palette[Math.min(i, palette.length - 1)] || [0, 0, 0];
      push(c[0], c[1], c[2]);
    }
    push(8); // LZW 최소 코드 크기
    pushSubBlocks(parts, lzwEncode(indexed, 8));
  }

  push(0x3b); // 트레일러
  return new Blob([Uint8Array.from(parts)], { type: 'image/gif' });
}
