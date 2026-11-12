// A small RGBA toolkit for the TUI's artwork: decoding, resampling, effects,
// and the generated pieces (timeline, stack, record, turntable).
// An image is { w, h, data: Uint8ClampedArray(w * h * 4) }. Pure, so the
// frame worker and the tests can use it too.

export const blank = (w, h, rgba) => {
  const data = new Uint8ClampedArray(w * h * 4);
  if (rgba) for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { w, h, data };
};

// A BMP as macOS's sips writes it: 24- or 32-bit, either row order.
export function decodeBMP(buf) {
  if (buf.toString('latin1', 0, 2) !== 'BM') throw new Error('Not a BMP');
  const off = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  const rawH = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) throw new Error(`Unsupported BMP depth ${bpp}`);
  const h = Math.abs(rawH);
  const step = bpp / 8;
  const stride = Math.ceil((w * step) / 4) * 4;
  const img = blank(w, h);
  for (let y = 0; y < h; y++) {
    const row = off + (rawH < 0 ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const p = row + x * step;
      const o = (y * w + x) * 4;
      img.data[o] = buf[p + 2];
      img.data[o + 1] = buf[p + 1];
      img.data[o + 2] = buf[p];
      img.data[o + 3] = step === 4 ? buf[p + 3] : 255;
    }
  }
  return img;
}

export function sample(img, fx, fy) {
  const x0 = Math.max(0, Math.min(img.w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(img.h - 1, Math.floor(fy)));
  const x1 = Math.min(img.w - 1, x0 + 1);
  const y1 = Math.min(img.h - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const d = img.data;
  const a = (y0 * img.w + x0) * 4;
  const b = (y0 * img.w + x1) * 4;
  const c = (y1 * img.w + x0) * 4;
  const e = (y1 * img.w + x1) * 4;
  const px = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const top = d[a + k] * (1 - tx) + d[b + k] * tx;
    const bottom = d[c + k] * (1 - tx) + d[e + k] * tx;
    px[k] = top * (1 - ty) + bottom * ty;
  }
  return px;
}

// The source rect (sx, sy, sw, sh) scaled to dw x dh, bilinearly.
export function resample(img, sx, sy, sw, sh, dw, dh) {
  const out = blank(dw, dh);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++)
      out.data.set(
        sample(img, sx + ((x + 0.5) * sw) / dw - 0.5, sy + ((y + 0.5) * sh) / dh - 0.5),
        (y * dw + x) * 4,
      );
  return out;
}

// Scaled to fill dw x dh, cropping the middle, like CSS object-fit: cover.
export function cover(img, dw, dh) {
  let sw = img.w;
  let sh = img.h;
  if (sw / sh > dw / dh) sw = (sh * dw) / dh;
  else sh = (sw * dh) / dw;
  return resample(img, (img.w - sw) / 2, (img.h - sh) / 2, sw, sh, dw, dh);
}

export function crop(img, x, y, w, h) {
  const out = blank(w, h);
  for (let r = 0; r < h; r++) {
    const from = ((y + r) * img.w + x) * 4;
    out.data.set(img.data.subarray(from, from + w * 4), r * w * 4);
  }
  return out;
}

export function map(img, fn) {
  const out = blank(img.w, img.h);
  const d = img.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++)
    out.data.set(fn(d[i], d[i + 1], d[i + 2], d[i + 3], p % img.w, Math.floor(p / img.w)), i);
  return out;
}

// A soft blur: shrink hard, smooth, then double back up a step at a time.
export function blur(img, factor = 24) {
  const sw = Math.max(2, Math.round(img.w / factor));
  const sh = Math.max(2, Math.round(img.h / factor));
  let cur = resample(img, 0, 0, img.w, img.h, sw, sh);
  const small = cur;
  cur = map(small, (r, g, b, a, x, y) => {
    const acc = [0, 0, 0, 0];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const px = sample(small, x + dx, y + dy);
        for (let k = 0; k < 4; k++) acc[k] += px[k] / 9;
      }
    return acc;
  });
  while (cur.w * 2 < img.w) cur = resample(cur, 0, 0, cur.w, cur.h, cur.w * 2, Math.min(img.h, cur.h * 2));
  return resample(cur, 0, 0, cur.w, cur.h, img.w, img.h);
}

export const darken = (img, k) => map(img, (r, g, b, a) => [r * k, g * k, b * k, a]);

// Alpha-composites src onto dst at (dx, dy), in place.
export function draw(dst, src, dx, dy, alpha = 1) {
  for (let y = Math.max(0, -dy); y < src.h && y + dy < dst.h; y++) {
    for (let x = Math.max(0, -dx); x < src.w && x + dx < dst.w; x++) {
      const s = (y * src.w + x) * 4;
      const d = ((y + dy) * dst.w + x + dx) * 4;
      const a = (src.data[s + 3] / 255) * alpha;
      if (!a) continue;
      const da = dst.data[d + 3] / 255;
      const oa = a + da * (1 - a);
      for (let k = 0; k < 3; k++)
        dst.data[d + k] = (src.data[s + k] * a + dst.data[d + k] * da * (1 - a)) / oa;
      dst.data[d + 3] = oa * 255;
    }
  }
  return dst;
}

export const rect = (dst, x, y, w, h, rgba) =>
  w > 0 && h > 0 ? draw(dst, blank(Math.round(w), Math.round(h), rgba), Math.round(x), Math.round(y)) : dst;

// Paints pixels within `reach` of (cx, cy) by coverage(x, y), 0..1.
function paint(dst, x0, y0, x1, y1, rgba, coverage) {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(dst.h, Math.ceil(y1)); y++)
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(dst.w, Math.ceil(x1)); x++) {
      const k = coverage(x + 0.5, y + 0.5);
      if (k <= 0) continue;
      const a = (rgba[3] / 255) * Math.min(1, k);
      const d = (y * dst.w + x) * 4;
      const da = dst.data[d + 3] / 255;
      const oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) dst.data[d + c] = (rgba[c] * a + dst.data[d + c] * da * (1 - a)) / oa;
      dst.data[d + 3] = oa * 255;
    }
  return dst;
}

export const disc = (dst, cx, cy, r, rgba) =>
  paint(
    dst,
    cx - r - 1,
    cy - r - 1,
    cx + r + 1,
    cy + r + 1,
    rgba,
    (x, y) => r - Math.hypot(x - cx, y - cy) + 0.5,
  );

// A thick, anti-aliased segment.
export function line(dst, ax, ay, bx, by, width, rgba) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const pad = width / 2 + 1;
  return paint(
    dst,
    Math.min(ax, bx) - pad,
    Math.min(ay, by) - pad,
    Math.max(ax, bx) + pad,
    Math.max(ay, by) + pad,
    rgba,
    (x, y) => {
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      return width / 2 - Math.hypot(x - ax - t * dx, y - ay - t * dy) + 0.5;
    },
  );
}

export function rounded(img, r) {
  return map(img, (R, G, B, A, x, y) => {
    const cx = x < r ? r : x >= img.w - r ? img.w - r - 1 : x;
    const cy = y < r ? r : y >= img.h - r ? img.h - r - 1 : y;
    return [R, G, B, A * Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5))];
  });
}

export function frame(img, px, rgba) {
  const out = draw(blank(img.w, img.h), img, 0, 0);
  rect(out, 0, 0, img.w, px, rgba);
  rect(out, 0, img.h - px, img.w, px, rgba);
  rect(out, 0, px, px, img.h - 2 * px, rgba);
  rect(out, img.w - px, px, px, img.h - 2 * px, rgba);
  return out;
}

// --- color -------------------------------------------------------------------

export function hsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    if (max === r) h = ((g - b) / (max - min)) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, max ? (max - min) / max : 0, max / 255];
}

// The image's colors, most characterful first: [[r, g, b], ...].
export function palette(img, n = 5) {
  const buckets = new Map();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += d[i];
    e.g += d[i + 1];
    e.b += d[i + 2];
    buckets.set(key, e);
  }
  const colors = [...buckets.values()]
    .map((e) => {
      const c = [e.r / e.n, e.g / e.n, e.b / e.n].map(Math.round);
      const [, s, v] = hsv(...c);
      return { c, score: e.n * (0.15 + s ** 1.5) * (0.2 + v) };
    })
    .sort((a, b) => b.score - a.score);
  const picked = [];
  for (const { c } of colors) {
    if (picked.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) > 60)) picked.push(c);
    if (picked.length === n) break;
  }
  return picked;
}

// An accent that reads on a dark terminal: the palette's liveliest color,
// lifted if it's dim. Null for a grey image, so callers keep their default.
export function accent(img) {
  const best = palette(img, 6).find((c) => hsv(...c)[1] > 0.3 && hsv(...c)[2] > 0.3);
  if (!best) return null;
  const v = hsv(...best)[2];
  const lift = v < 0.75 ? 0.75 / v : 1;
  return best.map((x) => Math.min(255, Math.round(x * lift)));
}

export const hex = (c) => `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;

// --- generated pieces ----------------------------------------------------------

const GROOVE = [60, 60, 60, 255];
const SHADES = [
  [96, 96, 96, 255],
  [78, 78, 78, 255],
];

// The episode as a strip: a block per listed track, the played part lit in
// `color`, a playhead, and optionally one track (`focus`) highlighted.
export function timeline(
  w,
  h,
  { dur, pos = 0, tracks = [], color = [90, 200, 120], focus = -1, head = true },
) {
  const img = blank(w, h);
  const barH = Math.max(3, Math.round(h * 0.42));
  const y0 = Math.round((h - barH) / 2);
  const X = (t) => (dur > 0 ? Math.round((Math.min(t, dur) / dur) * w) : 0);
  rect(img, 0, y0, w, barH, GROOVE);
  const segs = tracks.length ? tracks : [{ offset: 0 }];
  segs.forEach((t, i) => {
    const a = X(t.offset);
    const b = i + 1 < segs.length ? X(segs[i + 1].offset) : t.duration ? X(t.offset + t.duration) : w;
    const lit = i % 2 ? color.map((c) => c * 0.82) : color;
    rect(img, a, y0, b - a - 1, barH, SHADES[i % 2]);
    const played = Math.min(b, X(pos));
    if (played > a) rect(img, a, y0, played - a - (played === b ? 1 : 0), barH, [...lit, 255]);
    if (i === focus) {
      rect(img, a, 0, Math.max(2, b - a - 1), h, [...color, 80]);
      rect(img, a, y0, Math.max(2, b - a - 1), barH, [...color, 255]);
    }
  });
  if (head && dur > 0) rect(img, Math.min(w - 2, Math.max(0, X(pos) - 1)), 0, 2, h, [255, 255, 255, 255]);
  return img;
}

// The side panel's stack: covers behind, up and to the right, dimmer each step.
export function stack(covers, size) {
  const n = Math.min(3, covers.length);
  const step = Math.round(size * 0.06);
  const out = blank(size + step * (n - 1), size + step * (n - 1));
  for (let i = n - 1; i >= 0; i--) {
    let c = cover(covers[i], size, size);
    if (i) c = frame(darken(c, i === 1 ? 0.55 : 0.35), 1, [119, 119, 119, 255]);
    draw(out, rounded(c, Math.round(size * 0.03)), step * i, step * (n - 1 - i));
  }
  return out;
}

export const LABEL = 0.62; // the label's share of the record's radius

// Paints the label (the cover, turned by `turn`, 0..1) onto a record centred
// at (cx, cy), in place, leaving the spindle hole alone.
export function turnLabel(img, art, cx, cy, labelR, holeR, turn) {
  const cos = Math.cos(-turn * Math.PI * 2);
  const sin = Math.sin(-turn * Math.PI * 2);
  const x0 = Math.max(0, Math.floor(cx - labelR));
  const y0 = Math.max(0, Math.floor(cy - labelR));
  for (let y = y0; y < Math.min(img.h, Math.ceil(cy + labelR)); y++) {
    for (let x = x0; x < Math.min(img.w, Math.ceil(cx + labelR)); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d >= labelR || d < holeR) continue;
      const sx = (dx * cos - dy * sin) / labelR;
      const sy = (dx * sin + dy * cos) / labelR;
      const px = sample(art, ((sx + 1) / 2) * (art.w - 1), ((sy + 1) / 2) * (art.h - 1));
      const ring = Math.max(0, Math.min(1, labelR - d)); // a dark edge where it meets the grooves
      const o = (y * img.w + x) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = px[k] * ring + 18 * (1 - ring);
      img.data[o + 3] = 255;
    }
  }
  return img;
}

// A record `size` across with the cover as its label, turned by `turn` (0..1).
// Only the label changes as it turns; the grooves and their sheen stay put.
export function vinyl(art, size, turn = 0) {
  const out = blank(size, size);
  const R = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - R;
      const dy = y + 0.5 - R;
      const d = Math.hypot(dx, dy);
      const edge = Math.max(0, Math.min(1, R - d));
      if (!edge || d < R * 0.035) continue;
      const groove = 18 + 10 * (Math.sin(d * 1.7) > 0.6) + 6 * (d > R * 0.95);
      const sheen = Math.max(0, Math.cos(Math.atan2(dy, dx) * 2 - 0.8)) ** 6 * 38;
      out.data.set([groove + sheen, groove + sheen, groove + sheen + 2, 255 * edge], (y * size + x) * 4);
    }
  }
  return turnLabel(out, art, R, R, R * LABEL, R * 0.035, turn);
}

const box = (cx, cy, r, minX = 0) => {
  const x = Math.max(minX, Math.floor(cx - r));
  const y = Math.floor(cy - r);
  return { x, y, w: Math.ceil(cx + r) - x, h: Math.ceil(cy + r) - y };
};

// The turntable: platter, record, and on the right the tonearm's pivot.
// `moving` is the label's box: all that changes as the record turns.
export function deckLayout(S) {
  const R = S * 0.45;
  const cx = S * 0.5;
  const cy = S * 0.5;
  return {
    w: Math.round(S * 1.2),
    h: S,
    R,
    cx,
    cy,
    pivot: { x: cx + 1.25 * R, y: cy - 0.75 * R },
    arm: 1.05 * R,
    moving: box(cx, cy, R * LABEL),
  };
}

// Where the record lies on the deck, rounded to whole pixels as it's drawn.
export function deckRecord(S) {
  const L = deckLayout(S);
  const size = Math.round(L.R * 2);
  const x = Math.round(L.cx - L.R);
  const y = Math.round(L.cy - L.R);
  const R = size / 2;
  return { size, x, y, cx: x + R, cy: y + R, labelR: R * LABEL, holeR: R * 0.035 };
}

export function deck(art, S, turn = 0) {
  const L = deckLayout(S);
  const rec = deckRecord(S);
  const out = blank(L.w, L.h);
  disc(out, L.cx, L.cy, L.R * 1.05, [24, 24, 26, 255]);
  disc(out, L.cx, L.cy, L.R * 1.03, [34, 34, 37, 255]);
  return draw(out, vinyl(art, rec.size, turn), rec.x, rec.y);
}

// Where the stylus sits after `t` (0..1) of the side: it starts at the outer
// groove and ends just short of the label (far enough that the headshell
// never covers it, since only the label is redrawn as the record turns).
export const STOP = 1.14;
export function stylus(L, t) {
  const r = L.R * 0.93 - Math.max(0, Math.min(1, t)) * (L.R * 0.93 - L.R * LABEL * STOP);
  const px = L.pivot.x - L.cx;
  const py = L.pivot.y - L.cy;
  const d = Math.hypot(px, py);
  const a = (r * r - L.arm * L.arm + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r * r - a * a));
  const bx = L.cx + (a * px) / d;
  const by = L.cy + (a * py) / d;
  // of the two places the arm can reach that groove, the one on the right
  const one = { x: bx + (h * py) / d, y: by - (h * px) / d };
  const two = { x: bx - (h * py) / d, y: by + (h * px) / d };
  return one.x > two.x ? one : two;
}

export function tonearm(S, t) {
  const L = deckLayout(S);
  const out = blank(L.w, L.h);
  const p = L.pivot;
  const s = stylus(L, t);
  const ux = (s.x - p.x) / L.arm;
  const uy = (s.y - p.y) / L.arm;
  const k = L.R;
  disc(out, p.x, p.y, k * 0.16, [20, 20, 22, 220]);
  disc(out, p.x, p.y, k * 0.11, [70, 70, 74, 255]);
  // counterweight behind the pivot
  line(out, p.x, p.y, p.x - ux * k * 0.28, p.y - uy * k * 0.28, k * 0.1, [55, 55, 58, 255]);
  line(
    out,
    p.x - ux * k * 0.2,
    p.y - uy * k * 0.2,
    p.x - ux * k * 0.34,
    p.y - uy * k * 0.34,
    k * 0.16,
    [90, 90, 94, 255],
  );
  // the arm's shadow, then the arm, then the headshell at the stylus
  line(out, p.x + k * 0.03, p.y + k * 0.04, s.x + k * 0.03, s.y + k * 0.04, k * 0.05, [0, 0, 0, 90]);
  line(out, p.x, p.y, s.x - ux * k * 0.1, s.y - uy * k * 0.1, k * 0.035, [200, 200, 204, 255]);
  line(out, s.x - ux * k * 0.16, s.y - uy * k * 0.16, s.x, s.y, k * 0.08, [225, 225, 228, 255]);
  disc(out, p.x, p.y, k * 0.05, [210, 210, 214, 255]);
  return out;
}

// The whole turntable with its arm `t` (0..1) of the way through the side
// and the label turned by `turn`.
export function turntable(art, S, t, turn = 0) {
  const img = draw(deck(art, S, 0), tonearm(S, t), 0, 0);
  return turn ? turnLabelOf(img, art, S, turn) : img;
}

// Repaints just the label of a turntable image (or a crop of one starting at
// x0, y0) at a new angle.
export function turnLabelOf(img, art, S, turn, x0 = 0, y0 = 0) {
  const rec = deckRecord(S);
  return turnLabel(img, art, rec.cx - x0, rec.cy - y0, rec.labelR, rec.holeR, turn);
}
