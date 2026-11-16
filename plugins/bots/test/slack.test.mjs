import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as slack from '../lib/channels/slack.mjs';
import { PRIVATE_TEXT, createChannels } from '../lib/channels.mjs';
import { catalog } from '../lib/apps.mjs';

const { kind, TEXT_LIMIT, MARKDOWN, BOT_SCOPES, BOT_EVENTS, createConnector, normalizeEvent, fromSlack, orderOf, missingScopes, tokenProblem, defuse, fallbackText, links, appManifest } = slack;

const BOT = 'xox' + 'b-1111111111-2222222222-SeCrEtBoTtOkEnVaLuE';
const APP = 'xap' + 'p-1-A0APPID001-3333333333-deadbeefsecretappvalue0123';
const SCOPES = 'app_mentions:read,channels:read,chat:write,groups:read,im:history,users:read';
const AUTH = { ok: true, url: 'https://acme.slack.com/', team: 'Acme', user: 'atlas_team', team_id: 'T0TEAM', user_id: 'U0BOT', bot_id: 'B0BOT' };
const USERS = {
  U0BOT: { id: 'U0BOT', name: 'atlas_team', is_bot: true, profile: { display_name: '', real_name: 'Atlas Team' } },
  U0KADA: { id: 'U0KADA', name: 'kada', real_name: 'Kada Liao', profile: { display_name: 'Kada', real_name: 'Kada Liao' } },
  U0BOB: { id: 'U0BOB', name: 'bob', profile: { display_name: '', real_name: 'Bob Stone' } },
};
const CHANNELS = { C0LAUNCH: { id: 'C0LAUNCH', name: 'launch', is_channel: true } };
const HELLO = { type: 'hello', num_connections: 1, debug_info: { host: 'applink-1', approximate_connection_time: 18060 }, connection_info: { app_id: 'A0APPID001' } };

const flush = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};
const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: async () => (body == null ? '' : JSON.stringify(body)),
});
const ok = (body, headers = {}) => reply(200, { ok: true, ...body }, { 'x-oauth-scopes': SCOPES, ...headers });
const err = (error, extra = {}, headers = {}) => reply(200, { ok: false, error, ...extra }, headers);

/** Timers that only move when the test says so. */
function fakeClock() {
  let now = 0;
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
    get size() {
      return timers.size;
    },
    delays() {
      return [...timers.values()].map((v) => v.at - now).sort((a, b) => a - b);
    },
  };
}

function fakePings() {
  const subs = new Set();
  return {
    subs,
    subscribe: (fn) => subs.add(fn),
    unsubscribe: (fn) => subs.delete(fn),
    ping: (websocket) => {
      for (const fn of [...subs]) fn({ websocket, payload: Buffer.from('ping') });
    },
  };
}

function harness({ fetch, values, ...opts } = {}) {
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
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type, ev) {
      for (const fn of this.listeners[type] ?? []) fn(ev);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close(code = 1000) {
      if (this.closedWith !== null) return;
      this.closedWith = code;
      this.emit('close', { code, reason: '' });
    }
    /** A frame from Slack. */
    push(frame) {
      this.emit('message', { data: JSON.stringify(frame) });
    }
    /** Slack (or the network) closes the socket. */
    drop(code = 1006, reason = '') {
      this.closedWith = code;
      this.emit('close', { code, reason });
    }
    get acks() {
      return this.sent.map((f) => f.envelope_id);
    }
  }
  const calls = [];
  let tickets = 0;
  const fetchImpl = async (url, init = {}) => {
    const method = String(url).split('/').pop();
    const params = Object.fromEntries(new URLSearchParams(init.body ?? ''));
    const call = { url: String(url), method, auth: init.headers?.Authorization, params };
    calls.push(call);
    const custom = fetch ? await fetch(call, calls) : undefined;
    if (custom) return custom;
    switch (method) {
      case 'auth.test':
        return ok(AUTH);
      case 'apps.connections.open':
        tickets += 1;
        return reply(200, { ok: true, url: `wss://wss.test/link/?ticket=tk-${tickets}-secret&app_id=A0APPID001` });
      case 'users.info':
        return USERS[params.user] ? ok({ user: USERS[params.user] }) : err('user_not_found');
      case 'conversations.info':
        return CHANNELS[params.channel] ? ok({ channel: CHANNELS[params.channel] }) : err('channel_not_found');
      case 'chat.postMessage':
        return ok({ channel: params.channel, ts: `1800000000.${String(calls.length).padStart(6, '0')}` });
      case 'assistant.threads.setStatus':
        return ok({});
      default:
        return err('unknown_method');
    }
  };
  const h = { clock, sockets, calls, statuses: [], messages: [], logs: [], errors: [] };
  const fakes = {
    fetchImpl,
    WebSocketImpl: FakeSocket,
    apiBase: 'https://slack.test/api',
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    now: clock.now,
    random: () => 0.5,
    pingChannel: null,
  };
  h.c = createConnector({
    token: BOT,
    values: values ?? { token: BOT, appToken: APP },
    onMessage: (m) => h.messages.push(m),
    onStatus: (s) => h.statuses.push(s),
    log: (line) => h.logs.push(line),
    ...fakes,
    ...opts,
  });
  /** A connector made by someone else (the hub) on the same fakes. */
  h.wrap = (o) => createConnector({ ...o, ...fakes, log: (line) => (h.logs.push(line), o.log?.(line)) });
  h.last = () => sockets.at(-1);
  h.states = () => h.statuses.map((s) => s.state);
  h.of = (method) => calls.filter((c) => c.method === method);
  return h;
}

/** Start and say hello on the first socket. */
async function online(h, hello = HELLO) {
  const started = h.c.start();
  await flush();
  const ws = h.last();
  assert.ok(ws, 'a socket was opened');
  ws.push(hello);
  return { me: await started, ws };
}

let envelopeN = 0;
/** An events_api envelope around `event`. */
const env = (event, extra = {}) => ({ envelope_id: `env-${(envelopeN += 1)}`, type: 'events_api', accepts_response_payload: false, retry_attempt: 0, payload: { type: 'event_callback', team_id: 'T0TEAM', event_id: `Ev${envelopeN}`, event, ...extra } });
const dm = (text, extra = {}) => ({ type: 'message', channel: 'D0KADA', channel_type: 'im', user: 'U0KADA', text, ts: '1700000001.000100', ...extra });
const mention = (text, extra = {}) => ({ type: 'app_mention', channel: 'C0LAUNCH', user: 'U0KADA', text, ts: '1700000002.000200', ...extra });

/** Nothing the connector reported or threw carries a token or a connection ticket. */
function assertNoSecret(h, ...extra) {
  const seen = JSON.stringify([h.statuses, h.logs, h.errors.map((e) => e?.message), ...extra]);
  for (const s of [BOT, APP, 'SeCrEtBoTtOkEnVaLuE', 'deadbeefsecretappvalue', '-secret&']) assert.equal(seen.includes(s), false, `secret leaked: ${s}`);
}

// --- pure helpers ---------------------------------------------------------------------------

test('the module implements the channel contract', () => {
  assert.equal(kind, 'slack');
  assert.equal(MARKDOWN, true);
  assert.ok(TEXT_LIMIT >= 12_000);
  const c = createConnector({ token: BOT, values: { token: BOT, appToken: APP }, onMessage() {} });
  for (const fn of ['start', 'stop', 'send', 'typing']) assert.equal(typeof c[fn], 'function');
});

test('the manifest turns on Socket Mode and DMs, with exactly the scopes and events the connector uses', () => {
  const m = appManifest({ name: 'Atlas' });
  assert.equal(m.display_information.name, 'Atlas');
  assert.equal(m.settings.socket_mode_enabled, true);
  assert.equal(m.settings.token_rotation_enabled, false);
  assert.equal(m.settings.event_subscriptions.request_url, undefined, 'no public URL');
  assert.deepEqual(m.settings.event_subscriptions.bot_events, ['app_mention', 'message.im']);
  assert.deepEqual(m.features.app_home, { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false });
  assert.equal(m.features.bot_user.display_name, 'Atlas');
  assert.deepEqual(m.oauth_config.scopes.bot, BOT_SCOPES);
  for (const s of ['app_mentions:read', 'chat:write', 'im:history', 'users:read']) assert.ok(BOT_SCOPES.includes(s), s);
  assert.deepEqual(BOT_EVENTS, ['app_mention', 'message.im']);
  assert.ok(appManifest({ name: 'x'.repeat(50) }).display_information.name.length <= 35);
  assert.ok(appManifest().display_information.description.length <= 140);
});

test('the gallery entry: two secret fields with setup help in both languages', () => {
  const e = catalog().find((x) => x.id === 'slack-chat');
  assert.equal(e.kind, 'channel');
  assert.equal(e.channel, 'slack');
  assert.deepEqual(e.fields.map((f) => [f.key, f.kind, f.required]), [['token', 'secret', true], ['appToken', 'secret', true]]);
  for (const f of e.fields) assert.ok(f.help?.en && f.help?.zh, f.key);
  assert.match(e.fields[0].help.en, /From a manifest/);
  assert.match(e.fields[1].help.en, /connections:write/);
  assert.match(e.homepage, /^https:\/\/docs\.slack\.dev\//);
});

test('orderOf, missingScopes and tokenProblem', () => {
  assert.equal(orderOf('1700000000.000100'), '1700000000000100');
  assert.equal(orderOf('1700000000.1'), '1700000000100000');
  assert.equal(orderOf('1700000000'), '1700000000000000');
  assert.equal(orderOf('nope'), '');
  assert.ok(orderOf('1700000000.000101') > orderOf('1700000000.000100'));
  assert.match(orderOf('1700000000.123456'), /^\d{1,30}$/);

  assert.deepEqual(missingScopes(SCOPES), []);
  assert.deepEqual(missingScopes('chat:write,users:read'), ['app_mentions:read', 'im:history']);
  assert.deepEqual(missingScopes(undefined), [], 'no header, no verdict');
  assert.deepEqual(missingScopes('app_mentions:read,chat:write:bot,im:history'), []);

  assert.equal(tokenProblem(BOT, APP), '');
  assert.match(tokenProblem(APP, BOT), /swapped/);
  assert.match(tokenProblem(APP, APP), /app-level token \(xapp-…\)/);
  assert.match(tokenProblem('xox' + 'p-123-456-abc', APP), /user token/);
  assert.match(tokenProblem(BOT, BOT), /App-level token field/);
});

test('fromSlack: the bot mention goes, mentions, channels and links read as text', () => {
  const names = new Map([['U0BOB', 'Bob']]);
  const t = (s) => fromSlack(s, { botUserId: 'U0BOT', names });
  assert.equal(t('<@U0BOT> plan the launch'), 'plan the launch');
  assert.equal(t('hey <@U0BOT>, plan it'), 'hey, plan it');
  assert.equal(t('<@U0BOT>: ABC234'), 'ABC234');
  assert.equal(t('<@U0BOT> @forge fix the build'), '@forge fix the build');
  assert.equal(t('ask <@U0BOB> and <@U0ZED|zed> in <#C0LAUNCH|launch>'), 'ask @Bob and @zed in #launch');
  assert.equal(t('see <https://example.com/a?b=1&amp;c=2|the spec> and <https://x.dev>'), 'see the spec (https://example.com/a?b=1&c=2) and https://x.dev');
  assert.equal(t('mail <mailto:a@b.co|a@b.co>'), 'mail a@b.co');
  assert.equal(t('<!here> 5 &lt; 6 &amp;&amp; 7 &gt; 3'), '@here 5 < 6 && 7 > 3');
  assert.equal(t('<!subteam^S0ENG|@eng> ping'), '@eng ping');
  assert.equal(t('<@U0BOT>\n```\n  indented  code\n```'), '```\n  indented  code\n```', 'code keeps its spaces');
  assert.equal(t('<@U0BOT>'), '');
});

test('defuse and fallbackText: no channel-wide pings, Slack control characters escaped', () => {
  assert.equal(defuse('ping <!channel> and <!here|here> and <!subteam^S1|@eng>'), 'ping @channel and @here and @eng');
  assert.equal(fallbackText('**Done** <!everyone>: a < b & c > d, cc <@U0KADA>'), 'Done @everyone: a &lt; b &amp; c &gt; d, cc <@U0KADA>');
  assert.equal(fallbackText('# Plan\n- [docs](https://x.dev)'), 'Plan\n• docs (https://x.dev)');
  assert.equal(fallbackText(''), ' ');
});

test('normalizeEvent keeps people writing to the bot and drops the rest', () => {
  const me = { userId: 'U0BOT', botId: 'B0BOT' };
  assert.deepEqual(normalizeEvent(dm('hi'), me), { chatId: 'D0KADA', messageId: '1700000001.000100', order: '1700000001000100', userId: 'U0KADA', raw: 'hi', isDirect: true, mentioned: true, thread: '1700000001.000100', profileName: '' });
  const inThread = normalizeEvent(mention('<@U0BOT> again', { thread_ts: '1700000000.000001' }), me);
  assert.equal(inThread.isDirect, false);
  assert.equal(inThread.mentioned, true);
  assert.equal(inThread.thread, '1700000000.000001', 'a reply belongs in the thread the mention is in');
  // a channel message (only when the app also subscribes to channel messages)
  assert.equal(normalizeEvent({ ...mention('just chatting'), type: 'message', channel_type: 'channel' }, me).mentioned, false);
  assert.equal(normalizeEvent({ ...mention('<@U0BOT> hi'), type: 'message', channel_type: 'channel' }, me).mentioned, true);
  assert.equal(normalizeEvent({ ...mention('and the docs'), type: 'message', channel_type: 'channel', thread_ts: '1', parent_user_id: 'U0BOT' }, me).mentioned, true);
  assert.equal(normalizeEvent(dm('pic', { subtype: 'file_share' }), me).raw, 'pic');
  for (const ev of [
    dm('my own reply', { user: 'U0BOT', bot_id: 'B0BOT' }),
    dm('other bot', { user: 'U0OTHER', bot_id: 'B0OTHER' }),
    dm('legacy bot', { subtype: 'bot_message', user: undefined, username: 'hook' }),
    dm('edited', { subtype: 'message_changed' }),
    dm('gone', { subtype: 'message_deleted' }),
    dm('joined', { subtype: 'channel_join' }),
    dm('hidden', { hidden: true }),
    dm('   '),
    dm('no ts', { ts: undefined }),
    { type: 'reaction_added', user: 'U0KADA' },
    null,
  ]) assert.equal(normalizeEvent(ev, me), null, JSON.stringify(ev));
});

// --- connecting -------------------------------------------------------------------------------

test('start checks the bot token, opens Socket Mode with the app token and resolves on hello', async () => {
  const h = harness();
  const { me, ws } = await online(h);
  assert.deepEqual(me, { id: 'U0BOT', username: 'atlas_team', name: 'Atlas Team' });
  const auth = h.of('auth.test')[0];
  assert.equal(auth.url, 'https://slack.test/api/auth.test');
  assert.equal(auth.auth, `Bearer ${BOT}`);
  const open = h.of('apps.connections.open')[0];
  assert.equal(open.auth, `Bearer ${APP}`, 'the app-level token opens the socket');
  assert.equal(ws.url, 'wss://wss.test/link/?ticket=tk-1-secret&app_id=A0APPID001');
  assert.deepEqual(h.states(), ['connecting', 'connected']);
  assert.equal(h.c.start(), h.c.start(), 'start is shared');
  assert.deepEqual(links({ account: { id: 'U0BOT' } }), { link: 'https://slack.com/app_redirect?app=A0APPID001&team=T0TEAM' });
  assert.deepEqual(links({ account: { id: 'U0NOBODY' } }), {});
  await h.c.stop();
  assert.equal(ws.closedWith, 1000);
  assert.equal(h.clock.size, 0, 'no timers left');
  assertNoSecret(h);
});

test('the API base defaults to BOTS_SLACK_API', async () => {
  const before = process.env.BOTS_SLACK_API;
  process.env.BOTS_SLACK_API = 'http://127.0.0.1:9/api/';
  try {
    const h = harness({ apiBase: undefined });
    await h.c.send('D0KADA', 'hi');
    assert.equal(h.calls[0].url, 'http://127.0.0.1:9/api/chat.postMessage');
  } finally {
    if (before === undefined) delete process.env.BOTS_SLACK_API;
    else process.env.BOTS_SLACK_API = before;
  }
});

test('tokens in the wrong fields or missing fail at once, without the network', async () => {
  for (const [values, hint, re] of [
    [{ token: APP, appToken: BOT }, 'token_kind', /swapped/],
    [{ token: 'xox' + 'p-1-2-userTokenValue', appToken: APP }, 'token_kind', /user token/],
    [{ token: BOT, appToken: BOT }, 'token_kind', /App-level token field/],
    [{ token: BOT }, 'app_token', /No Slack app-level token/],
  ]) {
    const h = harness({ values, token: values.token });
    await assert.rejects(h.c.start(), (e) => (h.errors.push(e), e.fatal === true && re.test(e.message)));
    assert.equal(h.calls.length, 0);
    assert.equal(h.statuses.at(-1).hint, hint);
    assert.equal(h.statuses.at(-1).fatal, true);
    assertNoSecret(h);
  }
});

test('a rejected bot token is fatal and says which token', async () => {
  for (const code of ['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive']) {
    const h = harness({ fetch: ({ method }) => (method === 'auth.test' ? err(code) : undefined) });
    await assert.rejects(h.c.start(), (e) => (h.errors.push(e), e.fatal === true && /rejected the bot token/.test(e.message)));
    assert.deepEqual(h.statuses.at(-1), { state: 'error', detail: h.statuses.at(-1).detail, hint: 'token', fatal: true });
    assert.match(h.statuses.at(-1).detail, /Bot User OAuth Token/);
    assert.equal(h.sockets.length, 0);
    await h.clock.tick(120_000);
    assert.equal(h.of('auth.test').length, 1, 'no retries');
    assertNoSecret(h);
  }
});

test('app-level token problems are fatal with their own hints', async () => {
  for (const [code, hint, re] of [
    ['invalid_auth', 'app_token', /rejected the app-level token/],
    ['missing_scope', 'app_scope', /connections:write/],
    ['not_allowed_token_type', 'token_kind', /App-level token field/],
  ]) {
    const h = harness({ fetch: ({ method }) => (method === 'apps.connections.open' ? err(code, code === 'missing_scope' ? { needed: 'connections:write', provided: 'authorizations:read' } : {}) : undefined) });
    await assert.rejects(h.c.start(), (e) => (h.errors.push(e), e.fatal === true && re.test(e.message)));
    const s = h.statuses.at(-1);
    assert.equal(s.hint, hint, code);
    assert.equal(s.fatal, true);
    assert.equal(h.sockets.length, 0);
    await h.clock.tick(120_000);
    assert.equal(h.of('apps.connections.open').length, 1);
    assertNoSecret(h);
  }
});

test('missing bot scopes are fatal and named; missing optional ones only log', async () => {
  const h = harness({ fetch: ({ method }) => (method === 'auth.test' ? ok(AUTH, { 'x-oauth-scopes': 'chat:write,users:read' }) : undefined) });
  await assert.rejects(h.c.start(), (e) => /app_mentions:read, im:history scopes/.test(e.message));
  assert.equal(h.statuses.at(-1).hint, 'scopes');
  assert.match(h.statuses.at(-1).detail, /reinstall the app/);
  assert.equal(h.of('apps.connections.open').length, 0);

  const lean = harness({ fetch: ({ method }) => (method === 'auth.test' ? ok(AUTH, { 'x-oauth-scopes': 'app_mentions:read,chat:write,im:history' }) : method === 'users.info' ? err('missing_scope', { needed: 'users:read' }) : undefined) });
  await online(lean);
  assert.ok(lean.logs.some((l) => /lacks channels:read, groups:read, users:read/.test(l)));
  assert.equal(lean.statuses.at(-1).state, 'connected');
  await lean.c.stop();
});

test('network trouble at start retries with backoff until Slack answers', async () => {
  let n = 0;
  const h = harness({
    fetch: ({ method }) => {
      if (method !== 'auth.test') return undefined;
      n += 1;
      if (n === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: `getaddrinfo ENOTFOUND with ${BOT}` } });
      if (n === 2) return reply(503, null);
      return undefined;
    },
  });
  const started = h.c.start();
  await flush();
  assert.equal(h.statuses.at(-1).state, 'error');
  assert.equal(h.statuses.at(-1).fatal, false);
  assert.match(h.statuses.at(-1).detail, /could not reach Slack \(auth\.test: ENOTFOUND\); retrying in 1 s/);
  await h.clock.tick(1000);
  assert.match(h.statuses.at(-1).detail, /HTTP 503; retrying in 2 s/);
  await h.clock.tick(2000);
  h.last().push(HELLO);
  assert.equal((await started).id, 'U0BOT');
  await h.c.stop();
  assertNoSecret(h);
});

// --- events -----------------------------------------------------------------------------------

test('every envelope is acknowledged at once; DMs and mentions become channel messages', async () => {
  const h = harness();
  const { ws } = await online(h);
  const e1 = env(dm('hello there'));
  ws.push(e1);
  assert.deepEqual(ws.acks, [e1.envelope_id], 'acknowledged before anything else');
  ws.push(env(mention('<@U0BOT> what is <@U0BOB> doing?')));
  ws.push({ envelope_id: 'env-slash', type: 'slash_commands', payload: { command: '/x' } });
  await flush();
  assert.equal(ws.acks.length, 3);
  assert.deepEqual(h.messages, [
    { chatId: 'D0KADA', messageId: '1700000001.000100', order: '1700000001000100', userId: 'U0KADA', userName: 'Kada', text: 'hello there', isDirect: true, mentioned: true },
    { chatId: 'C0LAUNCH', messageId: '1700000002.000200', order: '1700000002000200', userId: 'U0KADA', userName: 'Kada', text: 'what is @Bob Stone doing?', isDirect: false, mentioned: true, chatTitle: 'Acme #launch' },
  ]);
  assert.equal(h.of('users.info').filter((c) => c.params.user === 'U0KADA').length, 1, 'names are cached');
  await h.c.stop();
});

test('one message as both message and app_mention, Slack retries and the bot itself are handled once or not at all', async () => {
  const h = harness();
  const { ws } = await online(h);
  const ev = mention('<@U0BOT> ship it', { ts: '1700000005.000001' });
  ws.push(env({ ...ev, type: 'message', channel_type: 'channel' }));
  ws.push(env(ev));
  const retried = env(dm('only once', { ts: '1700000006.000001' }));
  ws.push(retried);
  ws.push({ ...retried, envelope_id: 'env-retry', retry_attempt: 1, retry_reason: 'timeout' });
  ws.push(env(dm('my own reply', { user: 'U0BOT', bot_id: 'B0BOT', ts: '1700000007.000001' })));
  ws.push(env(dm('edited', { subtype: 'message_changed', ts: '1700000008.000001' })));
  ws.push(env(mention('<@U0BOT>', { ts: '1700000009.000001' })));
  await flush();
  assert.deepEqual(h.messages.map((m) => m.text), ['ship it', 'only once']);
  assert.equal(ws.acks.length, 7, 'everything acknowledged, even what is dropped');
  await h.c.stop();
});

test('messages reach onMessage in order even when a name lookup is slow, and a throwing handler does not break the socket', async () => {
  let release;
  const slow = new Promise((r) => (release = r));
  const h = harness({ fetch: async ({ method, params }) => (method === 'users.info' && params.user === 'U0BOB' ? (await slow, undefined) : undefined) });
  const { ws } = await online(h);
  ws.push(env(dm('first from bob', { user: 'U0BOB', channel: 'D0BOB', ts: '1700000010.000001' })));
  ws.push(env(dm('second from kada', { ts: '1700000011.000001' })));
  await flush();
  assert.equal(h.messages.length, 0);
  release();
  await flush();
  assert.deepEqual(h.messages.map((m) => [m.userName, m.text]), [['Bob Stone', 'first from bob'], ['Kada', 'second from kada']]);
  await h.c.stop();

  const t = harness({ onMessage: () => { throw new Error('caller bug'); } });
  const { ws: w2 } = await online(t);
  w2.push(env(dm('hi')));
  await flush();
  assert.ok(t.logs.some((l) => /caller bug/.test(l)));
  w2.push(env(dm('again', { ts: '1700000012.000001' })));
  assert.equal(w2.acks.length, 2, 'still handling frames');
  await t.c.stop();
});

test('without users:read people show by name from the event or their id', async () => {
  const h = harness({ fetch: ({ method }) => (method === 'users.info' ? err('missing_scope', { needed: 'users:read' }) : method === 'conversations.info' ? err('missing_scope') : undefined) });
  const { ws } = await online(h);
  ws.push(env(dm('hi', { user_profile: { display_name: 'kada', real_name: 'Kada Liao' } })));
  ws.push(env(mention('<@U0BOT> hey', { user: 'U0BOB' })));
  await flush();
  assert.deepEqual(h.messages.map((m) => [m.userName, m.chatTitle]), [['kada', undefined], ['U0BOB', undefined]]);
  assert.equal(h.of('users.info').length, 1, 'users.info is not asked again');
  await h.c.stop();
});

// --- the socket -------------------------------------------------------------------------------

test('disconnect (warning, then refresh_requested) opens one replacement and closes the old socket after its hello', async () => {
  const h = harness();
  const { ws } = await online(h);
  ws.push({ type: 'disconnect', reason: 'warning', debug_info: { host: 'applink-1' } });
  await flush();
  ws.push({ type: 'disconnect', reason: 'refresh_requested', debug_info: { host: 'applink-1' } });
  await flush();
  assert.equal(h.sockets.length, 2, 'one replacement');
  assert.equal(h.of('apps.connections.open').length, 2, 'a fresh URL');
  const next = h.last();
  assert.equal(next.url, 'wss://wss.test/link/?ticket=tk-2-secret&app_id=A0APPID001');
  assert.equal(ws.closedWith, null, 'the old socket stays until the new one is ready');
  ws.push(env(dm('in the gap', { ts: '1700000020.000001' })));
  await flush();
  assert.deepEqual(h.messages.map((m) => m.text), ['in the gap']);
  next.push({ ...HELLO, num_connections: 2 });
  assert.equal(ws.closedWith, 1000);
  ws.push(env(dm('stale', { ts: '1700000021.000001' })));
  next.push(env(dm('on the new one', { ts: '1700000022.000001' })));
  await flush();
  assert.deepEqual(h.messages.map((m) => m.text), ['in the gap', 'on the new one'], 'frames from a closed socket are ignored');
  assert.ok(!h.states().slice(2).includes('error'), 'a refresh is not an error');
  assert.equal(h.statuses.at(-1).state, 'connected');
  await h.c.stop();
  assertNoSecret(h);
});

test('link_disabled (Socket Mode turned off) is fatal with the socket_mode hint', async () => {
  const h = harness();
  const { ws } = await online(h);
  ws.push({ type: 'disconnect', reason: 'link_disabled', debug_info: { host: 'applink-1' } });
  const s = h.statuses.at(-1);
  assert.equal(s.state, 'error');
  assert.equal(s.fatal, true);
  assert.equal(s.hint, 'socket_mode');
  assert.match(s.detail, /Enable Socket Mode/);
  assert.equal(ws.closedWith, 1000);
  await h.clock.tick(300_000);
  assert.equal(h.sockets.length, 1, 'no reconnects');
  await h.c.stop();
});

test('a dropped connection reconnects with backoff and a fresh URL; the backoff resets after a hello', async () => {
  const h = harness();
  const { ws } = await online(h);
  ws.drop(1006);
  assert.equal(h.statuses.at(-1).state, 'connecting', 'the first drop after a good connection is not an error yet');
  assert.deepEqual(h.clock.delays(), [1000]);
  await h.clock.tick(1000);
  assert.equal(h.sockets.length, 2);
  h.last().drop(1006); // fails again before hello
  assert.equal(h.statuses.at(-1).state, 'error');
  assert.equal(h.statuses.at(-1).fatal, false);
  assert.match(h.statuses.at(-1).detail, /reconnecting in 2 s/);
  await h.clock.tick(2000);
  h.last().drop(1006);
  await h.clock.tick(4000);
  h.last().drop(1006);
  assert.match(h.statuses.at(-1).detail, /Socket Mode is on/, 'repeated early closes point at Socket Mode');
  await h.clock.tick(8000);
  h.last().push(HELLO);
  assert.equal(h.statuses.at(-1).state, 'connected');
  assert.equal(h.of('apps.connections.open').length, 5, 'every attempt gets a fresh URL');
  h.last().drop(1001);
  assert.deepEqual(h.clock.delays(), [1000], 'backoff reset');
  await h.c.stop();
  assertNoSecret(h);
});

test('apps.connections.open trouble (network, rate limit) retries; a socket that never says hello is replaced', async () => {
  let n = 0;
  const h = harness({
    fetch: ({ method }) => {
      if (method !== 'apps.connections.open') return undefined;
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return reply(429, { ok: false, error: 'ratelimited' }, { 'retry-after': '3' });
      return undefined;
    },
  });
  const started = h.c.start();
  await flush();
  assert.match(h.statuses.at(-1).detail, /apps\.connections\.open/);
  await h.clock.tick(1000); // backoff
  assert.deepEqual(h.clock.delays(), [3000], 'waits Retry-After');
  await h.clock.tick(3000);
  assert.equal(h.sockets.length, 1);
  await h.clock.tick(15_000); // no hello
  assert.equal(h.sockets[0].closedWith, 1000);
  assert.match(h.statuses.at(-1).detail, /did not greet/);
  await h.clock.tick(2000);
  h.last().push(HELLO);
  assert.equal((await started).id, 'U0BOT');
  await h.c.stop();
});

test('Slack pings watch the link: a minute of silence reconnects', async () => {
  const pings = fakePings();
  const h = harness({ pingChannel: pings });
  const { ws } = await online(h);
  await h.clock.tick(120_000);
  assert.equal(h.sockets.length, 1, 'no watchdog before the first ping');
  pings.ping(ws);
  await h.clock.tick(50_000);
  pings.ping(ws);
  pings.ping({ someone: 'else' }); // another socket in the process
  await h.clock.tick(59_000);
  assert.equal(h.sockets.length, 1);
  await h.clock.tick(1000);
  assert.equal(ws.closedWith, 1000);
  assert.equal(h.sockets.length, 2, 'reconnected at once');
  assert.equal(h.statuses.at(-1).state, 'connecting');
  h.last().push(HELLO);
  assert.equal(h.statuses.at(-1).state, 'connected');
  await h.c.stop();
  assert.equal(pings.subs.size, 0, 'unsubscribed');
});

test('another program on the same app: confirmed with a fresh connection, reported, cleared', async () => {
  const h = harness();
  const { ws } = await online(h, { ...HELLO, num_connections: 2 });
  assert.equal(h.statuses.at(-1).state, 'connected', 'one count could be a socket of ours that just died');
  assert.deepEqual(h.clock.delays(), [120_000]);
  await h.clock.tick(120_000);
  const second = h.last();
  assert.notEqual(second, ws);
  second.push({ ...HELLO, num_connections: 3 });
  assert.equal(ws.closedWith, 1000);
  const s = h.statuses.at(-1);
  assert.deepEqual([s.state, s.hint, s.fatal], ['error', 'conflict', false]);
  assert.match(s.detail, /Another program is connected to this Slack app/);
  second.push(env(dm('still works')));
  await flush();
  assert.equal(h.messages.length, 1);
  await h.clock.tick(600_000);
  h.last().push({ ...HELLO, num_connections: 2 });
  assert.equal(h.statuses.at(-1).state, 'connected');
  assert.equal(h.clock.size, 0, 'no more checks');
  await h.c.stop();
});

// --- sending ----------------------------------------------------------------------------------

test('send posts a markdown block with a plain fallback; channel replies stay in the thread', async () => {
  const h = harness();
  const { ws } = await online(h);
  ws.push(env(mention('<@U0BOT> again', { ts: '1700000030.000002', thread_ts: '1700000030.000001' })));
  await flush();
  const md = '**Done.** See the table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<!channel> fyi';
  await h.c.send('C0LAUNCH', md, { replyTo: '1700000030.000002' });
  const [post] = h.of('chat.postMessage');
  assert.equal(post.auth, `Bearer ${BOT}`);
  assert.equal(post.params.channel, 'C0LAUNCH');
  assert.equal(post.params.thread_ts, '1700000030.000001', 'into the thread the mention is in');
  assert.deepEqual(JSON.parse(post.params.blocks), [{ type: 'markdown', text: md.replace('<!channel>', '@channel') }]);
  assert.match(post.params.text, /^Done\. See the table:/);
  assert.ok(!post.params.text.includes('<!channel>'));

  await h.c.send('C0LAUNCH', 'top level mention reply', { replyTo: '1699999999.000001' });
  assert.equal(h.of('chat.postMessage').at(-1).params.thread_ts, '1699999999.000001', 'an unknown ts is its own thread');
  await h.c.send('D0KADA', 'in the DM');
  assert.equal(h.of('chat.postMessage').at(-1).params.thread_ts, undefined);
  await h.c.stop();
});

test('long replies split at about 11,000 characters, fences balanced, every part in the thread', async () => {
  const h = harness();
  const code = Array.from({ length: 700 }, (_, i) => `const v${i} = ${i}; // ${'x'.repeat(20)}`).join('\n');
  await h.c.send('C0LAUNCH', `Intro\n\n\`\`\`js\n${code}\n\`\`\`\nDone.`, { replyTo: '1700000040.000001' });
  const posts = h.of('chat.postMessage');
  assert.ok(posts.length >= 2);
  for (const p of posts) {
    const text = JSON.parse(p.params.blocks)[0].text;
    assert.ok(text.length <= 11_000, `part of ${text.length}`);
    assert.equal((text.match(/```/g) ?? []).length % 2, 0, 'balanced fences');
    assert.equal(p.params.thread_ts, '1700000040.000001');
  }
  await h.c.send('C0LAUNCH', '   ');
  assert.equal(h.of('chat.postMessage').length, posts.length, 'nothing to send, nothing posted');
});

test('send waits out rate limits, falls back to plain text when Slack refuses the block, and reports a revoked token', async () => {
  let n = 0;
  const h = harness({
    fetch: ({ method }) => {
      if (method !== 'chat.postMessage') return undefined;
      n += 1;
      if (n === 1) return reply(429, { ok: false, error: 'ratelimited' }, { 'retry-after': '2' });
      if (n === 2) return err('ratelimited');
      if (n === 3) return err('invalid_blocks');
      return undefined;
    },
  });
  const sending = h.c.send('D0KADA', '**hi**');
  await flush();
  assert.deepEqual(h.clock.delays(), [2000]);
  await h.clock.tick(2000);
  assert.deepEqual(h.clock.delays(), [1000], 'no Retry-After header: a second');
  await h.clock.tick(1000);
  await sending;
  const posts = h.of('chat.postMessage');
  assert.equal(posts.length, 4);
  assert.equal(posts[3].params.blocks, undefined, 'plain text after invalid_blocks');
  assert.equal(posts[3].params.text, 'hi');
  assert.ok(h.logs.some((l) => /did not take the Markdown block/.test(l)));

  const denied = harness({ fetch: ({ method }) => (method === 'chat.postMessage' ? err('not_in_channel') : undefined) });
  await assert.rejects(denied.c.send('C0X', 'x'), (e) => e.code === 'not_in_channel' && /not_in_channel/.test(e.message));

  const revoked = harness({ fetch: ({ method }) => (method === 'chat.postMessage' ? err('token_revoked') : undefined) });
  await online(revoked);
  await assert.rejects(revoked.c.send('D0KADA', 'x'));
  assert.deepEqual([revoked.statuses.at(-1).hint, revoked.statuses.at(-1).fatal], ['token', true]);
  await revoked.c.stop();

  const offline = harness({ fetch: () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', message: `refused ${BOT}` } }); } });
  await assert.rejects(offline.c.send('D0KADA', 'x'), (e) => (offline.errors.push(e), /could not reach Slack/.test(e.message)));
  for (const x of [h, denied, revoked, offline]) assertNoSecret(x);
});

test('typing: "is thinking…" in the channel thread, refreshed at most every 45 s, nothing in DMs', async () => {
  const h = harness();
  const { ws } = await online(h);
  await h.c.typing('D0KADA');
  await h.c.typing('C0LAUNCH');
  assert.equal(h.of('assistant.threads.setStatus').length, 0, 'nothing in a DM, nothing before a mention');
  ws.push(env(mention('<@U0BOT> go', { ts: '1700000050.000002', thread_ts: '1700000050.000001' })));
  await flush();
  await h.c.typing('C0LAUNCH');
  await h.c.typing('C0LAUNCH');
  const sets = h.of('assistant.threads.setStatus');
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].params, { channel_id: 'C0LAUNCH', thread_ts: '1700000050.000001', status: 'is thinking…' });
  await h.clock.tick(45_000);
  await h.c.typing('C0LAUNCH');
  assert.equal(h.of('assistant.threads.setStatus').length, 2);
  await h.c.stop();

  const old = harness({ fetch: ({ method }) => (method === 'assistant.threads.setStatus' ? err('method_not_supported_for_channel_type') : undefined) });
  const { ws: w2 } = await online(old);
  w2.push(env(mention('<@U0BOT> go')));
  w2.push(env(mention('<@U0BOT> go', { channel: 'C0OTHER', ts: '1700000060.000001' })));
  await flush();
  await old.c.typing('C0LAUNCH');
  await old.c.typing('C0OTHER');
  assert.equal(old.of('assistant.threads.setStatus').length, 1, 'turned off after Slack refused it');
  assert.ok(old.logs.some((l) => /no "is thinking…" status/.test(l)));
  await old.c.stop();
});

test('stop is idempotent and final: sockets closed, waits cancelled, nothing reconnects', async () => {
  const h = harness();
  const { ws } = await online(h);
  await h.c.stop();
  await h.c.stop();
  assert.equal(ws.closedWith, 1000);
  assert.equal(h.statuses.filter((s) => s.state === 'stopped').length, 1);
  ws.drop(1006);
  await h.clock.tick(120_000);
  assert.equal(h.sockets.length, 1);
  await assert.rejects(h.c.send('D0KADA', 'x'), /stopped/);
  await assert.rejects(h.c.start(), /stopped/);
  await h.c.typing('C0LAUNCH');

  // before hello: start rejects
  const h2 = harness();
  const started = h2.c.start();
  await flush();
  await h2.c.stop();
  await assert.rejects(started, /stopped/);
  assert.equal(h2.clock.size, 0);

  // during a backoff wait
  const h3 = harness();
  const { ws: w3 } = await online(h3);
  w3.drop(1006);
  assert.equal(h3.clock.size, 1);
  await h3.c.stop();
  assert.equal(h3.clock.size, 0);
  await h3.clock.tick(120_000);
  assert.equal(h3.sockets.length, 1);

  // during a 429 wait
  const h4 = harness({ fetch: ({ method }) => (method === 'chat.postMessage' ? reply(429, { ok: false, error: 'ratelimited' }, { 'retry-after': '30' }) : undefined) });
  const sending = h4.c.send('D0KADA', 'x');
  await flush();
  assert.equal(h4.clock.size, 1);
  await h4.c.stop();
  await assert.rejects(sending, /stopped/);
  assert.equal(h4.clock.size, 0);

  // after a fatal error
  const h5 = harness({ fetch: ({ method }) => (method === 'auth.test' ? err('invalid_auth') : undefined) });
  await assert.rejects(h5.c.start());
  await h5.c.stop();
  assert.deepEqual(h5.states().slice(-2), ['error', 'stopped']);
  for (const x of [h, h2, h3, h4, h5]) assertNoSecret(x);
});

// --- with the channel hub ---------------------------------------------------------------------

test('through the hub: pairing in a DM, a DM reply in Markdown, a channel mention answered in its thread, strangers ignored', async () => {
  const w = harness();
  const entries = catalog();
  const roster = [
    { id: 'atlas', handle: 'atlas', name: 'Atlas', role: 'primary', persona: '', apps: [{ id: 'sl', template: 'slack-chat', serverName: 'slack-chat', enabled: true, values: { token: BOT, appToken: APP } }] },
    { id: 'forge', handle: 'forge', name: 'Forge', role: 'bot', persona: '', apps: [] },
  ];
  const delivered = [];
  const hubLogs = [];
  const hub = createChannels({
    file: join(mkdtempSync(join(tmpdir(), 'bots-slack-')), 'channels.json'),
    bots: () => roster,
    entries: () => entries,
    deliver: async (bot, msg) => {
      delivered.push({ bot: bot.id, ...msg });
      return `session-${bot.id}`;
    },
    running: () => true,
    loadConnector: async (k) => {
      assert.equal(k, 'slack');
      return { ...slack, createConnector: (o) => (assert.deepEqual(o.values, { token: BOT, appToken: APP }), w.wrap(o)) };
    },
    log: (line) => hubLogs.push(line),
    typingEveryMs: 60_000,
  });
  hub.sync();
  await flush();
  const ws = w.last();
  ws.push(HELLO);
  await flush();
  const view = hub.view(roster[0]).sl;
  assert.equal(view.kind, 'slack');
  assert.equal(view.state, 'connected');
  assert.deepEqual(view.account, { username: 'atlas_team', name: 'Atlas Team' });
  assert.match(view.code?.code ?? '', /^[A-Z2-9]{6}$/);
  assert.equal(view.link, 'https://slack.com/app_redirect?app=A0APPID001&team=T0TEAM', 'the panel can open the app\'s DM');
  const posts = () => w.of('chat.postMessage').map((c) => ({ channel: c.params.channel, thread: c.params.thread_ts ?? null, md: JSON.parse(c.params.blocks)[0].text }));

  // Strangers: one private note in a DM, silence in a channel.
  ws.push(env(dm('hello?', { user: 'U0BOB', channel: 'D0BOB', ts: '1700000100.000001' })));
  ws.push(env(dm('hello again?', { user: 'U0BOB', channel: 'D0BOB', ts: '1700000100.000003' })));
  ws.push(env(mention('<@U0BOT> hello?', { user: 'U0BOB', ts: '1700000100.000002' })));
  await flush();
  assert.deepEqual(posts(), [{ channel: 'D0BOB', thread: null, md: PRIVATE_TEXT }]);
  assert.equal(delivered.length, 0);

  // Pairing with the code from the panel.
  ws.push(env(dm(view.code.code, { ts: '1700000101.000001' })));
  await flush();
  assert.match(posts().at(-1).md, /^Paired\. What you send here goes to Atlas \(@atlas\)/);
  assert.equal(posts().at(-1).channel, 'D0KADA');
  assert.deepEqual(hub.view(roster[0]).sl.paired.map((p) => [p.id, p.name, p.direct]), [['U0KADA', 'Kada', true]]);

  // A DM to the team, and the reply as Markdown.
  ws.push(env(dm('plan the launch', { ts: '1700000102.000001' })));
  await flush();
  assert.deepEqual(delivered.at(-1), { bot: 'atlas', header: '[Slack · Kada]', body: 'plan the launch' });
  hub.noteUserMessage('session-atlas', roster[0], 'user', '[Slack · Kada]\nplan the launch');
  const plan = '## Plan\n\n- **one**\n- two\n\n| step | who |\n|---|---|\n| 1 | Forge |';
  hub.noteReply('session-atlas', plan);
  await flush();
  assert.deepEqual(posts().at(-1), { channel: 'D0KADA', thread: null, md: plan }, 'Markdown goes out as written');

  // A channel mention for another bot: routed by @handle, "is thinking…" in the thread, the reply in the thread.
  ws.push(env(mention('<@U0BOT> @forge fix the build', { ts: '1700000103.000002', thread_ts: '1700000103.000001' })));
  await flush();
  assert.deepEqual(delivered.at(-1), { bot: 'forge', header: '[Slack · Kada · Acme #launch]', body: 'fix the build' });
  assert.deepEqual(w.of('assistant.threads.setStatus').map((c) => c.params), [{ channel_id: 'C0LAUNCH', thread_ts: '1700000103.000001', status: 'is thinking…' }]);
  hub.noteUserMessage('session-forge', roster[1], 'user', '[Slack · Kada · Acme #launch]\nfix the build');
  hub.noteReply('session-forge', 'Fixed in `main`.');
  await flush();
  assert.deepEqual(posts().at(-1), { channel: 'C0LAUNCH', thread: '1700000103.000001', md: 'Fixed in `main`.' });

  await hub.stopAll();
  assert.equal(ws.closedWith, 1000);
  assertNoSecret(w, hubLogs);
});
