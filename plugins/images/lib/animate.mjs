/**
 * Animated GIFs from a still-image model. The model draws one sprite sheet — a
 * grid of frames of the same scene — and this module cuts it into frames and
 * encodes them as a looping GIF. Pure JavaScript: PNG is decoded with zlib, and
 * other formats go through `sharp` when the Harness has it.
 *
 * @module @kadaliao/dsh-images/lib/animate
 */

import { inflateSync } from 'node:zlib';

/** Frame counts a sheet can hold, with their grid and the sheet size to ask for. */
export const LAYOUTS = [
  { frames: 4, cols: 2, rows: 2, size: '1024x1024' },
  { frames: 6, cols: 3, rows: 2, size: '1536x1024' },
  { frames: 9, cols: 3, rows: 3, size: '1024x1024' },
  { frames: 16, cols: 4, rows: 4, size: '1024x1024' },
];

/** Longest side of a GIF frame, in pixels. */
export const FRAME_MAX = 480;
/** Default time each frame is shown. */
export const DEFAULT_FRAME_MS = 100;

/** The layout for a requested frame count: the nearest one, ties to more frames. */
export function layoutFor(frames) {
  const n = Number(frames);
  if (!Number.isFinite(n) || n <= 1) return undefined;
  let best = LAYOUTS[0];
  for (const l of LAYOUTS) if (Math.abs(l.frames - n) <= Math.abs(best.frames - n)) best = l;
  return best;
}

/** A per-frame delay in ms, clamped to what GIF viewers honour. */
export function frameDelay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FRAME_MS;
  return Math.min(1000, Math.max(40, Math.round(n / 10) * 10));
}

/** The prompt that asks for a sprite sheet of `prompt` in `layout`. */
export function sheetPrompt(prompt, layout) {
  const { cols, rows, frames } = layout;
  return [
    `A sprite sheet for a smooth looping animation: a ${cols}x${rows} grid of ${frames} equally sized frames, edge to edge, with no borders, gutters, margins, labels, numbers or text between them.`,
    `Frames are read left to right, top to bottom; each one is the next moment of the same continuous motion, and the last frame leads back into the first so the loop is seamless.`,
    `Every frame uses the same fixed camera, framing, background, lighting, palette and character design; only the motion described below changes between frames, in small even steps.`,
    `Animation: ${prompt}`,
  ].join('\n');
}

// --- decoding ------------------------------------------------------------------

/**
 * RGBA pixels of a PNG (8- or 16-bit; grey, RGB, palette, with or without alpha;
 * not interlaced).
 * @param {Uint8Array} bytes
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette;
  let trns;
  const idat = [];
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const name = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (name === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (name === 'PLTE') palette = body;
    else if (name === 'tRNS') trns = body;
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    at += 12 + len;
  }
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || (depth !== 8 && depth !== 16) || (type === 3 && depth !== 8)) throw new Error(`unsupported PNG (type ${type}, depth ${depth})`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  const lines = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = lines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }
  const data = new Uint8Array(width * height * 4);
  const step = depth / 8;
  for (let i = 0, p = 0; i < width * height; i += 1, p += bpp) {
    const s = (k) => lines[p + k * step];
    let r;
    let g;
    let b;
    let alpha = 255;
    if (type === 0) {
      r = g = b = s(0);
      if (trns && trns.length >= 2 && depth === 8 && s(0) === trns[1]) alpha = 0;
    } else if (type === 2) {
      r = s(0);
      g = s(1);
      b = s(2);
    } else if (type === 3) {
      const idx = lines[p];
      r = palette?.[idx * 3] ?? 0;
      g = palette?.[idx * 3 + 1] ?? 0;
      b = palette?.[idx * 3 + 2] ?? 0;
      if (trns && idx < trns.length) alpha = trns[idx];
    } else if (type === 4) {
      r = g = b = s(0);
      alpha = s(1);
    } else {
      r = s(0);
      g = s(1);
      b = s(2);
      alpha = s(3);
    }
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = alpha;
  }
  return { width, height, data };
}

/**
 * RGBA pixels of any image the provider returns: PNG here, anything else
 * through `sharp` when it can be loaded.
 */
export async function decodeImage(bytes, mediaType) {
  if (mediaType === 'image/png') return decodePng(bytes);
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    throw new Error(`the image model returned ${mediaType ?? 'an unknown format'}; making a GIF from it needs PNG output (or the sharp module)`);
  }
  const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

// --- frames --------------------------------------------------------------------

/** An area-averaged crop-and-scale of an RGBA image, flattened onto white. */
function resample(img, sx, sy, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 3);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const y0 = sy + y * fy;
    const y1 = y0 + fy;
    for (let x = 0; x < dw; x += 1) {
      const x0 = sx + x * fx;
      const x1 = x0 + fx;
      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy += 1) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0 || yy < 0 || yy >= img.height) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx += 1) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (wx <= 0 || xx < 0 || xx >= img.width) continue;
          const w = wx * wy;
          const p = (yy * img.width + xx) * 4;
          const a = img.data[p + 3] / 255;
          r += w * (img.data[p] * a + 255 * (1 - a));
          g += w * (img.data[p + 1] * a + 255 * (1 - a));
          b += w * (img.data[p + 2] * a + 255 * (1 - a));
          wsum += w;
        }
      }
      const o = (y * dw + x) * 3;
      out[o] = wsum ? Math.round(r / wsum) : 255;
      out[o + 1] = wsum ? Math.round(g / wsum) : 255;
      out[o + 2] = wsum ? Math.round(b / wsum) : 255;
    }
  }
  return out;
}

/**
 * The frames of a sheet, each cell trimmed by a small inset (to drop seams the
 * model leaves between cells) and scaled to fit `maxSide`.
 * @returns {{width: number, height: number, frames: Uint8Array[]}} RGB frames.
 */
export function sliceFrames(img, layout, maxSide = FRAME_MAX) {
  const cw = img.width / layout.cols;
  const ch = img.height / layout.rows;
  const inset = Math.max(1, Math.round(Math.min(cw, ch) * 0.015));
  const sw = cw - 2 * inset;
  const sh = ch - 2 * inset;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  const frames = [];
  for (let r = 0; r < layout.rows; r += 1) {
    for (let c = 0; c < layout.cols; c += 1) {
      frames.push(resample(img, c * cw + inset, r * ch + inset, sw, sh, width, height));
    }
  }
  return { width, height, frames };
}

// --- GIF encoding --------------------------------------------------------------

/**
 * A palette of up to 256 colours for all frames by median cut over a 15-bit
 * histogram, and a 15-bit lookup into it.
 */
function buildPalette(frames) {
  const hist = new Uint32Array(32768);
  for (const f of frames) for (let i = 0; i < f.length; i += 3) hist[((f[i] >> 3) << 10) | ((f[i + 1] >> 3) << 5) | (f[i + 2] >> 3)] += 1;
  const colors = [];
  for (let k = 0; k < 32768; k += 1) if (hist[k] > 0) colors.push(k);
  const comp = (k, ch) => (ch === 0 ? k >> 10 : ch === 1 ? (k >> 5) & 31 : k & 31);
  let boxes = [colors];
  while (boxes.length < 256) {
    // Split the box with the most pixels that still has more than one colour.
    let pick = -1;
    let most = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i].length < 2) continue;
      let count = 0;
      for (const k of boxes[i]) count += hist[k];
      if (count > most) {
        most = count;
        pick = i;
      }
    }
    if (pick === -1) break;
    const box = boxes[pick];
    let ch = 0;
    let span = -1;
    for (let c = 0; c < 3; c += 1) {
      let lo = 31;
      let hi = 0;
      for (const k of box) {
        const v = comp(k, c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > span) {
        span = hi - lo;
        ch = c;
      }
    }
    box.sort((a, b) => comp(a, ch) - comp(b, ch));
    let half = most / 2;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i += 1) {
      half -= hist[box[i]];
      if (half <= 0) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    boxes = [...boxes.slice(0, pick), box.slice(0, cut), box.slice(cut), ...boxes.slice(pick + 1)];
  }
  const palette = [];
  for (const box of boxes) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const k of box) {
      const w = hist[k];
      r += w * ((comp(k, 0) << 3) | 4);
      g += w * ((comp(k, 1) << 3) | 4);
      b += w * ((comp(k, 2) << 3) | 4);
      n += w;
    }
    if (n > 0) palette.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
  }
  if (palette.length === 0) palette.push([0, 0, 0]);
  const lookup = new Uint8Array(32768);
  for (let k = 0; k < 32768; k += 1) {
    const r = (comp(k, 0) << 3) | 4;
    const g = (comp(k, 1) << 3) | 4;
    const b = (comp(k, 2) << 3) | 4;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i += 1) {
      const p = palette[i];
      const d = (p[0] - r) ** 2 * 2 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 3;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    lookup[k] = best;
  }
  return { palette, lookup };
}

// An ordered (Bayer) dither: unlike error diffusion it does not shimmer between frames.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v / 16 - 0.5) * 8);

function indexFrame(frame, width, height, lookup) {
  const out = new Uint8Array(width * height);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const d = BAYER[(y & 3) * 4 + (x & 3)];
      const r = clamp(frame[i * 3] + d) >> 3;
      const g = clamp(frame[i * 3 + 1] + d) >> 3;
      const b = clamp(frame[i * 3 + 2] + d) >> 3;
      out[i] = lookup[(r << 10) | (g << 5) | b];
    }
  }
  return out;
}

/** GIF LZW of one frame's indices, as data sub-blocks. */
function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const bytes = [];
  let acc = 0;
  let bits = 0;
  let size = minCodeSize + 1;
  const emit = (code) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      bytes.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };
  let dict = new Map();
  let next = eoi + 1;
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next);
      next += 1;
      if (next > 1 << size && size < 12) size += 1;
    } else {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      size = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) bytes.push(acc & 0xff);
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

/**
 * A looping GIF of RGB frames, one shared palette.
 * @param {{width: number, height: number, frames: Uint8Array[]}} input
 * @param {{delayMs?: number}} [options]
 * @returns {Uint8Array}
 */
export function encodeGif({ width, height, frames }, options = {}) {
  const { palette, lookup } = buildPalette(frames);
  let depth = 1;
  while (1 << depth < palette.length) depth += 1;
  const tableSize = 1 << depth;
  const delay = Math.round(frameDelay(options.delayMs) / 10);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  out.push(...Buffer.from('GIF89a', 'latin1'));
  u16(width);
  u16(height);
  out.push(0x80 | ((depth - 1) << 4) | (depth - 1), 0, 0);
  for (let i = 0; i < tableSize; i += 1) {
    const p = palette[i] ?? [0, 0, 0];
    out.push(p[0], p[1], p[2]);
  }
  // NETSCAPE2.0: loop forever.
  out.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'latin1'), 3, 1, 0, 0, 0);
  const chunks = [Buffer.from(out)];
  const minCodeSize = Math.max(2, depth);
  for (const frame of frames) {
    const head = [0x21, 0xf9, 4, 0x04, delay & 0xff, (delay >> 8) & 0xff, 0, 0, 0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0, minCodeSize];
    chunks.push(Buffer.from(head), Buffer.from(lzw(indexFrame(frame, width, height, lookup), minCodeSize)));
  }
  chunks.push(Buffer.from([0x3b]));
  const all = Buffer.concat(chunks);
  return new Uint8Array(all.buffer, all.byteOffset, all.byteLength);
}

/**
 * A sheet's bytes to a GIF.
 * @returns {Promise<{bytes: Uint8Array, width: number, height: number, frames: number, delayMs: number}>}
 */
export async function sheetToGif(bytes, mediaType, layout, options = {}) {
  const img = await decodeImage(bytes, mediaType);
  const sliced = sliceFrames(img, layout, options.maxSide ?? FRAME_MAX);
  const delayMs = frameDelay(options.delayMs);
  return { bytes: encodeGif(sliced, { delayMs }), width: sliced.width, height: sliced.height, frames: sliced.frames.length, delayMs };
}
