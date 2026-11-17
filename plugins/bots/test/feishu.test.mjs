import assert from 'node:assert/strict';
import test from 'node:test';

import { PRIVATE_TEXT, createChannels } from '../lib/channels.mjs';
import { catalog } from '../lib/apps.mjs';
import * as feishu from '../lib/channels/feishu.mjs';
import { MARKDOWN, TEXT_LIMIT, backoffDelay, createConnector, decodeFrame, encodeFrame, kind, links, normalizeEvent } from '../lib/channels/feishu.mjs';

const APP_ID = 'cli_a1b2c3d4e5f60718';
const LARK_APP = 'cli_f0e1d2c3b4a59687';
const SECRET = 'sEcReT-feishu-app-secret-do-not-leak';
const TICKET = 'tIcKeT-short-lived-do-not-leak';
const BOT = 'ou_bot00000000000000000000000000001';
const KADA = 'ou_kada0000000000000000000000000001';
const MAY = 'ou_may00000000000000000000000000001';
const FEISHU = 'http://feishu.test';
const LARK = 'http://lark.test';

const enc = new TextEncoder();
const dec = new TextDecoder();
const flush = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};
const reply = (status, body, headers = {}) => ({ status, headers: new Headers(headers), text: async () => (body == null ? '' : JSON.stringify(body)) });

/** Timers that only move when the test says so. */
function fakeClock() {
  let now = 1_700_000_000_000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms = 0) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async tick(ms = 0) {
      const end = now + ms;
      for (;;) {
        let id = null;
        let t = null;
        for (const [k, v] of timers) if (v.at <= end && (!t || v.at < t.at)) [id, t] = [k, v];
        if (!t) break;
        timers.delete(id);
        now = t.at;
        t.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    delays: () => [...timers.values()].map((v) => v.at - now).sort((a, b) => a - b),
  };
}

/**
 * The Open API and the long-connection endpoint of Feishu and Lark. `apps`
 * says which App IDs each platform knows; `routes` overrides an answer:
 * {'GET /open-apis/bot/v3/info': (call) => reply(...)}.
 */
function fakePlatform({ apps = { feishu: { [APP_ID]: SECRET }, lark: {} }, routes = {} } = {}) {
  const calls = [];
  const tokens = new Set();
  let n = 0;
  const p = { calls, tokens, apps, routes };
  p.of = (method, path) => calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)));
  p.fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const base = u.origin === LARK ? 'lark' : 'feishu';
    const call = { base, method: init.method ?? 'GET', path: u.pathname, search: u.search, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization ?? '' };
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    for (const [k, fn] of Object.entries(routes)) {
      const [m, path] = k.split(' ');
      if (m === call.method && (path === call.path || (path.endsWith('*') && call.path.startsWith(path.slice(0, -1))))) {
        const r = await fn(call, p);
        if (r) return r;
      }
    }
    const known = apps[base] ?? {};
    if (key === 'POST /open-apis/auth/v3/tenant_access_token/internal') {
      if (!(call.body.app_id in known)) return reply(200, { code: 10014, msg: 'app id not exists' });
      if (known[call.body.app_id] !== call.body.app_secret) return reply(200, { code: 10015, msg: 'wrong app secret' });
      const token = `t-${base}-${(n += 1)}-token-value`;
      tokens.add(token);
      return reply(200, { code: 0, msg: 'ok', tenant_access_token: token, expire: 7200 });
    }
    if (key === 'POST /callback/ws/endpoint') {
      if (known[call.body.AppID] !== call.body.AppSecret) return reply(200, { code: 1000040345, msg: 'app_id or app_secret is invalid', data: { URL: '' } });
      return reply(200, { code: 0, msg: 'ok', data: { URL: `wss://${base}.ws.test/ws/v2?device_id=dev1&service_id=77&ticket=${TICKET}`, ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 } } });
    }
    if (!tokens.has(call.auth.replace(/^Bearer /, ''))) return reply(400, { code: 99991663, msg: 'Invalid access token for authorization.' });
    if (key === 'GET /open-apis/bot/v3/info') return reply(200, { code: 0, msg: 'ok', bot: { activate_status: 2, app_name: 'Acme Team', open_id: BOT } });
    if (/^GET \/open-apis\/contact\/v3\/users\//.test(key)) {
      const id = decodeURIComponent(call.path.split('/').pop());
      return reply(200, { code: 0, data: { user: { open_id: id, name: id === MAY ? 'May' : 'Kada Liao' } } });
    }
    if (/^GET \/open-apis\/im\/v1\/chats\//.test(key)) return reply(200, { code: 0, data: { name: 'Launch room' } });
    if (key === 'POST /open-apis/im/v1/messages' || /^POST \/open-apis\/im\/v1\/messages\/[^/]+\/reply$/.test(key)) return reply(200, { code: 0, data: { message_id: `om_sent${(n += 1)}` } });
    if (/\/reactions$/.test(call.path) && call.method === 'POST') return reply(200, { code: 0, data: { reaction_id: `react${(n += 1)}` } });
    if (/\/reactions\//.test(call.path) && call.method === 'DELETE') return reply(200, { code: 0, data: {} });
    return reply(404, { code: 404, msg: 'not found' });
  };
  return p;
}

/** WebSockets that the test opens, feeds and drops by hand. */
function socketKit() {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = {};
      this.closedWith = null;
      sockets.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type, ev) {
      for (const fn of this.listeners[type] ?? []) fn(ev);
    }
    send(bytes) {
      const f = decodeFrame(bytes);
      this.sent.push(f);
      // Feishu answers every ping with a pong.
      if (this.autoPong !== false && f.method === 0 && f.headers[0]?.value === 'ping') queueMicrotask(() => this.push({ SeqID: 0, LogID: 0, service: f.service, method: 0, headers: [{ key: 'type', value: 'pong' }] }));
    }
    close(code = 1000) {
      this.closedWith = code;
      this.emit('close', { code, reason: '' });
    }
    open() {
      this.emit('open', {});
    }
    /** A frame from Feishu. */
    push(frame) {
      const bytes = encodeFrame(frame);
      this.emit('message', { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }
    drop(code = 1006) {
      this.emit('close', { code, reason: '' });
    }
    acks() {
      return this.sent.filter((f) => f.method === 1);
    }
    pings() {
      return this.sent.filter((f) => f.method === 0);
    }
  }
  return { sockets, FakeSocket };
}

function harness({ platform = fakePlatform(), appId = APP_ID, secret = SECRET, ...opts } = {}) {
  const clock = fakeClock();
  const { sockets, FakeSocket } = socketKit();
  const h = { clock, sockets, platform, statuses: [], messages: [], logs: [] };
  h.c = createConnector({
    token: secret,
    values: { appId, appSecret: secret },
    onMessage: (m) => h.messages.push(m),
    onStatus: (s) => h.statuses.push(s),
    log: (line) => h.logs.push(line),
    fetchImpl: platform.fetchImpl,
    WebSocketImpl: FakeSocket,
    apiBase: FEISHU,
    larkApiBase: LARK,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    random: () => 0.5,
    now: clock.now,
    ...opts,
  });
  h.last = () => sockets.at(-1);
  h.states = () => h.statuses.map((s) => s.state);
  return h;
}

/** Start and open the first socket; resolves with the account. */
async function online(h) {
  const started = h.c.start();
  await flush();
  h.last().open();
  await flush();
  return started;
}

let seq = 0;
function eventFrame(data, { sum, seqNo, msgId } = {}) {
  seq += 1;
  return {
    SeqID: BigInt(seq),
    LogID: 9007199254740993n + BigInt(seq),
    service: 77,
    method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: msgId ?? `frame-${seq}` },
      { key: 'sum', value: String(sum ?? 1) },
      { key: 'seq', value: String(seqNo ?? 0) },
      { key: 'trace_id', value: `trace-${seq}` },
    ],
    payload: enc.encode(JSON.stringify(data)),
  };
}
let msgN = 0;
function receive({ chatId = 'oc_dm_kada', chatType = 'p2p', text = 'hello', type = 'text', content, mentions, from = KADA, senderType = 'user', id, time, parent, root, thread } = {}) {
  msgN += 1;
  const created = String(time ?? 1_700_000_000_000 + msgN);
  return {
    schema: '2.0',
    header: { event_id: `ev-${msgN}`, event_type: 'im.message.receive_v1', create_time: created, token: '', app_id: APP_ID, tenant_key: 'tenant1' },
    event: {
      sender: { sender_id: { open_id: from, union_id: 'on_1', user_id: 'u1' }, sender_type: senderType, tenant_key: 'tenant1' },
      message: {
        message_id: id ?? `om_in${msgN}`,
        ...(root ? { root_id: root } : {}),
        ...(parent ? { parent_id: parent } : {}),
        create_time: created,
        chat_id: chatId,
        ...(thread ? { thread_id: thread } : {}),
        chat_type: chatType,
        message_type: type,
        content: content ?? JSON.stringify({ text }),
        ...(mentions ? { mentions } : {}),
      },
    },
  };
}
const mention = (n, openId, name, type = 'user') => ({ key: `@_user_${n}`, id: { open_id: openId, union_id: 'on', user_id: 'u' }, mentioned_type: type, name, tenant_key: 'tenant1' });

/** Nothing the connector reported or threw carries the App Secret, a tenant token or the connection ticket. */
function assertNoSecrets(h, ...extra) {
  const seen = JSON.stringify([h.statuses, h.logs, ...extra.map((e) => (e instanceof Error ? e.message : e))]);
  assert.equal(seen.includes(SECRET), false, 'the App Secret leaked');
  assert.equal(seen.includes(TICKET), false, 'the connection ticket leaked');
  assert.equal(/t-(feishu|lark)-\d+-token-value/.test(seen), false, 'a tenant token leaked');
}

// --- module ---------------------------------------------------------------------------

test('module contract: kind, limit, Markdown, and the AppLink to the bot chat', () => {
  assert.equal(kind, 'feishu');
  assert.equal(TEXT_LIMIT, 4000);
  assert.equal(MARKDOWN, true);
  assert.deepEqual(links({ values: { appId: APP_ID, appSecret: SECRET } }), { link: `https://applink.feishu.cn/client/bot/open?appId=${APP_ID}` });
  assert.deepEqual(links({ values: { appId: 'not an id' } }), {});
  assert.deepEqual(links({}), {});
  assert.equal(backoffDelay(0, () => 0.5), 1000);
  assert.equal(backoffDelay(10, () => 0.5), 60_000);
});

test('frames: the protobuf round-trips, 64-bit ids exactly, unknown fields skipped', () => {
  const f = { SeqID: 18446744073709551000n, LogID: 9007199254740993n, service: -2, method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'sum', value: '1' }], payloadEncoding: 'gzip', payloadType: 'json', payload: enc.encode('{"x":"中文"}'), LogIDNew: 'L1' };
  const back = decodeFrame(encodeFrame(f));
  assert.equal(back.SeqID, f.SeqID);
  assert.equal(back.LogID, f.LogID);
  assert.equal(back.service, -2);
  assert.equal(back.method, 1);
  assert.deepEqual(back.headers, f.headers);
  assert.equal(dec.decode(back.payload), '{"x":"中文"}');
  assert.equal(back.payloadEncoding, 'gzip');
  assert.equal(back.LogIDNew, 'L1');
  // field 15 (varint) and field 16 (bytes) from a newer server are skipped
  const extra = Uint8Array.from([...encodeFrame({ SeqID: 1, LogID: 2, service: 3, method: 0 }), 15 << 3, 0x96, 0x01, (16 << 3) | 2, 0x02, 0x01, 0x02]);
  assert.equal(decodeFrame(extra).service, 3);
  assert.throws(() => decodeFrame(Uint8Array.from([(8 << 3) | 2, 0x05, 0x01])), /truncated/);
});

test('normalizeEvent: direct and group text, mentions resolved, other types and senders ignored', () => {
  const dm = normalizeEvent(receive({ text: 'plan the launch', id: 'om_1', time: 1_700_000_000_123 }).event, { botOpenId: BOT });
  assert.deepEqual(dm, { chatId: 'oc_dm_kada', messageId: 'om_1', order: '1700000000123', userId: KADA, text: 'plan the launch', isDirect: true, mentioned: true });

  const group = (text, mentions, extra = {}) => normalizeEvent(receive({ chatId: 'oc_grp', chatType: 'group', text, mentions, ...extra }).event, { botOpenId: BOT, sentIds: new Set(['om_bot_said']) });
  assert.deepEqual(
    [group('@_user_1 plan it', [mention(1, BOT, 'Acme Team', 'bot')]), group('hey @_user_1, ask @_user_2 to review', [mention(1, BOT, 'Acme Team', 'bot'), mention(2, MAY, 'May')]), group('@_user_1，帮我看看', [mention(1, BOT, 'Acme', 'bot')])].map((m) => [m.text, m.isDirect, m.mentioned]),
    [
      ['plan it', false, true],
      ['hey, ask @May to review', false, true],
      ['帮我看看', false, true],
    ],
  );
  assert.equal(group('@_user_1 not for us', [mention(1, MAY, 'May')]).mentioned, false);
  assert.equal(group('@_user_1 @forge fix it', [mention(1, BOT, 'Acme Team', 'bot')]).text, '@forge fix it', 'a typed @handle stays for routing');
  assert.equal(group('and the docs', undefined, { parent: 'om_bot_said' }).mentioned, true, 'a reply to the bot addresses it');
  assert.equal(group('@_all standup', []).text, '@all standup');
  // no open_id known yet: a bot mention counts
  assert.equal(normalizeEvent(receive({ chatType: 'group', text: '@_user_1 hi', mentions: [mention(1, BOT, 'Acme', 'bot')] }).event).mentioned, true);

  const post = normalizeEvent(
    receive({
      type: 'post',
      content: JSON.stringify({
        title: 'Launch',
        content: [
          [{ tag: 'at', user_id: '@_user_1', user_name: 'Acme' }, { tag: 'text', text: ' see ' }, { tag: 'a', text: 'the doc', href: 'https://example.com/d' }],
          [{ tag: 'img', image_key: 'img_1' }],
          [{ tag: 'code_block', language: 'JS', text: 'run()' }],
        ],
      }),
      mentions: [mention(1, BOT, 'Acme', 'bot')],
    }).event,
    { botOpenId: BOT },
  );
  assert.equal(post.text, 'Launch\nsee the doc (https://example.com/d)\n\n```js\nrun()\n```');
  const localized = normalizeEvent(receive({ type: 'post', content: JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'text', text: '你好' }]] } }) }).event, { botOpenId: BOT });
  assert.equal(localized.text, '你好');

  assert.equal('threadId' in dm, false, 'a message that answers nothing has no threadId');
  assert.equal(normalizeEvent(receive({ type: 'image', content: JSON.stringify({ image_key: 'img_x' }) }).event, { botOpenId: BOT }), null);
  assert.equal(normalizeEvent(receive({ senderType: 'app' }).event, { botOpenId: BOT }), null);
  assert.equal(normalizeEvent(receive({ from: BOT }).event, { botOpenId: BOT }), null);
  assert.equal(normalizeEvent(receive({ text: '@_user_1', mentions: [mention(1, BOT, 'Acme', 'bot')] }).event, { botOpenId: BOT }), null, 'nothing left to read');
  assert.equal(normalizeEvent(receive({ content: '{broken' }).event, { botOpenId: BOT }), null);
});

test('normalizeEvent: threadId is the root message of a reply chain or topic, never the topic id', () => {
  const at = [mention(1, BOT, 'Acme Team', 'bot')];
  const t = (extra) => normalizeEvent(receive({ chatId: 'oc_grp', chatType: 'group', text: '@_user_1 go', mentions: at, ...extra }).event, { botOpenId: BOT })?.threadId;
  assert.equal(t({ id: 'om_top' }), undefined, 'a top-level message');
  assert.equal(t({ id: 'om_r2', root: 'om_top', parent: 'om_bot1' }), 'om_top', 'a reply chain: its root, not the message it answers');
  assert.equal(t({ id: 'om_t2', root: 'om_top', parent: 'om_top', thread: 'omt_1' }), 'om_top', 'a reply in a topic: the same root');
  assert.equal(t({ id: 'om_topic', thread: 'omt_2', chatType: 'topic_group' }), 'om_topic', 'the first message of a topic is its own root');
  assert.equal(t({ id: 'om_p', parent: 'om_q' }), 'om_q', 'a parent without a root names the root');
  const dmReply = normalizeEvent(receive({ text: 'about that', root: 'om_dm_first', parent: 'om_dm_first' }).event, { botOpenId: BOT });
  assert.equal(dmReply.threadId, 'om_dm_first', 'a reply chain in a DM too');
});

// --- connecting -----------------------------------------------------------------------

test('start: App ID checked on Feishu without the secret, token, long connection, bot info; pings with the service id', async () => {
  const h = harness();
  const me = await online(h);
  assert.deepEqual(me, { id: APP_ID, username: 'Acme Team', name: 'Acme Team' });
  const tokenCalls = h.platform.of('POST', '/open-apis/auth/v3/tenant_access_token/internal');
  assert.equal(tokenCalls.length, 2);
  assert.notEqual(tokenCalls[0].body.app_secret, SECRET, 'the first look-up carries no secret');
  assert.equal(tokenCalls[1].body.app_secret, SECRET);
  assert.ok(h.platform.calls.every((c) => c.base === 'feishu'), 'nothing went to Lark');
  assert.deepEqual(h.platform.of('POST', '/callback/ws/endpoint')[0].body, { AppID: APP_ID, AppSecret: SECRET });
  assert.match(h.last().url, /^wss:\/\/feishu\.ws\.test\/ws\/v2\?/);
  assert.match(h.platform.of('GET', '/open-apis/bot/v3/info')[0].auth, /^Bearer t-feishu-/);
  const ping = h.last().pings()[0];
  assert.deepEqual([ping.service, ping.method, ping.headers], [77, 0, [{ key: 'type', value: 'ping' }]]);
  assert.deepEqual(h.states(), ['connecting', 'connected']);
  // the next ping follows the interval from ClientConfig (120 s)
  await h.clock.tick(119_000);
  assert.equal(h.last().pings().length, 1);
  h.last().push({ SeqID: 0, LogID: 0, service: 77, method: 0, headers: [{ key: 'type', value: 'pong' }], payload: enc.encode(JSON.stringify({ PingInterval: 30, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 })) });
  await h.clock.tick(1000);
  assert.equal(h.last().pings().length, 2);
  await h.clock.tick(29_000);
  assert.equal(h.last().pings().length, 2, 'the pong carried a new interval: the next ping comes after 30 s');
  h.last().push({ SeqID: 0, LogID: 0, service: 77, method: 0, headers: [{ key: 'type', value: 'pong' }] });
  await h.clock.tick(1000);
  assert.equal(h.last().pings().length, 3);
  assertNoSecrets(h);
  await h.c.stop();
  await h.c.stop();
  assert.equal(h.states().at(-1), 'stopped');
  assert.equal(h.last().closedWith, 1000);
  await assert.rejects(h.c.start(), /stopped/);
});

test('a Lark app: Feishu does not know the App ID, so the secret goes to Lark only; messages say Lark', async () => {
  const platform = fakePlatform({ apps: { feishu: {}, lark: { [LARK_APP]: SECRET } } });
  const h = harness({ platform, appId: LARK_APP });
  const me = await online(h);
  assert.equal(me.id, LARK_APP);
  const toFeishu = platform.calls.filter((c) => c.base === 'feishu');
  assert.equal(toFeishu.length, 1, 'one look-up on Feishu');
  assert.notEqual(toFeishu[0].body.app_secret, SECRET);
  assert.equal(JSON.stringify(toFeishu).includes(SECRET), false, 'the secret never went to Feishu');
  assert.match(h.last().url, /^wss:\/\/lark\.ws\.test\//);
  h.last().push(eventFrame(receive({ text: 'hi from Lark' })));
  await flush();
  assert.equal(h.messages[0].source, 'Lark');
  assert.deepEqual(links({ values: { appId: LARK_APP } }), { link: `https://applink.larksuite.com/client/bot/open?appId=${LARK_APP}` });
  await h.c.stop();
});

test('a wrong App Secret is fatal with hint "secret"; no connection, and the secret never shows', async () => {
  const h = harness({ secret: 'not-the-right-secret-value' });
  const err = await h.c.start().catch((e) => e);
  assert.equal(err.fatal, true);
  assert.match(err.message, /Feishu rejected the App Secret/);
  assert.deepEqual(h.statuses.at(-1), { state: 'error', detail: err.message, fatal: true, hint: 'secret' });
  assert.equal(h.sockets.length, 0);
  assert.equal(h.platform.of('POST', '/callback/ws/endpoint').length, 0);
  assert.equal(JSON.stringify([h.statuses, h.logs, err.message]).includes('not-the-right-secret-value'), false);
});

test('an App ID neither platform knows is fatal with hint "appId"; a malformed one fails before any request', async () => {
  const h = harness({ platform: fakePlatform({ apps: { feishu: {}, lark: {} } }) });
  const err = await h.c.start().catch((e) => e);
  assert.equal(err.fatal, true);
  assert.match(err.message, /Neither Feishu nor Lark knows this App ID/);
  assert.equal(h.statuses.at(-1).hint, 'appId');

  const bad = harness({ appId: SECRET });
  const e2 = await bad.c.start().catch((e) => e);
  assert.equal(e2.fatal, true);
  assert.equal(bad.statuses.at(-1).hint, 'appId');
  assert.equal(bad.platform.calls.length, 0);
  assertNoSecrets(bad, e2);

  // a disabled app
  const off = harness({ platform: fakePlatform({ routes: { 'POST /open-apis/auth/v3/tenant_access_token/internal': () => reply(200, { code: 10014, msg: 'app unauthorized' }) } }) });
  const e3 = await off.c.start().catch((e) => e);
  assert.equal(off.statuses.at(-1).hint, 'disabled');
  assert.equal(e3.fatal, true);
});

test('network errors at sign-in back off and retry; the error never carries the secret', async () => {
  let downs = 2;
  const platform = fakePlatform({
    routes: {
      'POST /open-apis/auth/v3/tenant_access_token/internal': () => {
        if (downs-- > 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        return null;
      },
    },
  });
  const h = harness({ platform });
  const started = h.c.start();
  await flush();
  assert.match(h.statuses.at(-1).detail, /could not reach Feishu \(\/open-apis\/auth\/v3\/tenant_access_token\/internal: ECONNREFUSED\); retrying in 1 s/);
  assert.equal(h.statuses.at(-1).fatal, undefined);
  await h.clock.tick(1000);
  assert.match(h.statuses.at(-1).detail, /retrying in 2 s/);
  await h.clock.tick(2000);
  h.last().open();
  await flush();
  assert.equal((await started).id, APP_ID);
  assertNoSecrets(h);
  await h.c.stop();
});

test('the bot capability is off: hint "bot" while the connection stays up, then it connects by itself', async () => {
  let enabled = false;
  const platform = fakePlatform({ routes: { 'GET /open-apis/bot/v3/info': () => (enabled ? null : reply(400, { code: 10003, msg: 'bot not found' })) } });
  const h = harness({ platform });
  let done = false;
  const started = h.c.start().then((me) => ((done = true), me));
  await flush();
  h.last().open();
  await flush();
  assert.equal(done, false);
  assert.equal(h.statuses.at(-1).state, 'error');
  assert.equal(h.statuses.at(-1).hint, 'bot');
  assert.notEqual(h.statuses.at(-1).fatal, true);
  assert.equal(h.last().pings().length, 1, 'the long connection is online, so the console can save long-connection mode');
  await h.clock.tick(15_000);
  assert.equal(platform.of('GET', '/open-apis/bot/v3/info').length, 2);
  enabled = true;
  await h.clock.tick(15_000);
  assert.equal((await started).name, 'Acme Team');
  assert.equal(h.statuses.at(-1).state, 'connected');
  await h.c.stop();
});

// --- events ---------------------------------------------------------------------------

test('events: acked at once with the same frame, names looked up, duplicates dropped, other events ignored', async () => {
  const h = harness();
  await online(h);
  const frame = eventFrame(receive({ text: 'hello', id: 'om_a', time: 1_700_000_000_500 }));
  h.last().push(frame);
  await flush();
  const ack = h.last().acks()[0];
  assert.equal(ack.SeqID, frame.SeqID);
  assert.equal(ack.LogID, frame.LogID, 'a LogID above 2^53 comes back exactly');
  assert.equal(ack.service, 77);
  assert.deepEqual(ack.headers.slice(0, 5), frame.headers);
  assert.equal(ack.headers[5].key, 'biz_rt');
  assert.deepEqual(JSON.parse(dec.decode(ack.payload)), { code: 200 });
  assert.deepEqual(h.messages[0], { chatId: 'oc_dm_kada', messageId: 'om_a', order: '1700000000500', userId: KADA, text: 'hello', isDirect: true, mentioned: true, userName: 'Kada Liao' });
  // Feishu pushes the same message again: acked, not delivered twice
  h.last().push(eventFrame(receive({ text: 'hello', id: 'om_a', time: 1_700_000_000_500 })));
  await flush();
  assert.equal(h.last().acks().length, 2);
  assert.equal(h.messages.length, 1);
  // the name is cached
  h.last().push(eventFrame(receive({ text: 'again' })));
  await flush();
  assert.equal(h.platform.of('GET', /^\/open-apis\/contact\/v3\/users\//).length, 1);
  assert.equal(h.messages[1].userName, 'Kada Liao');
  // other events and unreadable payloads are acked and dropped
  h.last().push(eventFrame({ schema: '2.0', header: { event_type: 'im.chat.member.bot.added_v1' }, event: {} }));
  h.last().push({ ...eventFrame({}), payload: enc.encode('{not json') });
  await flush();
  assert.equal(h.last().acks().length, 5);
  assert.equal(h.messages.length, 2);
  await h.c.stop();
});

test('events split over frames are merged, then acked once', async () => {
  const h = harness();
  await online(h);
  const whole = enc.encode(JSON.stringify(receive({ text: 'a long message '.repeat(20).trim() })));
  const cut = 100;
  const one = eventFrame({}, { sum: 2, seqNo: 0, msgId: 'big' });
  const two = eventFrame({}, { sum: 2, seqNo: 1, msgId: 'big' });
  h.last().push({ ...two, payload: whole.slice(cut) });
  await flush();
  assert.equal(h.last().acks().length, 0, 'not acked until complete');
  h.last().push({ ...one, payload: whole.slice(0, cut) });
  await flush();
  assert.equal(h.last().acks().length, 1);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].text, /^a long message a long message/);
  // bad numbering is dropped
  h.last().push(eventFrame({}, { sum: 2, seqNo: 5, msgId: 'bad' }));
  await flush();
  assert.equal(h.last().acks().length, 1);
  await h.c.stop();
});

test('groups: mentions decide, the group name is looked up; no contact permission falls back to a short id, asked once', async () => {
  const platform = fakePlatform({ routes: { 'GET /open-apis/contact/v3/users/*': () => reply(400, { code: 99991672, msg: 'Access denied. One of the following scopes is required: [contact:user.base:readonly]' }) } });
  const h = harness({ platform });
  await online(h);
  h.last().push(eventFrame(receive({ chatId: 'oc_grp', chatType: 'group', text: '@_user_1 ship it', mentions: [mention(1, BOT, 'Acme Team', 'bot')] })));
  h.last().push(eventFrame(receive({ chatId: 'oc_grp', chatType: 'group', text: '@_user_1 hi May', mentions: [mention(1, MAY, 'May')] })));
  await flush(30);
  assert.deepEqual(
    h.messages.map((m) => [m.text, m.mentioned, m.chatTitle, m.userName]),
    [
      ['ship it', true, 'Launch room', `user ${KADA.slice(-6)}`],
      ['@May hi May', false, 'Launch room', `user ${KADA.slice(-6)}`],
    ],
  );
  assert.equal(platform.of('GET', /^\/open-apis\/contact\/v3\/users\//).length, 1, 'a missing permission stops the look-ups');
  assert.equal(platform.of('GET', /^\/open-apis\/im\/v1\/chats\//).length, 1, 'the group name is cached');
  assert.equal(h.logs.filter((l) => /contact:user\.base:readonly/.test(l)).length, 1);
  await h.c.stop();
});

test('a slow name lookup does not hold messages up, and messages keep their order', async () => {
  let release;
  const platform = fakePlatform({ routes: { 'GET /open-apis/contact/v3/users/*': () => new Promise((r) => (release = r)).then(() => null) } });
  const h = harness({ platform });
  await online(h);
  h.last().push(eventFrame(receive({ text: 'first' })));
  h.last().push(eventFrame(receive({ text: 'second' })));
  await flush();
  assert.equal(h.messages.length, 0);
  await h.clock.tick(4000);
  assert.deepEqual(h.messages.map((m) => [m.text, m.userName]), [['first', `user ${KADA.slice(-6)}`], ['second', `user ${KADA.slice(-6)}`]]);
  release();
  await flush();
  h.last().push(eventFrame(receive({ text: 'third' })));
  await flush();
  assert.equal(h.messages[2].userName, 'Kada Liao', 'the late answer is used next time');
  await h.c.stop();
});

// --- sending --------------------------------------------------------------------------

const sends = (p) => p.calls.filter((c) => c.method === 'POST' && /^\/open-apis\/im\/v1\/messages(\/[^/]+\/reply)?$/.test(c.path));
const mdOf = (call) => JSON.parse(call.body.content).zh_cn.content[0][0];

test('send: Markdown as a post md element, replies answer the message, long text splits, mentions defused', async () => {
  const h = harness();
  await online(h);
  await h.c.send('oc_dm_kada', '**Done.** See <at user_id="all"></at> and ![chart](https://x.test/c.png)');
  const [first] = sends(h.platform);
  assert.equal(first.path, '/open-apis/im/v1/messages');
  assert.equal(first.search, '?receive_id_type=chat_id');
  assert.equal(first.body.receive_id, 'oc_dm_kada');
  assert.equal(first.body.msg_type, 'post');
  assert.match(first.body.uuid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(mdOf(first), { tag: 'md', text: '**Done.** See <​at user_id="all"></​at> and [chart](https://x.test/c.png)' });

  await h.c.send('oc_grp', `${'a'.repeat(3990)}\n\n${'b'.repeat(3990)}`, { replyTo: 'om_in7' });
  const [r1, r2] = sends(h.platform).slice(1);
  assert.equal(r1.path, '/open-apis/im/v1/messages/om_in7/reply');
  assert.equal(mdOf(r1).text.length, 3990);
  assert.equal(r2.path, '/open-apis/im/v1/messages', 'only the first part answers');
  assert.equal(r2.body.receive_id, 'oc_grp');

  await h.c.stop();
});

test('in a group, a reply to a message the bot sent addresses it without an @', async () => {
  const platform = fakePlatform({ routes: { 'POST /open-apis/im/v1/messages': () => reply(200, { code: 0, data: { message_id: 'om_bot_question' } }) } });
  const h = harness({ platform });
  await online(h);
  await h.c.send('oc_grp', 'Which date?');
  h.last().push(eventFrame(receive({ chatId: 'oc_grp', chatType: 'group', text: 'Friday', parent: 'om_bot_question' })));
  h.last().push(eventFrame(receive({ chatId: 'oc_grp', chatType: 'group', text: 'unrelated', parent: 'om_someone_else' })));
  await flush(30);
  assert.deepEqual(h.messages.map((m) => [m.text, m.mentioned]), [['Friday', true], ['unrelated', false]]);
  await h.c.stop();
});

test('send: a recalled message is answered in the chat; a post Feishu refuses goes as plain text; rate limits wait', async () => {
  let limited = 1;
  const platform = fakePlatform({
    routes: {
      'POST /open-apis/im/v1/messages/om_gone/reply': () => reply(400, { code: 230011, msg: 'The message is recalled.' }),
      'POST /open-apis/im/v1/messages': (call) => {
        if (call.body.receive_id === 'oc_rate' && limited-- > 0) return reply(400, { code: 99991400, msg: 'request trigger frequency limit' }, { 'x-ogw-ratelimit-reset': '2' });
        if (call.body.msg_type === 'post' && /BROKEN/.test(call.body.content)) return reply(400, { code: 230001, msg: 'invalid post' });
        return null;
      },
    },
  });
  const h = harness({ platform });
  await online(h);
  await h.c.send('oc_grp', 'answer', { replyTo: 'om_gone' });
  assert.deepEqual(sends(platform).map((c) => c.path), ['/open-apis/im/v1/messages/om_gone/reply', '/open-apis/im/v1/messages']);
  await h.c.send('oc_grp', '# BROKEN **table**');
  const [post, text] = sends(platform).slice(2);
  assert.equal(post.body.msg_type, 'post');
  assert.deepEqual([text.body.msg_type, JSON.parse(text.body.content).text], ['text', 'BROKEN table']);
  const sending = h.c.send('oc_rate', 'later');
  await flush();
  assert.ok(h.clock.delays().includes(2000), 'waits the reset Feishu gave');
  await h.clock.tick(2000);
  await sending;
  const rated = sends(platform).filter((c) => c.body.receive_id === 'oc_rate');
  assert.equal(rated.length, 2);
  assert.equal(rated[0].body.uuid, rated[1].body.uuid, 'a retry keeps its uuid, so Feishu sends it once');
  await h.c.stop();
});

test('threads: messages carry the root; send with threadId answers the root with every part, replyTo first', async () => {
  const platform = fakePlatform({
    routes: {
      'POST /open-apis/im/v1/messages/om_recalled/reply': () => reply(400, { code: 230011, msg: 'The message is recalled.' }),
      'POST /open-apis/im/v1/messages/om_root_gone/reply': () => reply(400, { code: 231003, msg: 'The message is not found.' }),
    },
  });
  const h = harness({ platform });
  await online(h);
  const at = [mention(1, BOT, 'Acme Team', 'bot')];
  h.last().push(eventFrame(receive({ chatId: 'oc_grp', chatType: 'group', text: '@_user_1 in the topic', mentions: at, id: 'om_t3', root: 'om_root', parent: 'om_root', thread: 'omt_9' })));
  h.last().push(eventFrame(receive({ chatId: 'oc_grp', chatType: 'group', text: '@_user_1 top level', mentions: at, id: 'om_top' })));
  await flush(30);
  assert.deepEqual(h.messages.map((m) => [m.messageId, m.threadId]), [['om_t3', 'om_root'], ['om_top', undefined]]);

  const long = `${'a'.repeat(3990)}\n\n${'b'.repeat(3990)}\n\n${'c'.repeat(100)}`;
  const paths = (from) => sends(platform).slice(from).map((c) => c.path);
  let n = sends(platform).length;
  await h.c.send('oc_grp', long, { threadId: 'om_root' });
  assert.deepEqual(paths(n), Array(3).fill('/open-apis/im/v1/messages/om_root/reply'), 'every part in the topic');
  assert.ok(sends(platform).slice(n).every((c) => c.body.reply_in_thread === undefined), 'the root decides: a topic stays a topic, a chain a chain');

  n = sends(platform).length;
  await h.c.send('oc_grp', long, { threadId: 'om_root', replyTo: 'om_t3' });
  assert.deepEqual(paths(n), ['/open-apis/im/v1/messages/om_t3/reply', '/open-apis/im/v1/messages/om_root/reply', '/open-apis/im/v1/messages/om_root/reply']);

  n = sends(platform).length;
  await h.c.send('oc_grp', 'answer', { threadId: 'om_root', replyTo: 'om_recalled' });
  assert.deepEqual(paths(n), ['/open-apis/im/v1/messages/om_recalled/reply', '/open-apis/im/v1/messages/om_root/reply'], 'a recalled replyTo: the root');

  n = sends(platform).length;
  await h.c.send('oc_grp', long, { threadId: 'om_root_gone' });
  assert.deepEqual(paths(n), ['/open-apis/im/v1/messages/om_root_gone/reply', '/open-apis/im/v1/messages', '/open-apis/im/v1/messages', '/open-apis/im/v1/messages'], 'a root that is gone: the chat, asked once');
  assert.equal(sends(platform).at(-1).body.receive_id, 'oc_grp');
  await h.c.stop();
});

test('send without the permission to send: hint "scopes" until a send works again', async () => {
  let allowed = false;
  const platform = fakePlatform({ routes: { 'POST /open-apis/im/v1/messages': () => (allowed ? null : reply(400, { code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:message:send_as_bot]' })) } });
  const h = harness({ platform });
  await online(h);
  await assert.rejects(h.c.send('oc_dm_kada', 'hi'), /99991672/);
  assert.equal(h.statuses.at(-1).state, 'error');
  assert.equal(h.statuses.at(-1).hint, 'scopes');
  assert.match(h.statuses.at(-1).detail, /im:message:send_as_bot/);
  allowed = true;
  await h.c.send('oc_dm_kada', 'hi');
  assert.equal(h.statuses.at(-1).state, 'connected');
  await h.c.stop();
});

test('the tenant token is cached, renewed before expiry, and renewed once when Feishu rejects it', async () => {
  let reject = 0;
  const platform = fakePlatform({ routes: { 'POST /open-apis/im/v1/messages': () => (reject-- > 0 ? reply(400, { code: 99991663, msg: 'Invalid access token for authorization.' }) : null) } });
  const h = harness({ platform });
  await online(h);
  const tokenCount = () => platform.of('POST', '/open-apis/auth/v3/tenant_access_token/internal').length;
  const before = tokenCount();
  await h.c.send('oc_dm_kada', 'one');
  await h.c.send('oc_dm_kada', 'two');
  assert.equal(tokenCount(), before, 'cached');
  await h.clock.tick(101 * 60_000);
  await h.c.send('oc_dm_kada', 'three');
  assert.equal(tokenCount(), before + 1, 'renewed 20 minutes before the 2 h expiry');
  reject = 1;
  await h.c.send('oc_dm_kada', 'four');
  assert.equal(tokenCount(), before + 2, 'a rejected token is renewed and the call retried');
  assert.equal(sends(platform).filter((c) => JSON.parse(c.body.content).zh_cn.content[0][0].text === 'four').length, 2);
  await h.c.stop();
});

test('typing: a "Typing" reaction on the person\'s message, once; gone after the reply or when the work stops', async () => {
  const h = harness();
  await online(h);
  h.last().push(eventFrame(receive({ text: 'plan it', id: 'om_task' })));
  await flush();
  await h.c.typing('oc_dm_kada');
  await h.c.typing('oc_dm_kada');
  const adds = h.platform.of('POST', '/open-apis/im/v1/messages/om_task/reactions');
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].body, { reaction_type: { emoji_type: 'Typing' } });
  await h.c.send('oc_dm_kada', 'Here is the plan.');
  await flush();
  assert.equal(h.platform.of('DELETE', /^\/open-apis\/im\/v1\/messages\/om_task\/reactions\/react\d+$/).length, 1);
  await h.c.typing('oc_dm_kada');
  assert.equal(h.platform.of('POST', /\/reactions$/).length, 1, 'not again for the same message');
  // a new message; the work stops without a reply: the reaction goes after 15 s of silence
  h.last().push(eventFrame(receive({ text: 'and this', id: 'om_task2' })));
  await flush();
  await h.c.typing('oc_dm_kada');
  await h.clock.tick(10_000);
  await h.c.typing('oc_dm_kada');
  await h.clock.tick(14_000);
  assert.equal(h.platform.of('DELETE', /om_task2\/reactions\//).length, 0, 'still working');
  await h.clock.tick(1000);
  assert.equal(h.platform.of('DELETE', /om_task2\/reactions\//).length, 1);
  // no chat message to react to: nothing
  await h.c.typing('oc_other');
  assert.equal(h.platform.of('POST', /\/reactions$/).length, 2);
  await h.c.stop();
});

test('typing without the reaction permission stops trying; stop removes a reaction still showing', async () => {
  const platform = fakePlatform({ routes: { 'POST /open-apis/im/v1/messages/om_x/reactions': () => reply(400, { code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:message.reactions:write_only]' }) } });
  const h = harness({ platform });
  await online(h);
  h.last().push(eventFrame(receive({ text: 'a', id: 'om_x' })));
  await flush();
  await h.c.typing('oc_dm_kada');
  h.last().push(eventFrame(receive({ text: 'b', id: 'om_y', chatId: 'oc_dm_may', from: MAY })));
  await flush();
  await h.c.typing('oc_dm_may');
  assert.equal(platform.of('POST', /\/reactions$/).length, 1);
  assert.ok(h.logs.some((l) => /im:message\.reactions:write_only/.test(l)));

  const h2 = harness();
  await online(h2);
  h2.last().push(eventFrame(receive({ text: 'a', id: 'om_z' })));
  await flush();
  await h2.c.typing('oc_dm_kada');
  await h2.c.stop();
  assert.equal(h2.platform.of('DELETE', /om_z\/reactions\//).length, 1);
  await h.c.stop();
});

// --- the connection over time ---------------------------------------------------------

test('a dropped connection reconnects with backoff on a fresh endpoint; an unanswered ping counts as dropped', async () => {
  const h = harness();
  await online(h);
  h.last().drop(1006);
  await flush();
  assert.equal(h.statuses.at(-1).state, 'connecting', 'the first drop reads as reconnecting');
  assert.match(h.statuses.at(-1).detail, /Feishu closed the connection \(1006\); reconnecting in 1 s/);
  await h.clock.tick(1000);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.platform.of('POST', '/callback/ws/endpoint').length, 2);
  h.last().drop(1006);
  await flush();
  assert.equal(h.statuses.at(-1).state, 'error', 'repeated failures read as an error');
  assert.match(h.statuses.at(-1).detail, /reconnecting in 2 s/);
  await h.clock.tick(2000);
  h.last().autoPong = false;
  h.last().open();
  await flush();
  assert.equal(h.statuses.at(-1).state, 'connected');
  // no frame at all for 30 s after a ping: dead connection
  await h.clock.tick(30_000);
  assert.match(h.statuses.at(-1).detail, /did not answer a ping within 30 s/);
  assert.equal(h.sockets[2].closedWith, 1000);
  await h.clock.tick(1000);
  assert.equal(h.sockets.length, 4);
  assertNoSecrets(h);
  await h.c.stop();
  await h.clock.tick(120_000);
  assert.equal(h.sockets.length, 4, 'nothing reconnects after stop');
});

test('too many connections waits a minute (hint "connlimit"); rejected credentials after start are fatal', async () => {
  let mode = 'ok';
  const platform = fakePlatform({
    routes: {
      'POST /callback/ws/endpoint': () =>
        mode === 'limit' ? reply(200, { code: 1000040350, msg: 'exceed connection limit', data: { URL: '' } }) : mode === 'bad' ? reply(200, { code: 1000040345, msg: 'app_id or app_secret is invalid', data: { URL: '' } }) : null,
    },
  });
  const h = harness({ platform });
  await online(h);
  mode = 'limit';
  h.last().drop(1006);
  await flush();
  await h.clock.tick(1000);
  assert.equal(h.statuses.at(-1).hint, 'connlimit');
  assert.match(h.statuses.at(-1).detail, /reconnecting in 60 s/);
  mode = 'bad';
  await h.clock.tick(60_000);
  assert.deepEqual([h.statuses.at(-1).state, h.statuses.at(-1).fatal, h.statuses.at(-1).hint], ['error', true, 'secret']);
  const n = h.sockets.length;
  await h.clock.tick(300_000);
  assert.equal(h.sockets.length, n, 'no reconnects after a fatal error');
  await assert.rejects(h.c.send('oc_dm_kada', 'x'), /stopped/);
  assertNoSecrets(h);
  await h.c.stop();
});

test('stop while connecting rejects the start; a socket that never opens is retried', async () => {
  const h = harness();
  const started = h.c.start();
  await flush();
  await h.clock.tick(20_000);
  assert.match(h.statuses.at(-1).detail, /did not open within 20 s/);
  await h.clock.tick(1000);
  assert.equal(h.sockets.length, 2);
  await h.c.stop();
  await assert.rejects(started, /stopped/);
});

test('BOTS_FEISHU_API sets the base, and with no Lark base nothing goes to Lark', async () => {
  const platform = fakePlatform();
  const before = { f: process.env.BOTS_FEISHU_API, l: process.env.BOTS_LARK_API };
  process.env.BOTS_FEISHU_API = `${FEISHU}/`;
  delete process.env.BOTS_LARK_API;
  try {
    const clock = fakeClock();
    let sock;
    const c = createConnector({
      token: SECRET,
      values: { appId: APP_ID, appSecret: SECRET },
      onMessage() {},
      fetchImpl: platform.fetchImpl,
      WebSocketImpl: class {
        constructor() {
          sock = this;
          this.l = {};
        }
        addEventListener(t, fn) {
          this.l[t] = fn;
        }
        send() {}
        close() {}
      },
      setTimeoutImpl: clock.setTimeout,
      clearTimeoutImpl: clock.clearTimeout,
    });
    const started = c.start();
    await flush();
    sock.l.open();
    await started;
    const tokenCalls = platform.of('POST', '/open-apis/auth/v3/tenant_access_token/internal');
    assert.equal(tokenCalls.length, 1, 'no probe: there is no other platform to tell apart');
    assert.ok(platform.calls.every((x) => x.base === 'feishu'));
    await c.stop();
  } finally {
    for (const [k, v] of [['BOTS_FEISHU_API', before.f], ['BOTS_LARK_API', before.l]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// --- with the channel hub ---------------------------------------------------------------

test('with the hub: pairing in a DM, a stranger ignored, Markdown replies, a group answered in place, no replays', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'bots-feishu-')), 'channels.json');
  const platform = fakePlatform();
  const kit = socketKit();
  const entries = catalog();
  const roster = [
    { id: 'atlas', handle: 'atlas', name: 'Atlas', role: 'primary', persona: '', apps: [{ id: 'fs', template: 'feishu-chat', serverName: 'feishu-chat', enabled: true, values: { appId: APP_ID, appSecret: SECRET } }] },
    { id: 'forge', handle: 'forge', name: 'Forge', role: 'bot', persona: '', apps: [] },
  ];
  const delivered = [];
  const logs = [];
  const loadConnector = async () => ({
    ...feishu,
    createConnector: (o) => feishu.createConnector({ ...o, fetchImpl: platform.fetchImpl, WebSocketImpl: kit.FakeSocket, apiBase: FEISHU, larkApiBase: LARK }),
  });
  const deps = {
    file,
    bots: () => roster,
    entries: () => entries,
    deliver: async (bot, msg) => {
      delivered.push({ bot: bot.id, ...msg });
      return `session-${bot.id}`;
    },
    running: () => false,
    loadConnector,
    log: (line) => logs.push(line),
    typingEveryMs: 60_000,
  };
  const hub = createChannels(deps);
  hub.sync();
  await flush();
  kit.sockets.at(-1).open();
  await flush(20);
  const view = hub.view(roster[0]).fs;
  assert.equal(view.state, 'connected');
  assert.deepEqual(view.account, { username: 'Acme Team', name: 'Acme Team' });
  assert.equal(view.link, `https://applink.feishu.cn/client/bot/open?appId=${APP_ID}`);
  const code = view.code.code;
  const ws = kit.sockets.at(-1);
  const sentTo = (chat) => sends(platform).filter((c) => c.body.receive_id === chat || c.path.includes('/reply')).map((c) => ({ path: c.path, chat: c.body.receive_id, type: c.body.msg_type, text: c.body.msg_type === 'post' ? mdOf(c).text : JSON.parse(c.body.content).text }));

  // a stranger is told once that the bot is private
  ws.push(eventFrame(receive({ chatId: 'oc_dm_may', from: MAY, text: 'hi there' })));
  ws.push(eventFrame(receive({ chatId: 'oc_dm_may', from: MAY, text: 'hello?' })));
  await flush(30);
  assert.deepEqual(sentTo('oc_dm_may').map((m) => m.text), [PRIVATE_TEXT]);
  assert.equal(delivered.length, 0);

  // Kada sends the code from a DM
  ws.push(eventFrame(receive({ text: code.toLowerCase() })));
  await flush(30);
  assert.match(sentTo('oc_dm_kada')[0].text, /^Paired\. What you send here goes to Atlas \(@atlas\)/);
  assert.deepEqual(hub.view(roster[0]).fs.paired.map((p) => [p.name, p.direct]), [['Kada Liao', true]]);

  // a DM: delivered with its header, "Typing" shows, the reply goes out as Markdown and clears it
  ws.push(eventFrame(receive({ text: 'plan the launch', id: 'om_plan', time: 1_800_000_000_000 })));
  await flush(30);
  assert.deepEqual(delivered.at(-1), { bot: 'atlas', header: '[Feishu · Kada Liao]', body: 'plan the launch' });
  assert.equal(platform.of('POST', '/open-apis/im/v1/messages/om_plan/reactions').length, 1);
  hub.noteUserMessage('session-atlas', roster[0], 'user', '[Feishu · Kada Liao]\nplan the launch');
  hub.noteReply('session-atlas', '## Plan\n\n- **Forge** builds it');
  await flush(30);
  assert.deepEqual(sentTo('oc_dm_kada').at(-1), { path: '/open-apis/im/v1/messages', chat: 'oc_dm_kada', type: 'post', text: '## Plan\n\n- **Forge** builds it' });
  assert.equal(platform.of('DELETE', /om_plan\/reactions\//).length, 1);
  // That turn is over: the next one answers its own chat (0.8 keeps a turn's chats until it ends).
  hub.noteTurnEnd('session-atlas');

  // a group: only when the bot is @-mentioned, and the reply answers that message
  ws.push(eventFrame(receive({ chatId: 'oc_grp', chatType: 'group', text: 'talking among ourselves' })));
  ws.push(eventFrame(receive({ chatId: 'oc_grp', chatType: 'group', text: '@_user_1 status?', id: 'om_grp_q', mentions: [mention(1, BOT, 'Acme Team', 'bot')], time: 1_800_000_000_100 })));
  await flush(30);
  assert.deepEqual(delivered.at(-1), { bot: 'atlas', header: '[Feishu · Kada Liao · Launch room]', body: 'status?' });
  hub.noteUserMessage('session-atlas', roster[0], 'user', '[Feishu · Kada Liao · Launch room]\nstatus?');
  hub.noteReply('session-atlas', 'On track.');
  await flush(30);
  assert.deepEqual(sentTo('oc_grp').at(-1), { path: '/open-apis/im/v1/messages/om_grp_q/reply', chat: undefined, type: 'post', text: 'On track.' });

  // Feishu pushes the DM again, now and after a restart: it is not handled twice
  const count = delivered.length;
  ws.push(eventFrame(receive({ text: 'plan the launch', id: 'om_plan', time: 1_800_000_000_000 })));
  await flush(30);
  await hub.stopAll();
  const again = createChannels({ ...deps });
  again.sync();
  await flush();
  kit.sockets.at(-1).open();
  await flush(20);
  kit.sockets.at(-1).push(eventFrame(receive({ text: 'plan the launch', id: 'om_plan', time: 1_800_000_000_000 })));
  kit.sockets.at(-1).push(eventFrame(receive({ text: 'and the budget', time: 1_800_000_000_200 })));
  await flush(30);
  assert.deepEqual(delivered.slice(count).map((d) => d.body), ['and the budget']);
  await again.stopAll();

  const everything = JSON.stringify([logs, hub.view(roster[0]), again.view(roster[0])]);
  assert.equal(everything.includes(SECRET), false);
  assert.equal(everything.includes(TICKET), false);
});
