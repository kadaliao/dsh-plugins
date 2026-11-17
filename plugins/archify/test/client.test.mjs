import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'client.js'), 'utf8');
const allHooks = [];
afterEach(() => {
  for (const hooks of allHooks.splice(0)) hooks.runCleanups();
});

/** A hook-capable stand-in for React that renders plain element trees. */
function fakeReact() {
  let slots = [];
  let cursor = 0;
  const hooks = {
    reset() {
      slots = [];
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
      return [slots[index], (value) => (slots[index] = typeof value === 'function' ? value(slots[index]) : value)];
    },
    cleanups: [],
    useEffect(effect) {
      cursor++;
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
  allHooks.push(hooks);
  return { React: { createElement, useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect }, hooks };
}

function loadClient() {
  const { React, hooks } = fakeReact();
  let factory;
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory: make }) {
        assert.equal(id, '@kadaliao/dsh-archify');
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

function fakeContext() {
  const seen = { slots: [], locale: null, decorations: [], selected: [], definitions: [] };
  const all = { layout: { selectPanel: (id) => seen.selected.push(id) } };
  const ctx = {
    get: (name) => all[name],
    inject(names, callback) {
      seen.injected = [...(seen.injected ?? []), ...names];
      callback({ effect: (fn) => fn(), commandUi: { decorate: (d) => (seen.decorations.push(d), () => {}) } });
    },
    effect: (fn) => fn(),
    uiConversation: { events: { register: (d) => (seen.definitions.push(d), () => {}) } },
    locale: { register: (ns, dict) => ((seen.locale = { ns, dict }), () => {}) },
    slots: { inject: (_k, cb) => cb(), register: (options, component) => (seen.slots.push({ options, component }), () => {}) },
  };
  return { ctx, seen };
}

function text(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) text(child, out);
    return out;
  }
  for (const child of node.children ?? []) text(child, out);
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

const okMeta = {
  archify: true,
  ok: true,
  type: 'sequence',
  title: 'Checkout',
  status: 'pass',
  gates: { validate: 'pass', deliver: 'pass', check: 'pass', 'browser-check': 'pass' },
  output: '/w/.archify/sequence-checkout-20261117-183000/checkout.html',
  ms: 2600,
  id: 'abc123',
  version: 'v1',
  aspect: 0.5,
};

test('the client registers both tool views, the page row, the panel and /archify', () => {
  const { exports } = loadClient();
  assert.deepEqual(exports.inject, ['slots', 'locale', 'uiConversation']);
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  assert.deepEqual(
    seen.slots.map((s) => [s.options.name, s.options.key ?? s.options.id]),
    [
      ['tool.call.toolview', 'archify_render'],
      ['tool.call.toolview', 'archify_cli'],
      ['conversation.chat.node', 'archify-page'],
      ['sidebar.panellist', 'archify'],
      ['main', 'archify'],
    ],
  );
  assert.equal(seen.locale.ns, 'archify');
  assert.deepEqual(Object.keys(seen.locale.dict.zh).sort(), Object.keys(seen.locale.dict.en).sort());
  const [decoration] = seen.decorations;
  assert.equal(decoration.name, 'archify');
  decoration.ui.run({});
  assert.deepEqual(seen.selected, ['archify']);
  assert.equal(seen.slots[3].component({ size: 20 }).props.width, 20);
});

test('a delivered page becomes a turn-level row; failures and other tools do not', () => {
  const { exports } = loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const [def] = seen.definitions;
  assert.equal(def.kind, 'archify-page');
  assert.equal(def.match({ type: 'tool/call', data: { name: 'archify_render', callId: 'c1' } }), null);
  const result = (meta, callId = 'c1') => ({ type: 'tool/result', surfaceOp: 'append', seq: 7, data: { message: { source: { callId } }, meta } });
  const m = def.match(result(okMeta));
  assert.deepEqual(m, { id: 'c1', role: 'start' });
  const state = def.start({}, { event: result(okMeta) });
  const node = def.buildViewNode({ state, key: 'k', id: 'c1', start: { location: 'x' } });
  assert.equal(node.groupTree, 'turn');
  assert.equal(node.anchorSeq, 7.2);
  const failed = def.start({}, { event: result({ ...okMeta, ok: false, id: undefined }) });
  assert.equal(def.buildViewNode({ state: failed, key: 'k', id: 'c1', start: {} }), null);
  assert.equal(def.match(result({ prompt: 'x', ids: [] }, 'other')), null);

  const row = seen.slots.find((s) => s.options.name === 'conversation.chat.node').component;
  const tree = row({ node: { data: state } });
  assert.equal(findAll(tree, (n) => n.props?.['data-dsh-archify-card'] === 'abc123').length, 1);
  assert.match(text(tree).join(' '), /Checkout/);
});

test('the render tool card shows progress, the gates, and a failure\'s diagnostics', () => {
  const { exports, hooks } = loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const view = seen.slots.find((s) => s.options.key === 'archify_render').component;

  hooks.reset();
  let tree = view({ phase: 'start', block: { callId: 'c1', argsRaw: '{"type":"sequence","name":"checkout","spec":{"meta":{"title":"Chec' } });
  let words = text(tree).join(' ');
  assert.match(words, /Archify/);
  assert.match(words, /Sequence/);
  assert.match(words, /rendering and checking/);

  hooks.reset();
  tree = view({ phase: 'result', block: { callId: 'c1', argsRaw: '{"type":"sequence"}', meta: okMeta, content: [] } });
  words = text(tree).join(' ');
  assert.match(words, /delivered · 2\.6s/);
  assert.match(words, /✓ validate/);

  hooks.reset();
  const failed = { ...okMeta, ok: false, id: undefined, failedStage: 'validate', gates: { validate: 'fail' }, diagnostics: [{ code: 'layout/constraint', severity: 'error', message: 'too close' }], diagnosticTotal: 3 };
  tree = view({ phase: 'result', block: { callId: 'c1', argsRaw: '{"type":"sequence","candidate":"x/candidate.json"}', meta: failed, content: [] } });
  words = text(tree).join(' ');
  assert.match(words, /stopped at validate/);
  assert.match(words, /3 diagnostics/);
  assert.match(words, /repairs the candidate/);

  hooks.reset();
  tree = view({ phase: 'result', block: { callId: 'c1', isError: true, argsRaw: '{"type":"pie"}', content: [{ type: 'text', text: 'type must be one of' }] } });
  assert.match(text(tree).join(' '), /type must be one of/);
});

test('the CLI card shows the command and its exit code', () => {
  const { exports, hooks } = loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const view = seen.slots.find((s) => s.options.key === 'archify_cli').component;
  hooks.reset();
  const tree = view({ phase: 'result', block: { argsRaw: '{"args":["guide","checkout","--json"]}', content: [{ type: 'text', text: 'exit 0\n{}' }] } });
  const words = text(tree).join(' ');
  assert.match(words, /archify guide checkout --json/);
  assert.match(words, /exit 0/);
});
