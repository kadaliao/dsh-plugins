/**
 * Bots 0.9: the panel chat as topics (PLAN-0.9 §7) — every message typed in the panel is a topic
 * (or joins one), shown before a model takes it; the dispatcher answers in the topic, hands work to
 * itself or a teammate, and the worker answers in the topic itself; a reply in a topic goes to its
 * task directly; a message that continues a task is filed under that task's topic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bots-topics-'));
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
  process.env.DSH_HOME = home ?? mkdtempSync(join(tmpdir(), 'bots-topics-'));
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

/** Atlas (the router) and Forge; one panel message from the person, not yet taken by the model. */
async function team() {
  const env = boot();
  const { api } = env;
  api.store.save({ name: 'Forge', bio: 'Engineer' });
  const atlas = api.store.find('atlas');
  const first = await sendPanel(api, atlas, '帮我查一下北京工作居住证办理条件');
  const sid = first.sessionId;
  return { ...env, atlas, sid, router: env.h.agentsById.get(sid), first: first.message };
}

test('a panel message is in the chat at once, as its own topic, pending until the model takes it; then it is not logged twice', async () => {
  const env = await team();
  const { api, h, atlas, sid, router, first } = env;
  assert.match(first.id, /^p[a-z0-9]{8}$/);
  assert.equal(first.topic, first.id);
  assert.equal(first.thread, `panel:${sid}:${first.id}`);
  assert.equal(first.chat, atlas.id);
  assert.equal(first.pending, true);
  assert.equal(first.sid, undefined, 'internal fields stay inside');
  // The router got it by steering, with a header naming its topic.
  const got = router.deliveries.at(-1);
  assert.equal(got.mode, 'steer');
  assert.equal(got.message.id, `bots:panel:${first.id}`);
  assert.equal(textOfMsg(got.message), `[Panel] (thread ${first.id})\n帮我查一下北京工作居住证办理条件`);
  // A second message while the first waits: in the chat at once too, its own topic.
  const second = (await sendPanel(api, atlas, '帮我查一下上海落户条件')).message;
  assert.equal(second.pending, true);
  assert.notEqual(second.topic, first.topic);
  // The step takes both: no longer pending, nothing logged again.
  await h.step(sid, { answer: '' });
  const chat = await chatOf(api, atlas);
  assert.deepEqual(chat.items.filter((m) => m.from === 'user').map((m) => [m.id, m.pending ?? false]), [[first.id, false], [second.id, false]]);
  env.dispose();
});

test('one topic in a turn: the plain answer goes into it; two topics: each answer needs bot_reply, plain text stays outside, and a new task must name its topic', async () => {
  const env = await team();
  const { api, h, atlas, sid, first, call } = env;
  await h.step(sid, { answer: '北京工作居住证主要看单位资质和个人条件。' });
  let chat = await chatOf(api, atlas);
  const answer = chat.items.find((m) => m.kind === 'reply');
  assert.deepEqual([answer.topic, answer.thread, answer.chat, answer.via], [first.id, first.thread, atlas.id, undefined]);
  // Two messages taken in one step.
  const a = (await sendPanel(api, atlas, 'A?')).message;
  const b = (await sendPanel(api, atlas, 'B?')).message;
  const home = h.agentsById.get(sid);
  for (const m of home.inbox.nextStep.splice(0)) h.emit('session/event', home.session, { type: 'user/message', data: m });
  const ra = await call('bot_reply', { thread: a.id, text: 'Answer A' }, sid);
  assert.equal(ra.thread, a.thread);
  await call('bot_reply', { thread: `thread/${b.id}`, text: 'Answer B' }, sid);
  await assert.rejects(call('bot_send_message', { to: '@forge', text: 'Do A' }, sid), new RegExp(`several topics or chats: say which one this task is for with \`thread\`: ${a.id} \\(Panel · topic "A\\?"\\); ${b.id}`));
  const t = (await call('bot_send_message', { to: '@forge', text: 'Do B', thread: b.id }, sid)).ticket;
  assert.equal(api.tickets.get(t.id).origin.threadKey, b.thread);
  // Each topic has its answer: the closing words are not shown anywhere.
  h.emit('session/event', home.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Both answered.' }] } } });
  h.emit('session/event', home.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  chat = await chatOf(api, atlas);
  const replies = chat.items.filter((m) => m.kind === 'reply');
  assert.deepEqual(replies.slice(1).map((m) => [m.text, m.topic ?? null]), [['Answer A', a.id], ['Answer B', b.id]]);
  // The delegation is a line in topic B, not in the main timeline.
  assert.deepEqual(chat.items.filter((m) => m.ticket === t.id).map((m) => [m.kind, m.topic, m.chat]), [['dm', b.id, atlas.id]]);
  env.dispose();
});

test('the router hands work to itself; the task answers in the topic itself, and the router only gets a note', async () => {
  const env = await team();
  const { api, h, atlas, sid, router, first, call } = env;
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@atlas', text: '查北京工作居住证办理条件' } }], answer: '好，我另开一项去查。' });
  assert.match(r.text, /^Opened task t[a-z0-9]{8} for yourself \(working\)\. You answer the person in the topic it came from/);
  const t = api.tickets.get(r.ticket.id);
  assert.equal(t.botId, atlas.id);
  assert.equal(t.origin.threadKey, first.thread);
  const worker = h.agentsById.get(t.sessionId);
  // The task Session is the dispatcher at work: no router limits, the task persona.
  assert.equal(worker.guards.length, 0);
  assert.ok(!(worker.restricts.at(-1)?.deny ?? []).includes('web_search'));
  await h.step(t.sessionId, { answer: '' });
  assert.match(worker.prompts[0], /Your `done`, `question` and `blocked` reports are shown to the person as they are, in the panel, in the topic the request came from/);
  // Another bot cannot hand work to itself.
  const forgeHome = await api.userSend(api.store.find('forge'), 'hi');
  await assert.rejects(call('bot_send_message', { to: '@forge', text: 'x' }, forgeHome), /cannot message itself/);
  const before = router.deliveries.length;
  const done = await call('bot_send_message', { status: 'done', text: '北京工作居住证：1. 单位… 2. 个人…' }, t.sessionId);
  assert.match(done.text, /^Shown to the person as it is, in Panel · topic "帮我查一下北京工作居住证办理条件"; @atlas is told\./);
  assert.deepEqual(router.deliveries.slice(before).map((d) => d.mode), ['inject']);
  const chat = await chatOf(api, atlas);
  const inTopic = chat.items.filter((m) => m.topic === first.id).map((m) => [m.from, m.kind, m.ticket ?? null, m.status ?? null]);
  // The person's message, the delegation (a line between bots), Atlas's word, and the task's answer.
  assert.deepEqual(inTopic, [['user', 'user', null, null], [atlas.id, 'dm', t.id, null], [atlas.id, 'reply', null, null], [atlas.id, 'reply', t.id, 'done']]);
  assert.deepEqual(chat.topics[first.id].tickets.map((x) => [x.id, x.stage]), [[t.id, 'done']]);
  env.dispose();
});

test('a reply in a topic with a live task goes to the task directly; the router hears of it without waking', async () => {
  const env = await team();
  const { api, h, atlas, sid, router, first } = env;
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Look it up.' } }] });
  const t = api.tickets.get(r.ticket.id);
  const worker = h.agentsById.get(t.sessionId);
  await h.step(t.sessionId, { answer: '' });
  const before = router.deliveries.length;
  const sent = await sendPanel(api, atlas, '海淀和朝阳有区别吗？', first.id);
  assert.equal(sent.sessionId, t.sessionId);
  assert.deepEqual([sent.message.topic, sent.message.replyTo, sent.message.ticket, sent.message.pending], [first.id, first.id, t.id, true]);
  const got = worker.deliveries.at(-1);
  assert.equal(got.mode, 'steer');
  assert.equal(got.message.id, `bots:panel:${sent.message.id}:${t.id}`);
  assert.equal(textOfMsg(got.message), '海淀和朝阳有区别吗？');
  const fresh = router.deliveries.slice(before);
  assert.deepEqual(fresh.map((d) => d.mode), ['inject']);
  assert.match(textOfMsg(fresh[0].message), new RegExp(`^\\[follow_up\\] The user in Panel · topic "帮我查一下北京工作居住证办理条件" wrote about task ${t.id} .* on thread ${first.id}:`));
  await h.step(t.sessionId, { answer: '' });
  const chat = await chatOf(api, atlas);
  assert.equal(chat.items.find((m) => m.id === sent.message.id).pending, undefined);
  // Replying to a message in the topic quotes it for the task.
  const ack = chat.items.find((m) => m.kind === 'reply');
  const quoted = await sendPanel(api, atlas, '还有这个', sent.message.id);
  assert.equal(quoted.message.topic, first.id);
  assert.match(textOfMsg(worker.deliveries.at(-1).message), /^\[Panel\]\nIn reply to the user: "海淀和朝阳有区别吗？"\n还有这个$/);
  assert.equal(ack, undefined, 'the router said nothing in this test');
  env.dispose();
});

test('a reply in a topic without a task goes to the router, which reads what it answers; a message in no topic becomes the first of one', async () => {
  const env = await team();
  const { api, h, atlas, sid, router, first } = env;
  await h.step(sid, { answer: '你指的是哪个区？' });
  const ask = (await chatOf(api, atlas)).items.find((m) => m.kind === 'reply');
  const sent = await sendPanel(api, atlas, '海淀', ask.id);
  assert.equal(sent.message.topic, first.id);
  assert.equal(textOfMsg(router.deliveries.at(-1).message), `[Panel] (thread ${first.id})\nIn reply to @atlas: "你指的是哪个区？"\n海淀`);
  await h.step(sid, { answer: '海淀的条件是…' });
  assert.equal((await chatOf(api, atlas)).items.at(-1).topic, first.id);
  // An old message (from before topics) becomes a topic's first message when answered.
  const old = api.store.log({ from: atlas.id, to: 'user', kind: 'reply', text: 'Daily digest', thread: `panel:${sid}` });
  const r = await sendPanel(api, atlas, 'more on this', old.id);
  assert.equal(r.message.topic, old.id);
  assert.equal(api.store.message(old.id).topic, old.id);
  assert.equal(api.store.message(old.id).thread, `panel:${sid}:${old.id}`);
  await assert.rejects(sendPanel(api, atlas, 'x', 'pnope0000'), /not in this chat/);
  env.dispose();
});

test('a new message that continues a task is filed under that task\'s topic, and the answer goes there', async () => {
  const env = await team();
  const { api, h, atlas, sid, first } = env;
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Look it up.' } }] });
  const t = api.tickets.get(r.ticket.id);
  const later = (await sendPanel(api, atlas, '北京那个，顺便看看通州')).message;
  // The router's header lists the tasks a message may continue.
  assert.match(textOfMsg(env.router.deliveries.at(-1).message), new RegExp(`^\\[Panel\\] \\(thread ${later.id}\\)\\nOpen tasks: ${t.id} \\(@forge, working: Look it up\\.\\)\\n北京那个`));
  const [added] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { ticket: t.id, text: 'Also check Tongzhou.' } }], answer: '好，加到北京那件事里了。' });
  assert.match(added.text, /The person's message is filed under that task's topic\./);
  assert.match(added.text, /@forge answers the person in the task's topic itself/);
  const chat = await chatOf(api, atlas);
  assert.equal(chat.items.find((m) => m.id === later.id).movedTo, first.id);
  assert.equal(chat.items.at(-1).text, '好，加到北京那件事里了。');
  assert.equal(chat.items.at(-1).topic, first.id);
  // The topic lists what was filed under it; a reply to the filed message joins that topic too.
  const topic = await api.request('GET', `/__dsh_bots/messages?bot=${atlas.id}&topic=${first.id}`);
  assert.deepEqual(topic.items.filter((m) => m.from === 'user').map((m) => m.id), [first.id, later.id]);
  const re = await sendPanel(api, atlas, '还有顺义', later.id);
  assert.equal(re.message.topic, first.id);
  assert.equal(re.message.ticket, t.id);
  // What was patched survives reading the log afresh (another process, a restart).
  const fresh = createStore(join(env.home, 'cache', 'bots'));
  assert.equal(fresh.message(later.id).movedTo, first.id);
  assert.equal(fresh.message(re.message.id).ticket, t.id);
  env.dispose();
});

test('the chat view: replies whose topic began earlier bring its first message; other bots\' chats do not show a topic', async () => {
  const env = await team();
  const { api, h, atlas, sid, first } = env;
  await h.step(sid, { answer: 'ok' });
  for (let i = 0; i < 5; i += 1) api.store.log({ from: atlas.id, to: 'user', chat: atlas.id, kind: 'reply', text: `noise ${i}`, thread: `panel:${sid}` });
  await sendPanel(api, atlas, 'late reply', first.id);
  const page = await api.request('GET', `/__dsh_bots/messages?bot=${atlas.id}&limit=2`);
  assert.equal(page.items[0].id, first.id, 'the first message comes along');
  assert.equal(page.items.length, 3);
  assert.equal(page.topics[first.id].key, first.thread);
  const forge = api.store.find('forge');
  assert.ok(!(await chatOf(api, forge)).items.some((m) => m.topic === first.id));
  env.dispose();
});

// --- from the review ---------------------------------------------------------------------------

test('a new message in a topic that bot_reply answered earlier in the turn gets its plain answer shown', async () => {
  const env = await team();
  const { api, h, atlas, router, sid, first, call } = env;
  for (const m of router.inbox.nextStep.splice(0)) h.emit('session/event', router.session, { type: 'user/message', data: m });
  await call('bot_reply', { thread: first.id, text: 'working on it' }, sid);
  await sendPanel(api, atlas, 'also Haidian?', first.id);
  for (const m of router.inbox.nextStep.splice(0)) h.emit('session/event', router.session, { type: 'user/message', data: m });
  h.emit('session/event', router.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Haidian: yes it differs.' }] } } });
  h.emit('session/event', router.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  const chat = await chatOf(api, atlas);
  const answer = chat.items.find((m) => m.text === 'Haidian: yes it differs.');
  assert.equal(answer?.topic, first.id);
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

test('replying in the panel to a chat app message keeps its chat Thread; the topic key goes beside it', async () => {
  const env = await team();
  const { api, atlas, sid, router } = env;
  const tg = api.store.log({ from: 'user', to: atlas.id, kind: 'user', via: 'telegram', who: 'Kada', text: 'hi from tg', thread: 'telegram:acme%2Fapp:555' });
  const r = await sendPanel(api, atlas, 'reply in panel', tg.id);
  const kept = api.store.message(tg.id);
  assert.equal(kept.thread, 'telegram:acme%2Fapp:555');
  assert.equal(kept.topic, tg.id);
  assert.equal(kept.panelThread, `panel:${sid}:${tg.id}`);
  assert.equal(r.message.thread, kept.panelThread);
  assert.match(textOfMsg(router.deliveries.at(-1).message), new RegExp(`^\\[Panel\\] \\(thread ${tg.id}\\)\\nIn reply to the user: "hi from tg"`));
  const view = await chatOf(api, atlas);
  assert.equal(view.topics[tg.id].key, kept.panelThread);
  // A second reply joins the same topic.
  assert.equal((await sendPanel(api, atlas, 'and again', r.message.id)).message.thread, kept.panelThread);
  env.dispose();
});

test('bot_reply reaches only topics of its own chat, and tasks it asked for or does', async () => {
  const env = await team();
  const { api, h, atlas, sid, first, call } = env;
  const forge = api.store.find('forge');
  const forgeHome = await api.userSend(forge, 'hi');
  await h.step(forgeHome, { answer: '' });
  await assert.rejects(call('bot_reply', { thread: first.id, text: 'not mine' }, forgeHome), /no topic .* in this bot's chat/);
  await assert.rejects(call('bot_reply', { thread: `panel:${sid}:pnope0000`, text: 'made up' }, sid), /no topic .* in this bot's chat/);
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Look it up.' } }] });
  const scoutHome = await api.userSend(api.store.save({ name: 'Scout' }), 'hi');
  await h.step(scoutHome, { answer: '' });
  await assert.rejects(call('bot_reply', { ticket: r.ticket.id, text: 'x' }, scoutHome), /came from no topic in this bot's chat/);
  assert.equal((await call('bot_reply', { ticket: r.ticket.id, text: 'From Atlas.' }, sid)).thread, first.thread);
  env.dispose();
});

test('a topic whose first message left the log is still found by the message replied to, after a new home session', async () => {
  const env = await team();
  const { api, h, atlas, sid, first } = env;
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Look it up.' } }] });
  const reply = (await sendPanel(api, atlas, 'more', first.id)).message;
  // The home moves on to a new session, and the first message is gone (the log was compacted past it).
  await api.newTopic(api.store.get(atlas.id), 'manual');
  api.store.patchMessage(first.id, { hidden: true, thread: undefined, topic: undefined });
  const again = await sendPanel(api, atlas, 'and more', reply.id);
  assert.equal(again.message.thread, first.thread);
  assert.equal(again.message.ticket, r.ticket.id, 'it reaches the live task, not the new home');
  env.dispose();
});
