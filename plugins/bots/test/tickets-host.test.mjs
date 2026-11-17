import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bots-tickets-'));
const { apply } = await import('../index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A Harness stand-in shaped like 0.2.2's Agent: `inbox.{nextTurn, nextStep}`, `followup` / `steer` /
 * `inject` / `cancel`, scoped `tools.restrict` and `tools.guard`, and a `step` driver that, like the
 * Harness, assembles the system prompt before it reports the step's `user/message` events.
 */
function fakeHarness() {
  const listeners = {};
  const tools = new Map();
  const agentsById = new Map();
  const archived = [];
  const renamed = [];
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
      selected: null,
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
      cancel(cause, options) {
        agent.cancels.push({ cause, options });
      },
      model: {
        select(sel) {
          agent.selected = sel;
        },
        current: () => agent.selected ?? undefined,
      },
      sections,
      restricts,
      guards,
      ctx: {
        get(name) {
          if (name === 'systemPrompt') return { section: (s) => (sections.set(s.name, s), () => sections.delete(s.name)) };
          if (name === 'tools') {
            return {
              restrict: (f) => (restricts.push(f), () => restricts.splice(restricts.indexOf(f), 1)),
              guard: (g) => (guards.push(g), () => guards.splice(guards.indexOf(g), 1)),
            };
          }
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
      async rename({ sessionId, title }) {
        renamed.push({ sessionId, title });
        return { title };
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
  };
  const ctx = {
    tools: {
      register: (t) => (tools.set(t.name, t), () => tools.delete(t.name)),
      definitions: () => ['bash', 'write', 'edit', 'read', 'read_image', 'web_search', 'job_output', 'generate_image', 'skill'].map((name) => ({ name, description: `${name}.` })),
    },
    effect(fn) {
      fn();
    },
    on(name, fn) {
      (listeners[name] ??= []).push(fn);
    },
    get: (name) => services[name],
    inject(names, fn) {
      if (names.includes('webServer')) return;
      fn({ ...ctx, agents: services.agents });
    },
    logger: { warn() {}, info() {}, debug() {} },
  };

  /**
   * One turn of `sessionId`: the step takes its steering (or the next queued follow-up), the prompt
   * is assembled, then its messages are reported; tool calls run through the registered tools.
   */
  async function step(sessionId, { answer, calls = [], usage = { inputTokens: 500, outputTokens: 80 } } = {}) {
    const agent = agentsById.get(sessionId);
    const claimed = agent.inbox.nextStep.length ? agent.inbox.nextStep.splice(0) : agent.inbox.nextTurn.splice(0, 1);
    agent.status = 'running';
    emit('agent/status', { agent, status: 'running' });
    agent.prompts.push([...agent.sections.values()].map((s) => s.text?.()).join('\n'));
    const session = agent.session;
    for (const m of claimed) emit('session/event', session, { type: 'user/message', seq: ++seq, time: Date.now(), data: m });
    const results = [];
    for (const c of calls) {
      emit('session/event', session, { type: 'assistant/message', seq: ++seq, time: Date.now(), data: { message: { content: [{ type: 'tool-call', name: c.name, argsRaw: JSON.stringify(c.args) }], source: { kind: 'model', provider: 'magpie', model: 'm' } }, usage } });
      results.push(await tools.get(c.name).execute(c.args, { agent }));
    }
    if (answer) emit('session/event', session, { type: 'assistant/message', seq: ++seq, time: Date.now(), data: { message: { content: [{ type: 'text', text: answer }], source: { kind: 'model', provider: 'magpie', model: 'm' } }, usage } });
    emit('session/event', session, { type: 'turn/end', seq: ++seq, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
    agent.status = 'idle';
    emit('agent/status', { agent, status: 'idle' });
    return results;
  }
  return { ctx, tools, agentsById, archived, renamed, emit, step };
}

const memoryCalls = [];
function boot() {
  const h = fakeHarness();
  const api = apply(h.ctx, {}, {
    prices: false,
    sweep: false,
    startupPumpMs: 5,
    complete: async (req) => {
      memoryCalls.push(req);
      return { text: JSON.stringify({ summary: 'Fixed the Safari login bug.', notes: [{ op: 'add', text: 'Safari needs the SameSite cookie flag.', kind: 'lesson' }], team: [] }), usage: { inputTokens: 100, outputTokens: 20 } };
    },
  });
  const call = (name, args, sessionId) => h.tools.get(name).execute(args, sessionId ? { agent: { session: { id: sessionId } } } : {});
  return { h, api, call };
}

const { h, api, call } = boot();
const atlas = () => api.store.find('atlas');
const forge = () => api.store.find('forge');
const scout = () => api.store.find('scout');
const agentOf = (sessionId) => h.agentsById.get(sessionId);
const textOfMsg = (m) => m.content.map((b) => b.text).join('\n');
let atlasSid;
let t1;
let t2;

test('setup: router mode is the default; a fresh install gets no upgrade notice', async () => {
  const s = api.settings.get();
  assert.equal(s.dispatcher, 'router');
  assert.deepEqual(s.tickets, { maxWorking: 4, stallMinutes: 20, archiveHours: 24 });
  assert.equal(api.state().routerNoticePending, false);
  assert.equal(api.state().dispatcher, 'router');
  api.store.save({ name: 'Forge', persona: 'You build things.', bio: 'Engineer', skills: [{ name: 'Ship it', description: 'How we ship.', content: '# ship' }], tools: { deny: ['generate_image'] }, model: { provider: 'magpie', model: 'coder' } });
  api.store.save({ name: 'Scout', persona: 'You research.', bio: 'Researcher' });
  atlasSid = await api.userSend(atlas(), 'Fix the login bug, and find out why Safari differs.');
  // The router's home takes input by steering.
  assert.equal(agentOf(atlasSid).deliveries.at(-1).mode, 'steer');
  await h.step(atlasSid);
});

test('router home: tools that do the work are denied, waiting is guarded, the persona routes', () => {
  const agent = agentOf(atlasSid);
  const deny = agent.restricts.at(-1).deny;
  for (const n of ['bash', 'write', 'edit', 'job_output', 'generate_image']) assert.ok(deny.includes(n), n);
  for (const n of ['read', 'read_image', 'web_search', 'skill']) assert.ok(!deny.includes(n), n);
  assert.equal(agent.guards.length, 1);
  assert.match(agent.guards[0]({ name: 'bash', arguments: { command: 'sleep 30' } }), /no sleep/);
  assert.match(agent.guards[0]({ name: 'job_output', arguments: { wait: true } }), /job waits/);
  assert.equal(agent.guards[0]({ name: 'read', arguments: { path: 'x' } }), undefined);
  assert.match(agent.prompts[0], /You do three things: understand what the person wants, hand the work out, and report back/);
});

test('delegation opens a ticket Session decorated as the bot, with the assignment steered in first', async () => {
  const r = await call('bot_send_message', { to: '@forge', text: 'Fix the login bug.\nIt fails on Safari only.' }, atlasSid);
  assert.equal(r.ok, true);
  assert.equal(r.stage, 'working');
  assert.match(r.text, /Opened task t[a-z0-9]{8} for @forge \(working\)/);
  t1 = api.tickets.get(r.ticket.id);
  assert.equal(r.ticket.title, 'Fix the login bug.');
  assert.deepEqual(r.ticket.requester, { kind: 'bot', botId: atlas().id });
  assert.equal(t1.sessionId, `ticket-${t1.id}`);
  assert.deepEqual(t1.requester, { kind: 'session', sessionId: atlasSid, botId: atlas().id });
  assert.equal(t1.origin.threadKey, `panel:${atlasSid}`);
  assert.equal(forge().sessionId, null, "the bot's home is not involved");
  const agent = agentOf(t1.sessionId);
  // Decorated as Forge: persona (as one task), skills, memory, its own tool limits, its model, the title.
  const persona = agent.sections.get('bots:persona').text();
  assert.match(persona, /You are Forge \(@forge\)/);
  assert.match(persona, /## This conversation is one task/);
  assert.match(persona, new RegExp(`It is task ${t1.id}: "Fix the login bug\\."`));
  assert.match(persona, /Ship it/);
  assert.doesNotMatch(persona, /You are the dispatcher/);
  assert.ok(agent.sections.get('bots:memory'));
  assert.deepEqual(agent.restricts, [{ deny: ['generate_image'] }]);
  assert.equal(agent.guards.length, 0);
  assert.deepEqual(agent.selected, { provider: 'magpie', model: 'coder' });
  assert.deepEqual(h.renamed.at(-1), { sessionId: t1.sessionId, title: 'Fix the login bug.' });
  assert.equal(agent.deliveries.length, 1);
  const first = agent.deliveries[0];
  assert.equal(first.mode, 'steer');
  assert.equal(first.message.id, `bots:assign:${t1.id}`);
  assert.deepEqual(first.message.source, { kind: 'agent-message', form: 'relay', senderSessionId: atlasSid });
  assert.match(textOfMsg(first.message), new RegExp(`^New task ${t1.id} from @atlas: Fix the login bug\\.`));
  assert.match(textOfMsg(first.message), /It fails on Safari only/);
  assert.match(textOfMsg(first.message), /\nIt started with the user in Panel\.\n/);
  // The first step's prompt (assembled before its message is reported) is already the task's.
  await h.step(t1.sessionId, { answer: 'Looking at the cookie code.' });
  assert.match(agent.prompts[0], /## This conversation is one task/);
  const logged = api.store.messages({ bot: forge().id });
  assert.ok(logged.some((m) => m.ticket === t1.id && m.from === atlas().id && m.kind === 'dm'));
  assert.ok(!logged.some((m) => m.text === 'Looking at the cookie code.'), "a worker's plain text reaches no one");
  assert.equal(api.state().sessionMap[t1.sessionId], forge().id);
  assert.equal(api.state().ticketMap[t1.sessionId], t1.id);
});

test('two tickets for the same bot run at once, each in its own Session with only its own context', async () => {
  const r = await call('bot_send_message', { to: '@forge', text: 'Write the release notes for 2.4.', title: 'Release notes 2.4' }, atlasSid);
  t2 = api.tickets.get(r.ticket.id);
  assert.equal(r.stage, 'working');
  assert.notEqual(t2.sessionId, t1.sessionId);
  assert.equal(t2.title, 'Release notes 2.4');
  const a1 = agentOf(t1.sessionId);
  const a2 = agentOf(t2.sessionId);
  assert.equal(a2.deliveries.length, 1);
  assert.match(textOfMsg(a2.deliveries[0].message), /release notes/);
  assert.ok(!a1.deliveries.some((d) => /release notes/.test(textOfMsg(d.message))));
  assert.deepEqual(api.state().bots.find((b) => b.id === forge().id).tickets, { working: 2, question: 0, stalled: 0, queued: 0 });
});

let t3;
test('slots: with two at most, a third ticket queues and starts when one ends', async () => {
  const s = await api.routes.settings.post({ patch: { tickets: { maxWorking: 2 } } });
  assert.equal(s.settings.tickets.maxWorking, 2);
  const r = await call('bot_send_message', { to: '@scout', text: 'Compare Safari and Chrome cookie rules.' }, atlasSid);
  assert.equal(r.stage, 'queued');
  assert.match(r.text, /queued/);
  t3 = api.tickets.get(r.ticket.id);
  assert.equal(t3.sessionId, null);
  assert.equal(agentOf(`ticket-${t3.id}`), undefined, 'no Session yet');
  assert.equal(api.slots.count(), 2);
});

test('progress is only recorded: it does not wake the router', async () => {
  const before = agentOf(atlasSid).deliveries.length;
  const r = await call('bot_send_message', { status: 'progress', text: 'Draft half done.' }, t2.sessionId);
  assert.match(r.text, /Recorded on task/);
  assert.equal(agentOf(atlasSid).deliveries.length, before);
  assert.equal(api.tickets.get(t2.id).reports.length, 1);
  assert.equal(api.state().bots.find((b) => b.id === forge().id).tickets.working, 2);
  // A report needs a status; `status` outside a task conversation is refused.
  await assert.rejects(call('bot_send_message', { text: 'no status' }, t2.sessionId), /needs a status/);
  await assert.rejects(call('bot_send_message', { to: '@atlas', text: 'naming the requester is a report too' }, t2.sessionId), /needs a status/);
  await assert.rejects(call('bot_send_message', { to: '@forge', status: 'done', text: 'x' }, atlasSid), /only for reports/);
});

test('a done report reaches the router as one steered message, ends the ticket and frees its slot', async () => {
  const router = agentOf(atlasSid);
  const before = router.deliveries.length;
  const r = await call('bot_send_message', { status: 'done', text: 'Fixed: the cookie lacked SameSite=None; Secure.' }, t1.sessionId);
  assert.match(r.text, /Reported "done" on task .* to @atlas/);
  const fresh = router.deliveries.slice(before);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].mode, 'steer');
  assert.match(fresh[0].message.id, new RegExp(`^bots:report:${t1.id}:0:`));
  assert.deepEqual(fresh[0].message.source, { kind: 'agent-message', form: 'relay', senderSessionId: t1.sessionId });
  assert.match(textOfMsg(fresh[0].message), new RegExp(`^Report from @forge on task ${t1.id} — status: done`));
  assert.match(textOfMsg(fresh[0].message), /SameSite=None/);
  const ended = api.tickets.get(t1.id);
  assert.equal(ended.ended.outcome, 'done');
  assert.equal(ended.ended.by, 'worker');
  // The queued ticket took the freed slot.
  await api.pump();
  const started = api.tickets.get(t3.id);
  assert.equal(started.sessionId, `ticket-${t3.id}`);
  assert.equal(agentOf(started.sessionId).deliveries[0].message.id, `bots:assign:${t3.id}`);
  assert.equal(api.slots.count(), 2);
  // The router passes the report on: its reply is shown to the user.
  await h.step(atlasSid, { answer: 'Forge fixed the login bug.' });
  assert.ok(api.store.messages({ bot: atlas().id }).some((m) => m.kind === 'reply' && m.text === 'Forge fixed the login bug.'));
});

test('a sub-ticket opened from a ticket Session reports back to that Session, not to the router', async () => {
  const router = agentOf(atlasSid);
  const routerBefore = router.deliveries.length;
  const r = await call('bot_send_message', { to: '@scout', text: 'Find the Safari 18 cookie changes.' }, t2.sessionId);
  // With two slots taken (t2, t3) the sub-ticket waits; give it room.
  assert.equal(r.stage, 'queued');
  await api.routes.settings.post({ patch: { tickets: { maxWorking: 3 } } });
  await api.pump();
  const sub = api.tickets.get(r.ticket.id);
  assert.equal(sub.parentId, t2.id);
  assert.deepEqual(sub.requester, { kind: 'session', sessionId: t2.sessionId, botId: forge().id, ticketId: t2.id });
  assert.equal(sub.origin.threadKey, undefined, 'a sub-ticket takes no Thread');
  assert.ok(sub.sessionId);
  assert.match(textOfMsg(agentOf(sub.sessionId).deliveries[0].message), new RegExp(`^New task ${sub.id} from @forge \\(task ${t2.id}\\): Find the Safari 18 cookie changes\\.\nIt started with the user\\.`));
  const parentBefore = agentOf(t2.sessionId).deliveries.length;
  await call('bot_send_message', { status: 'done', text: 'Safari 18 blocks third-party cookies by default.' }, sub.sessionId);
  const toParent = agentOf(t2.sessionId).deliveries.slice(parentBefore);
  assert.equal(toParent.length, 1);
  assert.equal(toParent[0].mode, 'steer');
  assert.match(textOfMsg(toParent[0].message), new RegExp(`^Report from @scout on task ${sub.id} — status: done`));
  assert.equal(router.deliveries.length, routerBefore, 'the router hears nothing of it');
  // The parent answers a question of its sub-ticket with `ticket`.
  const q = await call('bot_send_message', { to: '@scout', text: 'Check Firefox too.' }, t2.sessionId);
  await api.pump();
  const sub2 = api.tickets.get(q.ticket.id);
  await call('bot_send_message', { status: 'question', text: 'Which Firefox version?' }, sub2.sessionId);
  assert.equal(api.tickets.get(sub2.id).reports.at(-1).status, 'question');
  assert.equal((await api.request('GET', `/__dsh_bots/tickets/${sub2.id}`)).stage, 'question');
  await sleep(2); // the answer comes after the question
  const answer = await call('bot_send_message', { ticket: sub2.id, text: 'Firefox 130.' }, t2.sessionId);
  assert.match(answer.text, /Added to task/);
  const got = agentOf(sub2.sessionId).deliveries.at(-1);
  assert.match(textOfMsg(got.message), /^Bot message from @forge \(Forge\) about task/);
  assert.ok(api.tickets.get(sub2.id).lastRequesterAt > 0);
  assert.equal((await api.request('GET', `/__dsh_bots/tickets/${sub2.id}`)).stage, 'working', 'the answer clears the question');
});

test('the requester adds to a ticket: a done one opens again; one the user stopped stays stopped', async () => {
  // Three slots are taken (t2, t3, the sub-task that asked): a bot's message takes no extra one, so make room.
  await api.routes.settings.post({ patch: { tickets: { maxWorking: 4 } } });
  const agent = agentOf(t1.sessionId);
  const r = await call('bot_send_message', { ticket: t1.id, text: 'Please also add a regression test.' }, atlasSid);
  assert.match(r.text, new RegExp(`Added to task ${t1.id} \\(working\\)`));
  const t = api.tickets.get(t1.id);
  assert.equal(t.ended, undefined);
  assert.ok(t.lastRequesterAt > 0);
  const last = agent.deliveries.at(-1);
  assert.equal(last.mode, 'steer');
  assert.match(textOfMsg(last.message), /^Bot message from @atlas \(Atlas\) about task/);
  assert.match(textOfMsg(last.message), /Answer in a report/);
  assert.deepEqual(last.message.source, { kind: 'agent-message', form: 'relay', senderSessionId: atlasSid });
  await api.request('POST', `/__dsh_bots/tickets/${t1.id}/stop`, {});
  await assert.rejects(call('bot_send_message', { ticket: t1.id, text: 'Go on anyway.' }, atlasSid), /stopped by the user/);
  // Only the requester (or the router) may add to a ticket.
  await assert.rejects(call('bot_send_message', { ticket: t2.id, text: 'hi' }, agentOf(t3.sessionId).session.id), /not asked for from this conversation/);
});

test('panel routes: list, view, message, stop, retry, close, threads, and what the state polls', async () => {
  const list = await api.request('GET', `/__dsh_bots/tickets?bot=${forge().id}`);
  assert.ok(Array.isArray(list.items));
  assert.ok('next_offset' in list);
  assert.deepEqual(Object.keys(list.items[0]).filter((k) => !['via', 'lastReport'].includes(k)).sort(), ['botId', 'createdAt', 'id', 'requester', 'stage', 'title', 'updatedAt']);
  const page = await api.request('GET', `/__dsh_bots/tickets?limit=1&offset=0`);
  assert.equal(page.items.length, 1);
  assert.equal(page.next_offset, 1);
  const stopped = await api.request('GET', `/__dsh_bots/tickets?stage=stopped`);
  assert.deepEqual(stopped.items.map((x) => x.id), [t1.id]);

  // View: the row, reports, Threads, runs with their cost, and the Session.
  const view = await api.request('GET', `/__dsh_bots/tickets/${t1.id}`);
  assert.equal(view.id, t1.id);
  assert.equal(view.stage, 'stopped');
  assert.equal(view.sessionId, t1.sessionId);
  assert.equal(view.reports.at(-1).status, 'done');
  assert.deepEqual(view.threads, [{ key: `panel:${atlasSid}`, kind: 'panel', label: 'Panel' }]);
  assert.ok(view.runs.length >= 1);
  assert.ok(view.usage.tokens > 0);
  assert.equal(view.lastReport.status, 'done');
  await assert.rejects(api.request('GET', '/__dsh_bots/tickets/tnope0000'), /no such task/);

  // Stop cancelled the running turn and told the router without waking it.
  const a1 = agentOf(t1.sessionId);
  assert.deepEqual(a1.cancels.at(-1).cause, { kind: 'user' });
  const notice = agentOf(atlasSid).deliveries.at(-1);
  assert.equal(notice.mode, 'inject');
  assert.match(textOfMsg(notice.message), /The user stopped task/);

  // Retry: open again (even after a stop) and hand the assignment over afresh.
  const retried = await api.request('POST', `/__dsh_bots/tickets/${t1.id}/retry`, {});
  assert.equal(retried.ok, true);
  assert.equal(retried.stage, 'working');
  assert.match(textOfMsg(a1.deliveries.at(-1).message), /^\[Retry\] The user asked you to take task/);
  // A person's message goes straight into the ticket Session.
  const msg = await api.request('POST', `/__dsh_bots/tickets/${t1.id}/message`, { text: 'Use the staging server.' });
  assert.equal(msg.ok, true);
  const m = a1.deliveries.at(-1);
  assert.equal(m.mode, 'steer');
  assert.deepEqual(m.message.source, { kind: 'user' });
  assert.equal(textOfMsg(m.message), 'Use the staging server.');
  assert.ok(api.tickets.get(t1.id).lastHumanAt > 0);
  // Close: done, by the user.
  const closed = await api.request('POST', `/__dsh_bots/tickets/${t1.id}/close`, {});
  assert.equal(closed.stage, 'done');
  assert.deepEqual(closed.ended.by, 'user');
  const bad = await api.request('POST', `/__dsh_bots/tickets/${t1.id}/explode`, {}).catch((e) => e);
  assert.match(String(bad?.message), /no such route/);

  // A question shows up in `attention`.
  await call('bot_send_message', { status: 'question', text: 'Which version do the notes cover?' }, t2.sessionId);
  const st = api.state();
  assert.ok(st.attention.some((row) => row.id === t2.id && row.stage === 'question'));
  assert.equal(st.bots.find((b) => b.id === forge().id).tickets.question, 1);
  // A Thread: its label, the tickets on it, what was said there lately.
  const th = await api.request('GET', `/__dsh_bots/threads/${encodeURIComponent(`panel:${atlasSid}`)}`);
  assert.equal(th.label, 'Panel');
  assert.equal(th.kind, 'panel');
  assert.ok(th.tickets.some((row) => row.id === t1.id));
  assert.ok(th.recent.some((x) => /Fix the login bug/.test(x.text)));
  assert.equal((await api.request('GET', `/__dsh_bots/threads/${encodeURIComponent('nope')}`)).ok, false);
});

test('runs in ticket Sessions carry the ticket; usage groups by it; its end is summarized into the bot’s memory', async () => {
  await sleep(400); // runs settle once their Session is idle
  const runs = api.ledger.tasks().filter((r) => r.t === t1.id);
  assert.ok(runs.length >= 1);
  assert.equal(runs[0].b, forge().id);
  assert.ok(api.ledger.calls().some((r) => r.tk === t1.id && r.r === 'chat'));
  const usage = api.routes.usage.get(new URL('http://x/?range=today'));
  const row = usage.tickets.find((x) => x.id === t1.id);
  assert.ok(row && row.tokens > 0);
  assert.equal(row.title, 'Fix the login bug.');
  assert.equal(row.bot, forge().id);
  assert.ok(usage.tasks.some((x) => x.ticket === t1.id));
  // The ticket ended (closed): Forge's memory pass ran once on the whole ticket.
  await sleep(50);
  const pass = memoryCalls.find((c) => /task t[a-z0-9]{8} from @atlas/.test(c.prompt) && /Fix the login bug|cookie/.test(c.prompt));
  assert.ok(pass, 'a memory pass for the ticket');
  const journal = api.memory.journal({ bot: forge().id });
  assert.ok(journal.some((j) => j.ticket === t1.id && j.trigger === 'ticket'));
  assert.ok(api.memory.notes(forge().id).some((n) => /SameSite/.test(n.text)));
  assert.ok(api.ledger.calls().some((r) => r.r === 'memory' && r.tk === t1.id));
  // Topics never see ticket Sessions.
  const topic = api.topics.peek(forge().id);
  assert.ok(!topic || !String(topic.sessionId).startsWith('ticket-'));
});

test('hands-on mode behaves as 0.7: home DMs, no tickets, no router limits; switching back restores them', async () => {
  await api.routes.settings.post({ patch: { dispatcher: 'hands-on' } });
  const home = agentOf(atlasSid);
  assert.equal(home.guards.length, 0);
  assert.equal(home.restricts.length, 0, 'Atlas has no own denials, and no router ones now');
  assert.match(home.sections.get('bots:persona').text(), /Do small or general tasks yourself/);
  const count = api.tickets.list().length;
  const r = await call('bot_send_message', { to: '@scout', text: 'What changed in Safari 18?' }, atlasSid);
  assert.match(r.text, /^Delivered to @scout/);
  assert.equal(api.tickets.list().length, count);
  const scoutHome = agentOf(scout().sessionId);
  const last = scoutHome.deliveries.at(-1);
  assert.equal(last.mode, 'followup');
  assert.match(textOfMsg(last.message), /^Bot message from @atlas \(Atlas\):/);
  assert.equal(last.message.source.senderSessionId, atlasSid);
  // Into a hands-on home, the panel's messages are follow-ups again.
  await api.userSend(atlas(), 'Status?');
  assert.equal(home.deliveries.at(-1).mode, 'followup');

  // Back to router: the limits and the guard return; a tool the user gave back stays allowed.
  await api.routes.settings.post({ patch: { dispatcher: 'router' } });
  assert.ok(home.restricts.at(-1).deny.includes('bash'));
  assert.equal(home.guards.length, 1);
  api.routes.save.post({ bot: { id: atlas().id, tools: { deny: [], routerAllow: ['bash'] } } });
  assert.ok(!home.restricts.at(-1).deny.includes('bash'));
  assert.ok(home.restricts.at(-1).deny.includes('write'));
  assert.match(home.guards[0]({ name: 'bash', arguments: { command: 'npm test && sleep 5' } }), /no sleep/);
  // A panel save that only edits `deny` keeps the router allowance.
  api.routes.save.post({ bot: { id: atlas().id, tools: { deny: ['web_fetch'] } } });
  assert.deepEqual(api.store.get(atlas().id).tools, { deny: ['web_fetch'], routerAllow: ['bash'] });
  const cat = await api.routes.catalog.get();
  assert.ok(cat.routerDeny.includes('bash'));
});

test('upkeep archives the Sessions of tickets ended long enough ago', async () => {
  await api.routes.settings.post({ patch: { tickets: { archiveHours: 0 } } });
  await api.ticketUpkeep(Date.now() + 1000);
  const t = api.tickets.get(t1.id);
  assert.ok(t.archivedAt);
  assert.ok(h.archived.includes(t1.sessionId));
  assert.ok(!api.installed.has(t1.sessionId));
  assert.equal(api.state().sessionMap[t1.sessionId], undefined);
  await assert.rejects(call('bot_send_message', { ticket: t1.id, text: 'more' }, atlasSid), /archived/);
  await api.routes.settings.post({ patch: { tickets: { archiveHours: 24 } } });
});

test('after a restart: working tickets keep their slots, queued ones start, a pending assignment is not sent twice', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bots-restart-'));
  const dir = join(home, 'cache', 'bots');
  mkdirSync(dir, { recursive: true });
  // An install from before 0.8: bots exist, no dispatcher setting yet.
  writeFileSync(join(dir, 'bots.json'), JSON.stringify({ version: 3, bots: [
    { id: 'bot-a', name: 'Atlas', handle: 'atlas', role: 'primary', sessionId: 'session-a', skills: [], apps: [], tools: { deny: [] } },
    { id: 'bot-f', name: 'Forge', handle: 'forge', role: 'bot', sessionId: null, skills: [], apps: [], tools: { deny: [] } },
  ] }));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ tickets: { maxWorking: 2 } }));
  const now = Date.now();
  const base = { botId: 'bot-f', requester: { kind: 'session', sessionId: 'session-a', botId: 'bot-a' }, origin: {}, threads: [], reports: [], retries: 0 };
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ version: 1, threads: [], tickets: [
    { ...base, id: 'tworking1', title: 'Working one', text: 'Do A', sessionId: 'ticket-tworking1', createdAt: now - 3000, updatedAt: now - 3000, startedAt: now - 3000 },
    { ...base, id: 'tqueued01', title: 'Queued one', text: 'Do B', sessionId: null, createdAt: now - 2000, updatedAt: now - 2000 },
    { ...base, id: 'tqueued02', title: 'Queued two', text: 'Do C', sessionId: null, createdAt: now - 1000, updatedAt: now - 1000 },
  ] }));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let r;
  try {
    const hh = fakeHarness();
    // The first queued ticket's Session was made, and its assignment handed over, just before the restart.
    await hh.ctx.get('sessionController').create({ sessionId: 'ticket-tqueued01' });
    const pre = hh.agentsById.get('ticket-tqueued01');
    pre.inbox.nextStep.push(Object.freeze({ id: 'bots:assign:tqueued01', role: 'user', content: [{ type: 'text', text: 'New task tqueued01' }], source: { kind: 'agent-message' } }));
    r = { hh, api: apply(hh.ctx, {}, { prices: false, sweep: false, startupPumpMs: 5 }) };
  } finally {
    process.env.DSH_HOME = before;
  }
  const { hh, api: rapi } = r;
  assert.equal(rapi.slots.holds('tworking1'), true, 'the working ticket holds its slot again');
  await sleep(30);
  await rapi.pump();
  // Two slots: the working one and the first queued one; the second still waits.
  assert.equal(rapi.tickets.get('tqueued01').sessionId, 'ticket-tqueued01');
  assert.equal(rapi.tickets.get('tqueued02').startedAt, undefined);
  const pre = hh.agentsById.get('ticket-tqueued01');
  assert.equal(pre.deliveries.length, 0, 'the pending assignment was not handed over again');
  assert.equal(pre.inbox.nextStep.length, 1);
  assert.ok(pre.sections.get('bots:persona'), 'the existing Session is decorated as the bot');
  // An upgraded team is told once that its dispatcher now routes.
  assert.equal(rapi.state().routerNoticePending, true);
  assert.equal(rapi.state().dispatcher, 'router');
  assert.deepEqual(await rapi.request('POST', '/__dsh_bots/router-notice/dismiss', {}), { ok: true, routerNoticePending: false });
  assert.equal(rapi.state().routerNoticePending, false);
});
