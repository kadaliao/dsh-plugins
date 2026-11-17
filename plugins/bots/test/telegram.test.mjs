import assert from 'node:assert/strict';
import test from 'node:test';

import { TEXT_LIMIT, createConnector, kind } from '../lib/channels/telegram.mjs';

const TOKEN = '123456789:AAHsecret-telegram-token-value_xyz';
const ME = { id: 555, is_bot: true, first_name: 'Team', username: 'acme_team_bot' };
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });

/**
 * A Bot API stand-in. `updates` is a queue of getUpdates answers (arrays, or
 * functions returning a response); an empty queue holds the poll until stop.
 */
function fakeApi({ getMe = () => json({ ok: true, result: ME }), send } = {}) {
  const calls = [];
  const updates = [];
  let waiting = null;
  const api = {
    calls,
    updates,
    push(answer) {
      updates.push(answer);
      if (waiting) {
        const w = waiting;
        waiting = null;
        w();
      }
    },
    of: (method) => calls.filter((c) => c.method === method),
    fetchImpl: async (url, init) => {
      const m = /\/bot([^/]+)\/(\w+)$/.exec(String(url));
      const call = { url: String(url), token: m?.[1], method: m?.[2], body: JSON.parse(init.body) };
      calls.push(call);
      if (call.method === 'getMe') return getMe(call);
      if (call.method === 'sendMessage') return send ? send(call) : json({ ok: true, result: { message_id: calls.length } });
      if (call.method === 'sendChatAction' || call.method === 'deleteWebhook') return json({ ok: true, result: true });
      if (call.method === 'getUpdates') {
        if (call.body.timeout === 0) return json({ ok: true, result: [] });
        while (updates.length === 0) {
          await new Promise((resolve, reject) => {
            waiting = resolve;
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          });
        }
        const next = updates.shift();
        if (typeof next === 'function') return next(call);
        return json({ ok: true, result: next });
      }
      return json({ ok: false, error_code: 404, description: 'Not Found' }, 404);
    },
  };
  return api;
}

function connector(api, extra = {}) {
  const seen = { messages: [], statuses: [], logs: [], sleeps: [] };
  const c = createConnector({
    token: TOKEN,
    fetchImpl: api.fetchImpl,
    apiBase: 'http://fake.local/',
    onMessage: (m) => seen.messages.push(m),
    onStatus: (s) => seen.statuses.push(s),
    log: (line) => seen.logs.push(line),
    sleep: async (ms) => {
      seen.sleeps.push(ms);
    },
    pollTimeout: 1,
    ...extra,
  });
  return { c, seen };
}
const msg = (id, m) => ({ update_id: id, message: { message_id: id * 10, date: 1, ...m } });
const kada = { id: 42, is_bot: false, first_name: 'Kada', last_name: 'Liao', username: 'kada' };
const priv = { id: 42, type: 'private', first_name: 'Kada' };
const group = { id: -1001234, type: 'supergroup', title: 'Acme team' };

test('module contract: kind and limit', () => {
  assert.equal(kind, 'telegram');
  assert.equal(TEXT_LIMIT, 4096);
});

test('start checks the token with getMe, then long-polls with offsets', async () => {
  const api = fakeApi();
  const { c, seen } = connector(api);
  const me = await c.start();
  assert.deepEqual(me, { id: '555', username: 'acme_team_bot', name: 'Team' });
  assert.equal(api.calls[0].url, `http://fake.local/bot${TOKEN}/getMe`);
  api.push([msg(7, { from: kada, chat: priv, text: 'hello' }), msg(8, { from: kada, chat: priv, text: 'second' })]);
  await flush();
  api.push([msg(9, { from: kada, chat: priv, text: 'third' })]);
  await flush();
  const polls = api.of('getUpdates');
  assert.equal(polls[0].body.offset, 0);
  assert.deepEqual(polls[0].body.allowed_updates, ['message']);
  assert.equal(polls[0].body.timeout, 1);
  assert.equal(polls[1].body.offset, 9);
  assert.equal(polls[2].body.offset, 10);
  assert.deepEqual(seen.messages[0], { chatId: '42', messageId: '70', userId: '42', userName: 'Kada Liao', text: 'hello', isDirect: true, mentioned: true });
  assert.deepEqual(seen.messages.map((m) => m.text), ['hello', 'second', 'third']);
  assert.deepEqual(seen.statuses.map((s) => s.state).slice(0, 2), ['connecting', 'connected']);
  await c.stop();
  await c.stop();
  assert.equal(seen.statuses.at(-1).state, 'stopped');
  assert.deepEqual(api.of('getUpdates').at(-1).body, { offset: 10, timeout: 0, limit: 1 }, 'the last batch is confirmed on stop');
  const after = api.calls.length;
  await flush();
  assert.equal(api.calls.length, after, 'no polling after stop');
});

test('groups: mentions, replies to the bot and commands; its own @username is stripped; bots are ignored', async () => {
  const api = fakeApi();
  const { c, seen } = connector(api);
  await c.start();
  const text1 = 'hey @acme_team_bot, plan the launch';
  const text2 = '@Acme_Team_Bot @forge fix it';
  api.push([
    msg(1, { from: kada, chat: group, text: 'just chatting' }),
    msg(2, { from: kada, chat: group, text: text1, entities: [{ type: 'mention', offset: 4, length: 14 }] }),
    msg(3, { from: kada, chat: group, text: text2, entities: [{ type: 'mention', offset: 0, length: 14 }, { type: 'mention', offset: 15, length: 6 }] }),
    msg(4, { from: kada, chat: group, text: 'and the docs', reply_to_message: { message_id: 30, from: ME } }),
    msg(5, { from: kada, chat: group, text: '/start@acme_team_bot ABC234', entities: [{ type: 'bot_command', offset: 0, length: 20 }] }),
    msg(6, { from: { id: 99, is_bot: true, first_name: 'Other bot' }, chat: group, text: '@acme_team_bot loop', entities: [{ type: 'mention', offset: 0, length: 14 }] }),
    msg(7, { from: { ...ME }, chat: group, text: 'me' }),
    msg(8, { from: kada, chat: group, photo: [{}] }),
  ]);
  await flush();
  assert.deepEqual(
    seen.messages.map((m) => [m.text, m.isDirect, m.mentioned]),
    [
      ['just chatting', false, false],
      ['hey, plan the launch', false, true],
      ['@forge fix it', false, true],
      ['and the docs', false, true],
      ['/start ABC234', false, true],
    ],
  );
  assert.equal(seen.messages[1].chatTitle, 'Acme team');
  assert.equal(seen.messages[1].chatId, '-1001234');
  await c.stop();
});

test('send splits at 4096, threads the first part, and waits out 429', async () => {
  let limited = 1;
  const api = fakeApi({
    send: () => (limited-- > 0 ? json({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } }, 429) : json({ ok: true, result: {} })),
  });
  const { c, seen } = connector(api);
  await c.start();
  const long = `${'a'.repeat(4000)}\n\n${'b'.repeat(4000)}\n\n${'c'.repeat(100)}`;
  await c.send('-1001234', long, { replyTo: '70' });
  const sends = api.of('sendMessage');
  assert.equal(sends.length, 4, 'one retry after 429, then three parts');
  assert.deepEqual(seen.sleeps, [3000]);
  const parts = sends.slice(1);
  assert.deepEqual(parts.map((p) => p.body.text.length), [4000, 4000, 100]);
  assert.equal(parts[0].body.chat_id, -1001234);
  assert.deepEqual(parts[0].body.reply_parameters, { message_id: 70, allow_sending_without_reply: true });
  assert.equal(parts[1].body.reply_parameters, undefined);
  assert.equal(parts[0].body.parse_mode, undefined, 'plain text');
  await c.typing('42');
  assert.deepEqual(api.of('sendChatAction')[0].body, { chat_id: 42, action: 'typing' });
  await c.stop();
});

test('threadId: forum topics only; a reply chain or the General topic is the whole chat', async () => {
  const api = fakeApi();
  const { c, seen } = connector(api);
  await c.start();
  const forum = { id: -1005555, type: 'supergroup', title: 'Acme forum', is_forum: true };
  const at = (text) => ({ text: `@acme_team_bot ${text}`, entities: [{ type: 'mention', offset: 0, length: 14 }] });
  api.push([
    msg(1, { from: kada, chat: forum, ...at('in a topic'), message_thread_id: 77, is_topic_message: true, reply_to_message: { message_id: 77, from: kada, forum_topic_created: { name: 'Launch' } } }),
    msg(2, { from: kada, chat: forum, ...at('in General') }),
    msg(3, { from: kada, chat: group, text: 'and the docs', message_thread_id: 30, reply_to_message: { message_id: 30, from: ME } }),
    msg(4, { from: kada, chat: priv, text: 'private topic', message_thread_id: 5, is_topic_message: true }),
    msg(5, { from: kada, chat: priv, text: 'plain dm' }),
  ]);
  await flush();
  assert.deepEqual(
    seen.messages.map((m) => [m.text, m.threadId]),
    [
      ['in a topic', '77'],
      ['in General', undefined],
      ['and the docs', undefined],
      ['private topic', '5'],
      ['plain dm', undefined],
    ],
  );
  assert.equal('threadId' in seen.messages[1], false, 'no threadId key at all without a topic');
  await c.stop();
});

test('send and typing with threadId go to the topic; replyTo still quotes the first part; a deleted topic falls back to the chat', async () => {
  let gone = false;
  const api = fakeApi({
    send: (call) => (gone && call.body.message_thread_id ? json({ ok: false, error_code: 400, description: 'Bad Request: message thread not found' }, 400) : json({ ok: true, result: { message_id: 1 } })),
  });
  const { c, seen } = connector(api);
  await c.start();
  await c.send('-1005555', `${'a'.repeat(4000)}\n\n${'b'.repeat(100)}`, { threadId: '77', replyTo: '120' });
  const [p1, p2] = api.of('sendMessage');
  assert.equal(p1.body.message_thread_id, 77);
  assert.deepEqual(p1.body.reply_parameters, { message_id: 120, allow_sending_without_reply: true });
  assert.equal(p2.body.message_thread_id, 77, 'every part stays in the topic');
  assert.equal(p2.body.reply_parameters, undefined);
  await c.send('-1005555', 'topic only', { threadId: '77' });
  assert.deepEqual(api.of('sendMessage').at(-1).body, { chat_id: -1005555, text: 'topic only', message_thread_id: 77 });
  await c.send('-1005555', 'no thread');
  assert.equal('message_thread_id' in api.of('sendMessage').at(-1).body, false);
  await c.send('-1005555', 'junk id', { threadId: 'abc' });
  assert.equal('message_thread_id' in api.of('sendMessage').at(-1).body, false, 'a non-numeric threadId is ignored');
  await c.typing('-1005555', { threadId: '77' });
  await c.typing('-1005555');
  assert.deepEqual(api.of('sendChatAction').map((x) => x.body), [
    { chat_id: -1005555, message_thread_id: 77, action: 'typing' },
    { chat_id: -1005555, action: 'typing' },
  ]);
  gone = true;
  const before = api.of('sendMessage').length;
  await c.send('-1005555', 'after the topic was deleted', { threadId: '77', replyTo: '120' });
  const tries = api.of('sendMessage').slice(before);
  assert.equal(tries.length, 2);
  assert.equal(tries[1].body.message_thread_id, undefined);
  assert.deepEqual(tries[1].body.reply_parameters, { message_id: 120, allow_sending_without_reply: true });
  assert.ok(seen.logs.some((l) => /topic 77 is gone/.test(l)));
  await c.stop();
});

test('a rejected token is fatal at start, and the token never shows in errors or statuses', async () => {
  const api = fakeApi({ getMe: () => json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401) });
  const { c, seen } = connector(api);
  await assert.rejects(c.start(), (e) => e.fatal === true && /rejected the bot token/.test(e.message) && !e.message.includes(TOKEN));
  assert.equal(seen.statuses.at(-1).state, 'error');
  assert.equal(seen.statuses.at(-1).fatal, true);
  assert.equal(api.of('getUpdates').length, 0);
  assert.equal(JSON.stringify(seen).includes(TOKEN), false);
});

test('network errors back off exponentially, at start and while polling; 401 while polling stops it', async () => {
  let downs = 2;
  const api = fakeApi({
    getMe: () => {
      if (downs-- > 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: `connect ECONNREFUSED http://fake.local/bot${TOKEN}/getMe` } });
      return json({ ok: true, result: ME });
    },
  });
  const { c, seen } = connector(api);
  await c.start();
  assert.deepEqual(seen.sleeps, [1000, 2000]);
  assert.match(seen.statuses[1].detail, /could not reach Telegram \(getMe: ECONNREFUSED\); retrying in 1 s/);
  const boom = () => {
    throw new TypeError('fetch failed');
  };
  api.push(boom);
  api.push(boom);
  api.push(boom);
  api.push([msg(1, { from: kada, chat: priv, text: 'back' })]);
  await flush(20);
  assert.deepEqual(seen.sleeps.slice(2), [1000, 2000, 4000]);
  const blip = seen.statuses.findIndex((x) => /getUpdates/.test(x.detail ?? ''));
  assert.deepEqual(seen.statuses.slice(blip, blip + 3).map((x) => x.state), ['connecting', 'error', 'error'], 'one dropped poll reads as reconnecting');
  assert.equal(seen.messages[0].text, 'back');
  assert.equal(seen.statuses.at(-1).state, 'connected', 'connected again after the outage');
  api.push(() => json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401));
  await flush();
  assert.equal(seen.statuses.at(-1).state, 'error');
  assert.equal(seen.statuses.at(-1).fatal, true);
  const n = api.of('getUpdates').length;
  await flush();
  assert.equal(api.of('getUpdates').length, n, 'polling stopped');
  assert.equal(JSON.stringify(seen).includes(TOKEN), false);
  await c.stop();
});

test('409 Conflict: removes a webhook once, else reports another program and retries slowly', async () => {
  const api = fakeApi();
  const { c, seen } = connector(api);
  await c.start();
  api.push(() => json({ ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" }, 409));
  api.push(() => json({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' }, 409));
  api.push(() => json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }, 429));
  api.push([]);
  await flush(20);
  assert.equal(api.of('deleteWebhook').length, 1);
  const conflict = seen.statuses.find((s) => /Another program is using this bot token/.test(s.detail ?? ''));
  assert.ok(conflict, 'a conflict status');
  assert.equal(conflict.state, 'error');
  assert.notEqual(conflict.fatal, true);
  assert.deepEqual(seen.sleeps, [30000, 7000]);
  assert.equal(seen.statuses.at(-1).state, 'connected');
  await c.stop();
});

test('stop during a long poll aborts it, and start after stop refuses', async () => {
  const api = fakeApi();
  const { c } = connector(api);
  await c.start();
  await flush();
  assert.equal(api.of('getUpdates').length, 1, 'a poll is waiting');
  await c.stop();
  await assert.rejects(c.start(), /stopped/);
});

test('the apiBase defaults to BOTS_TELEGRAM_API', async () => {
  const api = fakeApi();
  const before = process.env.BOTS_TELEGRAM_API;
  process.env.BOTS_TELEGRAM_API = 'http://127.0.0.1:9/';
  try {
    const c = createConnector({ token: TOKEN, fetchImpl: api.fetchImpl, onMessage() {}, pollTimeout: 1 });
    await c.start();
    assert.equal(api.calls[0].url, `http://127.0.0.1:9/bot${TOKEN}/getMe`);
    await c.stop();
  } finally {
    if (before === undefined) delete process.env.BOTS_TELEGRAM_API;
    else process.env.BOTS_TELEGRAM_API = before;
  }
});
