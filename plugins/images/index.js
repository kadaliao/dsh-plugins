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

import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildRequest, dimensionsOf, extensionOf, imagesEndpoint, parseReply, errorMessage, sniffMediaType, SIZES } from './lib/provider.mjs';
import { createStore, newId } from './lib/store.mjs';

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
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
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
 * the plugin is not set up.
 */
export async function targetOf(ctx, settings, exec) {
  const provider = providerFor(ctx, settings, exec);
  const profile = profileOf(ctx, provider);
  const baseURL = settings.baseURL || String(profile?.baseURL ?? '');
  if (settings.model === '') {
    throw new Error(
      'No image model is configured. On the images plugin row in cordis.patch.yml set `model` to an image model your provider serves (for example gpt-image-1), and `provider` if it is not the session\'s own.',
    );
  }
  if (baseURL === '') {
    throw new Error(
      provider === ''
        ? 'No provider to send the image request to: set `provider` (and `model`) on the images plugin row.'
        : `Provider "${provider}" has no baseURL the images plugin can read; set \`baseURL\` on the images plugin row.`,
    );
  }
  const ref = settings.apiKeyEnv || String(profile?.apiKeyEnv ?? '');
  const apiKey = await keyOf(ctx, ref);
  const headers = profile?.headers && typeof profile.headers === 'object' ? { ...profile.headers } : {};
  return { provider, model: settings.model, baseURL, apiKey, headers };
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
export async function generate(ctx, settings, store, args, exec) {
  const prompt = String(args.prompt ?? '').trim();
  if (prompt === '') throw new Error('prompt must be a non-empty description of the image');
  const target = await targetOf(ctx, settings, exec);
  const body = buildRequest({
    model: target.model,
    prompt,
    n: Math.min(MAX_N, Math.max(1, Number(args.n) || 1)),
    size: String(args.size ?? '').trim() || settings.size,
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

  const attachments = ctx.get('attachments');
  const sessionId = String(exec?.agent?.session?.id ?? '');
  const images = [];
  for (const reply of replies) {
    const bytes = reply.b64 ? new Uint8Array(Buffer.from(reply.b64, 'base64')) : await download(reply.url, signal);
    const mediaType = sniffMediaType(bytes) ?? 'image/png';
    const id = newId();
    const file = store.pathFor(id, extensionOf(mediaType));
    writeFileSync(file, bytes);
    let ref;
    if (attachments?.saveImage) {
      try {
        ref = await attachments.saveImage({ data: bytes, mediaType, name: `${id}.${extensionOf(mediaType)}` });
      } catch {
        ref = undefined;
      }
    }
    const dims = dimensionsOf(bytes);
    const item = {
      id,
      file,
      mediaType,
      bytes: bytes.length,
      width: ref?.width || dims.width,
      height: ref?.height || dims.height,
      prompt,
      ...(reply.revisedPrompt ? { revisedPrompt: reply.revisedPrompt } : {}),
      model: target.model,
      provider: target.provider,
      size: body.size ?? 'auto',
      sessionId,
      createdAt: Date.now(),
      ...(ref ? { attachmentId: ref.attachmentId } : {}),
    };
    store.add(item);
    images.push({
      id,
      path: file,
      mediaType,
      width: item.width,
      height: item.height,
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
    images,
  };
}

/** The model-facing content of one result: a line per image, then the images themselves. */
export function renderResult(_args, value) {
  const images = Array.isArray(value?.images) ? value.images : [];
  const lines = images.map((img, i) => {
    const dims = img.width && img.height ? `${img.width}×${img.height}` : 'unknown size';
    return `${images.length > 1 ? `Image ${i + 1}: ` : ''}${dims} ${img.mediaType}, saved at ${img.path}`;
  });
  const head = images.length === 0 ? 'No image was generated.' : `Generated ${images.length} image${images.length > 1 ? 's' : ''} with ${value.model}. The user already sees ${images.length > 1 ? 'them' : 'it'} in the conversation and in the Images panel; do not repeat the path unless asked.`;
  const revised = value?.revisedPrompt ? `\nThe provider rewrote the prompt as: ${value.revisedPrompt}` : '';
  const blocks = [{ type: 'text', text: [head, ...lines].join('\n') + revised }];
  for (const img of images) {
    if (img.image) blocks.push({ type: 'image', attachment: img.image });
  }
  return blocks;
}

/** The tool definition. */
export function buildTool(ctx, settings, store) {
  return defineTool({
    name: TOOL_NAME,
    description:
      'Generate an image from a text description with the configured image model. Use it whenever the user asks for a picture, illustration, poster, icon, logo, photo-like render, concept art, or to "draw" something; also for variations of an earlier image, by describing the change fully. Write the prompt in full detail — subject, style, composition, lighting, colours, mood, and any text to render, quoted exactly. The image is saved and shown to the user in the conversation and in the Images panel; after the call, say in a sentence what was drawn.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What to draw, in detail. Written in the language of the image model (English works everywhere), with any text to appear in the image quoted exactly.' },
      size: { type: 'string', description: `Pixel size as WIDTHxHEIGHT. Common: ${SIZES.join(', ')} (square, landscape, portrait). Leave out for the configured default.` },
      n: { type: 'integer', description: `How many images, 1 to ${MAX_N}. Leave out for one.` },
      quality: { type: 'string', description: 'Quality tier when the model takes one (low, medium, high). Leave out for the default.' },
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
                image: IMAGE_REF_SCHEMA,
              },
            },
          },
        },
      },
      render: renderResult,
      presentationMeta: (_args, value) => ({
        ids: (value?.images ?? []).map((img) => img.id),
        prompt: value?.prompt ?? '',
        model: value?.model ?? '',
      }),
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => generate(ctx, settings, store, args, exec),
  });
}

/**
 * Register the tool, the gallery routes and the `/images` command.
 * @param ctx - plugin context.
 * @param {unknown} config - the Loader row's config.
 */
export function apply(ctx, config) {
  const settings = settingsOf(config);
  const dir = join(homeDir(), 'cache', 'images');
  const store = createStore(dir);
  const enabledFile = join(dir, 'enabled.json');
  const runtime = { enabled: settings.enabled };
  try {
    const saved = JSON.parse(readFileSync(enabledFile, 'utf8'));
    if (typeof saved?.enabled === 'boolean') runtime.enabled = saved.enabled;
  } catch {
    // No saved toggle yet.
  }

  let disposeTool = null;
  function mountTool() {
    if (disposeTool !== null || !runtime.enabled || typeof ctx.tools?.register !== 'function') return;
    const dispose = ctx.tools.register(buildTool(ctx, settings, store));
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
                ? `images is on: the model can call ${TOOL_NAME}${settings.model ? ` (${settings.model})` : ' once a model is configured'}.`
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
            model: settings.model,
            provider: settings.provider,
            total: store.size(),
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
  const { file, ...rest } = item;
  void file;
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
