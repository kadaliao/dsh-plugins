// A 2×3 PNG header (IHDR only; enough for sniffing and dimensions).
export const PNG_2x3 = Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000308020000000000000000', 'hex');

/** A slice of LiteLLM's model_prices_and_context_window.json, in its real shapes. */
export const LITELLM_SAMPLE = {
  sample_spec: { mode: 'chat', input_cost_per_token: 0 },
  'gpt-5.4': { mode: 'chat', litellm_provider: 'openai', input_cost_per_token: 2.5e-6 },
  'gpt-image-2.6-sunburst': {
    mode: 'image_generation',
    litellm_provider: 'openai',
    input_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1.25e-6,
    input_cost_per_image_token: 8e-6,
    cache_read_input_image_token_cost: 2e-6,
    output_cost_per_image_token: 3e-5,
  },
  'gpt-image-2': { mode: 'image_generation', litellm_provider: 'openai', input_cost_per_token: 5e-6, output_cost_per_image_token: 3e-5 },
  'gpt-image-2-2026-04-21': { mode: 'image_generation', litellm_provider: 'openai', input_cost_per_token: 5e-6, output_cost_per_image_token: 3e-5 },
  'aiml/openai/gpt-image-2': { mode: 'image_generation', litellm_provider: 'aiml', output_cost_per_image: 0.054 },
  'fal_ai/gpt-image-2': { mode: 'image_generation', litellm_provider: 'fal_ai', output_cost_per_image: 0.145 },
  'fal_ai/high/1024-x-1024/gpt-image-2': { mode: 'image_generation', litellm_provider: 'fal_ai', output_cost_per_image: 0.211 },
  'fal_ai/high/1024-x-1536/gpt-image-2': { mode: 'image_generation', litellm_provider: 'fal_ai', output_cost_per_image: 0.165 },
  'fal_ai/low/1024-x-1024/gpt-image-2': { mode: 'image_generation', litellm_provider: 'fal_ai', output_cost_per_image: 0.006 },
  'fal_ai/openai/gpt-image-2/edit': { mode: 'image_generation', litellm_provider: 'fal_ai', output_cost_per_image: 0.151 },
  'xai/grok-imagine-image': { mode: 'image_generation', litellm_provider: 'xai', input_cost_per_image: 0.02 },
  'black_forest_labs/flux-pro': { mode: 'image_generation', litellm_provider: 'black_forest_labs', output_cost_per_image: 0.05 },
  'aiml/flux-pro': { mode: 'image_generation', litellm_provider: 'aiml', output_cost_per_image: 0.065 },
  'aiml/flux/dev': { mode: 'image_generation', litellm_provider: 'aiml', output_cost_per_image: 0.033 },
  'gemini/gemini-3-pro-image': { mode: 'image_generation', litellm_provider: 'gemini', input_cost_per_image: 0.0011, input_cost_per_token: 2e-6, output_cost_per_image: 0.134, output_cost_per_image_token: 1.2e-4 },
  'azure/hd/1024-x-1792/dall-e-3': { mode: 'image_generation', litellm_provider: 'azure', input_cost_per_pixel: 7.19343e-8 },
  'qwencloud/qwen-image-3.0': { mode: 'image_generation', litellm_provider: 'qwencloud' },
  'flux-kontext-pro': { mode: 'image_edit', litellm_provider: 'black_forest_labs', output_cost_per_image: 0.04 },
};

/**
 * A real PNG (8-bit RGBA, filter 0) of `cols`×`rows` cells, each `cell` px and
 * filled with a colour of its own, for the sprite-sheet path.
 */
export async function sheetPng(cols, rows, cell = 8) {
  const { deflateSync, crc32 } = await import('node:zlib');
  const w = cols * cell;
  const hgt = rows * cell;
  const raw = Buffer.alloc((w * 4 + 1) * hgt);
  for (let y = 0; y < hgt; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const k = Math.floor(y / cell) * cols + Math.floor(x / cell);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = (k * 53) & 255;
      raw[o + 1] = (k * 97 + 40) & 255;
      raw[o + 2] = (k * 151 + 80) & 255;
      raw[o + 3] = 255;
    }
  }
  const chunk = (name, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(name, 'latin1'), body])) >>> 0);
    return Buffer.concat([len, Buffer.from(name, 'latin1'), body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(hgt, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
