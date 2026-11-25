// Tests for the update reminders every @kadaliao/dsh-* plugin shares. The canonical copy of this file is
// shared/updates.test.mjs in kadaliao/dsh-plugins; `node scripts/sync-updates.mjs` copies it into each plugin
// as test/updates.test.mjs, where it reads the block out of that plugin's client.js.
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = [join(here, '..', 'client.js'), join(here, 'updates.js')].find((path) => existsSync(path));
const text = readFileSync(source, 'utf8');
const BEGIN = '// >>> kadaliao-dsh-updates';
const END = '// <<< kadaliao-dsh-updates';

function block() {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.ok(start >= 0 && end > start, `${source} has no update block`);
  return new Function(`${text.slice(start, end)}\nreturn kadaliaoUpdates;`)();
}

const kadaliaoUpdates = block();

/** Renders function components on the spot; state never changes and effects wait in `effects` until a test runs them. */
const effects = [];
const React = {
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
    if (typeof type === 'function') return type({ ...(props ?? {}), ...(kids.length ? { children: kids } : {}) });
    return { type, props: props ?? {}, children: kids };
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (fn) => {
    effects.push(fn);
  },
};

function find(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) find(child, predicate, out);
  return out;
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node !== 'object') return String(node);
  return (node.children ?? []).map(textOf).join('');
}

function storage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const NOW = Date.parse('2026-11-25T12:00:00Z');
const clock = { at: NOW };
const HOUR = 3600e3;
const MINUTE = 60e3;
const ago = (ms) => new Date(NOW - ms).toISOString();

function bundle(name, version, extra = {}) {
  return { name, version, installed: true, enabled: true, update: 'registry', meta: { title: { en: name.slice(14), zh: `${name.slice(14)}中` } }, ...extra };
}

function version(v, extra = {}) {
  return { version: v, publishedAt: ago(2 * HOUR), tags: [], prerelease: false, bundle: true, ...extra };
}

function fakeRemote({ bundles, versions, update }) {
  const handlers = new Map();
  const calls = [];
  return {
    calls,
    $on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event).delete(fn);
    },
    fire(event, payload) {
      for (const fn of handlers.get(event) ?? []) fn(payload);
    },
    listeners: (event) => handlers.get(event)?.size ?? 0,
    asked: () => calls.filter((c) => c[0] === 'listVersions').map((c) => c[1]),
    pluginManager: {
      async listBundles() {
        calls.push(['listBundles']);
        const value = typeof bundles === 'function' ? bundles() : bundles;
        return value instanceof Error ? { ok: false, error: { message: value.message } } : { ok: true, value };
      },
      async listVersions(name, options) {
        calls.push(['listVersions', name, options]);
        const value = typeof versions === 'function' ? versions(name) : versions[name];
        if (value instanceof Error) return { ok: false, error: { message: value.message } };
        return { ok: true, value: value ?? { status: 'refused', problem: 'not-found', reason: 'none', attempts: [] } };
      },
      async updateBundle(name, to, options) {
        calls.push(['updateBundle', name, to, options]);
        return update(name, to, options);
      },
    },
  };
}

/** One plugin's client half: its context, its own view wrapped by `opens`, and how to switch it off. */
function plugin(name, remote, { access = true, withRemote = true, resolve } = {}) {
  const seen = { access: [], disposers: [], reopened: 0 };
  let scopeDispose = null;
  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') seen.disposers.push(dispose);
    },
    locale: resolve === undefined ? { register: () => () => {} } : { register: () => () => {}, resolveText: resolve },
    get: (key) => (key === 'pluginNavigation' ? navigation : undefined),
    inject(names, callback) {
      seen.injected = names;
      const scope = {
        remote: withRemote ? remote : undefined,
        remoteAccess: {
          whenAccess(action, fn) {
            seen.access.push(action);
            return access ? fn() : undefined;
          },
        },
      };
      scopeDispose = callback(scope);
    },
  };
  const api = kadaliaoUpdates(ctx, { React, name, now: () => clock.at, reopen: () => { seen.reopened += 1; } });
  const View = (props) => ({ type: 'plugin-view', props, children: [] });
  const Framed = api.opens(View);
  const closers = [];
  return {
    api,
    seen,
    frame: () => Framed({ hello: 1 }),
    bar() {
      return find(Framed({}), (n) => n.props?.['data-kadaliao-update'] !== undefined)[0] ?? null;
    },
    /** What mounting the view does: the frame's own effect. */
    open() {
      effects.length = 0;
      Framed({});
      const close = effects[0]();
      effects.length = 0;
      closers.push(close);
      return close;
    },
    dispose() {
      for (const close of closers.splice(0)) close();
      if (typeof scopeDispose === 'function') scopeDispose();
      scopeDispose = null;
      for (const dispose of seen.disposers.splice(0)) dispose();
    },
  };
}

const navigation = { opened: [], openBundle(name) { this.opened.push(name); } };
const live = [];
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const action = (node, kind) => find(node, (n) => n.props?.['data-kadaliao-update-action'] === kind)[0];

function start(...args) {
  const p = plugin(...args);
  live.push(p);
  return p;
}

beforeEach(() => {
  clock.at = NOW;
  effects.length = 0;
  globalThis.window = { localStorage: storage(), document: { documentElement: { lang: 'zh-CN' }, hidden: false }, navigator: { language: 'zh-CN' } };
  navigation.opened = [];
});

afterEach(() => {
  for (const p of live.splice(0)) p.dispose();
  delete globalThis.window;
});

const installedSet = () => [
  bundle('@kadaliao/dsh-bots', '0.17.2'),
  bundle('@kadaliao/dsh-images', '0.5.6'),
  bundle('@liaoxingyi/dsh-yushi', '1.0.0'),
];

const newer = {
  '@kadaliao/dsh-bots': { status: 'listed', installed: '0.17.2', registry: 'https://registry.npmjs.org/', attempts: [], omitted: 0, versions: [version('0.18.0'), version('0.17.3')] },
  '@kadaliao/dsh-images': { status: 'listed', installed: '0.5.6', registry: null, attempts: [], omitted: 0, versions: [version('0.5.7')] },
};

test('nothing is asked until the view opens, and then only about this plugin', async () => {
  const remote = fakeRemote({ bundles: installedSet, versions: newer, update: () => ({ ok: true, value: {} }) });
  const bots = start('@kadaliao/dsh-bots', remote);
  start('@kadaliao/dsh-images', remote);
  assert.deepEqual(bots.seen.access, ['pluginManager/updateBundle']);
  await settle();
  assert.deepEqual(remote.calls, [], 'loading a plugin asks nothing');
  assert.equal(bots.bar(), null);
  bots.open();
  await settle();
  assert.deepEqual(remote.asked(), ['@kadaliao/dsh-bots'], 'Images is not asked about from the Bots view');
  const bar = bots.bar();
  assert.match(textOf(bar), /bots中 有新版本 0\.18\.0/);
  assert.match(textOf(bar), /0\.17\.2 → 0\.18\.0 · 2026-11-25 发布/);
  assert.equal(textOf(action(bar, 'update')), '更新');
  // The bar sits above the plugin's own view, which keeps its props.
  const frame = bots.frame();
  assert.equal(frame.props['data-kadaliao-update-frame'], '@kadaliao/dsh-bots');
  assert.equal(frame.children.length, 2);
  assert.deepEqual(find(frame, (n) => n.type === 'plugin-view')[0].props, { hello: 1 });
  // The name opens the plugin's own page in Plugins.
  find(bar, (n) => n.type === 'button' && /有新版本/.test(textOf(n)))[0].props.onClick();
  assert.deepEqual(navigation.opened, ['@kadaliao/dsh-bots']);
});

test('the frame keeps its shape with or without the bar, so the view is not remounted', async () => {
  const remote = fakeRemote({ bundles: installedSet, versions: newer, update: () => ({}) });
  const p = start('@kadaliao/dsh-bots', remote);
  const before = p.frame();
  p.open();
  await settle();
  const after = p.frame();
  assert.equal(before.children.length, 1, 'no bar yet: only the body');
  assert.equal(after.children.length, 2);
  assert.deepEqual(before.children.at(-1).props.style, after.children.at(-1).props.style);
});

test('opening again within a minute reuses the answer; after that it asks again', async () => {
  const remote = fakeRemote({ bundles: installedSet, versions: newer, update: () => ({}) });
  const p = start('@kadaliao/dsh-bots', remote);
  const close = p.open();
  await settle();
  close();
  clock.at += 30e3;
  p.open();
  await settle();
  assert.equal(remote.asked().length, 1);
  clock.at += 31e3;
  p.open();
  await settle();
  assert.equal(remote.asked().length, 2);
});

test('no timers: hours pass without a single question', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const remote = fakeRemote({ bundles: installedSet, versions: newer, update: () => ({}) });
  start('@kadaliao/dsh-bots', remote);
  clock.at += 7 * HOUR;
  t.mock.timers.tick(7 * HOUR);
  await settle();
  assert.deepEqual(remote.calls, []);
});

test('the offer is the newest installable version that has been public for ten minutes', () => {
  const remote = fakeRemote({ bundles: [], versions: {}, update: () => ({}) });
  const { api } = start('@kadaliao/dsh-bots', remote);
  const list = (versions) => ({ status: 'listed', installed: '1.0.0', registry: null, attempts: [], omitted: 0, versions });
  const chosen = api.choose(list([
    version('1.5.0', { publishedAt: ago(5 * MINUTE) }),
    version('1.4.0', { prerelease: true }),
    version('1.3.0', { deprecated: 'broken' }),
    version('1.2.0', { incompatible: { version: '1.2.0' } }),
    version('1.1.5', { bundle: false }),
    version('1.1.0', { publishedAt: ago(11 * MINUTE) }),
  ]), NOW);
  assert.equal(chosen.version, '1.1.0');
  assert.equal(api.choose(list([version('1.0.1', { publishedAt: undefined })]), NOW).version, '1.0.1', 'no date: offered');
  assert.equal(api.choose({ status: 'refused', problem: 'network', reason: 'x', attempts: [] }, NOW), undefined);
});

test('a folder, Git or switched-off install is not asked about', async () => {
  for (const extra of [{ update: undefined, source: 'link:/somewhere' }, { update: 'git' }, { enabled: false }]) {
    const remote = fakeRemote({ bundles: [bundle('@kadaliao/dsh-bots', '0.17.2', extra)], versions: newer, update: () => ({}) });
    const p = start('@kadaliao/dsh-bots', remote);
    p.open();
    await settle();
    assert.deepEqual(remote.asked(), [], JSON.stringify(extra));
    assert.equal(p.bar(), null);
    p.dispose();
  }
});

test('Update hands the version to Harness with the registry that listed it and follows its steps', async () => {
  let resolve;
  const installed = { '@kadaliao/dsh-images': '0.5.6' };
  const remote = fakeRemote({
    bundles: () => [bundle('@kadaliao/dsh-images', installed['@kadaliao/dsh-images'])],
    versions: newer,
    update: () => new Promise((r) => { resolve = r; }),
  });
  const p = start('@kadaliao/dsh-images', remote);
  p.open();
  await settle();
  const running = p.api.update();
  await settle();
  const [, name, to, options] = remote.calls.find((c) => c[0] === 'updateBundle');
  assert.equal(name, '@kadaliao/dsh-images');
  assert.equal(to, '0.5.7');
  assert.equal(options.registry, null);
  assert.match(options.requestId, /^[0-9a-f-]{36}$/);
  remote.fire('plugin-manager/update-state', { requestId: options.requestId, step: 'installing' });
  assert.match(textOf(p.bar()), /正在安装 0\.5\.7…/);
  assert.match(textOf(p.bar()), /更新时images中会先关闭，装好后自动重新打开/);
  remote.fire('plugin-manager/update-state', { requestId: 'someone-else', step: 'restoring' });
  assert.match(textOf(p.bar()), /正在安装/, 'another update’s steps are not ours');
  // No buttons while it runs: nothing to start twice, nothing to close.
  assert.equal(find(p.bar(), (n) => n.props['data-kadaliao-update-action']).length, 0);
  installed['@kadaliao/dsh-images'] = '0.5.7';
  resolve({ ok: true, value: { from: '0.5.6', to: '0.5.7', step: 'install', result: { changed: true, application: 'applied' } } });
  await running;
  assert.equal(p.api.handoff.phases['@kadaliao/dsh-images'].step, 'done');
  assert.match(textOf(p.bar()), /images中 已更新到 0\.5\.7/);
  action(p.bar(), 'close').props.onClick();
  assert.equal(p.bar(), null);
});

test('how an update ended reads off its answer', () => {
  const remote = fakeRemote({ bundles: [], versions: {}, update: () => ({}) });
  const { api } = start('@kadaliao/dsh-bots', remote);
  const ok = (value) => ({ ok: true, value });
  assert.deepEqual(api.outcomeOf(ok({ result: { application: 'applied' } }), '1.0.0'), { step: 'done', restart: false });
  assert.deepEqual(api.outcomeOf(ok({ result: { application: 'restart-required' } }), '1.0.0'), { step: 'done', restart: true });
  assert.deepEqual(api.outcomeOf(ok({ step: 'check', result: { application: 'failed', error: { code: 'operation-error', diagnostic: 'not on the registry' } } }), '1.0.0'),
    { step: 'failed', reason: 'not on the registry', kept: true });
  assert.deepEqual(api.outcomeOf(ok({ step: 'install', result: { application: 'failed', error: { diagnostic: 'ERR_PNPM_FETCH_404' } }, restore: { application: 'applied' } }), '1.0.0'),
    { step: 'failed', reason: 'ERR_PNPM_FETCH_404', restored: true, from: '1.0.0' });
  assert.deepEqual(api.outcomeOf(ok({ step: 'install', result: { application: 'cancelled' }, restore: { application: 'failed' } }), '1.0.0'),
    { step: 'failed', reason: 'cancelled', removed: true, from: '1.0.0' });
  assert.deepEqual(api.outcomeOf({ ok: false, message: 'socket closed' }, '1.0.0'), { step: 'unknown', reason: 'socket closed' });
});

test('a failed update says the old version is back and can be tried again', async () => {
  const remote = fakeRemote({
    bundles: [bundle('@kadaliao/dsh-images', '0.5.6')],
    versions: newer,
    update: () => ({ ok: true, value: { from: '0.5.6', to: '0.5.7', step: 'install', result: { application: 'failed', error: { diagnostic: 'ERR_PNPM_FETCH_404 tarball' } }, restore: { application: 'applied' } } }),
  });
  const p = start('@kadaliao/dsh-images', remote);
  p.open();
  await settle();
  await p.api.update();
  const bar = p.bar();
  assert.match(textOf(bar), /没有更新，已装回 0\.5\.6：ERR_PNPM_FETCH_404 tarball/);
  assert.equal(textOf(action(bar, 'update')), '再试一次');
  await p.api.update();
  assert.equal(remote.calls.filter((c) => c[0] === 'updateBundle').length, 2);
});

test('a failed install names the line of pnpm output that says why', () => {
  const remote = fakeRemote({ bundles: [], versions: {}, update: () => ({}) });
  const { api } = start('@kadaliao/dsh-bots', remote);
  const log = 'Progress: resolved 1, reused 0\nPackages: +1\n+\n[ERR_PNPM_FETCH_404] GET http://r/x.tgz: Not Found - 404\n\nNo authorization header was set for the request.';
  assert.equal(api.headline(log), '[ERR_PNPM_FETCH_404] GET http://r/x.tgz: Not Found - 404');
  assert.equal(api.headline('first\nlast line\n'), 'last line');
  assert.equal(api.headline('x'.repeat(300)).length, 158);
});

test('an answer lost with the page is settled by what is installed', async () => {
  const installed = { '@kadaliao/dsh-bots': '0.17.2' };
  const remote = fakeRemote({
    bundles: () => [bundle('@kadaliao/dsh-bots', installed['@kadaliao/dsh-bots'])],
    versions: newer,
    update: async () => {
      installed['@kadaliao/dsh-bots'] = '0.18.0';
      throw new Error('connection reset');
    },
  });
  const p = start('@kadaliao/dsh-bots', remote);
  p.open();
  await settle();
  await p.api.update();
  assert.equal(p.api.handoff.phases['@kadaliao/dsh-bots'].step, 'done');
});

test('a plugin that updates itself: the copy that comes next shows how it went', async () => {
  let resolve;
  const installed = { '@kadaliao/dsh-bots': '0.17.2' };
  const remote = fakeRemote({
    bundles: () => [bundle('@kadaliao/dsh-bots', installed['@kadaliao/dsh-bots'])],
    versions: newer,
    update: () => new Promise((r) => { resolve = r; }),
  });
  const old = start('@kadaliao/dsh-bots', remote);
  old.open();
  await settle();
  const running = old.api.update();
  await settle();
  const { requestId } = remote.calls.find((c) => c[0] === 'updateBundle')[3];
  // Harness removes the running version: its client half leaves, mid-update.
  old.dispose();
  assert.equal(remote.listeners('plugin-manager/changed'), 0, 'the old copy stopped listening');
  assert.equal(remote.listeners('plugin-manager/update-state'), 0);
  const next = start('@kadaliao/dsh-bots', remote);
  assert.equal(next.seen.reopened, 0, 'not while apply(ctx) may still be registering the view');
  await settle();
  assert.equal(next.seen.reopened, 1, 'Harness closed the view with the old copy: the new one opens it again');
  assert.equal(next.api.handoff.phases['@kadaliao/dsh-bots'].reopen, false, 'once');
  next.open();
  await settle();
  assert.match(textOf(next.bar()), /正在检查 0\.18\.0/, 'the new copy picks up the update in progress');
  remote.fire('plugin-manager/update-state', { requestId, step: 'installing' });
  assert.match(textOf(next.bar()), /正在安装 0\.18\.0/);
  installed['@kadaliao/dsh-bots'] = '0.18.0';
  resolve({ ok: true, value: { from: '0.17.2', to: '0.18.0', step: 'install', result: { application: 'applied' } } });
  await running;
  assert.match(textOf(next.bar()), /bots中 已更新到 0\.18\.0/);
});

test('a lost answer arriving late does not undo what is installed', async () => {
  let reject;
  const installed = { '@kadaliao/dsh-bots': '0.17.2' };
  const remote = fakeRemote({
    bundles: () => [bundle('@kadaliao/dsh-bots', installed['@kadaliao/dsh-bots'])],
    versions: newer,
    update: () => new Promise((_, r) => { reject = r; }),
  });
  const old = start('@kadaliao/dsh-bots', remote);
  old.open();
  await settle();
  const running = old.api.update();
  await settle();
  old.dispose();
  installed['@kadaliao/dsh-bots'] = '0.18.0';
  const next = start('@kadaliao/dsh-bots', remote);
  await settle();
  assert.equal(next.api.handoff.phases['@kadaliao/dsh-bots'].step, 'done', 'what is installed says it worked');
  reject(new Error('socket closed'));
  await running;
  assert.equal(next.api.handoff.phases['@kadaliao/dsh-bots'].step, 'done');
});

test('Later hides the bar for a day, Skip until a newer version', async () => {
  const lists = { ...newer };
  const remote = fakeRemote({ bundles: [bundle('@kadaliao/dsh-bots', '0.17.2')], versions: (name) => lists[name], update: () => ({}) });
  const p = start('@kadaliao/dsh-bots', remote);
  p.open();
  await settle();
  action(p.bar(), 'later').props.onClick();
  assert.equal(p.bar(), null);
  assert.equal(p.api.readStore().snoozedUntil, NOW + 24 * HOUR);
  clock.at += 25 * HOUR;
  assert.ok(p.bar(), 'back the next day');
  action(p.bar(), 'skip').props.onClick();
  assert.equal(p.bar(), null);
  p.open();
  await settle();
  assert.equal(p.bar(), null, 'a skipped version stays away');
  lists['@kadaliao/dsh-bots'] = { ...newer['@kadaliao/dsh-bots'], versions: [version('0.18.1'), version('0.18.0')] };
  clock.at += 2 * MINUTE;
  p.open();
  await settle();
  assert.match(textOf(p.bar()), /bots中 有新版本 0\.18\.1/);
});

test('a registry that does not answer leaves the bar as it was and is asked again next time', async () => {
  let down = false;
  const remote = fakeRemote({
    bundles: [bundle('@kadaliao/dsh-bots', '0.17.2')],
    versions: (name) => (down ? new Error('ETIMEDOUT') : newer[name]),
    update: () => ({}),
  });
  const p = start('@kadaliao/dsh-bots', remote);
  p.open();
  await settle();
  down = true;
  clock.at += 2 * MINUTE;
  p.open();
  await settle();
  assert.match(textOf(p.bar()), /0\.18\.0/);
  p.open();
  await settle();
  assert.equal(remote.asked().length, 3, 'a failed answer is not reused');
});

test('an offer another surface already applied leaves the bar', async () => {
  const installed = { '@kadaliao/dsh-bots': '0.17.2' };
  const lists = { ...newer };
  const remote = fakeRemote({ bundles: () => [bundle('@kadaliao/dsh-bots', installed['@kadaliao/dsh-bots'])], versions: (name) => lists[name], update: () => ({}) });
  const p = start('@kadaliao/dsh-bots', remote);
  p.open();
  await settle();
  assert.ok(p.bar());
  installed['@kadaliao/dsh-bots'] = '0.18.0';
  lists['@kadaliao/dsh-bots'] = { status: 'listed', installed: '0.18.0', registry: null, attempts: [], omitted: 0, versions: [] };
  remote.fire('plugin-manager/changed', { reason: 'install' });
  await settle();
  assert.equal(p.bar(), null);
});

test('a Peer that may not update plugins is never asked, and no Remote means nothing at all', async () => {
  const remote = fakeRemote({ bundles: installedSet, versions: newer, update: () => ({}) });
  const guest = start('@kadaliao/dsh-bots', remote, { access: false });
  guest.open();
  const bare = start('@kadaliao/dsh-images', remote, { withRemote: false });
  bare.open();
  await settle();
  assert.deepEqual(guest.seen.access, ['pluginManager/updateBundle']);
  assert.deepEqual(remote.calls, []);
  assert.equal(guest.bar(), null);
  assert.equal(bare.bar(), null);
  assert.ok(bare.frame(), 'the view still renders');
});

test('the words follow the language Harness shows, not the browser', async () => {
  const remote = fakeRemote({ bundles: [bundle('@kadaliao/dsh-bots', '0.17.2')], versions: newer, update: () => ({}) });
  const p = start('@kadaliao/dsh-bots', remote, { resolve: (text) => text.en });
  p.open();
  await settle();
  assert.match(textOf(p.bar()), /bots 0\.18\.0 is available/);
  assert.match(textOf(p.bar()), /Skip this version/);
});

test('the old shared card of earlier versions is left alone', async () => {
  const remote = fakeRemote({ bundles: installedSet, versions: newer, update: () => ({}) });
  const p = start('@kadaliao/dsh-bots', remote);
  p.open();
  await settle();
  assert.equal(window.__kadaliaoDshUpdates, undefined);
  assert.equal(window.localStorage.getItem('kadaliao-dsh-updates'), null);
});
