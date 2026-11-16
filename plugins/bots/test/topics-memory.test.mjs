import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bots-v07-'));
const { apply } = await import('../index.js');

const LONG_ANSWER = `Done. ${'Here is what I found and what I did about it, step by step. '.repeat(6)}`;
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** A Harness stand-in with sessions that emit events, schedules that retarget, settings and credentials. */
function fakeHarness() {
  const listeners = {};
  const tools = new Map();
  const agentsById = new Map();
  const tasks = [];
  const archived = [];
  const piSettings = { providers: { magpie: { displayName: 'Magpie' } } };
  const secrets = new Map();
  const records = new Map();
  const emit = (n, ...a) => (listeners[n] ?? []).forEach((fn) => fn(...a));
  let seq = 0;
  const makeAgent = (sessionId) => {
    const sections = new Map();
    const agent = {
      id: sessionId,
      status: 'idle',
      session: { id: sessionId },
      inbox: [],
      selected: null,
      followup(m) {
        agent.inbox.push(m);
      },
      model: {
        select(sel) {
          agent.selected = sel;
        },
        current: () => agent.selected ?? { provider: 'magpie', model: 'auto/deepseek-flash' },
      },
      sections,
      ctx: {
        get(name) {
          if (name === 'systemPrompt') return { section: (s) => (sections.set(s.name, s), () => sections.delete(s.name)) };
          if (name === 'tools') return { restrict: () => () => {} };
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
      get archivedSessionIds() {
        return archived;
      },
      async archiveSession(id) {
        if (tasks.some((t) => t.target?.sessionId === id)) throw new Error('a scheduled task still targets it');
        archived.push(id);
      },
    },
    schedule: {
      async create(req) {
        const e = { id: `schedule-${tasks.length + 1}`, title: req.title, prompt: req.prompt, kind: req.timing.kind, scheduledAt: '2099-01-01T01:00:00.000Z', status: 'active', target: req.target };
        tasks.push(e);
        return e;
      },
      async catalog() {
        return tasks;
      },
      async edit({ id, action, patch }) {
        const e = tasks.find((t) => t.id === id);
        if (!e) return { id, code: 'schedule_not_found' };
        if (action === 'delete') return tasks.splice(tasks.indexOf(e), 1) && { id, deleted: true };
        if (patch.target) e.target = patch.target;
        return e;
      },
      async run() {
        return {};
      },
    },
    llm: {
      listProviders: () => [{ id: 'magpie', name: 'Magpie' }, ...Object.keys(piSettings.providers).filter((p) => p !== 'magpie').map((id) => ({ id, name: piSettings.providers[id].displayName ?? id }))],
      listModels: async (p) => (p === 'magpie' ? [{ id: 'auto/deepseek-flash', name: 'Flash' }] : (piSettings.providers[p]?.models ?? []).map((m) => ({ id: m.id }))),
      resolveModelInfo: async (p, m) => (m === 'auto/deepseek-flash' ? { reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }, context: { contextWindow: 1_000_000 } } : {}),
      listConfigurableProviders: () => [{ provider: 'magpie', settingsNs: 'llm-pi-ai' }],
    },
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: structuredClone(piSettings) }],
      async mutate(ns, ops) {
        assert.equal(ns, 'llm-pi-ai');
        for (const op of ops) {
          const [, route] = op.path;
          if (op.op === 'set') piSettings.providers[route] = op.value;
          else delete piSettings.providers[route];
        }
      },
    },
    credentials: {
      async set(ref, value) {
        secrets.set(ref, value);
      },
      async unset(ref) {
        secrets.delete(ref);
      },
      async describe(ref) {
        return { configured: secrets.has(ref), writable: true };
      },
      async resolve(ref) {
        return secrets.has(ref) ? { value: secrets.get(ref), source: 'file' } : undefined;
      },
      async readRecord(key) {
        return records.get(key);
      },
      async modifyRecord(key, mutate) {
        const next = await mutate(records.get(key));
        if (next === undefined) records.delete(key);
        else records.set(key, next);
        emit('credentials/record-updated', key);
        return next;
      },
      async deleteRecord(key) {
        records.delete(key);
      },
      async listRecords() {
        return [...records].map(([key, r]) => ({ key, kind: r.kind }));
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'magpie', model: 'auto/deepseek-flash' }) },
  };
  const ctx = {
    tools: { register: (t) => (tools.set(t.name, t), () => tools.delete(t.name)), definitions: () => [] },
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
  /** One whole task in a bot's conversation: the prompt arrives, the model answers, the agent goes idle. */
  async function runTask(sessionId, { text, kind = 'user', source = {}, answer = LONG_ANSWER, usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 4000 }, tool }) {
    const session = { id: sessionId };
    const agent = agentsById.get(sessionId);
    agent.status = 'running';
    const content = Array.isArray(text) ? text : [{ type: 'text', text }];
    // Like the Harness: the step's system prompt is assembled before its message is reported.
    const prompt = [...agent.sections.values()].map((section) => section.text?.()).join('\n');
    agent.prompts = [...(agent.prompts ?? []), prompt];
    emit('session/event', session, { type: 'user/message', seq: ++seq, time: Date.now(), data: { id: `m${seq}`, role: 'user', content, source: { kind, ...source } } });
    if (tool) emit('session/event', session, { type: 'assistant/message', seq: ++seq, time: Date.now(), data: { message: { content: [{ type: 'tool-call', name: tool, argsRaw: '{"q":"x"}' }], source: { kind: 'model', provider: 'magpie', model: 'auto/deepseek-flash' } }, usage } });
    emit('session/event', session, { type: 'assistant/message', seq: ++seq, time: Date.now(), data: { message: { content: [{ type: 'text', text: answer }], source: { kind: 'model', provider: 'magpie', model: 'auto/deepseek-flash' } }, usage } });
    emit('session/event', session, { type: 'turn/end', seq: ++seq, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
    agent.status = 'idle';
    emit('agent/status', { agent, status: 'idle' });
    await new Promise((r) => setTimeout(r, 450));
  }
  return { ctx, tools, agentsById, tasks, archived, piSettings, secrets, records, listeners, emit, runTask };
}

const h = fakeHarness();
const calls = [];
let reply = { summary: 'Wrote the Acme launch post.', notes: [{ op: 'add', text: 'Kada wants launch posts under 800 words.', kind: 'preference' }], team: [{ op: 'add', text: 'The company is called Acme.' }] };
const home = mkdtempSync(join(tmpdir(), 'bots-home-'));
const api = apply(h.ctx, {}, {
  prices: false,
  sweep: false,
  home,
  complete: async (req) => {
    calls.push(req);
    return { text: `\`\`\`json\n${JSON.stringify(typeof reply === 'function' ? reply(req) : reply)}\n\`\`\``, usage: { inputTokens: 300, outputTokens: 60 } };
  },
});
const call = (name, args, sessionId) => h.tools.get(name).execute(args, sessionId ? { agent: { session: { id: sessionId } } } : {});
const route = (path, body) => (body === undefined ? api.routes[path].get(new URL(`http://x/?${new URLSearchParams(typeof body === 'object' ? body : {})}`)) : api.routes[path].post(body));
const get = (path, q = {}) => api.routes[path].get(new URL(`http://x/?${new URLSearchParams(q)}`));
const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const atlas = () => api.store.find('atlas');

test('a task is tracked from its prompt to idle: usage rows, a task row, a memory pass and a journal line', async () => {
  const sessionId = await api.userSend(atlas(), 'Write the launch post for Acme');
  await h.runTask(sessionId, { text: 'Write the launch post for Acme', tool: 'web_search' });
  await wait(30);
  const rows = api.ledger.calls();
  assert.equal(rows.filter((r) => r.r === 'chat').length, 2);
  const taskRows = api.ledger.tasks();
  assert.equal(taskRows.length, 1);
  assert.equal(taskRows[0].trigger, 'user');
  assert.equal(taskRows[0].title, 'Write the launch post for Acme');
  assert.ok(rows.filter((r) => r.r === 'chat').every((r) => r.k === taskRows[0].id));
  assert.equal(calls.length, 1, 'one memory call');
  assert.equal(calls[0].provider, 'magpie');
  assert.match(calls[0].prompt, /\[user\] Write the launch post for Acme/);
  assert.match(calls[0].prompt, /\[tool\] web_search/);
  assert.ok(rows.some((r) => r.r === 'memory' && r.k === taskRows[0].id));
  assert.equal(api.memory.notes(atlas().id)[0].text, 'Kada wants launch posts under 800 words.');
  assert.equal(api.memory.notes('team')[0].text, 'The company is called Acme.');
  assert.equal(api.memory.journal({ bot: atlas().id })[0].summary, 'Wrote the Acme launch post.');
  const topic = api.topics.peek(atlas().id);
  assert.equal(topic.tasks, 1);
  assert.equal(topic.lastPrompt, 5000);
});

test('memory holds for the topic (the prompt cache keeps working); a panel edit reaches the next task', async () => {
  const agent = h.agentsById.get(atlas().sessionId);
  const section = agent.sections.get('bots:memory');
  assert.ok(section, 'memory section installed');
  // Read when the topic's first task began, before anything was remembered.
  assert.match(section.text(), /\(nothing yet\)/);
  // What the bot saves or learns within the topic is in its conversation already: the prompt stays.
  await call('memory_save', { text: 'Kada lives in Singapore.' }, atlas().sessionId);
  await h.runTask(atlas().sessionId, { text: 'Thanks' });
  assert.doesNotMatch(section.text(), /Singapore/);
  // An edit in the panel is read at the next task, never mid-task.
  agent.status = 'running';
  route('memory/put', { scope: atlas().id, note: { text: 'Kada travels on Fridays.' } });
  assert.doesNotMatch(section.text(), /Fridays/, 'not while the bot is working');
  agent.status = 'idle';
  h.emit('agent/status', { agent, status: 'idle' });
  await h.runTask(atlas().sessionId, { text: 'Hello again' });
  const text = agent.prompts.at(-1);
  assert.match(text, /Kada travels on Fridays/);
  assert.match(text, /Singapore/);
  assert.match(text, /Kada wants launch posts under 800 words/);
  assert.match(text, /The company is called Acme/);
  assert.match(text, /Wrote the Acme launch post/);
  // The usual case: an edit while the bot is idle is in the very next task's prompt.
  route('memory/put', { scope: 'team', note: { text: 'Invoices go out on the 1st.' } });
  await h.runTask(atlas().sessionId, { text: 'One more' });
  assert.match(agent.prompts.at(-1), /Invoices go out on the 1st/);
  const r = get('usage', { range: 'today' });
  assert.equal(r.totals.tasks, 4);
  assert.equal(r.tasks[0].title, 'One more');
  assert.ok(r.bots.find((b) => b.bot === atlas().id).tokens > 0);
  assert.ok(r.kinds.some((k) => k.kind === 'memory'));
});

test('memory tools: save to self or team, replace, forget, search', async () => {
  const sid = atlas().sessionId;
  const saved = await call('memory_save', { text: 'Invoices are due on the 5th.', scope: 'team', kind: 'fact' }, sid);
  assert.equal(saved.scope, 'team');
  const replaced = await call('memory_save', { text: 'Invoices are due on the 10th.', scope: 'team', replace_id: saved.note.id }, sid);
  assert.equal(replaced.note.id, saved.note.id);
  assert.equal(api.memory.notes('team').find((n) => n.id === saved.note.id).text, 'Invoices are due on the 10th.');
  const again = await call('memory_save', { text: 'invoices are due on the 10th', scope: 'team' }, sid);
  assert.match(again.text, /Already remembered/);
  await assert.rejects(call('memory_save', { text: 'my key is sk-abcdefghijklmnopqrstu' }, sid), /secret/);
  await assert.rejects(call('memory_save', { text: 'x' }), /only a bot/);
  const found = await call('memory_search', { query: 'launch post' }, sid);
  assert.match(found.text, /Wrote the Acme launch post/);
  const forgot = await call('memory_forget', { id: saved.note.id }, sid);
  assert.match(forgot.text, /Forgot/);
  // A note the user pinned stays: the bot can neither rewrite nor forget it.
  const pinned = route('memory/put', { scope: atlas().id, note: { text: 'Never post on Sundays.', pinned: true } }).note;
  await assert.rejects(call('memory_save', { text: 'Post on Sundays too.', replace_id: pinned.id }, sid), /pinned/);
  await assert.rejects(call('memory_forget', { id: pinned.id }, sid), /pinned/);
  assert.equal(api.memory.notes(atlas().id).find((n) => n.id === pinned.id).text, 'Never post on Sundays.');
  route('memory/delete', { scope: atlas().id, id: pinned.id });
  await assert.rejects(call('memory_forget', { id: 'n-nope' }, sid), /no note/);
});

test('/new starts a new topic: fresh session, schedules move, old one archived, timeline marked', async () => {
  const before = atlas().sessionId;
  await call('bot_schedule', { action: 'create', bot: '@atlas', title: 'Morning brief', prompt: 'Brief me', kind: 'daily', time: '09:00' });
  assert.equal(h.tasks[0].target.sessionId, before);
  const sid = await api.userSend(atlas(), '/new');
  assert.notEqual(sid, before);
  assert.equal(atlas().sessionId, sid);
  assert.equal(h.tasks[0].target.sessionId, sid, 'the scheduled task moved');
  assert.ok(h.archived.includes(before));
  assert.equal(h.agentsById.get(sid).inbox.length, 0, 'a bare /new delivers nothing');
  const marks = api.store.messages({ bot: atlas().id }).filter((m) => m.kind === 'topic');
  assert.equal(marks.length, 1);
  assert.equal(api.topics.history(atlas().id)[0].sessionId, before);
  assert.equal(api.topics.history(atlas().id)[0].tasks, 4);
  // Memory survives the new topic.
  assert.match(h.agentsById.get(sid).sections.get('bots:memory').text(), /Kada wants launch posts/);
  // Text after the command goes to the new topic.
  const sid2 = await api.userSend(atlas(), '/new  Plan next week');
  assert.notEqual(sid2, sid);
  assert.match(h.agentsById.get(sid2).inbox[0].content[0].text, /^Plan next week$/);
});

test('when a scheduled task cannot move, the bot stays in its topic', async () => {
  const before = atlas().sessionId;
  const edit = h.ctx.get('schedule').edit;
  let n = 0;
  h.ctx.get('schedule').edit = async (req) => {
    if (req.patch?.target && req.patch.target.sessionId !== before && (n += 1) === 1) throw new Error('disk full');
    return edit(req);
  };
  await assert.rejects(api.newTopic(atlas(), 'manual'), /could not move the scheduled tasks/);
  h.ctx.get('schedule').edit = edit;
  assert.equal(atlas().sessionId, before);
  assert.ok(h.tasks.every((t) => t.target.sessionId === before));
  assert.ok(!h.archived.includes(before));
  // Messages that arrive while a topic is starting wait for it and land in the new one.
  const rotation = api.newTopic(atlas(), 'manual');
  const sent = api.userSend(atlas(), 'Arrives mid-rotation');
  const [next, landed] = await Promise.all([rotation, sent]);
  assert.equal(landed, next);
  assert.equal(h.agentsById.get(next).inbox.at(-1).content[0].text, 'Arrives mid-rotation');
  assert.equal(api.topics.history(atlas().id)[0].sessionId, before);
});

test('a scheduled run is a task titled after its schedule', async () => {
  await get('schedules', { bot: atlas().id });
  const sid = atlas().sessionId;
  const id = h.tasks[0].id;
  await h.runTask(sid, { kind: 'schedule', text: ['[SCHEDULE REMINDER]', 'This is a scheduled message from the user', `schedule_id_json: ${JSON.stringify(id)}`, 'occurrence_at: 2026-11-16T01:00:00Z', 'reminder_prompt_json: "Brief me"'].join('\n') });
  const t = api.ledger.tasks().at(-1);
  assert.equal(t.trigger, 'schedule');
  assert.equal(t.sched, id);
  assert.equal(t.title, 'Morning brief');
  const r = get('usage', { range: '7d' });
  assert.deepEqual(r.schedules.map((s) => s.title), ['Morning brief']);
});

test('a running bot is not cut; a long quiet starts a new topic before the next message', async () => {
  const bot = atlas();
  h.agentsById.get(bot.sessionId).status = 'running';
  await assert.rejects(api.newTopic(bot, 'manual'), /still working/);
  h.agentsById.get(bot.sessionId).status = 'idle';
  // Pretend the topic went quiet seven hours ago.
  api.topics.peek(bot.id).lastActiveAt = Date.now() - 7 * 3600_000;
  const before = bot.sessionId;
  await api.sweep();
  assert.notEqual(atlas().sessionId, before);
  assert.equal(api.topics.history(bot.id)[0].reason, 'idle');
  // A fresh topic with no tasks is left alone.
  const fresh = atlas().sessionId;
  api.topics.peek(bot.id).lastActiveAt = Date.now() - 30 * 3600_000;
  await api.sweep();
  assert.equal(atlas().sessionId, fresh);
});

test('a big conversation starts a new topic at the next user message, not at a teammate DM', async () => {
  const r = await call('bot_create', { name: 'Scout', persona: 'You research.' });
  const scout = () => api.store.find('scout');
  const sid = await api.userSend(scout(), 'Research X');
  await h.runTask(sid, { text: 'Research X', usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 200_000 } });
  assert.ok(api.topics.peek(r.bot.id).lastPrompt > 128_000);
  await call('bot_send_message', { to: '@scout', text: 'Here is the answer to your question.' }, atlas().sessionId);
  assert.equal(scout().sessionId, sid, 'a DM does not cut a big conversation');
  await api.userSend(scout(), 'Next question');
  assert.notEqual(scout().sessionId, sid);
  assert.equal(api.topics.history(r.bot.id)[0].reason, 'context');
});

test('the page sees topics, today’s usage, memory counts and model details', async () => {
  const s = api.state();
  const a = s.bots.find((b) => b.id === atlas().id);
  assert.ok(a.usageToday > 0);
  assert.ok(a.memoryNotes >= 2);
  assert.ok(a.topic);
  assert.ok(s.teamNotes >= 1);
  const cat = await api.routes.catalog.get();
  const flash = cat.models.find((m) => m.model === 'auto/deepseek-flash');
  assert.equal(flash.group, 'Magpie');
  assert.deepEqual(flash.efforts, [{ id: 'high', name: 'High' }]);
  assert.equal(flash.context, 1_000_000);
  assert.deepEqual(cat.defaultModel, { provider: 'magpie', model: 'auto/deepseek-flash' });
  const mem = get('memory', { bot: atlas().id });
  assert.ok(mem.notes.length >= 2);
  assert.ok(mem.journal.length >= 2);
  assert.ok(mem.topics.length >= 2);
  const team = get('memory', { bot: 'team' });
  assert.equal(team.scope, 'team');
  const put = route('memory/put', { scope: atlas().id, note: { text: 'Pinned rule.', pinned: true } });
  assert.equal(put.note.pinned, true);
  assert.equal(route('memory/delete', { scope: atlas().id, id: put.note.id }).ok, true);
});

test('a bot model with a reasoning effort is selected with it', async () => {
  const saved = route('save', { bot: { id: atlas().id, model: { provider: 'magpie', model: 'auto/deepseek-flash', reasoningEffort: 'high' } } });
  assert.deepEqual(saved.bot.model, { provider: 'magpie', model: 'auto/deepseek-flash', reasoningEffort: 'high' });
  assert.deepEqual(h.agentsById.get(atlas().sessionId).selected, { provider: 'magpie', model: 'auto/deepseek-flash', reasoningEffort: 'high' });
  // Memory work follows the bot's model unless the settings name one.
  route('settings', { patch: { memory: { model: { provider: 'cheap', model: 'mini' } } } });
  calls.length = 0;
  await h.runTask(atlas().sessionId, { text: 'Quick one' });
  assert.equal(calls[0].provider, 'cheap');
  route('settings', { patch: { memory: { model: null } } });
});

test('dreaming consolidates each bot and writes the team digest once a day', async () => {
  calls.length = 0;
  reply = (req) => (/shared memory of the user's team/.test(req.system) ? { digest: '## Today\nAtlas wrote the launch post.', team: [{ op: 'add', text: 'Launch is on Dec 1.' }] } : { notes: [{ op: 'add', text: 'Consolidated lesson.' }] });
  const result = await route('memory/dream', {});
  assert.equal(result.ok, true);
  assert.ok(result.result.bots.length >= 1);
  assert.match(result.result.digest.text, /launch post/);
  assert.ok(api.memory.notes('team').some((n) => n.text === 'Launch is on Dec 1.' && n.source === 'dream'));
  assert.ok(api.ledger.calls().some((r) => r.r === 'dream'));
  const team = get('memory', { bot: 'team' });
  assert.equal(team.digests[0].text.startsWith('## Today'), true);
  assert.ok(team.dream.lastDate);
  // Every bot prompt now carries the digest at its next task.
  await h.runTask(atlas().sessionId, { text: 'Morning' });
  assert.match(h.agentsById.get(atlas().sessionId).sections.get('bots:memory').text(), /Latest team digest/);
});

test('a consolidation whose every step failed is tried again from the same point', async () => {
  const before = api.memory.dreamState().lastAt;
  api.memory.addJournal({ bot: atlas().id, task: 't-x', title: 'Late work', summary: 'Late work' });
  reply = () => 'not json at all';
  const r = await route('memory/dream', {});
  assert.ok(r.result.errors.length >= 1);
  assert.equal(api.memory.dreamState().lastAt, before);
  reply = { summary: 'ok', notes: [], team: [] };
});

test('custom endpoints are saved as Harness provider routes with their key in the credential store', async () => {
  const saved = await route('models/custom/save', { name: 'Local LLM', api: 'openai-completions', baseURL: 'http://127.0.0.1:1234/v1', key: 'secret-key', models: ['qwen-coder'] });
  assert.equal(saved.route, 'bots-local-llm');
  assert.equal(h.piSettings.providers['bots-local-llm'].apiKeyEnv, 'BOTS_LOCAL_LLM_API_KEY');
  assert.equal(h.secrets.get('BOTS_LOCAL_LLM_API_KEY'), 'secret-key');
  await assert.rejects(route('models/custom/save', { name: 'Local LLM', baseURL: 'http://x', key: 'k', models: ['a'] }), /exists/);
  const src = await get('models/sources');
  assert.deepEqual(src.custom.map((c) => [c.route, c.keyConfigured]), [['bots-local-llm', true]]);
  assert.ok(!JSON.stringify(src).includes('secret-key'));
  // Editing without a key keeps the stored one.
  await route('models/custom/save', { route: 'bots-local-llm', name: 'Local LLM', baseURL: 'http://127.0.0.1:1234/v1', models: ['qwen-coder', 'llama'] });
  assert.equal(h.secrets.get('BOTS_LOCAL_LLM_API_KEY'), 'secret-key');
  assert.equal(h.piSettings.providers['bots-local-llm'].models.length, 2);
  route('save', { bot: { id: atlas().id, model: { provider: 'bots-local-llm', model: 'llama' } } });
  await route('models/custom/delete', { route: 'bots-local-llm' });
  assert.equal(h.piSettings.providers['bots-local-llm'], undefined);
  assert.equal(h.secrets.has('BOTS_LOCAL_LLM_API_KEY'), false);
  assert.equal(atlas().model, null, 'a bot on a removed endpoint goes back to the default');
});

test('the Codex CLI login becomes the openai-codex route and is kept in sync', async () => {
  mkdirSync(join(home, '.codex'), { recursive: true });
  const file = join(home, '.codex', 'auth.json');
  writeFileSync(file, JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: jwt({ email: 'k@example.com' }), access_token: jwt({ exp: 2_000_000_000, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc' } }), refresh_token: 'r1', account_id: 'acc' } }));
  let src = await get('models/sources');
  assert.equal(src.logins.find((l) => l.id === 'codex').found, true);
  assert.equal(src.logins.find((l) => l.id === 'codex').connected, false);
  await route('models/login/connect', { id: 'codex' });
  assert.deepEqual(h.piSettings.providers['openai-codex'], { displayName: 'ChatGPT (Codex)' });
  assert.equal(h.records.get('llm-pi-ai/openai-codex').payload.refresh, 'r1');
  src = await get('models/sources');
  assert.equal(src.logins.find((l) => l.id === 'codex').connected, true);
  // Harness refreshes: the record changes, and the new tokens reach the Codex CLI.
  await h.ctx.get('credentials').modifyRecord('llm-pi-ai/openai-codex', async (cur) => ({ kind: 'grant', payload: { ...cur.payload, refresh: 'r2', access: jwt({ exp: 2_100_000_000 }), expires: 2_100_000_000_000 } }));
  await wait(700);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).tokens.refresh_token, 'r2');
  await route('models/login/disconnect', { id: 'codex' });
  assert.equal(h.piSettings.providers['openai-codex'], undefined);
  assert.equal(h.records.has('llm-pi-ai/openai-codex'), false);
  await assert.rejects(route('models/login/connect', { id: 'claude-code' }), /cannot be used/);
  // Harness signed in to ChatGPT itself: connecting refuses, nothing is replaced.
  h.records.set('llm-pi-ai/openai-codex', { kind: 'grant', payload: { type: 'oauth', access: 'own', refresh: 'own', expires: 1, accountId: 'acc' } });
  h.piSettings.providers['openai-codex'] = { displayName: 'ChatGPT' };
  await assert.rejects(route('models/login/connect', { id: 'codex' }), /already signed in/);
  assert.equal(h.records.get('llm-pi-ai/openai-codex').payload.refresh, 'own');
  await route('models/login/disconnect', { id: 'codex' });
  assert.ok(h.piSettings.providers['openai-codex'], 'a route the user had stays');
  assert.ok(h.records.has('llm-pi-ai/openai-codex'));
});

test('a short exchange gets a journal line but no model call', async () => {
  calls.length = 0;
  const before = api.memory.journal({ bot: atlas().id }).length;
  await h.runTask(atlas().sessionId, { text: 'ok', answer: 'Noted.' });
  assert.equal(calls.length, 0);
  assert.equal(api.memory.journal({ bot: atlas().id }).length, before + 1);
  assert.equal(api.memory.journal({ bot: atlas().id }).at(-1).summary, 'ok');
});

test('deleting a bot forgets its memory and topics', async () => {
  const scout = api.store.find('scout');
  api.memory.put(scout.id, { text: 'Scout note.' });
  await call('bot_delete', { bot: '@scout' });
  assert.equal(api.memory.notes(scout.id).length, 0);
  assert.equal(api.topics.peek(scout.id), null);
});
