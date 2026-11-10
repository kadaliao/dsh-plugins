/**
 * Host half of the images bundle.
 *
 * Registers a `generate_image` tool the conversation model can call. The tool
 * asks the model provider's OpenAI-compatible `/images/generations` endpoint for
 * the picture, saves it as a Harness attachment (so the tool result carries the
 * image itself, and the Web UI shows it in the conversation) and in a gallery
 * under the DSH home; the Client half's Images panel reads that gallery through
 * loopback JSON routes.
 *
 * @module @kadaliao/dsh-images
 */

import { chmodSync, createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildRequest, dimensionsOf, extensionOf, imagesEndpoint, parseReply, errorMessage, sniffMediaType, SIZES } from './lib/provider.mjs';
import { costFromList, estimateCost, familyOf, knownFamily, looksLikeImageModel, providerPerImage, totalsOf, PRICE_LIST_DATE } from './lib/pricing.mjs';
import { catalogNames, catalogPerImage, createCatalog, lookupCatalog } from './lib/catalog.mjs';
import { createStore, newId } from './lib/store.mjs';
import { LAYOUTS, frameDelay, layoutFor, sheetPrompt, sheetToGif } from './lib/animate.mjs';

// The registry wants the compiled definition `defineTool` makes. Outside a
// Harness (the tests) the raw definition stands in for it.
let defineTool = (definition) => definition;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch {
  // No Harness around: tests run on the raw definition.
}

/** The tool registry is the whole point of this half; the web routes ride a deferred inject. */
export const inject = ['tools'];

export const TOOL_NAME = 'generate_image';

/** The routes the Client half reads. */
const LIST_ROUTE = '/__dsh_images/list';
// A prefix route matches `<prefix>/<rest>`, so it is registered without the slash.
const FILE_ROUTE = '/__dsh_images/file';
const DELETE_ROUTE = '/__dsh_images/delete';
const STATE_ROUTE = '/__dsh_images/state';
const SETTINGS_ROUTE = '/__dsh_images/settings';
const MODELS_ROUTE = '/__dsh_images/models';
const CATALOG_ROUTE = '/__dsh_images/catalog';

/** The credential reference the stored API key lives under. */
export const KEY_REF = 'DSH_IMAGES_API_KEY';
/** Fields the settings panel may set; everything else on the row stays as configured. */
const PANEL_FIELDS = ['provider', 'baseURL', 'model', 'size', 'quality', 'pricePerImage', 'currency'];

/** How long a picture's price waits for a first catalog download. */
const CATALOG_WAIT_MS = 8000;

/** An image request that has not answered by then is given up. */
const DEFAULT_TIMEOUT_MS = 180_000;
/** Images one call may ask for. */
const MAX_N = 4;

/**
 * Normalize the Loader row's config.
 * @param {unknown} config
 */
export function settingsOf(config) {
  const c = config && typeof config === 'object' ? config : {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const timeout = Number(c.timeoutMs);
  return {
    enabled: c.enabled !== false,
    provider: str(c.provider),
    model: str(c.model),
    baseURL: str(c.baseURL),
    apiKeyEnv: str(c.apiKeyEnv),
    size: str(c.size) || '1024x1024',
    quality: str(c.quality),
    pricePerImage: Number.isFinite(Number(c.pricePerImage)) && Number(c.pricePerImage) > 0 ? Number(c.pricePerImage) : 0,
    currency: str(c.currency).toUpperCase() || 'USD',
    // '' for the LiteLLM catalog, 'off' for none, or the URL of a file in its format.
    priceCatalog: c.priceCatalog === false ? 'off' : str(c.priceCatalog),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * The settings in force: what the panel saved on top of the row's config. A
 * saved empty string means "back to the row's value".
 * @param {object} base - `settingsOf(config)`.
 * @param {object} saved - the panel's file.
 */
export function mergeSettings(base, saved) {
  const out = { ...base };
  const panel = saved && typeof saved === 'object' ? saved : {};
  for (const key of PANEL_FIELDS) {
    const value = panel[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'pricePerImage') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) out.pricePerImage = n;
    } else if (key === 'currency') out.currency = String(value).toUpperCase();
    else out[key] = String(value).trim();
  }
  return out;
}

/** The DSH home the gallery lives under. */
function homeDir() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
}

/** The value schema of one saved image, as `read_image` declares it. */
const IMAGE_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
};

/**
 * The provider route the session is on: the configured one, else the session's
 * own, else the profile's default.
 */
function providerFor(ctx, settings, exec) {
  if (settings.provider !== '') return settings.provider;
  try {
    const header = exec?.agent?.session?.requestHeader?.();
    if (header?.config?.provider) return String(header.config.provider);
  } catch {
    // Fall through to the default.
  }
  try {
    const picked = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (picked?.provider) return String(picked.provider);
  } catch {
    // No default either.
  }
  return '';
}

/**
 * The live profile of one provider route (`baseURL`, `apiKeyEnv`, `headers`),
 * read from the settings service without its secrets, or undefined.
 */
function profileOf(ctx, provider) {
  if (provider === '') return undefined;
  let rows;
  try {
    rows = ctx.get('settings')?.describe?.({ redactSecrets: true }) ?? [];
  } catch {
    rows = [];
  }
  for (const row of rows) {
    const profile = row?.value?.providers?.[provider];
    if (profile && typeof profile === 'object') return profile;
  }
  return undefined;
}

/** The API key a credential reference names, through the credentials service or the environment. */
async function keyOf(ctx, ref) {
  if (!ref) return '';
  try {
    const credentials = ctx.get('credentials');
    if (credentials?.resolve) {
      const hit = await credentials.resolve(ref);
      if (typeof hit?.value === 'string' && hit.value !== '') return hit.value;
    }
  } catch {
    // Fall back to the environment below.
  }
  return typeof process.env[ref] === 'string' ? process.env[ref] : '';
}

/**
 * Where an image request goes, and with what. Throws a readable message when
 * the plugin is not set up. The panel's stored key wins over the provider's.
 * @param {object} keys - `{read(): Promise<string>}` for the stored key.
 */
export async function targetOf(ctx, settings, exec, keys) {
  const provider = settings.provider === 'custom' ? '' : providerFor(ctx, settings, exec);
  const profile = profileOf(ctx, provider);
  const baseURL = settings.baseURL || String(profile?.baseURL ?? '');
  if (settings.model === '') {
    throw new Error(
      'No image model is configured. Open the Images panel and pick one in Settings, or set `model` on the images plugin row in cordis.patch.yml.',
    );
  }
  if (baseURL === '') {
    throw new Error(
      provider === ''
        ? 'No provider to send the image request to: set the base URL in the Images panel\'s Settings (or `provider` on the plugin row).'
        : `Provider "${provider}" has no baseURL the images plugin can read; set one in the Images panel\'s Settings.`,
    );
  }
  let apiKey = keys ? await keys.read() : '';
  let keySource = apiKey !== '' ? 'stored' : '';
  if (apiKey === '') {
    const ref = settings.apiKeyEnv || String(profile?.apiKeyEnv ?? '');
    apiKey = await keyOf(ctx, ref);
    keySource = apiKey !== '' ? (settings.apiKeyEnv ? 'env' : 'provider') : 'none';
  }
  const headers = profile?.headers && typeof profile.headers === 'object' ? { ...profile.headers } : {};
  return { provider: provider || (settings.baseURL ? 'custom' : ''), model: settings.model, baseURL, apiKey, keySource, headers };
}

/** The last four characters of a key, for the panel to show which one is in use. */
export function hintOf(key) {
  const k = String(key ?? '');
  return k.length < 6 ? (k === '' ? '' : '····') : `····${k.slice(-4)}`;
}

/**
 * The stored API key: in the Harness credentials service when one is mounted,
 * else a file only the user can read. The value never leaves the host.
 */
export function keyStore(ctx, dir) {
  const file = join(dir, 'key.json');
  const credentials = () => {
    try {
      const c = ctx.get('credentials');
      return c && typeof c.set === 'function' && typeof c.resolve === 'function' ? c : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async read() {
      const c = credentials();
      if (c) {
        try {
          const hit = await c.resolve(KEY_REF);
          if (typeof hit?.value === 'string' && hit.value !== '') return hit.value;
        } catch {
          // Fall through to the file.
        }
      }
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return typeof parsed?.key === 'string' ? parsed.key : '';
      } catch {
        return '';
      }
    },
    async write(value) {
      const key = String(value ?? '').trim();
      const c = credentials();
      if (key === '') {
        if (c) {
          for (const name of ['unset', 'delete', 'remove']) {
            if (typeof c[name] === 'function') {
              try {
                await c[name](KEY_REF);
                break;
              } catch {
                // Try the next spelling.
              }
            }
          }
        }
        rmSync(file, { force: true });
        return;
      }
      if (c) {
        try {
          await c.set(KEY_REF, key);
          rmSync(file, { force: true });
          return;
        } catch {
          // The file below.
        }
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ key }), { encoding: 'utf8', mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        // Best effort on a filesystem without modes.
      }
    },
  };
}

/**
 * The provider's model list, image models first, with any per-image price it
 * states. Throws with the provider's message when it refuses.
 * @param {{baseURL: string, apiKey: string, headers: object}} target
 */
export async function listModels(target, signal) {
  const base = String(target.baseURL).replace(/\/+$/, '');
  const url = /\/v\d+[a-z]*$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
  const headers = { accept: 'application/json', ...target.headers };
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
  const res = await fetch(url, { headers, signal });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) throw new Error(`${res.status}: ${json ? errorMessage(json) : text.slice(0, 200)}`);
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
  const models = rows
    .map((r) => {
      const id = typeof r === 'string' ? r : String(r?.id ?? r?.name ?? '');
      if (id === '') return null;
      const record = typeof r === 'object' && r !== null ? r : {};
      const outputs = record.modalities?.output ?? record.output_modalities ?? record.architecture?.output_modalities;
      const imageOut = Array.isArray(outputs) && outputs.some((o) => String(o).toLowerCase() === 'image');
      const price = providerPerImage(record);
      return {
        id,
        name: typeof record.display_name === 'string' ? record.display_name : typeof record.name === 'string' && record.name !== id ? record.name : undefined,
        isImage: imageOut || looksLikeImageModel(id),
        ...(price ? { perImage: price } : {}),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.isImage) - Number(a.isImage) || a.id.localeCompare(b.id));
  return models;
}

/** Fetch bytes from a URL the provider returned. */
async function download(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`could not download the image (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Generate the images one call asks for, save them, and describe them.
 * @returns the tool's canonical value.
 */
export async function generate(ctx, settings, store, args, exec, keys, priceOf, catalog) {
  const prompt = String(args.prompt ?? '').trim();
  if (prompt === '') throw new Error('prompt must be a non-empty description of the image');
  const target = await targetOf(ctx, settings, exec, keys);
  // An animation is drawn as one sprite sheet, then cut into the GIF's frames.
  const layout = layoutFor(args.frames);
  const delayMs = layout ? frameDelay(args.frameMs) : 0;
  const body = buildRequest({
    model: target.model,
    prompt: layout ? sheetPrompt(prompt, layout) : prompt,
    n: Math.min(MAX_N, Math.max(1, Number(args.n) || 1)),
    size: String(args.size ?? '').trim() || (layout ? layout.size : settings.size),
    quality: String(args.quality ?? '').trim() || settings.quality,
  });

  const timer = AbortSignal.timeout(settings.timeoutMs);
  const signal = exec?.signal ? AbortSignal.any([exec.signal, timer]) : timer;
  const headers = { 'content-type': 'application/json', ...target.headers };
  if (target.apiKey !== '') headers.authorization = `Bearer ${target.apiKey}`;

  let res;
  try {
    res = await fetch(imagesEndpoint(target.baseURL), { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (error) {
    if (exec?.signal?.aborted) throw new Error('the image request was cancelled');
    if (timer.aborted) throw new Error(`the provider did not answer within ${Math.round(settings.timeoutMs / 1000)}s`);
    throw new Error(`could not reach ${target.provider || target.baseURL}: ${error?.message ?? error}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    throw new Error(`${target.provider || 'provider'} answered ${res.status}: ${json ? errorMessage(json) : text.slice(0, 300)}`);
  }
  const replies = parseReply(json);
  const usage = json && typeof json === 'object' && json.usage && typeof json.usage === 'object' ? json.usage : undefined;
  const providerRecord = priceOf ? priceOf(target.model) : undefined;
  // The catalog is only asked for a model nothing closer can price.
  const catalogMatch =
    catalog && !knownFamily(familyOf(target.model)) && !providerPerImage(providerRecord)
      ? lookupCatalog(await catalog.ensure(CATALOG_WAIT_MS), target.model)
      : undefined;
  const cost = estimateCost({
    model: target.model,
    size: body.size ?? 'auto',
    quality: body.quality ?? '',
    n: replies.length,
    usage,
    providerRecord,
    catalog: catalogMatch,
    manual: settings.pricePerImage > 0 ? { amount: settings.pricePerImage, currency: settings.currency } : undefined,
  });
  const perImageCost = cost ? { amount: cost.perImage, currency: cost.currency, source: cost.source } : undefined;

  const attachments = ctx.get('attachments');
  const sessionId = String(exec?.agent?.session?.id ?? '');
  const images = [];
  for (const reply of replies) {
    const drawn = reply.b64 ? new Uint8Array(Buffer.from(reply.b64, 'base64')) : await download(reply.url, signal);
    const drawnType = sniffMediaType(drawn) ?? 'image/png';
    const id = newId();
    // The attachment is what the model sees: the picture, or for a GIF its sprite
    // sheet (the Harness keeps attachments single-frame, so the sheet shows more).
    let ref;
    if (attachments?.saveImage) {
      try {
        ref = await attachments.saveImage({ data: drawn, mediaType: drawnType, name: `${id}${layout ? '-sheet' : ''}.${extensionOf(drawnType)}` });
      } catch {
        ref = undefined;
      }
    }
    let bytes = drawn;
    let mediaType = drawnType;
    let animation;
    let sheetFile;
    if (layout) {
      sheetFile = store.pathFor(`${id}-sheet`, extensionOf(drawnType));
      writeFileSync(sheetFile, drawn);
      let gif;
      try {
        gif = await sheetToGif(drawn, drawnType, layout, { delayMs });
      } catch (error) {
        throw new Error(`the sprite sheet was drawn (saved at ${sheetFile}) but could not be turned into a GIF: ${error?.message ?? error}`);
      }
      bytes = gif.bytes;
      mediaType = 'image/gif';
      animation = { frames: gif.frames, delayMs: gif.delayMs, grid: `${layout.cols}x${layout.rows}` };
    }
    const file = store.pathFor(id, extensionOf(mediaType));
    writeFileSync(file, bytes);
    const dims = dimensionsOf(bytes);
    const item = {
      id,
      file,
      mediaType,
      bytes: bytes.length,
      width: (layout ? dims.width : ref?.width) || dims.width,
      height: (layout ? dims.height : ref?.height) || dims.height,
      ...(animation ? { animation, sheetFile } : {}),
      prompt,
      ...(reply.revisedPrompt ? { revisedPrompt: reply.revisedPrompt } : {}),
      model: target.model,
      provider: target.provider,
      size: body.size ?? 'auto',
      sessionId,
      createdAt: Date.now(),
      ...(ref ? { attachmentId: ref.attachmentId } : {}),
      ...(perImageCost ? { cost: perImageCost } : {}),
      ...(usage ? { usage } : {}),
    };
    store.add(item);
    images.push({
      id,
      path: file,
      mediaType,
      width: item.width,
      height: item.height,
      ...(animation ? { animation, sheetPath: sheetFile } : {}),
      ...(ref
        ? {
            image: {
              attachmentId: ref.attachmentId,
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
              ...(ref.name ? { name: ref.name } : {}),
            },
          }
        : {}),
    });
  }
  return {
    ok: true,
    model: target.model,
    prompt,
    ...(replies[0].revisedPrompt ? { revisedPrompt: replies[0].revisedPrompt } : {}),
    ...(cost ? { cost: { amount: cost.amount, currency: cost.currency, source: cost.source } } : {}),
    images,
  };
}

/** `$0.13` / `¥0.20`, rounded to what matters. */
export function fmtMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  const sign = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : currency === 'EUR' ? '€' : `${currency} `;
  const digits = n >= 1 ? 2 : n >= 0.01 ? 3 : 4;
  return `${sign}${n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/** The model-facing content of one result: a line per image, then the images themselves. */
export function renderResult(_args, value) {
  const images = Array.isArray(value?.images) ? value.images : [];
  const lines = images.map((img, i) => {
    const dims = img.width && img.height ? `${img.width}×${img.height}` : 'unknown size';
    const anim = img.animation ? ` animated, ${img.animation.frames} frames at ${img.animation.delayMs}ms, looping` : '';
    const sheet = img.sheetPath ? `; its sprite sheet is at ${img.sheetPath}${img.image ? ' and is the picture attached below' : ''}` : '';
    return `${images.length > 1 ? `Image ${i + 1}: ` : ''}${dims} ${img.mediaType}${anim}, saved at ${img.path}${sheet}`;
  });
  const spent = value?.cost ? ` (≈ ${fmtMoney(value.cost.amount, value.cost.currency)})` : '';
  const animated = images.length > 0 && images.every((img) => img.animation);
  const noun = animated ? `animated GIF${images.length > 1 ? 's' : ''}` : `image${images.length > 1 ? 's' : ''}`;
  const head = images.length === 0 ? 'No image was generated.' : `Generated ${images.length} ${noun} with ${value.model}${spent}. The user already sees ${images.length > 1 ? 'them' : 'it'} in the conversation and in the Images panel; do not repeat the path unless asked.`;
  const revised = value?.revisedPrompt ? `\nThe provider rewrote the prompt as: ${value.revisedPrompt}` : '';
  const blocks = [{ type: 'text', text: [head, ...lines].join('\n') + revised }];
  for (const img of images) {
    if (img.image) blocks.push({ type: 'image', attachment: img.image });
  }
  return blocks;
}

/**
 * The tool definition. `runtime.settings` is read on every call, so what the
 * panel saves applies to the next picture without a reload.
 */
export function buildTool(ctx, runtime, store, keys, priceOf, catalog) {
  return defineTool({
    name: TOOL_NAME,
    description:
      'Generate an image from a text description with the configured image model. Use it whenever the user asks for a picture, illustration, poster, icon, logo, photo-like render, concept art, or to "draw" something; also for variations of an earlier image, by describing the change fully. Write the prompt in full detail — subject, style, composition, lighting, colours, mood, and any text to render, quoted exactly. ' +
      'It also makes short looping animated GIFs (动图, GIF, sticker, animation, a cat running, a waving hand…): set `frames` and describe the scene and the motion — the tool has the model draw a sprite sheet of that many frames and assembles the GIF itself, so do not script it by hand. ' +
      'The image is saved and shown to the user in the conversation and in the Images panel; after the call, say in a sentence what was drawn.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What to draw, in detail. Written in the language of the image model (English works everywhere), with any text to appear in the image quoted exactly.' },
      size: { type: 'string', description: `Pixel size as WIDTHxHEIGHT. Common: ${SIZES.join(', ')} (square, landscape, portrait). Leave out for the configured default.` },
      n: { type: 'integer', description: `How many images, 1 to ${MAX_N}. Leave out for one.` },
      quality: { type: 'string', description: 'Quality tier when the model takes one (low, medium, high). Leave out for the default.' },
      frames: {
        type: 'integer',
        description: `Set to make an animated GIF instead of a still: how many frames (${LAYOUTS.map((l) => l.frames).join(', ')}; others round to the nearest). 16 gives the smoothest motion, 4 a simple two-pose loop. With frames, describe one continuous, looping motion of a single scene, and leave size out unless the frames must be wide or tall.`,
      },
      frameMs: { type: 'integer', description: 'With frames: how long each frame shows, in milliseconds (40–1000, default 100). Lower is faster.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          revisedPrompt: { type: 'string' },
          cost: {
            type: 'object',
            additionalProperties: false,
            properties: { amount: { type: 'number', required: true }, currency: { type: 'string', required: true }, source: { type: 'string', required: true } },
          },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string', required: true },
                path: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                sheetPath: { type: 'string' },
                animation: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { frames: { type: 'integer', required: true }, delayMs: { type: 'integer', required: true }, grid: { type: 'string', required: true } },
                },
                image: IMAGE_REF_SCHEMA,
              },
            },
          },
        },
      },
      render: renderResult,
      presentationMeta: (_args, value) => ({
        ids: (value?.images ?? []).map((img) => img.id),
        // What the gallery file is, since the attachment may be a still or a sprite sheet.
        media: (value?.images ?? []).map((img) => ({ mediaType: img.mediaType, width: img.width, height: img.height, ...(img.animation ? { frames: img.animation.frames } : {}) })),
        prompt: value?.prompt ?? '',
        model: value?.model ?? '',
        ...(value?.cost ? { cost: value.cost } : {}),
      }),
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => generate(ctx, runtime.settings, store, args, exec, keys, priceOf, catalog),
  });
}

/**
 * Register the tool, the gallery routes and the `/images` command.
 * @param ctx - plugin context.
 * @param {unknown} config - the Loader row's config.
 */
export function apply(ctx, config) {
  const base = settingsOf(config);
  const dir = join(homeDir(), 'cache', 'images');
  const store = createStore(dir);
  const enabledFile = join(dir, 'enabled.json');
  const settingsFile = join(dir, 'settings.json');
  const keys = keyStore(ctx, dir);
  const readJson = (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const runtime = { enabled: base.enabled, saved: readJson(settingsFile), settings: base };
  runtime.settings = mergeSettings(base, runtime.saved);
  if (typeof readJson(enabledFile).enabled === 'boolean') runtime.enabled = readJson(enabledFile).enabled;
  // Per-image prices the provider stated for its models, from the last model listing.
  const providerPrices = new Map();
  const priceOf = (model) => providerPrices.get(model);
  // The public price list for models nothing else prices; fetched on first need.
  const catalog = createCatalog(dir, {
    enabled: base.priceCatalog !== 'off',
    sources: /^https?:\/\//i.test(base.priceCatalog) ? [base.priceCatalog] : undefined,
  });
  const settings = runtime.settings;

  let disposeTool = null;
  function mountTool() {
    if (disposeTool !== null || !runtime.enabled || typeof ctx.tools?.register !== 'function') return;
    const dispose = ctx.tools.register(buildTool(ctx, runtime, store, keys, priceOf, catalog));
    disposeTool = typeof dispose === 'function' ? dispose : () => {};
  }
  function unmountTool() {
    if (disposeTool === null) return;
    disposeTool();
    disposeTool = null;
  }
  ctx.effect(() => {
    mountTool();
    return () => unmountTool();
  });

  const commands = ctx.get('commands');
  if (commands !== undefined) {
    ctx.effect(() =>
      commands.register({
        name: 'images',
        description: 'Open the Images panel: every image generated in your conversations (on|off: offer the generate_image tool to the model or not)',
        input: { hint: '[on|off]' },
        handler: (invocation) => {
          const arg = String(invocation.rawInput ?? '').trim().toLowerCase();
          if (arg === 'on' || arg === 'off') {
            runtime.enabled = arg === 'on';
            try {
              mkdirSync(dir, { recursive: true });
              writeFileSync(enabledFile, JSON.stringify({ enabled: runtime.enabled }), 'utf8');
            } catch {
              // The toggle still applies to this process.
            }
            if (runtime.enabled) mountTool();
            else unmountTool();
            return {
              kind: 'success',
              text: runtime.enabled
                ? `images is on: the model can call ${TOOL_NAME}${runtime.settings.model ? ` (${runtime.settings.model})` : ' once a model is configured'}.`
                : `images is off: ${TOOL_NAME} is no longer offered to the model.`,
            };
          }
          const n = store.size();
          return {
            kind: 'success',
            text: n === 0 ? 'No images yet. Ask the model to draw something.' : `${n} image${n > 1 ? 's' : ''} in the gallery. Open the Images panel from the sidebar.`,
          };
        },
      }),
    );
  }

  // --- the gallery's routes (browser only; the headless profile has no page) ---
  const mountRoutes = (scope) => {
    const webServer = scope.webServer;
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: (_req, res) =>
          serveJson(res, () => ({
            enabled: runtime.enabled,
            model: runtime.settings.model,
            provider: runtime.settings.provider,
            total: store.size(),
            totals: totalsOf(store.list({ limit: 100_000 }).items),
          })),
      }),
    );
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: LIST_ROUTE,
        handler: (req, res) =>
          serveJson(res, () => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
            const page = store.list({ limit, before: url.searchParams.get('before') ?? '' });
            return { ...page, items: page.items.map(publicItem) };
          }),
      }),
    );
    scope.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: FILE_ROUTE,
        handler: (req, res) => serveFile(store, req, res),
      }),
    );
    /** How a model would be billed, for the panel while a model is being typed. */
    const previewPrice = async (model, size, quality) => {
      const provider = priceOf(model);
      const perImage = provider ? providerPerImage(provider) : undefined;
      if (perImage) return { model, source: 'provider', perImage, family: familyOf(model) };
      const family = familyOf(model);
      const sizes = ['1024x1024', '1536x1024'];
      const listed = family ? sizes.map((sz) => ({ size: sz, price: costFromList(family, sz, quality) })).filter((r) => r.price) : [];
      if (listed.length > 0) {
        const chosen = costFromList(family, size || runtime.settings.size, quality);
        return { model, source: 'list', family, perImage: chosen, samples: listed, priceListDate: PRICE_LIST_DATE };
      }
      const manual = runtime.settings.pricePerImage > 0 ? { amount: runtime.settings.pricePerImage, currency: runtime.settings.currency } : undefined;
      const match = knownFamily(family) ? undefined : lookupCatalog(await catalog.ensure(15_000), model);
      if (match) {
        const flat = catalogPerImage(match, size || runtime.settings.size, quality);
        return {
          model,
          source: 'catalog',
          family,
          catalog: {
            name: match.name,
            provider: match.provider,
            approximate: match.approximate,
            ...(match.tokens ? { tokens: { textIn: match.tokens.textIn, imageOut: match.tokens.imageOut } } : {}),
            ...(flat ? { perImage: flat } : {}),
            fetchedAt: catalog.status().fetchedAt,
          },
          ...(manual ? { manual } : {}),
        };
      }
      return { model, source: manual ? 'manual' : 'unknown', family, ...(manual ? { perImage: manual } : {}), catalogError: catalog.status().error };
    };
    /** What the panel's Settings shows: the values in force, where the key comes from, the providers to pick from. */
    const describeSettings = async () => {
      const s = runtime.settings;
      let target = null;
      let problem = '';
      try {
        target = await targetOf(ctx, s, undefined, keys);
      } catch (error) {
        problem = error?.message ?? String(error);
      }
      const stored = await keys.read();
      const providers = [];
      try {
        const rows = ctx.get('settings')?.describe?.({ redactSecrets: true }) ?? [];
        for (const row of rows) {
          const list = row?.value?.providers;
          if (!list || typeof list !== 'object') continue;
          for (const [id, profile] of Object.entries(list)) {
            providers.push({ id, name: String(profile?.displayName ?? id), baseURL: String(profile?.baseURL ?? ''), hasKey: Boolean(profile?.apiKeyEnv) });
          }
        }
      } catch {
        // No settings service: the panel offers a custom base URL only.
      }
      const items = store.list({ limit: 100_000 }).items;
      const byModel = {};
      for (const it of items) {
        const row = (byModel[it.model] ??= { count: 0, totals: {} });
        row.count += 1;
        if (it.cost) row.totals[it.cost.currency] = (row.totals[it.cost.currency] ?? 0) + it.cost.amount;
      }
      return {
        values: {
          provider: s.provider,
          baseURL: s.baseURL,
          model: s.model,
          size: s.size,
          quality: s.quality,
          pricePerImage: s.pricePerImage,
          currency: s.currency,
        },
        defaults: { provider: base.provider, baseURL: base.baseURL, model: base.model, size: base.size, quality: base.quality },
        effective: target
          ? { provider: target.provider, baseURL: target.baseURL, model: target.model, keySource: target.keySource, keyHint: hintOf(target.apiKey) }
          : { provider: '', baseURL: '', model: s.model, keySource: 'none', keyHint: '' },
        problem,
        storedKey: stored === '' ? null : hintOf(stored),
        providers,
        sessionProvider: providerFor(ctx, { ...s, provider: '' }, undefined),
        priceListDate: PRICE_LIST_DATE,
        catalog: catalog.status(),
        stats: { total: items.length, totals: totalsOf(items), byModel },
      };
    };
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: (req, res) => {
          if (req.method === 'GET') {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const model = url.searchParams.get('model');
            if (model !== null) {
              serveJson(res, () => previewPrice(model, url.searchParams.get('size') ?? '', url.searchParams.get('quality') ?? ''));
              return;
            }
            serveJson(res, describeSettings);
            return;
          }
          postJson(req, res, async (body) => {
            const next = { ...runtime.saved };
            for (const key of PANEL_FIELDS) {
              if (!(key in body)) continue;
              const value = body[key];
              if (value === null || value === '') delete next[key];
              else if (key === 'pricePerImage') {
                const n = Number(value);
                if (Number.isFinite(n) && n >= 0) next[key] = n;
              } else next[key] = String(value).trim();
            }
            if ('apiKey' in body) await keys.write(body.apiKey === null ? '' : String(body.apiKey));
            runtime.saved = next;
            runtime.settings = mergeSettings(base, next);
            try {
              mkdirSync(dir, { recursive: true });
              writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8');
            } catch {
              // The change still applies to this process.
            }
            return { ok: true, ...(await describeSettings()) };
          });
        },
      }),
    );
    /** The provider's models, for the picker; also the connection test. Draft values may be sent. */
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: MODELS_ROUTE,
        handler: (req, res) => {
          postJson(req, res, async (body) => {
            const draft = mergeSettings(runtime.settings, { provider: body.provider, baseURL: body.baseURL, model: 'x' });
            const draftKeys = typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? { read: async () => body.apiKey.trim() } : keys;
            try {
              const target = await targetOf(ctx, draft, undefined, draftKeys);
              const models = await listModels(target, AbortSignal.timeout(20_000));
              for (const m of models) if (m.perImage) providerPrices.set(m.id, { pricing: { per_image: m.perImage.amount, currency: m.perImage.currency } });
              return { ok: true, baseURL: target.baseURL, keySource: target.keySource, models };
            } catch (error) {
              return { ok: false, reason: error?.message ?? String(error) };
            }
          });
        },
      }),
    );
    /** The catalog's image models for the picker, and its state; POST `{refresh: true}` downloads it again. */
    const catalogView = () => ({ status: catalog.status(), names: catalogNames(catalog.current()) });
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: CATALOG_ROUTE,
        handler: (req, res) => {
          if (req.method === 'GET') {
            serveJson(res, async () => {
              await catalog.ensure(15_000);
              return catalogView();
            });
            return;
          }
          postJson(req, res, async (body) => {
            if (body.refresh === true) await catalog.refresh(true);
            return { ok: true, ...catalogView() };
          });
        },
      }),
    );
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: DELETE_ROUTE,
        handler: (req, res) => postJson(req, res, (body) => ({ ok: store.remove(String(body.id ?? '')) })),
      }),
    );
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountRoutes);
  else if (ctx.webServer) mountRoutes({ webServer: ctx.webServer, effect: (fn) => ctx.effect(fn) });

  ctx.effect(() => () => store.flush());
}

/** One gallery item as the page sees it: no host path, a URL instead. */
function publicItem(item) {
  const { file, sheetFile, ...rest } = item;
  void file;
  void sheetFile;
  return { ...rest, url: `${FILE_ROUTE}/${item.id}` };
}

/** Stream one image file; `?download=1` makes the browser save it. */
function serveFile(store, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = decodeURIComponent(url.pathname.slice(FILE_ROUTE.length + 1)).replace(/\.[a-z0-9]+$/i, '');
  const item = store.get(id);
  let size = 0;
  try {
    if (item?.file) size = statSync(item.file).size;
  } catch {
    size = 0;
  }
  if (!item || size === 0) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', item.mediaType);
  res.setHeader('content-length', String(size));
  res.setHeader('cache-control', 'private, max-age=31536000, immutable');
  if (url.searchParams.get('download') === '1') {
    res.setHeader('content-disposition', `attachment; filename="${id}.${extensionOf(item.mediaType)}"`);
  }
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(item.file);
  stream.on('error', () => {
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
  stream.pipe(res);
}

/**
 * Answer one state-changing request. Only a JSON POST is taken: a cross-site page
 * cannot send one without a CORS preflight, which these routes never grant.
 */
function postJson(req, res, produce) {
  const type = String(req.headers?.['content-type'] ?? '');
  if (req.method !== 'POST' || !/^application\/json\b/i.test(type)) {
    res.statusCode = req.method === 'POST' ? 415 : 405;
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    serveJson(res, () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return { ok: false, reason: 'bad-request' };
      }
      return produce(body && typeof body === 'object' ? body : {});
    });
  });
}

/** Answer one request as JSON; a thrown handler becomes a stable error body. */
function serveJson(res, produce) {
  Promise.resolve()
    .then(produce)
    .then((body) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    })
    .catch((error) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, reason: error?.message ?? 'error' }));
    });
}
