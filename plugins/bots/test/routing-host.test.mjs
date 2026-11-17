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
    on(name, fn) {
      (listeners[name] ??= []).push(fn);
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
  return { ctx, tools, agentsById, archived, effects, emit, step, addAgent, services };
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

/** A team (Atlas the router, Forge, Scout) on Telegram, and one task delegated from each of the two chats. */
async function twoChats({ topic } = {}) {
  const env = boot();
  const { h, api } = env;
  api.store.save({ name: 'Forge', bio: 'Engineer' });
  api.store.save({ name: 'Scout', bio: 'Researcher' });
  const tg = await withTelegram(env);
  tg.say('42', 10, 'Fix the login bug');
  await settle();
  const sid = api.store.find('atlas').sessionId;
  const router = h.agentsById.get(sid);
  const [a] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the login bug.' } }] });
  tg.say('43', 11, 'Write the release notes', topic);
  await settle();
  const [b] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@scout', text: 'Write the release notes for 2.4.' } }] });
  return { ...env, tg, sid, router, ta: api.tickets.get(a.ticket.id), tb: api.tickets.get(b.ticket.id) };
}

test('two chats each delegate a task; each result returns to its own chat, in its own turn', async () => {
  const s = await twoChats();
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
  const s = await twoChats();
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
  const plain = replies.at(-1);
  assert.equal(plain.text, 'Both answered.');
  assert.equal(plain.via, undefined);
  assert.equal(plain.notSent, true);
  assert.deepEqual(plain.choices, [tg.key('42'), tg.key('43')]);
  // Unknown targets are refused with the valid ones; a task conversation cannot reply to a chat.
  await assert.rejects(s.call('bot_reply', { thread: 'telegram:nope/app:1', text: 'x' }, sid), /no chat thread .* can be reached from here\. This turn has no chat/);
  await assert.rejects(s.call('bot_reply', { text: 'x' }, sid), /say where/);
  await assert.rejects(s.call('bot_reply', { ticket: ta.id, text: 'x' }, ta.sessionId), /task conversation talks to no chat/);
  // Outside a turn, a task's stored chat is still a target.
  const later = await s.call('bot_reply', { ticket: tb.id, text: 'Following up.' }, sid);
  assert.equal(later.thread, tg.key('43'));
  // Two chats in one turn, and the task belongs to the one named, else to none.
  tg.say('42', 20, '@atlas deploy to staging');
  tg.say('43', 21, '@atlas and update the changelog');
  await settle();
  const [named, none] = await h.step(sid, {
    calls: [
      { name: 'bot_send_message', args: { to: '@forge', text: 'Deploy to staging.', thread: tg.key('42') } },
      { name: 'bot_send_message', args: { to: '@scout', text: 'Update the changelog.' } },
    ],
  });
  assert.equal(api.tickets.get(named.ticket.id).origin.threadKey, tg.key('42'));
  assert.equal(api.tickets.get(none.ticket.id).origin.threadKey, undefined);
  assert.deepEqual(api.tickets.get(none.ticket.id).threads, []);
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
  await h.step(sid, { answer: 'Deployed.' });
  await settle();
  // Into the chain, quoting the message that started it (what the Thread's latest message told the hub).
  assert.deepEqual(c.sent.at(-1), { chatId: 'G1', text: 'Deployed.', threadId: '5001', replyTo: '5001' });
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
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the login bug.' } }] });
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

test('personas: a worker home in router mode expects reports; hands-on text is unchanged; every tool they name exists', async () => {
  const atlas = { id: 'a', name: 'Atlas', handle: 'atlas', role: 'primary', persona: '', skills: [] };
  const forge = { id: 'f', name: 'Forge', handle: 'forge', role: 'bot', persona: '', skills: [] };
  const roster = [atlas, forge];
  const handsOn = personaText(forge, roster, { dispatcher: 'hands-on' });
  assert.equal(personaText(forge, roster, { dispatcher: 'hands-on', tickets: false }), handsOn);
  assert.match(handsOn, /its answer comes back to you as a "Bot message from @…" message/);
  const routed = personaText(forge, roster, { dispatcher: 'router', tickets: true });
  assert.match(routed, /its answer comes back to you as a "Report from @… on task …" message/);
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
  assert.equal((await read(`thread/panel:${sid}`, p.sessionId)).thread.kind, 'panel');
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
