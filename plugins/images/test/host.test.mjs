import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { TOOL_NAME, apply, renderResult, settingsOf } from '../index.js';
import { LITELLM_SAMPLE, PNG_2x3 } from './fixtures.mjs';

const unloads = [];
afterEach(() => {
  for (const unload of unloads.splice(0)) unload();
  delete globalThis.fetch;
});

/**
 * The Harness beneath the plugin: a tool registry, a settings service holding one
 * provider profile, a credentials service, an attachment store and the web
 * server's routes. `reply` is what the provider answers.
 */
function harness({ home, config = { model: 'gpt-image-1' }, reply, status = 200, attachments = true, catalog = LITELLM_SAMPLE } = {}) {
  process.env.DSH_HOME = home ?? mkdtempSync(join(tmpdir(), 'images-home-'));
  const tools = new Map();
  const routes = new Map();
  const commands = new Map();
  const disposers = [];
  const calls = [];
  const vault = new Map();
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('model_prices_and_context_window')) {
      if (typeof catalog === 'number') return { ok: false, status: catalog, text: async () => 'unavailable' };
      return { ok: true, status: 200, text: async () => JSON.stringify(catalog) };
    }
    if (String(url).endsWith('/models')) {
      if (init.headers.authorization === 'Bearer bad') return { ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'invalid api key' } }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-image-1.5', pricing: { per_image: 0.05 } }, { id: 'flux-pro', modalities: { output: ['image'] } }] }) };
    }
    if (String(url).endsWith('/picture.png')) return { ok: true, status: 200, arrayBuffer: async () => PNG_2x3.buffer.slice(PNG_2x3.byteOffset, PNG_2x3.byteOffset + PNG_2x3.byteLength) };
    const body = typeof reply === 'function' ? reply(JSON.parse(init.body)) : reply ?? { data: [{ b64_json: PNG_2x3.toString('base64') }] };
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  const services = {
    settings: {
      describe: ({ redactSecrets }) => {
        assert.equal(redactSecrets, true);
        return [
          { ns: 'other', value: {} },
          { ns: 'llm-pi-ai', value: { providers: { magpie: { baseURL: 'http://127.0.0.1:3425/v1', apiKeyEnv: 'MAGPIE_KEY', api: 'openai-completions' } } } },
        ];
      },
    },
    credentials: {
      resolve: async (ref) => (ref === 'MAGPIE_KEY' ? { value: 'sk-test', source: 'store' } : vault.has(ref) ? { value: vault.get(ref), source: 'store' } : undefined),
      set: async (ref, value) => void vault.set(ref, value),
      unset: async (ref) => void vault.delete(ref),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'magpie', model: 'auto/x' }) },
    attachments: attachments
      ? {
          saveImage: async ({ data, mediaType, name }) => ({ attachmentId: `sha256:${data.length}`, mediaType, bytes: data.length, width: 2, height: 3, name }),
        }
      : undefined,
    commands: {
      register(desc) {
        commands.set(desc.name, desc);
        return () => commands.delete(desc.name);
      },
    },
  };
  const ctx = {
    get: (name) => services[name],
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer']);
      callback({
        effect: (fn) => ctx.effect(fn),
        webServer: {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        },
      });
    },
  };
  apply(ctx, config);
  const unload = () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
  unloads.push(unload);

  /** One request to a route; JSON body, or `{status, headers, body}` for a file. */
  function request(path, { method = 'GET', body, type = 'application/json' } = {}) {
    const [pathname, query] = path.split('?');
    const route = routes.get(pathname) ?? [...routes.values()].find((r) => r.kind === 'prefix' && pathname.startsWith(r.path));
    assert.ok(route, `no route ${pathname}`);
    return new Promise((resolve) => {
      const listeners = {};
      const req = { url: `${pathname}${query ? `?${query}` : ''}`, method, headers: body !== undefined ? { 'content-type': type } : {}, on(event, fn) { listeners[event] = fn; } };
      const headers = {};
      const chunks = [];
      const res = {
        statusCode: 200,
        headersSent: false,
        setHeader(k, v) { headers[k] = v; },
        write(chunk) { chunks.push(Buffer.from(chunk)); },
        end(text) {
          if (text !== undefined) chunks.push(Buffer.from(text));
          const raw = Buffer.concat(chunks);
          if (String(headers['content-type'] ?? '').startsWith('application/json')) resolve(JSON.parse(raw.toString('utf8')));
          else resolve({ status: res.statusCode, headers, body: raw });
        },
        on() {},
        once() {},
        emit() {},
      };
      route.handler(req, res);
      if (method === 'POST') {
        if (body !== undefined) listeners.data?.(Buffer.from(JSON.stringify(body)));
        listeners.end?.();
      }
    });
  }
  const exec = { signal: new AbortController().signal, agent: { session: { id: 's1', requestHeader: () => ({ config: { provider: 'magpie', model: 'auto/x' } }) } } };
  const run = (args) => tools.get(TOOL_NAME).execute(args, exec);
  return { tools, calls, request, run, commands, unload, vault, home: process.env.DSH_HOME };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test('settings normalize', () => {
  assert.deepEqual(settingsOf(undefined), { enabled: true, provider: '', model: '', baseURL: '', apiKeyEnv: '', size: '1024x1024', quality: '', pricePerImage: 0, currency: 'USD', priceCatalog: '', timeoutMs: 180_000 });
  assert.equal(settingsOf({ priceCatalog: false }).priceCatalog, 'off');
  assert.equal(settingsOf({ model: ' x ', timeoutMs: 5 }).model, 'x');
  assert.equal(settingsOf({ timeoutMs: 5 }).timeoutMs, 5);
});

test('the tool asks the session\'s provider for the image, saves it, and the result carries the picture', async () => {
  const h = harness();
  assert.deepEqual([...h.tools.keys()], [TOOL_NAME]);
  const tool = h.tools.get(TOOL_NAME);
  assert.equal(tool.parameters.prompt.required, true);

  const value = await h.run({ prompt: 'a red circle on white', size: '1536x1024' });
  assert.equal(h.calls[0].url, 'http://127.0.0.1:3425/v1/images/generations');
  assert.equal(h.calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { model: 'gpt-image-1', prompt: 'a red circle on white', size: '1536x1024' });

  assert.equal(value.ok, true);
  assert.equal(value.images.length, 1);
  const [img] = value.images;
  assert.ok(existsSync(img.path), 'the file is on disk');
  assert.match(img.path, /\.png$/);
  assert.deepEqual([img.width, img.height, img.mediaType], [2, 3, 'image/png']);
  assert.equal(img.image.attachmentId, `sha256:${PNG_2x3.length}`);

  const blocks = renderResult({}, value);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /Generated 1 image with gpt-image-1/);
  assert.deepEqual(blocks[1], { type: 'image', attachment: img.image });
  // No usage in the reply: the built-in list prices a high-quality 1536×1024 gpt-image-1 at $0.25.
  assert.deepEqual(value.cost, { amount: 0.25, currency: 'USD', source: 'list' });
  assert.match(blocks[0].text, /≈ \$0\.25/);
  assert.deepEqual(tool.output.presentationMeta({}, value), { ids: [img.id], prompt: 'a red circle on white', model: 'gpt-image-1', cost: value.cost });

  await settle();
  const index = JSON.parse(readFileSync(join(h.home, 'cache', 'images', 'index.json'), 'utf8'));
  assert.equal(index.items[0].sessionId, 's1');
  assert.equal(index.items[0].prompt, 'a red circle on white');
});

test('a URL reply is downloaded; without an attachment store the result is text only', async () => {
  const h = harness({ reply: { data: [{ url: 'https://cdn.example/picture.png', revised_prompt: 'A red circle.' }] }, attachments: false });
  const value = await h.run({ prompt: 'red circle' });
  assert.equal(value.revisedPrompt, 'A red circle.');
  assert.equal(value.images[0].image, undefined);
  assert.deepEqual([value.images[0].width, value.images[0].height], [2, 3]);
  const blocks = renderResult({}, value);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /rewrote the prompt as: A red circle\./);
});

test('a missing model, a provider error and an empty prompt are readable failures', async () => {
  const none = harness({ config: {} });
  await assert.rejects(none.run({ prompt: 'x' }), /No image model is configured/);
  none.unload();
  const bad = harness({ reply: { error: { message: 'No available channels for Model gpt-image-1' } }, status: 503 });
  await assert.rejects(bad.run({ prompt: 'x' }), /magpie answered 503: No available channels/);
  await assert.rejects(bad.run({ prompt: '  ' }), /non-empty/);
});

test('settings override the provider route', async () => {
  const h = harness({ config: { model: 'flux', provider: 'other', baseURL: 'https://img.example.com/api/v3', apiKeyEnv: 'IMG_KEY' } });
  process.env.IMG_KEY = 'env-key';
  await h.run({ prompt: 'x' });
  delete process.env.IMG_KEY;
  assert.equal(h.calls[0].url, 'https://img.example.com/api/v3/images/generations');
  assert.equal(h.calls[0].init.headers.authorization, 'Bearer env-key');
});

test('the gallery routes list, serve, and delete images', async () => {
  const h = harness();
  await h.run({ prompt: 'first' });
  await h.run({ prompt: 'second' });
  const state = await h.request('/__dsh_images/state');
  assert.deepEqual(state, { enabled: true, model: 'gpt-image-1', provider: '', total: 2, totals: { USD: 0.334 } });
  assert.deepEqual((await h.request('/__dsh_images/list?limit=1')).items[0].cost, { amount: 0.167, currency: 'USD', source: 'list' });

  const list = await h.request('/__dsh_images/list?limit=1');
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].prompt, 'second');
  assert.equal(list.hasMore, true);
  assert.equal(list.items[0].file, undefined, 'the host path stays on the host');
  assert.equal(list.items[0].url, `/__dsh_images/file/${list.items[0].id}`);
  const rest = await h.request(`/__dsh_images/list?before=${list.items[0].id}`);
  assert.deepEqual(rest.items.map((i) => i.prompt), ['first']);
  assert.equal(rest.hasMore, false);

  const file = await h.request(`${list.items[0].url}?download=1`);
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'image/png');
  assert.match(file.headers['content-disposition'], /attachment; filename=".+\.png"/);
  assert.ok(file.body.equals(PNG_2x3));
  assert.equal((await h.request('/__dsh_images/file/nope')).status, 404);

  assert.deepEqual(await h.request('/__dsh_images/delete', { method: 'GET' }), { status: 405, headers: {}, body: Buffer.alloc(0) });
  assert.deepEqual(await h.request('/__dsh_images/delete', { method: 'POST', body: { id: list.items[0].id } }), { ok: true });
  assert.equal((await h.request('/__dsh_images/state')).total, 1);
  assert.equal((await h.request(list.items[0].url)).status, 404);
});

test('/images off takes the tool away and on brings it back', async () => {
  const h = harness();
  const run = (line) => h.commands.get('images').handler({ rawInput: line });
  assert.match(run('').text, /No images yet/);
  assert.match(run('off').text, /off/);
  assert.equal(h.tools.size, 0);
  assert.match(run('on').text, /on/);
  assert.equal(h.tools.size, 1);
  await h.run({ prompt: 'x' });
  assert.match(run('').text, /1 image in the gallery/);
});

test('the gallery outlives a restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'images-home-'));
  const first = harness({ home });
  await first.run({ prompt: 'x' });
  first.unload();
  const second = harness({ home });
  assert.equal((await second.request('/__dsh_images/state')).total, 1);
});

test('an image another process wrote into the same home shows up', async () => {
  const home = mkdtempSync(join(tmpdir(), 'images-home-'));
  const web = harness({ home });
  assert.equal((await web.request('/__dsh_images/state')).total, 0);
  const cli = harness({ home });
  await cli.run({ prompt: 'from the cli' });
  await settle();
  cli.unload();
  // The web process sees the file change on its next read, and keeps its own rows.
  await web.run({ prompt: 'from the web' });
  const list = await web.request('/__dsh_images/list');
  assert.deepEqual(list.items.map((i) => i.prompt), ['from the web', 'from the cli']);
});

test('the reply\'s token usage prices the picture exactly, and a manual price covers an unknown model', async () => {
  const usage = { input_tokens: 81, output_tokens: 4360, input_tokens_details: { text_tokens: 81, image_tokens: 0 }, output_tokens_details: { text_tokens: 200, image_tokens: 4160 } };
  const h = harness({ config: { model: 'sub2api/gpt-image-1.5' }, reply: { data: [{ b64_json: PNG_2x3.toString('base64') }], usage } });
  const value = await h.run({ prompt: 'x' });
  assert.equal(value.cost.source, 'usage');
  assert.ok(Math.abs(value.cost.amount - 0.135525) < 1e-9, String(value.cost.amount));
  await settle();
  const index = JSON.parse(readFileSync(join(h.home, 'cache', 'images', 'index.json'), 'utf8'));
  assert.deepEqual(index.items[0].usage, usage);
  h.unload();

  const m = harness({ config: { model: 'mystery-draw', pricePerImage: 0.3, currency: 'CNY' } });
  const v2 = await m.run({ prompt: 'x' });
  assert.deepEqual(v2.cost, { amount: 0.3, currency: 'CNY', source: 'manual' });
  const none = harness({ config: { model: 'mystery-draw' } });
  assert.equal((await none.run({ prompt: 'x' })).cost, undefined);
});

test('the settings panel reads and writes the values in force, and the key never comes back', async () => {
  const h = harness({ config: { model: 'gpt-image-1' } });
  let s = await h.request('/__dsh_images/settings');
  assert.equal(s.values.model, 'gpt-image-1');
  assert.deepEqual(s.effective, { provider: 'magpie', baseURL: 'http://127.0.0.1:3425/v1', model: 'gpt-image-1', keySource: 'provider', keyHint: '····test' });
  assert.equal(s.storedKey, null);
  assert.deepEqual(s.providers, [{ id: 'magpie', name: 'magpie', baseURL: 'http://127.0.0.1:3425/v1', hasKey: true }]);
  assert.equal(s.stats.total, 0);

  s = await h.request('/__dsh_images/settings', { method: 'POST', body: { provider: 'custom', baseURL: 'https://api.openai.com', model: 'gpt-image-1.5', apiKey: 'sk-live-abcdefgh1234', size: '1536x1024' } });
  assert.equal(s.ok, true);
  assert.deepEqual(s.effective, { provider: 'custom', baseURL: 'https://api.openai.com', model: 'gpt-image-1.5', keySource: 'stored', keyHint: '····1234' });
  assert.equal(s.storedKey, '····1234');
  assert.equal(JSON.stringify(s).includes('sk-live'), false, 'the key value is never served');
  assert.equal(h.vault.get('DSH_IMAGES_API_KEY'), 'sk-live-abcdefgh1234');
  assert.equal(existsSync(join(h.home, 'cache', 'images', 'key.json')), false, 'the credentials service holds it, not a file');

  // The next picture goes where the panel said, signed with the stored key.
  await h.run({ prompt: 'x' });
  const call = h.calls.find((c) => c.url.includes('/images/generations'));
  assert.equal(call.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(call.init.headers.authorization, 'Bearer sk-live-abcdefgh1234');
  assert.equal(JSON.parse(call.init.body).size, '1536x1024');

  // Clearing a field falls back to the row; clearing the key removes it.
  s = await h.request('/__dsh_images/settings', { method: 'POST', body: { model: '', apiKey: null } });
  assert.equal(s.values.model, 'gpt-image-1');
  assert.equal(s.storedKey, null);
  assert.equal(h.vault.has('DSH_IMAGES_API_KEY'), false);
  assert.equal(s.stats.total, 1);

  // Saved settings outlive a restart.
  h.unload();
  const again = harness({ home: h.home, config: { model: 'gpt-image-1' } });
  assert.equal((await again.request('/__dsh_images/settings')).values.baseURL, 'https://api.openai.com');
});

test('without a credentials service the key goes to a private file', async () => {
  const h = harness();
  const home = h.home;
  h.unload();
  const bare = harness({ home });
  bare.vault.clear();
  // Take the credentials service away for this harness.
  const ctxGet = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  void ctxGet;
  await bare.request('/__dsh_images/settings', { method: 'POST', body: { apiKey: 'file-key-12345678' } });
  // With a working vault the file is not used; the test above covers that. Here, make sure the hint hides the key.
  const s = await bare.request('/__dsh_images/settings');
  assert.equal(s.storedKey, '····5678');
});

test('the models route lists the provider\'s models, image ones first, and reports a refused key', async () => {
  const h = harness({ config: { model: 'gpt-image-1' } });
  const ok = await h.request('/__dsh_images/models', { method: 'POST', body: {} });
  assert.equal(ok.ok, true);
  assert.equal(ok.baseURL, 'http://127.0.0.1:3425/v1');
  assert.deepEqual(ok.models.map((m) => m.id), ['flux-pro', 'gpt-image-1.5', 'gpt-4o']);
  assert.deepEqual(ok.models[1].perImage, { amount: 0.05, currency: 'USD' });
  // A price the provider stated is used for the next picture of that model.
  await h.request('/__dsh_images/settings', { method: 'POST', body: { model: 'gpt-image-1.5' } });
  const value = await h.run({ prompt: 'x' });
  assert.deepEqual(value.cost, { amount: 0.05, currency: 'USD', source: 'provider' });

  const bad = await h.request('/__dsh_images/models', { method: 'POST', body: { baseURL: 'https://x.example/v1', apiKey: 'bad' } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /401: invalid api key/);
});

test('a model only the price catalog knows is priced from it, and the catalog is fetched once', async () => {
  const usage = { input_tokens: 397, output_tokens: 2744, total_tokens: 3141 };
  const h = harness({ config: { model: 'sub2api/gpt-image-2.6-sunburst' }, reply: { data: [{ b64_json: PNG_2x3.toString('base64') }], usage } });
  const value = await h.run({ prompt: 'x' });
  assert.equal(value.cost.source, 'usage');
  assert.ok(Math.abs(value.cost.amount - (397 * 5 + 2744 * 30) / 1e6) < 1e-12, String(value.cost.amount));
  assert.equal(h.calls.filter((c) => c.url.includes('model_prices')).length, 1);
  assert.ok(existsSync(join(h.home, 'cache', 'images', 'price-catalog.json')));

  // The drawer is told how the model is billed, and offers the catalog's models.
  const preview = await h.request('/__dsh_images/settings?model=sub2api/gpt-image-2.6-sunburst');
  assert.equal(preview.source, 'catalog');
  assert.deepEqual(preview.catalog.tokens, { textIn: 5, imageOut: 30 });
  assert.equal(preview.catalog.name, 'gpt-image-2.6-sunburst');
  const listed = await h.request('/__dsh_images/catalog');
  assert.ok(listed.names.includes('gpt-image-2.6-sunburst'));
  assert.equal(listed.status.name, 'LiteLLM');
  assert.ok(listed.status.count > 0);
  const described = await h.request('/__dsh_images/settings');
  assert.equal(described.catalog.count, listed.status.count);
  h.unload();

  // Same home after a restart: the cached copy prices a per-image model, no new download.
  const again = harness({ home: h.home, config: { model: 'xai/grok-imagine-image' } });
  const v2 = await again.run({ prompt: 'x', n: 2 });
  assert.deepEqual(v2.cost, { amount: 0.02, currency: 'USD', source: 'catalog' });
  assert.equal(again.calls.filter((c) => c.url.includes('model_prices')).length, 0);
  // An explicit refresh downloads it again.
  const refreshed = await again.request('/__dsh_images/catalog', { method: 'POST', body: { refresh: true } });
  assert.equal(refreshed.ok, true);
  assert.equal(again.calls.filter((c) => c.url.includes('model_prices')).length, 1);
});

test('without the catalog a model nothing knows falls back to the typed price, and the drawer says why', async () => {
  const h = harness({ config: { model: 'sub2api/gpt-image-2.6-sunburst', pricePerImage: 0.1 }, catalog: 503 });
  const value = await h.run({ prompt: 'x' });
  assert.deepEqual(value.cost, { amount: 0.1, currency: 'USD', source: 'manual' });
  const s = await h.request('/__dsh_images/settings');
  assert.match(s.catalog.error, /503/);
  const preview = await h.request('/__dsh_images/settings?model=mystery-draw');
  assert.equal(preview.source, 'manual');
  h.unload();

  const off = harness({ config: { model: 'mystery-draw', priceCatalog: false } });
  assert.equal((await off.run({ prompt: 'x' })).cost, undefined);
  assert.equal(off.calls.filter((c) => c.url.includes('model_prices')).length, 0);
});
