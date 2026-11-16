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

test('local skills: a folder is scanned and linked once, read live, and name clashes are skipped', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } = await import('node:fs');
  const { listLocalSkills, resolveLocalPath, mergeImported } = await import('../lib/skills.mjs');
  const root = mkdtempSync(join(tmpdir(), 'local-skills-'));
  const mk = (rel, text) => (mkdirSync(join(root, rel, '..'), { recursive: true }), writeFileSync(join(root, rel), text));
  mk('alpha/SKILL.md', '---\nname: alpha\ndescription: First.\n---\n# Alpha v1');
  mk('alpha/scripts/run.py', 'print(1)');
  mk('alpha/.git/config', 'x');
  mk('alpha/node_modules/dep/index.js', 'x');
  mk('group/beta/skill.md', '# Beta without front matter');
  mk('group/beta/nested/SKILL.md', '---\nname: inner\n---\nnot a skill of its own');
  mk('.hidden/gamma/SKILL.md', '---\nname: gamma\n---\n');
  mk('node_modules/pkg/SKILL.md', '---\nname: pkg\n---\n');
  mk('notes/readme.md', 'no skill here');
  symlinkSync(root, join(root, 'group', 'loop'));

  const listing = listLocalSkills(root);
  assert.deepEqual(listing.skills.map((s) => s.name), ['alpha', 'beta']);
  assert.equal(listing.skills[0].files, 2); // SKILL.md + scripts/run.py; .git and node_modules left out
  assert.equal(listLocalSkills(join(root, 'alpha', 'SKILL.md')).skills[0].path, join(root, 'alpha'));
  assert.equal(resolveLocalPath('~/x/', '/home/me'), '/home/me/x');
  assert.throws(() => listLocalSkills(join(root, 'nope')), /no such folder/);
  assert.equal((await api.routes['skills/local'].post({ path: join(root, 'nope') })).ok, false);
  assert.deepEqual((await api.routes['skills/local'].post({ path: root })).skills.map((s) => s.name), ['alpha', 'beta']);

  const bot = api.store.save({ name: 'Local', handle: 'local-skills', skills: [{ name: 'Beta', source: 'own', content: '# mine' }] });
  const post = (items) => api.routes['skills/import'].post({ botId: bot.id, items });
  let r = await post([{ local: join(root, 'alpha') }, { local: join(root, 'group', 'beta') }, { local: join(root, 'notes') }]);
  assert.deepEqual([r.added, r.updated, r.skipped], [['alpha'], [], [{ name: 'beta', reason: 'exists' }]]);
  assert.match(r.failed[0].reason, /no SKILL\.md/);
  const first = api.store.get(bot.id).skills.find((s) => s.name === 'alpha');
  // Linked, not copied: the skill points at the folder itself.
  assert.deepEqual([first.origin, first.dir, first.linked, first.content], [join(root, 'alpha'), join(root, 'alpha'), true, '# Alpha v1']);

  // Again from the same folder: still one skill, same id, its on/off kept, the folder untouched.
  api.store.save({ id: bot.id, skills: api.store.get(bot.id).skills.map((s) => (s.name === 'alpha' ? { ...s, enabled: false } : s)) });
  r = await post([{ local: join(root, 'alpha') }, { local: join(root, 'alpha') }]);
  assert.deepEqual([r.added, r.updated, r.skipped.length], [[], ['alpha'], 1]);
  const again = api.store.get(bot.id).skills.filter((s) => s.name === 'alpha');
  assert.deepEqual([again.length, again[0].id, again[0].enabled], [1, first.id, false]);
  assert.ok(existsSync(join(root, 'alpha', 'scripts', 'run.py')));
  assert.equal(api.store.get(bot.id).skills.length, 2);

  // An edit in the folder reaches the bot: the panel shows it, and the conversation re-installs the skill.
  api.store.save({ id: bot.id, skills: api.store.get(bot.id).skills.map((s) => ({ ...s, enabled: true })) });
  const registered = [];
  const agent = { session: { id: 'sess-local' }, ctx: { get: (name) => (name === 'skills' ? { register: (sk) => (registered.push(sk), () => {}) } : name === 'systemPrompt' ? { section: () => () => {} } : name === 'tools' ? { restrict: () => () => {} } : undefined) } };
  api.store.save({ id: bot.id, sessionId: 'sess-local' });
  api.reconcile(agent);
  const reg = () => registered.filter((x) => x.name === 'local-skills-alpha').at(-1);
  assert.equal(reg().content, '# Alpha v1');
  assert.deepEqual(reg().resourceBase, { kind: 'directory', path: join(root, 'alpha') });
  mk('alpha/SKILL.md', '---\nname: alpha\ndescription: Second.\n---\n# Alpha v2, longer');
  api.reconcile(agent);
  assert.deepEqual([reg().content, reg().description], ['# Alpha v2, longer', 'Second.']);
  assert.equal(api.state().bots.find((b) => b.id === bot.id).skills.find((s) => s.name === 'alpha').description, 'Second.');
  // The folder gone: flagged in the panel, and the bot keeps what was read when it was linked.
  const { rmSync } = await import('node:fs');
  rmSync(join(root, 'alpha'), { recursive: true });
  assert.equal(api.state().bots.find((b) => b.id === bot.id).skills.find((s) => s.name === 'alpha').missing, true);
  api.reconcile(agent);
  assert.equal(reg().content, '# Alpha v1');

  // A same-named skill from somewhere else never replaces what is there.
  const m = mergeImported([{ id: 'a', name: 'pdf', source: 'dsh' }], [{ id: 'b', name: 'PDF', source: 'import', origin: '/x/pdf', dir: '/tmp/b' }]);
  assert.deepEqual([m.skills.length, m.added, m.skipped], [1, [], [{ name: 'PDF', reason: 'exists' }]]);

  // The store itself drops certain repeats: a Harness skill linked twice, one import made twice.
  const twice = api.store.save({ id: bot.id, skills: [
    { name: 'xlsx', source: 'dsh' }, { name: 'xlsx', source: 'dsh' },
    { name: 'pdf', source: 'import', origin: 'https://github.com/a/b/tree/main/pdf' }, { name: 'pdf', source: 'import', origin: 'https://github.com/a/b/tree/main/pdf' },
    { name: 'draft', source: 'own', content: '1' }, { name: 'draft', source: 'own', content: '2' },
  ] });
  assert.deepEqual(twice.skills.map((s) => s.name), ['xlsx', 'pdf', 'draft', 'draft']);
});

test('skills: at most 50 are on at once, the rest kept switched off; at most 200 are kept', async () => {
  const { mergeImported } = await import('../lib/skills.mjs');
  const { MAX_SKILLS, MAX_SKILLS_ON } = await import('../lib/store.mjs');
  assert.deepEqual([MAX_SKILLS, MAX_SKILLS_ON], [200, 50]);
  assert.deepEqual(api.state().limits, { skills: 200, skillsOn: 50 });
  const names = (n, p) => Array.from({ length: n }, (_, i) => ({ name: `${p}${i}`, content: 'x' }));
  const onOf = (b) => b.skills.filter((s) => s.enabled).map((s) => s.name);

  // Created with 60: all kept, the first 50 on, and the tool says which came in off.
  const r = await call('bot_create', { name: 'Many', skills: names(60, 's') });
  let bot = api.store.find(r.bot.handle);
  assert.equal(bot.skills.length, 60);
  assert.equal(onOf(bot).length, 50);
  assert.deepEqual(bot.skills.filter((s) => !s.enabled).map((s) => s.name), names(10, 's').map((s, i) => `s${50 + i}`));
  assert.match(r.text, /switched off.*: s50, s51/);

  // One off, another on: fits.
  bot = api.store.save({ id: bot.id, skills: bot.skills.map((s) => (s.name === 's0' ? { ...s, enabled: false } : s.name === 's55' ? { ...s, enabled: true } : s)) });
  assert.deepEqual([onOf(bot).length, onOf(bot).includes('s55'), onOf(bot).includes('s0')], [50, true, false]);
  // One more on past 50: the newcomer stays off, the ones on before stay on.
  bot = api.store.save({ id: bot.id, skills: bot.skills.map((s) => (s.name === 's56' ? { ...s, enabled: true } : s)) });
  assert.deepEqual([onOf(bot).length, onOf(bot).includes('s56'), onOf(bot).includes('s55')], [50, false, true]);

  // bot_update adds past 50 on switched off, and says so.
  const u = await call('bot_update', { bot: `@${bot.handle}`, add_skills: [{ name: 'late', content: 'x' }] });
  assert.match(u.text, /switched off.*: late\./);
  bot = api.store.find(bot.handle);
  assert.deepEqual([bot.skills.length, bot.skills.find((s) => s.name === 'late').enabled], [61, false]);
  // Past 200 kept: refused, nothing changed.
  await assert.rejects(call('bot_update', { bot: `@${bot.handle}`, add_skills: names(140, 't') }), /at most 200 skills/);
  assert.equal(api.store.find(bot.handle).skills.length, 61);

  // Imports: a new one past 50 on comes in off; past 200 kept is skipped as full.
  const m = mergeImported(bot.skills, [{ id: 'n1', name: 'fresh', source: 'import', origin: '/x/fresh', enabled: true }]);
  assert.deepEqual([m.added, m.off, m.skills.at(-1).enabled], [['fresh'], ['fresh'], false]);
  const few = mergeImported([{ id: 'a', name: 'a', enabled: true }], [{ id: 'b', name: 'b', enabled: true }]);
  assert.deepEqual([few.off, few.skills[1].enabled], [[], true]);
  const full = mergeImported(Array.from({ length: 200 }, (_, i) => ({ id: `k${i}`, name: `k${i}`, enabled: false })), [{ id: 'z', name: 'z', enabled: true }]);
  assert.deepEqual([full.added, full.skipped], [[], [{ name: 'z', reason: 'full' }]]);

  await call('bot_delete', { bot: `@${bot.handle}` });
});
