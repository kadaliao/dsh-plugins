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

function block(impl) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.ok(start >= 0 && end > start, `${source} has no update block`);
  let body = text.slice(start, end);
  if (impl !== undefined) body = body.replace('const UPDATES_IMPL = 1;', `const UPDATES_IMPL = ${impl};`);
  return new Function(`${body}\nreturn kadaliaoUpdates;`)();
}

const kadaliaoUpdates = block();

/** Renders function components on the spot; hooks keep no state, which is all these tests need. */
const React = {
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
    if (typeof type === 'function') return type({ ...(props ?? {}), ...(kids.length ? { children: kids } : {}) });
    return { type, props: props ?? {}, children: kids };
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
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

const NOW = Date.parse('2026-11-24T12:00:00Z');
const clock = { at: NOW };
const HOUR = 3600e3;
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

/** One plugin's client half: its context, the slot it registers, and how to switch it off. */
function plugin(name, remote, { impl, access = true, withRemote = true, resolve } = {}) {
  const seen = { slots: [], access: [], disposers: [] };
  const factory = impl === undefined ? kadaliaoUpdates : block(impl);
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
        slots: {
          inject: (_name, register) => register(),
          register(definition, Component) {
            const slot = { definition, Component };
            seen.slots.push(slot);
            return () => {
              seen.slots.splice(seen.slots.indexOf(slot), 1);
            };
          },
        },
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
  const api = factory(ctx, { React, name, now: () => clock.at });
  return {
    api,
    seen,
    render() {
      const slot = seen.slots[0];
      return slot === undefined ? null : slot.Component({});
    },
    dispose() {
      if (typeof scopeDispose === 'function') scopeDispose();
      scopeDispose = null;
      for (const dispose of seen.disposers.splice(0)) dispose();
    },
  };
}

const navigation = { opened: [], openBundle(name) { this.opened.push(name); } };
const live = [];
const settle = () => new Promise((resolve) => setImmediate(resolve));

function start(...args) {
  const p = plugin(...args);
  live.push(p);
  return p;
}

beforeEach(() => {
  clock.at = NOW;
  globalThis.window = { localStorage: storage(), document: { documentElement: { lang: 'zh-CN' }, hidden: false }, navigator: { language: 'zh-CN' } };
  navigation.opened = [];
});

afterEach(() => {
  for (const p of live.splice(0)) p.dispose();
  delete globalThis.window;
});

const twoPlugins = () => [
  bundle('@kadaliao/dsh-bots', '0.17.2'),
  bundle('@kadaliao/dsh-images', '0.5.6'),
  bundle('@kadaliao/dsh-archify', '0.4.0', { update: undefined, source: 'link:/somewhere' }),
  bundle('@kadaliao/dsh-atlas', '0.1.4', { enabled: false }),
  bundle('@liaoxingyi/dsh-yushi', '1.0.0'),
];

const newer = {
  '@kadaliao/dsh-bots': { status: 'listed', installed: '0.17.2', registry: 'https://registry.npmjs.org/', attempts: [], omitted: 0, versions: [version('0.18.0'), version('0.17.3')] },
  '@kadaliao/dsh-images': { status: 'listed', installed: '0.5.6', registry: null, attempts: [], omitted: 0, versions: [version('0.5.7')] },
  '@kadaliao/dsh-atlas': { status: 'listed', installed: '0.1.4', registry: null, attempts: [], omitted: 0, versions: [version('0.2.0')] },
  '@liaoxingyi/dsh-yushi': { status: 'listed', installed: '1.0.0', registry: null, attempts: [], omitted: 0, versions: [version('2.0.0')] },
};

test('one card for every installed kadaliao plugin, drawn by one copy', async () => {
  const remote = fakeRemote({ bundles: twoPlugins, versions: newer, update: () => ({ ok: true, value: {} }) });
  const bots = start('@kadaliao/dsh-bots', remote);
  const images = start('@kadaliao/dsh-images', remote);
  assert.deepEqual(bots.seen.access, ['pluginManager/updateBundle']);
  await bots.api.check(remote);
  const offers = bots.api.state().offers;
  assert.deepEqual(offers.map((o) => [o.name, o.installed, o.version]), [
    ['@kadaliao/dsh-bots', '0.17.2', '0.18.0'],
    ['@kadaliao/dsh-images', '0.5.6', '0.5.7'],
  ]);
  // Only registry copies that are switched on, and only kadaliao's, are asked about.
  assert.deepEqual(remote.calls.filter((c) => c[0] === 'listVersions').map((c) => c[1]), ['@kadaliao/dsh-bots', '@kadaliao/dsh-images']);
  assert.equal(images.render(), null, 'the second copy stands by');
  const card = bots.render();
  assert.ok(card, 'the first copy draws');
  assert.match(textOf(card), /2 个插件有新版本/);
  assert.match(textOf(card), /0\.17\.2 → 0\.18\.0/);
  assert.match(textOf(card), /bots中/);
  assert.equal(find(card, (n) => n.props?.['data-kadaliao-updates-row']).length, 2);
  assert.equal(find(card, (n) => n.props?.['data-kadaliao-updates-action'] === 'primary' && textOf(n) === '全部更新').length, 1);
  // The title opens the plugin's own page in Plugins.
  find(card, (n) => n.type === 'button' && textOf(n) === 'bots中')[0].props.onClick();
  assert.deepEqual(navigation.opened, ['@kadaliao/dsh-bots']);
});

test('the offer is the newest installable version that has been public for half an hour', () => {
  const remote = fakeRemote({ bundles: [], versions: {}, update: () => ({}) });
  const { api } = start('@kadaliao/dsh-bots', remote);
  const list = (versions) => ({ status: 'listed', installed: '1.0.0', registry: null, attempts: [], omitted: 0, versions });
  const fresh = version('1.5.0', { publishedAt: ago(5 * 60e3) });
  const chosen = api.choose(list([
    fresh,
    version('1.4.0', { prerelease: true }),
    version('1.3.0', { deprecated: 'broken' }),
    version('1.2.0', { incompatible: { version: '1.2.0' } }),
    version('1.1.5', { bundle: false }),
    version('1.1.0'),
  ]), NOW);
  assert.equal(chosen.offer.version, '1.1.0');
  assert.equal(chosen.recheckAt, Date.parse(fresh.publishedAt) + 30 * 60e3);
  assert.equal(api.choose({ status: 'refused', problem: 'network', reason: 'x', attempts: [] }, NOW).offer, undefined);
});

test('Update hands the version to Harness with the registry that listed it and follows its steps', async () => {
  let resolve;
  const installed = { '@kadaliao/dsh-images': '0.5.6' };
  const remote = fakeRemote({
    bundles: () => [bundle('@kadaliao/dsh-images', installed['@kadaliao/dsh-images'])],
    versions: newer,
    update: () => new Promise((r) => { resolve = r; }),
  });
  const p = start('@kadaliao/dsh-bots', remote);
  await p.api.check(remote);
  const running = p.api.update(remote, '@kadaliao/dsh-images');
  await settle();
  const [, name, to, options] = remote.calls.find((c) => c[0] === 'updateBundle');
  assert.equal(name, '@kadaliao/dsh-images');
  assert.equal(to, '0.5.7');
  assert.equal(options.registry, null);
  assert.match(options.requestId, /^[0-9a-f-]{36}$/);
  remote.fire('plugin-manager/update-state', { requestId: options.requestId, step: 'installing' });
  assert.match(textOf(p.render()), /正在安装 0\.5\.7/);
  // No buttons while it runs: nothing to start twice, nothing to close.
  assert.equal(find(p.render(), (n) => n.type === 'button' && n.props['data-kadaliao-updates-action']).length, 0);
  installed['@kadaliao/dsh-images'] = '0.5.7';
  resolve({ ok: true, value: { from: '0.5.6', to: '0.5.7', step: 'install', result: { changed: true, application: 'applied' } } });
  await running;
  assert.equal(p.api.state().phases['@kadaliao/dsh-images'].step, 'done');
  assert.match(textOf(p.render()), /插件已更新/);
  assert.match(textOf(p.render()), /已更新到 0\.5\.7/);
  assert.deepEqual(p.api.readStore().offers, [], 'a reload does not offer it again');
  p.api.close();
  assert.equal(p.render(), null);
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
  const p = start('@kadaliao/dsh-bots', remote);
  await p.api.check(remote);
  await p.api.update(remote, '@kadaliao/dsh-images');
  const card = p.render();
  assert.match(textOf(card), /没有更新，已装回 0\.5\.6：ERR_PNPM_FETCH_404 tarball/);
  assert.equal(find(card, (n) => n.props?.['data-kadaliao-updates-action'] === 'primary' && textOf(n) === '更新').length, 1);
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
  await p.api.check(remote);
  await p.api.update(remote, '@kadaliao/dsh-bots');
  assert.equal(p.api.state().phases['@kadaliao/dsh-bots'].step, 'done');
});

test('a plugin that updates itself hands the card to the copy that comes next', async () => {
  let resolve;
  const installed = { '@kadaliao/dsh-bots': '0.17.2' };
  const remote = fakeRemote({
    bundles: () => [bundle('@kadaliao/dsh-bots', installed['@kadaliao/dsh-bots'])],
    versions: newer,
    update: () => new Promise((r) => { resolve = r; }),
  });
  const old = start('@kadaliao/dsh-bots', remote);
  await old.api.check(remote);
  const running = old.api.update(remote, '@kadaliao/dsh-bots');
  await settle();
  // Harness removes the running version: its client half leaves, mid-update.
  old.dispose();
  assert.equal(remote.listeners('plugin-manager/changed'), 0, 'the old copy stopped listening');
  installed['@kadaliao/dsh-bots'] = '0.18.0';
  const next = start('@kadaliao/dsh-bots', remote, { impl: 2 });
  assert.match(textOf(next.render()), /正在检查 0\.18\.0/, 'the new copy picks up the update in progress');
  resolve({ ok: true, value: { from: '0.17.2', to: '0.18.0', step: 'install', result: { application: 'applied' } } });
  await running;
  assert.match(textOf(next.render()), /已更新到 0\.18\.0/);
});

test('the newest copy leads, and the next one takes over when it leaves', () => {
  const remote = fakeRemote({ bundles: [], versions: {}, update: () => ({}) });
  const a = start('@kadaliao/dsh-images', remote);
  const b = start('@kadaliao/dsh-bots', remote, { impl: 2 });
  const c = start('@kadaliao/dsh-atlas', remote);
  assert.equal(a.api.leader().name, '@kadaliao/dsh-bots');
  assert.equal(a.api.hub.members.length, 3);
  b.dispose();
  assert.equal(a.api.leader().name, '@kadaliao/dsh-images', 'the first loaded among equals');
  a.dispose();
  assert.equal(c.api.leader().name, '@kadaliao/dsh-atlas');
});

test('Later hides the card for a day, Skip until a newer version', async () => {
  const lists = { ...newer };
  const remote = fakeRemote({ bundles: [bundle('@kadaliao/dsh-bots', '0.17.2')], versions: (name) => lists[name], update: () => ({}) });
  const p = start('@kadaliao/dsh-bots', remote);
  await p.api.check(remote);
  assert.ok(p.render());
  find(p.render(), (n) => n.props?.['data-kadaliao-updates-action'] === 'later')[0].props.onClick();
  assert.equal(p.render(), null);
  assert.equal(p.api.readStore().snoozedUntil, NOW + 24 * HOUR);
  window.localStorage.data.clear();
  await p.api.check(remote);
  find(p.render(), (n) => n.props?.['data-kadaliao-updates-action'] === 'skip')[0].props.onClick();
  assert.equal(p.render(), null);
  await p.api.check(remote);
  assert.equal(p.render(), null, 'a skipped version stays away');
  lists['@kadaliao/dsh-bots'] = { ...newer['@kadaliao/dsh-bots'], versions: [version('0.18.1'), version('0.18.0')] };
  await p.api.check(remote);
  assert.match(textOf(p.render()), /bots中 有新版本 0\.18\.1/);
});

test('a registry that does not answer keeps what the last check found', async () => {
  let down = false;
  const remote = fakeRemote({
    bundles: [bundle('@kadaliao/dsh-bots', '0.17.2')],
    versions: (name) => (down ? new Error('ETIMEDOUT') : newer[name]),
    update: () => ({}),
  });
  const p = start('@kadaliao/dsh-bots', remote);
  await p.api.check(remote);
  down = true;
  await p.api.check(remote);
  assert.deepEqual(p.api.readStore().offers.map((o) => o.version), ['0.18.0']);
});

test('an unreadable plugin list backs off instead of retrying at once', async () => {
  const remote = fakeRemote({ bundles: new Error('no profile'), versions: {}, update: () => ({}) });
  const p = start('@kadaliao/dsh-bots', remote);
  await p.api.check(remote);
  assert.equal(p.api.readStore().failedAt, NOW);
  assert.equal(p.api.readStore().checkedAt, 0);
});

test('offers another surface already applied leave the card', async () => {
  const installed = { '@kadaliao/dsh-bots': '0.17.2' };
  const remote = fakeRemote({ bundles: () => [bundle('@kadaliao/dsh-bots', installed['@kadaliao/dsh-bots'])], versions: newer, update: () => ({}) });
  const p = start('@kadaliao/dsh-bots', remote);
  await p.api.check(remote);
  assert.ok(p.render());
  installed['@kadaliao/dsh-bots'] = '0.18.0';
  remote.fire('plugin-manager/changed', { reason: 'install' });
  await settle();
  assert.equal(p.render(), null);
  assert.deepEqual(p.api.readStore().offers, []);
});

test('a Peer that may not update plugins gets no card, and no Remote means nothing at all', () => {
  const remote = fakeRemote({ bundles: [], versions: {}, update: () => ({}) });
  const guest = start('@kadaliao/dsh-bots', remote, { access: false });
  assert.deepEqual(guest.seen.access, ['pluginManager/updateBundle']);
  assert.equal(guest.seen.slots.length, 0);
  const bare = start('@kadaliao/dsh-images', remote, { withRemote: false });
  assert.equal(bare.seen.slots.length, 0);
  assert.equal(bare.api.hub.members.length, 0);
});

test('the words follow the language Harness shows, not the browser', async () => {
  const remote = fakeRemote({ bundles: [bundle('@kadaliao/dsh-bots', '0.17.2')], versions: newer, update: () => ({}) });
  const p = start('@kadaliao/dsh-bots', remote, { resolve: (text) => text.en });
  await p.api.check(remote);
  assert.match(textOf(p.render()), /bots 0\.18\.0 is available/);
  assert.match(textOf(p.render()), /Skip this version/);
});

test('the first check waits for the page to settle, then every six hours', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const remote = fakeRemote({ bundles: [bundle('@kadaliao/dsh-bots', '0.17.2')], versions: newer, update: () => ({}) });
  start('@kadaliao/dsh-bots', remote);
  await settle();
  const checks = () => remote.calls.filter((c) => c[0] === 'listVersions').length;
  assert.equal(checks(), 0);
  const pass = async (ms) => {
    clock.at += ms;
    t.mock.timers.tick(ms);
    for (let i = 0; i < 5; i += 1) await settle();
  };
  await pass(19e3);
  assert.equal(checks(), 0);
  await pass(1e3);
  assert.equal(checks(), 1);
  await pass(3 * HOUR);
  assert.equal(checks(), 1, 'not again within six hours');
  await pass(3 * HOUR);
  assert.equal(checks(), 2);
});
