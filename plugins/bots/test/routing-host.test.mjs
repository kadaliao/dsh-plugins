/**
 * Bots 0.8, the second host batch (PLAN-0.8 §4.3–§4.5, §8): Thread routing with chat channels,
 * bot_reply / bot_recall / bot_ticket, the task watchdog, recovery after a restart, and the lone
 * dispatcher, against a Harness stand-in shaped like 0.2.2's Agent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bots-routing-'));
const { apply } = await import('../index.js');
const { personaText } = await import('../lib/prompt.mjs');

const TG_TOKEN = '123456789:AAHsecret-telegram-token-value_xyz';
const settle = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};
const textOfMsg = (m) => m.content.map((b, i, all) => (i < all.length - 1 && !b.text.endsWith('\n') ? `${b.text}\n` : b.text)).join('');

/** The Harness: agents with `inbox.{nextTurn, nextStep}`, steer / followup / inject / cancel, scoped restrict and guard; `step` runs one turn. */
function fakeHarness({ services: extra = {} } = {}) {
  const listeners = {};
  const onOptions = {};
  const tools = new Map();
  const agentsById = new Map();
  const archived = [];
  const effects = [];
  const emit = (n, ...a) => (listeners[n] ?? []).forEach((fn) => fn(...a));
  let seq = 0;
  const makeAgent = (sessionId) => {
    const sections = new Map();
    const restricts = [];
    const guards = [];
    const agent = {
      id: sessionId,
      status: 'idle',
      session: { id: sessionId },
      inbox: { nextTurn: [], nextStep: [] },
      deliveries: [],
      injected: [],
      cancels: [],
      prompts: [],
      followup(m) {
        agent.inbox.nextTurn.push(m);
        agent.deliveries.push({ mode: 'followup', message: m });
      },
      steer(m) {
        agent.inbox.nextStep.push(m);
        agent.deliveries.push({ mode: 'steer', message: m });
      },
      inject(m) {
        agent.injected.push(m);
        agent.deliveries.push({ mode: 'inject', message: m });
      },
      cancel(cause) {
        agent.cancels.push(cause);
      },
      model: { select() {}, current: () => undefined },
      sections,
      restricts,
      guards,
      ctx: {
        get(name) {
          if (name === 'systemPrompt') return { section: (s) => (sections.set(s.name, s), () => sections.delete(s.name)) };
          if (name === 'tools') return { restrict: (f) => (restricts.push(f), () => restricts.splice(restricts.indexOf(f), 1)), guard: (g) => (guards.push(g), () => guards.splice(guards.indexOf(g), 1)) };
          return undefined;
        },
      },
    };
    return agent;
  };
  const services = {
    agents: { get: (id) => agentsById.get(id), list: () => [...agentsById.values()] },
    sessionController: {
      async create({ sessionId }) {
        if (agentsById.has(sessionId)) throw new Error(`session ${sessionId} exists`);
        const agent = makeAgent(sessionId);
        agentsById.set(sessionId, agent);
        for (const fn of listeners['agent/created'] ?? []) fn({ agent });
        return { sessionId };
      },
      async resolveAgent(id) {
        const a = agentsById.get(id);
        return a && !archived.includes(id) ? { agent: a } : { error: new Error('gone') };
      },
    },
    workspaceRegistry: {
      async create() {
        return { id: 'ws-bots' };
      },
      get archivedSessionIds() {
        return archived;
      },
      async archiveSession(id) {
        archived.push(id);
      },
    },
    ...extra,
  };
  const ctx = {
    tools: {
      register: (t) => (tools.set(t.name, t), () => tools.delete(t.name)),
      definitions: () => ['bash', 'write', 'edit', 'read', 'web_search', 'job_output', 'skill'].map((name) => ({ name, description: `${name}.` })),
    },
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') effects.push(d);
    },
    on(name, fn, options) {
      (listeners[name] ??= []).push(fn);
      if (options) onOptions[name] = options;
    },
    get: (name) => services[name],
    inject(names, fn) {
      if (names.includes('webServer')) return;
      if (names.includes('jobs') && !services.jobs) return;
      fn({ ...ctx, agents: services.agents, jobs: services.jobs });
    },
    logger: { warn() {}, info() {}, debug() {} },
  };
  /** A Session that exists before the plugin starts (a restart). */
  const addAgent = (sessionId) => {
    const agent = makeAgent(sessionId);
    agentsById.set(sessionId, agent);
    return agent;
  };
  /** One turn: the step takes its steering (or the next follow-up), the prompt is assembled, its messages reported, tools run. */
  async function step(sessionId, { answer, calls = [], claim } = {}) {
    const agent = agentsById.get(sessionId);
    const claimed = claim ?? (agent.inbox.nextStep.length ? agent.inbox.nextStep.splice(0) : agent.inbox.nextTurn.splice(0, 1));
    agent.status = 'running';
    emit('agent/status', { agent, status: 'running' });
    agent.prompts.push([...agent.sections.values()].map((s) => s.text?.()).join('\n'));
    for (const m of claimed) emit('session/event', agent.session, { type: 'user/message', seq: ++seq, time: Date.now(), data: m });
    const results = [];
    for (const c of calls) {
      emit('session/event', agent.session, { type: 'assistant/message', seq: ++seq, time: Date.now(), data: { message: { content: [{ type: 'tool-call', name: c.name, argsRaw: JSON.stringify(c.args) }], source: { kind: 'model', provider: 'magpie', model: 'm' } }, usage: { inputTokens: 10, outputTokens: 5 } } });
      results.push(await tools.get(c.name).execute(c.args, { agent }));
    }
    if (answer) emit('session/event', agent.session, { type: 'assistant/message', seq: ++seq, time: Date.now(), data: { message: { content: [{ type: 'text', text: answer }], source: { kind: 'model', provider: 'magpie', model: 'm' } }, usage: { inputTokens: 10, outputTokens: 5 } } });
    emit('session/event', agent.session, { type: 'turn/end', seq: ++seq, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
    agent.status = 'idle';
    emit('agent/status', { agent, status: 'idle' });
    return results;
  }
  return { ctx, tools, agentsById, archived, effects, emit, step, addAgent, services, listeners, onOptions };
}

/** A chat connector module stand-in: records what is sent (with its thread options) and typing. */
function fakeChannels() {
  const made = [];
  return {
    made,
    live: () => made.filter((c) => !c.stopped),
    load: async (kind) => ({
      kind,
      TEXT_LIMIT: 4096,
      createConnector(opts) {
        const c = {
          kind,
          opts,
          stopped: false,
          sent: [],
          typed: [],
          async start() {
            return { id: '555', username: 'acme_team_bot', name: 'Acme' };
          },
          async stop() {
            c.stopped = true;
          },
          async send(chatId, text, o) {
            c.sent.push({ chatId, text, ...(o ?? {}) });
          },
          async typing(chatId, o) {
            c.typed.push({ chatId, ...(o ?? {}) });
          },
          emit: (msg) => opts.onMessage(msg),
        };
        made.push(c);
        return c;
      },
    }),
  };
}

/** The plugin on a fresh (or given) home, with a fake Harness and fake chat connectors. */
function boot({ home, pre, ...deps } = {}) {
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home ?? mkdtempSync(join(tmpdir(), 'bots-routing-'));
  try {
    const h = fakeHarness({ services: deps.services ?? {} });
    pre?.(h);
    const fake = fakeChannels();
    const { services: _services, ...rest } = deps;
    const api = apply(h.ctx, {}, { prices: false, sweep: false, startupPumpMs: 5, loadConnector: fake.load, typingEveryMs: 5, complete: async () => ({ text: '{}', usage: {} }), ...rest });
    const call = (name, args, sessionId) => h.tools.get(name).execute(args, { agent: h.agentsById.get(sessionId) ?? { session: { id: sessionId } } });
    return { h, api, fake, call, home: process.env.DSH_HOME, dispose: () => h.effects.forEach((d) => d()) };
  } finally {
    process.env.DSH_HOME = before;
  }
}

/** Atlas gets a Telegram channel with Kada (chat 42) and Lin (chat 43) paired. */
async function withTelegram(env) {
  const { api, fake } = env;
  const atlas = api.store.find('atlas');
  api.routes.save.post({ bot: { id: atlas.id, apps: [{ template: 'telegram', name: 'Telegram', serverName: 'telegram', enabled: true, values: { token: TG_TOKEN } }] } });
  await settle();
  const c = fake.live()[0];
  const appId = api.store.get(atlas.id).apps[0].id;
  for (const [chat, name] of [['42', 'Kada'], ['43', 'Lin']]) {
    const { code } = await api.routes['channels/code'].post({ botId: atlas.id, appId });
    c.emit({ chatId: chat, messageId: '1', userId: chat, userName: name, text: `/start ${code}`, isDirect: true, mentioned: true });
    await settle();
  }
  c.sent.length = 0;
  const say = (chat, id, text, threadId) => c.emit({ chatId: chat, messageId: String(id), userId: chat, userName: chat === '42' ? 'Kada' : 'Lin', text, isDirect: true, mentioned: true, ...(threadId ? { threadId } : {}) });
  return { c, appId, say, key: (chat) => `telegram:${atlas.id}/${appId}:${chat}` };
}

/** A team (Atlas the router, Forge, Scout) on Telegram, and one task delegated from each of the two chats (`relay`: asking for the reports, 0.8's way). */
async function twoChats({ topic, relay = false } = {}) {
  const back = relay ? { report_to: 'me' } : {};
  const env = boot();
  const { h, api } = env;
  api.store.save({ name: 'Forge', bio: 'Engineer' });
  api.store.save({ name: 'Scout', bio: 'Researcher' });
  const tg = await withTelegram(env);
  tg.say('42', 10, 'Fix the login bug');
  await settle();
  const sid = api.store.find('atlas').sessionId;
  const router = h.agentsById.get(sid);
  const [a] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the login bug.', ...back } }] });
  tg.say('43', 11, 'Write the release notes', topic);
  await settle();
  const [b] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@scout', text: 'Write the release notes for 2.4.', ...back } }] });
  return { ...env, tg, sid, router, ta: api.tickets.get(a.ticket.id), tb: api.tickets.get(b.ticket.id) };
}

test('two chats each delegate a task; each worker answers in its own chat itself, signed, and the Router takes no turn for it (0.9)', async () => {
  const s = await twoChats();
  const { api, tg, router, ta, tb, call } = s;
  await call('bot_send_message', { status: 'done', text: 'Fixed: SameSite=None; Secure.' }, ta.sessionId);
  await call('bot_send_message', { status: 'done', text: 'Notes are in docs/2.4.md.' }, tb.sessionId);
  await settle();
  assert.deepEqual(tg.c.sent, [
    { chatId: '42', text: '【Forge】\nFixed: SameSite=None; Secure.' },
    { chatId: '43', text: '【Scout】\nNotes are in docs/2.4.md.' },
  ]);
  const notes = router.deliveries.filter((d) => /^bots:shown:/.test(d.message.id));
  assert.deepEqual(notes.map((d) => d.mode), ['inject', 'inject']);
  assert.match(textOfMsg(notes[0].message), /went to the person as it is, in Telegram · Kada:/);
  assert.equal(router.inbox.nextStep.length + router.inbox.nextTurn.length, 0, 'nothing for the Router to pass on');
  const atlas = api.store.find('atlas');
  const replies = api.store.messages({ bot: atlas.id }).filter((m) => m.kind === 'reply');
  assert.deepEqual(replies.map((m) => [m.from, m.via, m.thread, m.ticket]), [[ta.botId, 'telegram', tg.key('42'), ta.id], [tb.botId, 'telegram', tg.key('43'), tb.id]]);
  s.dispose();
});

test('with report_to "me", each result returns through the Router to its own chat, in its own turn', async () => {
  const s = await twoChats({ relay: true });
  const { api, h, tg, sid, router, ta, tb, call } = s;
  // The chat message names its Thread for the model; the Router took both by steering.
  const first = router.deliveries.find((d) => /Fix the login bug$/.test(textOfMsg(d.message)));
  assert.equal(first.mode, 'steer');
  assert.equal(first.message.content[0].text, `[Telegram · Kada] (thread ${tg.key('42')})\n`);
  assert.match(first.message.id, /^bots:chat:/);
  assert.deepEqual([ta.origin.threadKey, tb.origin.threadKey], [tg.key('42'), tg.key('43')]);
  assert.deepEqual([ta.threads, tb.threads], [[tg.key('42')], [tg.key('43')]]);
  assert.deepEqual([ta.origin.who, tb.origin.who], ['Kada', 'Lin']);
  await call('bot_send_message', { status: 'done', text: 'Fixed: SameSite=None; Secure.' }, ta.sessionId);
  await h.step(sid, { answer: 'Forge fixed the login bug.' });
  await call('bot_send_message', { status: 'done', text: 'Notes are in docs/2.4.md.' }, tb.sessionId);
  await h.step(sid, { answer: 'Scout wrote the release notes.' });
  await settle();
  assert.deepEqual(tg.c.sent, [
    { chatId: '42', text: 'Forge fixed the login bug.' },
    { chatId: '43', text: 'Scout wrote the release notes.' },
  ]);
  const replies = api.store.messages({ bot: api.store.find('atlas').id }).filter((m) => m.kind === 'reply');
  assert.deepEqual(replies.map((m) => [m.via, m.thread]), [['telegram', tg.key('42')], ['telegram', tg.key('43')]]);
  s.dispose();
});

test('a follow-up on a subscribed Thread goes to the task; the Router only gets an injected notice, which adds no Thread', async () => {
  // Lin's chat has topics: the task belongs to topic t9, not to the whole chat.
  const s = await twoChats({ topic: 't9' });
  const { api, h, tg, sid, router, tb } = s;
  const T = `${tg.key('43')}:t9`;
  const before = router.deliveries.length;
  tg.say('43', 12, 'Mention the new export button too', 't9');
  await settle();
  // No model call for the Router: nothing steered or queued, one notice injected.
  const fresh = router.deliveries.slice(before);
  assert.deepEqual(fresh.map((d) => d.mode), ['inject']);
  assert.equal(router.inbox.nextStep.length + router.inbox.nextTurn.length, 0);
  assert.equal(router.status, 'idle');
  assert.match(textOfMsg(fresh[0].message), new RegExp(`^\\[follow_up\\] Lin in Telegram · Lin · topic wrote about task ${tb.id} \\(@scout, working: .* on thread ${T}:`));
  assert.match(textOfMsg(fresh[0].message), /needs no reply from you/);
  // The task got it as the person's message, with its header.
  const worker = h.agentsById.get(tb.sessionId);
  const got = worker.deliveries.at(-1);
  assert.equal(got.mode, 'steer');
  assert.deepEqual(got.message.source, { kind: 'user' });
  assert.equal(textOfMsg(got.message), `[Telegram · Lin] (thread ${T})\nMention the new export button too`);
  assert.ok(api.tickets.get(tb.id).lastHumanAt > 0);
  assert.ok(api.store.messages({ bot: api.store.find('scout').id }).some((m) => m.kind === 'user' && m.ticket === tb.id && m.via === 'telegram' && m.who === 'Lin'));
  // A leading @handle still reaches the Router on that Thread; the notice claimed with it adds no Thread.
  tg.say('42', 13, '@atlas what else is open?');
  await settle();
  const asked = router.deliveries.at(-1);
  assert.equal(asked.mode, 'steer');
  assert.match(textOfMsg(asked.message), /what else is open\?$/);
  await h.step(sid, { claim: [router.injected.at(-1), ...router.inbox.nextStep.splice(0)], answer: 'Two tasks are open.' });
  await settle();
  assert.deepEqual(tg.c.sent.at(-1), { chatId: '42', text: 'Two tasks are open.' });
  // A done task opens again when its person follows up (before it is archived).
  await s.call('bot_send_message', { status: 'done', text: 'Done.' }, tb.sessionId);
  assert.equal(api.tickets.get(tb.id).ended.outcome, 'done');
  tg.say('43', 14, 'One more fix please', 't9');
  await settle();
  assert.equal(api.tickets.get(tb.id).ended, undefined);
  assert.equal((await api.request('GET', `/__dsh_bots/tickets/${tb.id}`)).stage, 'working');
  s.dispose();
});

test('in a whole chat (a private chat) a task takes a message only while its question is unanswered; anything else is the Router\'s', async () => {
  const s = await twoChats();
  const { api, h, tg, router, tb, call } = s;
  const worker = h.agentsById.get(tb.sessionId);
  const seen = worker.deliveries.length;
  // The task is working: a new message in that private chat is a new request for the Router.
  tg.say('43', 12, 'What is the weather in Lisbon?');
  await settle();
  assert.equal(worker.deliveries.length, seen);
  assert.match(textOfMsg(router.deliveries.at(-1).message), /What is the weather in Lisbon\?$/);
  assert.notEqual(router.deliveries.at(-1).mode, 'inject');
  // The task asks: the next message there is the answer, and goes to the task.
  await call('bot_send_message', { status: 'question', text: 'Which version, 2.4 or 2.4.1?' }, tb.sessionId);
  await settle();
  const before = router.deliveries.length;
  tg.say('43', 13, '2.4.1');
  await settle();
  assert.match(textOfMsg(worker.deliveries.at(-1).message), /2\.4\.1$/);
  assert.deepEqual(router.deliveries.slice(before).map((d) => d.mode), ['inject']);
  // Answered: the chat is the Router's again.
  tg.say('43', 14, 'And thanks!');
  await settle();
  assert.match(textOfMsg(router.deliveries.at(-1).message), /And thanks!$/);
  s.dispose();
});

test('reports from two chats in one turn: plain text stays in the panel (marked), bot_reply sends each answer to its chat', async () => {
  const s = await twoChats({ relay: true });
  const { api, h, tg, sid, ta, tb, call } = s;
  await call('bot_send_message', { status: 'done', text: 'Login fixed.' }, ta.sessionId);
  await call('bot_send_message', { status: 'done', text: 'Notes written.' }, tb.sessionId);
  const results = await h.step(sid, {
    calls: [
      { name: 'bot_reply', args: { ticket: ta.id, text: 'The login bug is fixed.' } },
      { name: 'bot_reply', args: { thread: tg.key('43'), text: 'The release notes are ready.' } },
    ],
    answer: 'Both answered.',
  });
  await settle();
  assert.deepEqual(results.map((r) => r.via), ['telegram', 'telegram']);
  assert.deepEqual(tg.c.sent, [
    { chatId: '42', text: 'The login bug is fixed.' },
    { chatId: '43', text: 'The release notes are ready.' },
  ]);
  const replies = api.store.messages({ bot: api.store.find('atlas').id }).filter((m) => m.kind === 'reply');
  assert.deepEqual(replies.slice(0, 2).map((m) => [m.via, m.thread]), [['telegram', tg.key('42')], ['telegram', tg.key('43')]]);
  // Every chat of the turn got its answer with bot_reply: the closing words reach no one and are not shown (0.9).
  assert.ok(!replies.some((m) => m.text === 'Both answered.'));
  // With one of them left unanswered, plain text stays in the panel, marked with the choices.
  await s.call('bot_send_message', { ticket: ta.id, text: 'One more: the logout bug.' }, sid);
  await s.call('bot_send_message', { status: 'done', text: 'Logout fixed.' }, ta.sessionId);
  await s.call('bot_send_message', { ticket: tb.id, text: 'Add the logout fix to the notes.' }, sid);
  await s.call('bot_send_message', { status: 'done', text: 'Added.' }, tb.sessionId);
  await h.step(sid, { calls: [{ name: 'bot_reply', args: { ticket: ta.id, text: 'Logout fixed too.' } }], answer: 'Both done.' });
  const plain = api.store.messages({ bot: api.store.find('atlas').id }).filter((m) => m.kind === 'reply').at(-1);
  assert.equal(plain.text, 'Both done.');
  assert.equal(plain.via, undefined);
  assert.equal(plain.notSent, true);
  assert.deepEqual(plain.choices, [tg.key('42'), tg.key('43')]);
  tg.c.sent.splice(2);
  // Unknown targets are refused with the valid ones; a task conversation cannot reply to a chat.
  await assert.rejects(s.call('bot_reply', { thread: 'telegram:nope/app:1', text: 'x' }, sid), /no topic or chat thread .* can be reached from here\. This turn has no topic or chat/);
  await assert.rejects(s.call('bot_reply', { text: 'x' }, sid), /say where/);
  await assert.rejects(s.call('bot_reply', { ticket: ta.id, text: 'x' }, ta.sessionId), /task conversation talks to no chat/);
  // Outside a turn, a task's stored chat is still a target.
  const later = await s.call('bot_reply', { ticket: tb.id, text: 'Following up.' }, sid);
  assert.equal(later.thread, tg.key('43'));
  // Two chats in one turn: the task belongs to the one named; naming none is refused with the choices (0.9).
  tg.say('42', 20, '@atlas deploy to staging');
  tg.say('43', 21, '@atlas and update the changelog');
  await settle();
  const home = h.agentsById.get(sid);
  for (const m of home.inbox.nextStep.splice(0)) h.emit('session/event', home.session, { type: 'user/message', data: m });
  const named = await s.call('bot_send_message', { to: '@forge', text: 'Deploy to staging.', thread: tg.key('42') }, sid);
  assert.equal(api.tickets.get(named.ticket.id).origin.threadKey, tg.key('42'));
  await assert.rejects(
    s.call('bot_send_message', { to: '@scout', text: 'Update the changelog.' }, sid),
    (e) => /several topics or chats: say which one this task is for with `thread`/.test(e.message) && e.message.includes(`${tg.key('42')} (Telegram · Kada); ${tg.key('43')} (Telegram · Lin)`),
  );
  h.emit('session/event', home.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await assert.rejects(s.call('bot_send_message', { to: '@forge', text: 'x', thread: tg.key('99') }, sid), /`thread` must be one of this turn's threads/);
  s.dispose();
});

test('a group message on Slack or Discord is its own Thread: the task it starts subscribes to it, the answer goes under it', async () => {
  const env = boot();
  const { h, api, fake } = env;
  api.store.save({ name: 'Forge' });
  const atlas = api.store.find('atlas');
  api.routes.save.post({ bot: { id: atlas.id, apps: [{ template: 'discord', name: 'Discord', serverName: 'discord', enabled: true, values: { token: 'discord-token-value-1234567890' } }] } });
  await settle();
  const c = fake.live()[0];
  const appId = api.store.get(atlas.id).apps[0].id;
  const { code } = await api.routes['channels/code'].post({ botId: atlas.id, appId });
  c.emit({ chatId: 'dm-1', messageId: '100', userId: '77', userName: 'Kada', text: code, isDirect: true, mentioned: true });
  await settle();
  c.emit({ chatId: 'G1', messageId: '5001', userId: '77', userName: 'Kada', text: 'deploy it', isDirect: false, mentioned: true, chatTitle: 'Ops' });
  await settle();
  const sid = api.store.get(atlas.id).sessionId;
  assert.deepEqual(c.typed.at(-1), { chatId: 'G1', threadId: '5001' }, 'typing shows in that Thread');
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Deploy it.' } }] });
  const key = `discord:${atlas.id}/${appId}:G1:5001`;
  const t = api.tickets.get(r.ticket.id);
  assert.equal(t.origin.threadKey, key);
  assert.equal(api.tickets.thread(key).label, 'Discord · Ops · thread');
  await env.call('bot_send_message', { status: 'done', text: 'Deployed.' }, t.sessionId);
  await settle();
  // Into the chain, quoting the message that started it, from Forge itself (0.9).
  assert.deepEqual(c.sent.at(-1), { chatId: 'G1', text: '【Forge】\nDeployed.', threadId: '5001', replyTo: '5001' });
  // A reply in that chain is a follow-up of the task; a new top-level message is a new Thread for the Router.
  c.emit({ chatId: 'G1', messageId: '5002', userId: '77', userName: 'Kada', text: 'and roll back if it fails', isDirect: false, mentioned: true, chatTitle: 'Ops', threadId: '5001' });
  c.emit({ chatId: 'G1', messageId: '5003', userId: '77', userName: 'Kada', text: 'new thing', isDirect: false, mentioned: true, chatTitle: 'Ops' });
  await settle();
  assert.match(textOfMsg(h.agentsById.get(t.sessionId).deliveries.at(-1).message), /and roll back if it fails$/);
  const toRouter = h.agentsById.get(sid).deliveries;
  assert.ok(toRouter.some((d) => d.mode === 'steer' && new RegExp(`\\(thread discord:${atlas.id}/${appId}:G1:5003\\)\\nnew thing$`).test(textOfMsg(d.message))));
  assert.ok(toRouter.some((d) => d.mode === 'inject' && /^\[follow_up\] Kada in Discord · Ops · thread wrote about task/.test(textOfMsg(d.message))));
  env.dispose();
});

test('the watchdog: a quiet worker gets one status check, then is stalled and its requester told (injected clock)', async () => {
  const clock = { t: Date.now() };
  const jobs = [];
  const env = boot({ now: () => clock.t, services: { jobs: { list: (sid) => jobs.filter((j) => j.owner === sid), events: { subscribe: () => () => {} } } } });
  const { h, api } = env;
  api.store.save({ name: 'Forge' });
  const sid = await api.userSend(api.store.find('atlas'), 'Fix the login bug');
  // Asked back (`report_to: "me"`): its requester is the one reminded once it settles.
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the login bug.', report_to: 'me' } }] });
  const t = api.tickets.get(r.ticket.id);
  await h.step(t.sessionId, { answer: 'Looking.' });
  const worker = h.agentsById.get(t.sessionId);
  const router = h.agentsById.get(sid);
  // A background job counts as work: no check while it runs.
  jobs.push({ owner: t.sessionId, status: 'running' });
  clock.t += 21 * 60_000;
  await api.ticketUpkeep(clock.t);
  assert.ok(!worker.deliveries.some((d) => /\[Status check\]/.test(textOfMsg(d.message))));
  jobs.length = 0;
  await api.ticketUpkeep(clock.t);
  const nudge = worker.deliveries.at(-1);
  assert.equal(nudge.mode, 'steer');
  assert.match(textOfMsg(nudge.message), new RegExp(`^\\[Status check\\] Task ${t.id}`));
  assert.equal(api.tickets.get(t.id).nudgedAt, clock.t);
  // Once only.
  const count = worker.deliveries.length;
  clock.t += 5 * 60_000;
  await api.ticketUpkeep(clock.t);
  assert.equal(worker.deliveries.length, count);
  const before = router.deliveries.length;
  clock.t += 16 * 60_000;
  await api.ticketUpkeep(clock.t);
  assert.equal((await api.request('GET', `/__dsh_bots/tickets/${t.id}`)).stage, 'stalled');
  const told = router.deliveries.slice(before);
  assert.equal(told.length, 1);
  assert.equal(told[0].mode, 'steer');
  assert.match(told[0].message.id, new RegExp(`^bots:stalled:${t.id}:`));
  assert.match(textOfMsg(told[0].message), new RegExp(`^\\[Stalled\\] Task ${t.id} \\(@forge: Fix the login bug\\.\\)`));
  assert.ok(api.state().attention.some((x) => x.id === t.id && x.stage === 'stalled'));
  assert.equal(api.slots.holds(t.id), false, 'a stalled task gives its slot back');
  // Every task it waited for settled and the Router said nothing since: one reminder, once.
  clock.t += 2 * 60_000;
  const beforeReminder = router.deliveries.length;
  await api.ticketUpkeep(clock.t);
  await api.ticketUpkeep(clock.t + 60_000);
  const reminders = router.deliveries.slice(beforeReminder).filter((d) => /^\[Reminder\]/.test(textOfMsg(d.message)));
  assert.equal(reminders.length, 1);
  env.dispose();
});

test('a temporary error is retried after 15, 30 and 60 s, then the task fails; other errors fail at once (injected timers)', async () => {
  const timers = [];
  const env = boot({ setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeout: () => {} });
  const { h, api } = env;
  api.store.save({ name: 'Forge' });
  const sid = await api.userSend(api.store.find('atlas'), 'Two things');
  const [r, q] = await h.step(sid, {
    calls: [
      { name: 'bot_send_message', args: { to: '@forge', text: 'Fix the login bug.' } },
      { name: 'bot_send_message', args: { to: '@forge', text: 'Check the billing.' } },
    ],
  });
  const t = api.tickets.get(r.ticket.id);
  const agent = h.agentsById.get(t.sessionId);
  const router = h.agentsById.get(sid);
  const delays = [];
  // As Harness reports a model failure: an LlmError whose `failure` holds the facts.
  const llmError = () => Object.assign(new Error('the provider failed'), { name: 'LlmError', failure: { message: 'Service Unavailable', code: 'PROVIDER_ERROR', status: 503 } });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    h.emit('agent/error', { agent, turn: 1, step: 1, error: llmError() });
    // A second report of the same failure does not schedule a second retry.
    h.emit('agent/error', { agent, turn: 1, step: 1, error: llmError() });
    const pending = timers.filter((x) => x.ms >= 15_000);
    delays.push(pending.at(-1).ms);
    assert.equal(pending.length, attempt);
    pending.at(-1).fn();
    await settle();
    assert.match(textOfMsg(agent.deliveries.at(-1).message), new RegExp(`^\\[Retry ${attempt}\\] The last step of task ${t.id} failed with a temporary error`));
    assert.equal(api.tickets.get(t.id).retries, attempt);
  }
  assert.deepEqual(delays, [15_000, 30_000, 60_000]);
  const before = router.deliveries.length;
  h.emit('agent/error', { agent, turn: 1, step: 1, error: llmError() });
  await settle();
  const failed = api.tickets.get(t.id);
  assert.equal(failed.ended.outcome, 'failed');
  assert.equal(failed.error, 'Service Unavailable');
  const notice = router.deliveries.slice(before);
  assert.equal(notice.length, 1);
  assert.match(textOfMsg(notice[0].message), new RegExp(`^\\[Failed\\] Task ${t.id}`));
  // Out of quota is no temporary error, even as a 429.
  const other = api.tickets.get(q.ticket.id);
  h.emit('agent/error', { agent: h.agentsById.get(other.sessionId), turn: 1, step: 1, error: Object.assign(new Error('insufficient_quota'), { status: 429 }) });
  await settle();
  assert.equal(api.tickets.get(other.id).ended.outcome, 'failed');
  env.dispose();
});

test('after a restart: a worker cut off mid-turn gets one recovery note; a replayed chat message is not run again', async () => {
  // Before: Kada asks in Telegram, the Router delegates, the worker starts and Harness goes down mid-turn.
  const first = boot();
  first.api.store.save({ name: 'Forge' });
  const tg = await withTelegram(first);
  tg.say('42', 30, 'Fix the login bug');
  await settle();
  const atlas = first.api.store.find('atlas');
  const sid = atlas.sessionId;
  const [r] = await first.h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the login bug.' } }] });
  const t = first.api.tickets.get(r.ticket.id);
  const chatId = first.h.agentsById.get(sid).deliveries.find((d) => /Fix the login bug$/.test(textOfMsg(d.message))).message.id;
  first.dispose();

  // The stored logs as Harness kept them: the Router took the chat message; the worker's turn never ended.
  const logs = {
    [sid]: [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'user/message', data: { id: chatId, content: [] } }, { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } }],
    [t.sessionId]: [
      { seq: 0, type: 'turn/start' },
      { seq: 1, type: 'user/message', data: { id: `bots:assign:${t.id}`, content: [{ type: 'text', text: 'New task' }] } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'bash', argsRaw: '{"command":"npm test"}' }] } } },
    ],
  };
  const restart = (extra = {}) =>
    boot({
      home: first.home,
      history: async (id) => logs[id] ?? [],
      pre: (h) => {
        h.addAgent(sid);
        h.addAgent(t.sessionId);
        extra.pre?.(h);
      },
    });
  const second = restart();
  assert.equal(second.api.slots.holds(t.id), true);
  await second.api.startup();
  await second.api.recoverTickets();
  const worker = second.h.agentsById.get(t.sessionId);
  const notes = worker.deliveries.filter((d) => /^\[Recovery\]/.test(textOfMsg(d.message)));
  assert.equal(notes.length, 1, 'one recovery note');
  assert.equal(notes[0].mode, 'steer');
  assert.equal(notes[0].message.id, `bots:recover:${t.id}:t0`);
  assert.match(textOfMsg(notes[0].message), /Do not repeat an outside action that already happened/);
  // The chat app hands the message out again: the replay guard (the highest id seen per chat) drops it.
  const c2 = await (async () => {
    await settle();
    return second.fake.live()[0];
  })();
  const replay = { chatId: '42', messageId: '30', userId: '42', userName: 'Kada', text: 'Fix the login bug', isDirect: true, mentioned: true };
  c2.emit(replay);
  await settle();
  const router = second.h.agentsById.get(sid);
  assert.equal(router.deliveries.length, 0);
  // Without that guard (its record lost), the Router's stored log still has the message: the task it
  // opened, now subscribed to that chat, does not take it as a follow-up either.
  const file = join(first.home, 'cache', 'bots', 'channels.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  for (const rec of Object.values(saved.channels)) delete rec.seen;
  writeFileSync(file, JSON.stringify(saved));
  second.dispose();
  const again = restart();
  await again.api.startup();
  await settle();
  again.fake.live()[0].emit(replay);
  await settle();
  assert.equal(again.h.agentsById.get(sid).deliveries.length, 0);
  assert.equal(again.h.agentsById.get(t.sessionId).deliveries.filter((d) => /Fix the login bug$/.test(textOfMsg(d.message))).length, 0);
  again.dispose();

  // Another restart before the worker read its note (it waits in the durable inbox): nothing new.
  const third = restart({ pre: (h) => h.agentsById.get(t.sessionId).inbox.nextStep.push(notes[0].message) });
  await third.api.startup();
  assert.equal(third.h.agentsById.get(t.sessionId).deliveries.length, 0);
  third.dispose();
  // After it read the note and finished its turn: nothing either.
  logs[t.sessionId].push({ seq: 3, type: 'turn/end', data: { reason: { kind: 'interrupted' } } }, { seq: 4, type: 'turn/start' }, { seq: 5, type: 'user/message', data: { id: notes[0].message.id, content: [] } }, { seq: 6, type: 'turn/end', data: { reason: { kind: 'completed' } } });
  const fourth = restart();
  await fourth.api.startup();
  assert.equal(fourth.h.agentsById.get(t.sessionId).deliveries.length, 0);
  fourth.dispose();
});

test('a lone dispatcher works hands-on; with a teammate it routes, and alone again it is hands-on again', async () => {
  const env = boot();
  const { h, api } = env;
  const atlas = api.store.find('atlas');
  assert.equal(api.state().dispatcher, 'router');
  assert.equal(api.state().routerActive, false);
  const sid = await api.userSend(atlas, 'Hello');
  const home = h.agentsById.get(sid);
  assert.equal(home.deliveries.at(-1).mode, 'followup');
  assert.equal(home.guards.length, 0);
  assert.equal(home.restricts.length, 0);
  assert.match(home.sections.get('bots:persona').text(), /Do small or general tasks yourself/);
  const forge = api.store.save({ name: 'Forge' });
  assert.equal(api.state().routerActive, true);
  assert.equal(home.guards.length, 1);
  assert.ok(home.restricts.at(-1).deny.includes('bash'));
  assert.match(home.sections.get('bots:persona').text(), /You do three things/);
  await api.userSend(api.store.get(atlas.id), 'Now route');
  assert.equal(home.deliveries.at(-1).mode, 'steer');
  assert.equal((await api.routes.delete.post({ id: forge.id })).ok, true);
  assert.equal(api.state().routerActive, false);
  assert.equal(home.guards.length, 0);
  assert.equal(home.restricts.length, 0);
  assert.match(home.sections.get('bots:persona').text(), /Do small or general tasks yourself/);
  env.dispose();
});

test('0.10.1: the Router puts no question cards to the person; the profile still lists every tool Router mode turns off', async () => {
  const ALL = ['bash', 'write', 'edit', 'read', 'web_search', 'web_fetch', 'job_output', 'skill', 'ask_user_question', 'subagent'];
  const env = boot({
    pre: (h) => {
      // As in Harness: what a limit denies is gone from the view, and `restrictableNames` keeps every name.
      const denied = () => new Set([...h.agentsById.values()].flatMap((a) => a.restricts.flatMap((f) => f.deny ?? [])));
      h.ctx.tools.definitions = () => ALL.filter((n) => !denied().has(n)).map((name) => ({ name, description: `${name} does it. More.` }));
      h.ctx.tools.view = () => ({ restrictableNames: new Set(ALL) });
    },
  });
  const { h, api } = env;
  api.store.save({ name: 'Forge' });
  const sid = await api.userSend(api.store.find('atlas'), 'Write the invite; ask me which tone first');
  const home = h.agentsById.get(sid);
  for (const name of ['ask_user_question', 'bash', 'web_search', 'subagent']) assert.ok(home.restricts.at(-1).deny.includes(name), name);
  assert.ok(!home.restricts.at(-1).deny.includes('read'));
  assert.match(home.sections.get('bots:persona').text(), /You put no question cards to the person/);
  // The catalog reads through the Router's home (the only live one), yet lists every tool with its description.
  const cat = await api.request('GET', '/__dsh_bots/catalog');
  assert.deepEqual(cat.tools.map((t) => t.name), [...ALL].sort());
  assert.equal(cat.tools.find((t) => t.name === 'bash').description, 'bash does it.');
  assert.deepEqual(cat.abilities.find((a) => a.id === 'ask').available, ['ask_user_question']);
  assert.deepEqual(cat.abilities.find((a) => a.id === 'web').available, ['web_search', 'web_fetch']);
  assert.ok(cat.routerDeny.includes('ask_user_question'));
  env.dispose();
});

test('0.10.1: a teammate\'s message to the Router opens no task: it goes into the Router\'s conversation, and an answer goes to the task it came from', async () => {
  const env = boot();
  const { h, api, call } = env;
  api.store.save({ name: 'Forge' });
  api.store.save({ name: 'Harbor' });
  const atlas = api.store.find('atlas');
  const sid = await api.userSend(atlas, 'Hello');
  const home = h.agentsById.get(sid);
  // In a task Atlas asked for, naming @atlas is a report, as before.
  const [mine] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@harbor', text: 'Check the calendar.' } }] });
  await assert.rejects(call('bot_send_message', { to: '@atlas', text: 'Done.' }, api.tickets.get(mine.ticket.id).sessionId), /needs a status/);
  // Forge asks Harbor for a sweep: Harbor's task, not Atlas's.
  const fsid = await api.userSend(api.store.find('forge'), 'Get the inbox swept');
  const r = await call('bot_send_message', { to: '@harbor', text: 'Sweep the inbox.' }, fsid);
  const t = api.tickets.get(r.ticket.id);
  const before = api.tickets.list().length;
  // From Harbor's task: delivered to Atlas's home, naming the task.
  const sent = await call('bot_send_message', { to: '@atlas', text: 'Three urgent emails from Acme.' }, t.sessionId);
  assert.equal(sent.ok, true);
  assert.match(sent.text, /opens no task/);
  assert.equal(api.tickets.list().length, before, 'no task for the dispatcher');
  const dm = home.deliveries.at(-1);
  assert.equal(dm.mode, 'steer');
  assert.match(dm.message.id, /^bots:dm:/);
  assert.match(textOfMsg(dm.message), new RegExp(`^Bot message from @harbor \\(Harbor\\), from its task ${t.id} \\("Sweep the inbox\\."\\):`));
  assert.match(textOfMsg(dm.message), new RegExp(`give it with bot_send_message, ticket: ${t.id}\\.\\)$`));
  // Atlas answers on Harbor's task; that reaches Harbor's task conversation.
  await h.step(sid, { claim: home.inbox.nextStep.splice(0), calls: [{ name: 'bot_send_message', args: { ticket: t.id, text: 'Flag them for the person.' } }] });
  assert.match(textOfMsg(h.agentsById.get(t.sessionId).deliveries.at(-1).message), /Flag them for the person\./);
  // From Harbor's own conversation too (a scheduled sweep, say): no task either.
  const harbor = api.store.find('harbor');
  const hsid = await api.userSend(harbor, 'Morning sweep');
  const fromHome = await call('bot_send_message', { to: '@atlas', text: 'Inbox is clear.', thread: 'whatever' }, hsid);
  assert.equal(fromHome.ok, true);
  assert.equal(api.tickets.list().length, before);
  assert.match(textOfMsg(home.deliveries.at(-1).message), /^Bot message from @harbor \(Harbor\):\nInbox is clear\.\n\n\(Reply with bot_send_message to @harbor/);
  env.dispose();
});

test('0.10.1: a note for a conversation in the middle of a turn waits for its end, so it is never the newest input of a step', async () => {
  const env = boot();
  const { h, api, call } = env;
  api.store.save({ name: 'Forge' });
  const sid = await api.userSend(api.store.find('atlas'), 'Fix the cookie bug');
  const router = h.agentsById.get(sid);
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the cookie bug.' } }] });
  const t = api.tickets.get(r.ticket.id);
  const shown = () => router.injected.filter((m) => /^bots:shown:/.test(m.id));
  // Atlas is working (another message, say) when Forge's answer goes to the person.
  router.status = 'running';
  await call('bot_send_message', { status: 'done', text: 'Fixed: SameSite=None; Secure.' }, t.sessionId);
  await settle();
  assert.equal(shown().length, 0, 'held while the turn runs');
  router.status = 'idle';
  h.emit('agent/status', { agent: router, status: 'idle' });
  assert.equal(shown().length, 1, 'in at the turn\'s end');
  assert.equal(router.inbox.nextStep.length + router.inbox.nextTurn.length, 0, 'and it wakes nothing');
  assert.match(textOfMsg(shown()[0]), /^\[Shown\] @forge's report on task/);
  h.emit('agent/status', { agent: router, status: 'idle' });
  assert.equal(shown().length, 1, 'once');
  assert.match(personaText(api.store.find('atlas'), api.store.list(), { dispatcher: 'router' }), /are for you, not the person: never answer them/);
  env.dispose();
});

test('personas: a worker home in router mode expects reports; hands-on text is unchanged; every tool they name exists', async () => {
  const atlas = { id: 'a', name: 'Atlas', handle: 'atlas', role: 'primary', persona: '', skills: [] };
  const forge = { id: 'f', name: 'Forge', handle: 'forge', role: 'bot', persona: '', skills: [] };
  const roster = [atlas, forge];
  const handsOn = personaText(forge, roster, { dispatcher: 'hands-on' });
  assert.equal(personaText(forge, roster, { dispatcher: 'hands-on', tickets: false }), handsOn);
  assert.match(handsOn, /its answer comes back to you as a "Bot message from @…" message/);
  const routed = personaText(forge, roster, { dispatcher: 'router', tickets: true });
  assert.match(routed, /Pass `report_to: "me"` when you need the result back yourself; it then arrives as a "Report from @… on task …" message/);
  assert.doesNotMatch(routed, /comes back to you as a "Bot message from/);
  // The dispatcher's own texts do not change with `tickets`.
  assert.equal(personaText(atlas, roster, { dispatcher: 'router', tickets: true }), personaText(atlas, roster, { dispatcher: 'router' }));
  const env = boot();
  for (const name of ['bot_reply', 'bot_recall', 'bot_ticket']) assert.ok(env.h.tools.has(name), name);
  assert.deepEqual(Object.keys(env.h.tools.get('bot_reply').parameters).sort(), ['text', 'thread', 'ticket']);
  assert.deepEqual(Object.keys(env.h.tools.get('bot_recall').parameters).sort(), ['offset', 'ref']);
  assert.deepEqual(Object.keys(env.h.tools.get('bot_ticket').parameters).sort(), ['action', 'id']);
  assert.deepEqual(env.h.tools.get('bot_ticket').parameters.action.enum, ['stop', 'close', 'retry', 'status']);
  const router = personaText(atlas, roster, { dispatcher: 'router' });
  for (const name of [...router.matchAll(/`(bot_[a-z_]+)`/g)].map((m) => m[1])) assert.ok(env.h.tools.has(name), name);
  env.dispose();
});

/** Atlas routes; P (Forge) opened sub-task C (Scout); S (Scout) is a sibling the Router opened. */
async function family() {
  const env = boot();
  const { h, api } = env;
  api.store.save({ name: 'Forge' });
  api.store.save({ name: 'Scout' });
  const sid = await api.userSend(api.store.find('atlas'), 'Fix the cookie bug and research Safari');
  const [rp, rs] = await h.step(sid, {
    calls: [
      { name: 'bot_send_message', args: { to: '@forge', text: 'Fix the cookie bug.' } },
      { name: 'bot_send_message', args: { to: '@scout', text: 'Research Safari 18.' } },
    ],
  });
  const p = api.tickets.get(rp.ticket.id);
  await h.step(p.sessionId, { answer: 'Looking at the cookie code.', calls: [{ name: 'bot_send_message', args: { to: '@scout', text: 'Which cookie flags does Safari need?' } }] });
  const c = api.tickets.list().find((t) => t.parentId === p.id);
  return { ...env, sid, p, c, s: api.tickets.get(rs.ticket.id) };
}

test('bot_recall: a task conversation reads its task, parent, sub-tasks and Threads, nothing else', async () => {
  const f = await family();
  const { call, sid, p, c, s } = f;
  const read = async (ref, from, extra = {}) => (await call('bot_recall', { ref, ...extra }, from));
  assert.equal((await read(`ticket/${p.id}`, p.sessionId)).card.id, p.id);
  assert.deepEqual((await read(`ticket/${p.id}`, p.sessionId)).card.children, [c.id]);
  assert.equal((await read(`ticket/${c.id}`, p.sessionId)).card.parent, p.id);
  await assert.rejects(read(`ticket/${s.id}`, p.sessionId), /outside this task/);
  assert.deepEqual((await read('tickets', p.sessionId)).items.map((x) => x.id).sort(), [p.id, c.id].sort());
  // Its thread is the panel chat the request came from (0.10: the main chat; a thread only for a reply).
  assert.equal(p.origin.threadKey, `panel:${sid}`);
  assert.equal((await read(`thread/${p.origin.threadKey}`, p.sessionId)).thread.kind, 'panel');
  await assert.rejects(read('thread/panel:session-elsewhere', p.sessionId), /outside this task/);
  // The sub-task reads its parent but not its parent's sibling.
  assert.equal((await read(`ticket/${p.id}`, c.sessionId)).card.id, p.id);
  await assert.rejects(read(`ticket/${s.id}`, c.sessionId), /outside this task/);
  // The Router reads everything; a transcript comes from the runs recorded here.
  assert.equal((await read(`ticket/${s.id}`, sid)).card.id, s.id);
  assert.equal((await read('tickets', sid)).total, 3);
  const transcript = await read(`ticket/${p.id}/transcript`, sid);
  assert.match(transcript.text, /Looking at the cookie code\./);
  assert.match((await read(`ticket/${p.id}/text`, sid)).text, /Fix the cookie bug\./);
  await assert.rejects(read('nonsense', sid), /unknown ref/);
  // memory_search finds tasks by title and report, with the ref to read them.
  const found = await call('memory_search', { query: 'cookie' }, sid);
  assert.ok(found.tickets.includes(p.id));
  assert.match(found.text, new RegExp(`Task ${p.id} \\(@forge, working\\): Fix the cookie bug\\. \\[bot_recall "ticket/${p.id}"\\]`));
  await call('bot_send_message', { status: 'progress', text: 'SameSite=None needs Secure on Safari.' }, s.sessionId);
  const byReport = await call('memory_search', { query: 'samesite secure' }, sid);
  assert.match(byReport.text, new RegExp(`Task ${s.id} .* progress report: .*SameSite=None`));
  const scoped = await call('memory_search', { query: 'safari' }, c.sessionId);
  assert.ok(!scoped.tickets.includes(s.id), 'a task conversation finds only what it may read');
  f.dispose();
});

test('bot_ticket: the requester or Router acts on a task; a task conversation only on its own sub-tasks', async () => {
  const f = await family();
  const { call, h, api, sid, p, c, s } = f;
  await assert.rejects(call('bot_ticket', { id: s.id, action: 'stop' }, c.sessionId), /only on the sub-tasks it opened/);
  await assert.rejects(call('bot_ticket', { id: p.id, action: 'close' }, p.sessionId), /report "done"/);
  await assert.rejects(call('bot_ticket', { id: 'tnope0000', action: 'stop' }, sid), /no task tnope0000/);
  // Scout's own home did not ask for S.
  const scoutHome = await api.userSend(api.store.find('scout'), 'hi');
  await assert.rejects(call('bot_ticket', { id: s.id, action: 'stop' }, scoutHome), /not asked for from this conversation/);
  // The parent asks its idle sub-task how it stands; a running one is left alone.
  const sub = h.agentsById.get(c.sessionId);
  const status = await call('bot_ticket', { id: c.id, action: 'status' }, p.sessionId);
  assert.match(status.text, /Asked @scout for a status report/);
  assert.match(textOfMsg(sub.deliveries.at(-1).message), new RegExp(`^\\[Status request\\] @forge asks how task ${c.id}`));
  sub.status = 'running';
  assert.match((await call('bot_ticket', { id: c.id, action: 'status' }, p.sessionId)).text, /working on task .* right now/);
  sub.status = 'idle';
  // Stop, retry, close.
  const stopped = await call('bot_ticket', { id: c.id, action: 'stop' }, p.sessionId);
  assert.equal(stopped.ticket.stage, 'stopped');
  assert.ok(sub.cancels.length > 0, 'its running turn is cancelled');
  assert.equal(api.tickets.get(c.id).ended.by, 'requester');
  const retried = await call('bot_ticket', { id: c.id, action: 'retry' }, p.sessionId);
  assert.equal(retried.ticket.stage, 'working');
  assert.match(textOfMsg(sub.deliveries.at(-1).message), /^\[Retry\] @forge asked you to take task/);
  const closed = await call('bot_ticket', { id: s.id, action: 'close' }, sid);
  assert.equal(closed.ticket.stage, 'done');
  // A task the user stopped stays stopped for a bot's retry.
  await api.request('POST', `/__dsh_bots/tickets/${p.id}/stop`, {});
  await assert.rejects(call('bot_ticket', { id: p.id, action: 'retry' }, sid), /stopped by the user/);
  f.dispose();
});

test('the watchdog leaves a task alone while a sub-task it waits for still works', async () => {
  const clock = { t: Date.now() };
  const env = boot({ now: () => clock.t });
  const { h, api } = env;
  api.store.save({ name: 'Forge' });
  api.store.save({ name: 'Scout' });
  const sid = await api.userSend(api.store.find('atlas'), 'Fix it');
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the cookie bug.' } }] });
  const p = api.tickets.get(r.ticket.id);
  await h.step(p.sessionId, { calls: [{ name: 'bot_send_message', args: { to: '@scout', text: 'Which cookie flags does Safari need?' } }] });
  const c = api.tickets.list().find((t) => t.parentId === p.id);
  await h.step(c.sessionId, { answer: 'Reading the WebKit notes.' });
  clock.t += 21 * 60_000;
  await api.ticketUpkeep(clock.t);
  const checked = (t) => h.agentsById.get(t.sessionId).deliveries.some((d) => /^\[Status check\]/.test(textOfMsg(d.message)));
  assert.equal(checked(p), false, 'the parent waits for its sub-task');
  assert.equal(checked(c), true, 'the quiet sub-task gets its status check');
  env.dispose();
});

// --- regressions from the 0.8 review ------------------------------------------------------------

test('a queued task stopped while the queue starts others never starts, and keeps no slot (also when stopped mid-start)', async () => {
  const env = boot();
  const { h, api, call } = env;
  api.store.save({ name: 'Forge' });
  api.store.save({ name: 'Scout' });
  await api.routes.settings.post({ patch: { tickets: { maxWorking: 1 } } });
  const sid = await api.userSend(api.store.find('atlas'), 'Three things');
  await h.step(sid);
  const open = async (to, text) => (await call('bot_send_message', { to, text }, sid)).ticket.id;
  const t1 = await open('@forge', 'one');
  const t2 = await open('@scout', 'two');
  const t3 = await open('@scout', 'three');
  assert.deepEqual([t2, t3].map((id) => api.tickets.get(id).startedAt), [undefined, undefined]);
  // Making a Session takes a while: hold it until both stops are in.
  let go;
  const gate = new Promise((r) => (go = r));
  const create = h.services.sessionController.create;
  h.services.sessionController.create = async (o) => (await gate, create(o));
  // More room: the queue starts t2 ...
  await api.routes.settings.post({ patch: { tickets: { maxWorking: 3 } } });
  // ... and while its Session is being made, the user stops it, and the still-queued t3.
  await api.request('POST', `/__dsh_bots/tickets/${t2}/stop`);
  await api.request('POST', `/__dsh_bots/tickets/${t3}/stop`);
  go();
  await api.pump();
  await settle();
  for (const id of [t2, t3]) {
    const t = api.tickets.get(id);
    assert.equal(t.startedAt, undefined, `${id} did not start`);
    assert.equal(t.ended.by, 'user');
    assert.equal(api.slots.holds(id), false, `${id} keeps no slot`);
    assert.equal(h.agentsById.get(`ticket-${id}`)?.deliveries.length ?? 0, 0, `${id} got no assignment`);
  }
  assert.deepEqual([api.slots.count(), api.slots.holds(t1)], [1, true]);
  // The Session made for t2 is recorded, so upkeep archives it with the task.
  assert.equal(api.tickets.get(t2).sessionId, `ticket-${t2}`);
  env.dispose();
});

test('a full house: a bot\'s message to a started task waits for a slot (in order, kept over a restart); a person\'s takes the extra one', async () => {
  const env = boot();
  const { h, api, call, home } = env;
  for (const name of ['Forge', 'Scout', 'Quill']) api.store.save({ name });
  await api.routes.settings.post({ patch: { tickets: { maxWorking: 1 } } });
  const sid = await api.userSend(api.store.find('atlas'), 'Do three things');
  await h.step(sid);
  const open = async (to, text) => (await call('bot_send_message', { to, text }, sid)).ticket.id;
  const t1 = await open('@forge', 'Task one');
  const t2 = await open('@scout', 'Task two');
  const t3 = await open('@quill', 'Task three');
  // t1 asks and goes idle: its slot goes to t2, which asks too: t3 starts.
  const s1 = api.tickets.get(t1).sessionId;
  await h.step(s1, { calls: [{ name: 'bot_send_message', args: { status: 'question', text: 'Which branch?' } }] });
  await api.pump();
  const s2 = api.tickets.get(t2).sessionId;
  await h.step(s2, { calls: [{ name: 'bot_send_message', args: { status: 'question', text: 'Which source?' } }] });
  await api.pump();
  assert.ok(api.tickets.get(t3).sessionId);
  assert.deepEqual([api.slots.count(), api.slots.holds(t3)], [1, true]);
  const w1 = h.agentsById.get(s1);
  const w2 = h.agentsById.get(s2);
  const seen = [w1.deliveries.length, w2.deliveries.length];
  // The Router answers both. A bot may not take the extra slot (it is for a person), so both answers wait.
  const r1 = await call('bot_send_message', { ticket: t1, text: 'main' }, sid);
  assert.match(r1.text, new RegExp(`Added to task ${t1} \\(queued: every worker slot is taken, so it is handed over when one frees\\)`));
  await call('bot_send_message', { ticket: t2, text: 'docs' }, sid);
  await call('bot_send_message', { ticket: t1, text: 'and rebase first' }, sid);
  assert.deepEqual([w1.deliveries.length, w2.deliveries.length], seen, 'nothing delivered');
  assert.equal(api.slots.count(), 1);
  assert.equal((await api.request('GET', `/__dsh_bots/tickets/${t1}`)).stage, 'queued');
  assert.deepEqual(api.tickets.get(t1).parked.map((m) => m.key.split(':')[0]), ['msg', 'msg']);
  // A status request from the Router waits too; the watchdog leaves a waiting task alone.
  assert.match((await call('bot_ticket', { id: t1, action: 'status' }, sid)).text, /waits for a free worker slot/);
  // A person (the panel) may take the extra slot: what waited for t2 goes first, then the person's message.
  await api.request('POST', `/__dsh_bots/tickets/${t2}/message`, { text: 'Use the v2 docs.' });
  await api.pump();
  assert.deepEqual(w2.deliveries.slice(seen[1]).map((d) => textOfMsg(d.message).split('\n').at(-1) || textOfMsg(d.message)), [
    '(Answer in a report: bot_send_message with a status, without "to".)',
    'Use the v2 docs.',
  ]);
  assert.match(textOfMsg(w2.deliveries[seen[1]].message), /\ndocs\n/);
  assert.equal(api.tickets.get(t2).parked, undefined);
  assert.equal(api.slots.count(), 2);
  assert.equal(w1.deliveries.length, seen[0], 't1 still waits');
  env.dispose();

  // After a restart what waits is still on the task, and goes out, in order, once a slot frees.
  const again = boot({ home, pre: (hh) => [sid, s1, s2, api.tickets.get(t3).sessionId].forEach((id) => hh.addAgent(id)) });
  await again.api.startup();
  await again.api.pump();
  const n1 = again.h.agentsById.get(s1);
  assert.equal(n1.deliveries.length, 0);
  assert.equal(again.api.tickets.get(t1).parked.length, 2);
  await again.call('bot_send_message', { status: 'done', text: 'Docs ready.' }, s2);
  await again.api.pump();
  assert.deepEqual(n1.deliveries.map((d) => /\n(main|and rebase first)\n/.exec(textOfMsg(d.message))?.[1]), ['main', 'and rebase first']);
  assert.equal(again.api.tickets.get(t1).parked, undefined);
  assert.equal((await again.api.request('GET', `/__dsh_bots/tickets/${t1}`)).stage, 'working');
  again.dispose();
});

test('the Router passes a report on while it hands out the next step: its words reach the person; answering the task alone stays quiet', async () => {
  const env = boot();
  const { h, api, call } = env;
  api.store.save({ name: 'Forge' });
  api.store.save({ name: 'Scout' });
  const tg = await withTelegram(env);
  tg.say('42', 10, 'Fix the bug, then have Scout write it up');
  await settle();
  const sid = api.store.find('atlas').sessionId;
  // The Router chains the steps itself: it asks for the reports back.
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the bug.', report_to: 'me' } }] });
  await call('bot_send_message', { status: 'done', text: 'Fixed in commit abc.' }, api.tickets.get(r.ticket.id).sessionId);
  const [w] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@scout', text: 'Write up the fix in abc.', report_to: 'me' } }], answer: 'Forge fixed the bug (commit abc). Scout is writing it up.' });
  await settle();
  const replies = () => api.store.messages({ bot: api.store.find('atlas').id }).filter((m) => m.kind === 'reply').map((m) => m.text);
  assert.ok(replies().includes('Forge fixed the bug (commit abc). Scout is writing it up.'));
  assert.deepEqual(tg.c.sent.at(-1), { chatId: '42', text: 'Forge fixed the bug (commit abc). Scout is writing it up.' });
  // A report that arrives in a turn a person started: even when all the Router does is answer that
  // task, its words are for the person.
  const tw = api.tickets.get(w.ticket.id);
  tg.say('42', 11, 'Also add a docs section');
  await settle();
  await call('bot_send_message', { status: 'done', text: 'Write-up in docs/fix.md.' }, tw.sessionId);
  await h.step(sid, { calls: [{ name: 'bot_send_message', args: { ticket: tw.id, text: 'Add a docs section too.' } }], answer: 'Scout wrote it up and adds a docs section.' });
  await settle();
  assert.deepEqual(tg.c.sent.at(-1), { chatId: '42', text: 'Scout wrote it up and adds a docs section.' });
  // Answering a task's question and nothing else: the closing words reach no one.
  const tq = api.tickets.get(tw.id);
  await call('bot_send_message', { status: 'question', text: 'Which docs, user or API?' }, tq.sessionId);
  const sent = tg.c.sent.length;
  await h.step(sid, { calls: [{ name: 'bot_send_message', args: { ticket: tq.id, text: 'The API docs.' } }], answer: 'Answered Scout.' });
  await settle();
  assert.ok(!replies().includes('Answered Scout.'));
  assert.equal(tg.c.sent.length, sent);
  env.dispose();
});

test('restarts: a recovery turn cut off again gets a note of its own; a start whose assignment never landed gets it again', async () => {
  const first = boot();
  first.api.store.save({ name: 'Forge' });
  const sid = await first.api.userSend(first.api.store.find('atlas'), 'go');
  await first.h.step(sid);
  const [r] = await first.h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the login bug.' } }] });
  const t = first.api.tickets.get(r.ticket.id);
  first.dispose();
  const logs = {
    [t.sessionId]: [
      { seq: 0, type: 'turn/start' },
      { seq: 1, type: 'user/message', data: { id: `bots:assign:${t.id}`, content: [] } },
      { seq: 2, type: 'tool/call' },
    ],
  };
  const restart = (pre) => boot({ home: first.home, history: async (id) => logs[id] ?? [], pre: (h) => (h.addAgent(sid), h.addAgent(t.sessionId), pre?.(h)) });
  const ids = (env) => env.h.agentsById.get(t.sessionId).deliveries.map((d) => d.message.id);
  const second = restart();
  await second.api.startup();
  assert.deepEqual(ids(second), [`bots:recover:${t.id}:t0`]);
  second.dispose();
  // Harness closed that turn as interrupted; the worker took the note and was cut off again mid-turn.
  logs[t.sessionId].push({ seq: 3, type: 'turn/end', data: { reason: { kind: 'interrupted' } } }, { seq: 4, type: 'turn/start' }, { seq: 5, type: 'user/message', data: { id: `bots:recover:${t.id}:t0`, content: [] } }, { seq: 6, type: 'tool/call' });
  const third = restart();
  await third.api.startup();
  assert.deepEqual(ids(third), [`bots:recover:${t.id}:t4`]);
  third.dispose();

  // Harness went down after the start was recorded but before the assignment reached the Session.
  logs[t.sessionId] = [];
  const fourth = restart();
  await fourth.api.startup();
  assert.deepEqual(ids(fourth), [`bots:assign:${t.id}`]);
  assert.match(textOfMsg(fourth.h.agentsById.get(t.sessionId).deliveries[0].message), new RegExp(`^New task ${t.id} from @atlas: Fix the login bug\\.`));
  const resent = fourth.h.agentsById.get(t.sessionId).deliveries[0].message;
  fourth.dispose();
  // Still in the inbox at the next start: not sent twice.
  const fifth = restart((h) => h.agentsById.get(t.sessionId).inbox.nextStep.push(resent));
  await fifth.api.startup();
  assert.deepEqual(ids(fifth), []);
  fifth.dispose();
});

test('a Harness helper (subagent) acts as the task or home it descends from; one that cannot be traced acts for no one; a person\'s own conversation is the user', async () => {
  const env = boot();
  const { h, api, call } = env;
  api.store.save({ name: 'Forge' });
  api.store.save({ name: 'Scout' });
  const sid = await api.userSend(api.store.find('atlas'), 'go');
  await h.step(sid);
  const tA = (await call('bot_send_message', { to: '@forge', text: 'Secret project A' }, sid)).ticket.id;
  const tB = api.tickets.get((await call('bot_send_message', { to: '@scout', text: 'Project B' }, sid)).ticket.id);
  const helper = (id, parent) => {
    const a = h.addAgent(id);
    a.session.header = { id, origin: 'subagent', parentSession: parent, delegationDepth: 1 };
    return a;
  };
  // A helper inside task B, and a helper of that helper: both are task B.
  helper('session-sub-b', tB.sessionId);
  helper('session-sub-b2', 'session-sub-b');
  for (const s of ['session-sub-b', 'session-sub-b2']) {
    await assert.rejects(call('bot_recall', { ref: `ticket/${tA}/text` }, s), /outside this task/, s);
    await assert.rejects(call('bot_ticket', { id: tA, action: 'retry' }, s), /only on the sub-tasks it opened/, s);
    assert.deepEqual((await call('memory_search', { query: 'project' }, s)).tickets, [tB.id], s);
  }
  const rep = await call('bot_send_message', { status: 'progress', text: 'Half way.' }, 'session-sub-b2');
  assert.match(rep.text, new RegExp(`Recorded on task ${tB.id}`));
  // A helper whose maker is gone and was no bot's acts for no one.
  helper('session-orphan', 'session-gone');
  await assert.rejects(call('bot_recall', { ref: 'tickets' }, 'session-orphan'), /cannot be traced/);
  await assert.rejects(call('bot_ticket', { id: tA, action: 'stop' }, 'session-orphan'), /cannot be traced/);
  await assert.rejects(call('bot_send_message', { to: '@forge', text: 'hello' }, 'session-orphan'), /cannot be traced/);
  assert.equal(api.tickets.get(tA).ended, undefined);
  // A person's own top-level conversation, and a helper it started, read everything as the user.
  h.addAgent('session-plain').session.header = { id: 'session-plain' };
  helper('session-plain-sub', 'session-plain');
  for (const s of ['session-plain', 'session-plain-sub']) assert.equal((await call('bot_recall', { ref: 'tickets' }, s)).total, 2, s);
  env.dispose();
});

test('ended tasks stay quiet: a sub-task reporting to a finished parent wakes no one; closing cancels the running turn; a closed task\'s late question is not relayed', async () => {
  const clock = { t: Date.now() };
  const env = boot({ now: () => clock.t });
  const { h, api, call } = env;
  api.store.save({ name: 'Forge' });
  api.store.save({ name: 'Scout' });
  const sid = await api.userSend(api.store.find('atlas'), 'go');
  await h.step(sid);
  const p = api.tickets.get((await call('bot_send_message', { to: '@forge', text: 'Parent work' }, sid)).ticket.id);
  await h.step(p.sessionId, { calls: [{ name: 'bot_send_message', args: { to: '@scout', text: 'Sub work' } }] });
  const sub = api.tickets.children(p.id)[0];
  clock.t += 1000;
  await call('bot_send_message', { status: 'done', text: 'Done (the sub-task still runs).' }, p.sessionId);
  await h.step(sid, { answer: 'Forge is done.' });
  const parent = h.agentsById.get(p.sessionId);
  const before = parent.deliveries.length;
  clock.t += 60_000;
  const r = await call('bot_send_message', { status: 'done', text: 'Sub result.' }, sub.sessionId);
  assert.match(r.text, new RegExp(`nobody is told: the task that asked for it, ${p.id}, has ended`));
  assert.equal(parent.deliveries.length, before, 'the finished parent is not woken');
  assert.equal(api.tickets.get(sub.id).reports.at(-1).text, 'Sub result.');
  assert.equal(api.tickets.get(sub.id).ended.outcome, 'done');
  clock.t += 5 * 60_000;
  await api.watch(clock.t);
  assert.equal(parent.deliveries.length, before, 'nor reminded');
  // Closing a task cancels its running turn, as stopping does.
  const t2 = api.tickets.get((await call('bot_send_message', { to: '@forge', text: 'Another thing' }, sid)).ticket.id);
  const w = h.agentsById.get(t2.sessionId);
  w.status = 'running';
  await call('bot_ticket', { id: t2.id, action: 'close' }, sid);
  assert.equal(w.cancels.length, 1);
  w.status = 'idle';
  // What its cut-short turn still says reaches no one.
  const router = h.agentsById.get(sid);
  const seen = router.deliveries.length;
  const late = await call('bot_send_message', { status: 'question', text: 'Should I go on?' }, t2.sessionId);
  assert.match(late.text, /nobody is told: the task has ended \(done\)/);
  assert.equal(router.deliveries.length, seen);
  assert.ok(!api.store.messages({ bot: api.store.find('forge').id }).some((m) => m.text === 'Should I go on?'));
  env.dispose();
});

test('memory_search in a task conversation finds the journal of its own tasks only, and no digests', async () => {
  const f = await family();
  const { call, api, sid, p, c, s } = f;
  const forge = api.store.find('forge');
  api.memory.addJournal({ bot: forge.id, task: 'x1', trigger: 'ticket', ticket: p.id, title: 'Cookie fix', summary: 'Cookie flags for P.' });
  api.memory.addJournal({ bot: forge.id, task: 'x2', trigger: 'ticket', ticket: s.id, title: 'Cookie research', summary: 'Cookie notes for S.' });
  api.memory.addJournal({ bot: forge.id, task: 'x3', trigger: 'user', title: 'Cookie chat', summary: 'Cookie talk with the user.' });
  api.memory.addDigest({ date: '2026-11-16', text: 'Cookie day for everyone.' });
  const inTask = (await call('memory_search', { query: 'cookie' }, c.sessionId)).text;
  assert.match(inTask, /Cookie flags for P\./);
  assert.doesNotMatch(inTask, /Cookie notes for S\.|Cookie talk with the user\.|Digest/);
  const fromRouter = (await call('memory_search', { query: 'cookie' }, sid)).text;
  for (const x of [/Cookie flags for P\./, /Cookie notes for S\./, /Cookie talk with the user\./, /Digest 2026-11-16/]) assert.match(fromRouter, x);
  f.dispose();
});

test('removing a bot stops the tasks it asked for (they stay in the panel), and nothing reaches its archived conversations', async () => {
  const env = boot();
  const { h, api, call } = env;
  api.store.save({ name: 'Forge' });
  api.store.save({ name: 'Scout' });
  const sid = await api.userSend(api.store.find('atlas'), 'go');
  await h.step(sid);
  const p = api.tickets.get((await call('bot_send_message', { to: '@forge', text: 'Fix the cookie bug.' }, sid)).ticket.id);
  await h.step(p.sessionId, { calls: [{ name: 'bot_send_message', args: { to: '@scout', text: 'Which flags does Safari need?' } }] });
  const sub = api.tickets.children(p.id)[0];
  // The user talks to Forge directly; Forge hands a part to Scout from its home.
  const forgeHome = await api.userSend(api.store.find('forge'), 'Look into Firefox too');
  const [fromHome] = await h.step(forgeHome, { calls: [{ name: 'bot_send_message', args: { to: '@scout', text: 'Check Firefox cookies.' } }] });
  const asked = api.tickets.get(fromHome.ticket.id);
  assert.equal(asked.requester.sessionId, forgeHome);
  assert.equal((await api.routes.delete.post({ id: api.store.find('forge').id })).ok, true);
  for (const id of [sub.id, asked.id]) {
    const t = api.tickets.get(id);
    assert.equal(t.ended.outcome, 'stopped', id);
    assert.equal(t.ended.by, 'system');
    assert.match(t.error, /@forge, who asked for it, was removed/);
    assert.equal(t.archivedAt, undefined, 'still in the panel');
  }
  assert.ok(api.tickets.get(p.id).archivedAt, "Forge's own task is archived");
  // The user retries one from the panel; its report finds nobody to wake: not Forge's archived home,
  // even where Harness still resolves an archived conversation.
  h.services.sessionController.resolveAgent = async (id) => (h.agentsById.get(id) ? { agent: h.agentsById.get(id) } : { error: new Error('gone') });
  assert.ok(h.archived.includes(forgeHome));
  await api.request('POST', `/__dsh_bots/tickets/${asked.id}/retry`, {});
  const home = h.agentsById.get(forgeHome);
  const before = home.deliveries.length;
  await call('bot_send_message', { status: 'done', text: 'Firefox needs SameSite too.' }, asked.sessionId);
  assert.equal(home.deliveries.length, before);
  env.dispose();
});

test('an answer in a group without threads quotes the message that started the task, not the latest one there', async () => {
  const env = boot();
  const { h, api, call } = env;
  api.store.save({ name: 'Forge' });
  const tg = await withTelegram(env);
  const group = (id, text) => tg.c.emit({ chatId: '-100', messageId: String(id), userId: '42', userName: 'Kada', text, isDirect: false, mentioned: true, chatTitle: 'Team' });
  group(50, 'Fix the login bug');
  await settle();
  const sid = api.store.find('atlas').sessionId;
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the login bug.' } }] });
  const t = api.tickets.get(r.ticket.id);
  assert.equal(t.origin.replyTo, '50');
  assert.equal(t.origin.threadKey, `${tg.key('-100')}`);
  group(51, 'And what is the weather?');
  await settle();
  await h.step(sid, { answer: 'Sunny.' });
  await settle();
  assert.deepEqual(tg.c.sent.at(-1), { chatId: '-100', text: 'Sunny.', replyTo: '51' });
  await call('bot_send_message', { status: 'done', text: 'Fixed.' }, t.sessionId);
  await settle();
  assert.deepEqual(tg.c.sent.at(-1), { chatId: '-100', text: '【Forge】\nFixed.', replyTo: '50' });
  env.dispose();
});

test('plain text that reached no chat does not count as telling the person: the reminder still comes', async () => {
  const clock = { t: Date.now() };
  const env = boot({ now: () => clock.t });
  const { h, api, call } = env;
  api.store.save({ name: 'Forge' });
  api.store.save({ name: 'Scout' });
  const tg = await withTelegram(env);
  tg.say('42', 10, 'Fix the login bug');
  tg.say('43', 11, 'Write the release notes');
  await settle();
  const sid = api.store.find('atlas').sessionId;
  const [a, b] = await h.step(sid, {
    calls: [
      { name: 'bot_send_message', args: { to: '@forge', text: 'Fix the login bug.', thread: tg.key('42'), report_to: 'me' } },
      { name: 'bot_send_message', args: { to: '@scout', text: 'Write the release notes.', thread: tg.key('43'), report_to: 'me' } },
    ],
  });
  await call('bot_send_message', { status: 'done', text: 'Fixed.' }, api.tickets.get(a.ticket.id).sessionId);
  await call('bot_send_message', { status: 'done', text: 'Written.' }, api.tickets.get(b.ticket.id).sessionId);
  // Two chats in one turn and no bot_reply: the text stays in the panel, marked as sent nowhere.
  await h.step(sid, { answer: 'Both are done.' });
  const plain = api.store.messages({ bot: api.store.find('atlas').id }).filter((m) => m.kind === 'reply').at(-1);
  assert.equal(plain.notSent, true);
  const router = h.agentsById.get(sid);
  const before = router.deliveries.length;
  clock.t += 2 * 60_000;
  await api.watch(clock.t);
  const reminders = router.deliveries.slice(before).filter((d) => /^\[Reminder\]/.test(textOfMsg(d.message)));
  assert.equal(reminders.length, 1);
  env.dispose();
});

test('without agent.inject a note that must not wake the Router is dropped, not steered', async () => {
  const env = boot();
  const { h, api, call } = env;
  api.store.save({ name: 'Forge' });
  const sid = await api.userSend(api.store.find('atlas'), 'go');
  await h.step(sid);
  const t = (await call('bot_send_message', { to: '@forge', text: 'Fix it.' }, sid)).ticket.id;
  const router = h.agentsById.get(sid);
  delete router.inject;
  const before = router.deliveries.length;
  await api.request('POST', `/__dsh_bots/tickets/${t}/stop`, {});
  await settle();
  assert.equal(router.deliveries.length, before);
  assert.equal(router.inbox.nextStep.length + router.inbox.nextTurn.length, 0);
  env.dispose();
});

test('a follow-up handed out again after a restart does not reopen the finished task it already reached', async () => {
  const s = await twoChats({ topic: 't9' });
  const { api, h, tg, sid, ta, tb } = s;
  tg.say('43', 12, 'Mention the export button too', 't9');
  await settle();
  const worker = h.agentsById.get(tb.sessionId);
  const followUpId = worker.deliveries.at(-1).message.id;
  assert.match(followUpId, new RegExp(`^bots:chat:.*:12:${tb.id}$`));
  const noticeId = h.agentsById.get(sid).injected.at(-1).id;
  await s.call('bot_send_message', { status: 'done', text: 'Done.' }, tb.sessionId);
  assert.equal(api.tickets.get(tb.id).ended.outcome, 'done');
  s.dispose();
  // The chat app's record of what it handed out is lost; the logs show the follow-up arrived.
  const file = join(s.home, 'cache', 'bots', 'channels.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  for (const rec of Object.values(saved.channels)) delete rec.seen;
  writeFileSync(file, JSON.stringify(saved));
  const logs = {
    [ta.sessionId]: [{ seq: 0, type: 'user/message', data: { id: `bots:assign:${ta.id}`, content: [] } }, { seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } }],
    [tb.sessionId]: [{ seq: 0, type: 'user/message', data: { id: followUpId, content: [] } }, { seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } }],
    [sid]: [{ seq: 0, type: 'user/message', data: { id: noticeId, content: [] } }, { seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } }],
  };
  const again = boot({ home: s.home, history: async (id) => logs[id] ?? [], pre: (hh) => [sid, ta.sessionId, tb.sessionId].forEach((id) => hh.addAgent(id)) });
  await again.api.startup();
  await settle();
  again.fake.live()[0].emit({ chatId: '43', messageId: '12', userId: '43', userName: 'Lin', text: 'Mention the export button too', isDirect: true, mentioned: true, threadId: 't9' });
  await settle();
  const t = again.api.tickets.get(tb.id);
  assert.equal(t.ended?.outcome, 'done', 'still done');
  assert.equal(again.api.slots.holds(tb.id), false);
  assert.equal(again.h.agentsById.get(tb.sessionId).deliveries.length, 0);
  again.dispose();
});

test('per-Session records go with an archived task and with a topic left behind', async () => {
  const env = boot();
  const { h, api, call } = env;
  api.store.save({ name: 'Forge' });
  const atlas = api.store.find('atlas');
  const sid = await api.userSend(atlas, 'go');
  await h.step(sid, { answer: 'On it.' });
  const t = api.tickets.get((await call('bot_send_message', { to: '@forge', text: 'Fix it.' }, sid)).ticket.id);
  await h.step(t.sessionId, { answer: 'Looking.' });
  assert.equal(api.tracked(t.sessionId).trigger, true);
  assert.equal(api.tracked(sid).trigger, true);
  await call('bot_send_message', { status: 'done', text: 'Fixed.' }, t.sessionId);
  await h.step(sid, { answer: 'Fixed.' });
  // The runs settle (their Sessions are idle) before upkeep archives the task.
  for (const run of [...api.openTasks.values()]) api.finishTask(run);
  await api.routes.settings.post({ patch: { tickets: { archiveHours: 0 } } });
  await api.ticketUpkeep(Date.now() + 1000);
  assert.ok(api.tickets.get(t.id).archivedAt);
  assert.deepEqual(api.tracked(t.sessionId), { trigger: false, answered: false, turn: false, delivered: false, history: false });
  const next = await api.newTopic(api.store.get(atlas.id));
  assert.notEqual(next, sid);
  assert.deepEqual(api.tracked(sid), { trigger: false, answered: false, turn: false, delivered: false, history: false });
  env.dispose();
});

// --- questions a bot asks (ask_user_question): the panel sees and answers them -------------------

/** A user-questions error as the Harness raises it (`UserQuestionError`). */
const questionError = (code) => Object.assign(new Error(code), { name: 'UserQuestionError', code });
const noWindow = () => Promise.reject(questionError('NO_PROVIDER'));
/** One `ask_user_question` through the plugin's answerer; `native` stands for the rest of the chain (the Harness window). */
function askUser(h, agent, questions, { native = () => new Promise(() => {}), signal, wait } = {}) {
  const request = { questions, agent, ...(signal ? { signal } : {}), ...(wait ? { wait } : {}) };
  const [answerer] = h.listeners['user-questions/request'];
  return { request, out: answerer(request, () => native(request)) };
}
const DB_QUESTION = [{ id: 'db', question: 'Which database?', header: 'Storage', options: [{ label: 'Postgres', description: 'A server.' }, { label: 'SQLite' }] }];
const answerRoute = (api, id, answers) => api.request('POST', `/__dsh_bots/asks/${id}/answer`, { answers });

test('a question from a bot\'s home: the panel answers it, the window\'s card is withdrawn, the timeline shows the answer', async () => {
  const env = boot();
  const { h, api } = env;
  // First in the chain, so the Harness window's forwarder does not hold the request first.
  assert.deepEqual(h.onOptions['user-questions/request'], { prepend: true });
  const atlas = api.store.find('atlas');
  const sid = await api.userSend(atlas, 'Plan the launch');
  const agent = h.agentsById.get(sid);
  let windowSignal;
  const { out } = askUser(h, agent, DB_QUESTION, { native: (req) => ((windowSignal = req.signal), new Promise(() => {})) });
  const [ask] = api.state().asks;
  assert.match(ask.id, /^ask-/);
  assert.deepEqual({ ...ask, id: '', at: 0 }, { id: '', botId: atlas.id, sessionId: sid, at: 0, questions: DB_QUESTION });
  assert.equal(api.state().bots.find((b) => b.id === atlas.id).asking, 1);
  assert.equal(api.state().attention.length, 0, 'a home question is no task');
  // Answers that do not fit are refused, and the question keeps waiting.
  for (const [answers, reason] of [
    [[], /one answer for each of the 1 question/],
    [[{ id: 'other', selected: ['SQLite'] }], /answer question "db" exactly once/],
    [[{ id: 'db', selected: ['MySQL'] }], /"MySQL" is not an option of question "db"/],
    [[{ id: 'db', selected: ['Postgres', 'SQLite'] }], /takes one answer/],
    [[{ id: 'db', selected: ['SQLite'], custom: 'Or DuckDB' }], /takes one answer/],
    [[{ id: 'db', selected: [] }], /has no answer/],
  ]) assert.match((await answerRoute(api, ask.id, answers)).reason, reason);
  assert.match((await answerRoute(api, 'ask-nope', [])).reason, /no such question/);
  assert.equal(api.state().asks.length, 1);
  assert.deepEqual(await answerRoute(api, ask.id, [{ id: 'db', selected: ['Postgres'] }]), { ok: true });
  assert.deepEqual(await out, { answers: [{ id: 'db', selected: ['Postgres'] }] });
  assert.equal(windowSignal.aborted, true, 'the window card is withdrawn');
  assert.deepEqual(api.state().asks, []);
  assert.equal(api.state().bots.find((b) => b.id === atlas.id).asking, 0);
  const last = api.store.messages({ bot: atlas.id }).at(-1);
  assert.deepEqual([last.from, last.kind, last.text, last.thread], ['user', 'user', 'Which database?\n→ Postgres', `panel:${sid}`]);
  assert.match((await answerRoute(api, ask.id, [{ id: 'db', selected: ['Postgres'] }])).reason, /no such question/);
  // A free-text answer; a question from another conversation passes straight on.
  const second = askUser(h, agent, [{ id: 'name', question: 'Name it?' }]);
  assert.deepEqual(await answerRoute(api, api.state().asks[0].id, [{ id: 'name', selected: [], custom: '  Apollo ' }]), { ok: true });
  assert.deepEqual(await second.out, { answers: [{ id: 'name', selected: [], custom: 'Apollo' }] });
  const other = askUser(h, { session: { id: 'someone-else' } }, DB_QUESTION, { native: async () => ({ answers: [{ id: 'db', selected: ['SQLite'] }] }) });
  assert.deepEqual(api.state().asks, []);
  assert.deepEqual(await other.out, { answers: [{ id: 'db', selected: ['SQLite'] }] });
  env.dispose();
});

test('the window answers first and the question clears; with no window the panel still can; an abort or a failure ends it', async () => {
  const env = boot();
  const { h, api } = env;
  const agent = h.agentsById.get(await api.userSend(api.store.find('atlas'), 'Plan the launch'));
  // The window answers.
  let answerInWindow;
  const first = askUser(h, agent, DB_QUESTION, { native: () => new Promise((resolve) => (answerInWindow = resolve)) });
  const id = api.state().asks[0].id;
  answerInWindow({ answers: [{ id: 'db', selected: ['SQLite'] }] });
  assert.deepEqual(await first.out, { answers: [{ id: 'db', selected: ['SQLite'] }] });
  assert.deepEqual(api.state().asks, []);
  assert.match((await answerRoute(api, id, [{ id: 'db', selected: ['Postgres'] }])).reason, /no such question/);
  // No window to ask: the question waits for the panel.
  const second = askUser(h, agent, DB_QUESTION, { native: noWindow });
  await settle();
  assert.equal(api.state().asks.length, 1);
  assert.deepEqual(await answerRoute(api, api.state().asks[0].id, [{ id: 'db', selected: ['SQLite'] }]), { ok: true });
  assert.deepEqual(await second.out, { answers: [{ id: 'db', selected: ['SQLite'] }] });
  // The call is aborted (the turn stopped): it ends with the abort's reason and clears.
  const stop = new AbortController();
  const third = askUser(h, agent, DB_QUESTION, { native: noWindow, signal: stop.signal });
  await settle();
  const reason = questionError('ASK_ABORTED');
  stop.abort(reason);
  await assert.rejects(third.out, (e) => e === reason);
  assert.deepEqual(api.state().asks, []);
  // Any other failure of the chain is passed on.
  const fourth = askUser(h, agent, DB_QUESTION, { native: () => Promise.reject(questionError('CALLER_NOT_LIVE')) });
  await assert.rejects(fourth.out, /CALLER_NOT_LIVE/);
  assert.deepEqual(api.state().asks, []);
  env.dispose();
});

test('approvals and plan reviews show in the panel as waiting in the conversation, pass on unchanged, and are not answered there', async () => {
  const env = boot();
  const { h, api } = env;
  const agent = h.agentsById.get(await api.userSend(api.store.find('atlas'), 'Clean up'));
  const approval = [{ id: 'perm', question: 'Allow rm -rf build?', detail: 'Deletes the build folder.', options: [{ label: 'Allow' }, { label: 'Deny' }], intent: { kind: 'approval', approve: 'Allow', reject: 'Deny' } }];
  let seen;
  let answerInWindow;
  const { request, out } = askUser(h, agent, approval, { native: (req) => ((seen = req), new Promise((resolve) => (answerInWindow = resolve))) });
  assert.equal(seen, request);
  assert.equal(request.signal, undefined, 'passed on unchanged');
  const [ask] = api.state().asks;
  assert.equal(ask.native, true);
  assert.deepEqual(ask.questions, [{ id: 'perm', question: 'Allow rm -rf build?' }]);
  assert.match((await answerRoute(api, ask.id, [{ id: 'perm', selected: ['Allow'] }])).reason, /answered in the conversation/);
  answerInWindow({ answers: [{ id: 'perm', selected: ['Deny'] }] });
  assert.deepEqual(await out, { answers: [{ id: 'perm', selected: ['Deny'] }] });
  assert.deepEqual(api.state().asks, []);
  // With no window, a plan review fails as it does without the plugin.
  const review = [{ id: 'plan', question: 'Approve the plan?', detail: '1. Do it', options: [{ label: 'Approve' }, { label: 'Revise' }], intent: { kind: 'plan-review', approve: 'Approve' } }];
  await assert.rejects(askUser(h, agent, review, { native: noWindow }).out, /NO_PROVIDER/);
  assert.deepEqual(api.state().asks, []);
  env.dispose();
});

test('a task waiting on its question needs you (attention and its row), and the watchdog leaves it alone', async () => {
  const clock = { t: Date.now() };
  const env = boot({ now: () => clock.t });
  const { h, api } = env;
  api.store.save({ name: 'Forge' });
  const sid = await api.userSend(api.store.find('atlas'), 'Fix the login bug');
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the login bug.' } }] });
  const t = api.tickets.get(r.ticket.id);
  await h.step(t.sessionId, { answer: 'Looking.' });
  const worker = h.agentsById.get(t.sessionId);
  const forge = api.store.find('forge');
  // Asked while its Session reads idle (a question past its timed wait leaves the turn).
  const { out } = askUser(h, worker, DB_QUESTION, { native: noWindow });
  await settle();
  const state = api.state();
  assert.equal(state.asks[0].ticketId, t.id);
  assert.equal(state.bots.find((b) => b.id === forge.id).asking, 0, 'a task\'s question counts under attention, not on the bot');
  assert.deepEqual(state.attention.map((x) => [x.id, x.stage, x.asking]), [[t.id, 'working', true]]);
  assert.equal((await api.request('GET', `/__dsh_bots/tickets?bot=${forge.id}`)).items[0].asking, true);
  assert.equal((await api.request('GET', `/__dsh_bots/tickets/${t.id}`)).asking, true);
  clock.t += 21 * 60_000;
  await api.ticketUpkeep(clock.t);
  const checks = () => worker.deliveries.filter((d) => /^\[Status check\]/.test(textOfMsg(d.message))).length;
  assert.equal(checks(), 0, 'no status check while it waits for the person');
  assert.deepEqual(await answerRoute(api, state.asks[0].id, [{ id: 'db', selected: ['Postgres'] }]), { ok: true });
  await out;
  const logged = api.store.messages({ bot: forge.id }).at(-1);
  assert.deepEqual([logged.from, logged.ticket, logged.thread], ['user', t.id, undefined]);
  assert.equal(api.state().attention.length, 0);
  assert.equal((await api.request('GET', `/__dsh_bots/tickets/${t.id}`)).asking, undefined);
  await api.ticketUpkeep(clock.t);
  assert.equal(checks(), 1, 'answered, it is judged as before');
  env.dispose();
});

test('a question in a turn that came from a chat is posted to that chat once, as plain text; a task\'s goes to the chat it came from', async () => {
  const s = await twoChats();
  const { h, api, tg, sid, ta } = s;
  tg.c.sent.length = 0;
  let pending;
  h.tools.set('ask_user_question', { name: 'ask_user_question', execute: async (args, exec) => ((pending = askUser(h, exec.agent, args.questions, { native: noWindow })), {}) });
  tg.say('42', 20, 'Set up the database');
  await settle();
  await h.step(sid, { calls: [{ name: 'ask_user_question', args: { questions: DB_QUESTION } }] });
  await settle();
  assert.deepEqual(tg.c.sent, [{ chatId: '42', text: 'Atlas (@atlas) is waiting for your answer in DeepSeek Harness:\n\nStorage: Which database?\n• Postgres\n• SQLite\n\nAnswer it in DeepSeek Harness; a reply here does not answer it.' }]);
  assert.deepEqual(await answerRoute(api, api.state().asks[0].id, [{ id: 'db', selected: ['SQLite'] }]), { ok: true });
  await pending.out;
  await settle();
  assert.equal(tg.c.sent.length, 1, 'once');
  // Forge's task came from Kada's chat: its question is posted there.
  const task = askUser(h, h.agentsById.get(ta.sessionId), [{ id: 'q', question: 'Keep the old cookie?', options: [{ label: 'Yes' }, { label: 'No' }] }], { native: noWindow });
  await settle();
  assert.equal(tg.c.sent.length, 2);
  assert.equal(tg.c.sent[1].chatId, '42');
  assert.match(tg.c.sent[1].text, /^Forge \(@forge\) is waiting for your answer in DeepSeek Harness:\n\nKeep the old cookie\?\n• Yes\n• No\n/);
  assert.deepEqual(await answerRoute(api, api.state().asks[0].id, [{ id: 'q', selected: ['No'] }]), { ok: true });
  await task.out;
  s.dispose();
});

test('a timed question past its wait stays answerable: the panel answers through userQuestions.answer; a reply in the conversation clears it', async () => {
  const answered = [];
  const env = boot({ services: { userQuestions: { answer: async (agent, callId, answer) => (answered.push({ agent, callId, answer }), true) } } });
  const { h, api } = env;
  const sid = await api.userSend(api.store.find('atlas'), 'Plan the launch');
  const agent = h.agentsById.get(sid);
  const wait = new AbortController();
  const { out } = askUser(h, agent, DB_QUESTION, { native: noWindow, signal: wait.signal, wait: { callId: 'call-1', timed: true } });
  await settle();
  wait.abort(questionError('ASK_TIMED_OUT'));
  await assert.rejects(out, /ASK_TIMED_OUT/);
  const [ask] = api.state().asks;
  assert.equal(ask.continued, true);
  assert.deepEqual(await answerRoute(api, ask.id, [{ id: 'db', selected: ['Postgres'] }]), { ok: true });
  assert.deepEqual(answered, [{ agent, callId: 'call-1', answer: { answers: [{ id: 'db', selected: ['Postgres'] }] } }]);
  assert.deepEqual(api.state().asks, []);
  // Answered in the conversation instead: its reply clears the question here.
  const again = new AbortController();
  const second = askUser(h, agent, DB_QUESTION, { native: () => Promise.reject(questionError('ASK_TIMED_OUT')), signal: again.signal, wait: { callId: 'call-2', timed: true } });
  await assert.rejects(second.out, /ASK_TIMED_OUT/);
  assert.equal(api.state().asks[0].continued, true);
  h.emit('session/event', agent.session, { type: 'user/message', seq: 999, time: Date.now(), data: { id: 'm-reply', content: [{ type: 'text', text: '{}' }], source: { kind: 'user-question-reply', callId: 'call-2', outcome: 'answered' } } });
  assert.deepEqual(api.state().asks, []);
  env.dispose();
});
