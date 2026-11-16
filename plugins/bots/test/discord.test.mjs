import assert from 'node:assert/strict';
import test from 'node:test';
import { kind, TEXT_LIMIT, INTENTS, createConnector, splitMessage, normalizeMessage, backoffDelay } from '../lib/channels/discord.mjs';

const TOKEN = ['MTA5ODc2NTQzMjEwOTg3NjU0', 'Gx1AbC', 'sEcReT-token_value-do-not-leak'].join('.');
const BOT = '1098765432109876543';
const GATEWAY = 'wss://gateway.test/?v=10&encoding=json';
const RESUME = 'wss://resume.test/?v=10&encoding=json';
const HELLO = { op: 10, d: { heartbeat_interval: 40_000 } };
const READY = { op: 0, t: 'READY', s: 1, d: { v: 10, session_id: 'sess-1', resume_gateway_url: 'wss://resume.test', user: { id: BOT, username: 'helper', global_name: 'Helper Bot', bot: true }, guilds: [] } };

const flush = () => new Promise((r) => setImmediate(r));
const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: async () => (body == null ? '' : JSON.stringify(body)),
});

/** Timers that only move when the test says so. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms = 0) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async tick(ms = 0) {
      const end = now + ms;
      for (;;) {
        let id = null;
        let t = null;
        for (const [k, v] of timers) if (v.at <= end && (!t || v.at < t.at)) { id = k; t = v; }
        if (!t) break;
        timers.delete(id);
        now = t.at;
        t.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    get size() { return timers.size; },
    delays() { return [...timers.values()].map((v) => v.at - now); },
  };
}

function harness({ fetch, ...opts } = {}) {
  const clock = fakeClock();
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = {};
      this.closedWith = null;
      sockets.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    emit(type, ev) { for (const fn of this.listeners[type] ?? []) fn(ev); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code = 1000) {
      this.closedWith = code;
      this.emit('close', { code, reason: '' });
    }
    /** A frame from Discord. */
    push(frame) { this.emit('message', { data: JSON.stringify(frame) }); }
    /** Discord (or the network) closes the socket. */
    drop(code, reason = '') { this.emit('close', { code, reason }); }
  }
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    if (fetch) return fetch(url, init, calls.length);
    if (url.endsWith('/gateway/bot')) return reply(200, { url: 'wss://gateway.test', shards: 1, session_start_limit: { remaining: 999 } });
    if (url.endsWith('/typing')) return reply(204, null);
    return reply(200, { id: String(calls.length) });
  };
  const h = { clock, sockets, calls, statuses: [], messages: [], logs: [], errors: [] };
  h.c = createConnector({
    token: TOKEN,
    onMessage: (m) => h.messages.push(m),
    onStatus: (s) => h.statuses.push(s),
    fetchImpl,
    WebSocketImpl: FakeSocket,
    log: (line) => h.logs.push(line),
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    random: () => 0.5,
    ...opts,
  });
  h.last = () => sockets.at(-1);
  h.states = () => h.statuses.map((s) => s.state);
  return h;
}

/** Start, say Hello and READY on the first socket. */
async function online(h) {
  const started = h.c.start();
  await flush();
  const ws = h.last();
  ws.push(HELLO);
  ws.push(READY);
  return { me: await started, ws };
}

/** Nothing the connector reported or threw carries the token. */
function assertNoToken(h, ...extra) {
  const seen = JSON.stringify([h.statuses, h.logs, h.errors.map((e) => e?.message), ...extra]);
  assert.equal(seen.includes(TOKEN), false, 'token leaked into a status, log line or error');
}

test('the module implements the channel contract', () => {
  assert.equal(kind, 'discord');
  assert.equal(TEXT_LIMIT, 2000);
  assert.equal(INTENTS, (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15));
  const c = createConnector({ token: TOKEN, onMessage() {} });
  for (const fn of ['start', 'stop', 'send', 'typing']) assert.equal(typeof c[fn], 'function');
});

test('start identifies with the message intents and resolves with the bot on READY', async () => {
  const h = harness({ token: `Bot ${TOKEN}` }); // a pasted "Bot " prefix is fine
  const { me, ws } = await online(h);
  assert.deepEqual(me, { id: BOT, username: 'helper', name: 'Helper Bot' });
  assert.equal(h.calls[0].url, 'https://discord.com/api/v10/gateway/bot');
  assert.equal(h.calls[0].headers.Authorization, `Bot ${TOKEN}`);
  assert.match(h.calls[0].headers['User-Agent'], /^DiscordBot \(https:\/\/github\.com\/kadaliao\/dsh-plugins, [\d.]+\)$/);
  assert.equal(ws.url, GATEWAY);
  assert.deepEqual(ws.sent[0], { op: 2, d: { token: TOKEN, intents: 1 | 512 | 4096 | 32768, properties: { os: process.platform, browser: 'dsh-bots', device: 'dsh-bots' } } });
  assert.deepEqual(h.states(), ['connecting', 'connected']);
  assert.equal(h.c.start(), h.c.start(), 'start is shared while running');
  await h.c.stop();
  assert.equal(h.clock.size, 0);
  assertNoToken(h);
});

test('apiBase overrides the REST base', async () => {
  const h = harness({ apiBase: 'http://127.0.0.1:9999/api/v10/' });
  await h.c.send('c1', 'hi');
  assert.equal(h.calls[0].url, 'http://127.0.0.1:9999/api/v10/channels/c1/messages');
});

test('heartbeats: jittered first beat, answers op 1, resumes when an ACK is missed', async () => {
  const h = harness();
  const { ws } = await online(h);
  const beats = () => ws.sent.filter((f) => f.op === 1);
  await h.clock.tick(19_999); // interval 40 s × jitter 0.5
  assert.equal(beats().length, 0);
  await h.clock.tick(1);
  assert.deepEqual(beats(), [{ op: 1, d: 1 }]);
  ws.push({ op: 11 });
  ws.push({ op: 0, t: 'GUILD_CREATE', s: 2, d: { id: 'g1', name: 'Lab', channels: [] } });
  await h.clock.tick(40_000);
  assert.deepEqual(beats().at(-1), { op: 1, d: 2 }, 'beats carry the last sequence number');
  ws.push({ op: 11 });
  ws.push({ op: 1 }); // Discord asks for a beat right now
  assert.equal(beats().length, 3);
  await h.clock.tick(40_000); // beat, no ACK this time
  assert.equal(beats().length, 4);
  assert.equal(h.sockets.length, 1);
  await h.clock.tick(40_000); // next beat finds the last one unacknowledged
  assert.equal(beats().length, 4);
  assert.notEqual(ws.closedWith, 1000, 'a zombie connection is closed with a resumable code');
  assert.equal(ws.closedWith, 4000);
  const next = h.last();
  assert.notEqual(next, ws);
  assert.equal(next.url, RESUME);
  next.push(HELLO);
  assert.deepEqual(next.sent[0], { op: 6, d: { token: TOKEN, session_id: 'sess-1', seq: 2 } });
  next.push({ op: 0, t: 'RESUMED', s: 3, d: null });
  assert.equal(h.statuses.at(-1).state, 'connected');
  ws.push({ op: 0, t: 'MESSAGE_CREATE', s: 9, d: { id: 'late', channel_id: 'dm', author: { id: '1', username: 'x' }, content: 'stale socket' } });
  assert.equal(h.messages.length, 0, 'frames from a replaced socket are ignored');
  await h.c.stop();
  assertNoToken(h);
});

test('MESSAGE_CREATE is normalised; bots, itself and empty messages are dropped', async () => {
  const h = harness();
  const { ws } = await online(h);
  let s = 1;
  const event = (d) => ws.push({ op: 0, t: 'MESSAGE_CREATE', s: (s += 1), d });
  const ada = { id: '42', username: 'ada', global_name: 'Ada L' };
  ws.push({
    op: 0, t: 'GUILD_CREATE', s: (s += 1),
    d: { id: 'g1', name: 'Lab', channels: [{ id: 'c1', name: 'general', type: 0 }], threads: [{ id: 't1', name: 'ideas', type: 11 }], roles: [{ id: '777', name: 'helper', managed: true, tags: { bot_id: BOT } }, { id: '888', name: 'mods' }] },
  });
  event({ id: 'm1', channel_id: 'dm1', author: ada, content: '  hello there ', mentions: [] });
  event({ id: 'm2', channel_id: 'c1', guild_id: 'g1', author: ada, member: { nick: 'Ada (lab)' }, content: `<@${BOT}> summarise this`, mentions: [{ id: BOT }], type: 0 });
  event({ id: 'm3', channel_id: 'c1', guild_id: 'g1', author: ada, member: { nick: null }, content: `hey <@!${BOT}>   what's new`, mentions: [{ id: BOT }] });
  event({ id: 'm4', channel_id: 't1', guild_id: 'g1', author: ada, content: 'thanks!', mentions: [], type: 19, referenced_message: { id: 'b1', author: { id: BOT, bot: true } } });
  event({ id: 'm5', channel_id: 'c1', guild_id: 'g1', author: { id: '43', username: 'bob' }, content: 'just chatting <@99>', mentions: [{ id: '99' }] });
  event({ id: 'm6', channel_id: 'c1', guild_id: 'g1', author: ada, content: '<@&777> via the role', mentions: [], mention_roles: ['777'] });
  event({ id: 'm7', channel_id: 'c9', guild_id: 'g2', author: ada, content: 'unknown channel' });
  // dropped
  event({ id: 'x1', channel_id: 'c1', guild_id: 'g1', author: { id: '7', username: 'otherbot', bot: true }, content: `<@${BOT}> hi`, mentions: [{ id: BOT }] });
  event({ id: 'x2', channel_id: 'dm1', author: { id: BOT, username: 'helper' }, content: 'my own reply' });
  event({ id: 'x3', channel_id: 'dm1', author: ada, content: '   ' });
  event({ id: 'x4', channel_id: 'c1', guild_id: 'g1', author: ada, content: `<@${BOT}>`, mentions: [{ id: BOT }] });
  event({ id: 'x5', channel_id: 'c1', guild_id: 'g1', author: ada, content: '', attachments: [{ id: 'a' }] });
  event({ id: 'x6', channel_id: 'c1', guild_id: 'g1', webhook_id: 'w1', author: { id: 'w1', username: 'hook' }, content: 'from a webhook' });
  event({ id: 'x7', channel_id: 'c1', guild_id: 'g1', author: ada, content: 'pinned a message', type: 6 });
  assert.deepEqual(h.messages, [
    { chatId: 'dm1', messageId: 'm1', userId: '42', userName: 'Ada L', text: 'hello there', isDirect: true, mentioned: true },
    { chatId: 'c1', messageId: 'm2', userId: '42', userName: 'Ada (lab)', text: 'summarise this', isDirect: false, mentioned: true, chatTitle: 'Lab #general' },
    { chatId: 'c1', messageId: 'm3', userId: '42', userName: 'Ada L', text: "hey what's new", isDirect: false, mentioned: true, chatTitle: 'Lab #general' },
    { chatId: 't1', messageId: 'm4', userId: '42', userName: 'Ada L', text: 'thanks!', isDirect: false, mentioned: true, chatTitle: 'Lab #ideas' },
    { chatId: 'c1', messageId: 'm5', userId: '43', userName: 'bob', text: 'just chatting <@99>', isDirect: false, mentioned: false, chatTitle: 'Lab #general' },
    { chatId: 'c1', messageId: 'm6', userId: '42', userName: 'Ada L', text: 'via the role', isDirect: false, mentioned: true, chatTitle: 'Lab #general' },
    { chatId: 'c9', messageId: 'm7', userId: '42', userName: 'Ada L', text: 'unknown channel', isDirect: false, mentioned: false },
  ]);
  await h.c.stop();
});

test('normalizeMessage works on its own and a throwing onMessage does not break the socket', async () => {
  assert.equal(normalizeMessage({ id: '1', channel_id: 'c', author: { id: BOT }, content: 'me' }, BOT), null);
  assert.equal(normalizeMessage({ id: '1', channel_id: 'c', content: 'no author' }, BOT), null);
  assert.deepEqual(normalizeMessage({ id: '1', channel_id: 'c', guild_id: 'g', author: { id: '2', username: 'u' }, content: `<@${BOT}><@!${BOT}> twice` }, BOT), { chatId: 'c', messageId: '1', userId: '2', userName: 'u', text: 'twice', isDirect: false, mentioned: true });
  const h = harness({ onMessage: () => { throw new Error('caller bug'); } });
  const { ws } = await online(h);
  ws.push({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'm', channel_id: 'dm', author: { id: '5', username: 'z' }, content: 'hi' } });
  assert.ok(h.logs.some((l) => /caller bug/.test(l)));
  ws.push({ op: 1 });
  assert.equal(ws.sent.at(-1).op, 1, 'still handling frames');
  await h.c.stop();
});

test('op 7 resumes, op 9 resumes or identifies again after 1–5 s', async () => {
  const h = harness();
  const { ws } = await online(h);
  ws.push({ op: 7, d: null });
  assert.equal(ws.closedWith, 4000);
  await h.clock.tick(0);
  const r1 = h.last();
  assert.equal(r1.url, RESUME);
  r1.push(HELLO);
  assert.deepEqual(r1.sent[0], { op: 6, d: { token: TOKEN, session_id: 'sess-1', seq: 1 } });

  r1.push({ op: 9, d: true });
  await h.clock.tick(0);
  const r2 = h.last();
  assert.notEqual(r2, r1);
  assert.equal(r2.url, RESUME);
  r2.push(HELLO);
  assert.equal(r2.sent[0].op, 6);

  r2.push({ op: 9, d: false });
  await h.clock.tick(2_999); // 1 s + 4 s × 0.5
  assert.equal(h.last(), r2);
  await h.clock.tick(1);
  const fresh = h.last();
  assert.equal(fresh.url, GATEWAY, 'a new session goes to the main gateway, not the resume URL');
  fresh.push(HELLO);
  assert.equal(fresh.sent[0].op, 2);
  fresh.push({ ...READY, d: { ...READY.d, session_id: 'sess-2' } });
  assert.equal(h.statuses.at(-1).state, 'connected');
  assert.equal(h.calls.filter((c) => c.url.endsWith('/gateway/bot')).length, 1, 'the gateway URL is cached');

  fresh.push({ op: 7 });
  await h.clock.tick(0);
  h.last().push(HELLO);
  assert.deepEqual(h.last().sent[0].d.session_id, 'sess-2');
  await h.c.stop();
  assertNoToken(h);
});

test('close 4004 rejects start with "invalid bot token" and stops for good', async () => {
  const h = harness();
  const started = h.c.start();
  await flush();
  h.last().push(HELLO);
  h.last().drop(4004, 'Authentication failed.');
  await assert.rejects(started, (e) => (h.errors.push(e), /invalid bot token/i.test(e.message) && e.fatal === true));
  const s = h.statuses.at(-1);
  assert.equal(s.state, 'error');
  assert.equal(s.fatal, true);
  assert.match(s.detail, /invalid bot token/i);
  assert.equal(h.clock.size, 0);
  await h.clock.tick(120_000);
  assert.equal(h.sockets.length, 1, 'no reconnects after a fatal close');
  assertNoToken(h);
});

test('a 401 from /gateway/bot rejects start before any socket opens', async () => {
  const h = harness({ fetch: async () => reply(401, { message: '401: Unauthorized', code: 0 }) });
  await assert.rejects(h.c.start(), (e) => (h.errors.push(e), /invalid bot token/i.test(e.message)));
  assert.equal(h.sockets.length, 0);
  assert.deepEqual(h.statuses.at(-1), { state: 'error', detail: h.statuses.at(-1).detail, fatal: true });
  assertNoToken(h);
});

test('close 4014 is fatal and says to enable the Message Content Intent', async () => {
  const h = harness();
  const started = h.c.start();
  await flush();
  h.last().push(HELLO);
  h.last().drop(4014, 'Disallowed intent(s).');
  await assert.rejects(started, (e) => (h.errors.push(e), /Message Content Intent/.test(e.message)));
  const s = h.statuses.at(-1);
  assert.equal(s.fatal, true);
  assert.match(s.detail, /Message Content Intent/);
  assert.match(s.detail, /Privileged Gateway Intents/);
  assert.match(s.detail, /Developer Portal/);
  await h.clock.tick(120_000);
  assert.equal(h.sockets.length, 1);

  for (const code of [4010, 4011, 4012, 4013]) {
    const hx = harness();
    const { ws } = await online(hx);
    ws.drop(code);
    assert.equal(hx.statuses.at(-1).fatal, true, `close ${code}`);
    await hx.clock.tick(120_000);
    assert.equal(hx.sockets.length, 1);
  }
  assertNoToken(h);
});

test('a dropped connection reconnects with exponential backoff and resumes', async () => {
  const h = harness();
  const { ws } = await online(h);
  ws.drop(1006);
  assert.equal(h.statuses.at(-1).state, 'connecting', 'the first drop after a good connection is not an error yet');
  assert.deepEqual(h.clock.delays(), [1000]);
  await h.clock.tick(999);
  assert.equal(h.sockets.length, 1);
  await h.clock.tick(1);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.last().url, RESUME);

  h.last().drop(1006); // fails again before Hello
  assert.equal(h.statuses.at(-1).state, 'error');
  assert.equal(h.statuses.at(-1).fatal, false);
  assert.match(h.statuses.at(-1).detail, /reconnecting in 2 s/);
  assert.deepEqual(h.clock.delays(), [2000]);
  await h.clock.tick(2000);
  h.last().drop(1006);
  assert.deepEqual(h.clock.delays(), [4000]);
  await h.clock.tick(4000);
  const back = h.last();
  back.push(HELLO);
  assert.deepEqual(back.sent[0], { op: 6, d: { token: TOKEN, session_id: 'sess-1', seq: 1 } });
  back.push({ op: 0, t: 'RESUMED', s: 2, d: null });
  assert.equal(h.statuses.at(-1).state, 'connected');

  back.drop(1001);
  assert.deepEqual(h.clock.delays(), [1000], 'backoff resets after a good connection');
  await h.clock.tick(1000);
  h.last().drop(4009); // session timed out: start a new one
  await h.clock.tick(2000);
  const fresh = h.last();
  assert.equal(fresh.url, GATEWAY);
  fresh.push(HELLO);
  assert.equal(fresh.sent[0].op, 2);

  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n, () => 0.5)), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  for (const r of [0, 0.99]) for (let n = 0; n < 10; n += 1) {
    const d = backoffDelay(n, () => r);
    assert.ok(d >= 1000 && d <= 60000, `${n}/${r}: ${d}`);
  }
  await h.c.stop();
  assertNoToken(h);
});

test('start keeps retrying through network errors and resolves once Discord answers', async () => {
  let n = 0;
  const h = harness({ fetch: async () => {
    n += 1;
    if (n === 1) throw new Error(`getaddrinfo ENOTFOUND discord.com (Bot ${TOKEN})`);
    if (n === 2) return reply(502, { message: 'Bad Gateway' });
    return reply(200, { url: 'wss://gateway.test' });
  } });
  const started = h.c.start();
  await flush();
  assert.equal(h.statuses.at(-1).state, 'error');
  assert.equal(h.statuses.at(-1).fatal, false);
  await h.clock.tick(1000);
  assert.match(h.statuses.at(-1).detail, /HTTP 502/);
  await h.clock.tick(2000);
  h.last().push(HELLO);
  h.last().push(READY);
  assert.equal((await started).id, BOT);
  await h.c.stop();
  assertNoToken(h);
});

test('splitMessage: within the limit, newline first, then space, then a hard cut', () => {
  assert.deepEqual(splitMessage('hi'), ['hi']);
  assert.deepEqual(splitMessage(''), []);
  assert.deepEqual(splitMessage('  \n\n  '), []);
  assert.deepEqual(splitMessage('\n'.repeat(3000) + 'end'), ['end']);

  const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const a = splitMessage(lines);
  assert.ok(a.length >= 3);
  for (const c of a) assert.ok(c.length <= 2000 && c.trim() === c && c.length > 0);
  assert.equal(a.join('\n'), lines, 'cuts land on line breaks');

  const part1 = 'alpha beta '.repeat(150).trim();
  const part2 = 'gamma delta '.repeat(100).trim();
  const b = splitMessage(`${part1}\n${part2}`);
  assert.deepEqual(b, [part1, part2], 'a newline wins over a later space');

  const words = 'word '.repeat(1000).trim();
  const w = splitMessage(words);
  for (const c of w) assert.ok(c.length <= 2000 && !c.startsWith(' ') && !c.endsWith(' '));
  assert.equal(w.join(' '), words);

  const blob = 'a'.repeat(4500);
  const hard = splitMessage(blob);
  assert.ok(hard.every((c) => c.length <= 2000));
  assert.equal(hard.join(''), blob);

  const emoji = '😀'.repeat(1500); // 3000 UTF-16 units
  const e = splitMessage(emoji);
  assert.equal(e.join(''), emoji);
  assert.ok(e.every((c) => c.length <= 2000 && !/[\ud800-\udbff]$/.test(c)), 'surrogate pairs stay whole');
});

test('splitMessage closes a code fence at the cut and reopens it with the language', () => {
  const code = Array.from({ length: 120 }, (_, i) => `const v${i} = ${i}; // filler filler`).join('\n');
  const text = `Here is the code:\n\`\`\`js\n${code}\n\`\`\`\nDone.`;
  const chunks = splitMessage(text);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.length <= 2000, `chunk of ${c.length}`);
    assert.equal((c.match(/```/g) ?? []).length % 2, 0, 'every chunk has balanced fences');
  }
  assert.ok(chunks[0].endsWith('\n```'));
  for (const c of chunks.slice(1)) assert.ok(c.startsWith('```js\n'), c.slice(0, 20));
  assert.ok(chunks.at(-1).endsWith('```\nDone.'));
  assert.equal(chunks.join('\n').match(/const v\d+ = /g).length, 120, 'no code line lost or doubled');

  const bare = `${'a'.repeat(1985)}\n\`\`\`py\n${'print(1)\n'.repeat(300)}\`\`\``;
  const p = splitMessage(bare);
  assert.equal(p[0], 'a'.repeat(1985), 'an opening fence is not left dangling at the end of a chunk');
  assert.ok(p[1].startsWith('```py\nprint(1)'));
  for (const c of p) assert.ok(c.length <= 2000 && (c.match(/```/g) ?? []).length % 2 === 0);
});

test('send posts each chunk without pings and threads only the first one as a reply', async () => {
  const h = harness();
  const text = Array.from({ length: 80 }, (_, i) => `paragraph ${i} ${'y'.repeat(40)}`).join('\n');
  await h.c.send('c1', text, { replyTo: 'm9' });
  const posts = h.calls.filter((c) => c.method === 'POST');
  assert.ok(posts.length >= 2);
  for (const p of posts) {
    assert.equal(p.url, 'https://discord.com/api/v10/channels/c1/messages');
    assert.equal(p.headers.Authorization, `Bot ${TOKEN}`);
    assert.equal(p.headers['Content-Type'], 'application/json');
    assert.ok(p.body.content.length <= 2000);
    assert.deepEqual(p.body.allowed_mentions, { parse: [] });
  }
  assert.deepEqual(posts[0].body.message_reference, { message_id: 'm9', fail_if_not_exists: false });
  assert.ok(posts.slice(1).every((p) => !('message_reference' in p.body)));
  assert.equal(posts.map((p) => p.body.content).join('\n'), text);

  await h.c.send('c1', 'short');
  assert.equal(h.calls.at(-1).body.message_reference, undefined);
  const before = h.calls.length;
  await h.c.send('c1', '   ');
  assert.equal(h.calls.length, before, 'nothing to send, nothing posted');
});

test('send waits out a 429 and retries; other errors carry status and message, not the token', async () => {
  let n = 0;
  const h = harness({ fetch: async () => {
    n += 1;
    if (n === 1) return reply(429, { message: 'You are being rate limited.', retry_after: 1.5, global: false });
    if (n === 2) return reply(429, null, { 'retry-after': '2' });
    return reply(200, { id: 'ok' });
  } });
  const sent = h.c.send('c1', 'hello');
  await flush();
  assert.equal(n, 1);
  assert.deepEqual(h.clock.delays(), [1500]);
  await h.clock.tick(1500);
  assert.equal(n, 2);
  assert.deepEqual(h.clock.delays(), [2000]);
  await h.clock.tick(2000);
  await sent;
  assert.equal(n, 3);

  const always = harness({ fetch: async () => reply(429, { retry_after: 0.1 }) });
  const p = always.c.send('c1', 'x');
  p.catch(() => {});
  for (let i = 0; i < 4; i += 1) await always.clock.tick(100);
  await assert.rejects(p, /HTTP 429/);
  assert.equal(always.calls.length, 4, 'gives up after a few retries');

  const denied = harness({ fetch: async () => reply(403, { message: 'Missing Permissions', code: 50013 }) });
  await assert.rejects(denied.c.send('c1', 'x'), (e) => (denied.errors.push(e), e.status === 403 && /403/.test(e.message) && /Missing Permissions/.test(e.message)));
  assertNoToken(denied);

  const offline = harness({ fetch: async () => { throw new Error(`connect ECONNREFUSED with Bot ${TOKEN}`); } });
  await assert.rejects(offline.c.send('c1', 'x'), (e) => (offline.errors.push(e), /ECONNREFUSED/.test(e.message)));
  assertNoToken(offline);
});

test('typing posts the indicator and swallows failures', async () => {
  const h = harness();
  await h.c.typing('c1');
  assert.equal(h.calls[0].url, 'https://discord.com/api/v10/channels/c1/typing');
  assert.equal(h.calls[0].method, 'POST');
  const broken = harness({ fetch: async () => { throw new Error(`socket hang up ${TOKEN}`); } });
  await broken.c.typing('c1');
  assert.ok(broken.logs.some((l) => /typing/.test(l)));
  assertNoToken(broken);
});

test('stop is idempotent, closes with 1000 and nothing reconnects afterwards', async () => {
  const h = harness();
  const { ws } = await online(h);
  await h.c.stop();
  await h.c.stop();
  assert.equal(ws.closedWith, 1000);
  assert.equal(h.statuses.filter((s) => s.state === 'stopped').length, 1);
  assert.equal(h.clock.size, 0, 'no timers left');
  ws.drop(1006);
  ws.push({ op: 7 });
  await h.clock.tick(120_000);
  assert.equal(h.sockets.length, 1);
  await assert.rejects(h.c.send('c1', 'x'), /stopped/);
  await assert.rejects(h.c.start(), /stopped/);
  await h.c.typing('c1');

  // during a backoff wait
  const h2 = harness();
  const { ws: w2 } = await online(h2);
  w2.drop(1006);
  assert.equal(h2.clock.size, 1);
  await h2.c.stop();
  assert.equal(h2.clock.size, 0);
  await h2.clock.tick(120_000);
  assert.equal(h2.sockets.length, 1);

  // before READY: start rejects
  const h3 = harness();
  const started = h3.c.start();
  await flush();
  h3.last().push(HELLO);
  await h3.c.stop();
  await assert.rejects(started, /stopped/);
  assert.equal(h3.clock.size, 0);

  // during a 429 wait
  const h4 = harness({ fetch: async () => reply(429, { retry_after: 30 }) });
  const sending = h4.c.send('c1', 'x');
  await flush();
  assert.equal(h4.clock.size, 1);
  await h4.c.stop();
  await assert.rejects(sending, /stopped/);
  assert.equal(h4.clock.size, 0);

  // stop after a fatal error still reports stopped once
  const h5 = harness();
  const s5 = h5.c.start();
  await flush();
  h5.last().drop(4004);
  await assert.rejects(s5);
  await h5.c.stop();
  await h5.c.stop();
  assert.deepEqual(h5.states().slice(-2), ['error', 'stopped']);
  for (const x of [h, h2, h3, h4, h5]) assertNoToken(x);
});

test('a missing token fails fast without touching the network', async () => {
  const h = harness({ token: '  ' });
  await assert.rejects(h.c.start(), /No Discord bot token/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.statuses.at(-1).fatal, true);
});
