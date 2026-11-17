/**
 * Bots 0.10: threads (PLAN-0.10 §7) — the panel chat is one flat conversation; a reply to a message
 * is a thread, talked over in the bot's conversation forked at that message (it sees what came before,
 * nothing the main chat said since, and what is said there stays there); a thread on a task's message
 * goes to the task; chat app threads follow the same rule.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bots-threads-'));
const { apply } = await import('../index.js');
const { personaText } = await import('../lib/prompt.mjs');
const { createStore } = await import('../lib/store.mjs');

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
  const forks = [];
  /** Every session event, as `{sessionId, event}`. */
  const events = [];
  const emit = (n, ...a) => {
    if (n === 'session/event') events.push({ sessionId: a[0]?.id, event: a[1] });
    (listeners[n] ?? []).forEach((fn) => fn(...a));
  };
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
      /** Harness's fork: a new Session with the source's log up to `atSeq` (or its latest turn). */
      async fork({ sessionId, atSeq }) {
        if (!agentsById.has(sessionId)) throw new Error(`session ${sessionId} not found`);
        forks.push(atSeq === undefined ? { sessionId } : { sessionId, atSeq });
        const id = `session-fork-${forks.length}`;
        const agent = makeAgent(id);
        agentsById.set(id, agent);
        for (const fn of listeners['agent/created'] ?? []) fn({ agent });
        return { sessionId: id };
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
      async unarchiveSession(id) {
        if (archived.includes(id)) archived.splice(archived.indexOf(id), 1);
      },
    },
    ...extra,
  };
  const ctx = {
    tools: {
      register: (t) => (tools.set(t.name, t), () => tools.delete(t.name)),
      definitions: () => ['bash', 'write', 'edit', 'read', 'web_search', 'job_output', 'skill', 'subagent', 'wait_agent'].map((name) => ({ name, description: `${name}.` })),
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
  return { ctx, tools, agentsById, archived, effects, emit, step, addAgent, services, listeners, onOptions, forks, events };
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
            return { ids: [`m${c.sent.length}`] };
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
  process.env.DSH_HOME = home ?? mkdtempSync(join(tmpdir(), 'bots-threads-'));
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


const sendPanel = (api, bot, text, replyTo) => api.panelSend(bot, text, replyTo ? { replyTo } : {});
const chatOf = (api, bot) => api.request('GET', `/__dsh_bots/messages?bot=${bot.id}`);

const threadOf = (api, bot, root) => api.request('GET', `/__dsh_bots/messages?bot=${bot.id}&topic=${root}`);
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));
/** The seq of the first event in `sessionId` of `type` whose data mentions `text` (any, when none). */
const seqOf = (h, sessionId, type, text = '') => h.events.find((e) => e.sessionId === sessionId && e.event.type === type && (!text || JSON.stringify(e.event.data).includes(text)))?.event.seq;

/** Atlas (the router) and Forge; one panel message from the person, not yet taken by the model. */
async function team() {
  const env = boot();
  const { api } = env;
  api.store.save({ name: 'Forge', bio: 'Engineer' });
  const atlas = api.store.find('atlas');
  const first = await sendPanel(api, atlas, '帮我查一下北京工作居住证办理条件');
  const sid = first.sessionId;
  return { ...env, atlas, forge: api.store.find('forge'), sid, router: env.h.agentsById.get(sid), first: first.message };
}

/** Forge's chat: an answer that offers something, and the main chat moving on after it. */
async function forgeChat(opts = {}) {
  const env = boot(opts);
  const { api, h } = env;
  const forge = api.store.save({ name: 'Forge', bio: 'Engineer' });
  const home = (await sendPanel(api, forge, '这个任务花了多少 token？')).sessionId;
  await h.step(home, { answer: '约 39.5 万。要不要我写个小脚本？' });
  await sendPanel(api, forge, '先不用');
  await h.step(home, { answer: '好。' });
  const chat = await chatOf(api, forge);
  return { ...env, forge, home, chat, offer: chat.items.find((m) => m.text.startsWith('约 39.5 万')) };
}

/** Atlas gets a Telegram channel with Kada (chat 42) paired. */
async function withTelegram(env) {
  const { api, fake } = env;
  const atlas = api.store.find('atlas');
  api.routes.save.post({ bot: { id: atlas.id, apps: [{ template: 'telegram', name: 'Telegram', serverName: 'telegram', enabled: true, values: { token: TG_TOKEN } }] } });
  await settle();
  const c = fake.live()[0];
  const appId = api.store.get(atlas.id).apps[0].id;
  const { code } = await api.routes['channels/code'].post({ botId: atlas.id, appId });
  c.emit({ chatId: '42', messageId: '1', userId: '42', userName: 'Kada', text: `/start ${code}`, isDirect: true, mentioned: true });
  await settle();
  c.sent.length = 0;
  const say = (id, text, threadId) => c.emit({ chatId: '42', messageId: String(id), userId: '42', userName: 'Kada', text, isDirect: true, mentioned: true, ...(threadId ? { threadId } : {}) });
  return { c, appId, say, key: (root) => `telegram:${atlas.id}/${appId}:42${root ? `:${root}` : ''}` };
}

test('a panel message goes to the main chat at once, pending until a model takes it, logged once; the router sees the panel, no thread id', async () => {
  const env = await team();
  const { api, h, atlas, sid, router, first } = env;
  assert.match(first.id, /^p[a-z0-9]{8}$/);
  assert.deepEqual([first.topic, first.thread, first.chat, first.pending, first.sid], [undefined, `panel:${sid}`, atlas.id, true, undefined]);
  const got = router.deliveries.at(-1);
  assert.equal(got.mode, 'steer');
  assert.equal(got.message.id, `bots:panel:${first.id}`);
  assert.equal(textOfMsg(got.message), '[Panel]\n帮我查一下北京工作居住证办理条件');
  const second = (await sendPanel(api, atlas, '帮我查一下上海落户条件')).message;
  assert.equal(second.pending, true);
  await h.step(sid, { answer: '两件我都记下了。' });
  const chat = await chatOf(api, atlas);
  assert.deepEqual(
    chat.items.map((m) => [m.from === 'user' ? 'user' : 'atlas', m.topic ?? null, m.pending ?? false]),
    [['user', null, false], ['user', null, false], ['atlas', null, false]],
  );
  assert.deepEqual(chat.threads, {});
  env.dispose();
});

test('a reply to a bot\'s message is a thread: its conversation forked at that message, with a note; the chat lists it quoted, and the main chat hears of it with the next message there', async () => {
  const env = await forgeChat();
  const { api, h, forge, home, offer } = env;
  const r = await sendPanel(api, forge, '什么情况下你会这么做？', offer.id);
  assert.deepEqual(h.forks, [{ sessionId: home, atSeq: seqOf(h, home, 'assistant/message', '要不要我写个小脚本') }]);
  assert.equal(r.sessionId, 'session-fork-1');
  assert.deepEqual([r.message.topic, r.message.thread, r.message.replyTo], [offer.id, `panel:${home}:${offer.id}`, undefined]);
  const branch = h.agentsById.get(r.sessionId);
  const got = branch.deliveries.at(-1);
  assert.equal(got.mode, 'followup');
  assert.equal(
    textOfMsg(got.message),
    '[Thread] From here on this is a thread: the user replies to this message of @forge above: "约 39.5 万。要不要我写个小脚本？". Answer about it.\nWhat the main conversation said after that message is not visible here.\n什么情况下你会这么做？',
  );
  // The home heard nothing of it.
  assert.equal(h.agentsById.get(home).inbox.nextTurn.length, 0);
  // The fork is Forge at work: its persona.
  assert.ok(branch.sections.size > 0);
  await h.step(r.sessionId, { answer: '当你会反复问同一个数字的时候。' });
  const chat = await chatOf(api, forge);
  // The chat as it was said, a reply in the thread quoting what it answers: the person the message they replied to, the bot the person.
  assert.deepEqual(
    chat.items.map((m) => [m.text, m.quote ? [m.quote.id === offer.id ? 'offer' : m.quote.from === 'user' ? 'user' : m.quote.id, m.quote.text] : null]),
    [
      ['这个任务花了多少 token？', null],
      ['约 39.5 万。要不要我写个小脚本？', null],
      ['先不用', null],
      ['好。', null],
      ['什么情况下你会这么做？', ['offer', '约 39.5 万。要不要我写个小脚本？']],
      ['当你会反复问同一个数字的时候。', ['user', '什么情况下你会这么做？']],
    ],
  );
  assert.deepEqual(pick(chat.threads[offer.id], ['key', 'count', 'unread', 'running', 'last']), { key: `panel:${home}:${offer.id}`, count: 2, unread: 1, running: false, last: { from: forge.id, text: '当你会反复问同一个数字的时候。' } });
  const thread = await threadOf(api, forge, offer.id);
  assert.deepEqual(thread.items.map((m) => m.text), ['约 39.5 万。要不要我写个小脚本？', '什么情况下你会这么做？', '当你会反复问同一个数字的时候。']);
  // Quoting a message inside the thread stays in it: same Session, no note, the quote instead.
  const again = await sendPanel(api, forge, '那现在呢？', thread.items.at(-1).id);
  assert.equal(again.sessionId, r.sessionId);
  assert.equal(h.forks.length, 1);
  assert.deepEqual([again.message.topic, again.message.replyTo], [offer.id, thread.items.at(-1).id]);
  assert.equal(textOfMsg(branch.deliveries.at(-1).message), '[Panel]\nIn reply to @forge: "当你会反复问同一个数字的时候。"\n那现在呢？');
  assert.deepEqual(pick((await chatOf(api, forge)).items.find((m) => m.id === again.message.id).quote, ['id', 'from', 'text']), { id: thread.items.at(-1).id, from: forge.id, text: '当你会反复问同一个数字的时候。' });
  // Looked at: nothing unread.
  assert.deepEqual(await api.request('POST', '/__dsh_bots/threads/seen', { bot: forge.id, root: offer.id }), { ok: true, unread: 0 });
  assert.equal((await chatOf(api, forge)).threads[offer.id].unread, 0);
  // The home's topic bookkeeping is the home's alone.
  assert.equal(api.topics.peek(forge.id).sessionId, home);
  // The next message in the main chat: the home hears first what the person read in the thread, once.
  await h.step(again.sessionId, { answer: '现在也一样。' });
  await sendPanel(api, forge, '那就先这样');
  assert.equal(
    textOfMsg(h.agentsById.get(home).deliveries.at(-1).message),
    [
      '[Threads] Since your last message here, the user replied to messages of this chat in threads (each its own conversation, which answered there). So you know what was said; nothing to answer:',
      '- On your message: "约 39.5 万。要不要我写个小脚本？"',
      '  The user: "什么情况下你会这么做？"',
      '  You: "当你会反复问同一个数字的时候。"',
      '  The user: "那现在呢？"',
      '  You: "现在也一样。"',
      '那就先这样',
    ].join('\n'),
  );
  await sendPanel(api, forge, '还有一件事');
  assert.equal(textOfMsg(h.agentsById.get(home).deliveries.at(-1).message), '还有一件事');
  env.dispose();
});

test('a reply to the person\'s own message forks after the answer it got; an older message is found in the log by time', async () => {
  const history = new Map();
  const env = await forgeChat({ history: async (sid) => history.get(sid) ?? null });
  const { api, h, forge, home, chat } = env;
  const ask = chat.items.find((m) => m.text === '这个任务花了多少 token？');
  await sendPanel(api, forge, '我是说调研那个任务', ask.id);
  const firstEnd = h.events.find((e) => e.sessionId === home && e.event.type === 'turn/end').event.seq;
  assert.deepEqual(h.forks.at(-1), { sessionId: home, atSeq: firstEnd });
  // A message from before 0.10 has no anchor: its place is read from the conversation's log.
  history.set(home, [
    { seq: 0, time: 1000, type: 'session/created' },
    { seq: 1, time: 2000, type: 'assistant/message' },
    { seq: 2, time: 9000, type: 'user/message' },
  ]);
  const old = api.store.log({ from: forge.id, to: 'user', kind: 'reply', text: 'old words', thread: `panel:${home}`, at: 2100 });
  await sendPanel(api, forge, 'about the old words', old.id);
  assert.deepEqual(h.forks.at(-1), { sessionId: home, atSeq: 1 });
  // Nowhere to be found: the bot's conversation as it is now.
  const lost = api.store.log({ from: forge.id, to: 'user', kind: 'reply', text: 'lost words', thread: 'panel:session-gone', at: 2100 });
  await sendPanel(api, forge, 'about the lost words', lost.id);
  assert.deepEqual(h.forks.at(-1), { sessionId: home });
  env.dispose();
});

test('a reply to a task\'s message goes to the task; its later reports show in that thread, not the main chat', async () => {
  const env = await team();
  const { api, h, atlas, forge, sid, call } = env;
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Look it up.' } }], answer: '已交给 @forge。' });
  const t = api.tickets.get(r.ticket.id);
  assert.equal(t.origin.threadKey, `panel:${sid}`);
  await h.step(t.sessionId, { answer: '' });
  await call('bot_send_message', { status: 'question', text: '要查哪个区？' }, t.sessionId);
  let chat = await chatOf(api, atlas);
  const q = chat.items.find((m) => m.ticket === t.id && m.status === 'question');
  assert.deepEqual([q.from, q.topic], [forge.id, undefined], 'the worker asks in the main chat itself');
  const sent = await sendPanel(api, atlas, '海淀', q.id);
  assert.equal(sent.sessionId, t.sessionId);
  assert.deepEqual([sent.message.topic, sent.message.ticket], [q.id, t.id]);
  assert.equal(api.tickets.get(t.id).showIn, `panel:${sid}:${q.id}`);
  assert.equal(h.forks.length, 0);
  await h.step(t.sessionId, { answer: '' });
  await call('bot_send_message', { status: 'done', text: '海淀：材料一样，窗口不同。' }, t.sessionId);
  chat = await chatOf(api, atlas);
  // In the chat as said, quoting the person's message it answers.
  assert.deepEqual(pick(chat.items.find((m) => m.text === '海淀：材料一样，窗口不同。').quote, ['from', 'text']), { from: 'user', text: '海淀' });
  assert.deepEqual(chat.threads[q.id].tickets.map((x) => x.id), [t.id]);
  const thread = await threadOf(api, atlas, q.id);
  assert.deepEqual(thread.items.map((m) => m.text), ['要查哪个区？', '海淀', '海淀：材料一样，窗口不同。']);
  env.dispose();
});

test('a thread of the dispatcher is a dispatcher too; a task it opens answers in the thread', async () => {
  const env = await team();
  const { api, h, atlas, sid, call } = env;
  await h.step(sid, { answer: '北京工作居住证主要看单位资质。' });
  const answer = (await chatOf(api, atlas)).items.find((m) => m.kind === 'reply');
  const r = await sendPanel(api, atlas, '帮我细查海淀', answer.id);
  const branch = h.agentsById.get(r.sessionId);
  assert.ok((branch.restricts.at(-1)?.deny ?? []).includes('web_search'));
  assert.equal(branch.guards.length, 1);
  assert.equal(branch.deliveries.at(-1).mode, 'steer');
  const [o] = await h.step(r.sessionId, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: '细查海淀' } }] });
  const t = api.tickets.get(o.ticket.id);
  assert.equal(t.origin.threadKey, `panel:${sid}:${answer.id}`);
  await h.step(t.sessionId, { answer: '' });
  await call('bot_send_message', { status: 'done', text: '海淀细则' }, t.sessionId);
  assert.ok((await threadOf(api, atlas, answer.id)).items.some((m) => m.text === '海淀细则' && m.ticket === t.id));
  assert.deepEqual(pick((await chatOf(api, atlas)).items.find((m) => m.text === '海淀细则').quote, ['from', 'text']), { from: 'user', text: '帮我细查海淀' });
  env.dispose();
});

test('chat app threads: the first message goes home; a later one, after the home answered there, goes to a fork at that answer', async () => {
  const env = boot();
  const { api, h } = env;
  api.store.save({ name: 'Forge', bio: 'Engineer' });
  const tg = await withTelegram(env);
  tg.say(10, 'Plan the launch', 't5');
  await settle();
  const sid = api.store.find('atlas').sessionId;
  await h.step(sid, { answer: 'Here is the plan.' });
  await settle();
  assert.equal(tg.c.sent.at(-1).text, 'Here is the plan.');
  assert.equal(h.forks.length, 0);
  const homeEnd = h.events.filter((e) => e.sessionId === sid && e.event.type === 'turn/end').at(-1).event.seq;
  tg.say(11, 'Move it to Friday', 't5');
  await settle();
  assert.deepEqual(h.forks, [{ sessionId: sid, atSeq: homeEnd }]);
  const branch = h.agentsById.get('session-fork-1');
  const got = textOfMsg(branch.deliveries.at(-1).message);
  assert.match(got, /^\[Thread\] From here on this is a thread: the user replies to an earlier message of the conversation above\./);
  assert.ok(got.endsWith(`[Telegram · Kada] (thread ${tg.key('t5')})\nMove it to Friday`));
  await h.step('session-fork-1', { answer: 'Moved to Friday.' });
  await settle();
  assert.deepEqual(pick(tg.c.sent.at(-1), ['text', 'threadId']), { text: 'Moved to Friday.', threadId: 't5' });
  // The next one in that thread goes to the same fork; a message in the chat itself goes home.
  tg.say(12, 'and invite Lin', 't5');
  tg.say(13, 'Something else');
  await settle();
  assert.equal(h.forks.length, 1);
  assert.equal(textOfMsg(branch.deliveries.at(-1).message).endsWith('and invite Lin'), true);
  assert.equal(textOfMsg(h.agentsById.get(sid).deliveries.at(-1).message).endsWith('Something else'), true);
  // A reply to one of the bot's chat messages forks where that message was said.
  await h.step(sid, { answer: 'Noted.' });
  await settle();
  const noted = tg.c.sent.length;
  const at = seqOf(h, sid, 'assistant/message', 'Noted.');
  tg.say(14, 'why?', `m${noted}`);
  await settle();
  assert.deepEqual(h.forks.at(-1), { sessionId: sid, atSeq: at });
  env.dispose();
});

test('a thread is refused a new topic, and only messages of the bot\'s own chat can be replied to', async () => {
  const env = await forgeChat();
  const { api, forge, offer } = env;
  await assert.rejects(sendPanel(api, forge, '/new', offer.id), /a thread has no new topic/);
  const atlas = api.store.find('atlas');
  const other = (await sendPanel(api, atlas, 'hello')).message;
  await assert.rejects(sendPanel(api, forge, 'hijack', other.id), /not in this chat/);
  env.dispose();
});

test('a quiet thread is archived, and the next reply brings the same conversation back', async () => {
  let clock = Date.now();
  const env = await forgeChat({ now: () => clock });
  const { api, h, forge, offer } = env;
  const r = await sendPanel(api, forge, 'why?', offer.id);
  await h.step(r.sessionId, { answer: 'because.' });
  // Its run is over (the Agent went idle a while ago).
  api.finishTask(api.openTasks.get(r.sessionId));
  clock += 25 * 3_600_000;
  await api.ticketUpkeep(clock);
  assert.ok(h.archived.includes(r.sessionId));
  const state = await api.request('GET', '/__dsh_bots/state');
  assert.ok(state.rotatedAt > 0, 'the panel learns a conversation was archived under it');
  const back = await sendPanel(api, forge, 'still there?', offer.id);
  assert.equal(back.sessionId, r.sessionId);
  assert.ok(!h.archived.includes(r.sessionId));
  assert.equal(h.forks.length, 1);
  env.dispose();
});

test('the panel learns which Bots runs and when a new topic archived the conversation under it', async () => {
  const env = await forgeChat();
  const { api, forge } = env;
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  let state = await api.request('GET', '/__dsh_bots/state');
  assert.equal(state.botsVersion, pkg.version);
  assert.equal(state.rotatedAt, 0);
  await api.request('POST', '/__dsh_bots/topic/new', { id: forge.id });
  state = await api.request('GET', '/__dsh_bots/state');
  assert.ok(state.rotatedAt > 0);
  env.dispose();
});

test('a message that could not be handed over leaves no copy in the chat', async () => {
  const env = await team();
  const { api, atlas, router } = env;
  router.steer = () => {
    throw new Error('boom');
  };
  await assert.rejects(sendPanel(api, atlas, 'second'), /boom/);
  const chat = await chatOf(api, atlas);
  assert.deepEqual(chat.items.filter((m) => m.from === 'user').map((m) => m.text), ['帮我查一下北京工作居住证办理条件']);
  env.dispose();
});

test('in a thread the person talks to the thread\'s bot, even after it opened a task there; that task\'s notices reach the thread', async () => {
  const env = await team();
  const { api, h, atlas, sid, call } = env;
  await h.step(sid, { answer: '北京工作居住证主要看单位资质。' });
  const answer = (await chatOf(api, atlas)).items.find((m) => m.kind === 'reply');
  const r = await sendPanel(api, atlas, '帮我细查海淀', answer.id);
  const fork = r.sessionId;
  const [o] = await h.step(fork, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: '细查海淀', report_to: 'me' } }] });
  const t = api.tickets.get(o.ticket.id);
  await h.step(t.sessionId, { answer: '' });
  const again = await sendPanel(api, atlas, '顺便看看朝阳', answer.id);
  assert.equal(again.sessionId, fork, 'the thread\'s bot takes it, not the worker');
  const branch = h.agentsById.get(fork);
  const home = h.agentsById.get(sid);
  const before = home.deliveries.length;
  await call('bot_send_message', { status: 'done', text: '海淀细则' }, t.sessionId);
  assert.ok(branch.deliveries.some((d) => /Report from @forge on task/.test(textOfMsg(d.message))), 'the report asked for comes to the thread');
  assert.equal(home.deliveries.length, before, 'the home hears nothing of it');
  // bot_recall in the thread reads like its home.
  assert.ok((await call('bot_recall', { ref: 'tickets' }, fork)).items.some((x) => x.id === t.id));
  env.dispose();
});

test('a thread whose place cannot be found says the conversation may go on past the message; two first replies at once carry one note', async () => {
  const env = await forgeChat();
  const { api, h, forge } = env;
  const lost = api.store.log({ from: forge.id, to: 'user', kind: 'reply', text: 'lost words', thread: 'panel:session-gone', at: 2100 });
  await sendPanel(api, forge, 'about the lost words', lost.id);
  const branch = h.agentsById.get('session-fork-1');
  assert.match(textOfMsg(branch.deliveries.at(-1).message), /the user replies to this message of @forge: "lost words"\. Answer about it\.\nThe conversation above may go on past that message; stay on that message\./);
  const offer = env.offer;
  await Promise.all([sendPanel(api, forge, 'one', offer.id), sendPanel(api, forge, 'two', offer.id)]);
  const second = h.agentsById.get('session-fork-2');
  assert.equal(h.forks.length, 2);
  assert.deepEqual(second.deliveries.map((d) => /^\[Thread\]/.test(textOfMsg(d.message))), [true, false]);
  env.dispose();
});

test('a 0.9 message filed under another topic shows in that thread, and in the chat quoting its first message', async () => {
  const env = await forgeChat();
  const { api, forge, offer } = env;
  const moved = api.store.log({ from: 'user', to: forge.id, chat: forge.id, kind: 'user', text: 'filed away', topic: 'pself0000', movedTo: offer.id });
  api.store.patchMessage(moved.id, { topic: moved.id });
  const chat = await chatOf(api, forge);
  assert.equal(chat.items.find((m) => m.id === moved.id).quote.id, offer.id);
  assert.ok((await threadOf(api, forge, offer.id)).items.some((m) => m.id === moved.id));
  env.dispose();
});

test('the dispatcher hands work to teammates only: never to itself, and it starts no Harness sub-agents; its teammates keep theirs', async () => {
  const env = await team();
  const { api, h, atlas, forge, sid, call } = env;
  await assert.rejects(call('bot_send_message', { to: '@atlas', text: 'Look up the weather' }, sid), /you are the dispatcher: hand the work to a teammate/);
  assert.equal(api.tickets.list().length, 0);
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Look up the weather' } }] });
  const t = api.tickets.get(r.ticket.id);
  assert.equal(t.botId, forge.id);
  const deny = (sessionId) => h.agentsById.get(sessionId).restricts.at(-1)?.deny ?? [];
  assert.ok(deny(sid).includes('subagent') && deny(sid).includes('wait_agent'), 'the dispatcher: no sub-agents');
  // Forge's task keeps every tool, sub-agents included.
  assert.ok(!deny(t.sessionId).includes('subagent') && !deny(t.sessionId).includes('web_search'));
  env.dispose();
});

test('bot_reply into the panel succeeds: what Harness keeps of its result is plain JSON (0.9 failed it, and the model sent the answer again)', async () => {
  const env = await team();
  const { h, api, atlas, sid } = env;
  // In the turn of the panel's message, so bot_reply has somewhere to go.
  const tool = h.tools.get('bot_reply');
  const [out] = await h.step(sid, { calls: [{ name: 'bot_reply', args: { text: '明天 7℃。', thread: `panel:${sid}` } }] });
  const meta = tool.output.presentationMeta({}, out);
  assert.deepEqual(meta, JSON.parse(JSON.stringify(meta)));
  assert.ok(!Object.values(meta).includes(undefined));
  assert.equal((await chatOf(api, atlas)).items.filter((m) => m.text === '明天 7℃。').length, 1);
  env.dispose();
});

