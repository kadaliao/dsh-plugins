import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const allHooks = [];
afterEach(() => {
  for (const hooks of allHooks.splice(0)) hooks.runCleanups();
  delete globalThis.fetch;
});
const source = readFileSync(join(root, 'client.js'), 'utf8');

/** A hook-capable stand-in for React that renders plain element trees. */
function fakeReact() {
  let slots = [];
  let cursor = 0;
  const hooks = {
    reset() {
      slots = [];
      cursor = 0;
    },
    rewind() {
      cursor = 0;
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      const set = (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      };
      return [slots[index], set];
    },
    cleanups: [],
    useEffect(effect, deps) {
      const index = cursor++;
      const last = slots[index];
      if (last !== undefined && deps !== undefined && deps.length === last.length && deps.every((d, i) => Object.is(d, last[i]))) return;
      slots[index] = deps ?? [];
      const cleanup = effect();
      if (typeof cleanup === 'function') hooks.cleanups.push(cleanup);
    },
    runCleanups() {
      for (const cleanup of hooks.cleanups.splice(0)) cleanup();
    },
  };
  const createElement = (type, props, ...children) => {
    const kids = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
    if (typeof type === 'function') return type({ ...(props ?? {}), ...(kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {}) });
    return { type, props: props ?? {}, children: kids };
  };
  const react = { createElement, useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect };
  allHooks.push(hooks);
  return { React: react, hooks };
}

async function loadClient() {
  const { React, hooks } = fakeReact();
  let factory;
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory: make }) {
        assert.equal(id, '@kadaliao/dsh-images');
        factory = make;
      },
    },
  };
  new Function('source', `${source}\n//# sourceURL=client.js`)(source);
  const exports = factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require ${name}`);
  });
  return { exports, hooks };
}

function fakeContext({ services = {} } = {}) {
  const seen = { slots: [], locale: null, decorations: [], selected: [], definitions: [] };
  const layout = {
    selectPanel(id) {
      seen.selected.push(id);
    },
  };
  const all = { layout, ...services };
  const ctx = {
    get: (name) => all[name],
    inject(names, callback) {
      seen.injected = [...(seen.injected ?? []), ...names];
      callback({
        effect: (fn) => fn(),
        commandUi: {
          decorate(decoration) {
            seen.decorations.push(decoration);
            return () => {};
          },
        },
      });
    },
    effect: (fn) => fn(),
    uiConversation: {
      events: {
        register(definition) {
          seen.definitions.push(definition);
          return () => {};
        },
      },
    },
    locale: {
      register(ns, dict) {
        seen.locale = { ns, dict };
        return () => {};
      },
    },
    slots: {
      inject: (_key, callback) => callback(),
      register(options, component) {
        seen.slots.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, seen };
}

function collect(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  for (const child of node.children ?? []) collect(child, out);
  return out;
}
function findAll(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, pred, out);
  return out;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the client registers the tool view, the panel icon, the panel and /images', async () => {
  const { exports } = await loadClient();
  assert.deepEqual(exports.inject, ['slots', 'locale', 'uiConversation']);
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const names = seen.slots.map((s) => [s.options.name, s.options.key ?? s.options.id]);
  assert.deepEqual(names, [
    ['tool.call.toolview', 'generate_image'],
    ['conversation.chat.node', 'images-result'],
    ['sidebar.panellist', 'images'],
    ['main', 'images'],
  ]);
  assert.equal(seen.slots[2].options.label(), 'Images');
  assert.equal(seen.locale.ns, 'images');
  assert.deepEqual(Object.keys(seen.locale.dict.zh).sort(), Object.keys(seen.locale.dict.en).sort());
  assert.deepEqual(seen.injected, ['commandUi']);
  const [decoration] = seen.decorations;
  assert.equal(decoration.name, 'images');
  assert.equal(decoration.available(), true);
  decoration.ui.run({});
  assert.deepEqual(seen.selected, ['images']);
  // The glyph takes the owner's size and marks the active panel.
  const glyph = seen.slots[2].component({ size: 20, active: true });
  assert.equal(glyph.props.width, 20);
});

test('the tool view shows the prompt while generating, then the picture from the gallery', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const view = seen.slots.find((s) => s.options.name === 'tool.call.toolview').component;

  hooks.reset();
  let tree = view({ phase: 'start', block: { callId: 'c1', name: 'generate_image', argsRaw: '{"prompt":"a red circle"}' } });
  let text = collect(tree).join(' ');
  assert.match(text, /Image/);
  assert.match(text, /generating…/);
  assert.match(text, /a red circle/);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-images-pending']).length, 1);
  assert.equal(findAll(tree, (n) => n.type === 'img').length, 0);

  hooks.reset();
  const attachment = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 1024, height: 1536 };
  tree = view({
    phase: 'result',
    loadImage: () => Promise.resolve('blob:never-used'),
    block: {
      kind: 'tool-result',
      callId: 'c1',
      name: 'generate_image',
      call: { name: 'generate_image', argsRaw: '{"prompt":"a red circle"}' },
      content: [{ type: 'text', text: 'Generated 1 image' }, { type: 'image', attachment }],
      isError: false,
      meta: { ids: ['k1-abc'], prompt: 'a red circle', model: 'gpt-image-1' },
    },
  });
  const [img] = findAll(tree, (n) => n.type === 'img');
  assert.equal(img.props.src, '/__dsh_images/file/k1-abc');
  assert.equal(img.props.alt, 'a red circle');
  assert.match(collect(tree).join(' '), /gpt-image-1/);
  const tile = findAll(tree, (n) => n.props['data-dsh-images-tile'] === 'k1-abc')[0];
  const ratio = findAll(tile, (n) => n.props.style?.aspectRatio)[0];
  assert.equal(ratio.props.style.aspectRatio, '1024 / 1536');

  // Clicking the picture opens the lightbox; Escape is wired, the download button is there.
  ratio.props.onClick();
  hooks.rewind();
  tree = view({ phase: 'result', block: { kind: 'tool-result', callId: 'c1', call: { argsRaw: '{"prompt":"a red circle"}' }, content: [{ type: 'image', attachment }], isError: false, meta: { ids: ['k1-abc'] } } });
  const box = findAll(tree, (n) => n.props['data-dsh-images-lightbox'])[0];
  assert.ok(box, 'the lightbox is open');
  assert.ok(findAll(box, (n) => n.props['aria-label'] === 'Download').length === 1);
});

test('an animated result shows the GIF from the gallery at its own size, not the sheet attachment\'s', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const view = seen.slots.find((s) => s.options.name === 'tool.call.toolview').component;
  hooks.reset();
  const sheet = { attachmentId: 'sha256:sheet', mediaType: 'image/png', bytes: 10, width: 1024, height: 1024 };
  const tree = view({
    phase: 'result',
    block: {
      kind: 'tool-result',
      callId: 'g1',
      call: { argsRaw: '{"prompt":"a cat chasing yarn","frames":16}' },
      content: [{ type: 'image', attachment: sheet }],
      isError: false,
      meta: { ids: ['k2-gif'], media: [{ mediaType: 'image/gif', width: 240, height: 240, frames: 16 }], prompt: 'a cat chasing yarn', model: 'gpt-image-2' },
    },
  });
  const [img] = findAll(tree, (n) => n.type === 'img');
  assert.equal(img.props.src, '/__dsh_images/file/k2-gif');
  const tile = findAll(tree, (n) => n.props['data-dsh-images-tile'] === 'k2-gif')[0];
  assert.equal(findAll(tile, (n) => n.props.style?.aspectRatio)[0].props.style.aspectRatio, '240 / 240');
});

test('the viewer zooms with its buttons, the wheel and the keyboard, and pans when zoomed', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const view = seen.slots.find((s) => s.options.name === 'tool.call.toolview').component;
  const attachment = { attachmentId: 'sha256:z', mediaType: 'image/png', bytes: 10, width: 800, height: 600 };
  const props = { phase: 'result', block: { kind: 'tool-result', callId: 'z1', call: { argsRaw: '{"prompt":"p"}' }, content: [{ type: 'image', attachment }], isError: false, meta: { ids: ['z1'] } } };
  const listeners = {};
  globalThis.document = {
    body: { style: {} },
    addEventListener: (type, fn) => void (listeners[type] = fn),
    removeEventListener: () => {},
  };
  try {
    hooks.reset();
    let tree = view(props);
    findAll(tree, (n) => n.props['data-dsh-images-tile'] === 'z1').flatMap((t) => findAll(t, (n) => n.props.role === 'button'))[0].props.onClick();
    const render = () => {
      hooks.rewind();
      tree = view(props);
      const box = findAll(tree, (n) => n.props['data-dsh-images-lightbox'])[0];
      return { box, img: findAll(box, (n) => n.type === 'img')[0], bar: findAll(box, (n) => n.props['data-dsh-images-zoom'])[0] };
    };
    const ev = { stopPropagation() {}, preventDefault() {} };
    let { img, bar } = render();
    assert.match(img.props.style.transform, /scale\(1\)/);
    assert.match(collect(bar).join(' '), /100%/);

    findAll(bar, (n) => n.props['aria-label'] === 'Zoom in (+, wheel)')[0].props.onClick(ev);
    ({ img, bar } = render());
    assert.match(img.props.style.transform, /scale\(1\.25\)/);
    assert.match(collect(bar).join(' '), /125%/);
    assert.equal(img.props.style.cursor, 'grab');

    // Dragging pans the zoomed picture.
    img.props.onPointerDown({ ...ev, button: 0, pointerId: 1, clientX: 10, clientY: 10, currentTarget: {} });
    img.props.onPointerMove({ pointerId: 1, clientX: 40, clientY: 30 });
    img.props.onPointerUp({ pointerId: 1 });
    ({ img } = render());
    assert.match(img.props.style.transform, /translate\(30px, 20px\) scale\(1\.25\)/);

    // Keyboard: + zooms, 0 fits; zooming out never goes below half.
    listeners.keydown({ key: '+', ...ev });
    ({ bar } = render());
    assert.match(collect(bar).join(' '), /156%/);
    listeners.keydown({ key: '0', ...ev });
    ({ img } = render());
    assert.equal(img.props.style.transform, 'translate(0px, 0px) scale(1)');
    for (let i = 0; i < 10; i += 1) listeners.keydown({ key: '-', ...ev });
    ({ bar } = render());
    assert.match(collect(bar).join(' '), /50%/);

    // The fit button resets; the wheel zooms through a native, non-passive listener.
    findAll(bar, (n) => n.props['aria-label'] === 'Fit to screen (0)')[0].props.onClick(ev);
    const { box } = render();
    const stage = findAll(box, (n) => n.props['data-dsh-images-stage'])[0];
    let wheel;
    let options;
    stage.props.ref({ addEventListener: (type, fn, opts) => { wheel = fn; options = opts; }, removeEventListener() {}, querySelector: () => null });
    assert.deepEqual(options, { passive: false });
    let prevented = false;
    wheel({ deltaY: -200, deltaMode: 0, ctrlKey: false, clientX: 0, clientY: 0, preventDefault: () => { prevented = true; } });
    assert.ok(prevented);
    ({ bar } = render());
    assert.match(collect(bar).join(' '), /135%/);
  } finally {
    hooks.runCleanups();
    delete globalThis.document;
  }
});

test('a failed call shows the error, and a result without gallery ids falls back to the attachment loader', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const view = seen.slots.find((s) => s.options.name === 'tool.call.toolview').component;
  hooks.reset();
  let tree = view({ phase: 'result', block: { kind: 'tool-result', callId: 'c2', call: { argsRaw: '{"prompt":"x"}' }, content: [{ type: 'text', text: 'Error: provider answered 503' }], isError: true } });
  assert.match(collect(tree).join(' '), /provider answered 503/);

  hooks.reset();
  const attachment = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 2, height: 2 };
  const loadImage = Object.assign(() => Promise.resolve('blob:loaded'), { peek: () => undefined });
  const props = { phase: 'result', loadImage, block: { kind: 'tool-result', callId: 'c3', call: { argsRaw: '{}' }, content: [{ type: 'image', attachment }], isError: false, meta: {} } };
  tree = view(props);
  assert.match(collect(tree).join(' '), /loading…/);
  await flush();
  hooks.rewind();
  tree = view(props);
  assert.equal(findAll(tree, (n) => n.type === 'img')[0].props.src, 'blob:loaded');
});

test('the gallery panel lists the newest images first, enlarges one, and removes one', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  const posts = [];
  const items = [
    { id: 'b', url: '/__dsh_images/file/b', mediaType: 'image/png', width: 1536, height: 1024, prompt: 'second', model: 'gpt-image-1', createdAt: Date.now() - 5000 },
    { id: 'a', url: '/__dsh_images/file/a', mediaType: 'image/png', width: 1024, height: 1024, prompt: 'first', model: 'gpt-image-1', createdAt: Date.now() - 86_400_000 * 2 },
  ];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ items, hasMore: false, total: 2 }) };
  };
  hooks.reset();
  let tree = panel({});
  assert.match(collect(tree).join(' '), /…/);
  await flush();
  hooks.rewind();
  tree = panel({});
  let text = collect(tree).join(' ');
  assert.match(text, /Images/);
  assert.match(text, /2 images/);
  assert.match(text, /second.*first/s);
  assert.match(text, /just now/);
  assert.match(text, /2 d ago/);
  const imgs = findAll(tree, (n) => n.type === 'img').map((n) => n.props.src);
  assert.deepEqual(imgs, ['/__dsh_images/file/b', '/__dsh_images/file/a']);

  // Enlarge the second tile, then step to the first with the arrow.
  const tiles = findAll(tree, (n) => n.props['data-dsh-images-tile']);
  findAll(tiles[1], (n) => n.props.role === 'button')[0].props.onClick();
  hooks.rewind();
  tree = panel({});
  let box = findAll(tree, (n) => n.props['data-dsh-images-lightbox'])[0];
  assert.ok(box);
  assert.equal(findAll(box, (n) => n.type === 'img')[0].props.src, '/__dsh_images/file/a');
  assert.match(collect(box).join(' '), /2 \/ 2/);
  findAll(box, (n) => n.props['aria-label'] === 'Previous')[0].props.onClick({ stopPropagation() {} });
  hooks.rewind();
  tree = panel({});
  box = findAll(tree, (n) => n.props['data-dsh-images-lightbox'])[0];
  assert.equal(findAll(box, (n) => n.type === 'img')[0].props.src, '/__dsh_images/file/b');
  box.props.onClick();

  // The corner menu of a tile offers download, copy and remove; remove posts to the host.
  hooks.rewind();
  tree = panel({});
  const tile = findAll(tree, (n) => n.props['data-dsh-images-tile'] === 'b')[0];
  findAll(tile, (n) => n.props['aria-label'] === 'More')[0].props.onClick({ stopPropagation() {} });
  hooks.rewind();
  tree = panel({});
  const menu = findAll(tree, (n) => n.props['data-dsh-images-menu'])[0];
  assert.deepEqual(collect(menu), ['Download', 'Copy prompt', 'Remove from gallery']);
  findAll(menu, (n) => n.props.role === 'menuitem')[2].props.onClick();
  await flush();
  assert.deepEqual(posts, [{ url: '/__dsh_images/delete', body: { id: 'b' } }]);
  hooks.rewind();
  tree = panel({});
  assert.match(collect(tree).join(' '), /1 images/);
  assert.equal(findAll(tree, (n) => n.type === 'img').length, 1);
});

test('an empty gallery says how it fills; an unreachable host says so', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [], hasMore: false, total: 0 }) });
  hooks.reset();
  panel({});
  await flush();
  hooks.rewind();
  assert.match(collect(panel({})).join(' '), /No images yet/);
  hooks.runCleanups();

  globalThis.fetch = async () => ({ ok: false });
  hooks.reset();
  panel({});
  await flush();
  hooks.rewind();
  assert.match(collect(panel({})).join(' '), /not reachable/);
});

test('a generate_image result gets its own row at turn level, outside the process fold', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const [definition] = seen.definitions;
  assert.equal(definition.kind, 'images-result');

  // Another tool's call and result are not ours.
  assert.equal(definition.match({ type: 'tool/call', seq: 1, data: { callId: 'x1', name: 'bash' } }), null);
  assert.equal(definition.match({ type: 'tool/result', surfaceOp: 'append', seq: 2, data: { message: { source: { callId: 'x1' }, content: [] } } }), null);
  // Ours: the call is remembered, the result matched.
  assert.equal(definition.match({ type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'generate_image' } }), null);
  const attachment = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 4, height: 3 };
  const result = {
    type: 'tool/result',
    surfaceOp: 'append',
    seq: 4,
    time: 9,
    data: { message: { source: { callId: 'c1' }, content: [{ type: 'image', attachment }], isError: false }, meta: { ids: ['k1'], prompt: 'a star', model: 'm' } },
  };
  assert.deepEqual(definition.match(result), { id: 'c1', role: 'start' });
  // A result whose call this page never saw (an older Session) is known by its meta.
  assert.deepEqual(definition.match({ ...result, data: { ...result.data, message: { ...result.data.message, source: { callId: 'c9' } } } }), { id: 'c9', role: 'start' });

  const match = { event: result, location: { kind: 'step' } };
  const state = definition.start({}, match);
  const node = definition.buildViewNode({ key: 'images-result:c1', id: 'c1', state, start: match });
  assert.equal(node.kind, 'images-result');
  assert.equal(node.anchorSeq, 4.2);
  assert.equal(node.groupTree, 'turn');
  // A failed result draws no row.
  assert.equal(definition.buildViewNode({ key: 'k', id: 'c1', state: { ...state, isError: true }, start: match }), null);

  const row = seen.slots.find((s) => s.options.name === 'conversation.chat.node').component;
  hooks.reset();
  const tree = row({ node, sessionId: 's1' });
  const [img] = findAll(tree, (n) => n.type === 'img');
  assert.equal(img.props.src, '/__dsh_images/file/k1');
  assert.equal(img.props.alt, 'a star');
});

test('every picture shows its model and cost; the header sums what was spent', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const row = seen.slots.find((s) => s.options.name === 'conversation.chat.node').component;
  const attachment = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 1024, height: 1536 };
  const node = { data: { callId: 'c1', content: [{ type: 'image', attachment }], isError: false, meta: { ids: ['k1'], prompt: 'p', model: 'gpt-image-1.5', cost: { amount: 0.1355, currency: 'USD', source: 'usage' } } } };
  hooks.reset();
  const text = collect(row({ node, sessionId: 's1' })).join(' ');
  assert.match(text, /gpt-image-1\.5 · 1024×1536 · ≈ \$0\.136/);

  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith('/__dsh_images/state')) return { ok: true, json: async () => ({ total: 2, totals: { USD: 0.27, CNY: 0.4 } }) };
    return {
      ok: true,
      json: async () => ({
        total: 2,
        hasMore: false,
        items: [
          { id: 'a', url: '/__dsh_images/file/a', width: 1, height: 1, prompt: 'x', model: 'gpt-image-1.5', cost: { amount: 0.07, currency: 'USD', source: 'list' }, createdAt: Date.now() },
          { id: 'b', url: '/__dsh_images/file/b', width: 1, height: 1, prompt: 'y', model: 'seedream', cost: { amount: 0.4, currency: 'CNY', source: 'manual' }, createdAt: Date.now() },
        ],
      }),
    };
  };
  hooks.reset();
  panel({});
  await flush();
  await flush();
  hooks.rewind();
  const tree = panel({});
  const all = collect(tree).join(' ');
  assert.match(all, /2 images · spent \$0\.27 · ¥0\.4/);
  assert.match(all, /gpt-image-1\.5 · 1×1 · ≈ \$0\.07/);
  assert.match(all, /seedream · 1×1 · ≈ ¥0\.4/);
  hooks.runCleanups();
});

test('the settings drawer shows what is in force, tests the connection, and saves without echoing the key', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  const posts = [];
  const info = {
    values: { provider: '', baseURL: '', model: 'gpt-image-1', size: '1024x1024', quality: '', pricePerImage: 0, currency: 'USD' },
    defaults: { provider: '', baseURL: '', model: 'gpt-image-1', size: '1024x1024', quality: '' },
    effective: { provider: 'magpie', baseURL: 'http://127.0.0.1:3425/v1', model: 'gpt-image-1', keySource: 'provider', keyHint: '····test' },
    problem: '',
    storedKey: null,
    providers: [{ id: 'magpie', name: 'Magpie', baseURL: 'http://127.0.0.1:3425/v1', hasKey: true }],
    sessionProvider: 'magpie',
    priceListDate: '2026-11-09',
    stats: { total: 3, totals: { USD: 0.5 }, byModel: { 'gpt-image-1': { count: 3, totals: { USD: 0.5 } } } },
  };
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(init.body) });
      if (path === '/__dsh_images/models') return { ok: true, json: async () => ({ ok: true, baseURL: 'http://127.0.0.1:3425/v1', keySource: 'stored', models: [{ id: 'gpt-image-1.5', isImage: true }, { id: 'gpt-4o', isImage: false }] }) };
      return { ok: true, json: async () => ({ ok: true, ...info, stats: { ...info.stats, totals: { USD: 0.9 } } }) };
    }
    if (path.startsWith('/__dsh_images/settings?model=')) return { ok: true, json: async () => ({ model: 'gpt-image-1', source: 'list', family: 'gpt-image-1', perImage: { amount: 0.167, currency: 'USD' }, samples: [{ size: '1024x1024', price: { amount: 0.167, currency: 'USD' } }, { size: '1536x1024', price: { amount: 0.25, currency: 'USD' } }], priceListDate: '2026-11-09' }) };
    if (path === '/__dsh_images/settings') return { ok: true, json: async () => info };
    if (path.startsWith('/__dsh_images/state')) return { ok: true, json: async () => ({ total: 0, totals: {} }) };
    return { ok: true, json: async () => ({ items: [], hasMore: false, total: 0 }) };
  };
  hooks.reset();
  panel({});
  await flush();
  hooks.rewind();
  let tree = panel({});
  findAll(tree, (n) => n.props['data-dsh-images-settings-button'])[0].props.onClick();
  hooks.rewind();
  tree = panel({});
  await flush();
  await flush();
  hooks.rewind();
  tree = panel({});
  let drawer = findAll(tree, (n) => n.props['data-dsh-images-drawer'])[0];
  assert.ok(drawer, 'the drawer is open');
  // The price preview is asked a moment after the model settles.
  await new Promise((resolve) => setTimeout(resolve, 320));
  hooks.rewind();
  tree = panel({});
  drawer = findAll(tree, (n) => n.props['data-dsh-images-drawer'])[0];
  let text = collect(drawer).join(' ');
  assert.match(text, /Image generation/);
  assert.match(text, /3 images so far/);
  assert.match(text, /Built-in list for gpt-image-1: 1024×1024 \$0\.167 · 1536×1024 \$0\.25/);
  const keyInput = findAll(drawer, (n) => n.props['data-dsh-images-field'] === 'apiKey')[0];
  assert.equal(keyInput.props.type, 'password');
  assert.match(keyInput.props.placeholder, /Using the provider's key ····test/);

  // Test the connection: the models come back and are offered as chips.
  findAll(drawer, (n) => n.props['data-dsh-images-probe'])[0].props.onClick();
  await flush();
  hooks.rewind();
  tree = panel({});
  drawer = findAll(tree, (n) => n.props['data-dsh-images-drawer'])[0];
  text = collect(drawer).join(' ');
  assert.match(text, /Connected: 2 models, 1 of them image models/);
  assert.equal(posts[0].path, '/__dsh_images/models');

  // Type a key and a model, save: the key goes in the POST once, nothing shows it back.
  findAll(drawer, (n) => n.props['data-dsh-images-field'] === 'apiKey')[0].props.onChange({ target: { value: 'sk-new-key-0000' } });
  findAll(drawer, (n) => n.props['data-dsh-images-field'] === 'model')[0].props.onChange({ target: { value: 'gpt-image-1.5' } });
  hooks.rewind();
  tree = panel({});
  drawer = findAll(tree, (n) => n.props['data-dsh-images-drawer'])[0];
  findAll(drawer, (n) => n.props['data-dsh-images-save'])[0].props.onClick();
  await flush();
  const saved = posts.find((p) => p.path === '/__dsh_images/settings');
  assert.equal(saved.body.apiKey, 'sk-new-key-0000');
  assert.equal(saved.body.model, 'gpt-image-1.5');
  hooks.rewind();
  tree = panel({});
  assert.equal(findAll(tree, (n) => n.props['data-dsh-images-drawer']).length, 0, 'the drawer closed');
  const after = collect(tree).join(' ');
  assert.match(after, /Settings saved/);
  assert.doesNotMatch(after, /sk-new-key/);
  hooks.runCleanups();
});

test('the model picker filters loosely, carries the gateway prefix to catalog models, and picks with the keyboard', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  const info = {
    values: { provider: '', baseURL: '', model: 'sub2api/gpt-image-1.5', size: '1024x1024', quality: '', pricePerImage: 0, currency: 'USD' },
    defaults: { provider: '', baseURL: '', model: '', size: '1024x1024', quality: '' },
    effective: { provider: 'magpie', baseURL: 'http://127.0.0.1:3425/v1', model: 'sub2api/gpt-image-1.5', keySource: 'provider', keyHint: '····test' },
    problem: '',
    storedKey: null,
    providers: [],
    sessionProvider: 'magpie',
    priceListDate: '2026-11-09',
    catalog: { name: 'LiteLLM', enabled: true, count: 3, fetchedAt: Date.UTC(2026, 10, 9), loading: false, error: '' },
    stats: { total: 1, totals: {}, byModel: { 'sub2api/gpt-image-1.5': { count: 1, totals: {} } } },
  };
  const catalog = { status: info.catalog, names: ['gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.6-sunburst', 'grok-imagine-image'] };
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (init?.method === 'POST' && path === '/__dsh_images/models') return { ok: true, json: async () => ({ ok: true, models: [{ id: 'sub2api/gpt-5.4', isImage: false }, { id: 'sub2api/gpt-6', isImage: false }] }) };
    if (path === '/__dsh_images/catalog') return { ok: true, json: async () => catalog };
    if (path.startsWith('/__dsh_images/settings?model=')) {
      return { ok: true, json: async () => ({ model: 'x', source: 'catalog', family: '', catalog: { name: 'gpt-image-2.6-sunburst', provider: 'openai', approximate: false, tokens: { textIn: 5, imageOut: 30 }, fetchedAt: 0 } }) };
    }
    if (path === '/__dsh_images/settings') return { ok: true, json: async () => info };
    if (path.startsWith('/__dsh_images/state')) return { ok: true, json: async () => ({ total: 0, totals: {} }) };
    return { ok: true, json: async () => ({ items: [], hasMore: false, total: 0 }) };
  };
  const render = () => {
    hooks.rewind();
    return findAll(panel({}), (n) => n.props['data-dsh-images-drawer'])[0];
  };
  const input = (drawer) => findAll(drawer, (n) => n.props['data-dsh-images-field'] === 'model')[0];
  const options = (drawer) => findAll(drawer, (n) => n.props['data-dsh-images-model-option']).map((n) => n.props['data-dsh-images-model-option']);
  const key = (drawer, k) => {
    const e = { key: k, preventDefault() {}, stopPropagation() {} };
    input(drawer).props.onKeyDown(e);
  };

  hooks.reset();
  panel({});
  await flush();
  hooks.rewind();
  findAll(panel({}), (n) => n.props['data-dsh-images-settings-button'])[0].props.onClick();
  render();
  await flush();
  await flush();
  let drawer = render();
  assert.equal(input(drawer).props.role, 'combobox');
  assert.equal(input(drawer).props['aria-expanded'], false);
  assert.match(collect(drawer).join(' '), /LiteLLM price list: 3 image models, as of 2026-11-09/);

  // Opening shows everything, even with a value in the field; catalog names take the field's prefix.
  input(drawer).props.onFocus();
  drawer = render();
  assert.equal(input(drawer).props['aria-expanded'], true);
  assert.deepEqual(options(drawer), ['sub2api/gpt-image-1.5', 'sub2api/gpt-image-2', 'sub2api/gpt-image-2.6-sunburst', 'sub2api/grok-imagine-image']);
  assert.match(collect(drawer).join(' '), /In the LiteLLM price list · sub2api\//);

  // Test the connection: the provider's models join the list.
  findAll(drawer, (n) => n.props['data-dsh-images-probe'])[0].props.onClick();
  await flush();
  drawer = render();
  assert.equal(options(drawer).length, 6);

  // Loose typing: letters may be skipped, terms may be split.
  input(drawer).props.onChange({ target: { value: 'img26' } });
  drawer = render();
  assert.deepEqual(options(drawer), ['sub2api/gpt-image-2.6-sunburst']);
  input(drawer).props.onChange({ target: { value: '2 sun' } });
  drawer = render();
  assert.deepEqual(options(drawer), ['sub2api/gpt-image-2.6-sunburst']);
  input(drawer).props.onChange({ target: { value: 'gpt' } });
  drawer = render();
  assert.equal(options(drawer)[0], 'sub2api/gpt-image-1.5', 'what was used before comes first');
  assert.ok(options(drawer).includes('sub2api/gpt-6'));
  input(drawer).props.onChange({ target: { value: 'zzz' } });
  drawer = render();
  assert.deepEqual(options(drawer), []);
  assert.match(collect(drawer).join(' '), /Nothing matches; the id as typed is used/);

  // A typed prefix replaces the field's for catalog names.
  input(drawer).props.onChange({ target: { value: 'openai/grok' } });
  drawer = render();
  assert.deepEqual(options(drawer), ['openai/grok-imagine-image']);

  // Arrow keys and Enter pick; Escape closes the list.
  input(drawer).props.onChange({ target: { value: 'gpt image 2' } });
  drawer = render();
  assert.deepEqual(options(drawer).slice(0, 3), ['sub2api/gpt-image-1.5', 'sub2api/gpt-image-2', 'sub2api/gpt-image-2.6-sunburst']);
  key(drawer, 'ArrowDown');
  drawer = render();
  key(drawer, 'ArrowDown');
  drawer = render();
  key(drawer, 'Enter');
  drawer = render();
  assert.equal(input(drawer).props.value, 'sub2api/gpt-image-2.6-sunburst');
  assert.equal(input(drawer).props['aria-expanded'], false);
  input(drawer).props.onFocus();
  drawer = render();
  assert.equal(input(drawer).props['aria-expanded'], true);
  key(drawer, 'Escape');
  drawer = render();
  assert.equal(input(drawer).props['aria-expanded'], false);

  // How the picked model is billed.
  await new Promise((resolve) => setTimeout(resolve, 320));
  drawer = render();
  assert.match(collect(drawer).join(' '), /The LiteLLM price list has gpt-image-2\.6-sunburst: text in \$5, image out \$30 per million tokens/);
  hooks.runCleanups();
});
