import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bots-home-'));
const { apply, mcpConfigOf, templates } = await import('../index.js');
const { timingFrom, personaText, describeTiming } = await import('../lib/prompt.mjs');

/** A Harness stand-in: tools, events, agents, sessions, schedule, prompt sections. */
function fakeHarness() {
  const listeners = {};
  const tools = new Map();
  const agentsById = new Map();
  const tasks = [];
  const effects = [];
  const makeAgent = (sessionId) => {
    const sections = new Map();
    const restricts = [];
    const agent = {
      id: sessionId,
      status: 'idle',
      session: { id: sessionId },
      inbox: [],
      followup(m) {
        agent.inbox.push(m);
      },
      model: { select(sel) { agent.selected = sel; } },
      sections,
      restricts,
      ctx: {
        get(name) {
          if (name === 'systemPrompt') return { section: (s) => (sections.set(s.name, s), () => sections.delete(s.name)) };
          if (name === 'tools') return { restrict: (f) => (restricts.push(f), () => restricts.splice(restricts.indexOf(f), 1)) };
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
        return a ? { agent: a } : { error: new Error('gone') };
      },
    },
    schedule: {
      async create(req) {
        const e = { id: `schedule-${tasks.length + 1}`, title: req.title, prompt: req.prompt, kind: req.timing.kind, scheduledAt: '2099-01-01T01:00:00.000Z', status: 'active', target: req.target, ...(req.timing.daily ? { time: `${req.timing.daily.time}.000`, timeZone: req.timing.daily.time_zone } : {}) };
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
        if (patch.active !== undefined) e.status = patch.active ? 'active' : 'paused';
        return e;
      },
      async run() {
        return {};
      },
    },
  };
  const ctx = {
    tools: { register: (t) => (tools.set(t.name, t), () => tools.delete(t.name)), definitions: () => [{ name: 'bash', description: 'Run a command. More.' }, { name: 'web_fetch', description: 'Fetch.' }] },
    effect(fn) {
      const d = fn();
      effects.push(d);
    },
    on(name, fn) {
      (listeners[name] ??= []).push(fn);
    },
    get: (name) => services[name],
    inject(names, fn) {
      if (names.includes('webServer')) return;
      fn({ ...ctx, agents: services.agents, on: ctx.on, effect: ctx.effect });
    },
    logger: { warn() {} },
  };
  return { ctx, tools, agentsById, tasks, listeners, effects, emit: (n, ...a) => (listeners[n] ?? []).forEach((fn) => fn(...a)) };
}

const h = fakeHarness();
const api = apply(h.ctx, {});
const call = (name, args, sessionId) => h.tools.get(name).execute(args, sessionId ? { agent: { session: { id: sessionId } } } : {});

test('first run seeds a dispatcher', () => {
  const bots = api.store.list();
  assert.equal(bots.length, 1);
  assert.equal(bots[0].role, 'primary');
  assert.equal(bots[0].handle, 'atlas');
});

test('registers the bot tools', () => {
  for (const n of ['bot_list', 'bot_create', 'bot_update', 'bot_delete', 'bot_send_message', 'bot_schedule']) assert.ok(h.tools.has(n), n);
});

test('bot_create makes a bot with a unique handle and skills', async () => {
  const r = await call('bot_create', { name: 'Researcher', persona: 'You dig.', initials: 'RS', skills: [{ name: 'Deep dive', description: 'Long research', content: '# steps' }] });
  assert.equal(r.bot.handle, 'researcher');
  const again = await call('bot_create', { name: 'Researcher' });
  assert.equal(again.bot.handle, 'researcher-2');
  await call('bot_delete', { bot: '@researcher-2' });
  assert.equal(api.store.find('researcher').skills[0].name, 'Deep dive');
});

test('a DM creates the target conversation, applies the persona and lands in its inbox', async () => {
  const r = await call('bot_send_message', { to: '@researcher', text: 'Find three papers on X.' });
  assert.equal(r.ok, true);
  const bot = api.store.find('researcher');
  assert.ok(bot.sessionId);
  const agent = h.agentsById.get(bot.sessionId);
  assert.equal(agent.inbox.length, 1);
  assert.match(agent.inbox[0].content[0].text, /Bot message from the user/);
  const persona = agent.sections.get('bots:persona');
  assert.ok(persona, 'persona section installed');
  const text = persona.text();
  assert.match(text, /You are Researcher \(@researcher\)/);
  assert.match(text, /@atlas — Atlas \(dispatcher\)/);
  assert.match(text, /Deep dive/);
});

test('bot-to-bot DMs carry the sender and are rate limited per pair', async () => {
  const atlas = api.store.find('atlas');
  const res = await call('bot_send_message', { to: 'researcher', text: 'hi' }, 'not-a-bot-session');
  assert.equal(res.from, null);
  await call('bot_send_message', { to: 'atlas', text: 'warm up' });
  const atlasSession = api.store.find('atlas').sessionId;
  const r = await call('bot_send_message', { to: 'researcher', text: 'please summarise' }, atlasSession);
  assert.equal(r.from.handle, 'atlas');
  const inbox = h.agentsById.get(api.store.find('researcher').sessionId).inbox;
  const last = inbox.at(-1);
  assert.match(last.content[0].text, /Bot message from @atlas/);
  assert.equal(last.source.kind, 'agent-message');
  assert.equal(last.source.senderSessionId, atlasSession);
  void atlas;
  await assert.rejects(call('bot_send_message', { to: 'atlas', text: 'x' }, atlasSession), /itself/);
  let refused = null;
  for (let i = 0; i < 20 && !refused; i += 1) {
    try {
      await call('bot_send_message', { to: 'researcher', text: `ping ${i}` }, atlasSession);
    } catch (e) {
      refused = e;
    }
  }
  assert.match(String(refused?.message), /exchanged 16 messages/);
});

test('tool denial and edits are re-applied to the live agent', async () => {
  const bot = api.store.find('researcher');
  api.routes.save.post({ bot: { ...bot, tools: { deny: ['bash', 'nope'] } } });
  const agent = h.agentsById.get(bot.sessionId);
  assert.deepEqual(agent.restricts[0], { deny: ['bash'] });
  assert.ok(agent.sections.get('bots:persona'));
});

test('bot_schedule creates tasks on the bot conversation', async () => {
  const r = await call('bot_schedule', { action: 'create', bot: '@researcher', title: 'Morning digest', prompt: 'Summarise news', kind: 'daily', time: '9:00', time_zone: 'Asia/Singapore' });
  assert.equal(r.task.timing.daily.time, '09:00:00');
  assert.match(r.text, /daily at 09:00/);
  const list = await api.routes.schedules.get(new URL('http://x/?bot=' + api.store.find('researcher').id));
  assert.equal(list.items.length, 1);
  const paused = await call('bot_schedule', { action: 'pause', id: r.task.id });
  assert.equal(paused.task.status, 'paused');
});

test('the dispatcher cannot be deleted while others exist', async () => {
  await assert.rejects(call('bot_delete', { bot: 'atlas' }), /dispatcher/);
  const res = await api.routes.delete.post({ id: api.store.find('atlas').id });
  assert.equal(res.ok, false);
});

test('state maps sessions to bots', () => {
  const s = api.state();
  const bot = api.store.find('researcher');
  assert.equal(s.sessionMap[bot.sessionId], bot.id);
  assert.equal(s.bots.find((b) => b.id === bot.id).status, 'idle');
  assert.ok(s.messageCount >= 2);
});

test('timing builder and description', () => {
  assert.deepEqual(timingFrom({ kind: 'weekly', time: '18:30', weekdays: [5, 1, 1] }, 'UTC'), { kind: 'weekly', weekly: { time: '18:30:00', time_zone: 'UTC', weekdays: [1, 5] } });
  assert.deepEqual(timingFrom({ kind: 'every', every_minutes: 90 }, 'UTC'), { kind: 'every', every_seconds: 5400 });
  assert.throws(() => timingFrom({ kind: 'daily', time: '25:00' }, 'UTC'));
  assert.equal(describeTiming({ kind: 'every', every_seconds: 7200 }), 'every 2 h');
});

test('open-computer-use app maps to an mcp-client stdio row', () => {
  const t = templates().find((x) => x.id === 'open-computer-use');
  assert.deepEqual(t.args, ['mcp']);
  const c = mcpConfigOf({ template: 'open-computer-use', serverName: 'ocu', config: { command: '/x/ocu' } });
  assert.equal(c.transport, 'stdio');
  assert.equal(c.command, '/x/ocu');
  assert.equal(c.toolCallTimeoutMs, 180000);
});

test('persona text for a lone non-dispatcher', () => {
  const bot = { id: 'b', name: 'Solo', handle: 'solo', role: 'bot', persona: '', bio: '', skills: [] };
  assert.match(personaText(bot, [bot]), /only bot/);
});

test('catalog apps fill keys, paths and headers from values', () => {
  assert.ok(templates().length >= 20);
  for (const gone of ['filesystem', 'fetch', 'time']) assert.ok(!templates().some((t) => t.id === gone), `${gone} is a built-in DSH ability`);
  const tav = mcpConfigOf({ template: 'tavily', serverName: 'tavily', values: { TAVILY_API_KEY: 'k' } });
  assert.equal(tav.env.TAVILY_API_KEY, 'k');
  assert.throws(() => mcpConfigOf({ template: 'tavily', serverName: 'tavily', values: {} }), /needs/);
  const gh = mcpConfigOf({ template: 'github', serverName: 'github', values: { GITHUB_TOKEN: 't' } });
  assert.equal(gh.headers.Authorization, 'Bearer t');
  const fs = mcpConfigOf({ template: 'feishu', serverName: 'feishu', values: { appId: 'cli_1', appSecret: 's' } });
  assert.deepEqual(fs.args.slice(-4), ['-a', 'cli_1', '-s', 's']);
  const git = mcpConfigOf({ template: 'git', serverName: 'git', values: { repository: '/r' } });
  assert.deepEqual(git.args, ['mcp-server-git', '--repository', '/r']);
  const mem = mcpConfigOf({ template: 'memory', serverName: 'memory' }, { handle: 'atlas' });
  assert.match(mem.env.MEMORY_FILE_PATH, /atlas\.jsonl$/);
  const exa = mcpConfigOf({ template: 'exa', serverName: 'exa', values: { exaApiKey: 'e' } });
  assert.match(exa.url, /exaApiKey=e/);
});

test('initials avatars, including pinyin', async () => {
  const { initialsOf } = await import('../lib/store.mjs');
  assert.equal(initialsOf('研究员'), 'YJ');
  assert.equal(initialsOf('Data Scout'), 'DS');
  const r = await call('bot_create', { name: '小助手' });
  assert.equal(r.bot.avatar.kind, 'initials');
  assert.equal(r.bot.handle.length > 0, true);
});

test('AI avatar retries a dropped gateway connection', async () => {
  const { writeFileSync } = await import('node:fs');
  const png = join(process.env.DSH_HOME, 'a.png');
  writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  let calls = 0;
  h.tools.set('generate_image', {
    name: 'generate_image',
    async execute() {
      calls += 1;
      if (calls < 3) throw new Error('magpie answered 502: http2: client connection lost');
      return { images: [{ path: png, mediaType: 'image/png' }] };
    },
  });
  const original = h.ctx.tools.get;
  h.ctx.tools.get = (name) => h.tools.get(name);
  try {
    const bot = api.store.find('researcher');
    const r = await api.routes['avatar/generate'].post({ id: bot.id });
    assert.equal(r.ok, true);
    assert.equal(calls, 3);
    assert.equal(r.bot.avatar.kind, 'image');
    assert.equal(r.bot.avatar.source, 'ai');
    calls = -10;
    await assert.rejects(api.routes['avatar/generate'].post({ id: bot.id }), /failed 3 times in a row/);
  } finally {
    h.ctx.tools.get = original;
    h.tools.delete('generate_image');
  }
});

test('teams: every bot is bilingual, timings parse, apps exist in the catalog', async () => {
  const { TEAMS, teamTiming } = await import('../lib/teams.mjs');
  const ids = new Set(templates().map((t) => t.id));
  assert.ok(TEAMS.length >= 4);
  for (const team of TEAMS) {
    assert.equal(team.bots.filter((b) => b.role === 'primary').length, 1, team.id);
    for (const b of team.bots) {
      for (const k of ['name', 'bio', 'persona']) assert.ok(b[k].en && b[k].zh, `${team.id}/${b.key}.${k}`);
      for (const a of b.apps ?? []) assert.ok(ids.has(a), `${team.id}/${b.key} app ${a}`);
      for (const t of b.tasks ?? []) assert.ok(teamTiming(t.when, 'UTC').kind);
    }
  }
  assert.deepEqual(teamTiming('weekly 1,2 09:00', 'Asia/Shanghai'), { kind: 'weekly', weekly: { time: '09:00:00', time_zone: 'Asia/Shanghai', weekdays: [1, 2] } });
});

test('hiring a team creates its bots, Harness skills, apps and schedules', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [{ type: 'blob', path: 'skills/webapp-testing/SKILL.md', size: 10 }, { type: 'blob', path: 'skills/webapp-testing/run.py', size: 5 }, { type: 'blob', path: 'skills/frontend-design/SKILL.md', size: 10 }, { type: 'blob', path: 'skills/brand-guidelines/SKILL.md', size: 10 }] }));
    if (u.endsWith('/repos/anthropics/skills')) return new Response(JSON.stringify({ default_branch: 'main' }));
    if (u.endsWith('SKILL.md')) return new Response('---\nname: imported\ndescription: An imported skill.\n---\n# Body');
    return new Response('print(1)');
  };
  h.ctx.get = ((get) => (name) => (name === 'skills' ? { list: async () => [{ name: 'deep-research', description: 'Research.', source: 'user-agents' }, { name: 'xlsx', description: 'Sheets.', source: 'user-agents' }] } : get(name)))(h.ctx.get);
  try {
    const before = api.store.list().length;
    const seededAtlas = api.store.find('atlas').id;
    const r = await api.routes['teams/hire'].post({ id: 'opc', lang: 'zh' });
    assert.equal(r.ok, true);
    // The seeded dispatcher @atlas becomes the team's chief of staff instead of a duplicate.
    assert.equal(api.store.list().length, before + 4);
    assert.equal(r.leadId, seededAtlas);
    const lead = api.store.get(r.leadId);
    assert.equal(lead.role, 'primary');
    assert.match(lead.name, /幕僚长/);
    assert.ok(lead.skills.some((s) => s.source === 'dsh' && s.name === 'deep-research' && s.description === 'Research.'), 'Harness skills keep their description');
    assert.ok(r.skipped.some((x) => x.name === 'morning'), 'missing Harness skills are reported');
    const forge = r.bots.find((b) => b.team === 'opc' && /Forge/.test(b.name));
    assert.ok(forge.skills.some((s) => s.source === 'import' && s.dir));
    assert.ok(forge.apps.some((a) => a.template === 'github'));
    const ledger = r.bots.find((b) => /Ledger/.test(b.name));
    assert.ok(ledger.skills.some((s) => s.name === 'xlsx'));
    assert.ok(h.tasks.some((t) => t.title === '早间简报'));
    assert.ok(api.state().bots.find((b) => b.id === forge.id).appIssues[forge.apps[0].id], 'GitHub needs a token');
    // A Harness skill stored without a description (hired by 0.3.0) is shown with the registry's.
    api.store.save({ id: ledger.id, skills: ledger.skills.map((s) => ({ ...s, description: '' })) });
    assert.equal(api.store.get(ledger.id).skills.find((s) => s.name === 'xlsx').description, '');
    assert.equal(api.state().bots.find((b) => b.id === ledger.id).skills.find((s) => s.name === 'xlsx').description, 'Sheets.');
    assert.equal((await api.routes.state.get()).bots.find((b) => b.id === ledger.id).skills.find((s) => s.name === 'xlsx').description, 'Sheets.');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('external MCP servers are found in Codex and Claude configs', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { scanExternalMcp, maskedApp } = await import('../lib/mcp-import.mjs');
  const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n[mcp_servers.logseq]\ncommand = "uv"\nargs = ["run", "mcp-logseq"]\n[mcp_servers.logseq.env]\nTOKEN = "secret"\n[mcp_servers.docs]\nurl = "https://example.com/mcp"\n');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer t' } }, old: { type: 'sse', url: 'https://x/sse' } } }));
  const found = scanExternalMcp(home);
  assert.deepEqual(found.map((a) => `${a.from}/${a.name}/${a.template}`).sort(), ['Claude Code/gh/mcp-http', 'Codex/docs/mcp-http', 'Codex/logseq/mcp-stdio']);
  assert.equal(found.find((a) => a.name === 'logseq').config.env.TOKEN, 'secret');
  assert.equal(maskedApp(found.find((a) => a.name === 'logseq')).config.env.TOKEN, 'sec…');
});

test('SKILL.md front matter, folded descriptions included', async () => {
  const { parseSkillMd, parseGithub } = await import('../lib/skills.mjs');
  const m = parseSkillMd('---\nname: x\ndescription: >\n  line one\n  line two\n---\nBody');
  assert.equal(m.description, 'line one line two');
  assert.equal(m.body, 'Body');
  assert.deepEqual(parseGithub('https://github.com/anthropics/skills/tree/main/skills/pdf'), { owner: 'anthropics', repo: 'skills', ref: 'main', path: 'skills/pdf' });
});

// --- chat channels ---------------------------------------------------------------------------

const TG_TOKEN = '123456789:AAHsecret-telegram-token-value_xyz';
const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

/** A connector module stand-in: records sends and typing, `emit` plays an inbound message. */
function fakeChannelModule() {
  const made = [];
  return {
    made,
    live: () => made.filter((c) => !c.stopped),
    load: async (kind) => ({
      kind,
      TEXT_LIMIT: kind === 'telegram' ? 4096 : 2000,
      createConnector(opts) {
        const c = {
          kind,
          opts,
          stopped: false,
          sent: [],
          typed: [],
          async start() {
            opts.onStatus?.({ state: 'connected' });
            return { id: '555', username: 'acme_team_bot', name: 'Acme' };
          },
          async stop() {
            c.stopped = true;
          },
          async send(chatId, text, o) {
            c.sent.push({ chatId, text, ...(o ?? {}) });
          },
          async typing(chatId) {
            c.typed.push(chatId);
          },
          emit: (msg) => opts.onMessage(msg),
        };
        made.push(c);
        return c;
      },
    }),
  };
}

/** A second Harness with its own home, so the channel tests start from a clean roster. */
function channelHarness(loadConnector) {
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bots-channel-home-'));
  try {
    const hh = fakeHarness();
    return { hh, api: apply(hh.ctx, {}, { loadConnector, typingEveryMs: 5 }) };
  } finally {
    process.env.DSH_HOME = before;
  }
}

/** Play the Harness's session events for the last message in a bot's inbox. */
function seeInbox(hh, bot) {
  const agent = hh.agentsById.get(bot.sessionId);
  hh.emit('session/event', agent.session, { type: 'user/message', data: agent.inbox.at(-1) });
  return agent;
}
const says = (hh, bot, text, calls = []) =>
  hh.emit('session/event', { id: bot.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }, ...calls] } } });

test('chat channels: a Telegram app connects, pairs, routes messages and sends replies back', async () => {
  const fake = fakeChannelModule();
  const { hh, api: capi } = channelHarness(fake.load);
  const atlas = capi.store.find('atlas');
  // Not an MCP server: no mcp-client row, no MCP issue; a missing token is the issue.
  assert.equal(mcpConfigOf({ template: 'telegram', serverName: 'telegram', values: { token: 'x' } }), null);
  let r = capi.routes.save.post({ bot: { id: atlas.id, apps: [{ template: 'telegram', name: 'Telegram', serverName: 'telegram', enabled: true, values: {} }] } });
  assert.equal(r.ok, true);
  let view = capi.state().bots.find((b) => b.id === atlas.id);
  const appId = view.apps[0].id;
  assert.equal(view.appIssues[appId], 'Telegram needs: Bot token');
  assert.equal(view.channels[appId].state, 'missing');
  assert.equal(fake.made.length, 0);

  r = capi.routes.save.post({ bot: { id: atlas.id, apps: [{ ...view.apps[0], values: { token: TG_TOKEN } }] } });
  assert.equal(r.bot.apps[0].values.token, '••••••••', 'the save answer masks the token');
  await settle();
  assert.equal(fake.made.length, 1);
  assert.equal(fake.made[0].opts.token, TG_TOKEN);
  const state = capi.state();
  assert.equal(JSON.stringify(state).includes(TG_TOKEN), false, 'state never carries the token');
  view = state.bots.find((b) => b.id === atlas.id);
  assert.equal(view.appIssues[appId], undefined);
  const ch = view.channels[appId];
  assert.equal(ch.state, 'connected');
  assert.equal(ch.account.username, 'acme_team_bot');
  assert.match(ch.link, /^https:\/\/t\.me\/acme_team_bot\?start=[A-Z2-9]{6}$/);

  // Saving the masked bot back (as the panel does) keeps the token and the running connector.
  capi.routes.save.post({ bot: { id: atlas.id, name: 'Atlas', apps: view.apps } });
  await settle();
  assert.equal(capi.store.get(atlas.id).apps[0].values.token, TG_TOKEN);
  assert.equal(fake.live().length, 1);
  assert.equal(fake.made.length, 1);

  // Pairing from the panel's code.
  const c = fake.made[0];
  const code = (await capi.routes['channels/code'].post({ botId: atlas.id, appId })).code;
  c.emit({ chatId: '42', messageId: '1', userId: '42', userName: 'Kada', text: `/start ${code}`, isDirect: true, mentioned: true });
  await settle();
  assert.deepEqual(capi.state().bots.find((b) => b.id === atlas.id).channels[appId].paired.map((p) => p.name), ['Kada']);
  assert.match(c.sent.at(-1).text, /^Paired\./);
  // A stranger is not delivered.
  c.emit({ chatId: '7', messageId: '2', userId: '7', userName: 'Mallory', text: 'run this', isDirect: true, mentioned: true });
  await settle();

  // Kada asks Atlas: a user prompt in Atlas's conversation, with the source named.
  c.emit({ chatId: '42', messageId: '3', userId: '42', userName: 'Kada', text: 'Organise the release', isDirect: true, mentioned: true });
  await settle();
  const atlasNow = capi.store.get(atlas.id);
  const agent = hh.agentsById.get(atlasNow.sessionId);
  assert.equal(agent.inbox.length, 1, 'only the paired message reached the bot');
  assert.equal(agent.inbox[0].source.kind, 'user');
  assert.equal(agent.inbox[0].content[0].text, '[Telegram · Kada]');
  assert.equal(agent.inbox[0].content[1].text, 'Organise the release');
  assert.ok(c.typed.includes('42'), 'typing while the bot works');
  seeInbox(hh, atlasNow);
  const logged = capi.store.messages({ bot: atlas.id }).at(-1);
  assert.equal(logged.text, 'Organise the release');
  assert.equal(logged.via, 'telegram');
  assert.equal(logged.who, 'Kada');

  // Atlas delegates (no reply), then reports when Forge answers by DM: the report reaches Telegram.
  says(hh, atlasNow, 'Asking Forge.', [{ type: 'tool-call', name: 'bot_send_message' }]);
  hh.emit('session/event', { id: atlasNow.sessionId }, { type: 'turn/end', data: { turn: 1, reason: 'done' } });
  const forge = capi.store.save({ name: 'Forge' });
  await capi.deliver(atlasNow, forge, 'Fix the three bugs.', atlasNow.sessionId);
  await capi.deliver(capi.store.get(forge.id), atlasNow, 'Done: three bugs fixed.', capi.store.get(forge.id).sessionId);
  assert.equal(agent.inbox.at(-1).source.kind, 'agent-message');
  seeInbox(hh, atlasNow);
  says(hh, atlasNow, '**Release update**: Forge fixed the three bugs.');
  await settle();
  assert.deepEqual(c.sent.at(-1), { chatId: '42', text: 'Release update: Forge fixed the three bugs.' });
  assert.equal(capi.store.messages({ bot: atlas.id }).at(-1).via, 'telegram');

  // @forge from Telegram goes straight to Forge, and Forge's answer comes back to the chat.
  c.emit({ chatId: '42', messageId: '4', userId: '42', userName: 'Kada', text: '@forge what is left?', isDirect: true, mentioned: true });
  await settle();
  const forgeNow = capi.store.get(forge.id);
  const forgeAgent = seeInbox(hh, forgeNow);
  assert.equal(forgeAgent.inbox.at(-1).content[1].text, 'what is left?');
  says(hh, forgeNow, 'Only the docs.');
  await settle();
  assert.deepEqual(c.sent.at(-1), { chatId: '42', text: 'Only the docs.' });

  // A message typed in the panel takes Atlas's replies back to the panel.
  const sentBefore = c.sent.length;
  await capi.routes.send.post({ to: atlas.id, text: 'And from the panel?' });
  seeInbox(hh, atlasNow);
  says(hh, atlasNow, 'Answered in the panel.');
  await settle();
  assert.equal(c.sent.length, sentBefore);
  assert.equal(capi.store.messages({ bot: atlas.id }).at(-1).via, undefined);

  // Options, removing the person, a new token, turning the app off, and plugin dispose.
  assert.equal((await capi.routes['channels/options'].post({ botId: atlas.id, appId, scheduleReplies: false })).scheduleReplies, false);
  assert.equal((await capi.routes['channels/unpair'].post({ botId: atlas.id, appId, userId: '42' })).ok, true);
  assert.equal((await capi.routes['channels/unpair'].post({ botId: atlas.id, appId, userId: '42' })).ok, false);
  const apps = capi.state().bots.find((b) => b.id === atlas.id).apps;
  capi.routes.save.post({ bot: { id: atlas.id, apps: [{ ...apps[0], values: { token: '987654321:BBanother-token-for-this-team' } }] } });
  await settle();
  assert.equal(c.stopped, true);
  assert.equal(fake.live().length, 1);
  capi.routes.save.post({ bot: { id: atlas.id, apps: [{ ...apps[0], enabled: false }] } });
  await settle();
  assert.equal(fake.live().length, 0);
  capi.routes.save.post({ bot: { id: atlas.id, apps: [{ ...apps[0], enabled: true }] } });
  await settle();
  assert.equal(fake.live().length, 1);
  for (const dispose of hh.effects) if (typeof dispose === 'function') dispose();
  await settle();
  assert.equal(fake.live().length, 0, 'plugin dispose stops every connector');
});

test('chat channels: deleting a bot stops its connector; the persona tells bots about the chat app', async () => {
  const fake = fakeChannelModule();
  const { api: capi } = channelHarness(fake.load);
  const scout = capi.store.save({ name: 'Scout', apps: [{ template: 'discord', name: 'Discord', serverName: 'discord', enabled: true, values: { token: 'discord-token-value-1234567890' } }] });
  await settle();
  assert.equal(fake.live().length, 1);
  assert.equal(fake.live()[0].kind, 'discord');
  const atlas = capi.store.find('atlas');
  const text = personaText(atlas, capi.store.list(), { channels: ['Discord'] });
  assert.match(text, /## Chat apps/);
  assert.match(text, /"\[Discord · Name\]"/);
  assert.equal((await capi.routes.delete.post({ id: scout.id })).ok, true);
  await settle();
  assert.equal(fake.live().length, 0);
});

test('chat channels: the real Discord module connects through the host and a reply goes back over REST', async () => {
  const discord = await import('../lib/channels/discord.mjs');
  const TOKEN = ['MTA5ODc2NTQzMjEwOTg3NjU0', 'Gx1AbC', 'sEcReT-token_value-do-not-leak'].join('.');
  const BOT = '1098765432109876543';
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = {};
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
      this.emit('close', { code, reason: '' });
    }
    push(frame) {
      this.emit('message', { data: JSON.stringify(frame) });
    }
  }
  const rest = [];
  const res = (status, body) => ({ ok: status < 300, status, headers: new Headers(), text: async () => (body == null ? '' : JSON.stringify(body)), json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    rest.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith('/gateway/bot')) return res(200, { url: 'wss://gateway.test', shards: 1, session_start_limit: { remaining: 999 } });
    if (String(url).endsWith('/typing')) return res(204, null);
    return res(200, { id: String(rest.length) });
  };
  const load = async (kind) => {
    assert.equal(kind, 'discord');
    return { ...discord, createConnector: (opts) => discord.createConnector({ ...opts, fetchImpl, WebSocketImpl: FakeSocket, random: () => 0.5 }) };
  };
  const { hh, api: capi } = channelHarness(load);
  const atlas = capi.store.find('atlas');
  capi.routes.save.post({ bot: { id: atlas.id, apps: [{ template: 'discord', name: 'Discord', serverName: 'discord', enabled: true, values: { token: TOKEN } }] } });
  await settle();
  const appId = capi.store.get(atlas.id).apps[0].id;
  assert.equal(capi.state().bots[0].channels[appId].state, 'connecting');
  const ws = sockets.at(-1);
  ws.push({ op: 10, d: { heartbeat_interval: 40_000 } });
  ws.push({ op: 0, t: 'READY', s: 1, d: { v: 10, session_id: 's1', resume_gateway_url: 'wss://resume.test', user: { id: BOT, username: 'helper', global_name: 'Helper', bot: true }, guilds: [] } });
  await settle();
  let ch = capi.state().bots[0].channels[appId];
  assert.equal(ch.state, 'connected');
  assert.equal(ch.account.username, 'helper');
  assert.equal(ch.invite, `https://discord.com/oauth2/authorize?client_id=${BOT}&scope=bot&permissions=68608`);
  // Pair by DM, then ask: the DM becomes a prompt; the reply is posted to the DM channel.
  const dmFrame = (id, content) => ({ op: 0, t: 'MESSAGE_CREATE', s: 2 + Number(id), d: { id, channel_id: 'dm-1', author: { id: '77', username: 'kada', global_name: 'Kada' }, content, type: 0, mentions: [] } });
  ws.push(dmFrame('10', ch.code.code));
  await settle();
  ws.push(dmFrame('11', 'What is on today?'));
  await settle();
  const atlasNow = capi.store.get(atlas.id);
  const agent = seeInbox(hh, atlasNow);
  assert.deepEqual(agent.inbox[0].content.map((b) => b.text), ['[Discord · Kada]', 'What is on today?']);
  says(hh, atlasNow, 'Two meetings and the **launch post**.');
  await settle();
  const posts = rest.filter((x) => x.method === 'POST' && x.url.endsWith('/channels/dm-1/messages'));
  assert.deepEqual(posts.map((p) => p.body.content).slice(-1), ['Two meetings and the **launch post**.'], 'Discord keeps Markdown');
  assert.ok(rest.some((x) => x.url.endsWith('/channels/dm-1/typing')));
  // 4014 (Message Content Intent off) after a reconnect reads as the intent hint.
  capi.routes['channels/reconnect'].post({ botId: atlas.id, appId });
  await settle();
  const ws2 = sockets.at(-1);
  assert.notEqual(ws2, ws);
  ws2.push({ op: 10, d: { heartbeat_interval: 40_000 } });
  ws2.emit('close', { code: 4014, reason: 'Disallowed intent(s).' });
  await settle();
  ch = capi.state().bots[0].channels[appId];
  assert.equal(ch.state, 'error');
  assert.equal(ch.hint, 'intent');
  assert.equal(JSON.stringify(capi.state()).includes(TOKEN), false);
  for (const dispose of hh.effects) if (typeof dispose === 'function') dispose();
  await settle();
});
