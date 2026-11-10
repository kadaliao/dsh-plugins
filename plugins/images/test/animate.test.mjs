import assert from 'node:assert/strict';
import test from 'node:test';

import { decodePng, encodeGif, frameDelay, gifCapable, layoutFor, sheetPrompt, sheetToGif, sliceFrames } from '../lib/animate.mjs';
import { dimensionsOf, sniffMediaType } from '../lib/provider.mjs';
import { sheetPng } from './fixtures.mjs';

/** The frames and delays a GIF declares, read back from its blocks. */
function readGif(bytes) {
  const b = Buffer.from(bytes);
  assert.equal(b.toString('latin1', 0, 6), 'GIF89a');
  const flags = b[10];
  let at = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  const delays = [];
  let loops = false;
  let frames = 0;
  while (at < b.length) {
    const tag = b[at];
    if (tag === 0x3b) break;
    if (tag === 0x21) {
      const label = b[at + 1];
      if (label === 0xf9) delays.push(b.readUInt16LE(at + 4) * 10);
      if (label === 0xff && b.toString('latin1', at + 3, at + 14) === 'NETSCAPE2.0') loops = true;
      at += 2;
      while (b[at] !== 0) at += b[at] + 1;
      at += 1;
    } else if (tag === 0x2c) {
      frames += 1;
      at += 10 + 1;
      while (b[at] !== 0) at += b[at] + 1;
      at += 1;
    } else throw new Error(`bad block ${tag} at ${at}`);
  }
  return { frames, delays, loops, ended: b[b.length - 1] === 0x3b };
}

test('a frame count picks the nearest sheet layout', () => {
  assert.equal(layoutFor(undefined), undefined);
  assert.equal(layoutFor(1), undefined);
  assert.deepEqual([4, 5, 6, 8, 12, 16, 40].map((n) => layoutFor(n).frames), [4, 6, 6, 9, 9, 16, 16]);
  assert.equal(layoutFor(6).size, '1536x1024');
  assert.deepEqual([undefined, 5, 95, 5000].map(frameDelay), [100, 40, 100, 1000]);
  const p = sheetPrompt('a cat chasing yarn', layoutFor(16));
  assert.match(p, /4x4 grid of 16/);
  assert.match(p, /Animation: a cat chasing yarn$/);
});

test('a PNG sheet is decoded, cut into its cells and encoded as a looping GIF', async () => {
  const png = await sheetPng(3, 2, 20);
  const img = decodePng(png);
  assert.deepEqual([img.width, img.height], [60, 40]);
  const sliced = sliceFrames(img, layoutFor(6));
  assert.equal(sliced.frames.length, 6);
  // Each frame is one flat cell colour, the inset cutting off its neighbours.
  const cell0 = sliced.frames[0];
  const cell5 = sliced.frames[5];
  assert.deepEqual([...cell0.slice(0, 3)], [0, 40, 80]);
  assert.deepEqual([...cell5.slice(0, 3)], [(5 * 53) & 255, (5 * 97 + 40) & 255, (5 * 151 + 80) & 255]);
  assert.deepEqual([...cell0.slice(-3)], [0, 40, 80]);

  const gif = await sheetToGif(new Uint8Array(png), 'image/png', layoutFor(6), { delayMs: 80 });
  assert.equal(sniffMediaType(gif.bytes), 'image/gif');
  assert.deepEqual(dimensionsOf(gif.bytes), { width: gif.width, height: gif.height });
  assert.deepEqual(readGif(gif.bytes), { frames: 6, delays: [80, 80, 80, 80, 80, 80], loops: true, ended: true });
});

test('large frames are scaled down and a busy frame survives LZW resets', () => {
  const width = 300;
  const height = 300;
  const noisy = new Uint8Array(width * height * 3);
  let seed = 7;
  for (let i = 0; i < noisy.length; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    noisy[i] = seed >>> 24;
  }
  const out = encodeGif({ width, height, frames: [noisy, noisy] }, {});
  assert.deepEqual(readGif(out), { frames: 2, delays: [100, 100], loops: true, ended: true });

  const big = { width: 2000, height: 2000, data: new Uint8Array(2000 * 2000 * 4).fill(255) };
  const sliced = sliceFrames(big, layoutFor(4));
  assert.ok(Math.max(sliced.width, sliced.height) <= 480);
});

test('gpt-image models are known to draw GIF frames; others are not', () => {
  for (const id of ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.6-flare', 'GPT-Image-2.6-Sunburst', 'sub2api/gpt-image-1.5', 'chatgpt-image-latest']) assert.equal(gifCapable(id), true, id);
  for (const id of ['flux-pro', 'doubao-seedream-4', 'dall-e-3', 'gemini-3-pro-image', 'my-gpt-image-clone', 'gpt-4o', '']) assert.equal(gifCapable(id), false, id);
});
