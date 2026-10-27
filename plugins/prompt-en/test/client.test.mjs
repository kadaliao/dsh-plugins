import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const allHooks = [];
afterEach(() => {
  for (const hooks of allHooks.splice(0)) hooks.runCleanups();
});
const source = readFileSync(join(root, 'client.js'), 'utf8');

/** A hook-capable stand-in for React that renders plain element trees. */
function fakeReact() {
  let slots = [];
  let cursor = 0;
  const hooks = {
    useCleanups() {},
    reset() {
      slots = [];
      cursor = 0;
    },
    /** Render again with the state kept (a re-render). */
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
    if (typeof type === 'function') {
      const kids = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
      return type({ ...(props ?? {}), ...(kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {}) });
    }
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    };
  };
  const react = { createElement, useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect, memo: (fn) => fn };
  allHooks.push(hooks);
  return { React: react, hooks };
}

/** Load the client module with a module loader stand-in. */
async function loadClient() {
  const { React, hooks } = fakeReact();
  let factory;
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory: make }) {
        assert.equal(id, '@kadaliao/dsh-prompt-en');
        factory = make;
      },
    },
  };
  const module = new Function('source', `${source}\n//# sourceURL=client.js`)(source);
  void module;
  assert.equal(typeof factory, 'function', 'client.js did not register a factory');
  const exports = factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require ${name}`);
  });
  return { exports, hooks };
}

function fakeContext({ services = {} } = {}) {
  const seen = { definitions: [], slots: [], locale: null, tabs: [], decorations: [], opened: [] };
  const sidebarRight = {
    openTab(kind) {
      seen.opened.push(kind);
    },
  };
  const all = { sidebarRight, ...services };
  const ctx = {
    get: (name) => all[name],
    inject(names, callback) {
      const scope = {
        slots: ctx.slots,
        effect: (fn) => fn(),
        sidebarRightTabs: {
          register(definition) {
            seen.tabs.push(definition);
            return () => {};
          },
        },
        commandUi: {
          decorate(decoration) {
            seen.decorations.push(decoration);
            return () => {};
          },
        },
      };
      seen.injected = [...(seen.injected ?? []), ...names];
      callback(scope);
      return { dispose() {} };
    },
    effect(fn) {
      return fn();
    },
    locale: {
      register(ns, dict) {
        seen.locale = { ns, dict };
        return () => {};
      },
    },
    uiConversation: {
      events: {
        register(definition) {
          seen.definitions.push(definition);
          return () => {};
        },
      },
    },
    slots: {
      inject(_key, callback) {
        return callback();
      },
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

test('the client registers a prompt-en definition and row renderer', async () => {
  const { exports } = await loadClient();
  assert.deepEqual(exports.inject, ['uiConversation', 'slots', 'locale']);
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  assert.equal(seen.definitions.length, 1);
  assert.equal(seen.definitions[0].kind, 'prompt-en');
  const row = seen.slots.find((s) => s.options.name === 'conversation.chat.node');
  assert.equal(row.options.key, 'prompt-en');
  assert.equal(seen.locale.ns, 'prompt-en');
  assert.equal(seen.locale.dict.en.label, 'EN');
  assert.equal(seen.locale.dict.zh['vocab.title'], '生词本');
  // Every key in one dictionary is in the other.
  assert.deepEqual(Object.keys(seen.locale.dict.zh).sort(), Object.keys(seen.locale.dict.en).sort());
});

test('the definition matches only a human append message and anchors just after it', async () => {
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const definition = seen.definitions[0];

  assert.deepEqual(
    definition.match({ type: 'assistant/message', seq: 10, data: {} }),
    null,
  );
  assert.deepEqual(
    definition.match({ type: 'user/message', surfaceOp: 'append', seq: 9, data: { id: 'm1', source: { kind: 'user' } } }),
    { id: 'm1', role: 'start' },
  );
  assert.equal(
    definition.match({ type: 'user/message', surfaceOp: { op: 'replace' }, data: { id: 'm1', source: { kind: 'user' } } }),
    null,
  );
  assert.equal(
    definition.match({ type: 'user/message', surfaceOp: 'append', data: { id: 'm1', source: { kind: 'plugin' } } }),
    null,
  );

  const match = { event: { type: 'user/message', seq: 9, time: 123, data: { id: 'm1' } }, location: { kind: 'step' } };
  const state = definition.start({}, match);
  const node = definition.buildViewNode({ key: 'prompt-en:m1', id: 'm1', state, start: match });
  assert.equal(node.kind, 'prompt-en');
  assert.equal(node.anchorSeq, 9.1);
  assert.equal(node.groupTree, 'input');
  assert.equal(node.data.messageId, 'm1');
});

test('the row draws the translation it reads from the host route', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const row = seen.slots.find((s) => s.options.name === 'conversation.chat.node').component;

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => ({
        enabled: true,
        items: [{ messageId: 'm1', seq: 9, status: 'done', kind: 'translate', text: 'Build me a plugin.' }],
      }),
    };
  };

  hooks.reset();
  let tree = row({
    node: { data: { messageId: 'm1', seq: 9 } },
    sessionId: 's1',
    t: (key) => ({ label: 'EN', translating: 'translating…' }[key] ?? key),
  });
  assert.equal(tree, null, 'an empty cache renders nothing');

  await new Promise((resolve) => setTimeout(resolve, 0));
  hooks.reset();
  tree = row({
    node: { data: { messageId: 'm1', seq: 9 } },
    sessionId: 's1',
    t: (key) => ({ label: 'EN', translating: 'translating…' }[key] ?? key),
  });
  const text = collect(tree).join(' ');
  assert.match(text, /EN/);
  assert.match(text, /Build me a plugin\./);
  assert.match(calls[0], /\/__dsh_prompt_en\/state\?session=s1/);
  hooks.runCleanups();
});

test('a review with a fix draws the marked words, the note and the verdict glyph', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const row = seen.slots.find((s) => s.options.name === 'conversation.chat.node').component;

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      enabled: true,
      items: [
        {
          messageId: 'm1',
          seq: 9,
          status: 'done',
          kind: 'review',
          verdict: 'fix',
          text: 'add a timeout',
          note: 'article',
          runs: [
            { text: 'add ', isNew: false },
            { text: 'a ', isNew: true },
            { text: 'timeout', isNew: false },
          ],
        },
      ],
    }),
  });

  hooks.reset();
  row({ node: { data: { messageId: 'm1', seq: 9 } }, sessionId: 's1', t: (key) => (key === 'label' ? 'EN' : key) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  hooks.reset();
  const tree = row({ node: { data: { messageId: 'm1', seq: 9 } }, sessionId: 's1', t: (key) => (key === 'label' ? 'EN' : key) });
  const text = collect(tree).join(' ');
  assert.match(text, /EN/);
  assert.match(text, /✎/);
  assert.match(text, /add\s+a\s+timeout/);
  assert.match(text, /article/);
  hooks.runCleanups();
});

// --- the vocabulary book ----------------------------------------------------------

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

const button = (tree, label) => {
  const found = findAll(tree, (n) => n.type === 'button' && collect(n).join('').includes(label));
  assert.ok(found.length > 0, `no button "${label}" in: ${collect(tree).join(' ')}`);
  return found[0];
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The vocabulary pane over a host that serves `cards`, recording what it is sent. */
async function mountPane(cards, { deckSize = cards.length } = {}) {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const pane = seen.slots.find((s) => s.options.name === 'sidebar.right.pane.tab').component;
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(init.body), type: init.headers['content-type'] });
    return {
      ok: true,
      json: async () => (path.startsWith('/__dsh_prompt_en/vocab?') || path === '/__dsh_prompt_en/vocab'
        ? { deckSize, cards, importing: null, collect: true, now: 1 }
        : { ok: true }),
    };
  };
  const props = { useTabInfo: () => ({ tab: { visible: true } }) };
  hooks.reset();
  pane(props);
  await flush();
  const render = () => {
    hooks.rewind();
    return pane(props);
  };
  return { render, posts, hooks };
}

const fixCard = {
  id: 'c1',
  kind: 'fix',
  cue: 'add timeout',
  answer: 'add a timeout',
  why: 'article',
  context: 'Make this function async and add timeout',
  addedAt: 1,
  seen: 1,
  box: 0,
  due: 1,
  lapses: 0,
};

test('the vocabulary tab, its guide entry, the reminder toast and a bare /vocab are registered', async () => {
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);

  assert.deepEqual(seen.injected, ['sidebarRightTabs', 'commandUi']);
  const [tab] = seen.tabs;
  assert.equal(tab.kind, 'prompt-en-vocab');
  assert.equal(tab.title(), 'Vocabulary');
  assert.equal(tab.guide[0].title(), 'Vocabulary');
  const body = seen.slots.find((s) => s.options.name === 'sidebar.right.pane.tab');
  assert.equal(body.options.key, tab.id);
  assert.equal(body.options.locale, 'prompt-en');
  const overlay = seen.slots.find((s) => s.options.name === 'shell.overlay');
  assert.equal(overlay.options.id, 'prompt-en.vocab-notice');

  const [decoration] = seen.decorations;
  assert.equal(decoration.name, 'vocab');
  assert.equal(decoration.available(), true);
  assert.equal(decoration.ui.kind, 'action');
  decoration.ui.run({ sessionId: 's1' });
  assert.deepEqual(seen.opened, ['prompt-en-vocab']);
});

test('without a right Sidebar, a bare /vocab is left to the host', async () => {
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext({ services: { sidebarRight: undefined } });
  exports.apply(ctx);
  assert.equal(seen.decorations[0].available(), false);
});

test('a card shows your words first, the answer when asked, and a grade moves on', async () => {
  const { render, posts, hooks } = await mountPane([fixCard]);
  let tree = render();
  let text = collect(tree).join(' ');
  assert.match(text, /Vocabulary/);
  assert.match(text, /1 \/ 1 · 1 in the book/);
  assert.match(text, /add timeout/);
  assert.doesNotMatch(text, /add a timeout/);

  button(tree, 'Show answer').props.onClick();
  tree = render();
  text = collect(tree).join(' ');
  assert.match(text, /add a timeout/);
  assert.match(text, /article/);

  button(tree, 'Knew it').props.onClick();
  await flush();
  assert.deepEqual(posts, [
    { path: '/__dsh_prompt_en/vocab/grade', body: { id: 'c1', grade: 'good' }, type: 'application/json' },
  ]);
  tree = render();
  assert.match(collect(tree).join(' '), /Sitting done: knew 1 · unsure 0 · forgot 0\./);
  hooks.runCleanups();
});

test('a forgotten card comes round again in the same sitting', async () => {
  const { render, hooks } = await mountPane([fixCard]);
  button(render(), 'Show answer').props.onClick();
  button(render(), 'Forgot').props.onClick();
  const text = collect(render()).join(' ');
  assert.match(text, /2 \/ 2/);
  assert.match(text, /add timeout/);
  hooks.runCleanups();
});

test('the keyboard shows the answer and grades', async () => {
  const { render, posts, hooks } = await mountPane([fixCard]);
  const key = (k) => {
    const root = render();
    root.props.onKeyDown({ key: k, target: { tagName: 'DIV' }, preventDefault() {} });
  };
  key('f');
  assert.match(collect(render()).join(' '), /add a timeout/);
  key('2');
  await flush();
  assert.equal(posts[0].body.grade, 'hard');
  // Keys typed into a field are not the pane's.
  const root = render();
  root.props.onKeyDown({ key: 'm', target: { tagName: 'INPUT' }, preventDefault() {} });
  hooks.runCleanups();
});

test('a phrase card marks its words in the sentence; a pattern card shows its frame', async () => {
  const phrase = {
    ...fixCard,
    id: 'p1',
    kind: 'phrase',
    cue: '制定完善的开发计划',
    answer: 'draw up a solid development plan',
    why: undefined,
    context: '你要先调研、然后制定完善的开发计划，然后跟我沟通确认之后再动手',
    example: 'Then draw up a solid development plan.',
  };
  const pattern = {
    ...fixCard,
    id: 'q1',
    kind: 'pattern',
    cue: '先别急着提交，等测试跑完再说',
    answer: 'Hold off on committing until the tests finish.',
    pattern: 'Hold off on ___ until ___',
    why: undefined,
    context: undefined,
  };
  const { render, hooks } = await mountPane([phrase, pattern]);
  let tree = render();
  const bold = findAll(tree, (n) => n.type === 'span' && n.props.style?.fontWeight === 600).map((n) => collect(n).join(''));
  assert.ok(bold.includes('制定完善的开发计划'), bold.join(' | '));
  assert.match(collect(tree).join(' '), /Yours/);

  button(tree, 'Show answer').props.onClick();
  tree = render();
  const green = findAll(tree, (n) => n.type === 'span' && n.props.style?.fontWeight === 600 && /success/.test(n.props.style?.color ?? ''));
  assert.equal(green.filter((n) => collect(n).join('') === 'draw up a solid development plan').length, 2);

  button(tree, 'Knew it').props.onClick();
  tree = render();
  assert.doesNotMatch(collect(tree).join(' '), /Hold off on ___/);
  button(tree, 'Show answer').props.onClick();
  tree = render();
  assert.match(collect(tree).join(' '), /Pattern/);
  assert.match(collect(tree).join(' '), /Hold off on ___ until ___/);
  hooks.runCleanups();
});

test('an empty book says how it fills, and offers the import', async () => {
  const { render, posts, hooks } = await mountPane([], { deckSize: 0 });
  const tree = render();
  assert.match(collect(tree).join(' '), /The vocabulary book is empty/);
  button(tree, 'Import earlier prompts').props.onClick();
  await flush();
  assert.equal(posts[0].path, '/__dsh_prompt_en/vocab/import');
  hooks.runCleanups();
});

test('a notice from the host is shown as a toast', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const overlay = seen.slots.find((s) => s.options.name === 'shell.overlay').component;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return { ok: true, json: async () => ({ notices: [{ id: 1, text: '生词本有 2 条该复习了 · /vocab' }], latest: 1, importing: null }) };
  };
  hooks.reset();
  assert.equal(overlay({}), null);
  t.mock.timers.tick(3000);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  hooks.rewind();
  const toast = overlay({});
  assert.match(collect(toast).join(''), /生词本有 2 条该复习了/);
  assert.match(asked[0], /\/__dsh_prompt_en\/vocab\/notice\?after=0/);
  hooks.runCleanups();
});
