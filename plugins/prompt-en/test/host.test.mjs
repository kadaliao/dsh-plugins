import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { apply } from '../index.js';
import { keyOf } from '../lib/prompt.mjs';

const ZH = '帮我把这个函数改成异步的，顺便加上超时';
const ZH_EN = "Make this function async, and add a timeout while you're at it.";
const EN = 'Make this function async and add timeout';
const FIX = 'VERDICT: fix\nTEXT: Make this function async and add a timeout\nNOTE: article: "add timeout" → "add a timeout"';
const PICK = "PHRASE: 顺便 => while you're at it";

const unloads = [];
afterEach(() => {
  for (const unload of unloads.splice(0)) unload();
});

/** A user message as the Session feed carries it. */
const userMessage = (seq, text, id = `m${seq}`) => ({
  type: 'user/message',
  surfaceOp: 'append',
  seq,
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});

/**
 * The Harness beneath the plugin: Sessions, a model that translates, reviews and
 * picks by what it is asked, the command registry and the web server's routes.
 */
function harness({ home, config = {}, events = {}, pick = PICK } = {}) {
  process.env.DSH_HOME = home ?? mkdtempSync(join(tmpdir(), 'prompt-en-home-'));
  const calls = { translate: 0, review: 0, pick: 0 };
  const routes = new Map();
  const commands = new Map();
  const disposers = [];
  let feed = null;
  const session = (id) => ({
    id,
    header: { origin: 'user' },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    eventAt: (seq) => events[`${id}:${seq}`],
    snapshotEvents: () => [],
  });
  const services = {
    llm: {
      stream(request) {
        const kind = request.system.includes('worth learning') ? 'pick' : request.system.includes('coach') ? 'review' : 'translate';
        calls[kind] += 1;
        const text = kind === 'pick' ? pick : kind === 'review' ? FIX : ZH_EN;
        return (async function* () {
          yield { type: 'text-delta', text };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    sessions: { get: (id) => (id === 'gone' ? undefined : session(id)) },
    sessionQuery: {
      readEvent: async ({ sessionId, seq }) => {
        const target = events[`${sessionId}:${seq}`];
        if (!target) throw new Error('no such event');
        return { target };
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    commands: {
      register(desc) {
        commands.set(desc.name, desc);
        return () => commands.delete(desc.name);
      },
    },
  };
  const ctx = {
    get: (name) => services[name],
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    on(name, handler) {
      if (name === 'session/event') feed = handler;
      return () => {};
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  apply(ctx, config);
  const unload = () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
  unloads.push(unload);

  /** One request to a route, its JSON body (or status) back. */
  function request(path, { method = 'GET', body, type = 'application/json' } = {}) {
    const [route, query] = path.split('?');
    const handler = routes.get(route);
    assert.ok(handler, `no route ${route}`);
    return new Promise((resolve) => {
      const listeners = {};
      const req = {
        url: `${route}${query ? `?${query}` : ''}`,
        method,
        headers: body !== undefined ? { 'content-type': type } : {},
        on(event, fn) {
          listeners[event] = fn;
        },
      };
      const res = {
        statusCode: 200,
        setHeader() {},
        end(text) {
          resolve(text ? JSON.parse(text) : { status: res.statusCode });
        },
      };
      handler(req, res);
      if (method === 'POST') {
        if (body !== undefined) listeners.data?.(Buffer.from(JSON.stringify(body)));
        listeners.end?.();
      }
    });
  }

  const submit = (sessionId, event) => {
    events[`${sessionId}:${event.seq}`] = event;
    feed(session(sessionId), event);
  };
  const run = (line) => commands.get('vocab').handler({ rawInput: line });
  return { calls, request, submit, run, unload, commands };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

test('a Chinese prompt gets its English, and the phrase it teaches goes into the book', async () => {
  const h = harness();
  h.submit('s1', userMessage(3, ZH));
  await settle();
  assert.deepEqual(h.calls, { translate: 1, review: 0, pick: 1 });

  const state = await h.request('/__dsh_prompt_en/state?session=s1');
  assert.equal(state.items[0].text, ZH_EN);

  const sitting = await h.request('/__dsh_prompt_en/vocab');
  assert.equal(sitting.deckSize, 1);
  assert.deepEqual(
    sitting.cards.map((c) => [c.kind, c.cue, c.answer]),
    [['phrase', '顺便', "while you're at it"]],
  );
  assert.match(h.run(' list').text, /顺便 → while you're at it/);
  assert.match(h.run('').text, /1 张待复习/);
});

test('a corrected English prompt is filed with no extra call, and grading moves it on', async () => {
  const h = harness();
  h.submit('s1', userMessage(1, EN));
  await settle();
  assert.deepEqual(h.calls, { translate: 0, review: 1, pick: 0 });

  const [card] = (await h.request('/__dsh_prompt_en/vocab')).cards;
  assert.deepEqual([card.cue, card.answer, card.why], ['add timeout', 'add a timeout', 'article']);

  const graded = await h.request('/__dsh_prompt_en/vocab/grade', { method: 'POST', body: { id: card.id, grade: 'good' } });
  assert.equal(graded.ok, true);
  assert.equal(graded.card.box, 1);
  assert.equal((await h.request('/__dsh_prompt_en/vocab')).cards.length, 0);
  assert.equal((await h.request('/__dsh_prompt_en/vocab?ahead=1')).cards.length, 1);
  assert.match(h.run('').text, /今天没有到期的/);

  // The same mistake again sends it back to the start.
  h.submit('s1', userMessage(5, `${EN} please`));
  await settle();
  const list = await h.request('/__dsh_prompt_en/vocab/list');
  assert.equal(list.deckSize, 1);
  assert.equal(list.cards[0].seen, 2);
  assert.equal(list.cards[0].box, 0);

  const dropped = await h.request('/__dsh_prompt_en/vocab/drop', { method: 'POST', body: { id: card.id } });
  assert.equal(dropped.ok, true);
  assert.match(h.run('list').text, /生词本还是空的/);
});

test('the routes that change the book take only a JSON POST', async () => {
  const h = harness();
  assert.deepEqual(await h.request('/__dsh_prompt_en/vocab/drop', { method: 'POST', body: { id: 'x' }, type: 'text/plain' }), {
    status: 415,
  });
  assert.deepEqual(await h.request('/__dsh_prompt_en/vocab/import', { method: 'GET' }), { status: 405 });
  const bad = await h.request('/__dsh_prompt_en/vocab/grade', { method: 'POST', body: { id: 'x', grade: 'easy' } });
  assert.equal(bad.ok, false);
});

test('collectVocab off keeps the book closed and costs no extra call', async () => {
  const h = harness({ config: { collectVocab: false } });
  h.submit('s1', userMessage(1, ZH));
  h.submit('s1', userMessage(2, EN));
  await settle();
  assert.deepEqual(h.calls, { translate: 1, review: 1, pick: 0 });
  assert.equal((await h.request('/__dsh_prompt_en/vocab')).deckSize, 0);
});

test('/vocab import files what the cache kept from before the book, once', async () => {
  // A cache written before the book: a translation in a closed session, a review in a live one.
  const home = mkdtempSync(join(tmpdir(), 'prompt-en-home-'));
  const dir = join(home, 'cache', 'prompt-en');
  mkdirSync(dir, { recursive: true });
  const items = {
    'gone:4': { seq: 4, key: keyOf(ZH), status: 'done', kind: 'translate', text: ZH_EN },
    's2:1': {
      seq: 1,
      key: keyOf(EN),
      status: 'done',
      kind: 'review',
      verdict: 'fix',
      base: EN,
      text: 'Make this function async and add a timeout',
      note: 'article: "add timeout" → "add a timeout"',
    },
  };
  writeFileSync(join(dir, 'cache.json'), JSON.stringify({ order: Object.keys(items), items }));
  const h = harness({ home, events: { 'gone:4': userMessage(4, ZH) } });

  assert.match(h.run('import').text, /开始导入/);
  assert.match(h.run('import').text, /正在导入/);
  await settle();
  assert.deepEqual(h.calls, { translate: 0, review: 0, pick: 1 });

  const notices = await h.request('/__dsh_prompt_en/vocab/notice?after=0');
  const texts = notices.notices.map((n) => n.text);
  assert.ok(texts.some((t) => /看了 2 条以前的 prompt，新收 2 张（纠错 1 · 短语 1 · 句型 0）/.test(t)), texts.join('\n'));
  assert.ok(texts.some((t) => t === '生词本有 2 条该复习了 · /vocab'), texts.join('\n'));
  assert.equal(notices.importing, null);
  // The reminder is not repeated at the next poll.
  const later = await h.request(`/__dsh_prompt_en/vocab/notice?after=${notices.latest}`);
  assert.deepEqual(later.notices, []);

  // Again: nothing new and no call.
  const started = await h.request('/__dsh_prompt_en/vocab/import', { method: 'POST', body: {} });
  assert.equal(started.started, true);
  await settle();
  assert.equal(h.calls.pick, 1);
  const last = await h.request(`/__dsh_prompt_en/vocab/notice?after=${notices.latest}`);
  assert.deepEqual(
    last.notices.map((n) => n.text),
    ['生词本：没有新的可以导入了。'],
  );
});

test('the book outlives a restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prompt-en-home-'));
  const first = harness({ home });
  first.submit('s1', userMessage(1, EN));
  await settle();
  first.unload();
  const second = harness({ home });
  assert.equal((await second.request('/__dsh_prompt_en/vocab')).deckSize, 1);
});
