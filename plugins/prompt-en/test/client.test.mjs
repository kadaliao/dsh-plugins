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
    if (typeof type === 'function') return type(props ?? {});
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

function fakeContext() {
  const seen = { definitions: [], slots: [], locale: null };
  const ctx = {
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
  assert.equal(seen.slots.length, 1);
  assert.equal(seen.slots[0].options.key, 'prompt-en');
  assert.equal(seen.locale.ns, 'prompt-en');
  assert.equal(seen.locale.dict.en.label, 'EN');
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
  const row = seen.slots[0].component;

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
  const row = seen.slots[0].component;

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
