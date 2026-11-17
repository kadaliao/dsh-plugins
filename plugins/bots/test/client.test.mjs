import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'client.js'), 'utf8');
const allHooks = [];
afterEach(() => {
  for (const hooks of allHooks.splice(0)) hooks.runCleanups();
  delete globalThis.fetch;
});

/** A hook-capable stand-in for React that renders plain element trees. */
function fakeReact() {
  let slots = [];
  let cursor = 0;
  const hooks = {
    reset() {
      slots = [];
      cursor = 0;
    },
    rewind() {
      cursor = 0;
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      const set = (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      };
      return [slots[index], set];
    },
    cleanups: [],
    useEffect(effect, deps) {
      const index = cursor++;
      const last = slots[index];
      if (last !== undefined && deps !== undefined && deps.length === last.length && deps.every((d, i) => Object.is(d, last[i]))) return;
      slots[index] = deps ?? [];
      const cleanup = effect();
      if (typeof cleanup === 'function') hooks.cleanups.push(cleanup);
    },
    runCleanups() {
      for (const cleanup of hooks.cleanups.splice(0)) cleanup();
    },
  };
  const createElement = (type, props, ...children) => {
    const kids = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
    if (typeof type === 'function') {
      // A different component (or key) at this position is a remount: drop the stale hook slots after it.
      const index = cursor++;
      const mark = { type, key: props?.key };
      const last = slots[index];
      if (last && (last.type !== type || last.key !== mark.key)) slots.length = index;
      slots[index] = mark;
      return type({ ...(props ?? {}), ...(kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {}) });
    }
    return { type, props: props ?? {}, children: kids };
  };
  allHooks.push(hooks);
  return { React: { createElement, useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect }, hooks };
}

async function loadClient({ primitives } = {}) {
  const { React, hooks } = fakeReact();
  let factory;
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory: make }) {
        assert.equal(id, '@kadaliao/dsh-bots');
        factory = make;
      },
    },
  };
  new Function('source', `${source}\n//# sourceURL=client.js`)(source);
  const exports = factory((name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives' && primitives) return primitives;
    throw new Error(`unexpected require ${name}`);
  });
  return { exports, hooks };
}

function fakeContext({ services = {} } = {}) {
  const seen = { slots: [], locale: null, decorations: [], selected: [], opened: [] };
  const all = {
    layout: { selectPanel: (id) => seen.selected.push(id) },
    uiWorkspace: { openSession: (id) => seen.opened.push(id) },
    ...services,
  };
  const ctx = {
    get: (name) => all[name],
    inject(names, callback) {
      seen.injected = [...(seen.injected ?? []), ...names];
      callback({
        effect: (fn) => fn(),
        commandUi: {
          decorate(decoration) {
            seen.decorations.push(decoration);
            return () => {};
          },
        },
      });
    },
    effect: (fn) => fn(),
    locale: {
      register(ns, dict) {
        seen.locale = { ns, dict };
        return () => {};
      },
    },
    slots: {
      inject: (_key, callback) => callback(),
      register(options, component) {
        seen.slots.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, seen };
}

function collect(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  for (const child of node.children ?? []) collect(child, out);
  return out;
}
function findAll(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, pred, out);
  return out;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const BOTS = [
  { id: 'bot-a', name: 'Ada', handle: 'ada', role: 'primary', avatar: { kind: 'initials', color: '#7c5cff' }, bio: 'Dispatches work', persona: 'You are Ada.', skills: [{ id: 's1', name: 'weekly', description: 'Weekly report', content: '# Do it', enabled: true }], apps: [], tools: { deny: ['bash'] }, model: null, sessionId: 'sess-a', status: 'running' },
  { id: 'bot-b', name: 'Bob', handle: 'bob', role: 'bot', avatar: { kind: 'image', url: '/__dsh_bots/avatar/bot-b?v=1', color: '#3b82f6' }, bio: 'Codes', persona: '', skills: [], apps: [
    { id: 'app1', template: 'mcp-stdio', name: 'Files', serverName: 'files', enabled: true, values: {}, config: { command: 'npx', args: ['-y', 'x'], env: {} } },
    { id: 'app2', template: 'tavily', name: 'Tavily Search', serverName: 'tavily', enabled: true, values: {}, config: {} },
  ], appIssues: { app2: 'Tavily Search needs: API key' }, tools: { deny: [] }, model: { provider: 'p', model: 'm' }, sessionId: 'sess-b', status: 'idle' },
  { id: 'bot-c', name: '研究员', handle: 'yj', role: 'bot', avatar: { kind: 'initials', color: '#10b981' }, bio: '', persona: '', skills: [], apps: [], appIssues: {}, tools: { deny: [] }, model: null, sessionId: null, status: 'offline' },
];
const STATE = { bots: BOTS, primaryId: 'bot-a', sessionMap: { 'sess-a': 'bot-a', 'sess-b': 'bot-b' }, messageCount: 2, version: 1 };
const CATALOG = {
  templates: [
    { id: 'open-computer-use', name: { en: 'Open Computer Use', zh: 'Open Computer Use 电脑操控' }, description: { en: 'Control your Mac.', zh: '操作 Mac。' }, category: 'computer', icon: 'OC', color: '#111827', transport: 'stdio', serverName: 'ocu', command: '/x/ocu', args: ['mcp'], runtime: 'binary', homepage: 'https://github.com/kadaliao/open-computer-use', featured: true, fields: [{ key: 'OCU_API_KEY', kind: 'secret', label: { en: 'Planner API key (optional)', zh: '规划模型 API Key（可选）' } }] },
    { id: 'fetch', name: { en: 'Fetch', zh: '网页抓取' }, description: { en: 'Fetch any URL.', zh: '抓取任意网址。' }, category: 'search', icon: 'FE', color: '#0ea5e9', transport: 'stdio', serverName: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], runtime: 'uv', homepage: 'https://example.com/fetch', featured: true },
    { id: 'tavily', name: { en: 'Tavily Search', zh: 'Tavily 搜索' }, description: { en: 'Search for agents.', zh: '为 Agent 设计的搜索。' }, category: 'search', icon: 'TV', color: '#7c3aed', transport: 'stdio', serverName: 'tavily', command: 'npx', runtime: 'node', homepage: 'https://example.com/tavily', keyUrl: 'https://app.tavily.com', fields: [{ key: 'TAVILY_API_KEY', kind: 'secret', required: true, label: { en: 'API key', zh: 'API Key' } }] },
    { id: 'filesystem', name: { en: 'Filesystem', zh: '文件系统' }, description: { en: 'Files in folders you allow.', zh: '在允许的文件夹里读写文件。' }, category: 'data', icon: 'FS', color: '#0f766e', transport: 'stdio', serverName: 'files', command: 'npx', runtime: 'node', homepage: 'https://example.com/fs', fields: [{ key: 'dirs', kind: 'path', arg: true, multi: true, required: true, label: { en: 'Allowed folders (one per line)', zh: '允许访问的文件夹（每行一个）' }, default: '/Users/x/Documents', help: { en: 'Absolute paths.', zh: '绝对路径。' } }] },
    { id: 'amap', name: { en: 'Amap', zh: '高德地图' }, description: { en: 'Maps in China.', zh: '高德地图。' }, category: 'life', icon: '高', color: '#2f6bff', transport: 'stdio', serverName: 'amap', command: 'npx', runtime: 'node', region: 'cn', homepage: 'https://lbs.amap.com', keyUrl: 'https://console.amap.com', fields: [{ key: 'AMAP_MAPS_API_KEY', kind: 'secret', required: true, label: { en: 'Web service key', zh: 'Web 服务 Key' } }] },
    { id: 'mcp-stdio', name: { en: 'Custom local server', zh: '自定义本地服务' }, description: { en: 'Any local server.', zh: '任意本地服务。' }, category: 'custom', icon: '{ }', color: '#475569', transport: 'stdio', serverName: 'tools', command: 'npx', args: ['-y', 'your-mcp-server'], homepage: 'https://modelcontextprotocol.io', custom: true },
  ],
  categories: [
    { id: 'computer', en: 'Computer & browser', zh: '电脑与浏览器' },
    { id: 'search', en: 'Search & web', zh: '搜索与网页' },
    { id: 'data', en: 'Files & data', zh: '文件与数据' },
    { id: 'life', en: 'Maps & everyday', zh: '地图与生活' },
    { id: 'custom', en: 'Custom', zh: '自定义' },
  ],
  imageGen: true,

  tools: [
    { name: 'bash', description: 'Run a command.' },
    { name: 'read', description: 'Read a file.' },
  ],
  models: [{ provider: 'p', model: 'm', label: 'P · M' }],
  skills: [{ name: 'pdf', description: 'PDF things' }],
  ocu: { installed: false, path: '/Users/x/.local/share/ocu/ocu' },
  mcp: true,
  zone: 'Asia/Singapore',
  abilities: [
    { id: 'web', name: { en: 'Web search & reading', zh: '联网搜索与阅读' }, description: { en: 'Search the web.', zh: '搜索网络。' }, tools: ['web_search', 'web_fetch'], available: ['web_search', 'web_fetch'] },
    { id: 'code', name: { en: 'Run commands & code', zh: '运行命令与代码' }, description: { en: 'Run shell commands.', zh: '执行命令。' }, tools: ['bash', 'job_list'], available: ['bash'] },
    { id: 'images', name: { en: 'Image generation', zh: 'AI 作图' }, description: { en: 'Draw.', zh: '画图。' }, tools: ['generate_image'], available: [] },
    { id: 'plugins', name: { en: 'Manage Harness plugins', zh: '管理 Harness 插件' }, description: { en: 'Plugins.', zh: '插件。' }, tools: ['plugin_manager'], available: ['plugin_manager'], risky: true },
  ],
  skillSources: [{ id: 'anthropics', repo: 'anthropics/skills', path: 'skills', name: { en: 'Anthropic skills', zh: 'Anthropic 官方技能' }, description: { en: 'Docs and design.', zh: '文档与设计。' } }],
};
const TEAMS = [
  {
    id: 'opc', name: { en: 'One-person company', zh: '一人公司' }, tagline: { en: 'A chief of staff plus four.', zh: '一个幕僚长加四个角色。' }, description: { en: 'For founders.', zh: '给创始人。' }, color: '#7c5cff', kickoff: { en: 'Hi team, introduce yourselves.', zh: '大家好，介绍一下自己。' },
    bots: [
      { key: 'chief', handle: 'atlas', name: { en: 'Atlas', zh: 'Atlas 幕僚长' }, color: '#7c5cff', bio: { en: 'Chief of staff: plans.', zh: '幕僚长：排计划。' }, role: 'primary', skills: [{ name: 'deep-research', source: 'dsh', available: true }, { name: 'morning', source: 'dsh', available: false }], apps: [], tasks: [{ when: 'weekly 1,2,3,4,5 09:00', title: { en: 'Morning brief', zh: '早间简报' } }, { when: 'weekly 5 17:30', title: { en: 'Weekly review', zh: '周复盘' } }] },
      { key: 'builder', handle: 'forge', name: { en: 'Forge', zh: 'Forge 工程师' }, color: '#0f766e', bio: { en: 'Product engineer: builds.', zh: '产品工程师：开发。' }, role: 'bot', skills: [{ name: 'webapp-testing', source: 'import', repo: 'anthropics/skills', available: true }], apps: [{ id: 'tavily', available: true }], tasks: [] },
    ],
  },
  { id: 'dev', name: { en: 'Software squad', zh: '研发小队' }, tagline: { en: 'Plan, build.', zh: '规划、开发。' }, description: { en: 'Ship.', zh: '交付。' }, color: '#0f766e', kickoff: { en: 'Lead: ask me.', zh: '负责人：问我。' }, bots: [] },
];
const LIBRARY = { skills: [{ name: 'deep-research', description: 'Research a topic.', source: 'user' }, { name: 'xlsx', description: 'Spreadsheets.', source: 'bundled' }, { name: 'weekly', description: 'Already there', source: 'user' }], sources: [] };
const GITHUB = { ok: true, owner: 'anthropics', repo: 'skills', ref: 'main', skills: [{ name: 'mcp-builder', description: 'Build MCP servers.', path: 'skills/mcp-builder', files: 9 }, { name: 'pdf', description: 'PDFs.', path: 'skills/pdf', files: 12 }] };
const LOCAL = { ok: true, root: '/home/me/skills', truncated: false, skills: [
  { name: 'fresh', description: 'A new one.', path: '/home/me/skills/fresh', files: 3 },
  { name: 'notes', description: 'Imported before.', path: '/home/me/skills/notes', files: 2 },
  { name: 'report', description: 'Clashes with a hand-written one.', path: '/home/me/skills/report', files: 1 },
] };
const EXTERNAL = { items: [
  { from: 'Codex', name: 'mcp-logseq', serverName: 'mcp-logseq', template: 'mcp-stdio', config: { command: 'uvx', args: ['mcp-logseq'], env: { LOGSEQ_API_TOKEN: 'lsq…' } } },
  { from: 'Codex', name: 'files', serverName: 'files', template: 'mcp-stdio', config: { command: 'npx', args: ['x'], env: {} } },
  { from: 'Claude Code', name: 'gh', serverName: 'gh', template: 'mcp-http', config: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bea…' } } },
] };
const MESSAGES = [
  { id: 'm1', from: 'user', to: 'bot-a', text: 'Plan the launch', at: Date.now() - 60_000, kind: 'user' },
  { id: 'm2', from: 'bot-a', to: 'bot-b', text: 'Please write the code', at: Date.now() - 30_000, kind: 'dm' },
  { id: 'm3', from: 'bot-a', to: 'user', text: 'Bob is on it', at: Date.now() - 10_000, kind: 'reply' },
];
const TASKS = [
  { id: 't1', botId: 'bot-a', title: 'Morning brief', prompt: 'Brief me', kind: 'schedule', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), status: 'active', timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Singapore' } }, describe: 'daily 09:00', lastDelivery: { deliveredAt: new Date(Date.now() - 86_400_000).toISOString() } },
  { id: 't2', botId: 'bot-a', title: 'Weekly', prompt: 'Report', scheduledAt: null, status: 'paused', timing: { kind: 'weekly', weekly: { time: '10:30:00', time_zone: 'UTC', weekdays: [1, 2, 3, 4, 5] } } },
];

const DAY = 86_400_000;
const USAGE = {
  range: { name: '7d', from: Date.now() - 6 * DAY, to: Date.now() + DAY, bucket: DAY },
  totals: { tokens: 1_250_000, input: 50_000, output: 20_000, cacheRead: 1_180_000, cacheWrite: 0, calls: 42, cost: { USD: 1.234 }, unpriced: 3000, tasks: 7, cacheRate: 0.95 },
  prev: { tokens: 1_000_000, calls: 30, cost: {}, unpriced: 0, tasks: 5 },
  series: Array.from({ length: 7 }, (_, i) => ({ t: Date.now() - (6 - i) * DAY, tokens: i * 100_000, byBot: { 'bot-a': i * 60_000, 'bot-b': i * 40_000 }, cost: { USD: i * 0.1 } })),
  bots: [{ bot: 'bot-a', tokens: 800_000, calls: 30, tasks: 5, cost: { USD: 1 } }, { bot: 'bot-b', tokens: 450_000, calls: 12, tasks: 2, cost: { USD: 0.234 } }],
  models: [{ provider: 'p', model: 'm', tokens: 1_247_000, calls: 40, cost: { USD: 1.234 }, priced: true }, { provider: 'q', model: 'mystery-1', tokens: 3000, calls: 2, cost: {}, priced: false }],
  kinds: [{ kind: 'chat', tokens: 1_200_000, calls: 38, cost: { USD: 1.2 } }, { kind: 'memory', tokens: 50_000, calls: 4, cost: { USD: 0.034 } }],
  schedules: [{ id: 'sch-1', title: 'Morning brief', bot: 'bot-a', runs: 3, tokens: 300_000, cost: { USD: 0.3 } }],
  tasks: [{ id: 'task-1', bot: 'bot-a', trigger: 'schedule', sched: 'sch-1', title: 'Morning brief', start: Date.now() - 3_600_000, end: Date.now() - 3_500_000, status: 'done', tokens: 100_000, calls: 5, cost: { USD: 0.1 } }, { id: 'task-2', bot: 'bot-b', trigger: 'chat', via: 'telegram', title: 'Fix the login bug', start: Date.now() - 60_000, end: null, status: 'running', tokens: 5000, calls: 1, cost: {} }],
  topTasks: [],
};
const BOT_MEMORY = {
  scope: 'bot-a',
  notes: [{ id: 'n-1', text: 'Kada prefers short answers.', kind: 'preference', source: 'auto', at: Date.now() - DAY, updated: Date.now() - DAY }, { id: 'n-2', text: 'Never email on weekends.', kind: 'lesson', source: 'user', pinned: true, at: Date.now(), updated: Date.now() }],
  journal: [{ id: 'j-1', at: Date.now() - 3_600_000, bot: 'bot-a', title: 'Morning brief', summary: 'Sent the morning brief with three items.' }],
  topic: { sessionId: 'sess-a', startedAt: Date.now() - 7_200_000, tasks: 3, lastPrompt: 45_000 },
  topics: [{ sessionId: 'sess-old', startedAt: Date.now() - 3 * DAY, endedAt: Date.now() - 2 * DAY, tasks: 9, reason: 'idle', titles: ['Plan the launch', 'Weekly review'] }],
  model: null,
  settings: { auto: true, model: null, dream: true, dreamTime: '03:00' },
};
const TEAM_MEMORY = { scope: 'team', notes: [{ id: 't-1', text: 'The company is called Acme.', kind: 'fact', source: 'dream', at: 1, updated: 1 }], digests: [{ date: '2026-11-15', text: '## Done\nAda sent the brief.', at: 1 }], journal: BOT_MEMORY.journal, dream: { lastDate: '2026-11-16', lastAt: Date.now() - 5 * 3_600_000 }, settings: { auto: true, model: null, dream: true, dreamTime: '03:00' } };
const SOURCES = {
  writable: true,
  apis: ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'],
  custom: [{ route: 'bots-local', name: 'Local', api: 'openai-completions', baseURL: 'http://127.0.0.1:1234/v1', models: [{ id: 'qwen' }], keyConfigured: true }],
  logins: [
    { id: 'codex', name: 'Codex CLI', product: 'ChatGPT', found: true, account: 'k@example.com', plan: 'pro', supported: true, route: 'openai-codex', connected: false, sync: false },
    { id: 'claude-code', name: 'Claude Code', product: 'Claude', found: true, supported: false, reason: 'terms' },
  ],
};
const SETTINGS = { topics: { idleHours: 6, maxContextK: 128 }, memory: { auto: true, model: null, dream: true, dreamTime: '03:00' }, prices: {}, codex: { sync: false } };
const PRICES = { overrides: {}, list: { name: 'LiteLLM', count: 1800, fetchedAt: Date.now() }, models: [{ model: 'm', provider: 'p', price: { input: 1, output: 2, currency: 'USD', source: 'catalog' } }, { model: 'mystery-1', provider: 'q', price: null }] };

// Tasks (tickets in the Host), in the shapes of PLAN-0.8 §6.3.
const MIN = 60_000;
const ticketRow = (id, botId, stage, title, extra = {}) => ({ id, title, botId, stage, requester: { kind: 'bot', botId: 'bot-a' }, createdAt: Date.now() - 90 * MIN, updatedAt: Date.now() - 10 * MIN, ...extra });
const TICKETS = [
  ticketRow('tfailed01', 'bot-b', 'failed', 'Deploy the site', { updatedAt: Date.now() - 20 * MIN, lastReport: { status: 'blocked', preview: 'No access to the server' } }),
  ticketRow('tquestion', 'bot-b', 'question', 'Which logo do you prefer?', { via: 'telegram', updatedAt: Date.now() - 2 * MIN, lastReport: { status: 'question', preview: 'Blue or green?' } }),
  ticketRow('tstalled1', 'bot-c', 'stalled', 'Write the launch post', { requester: { kind: 'user' }, via: 'panel', updatedAt: Date.now() - 40 * MIN }),
  ticketRow('tworking1', 'bot-b', 'working', 'Fix the login bug', { via: 'slack', updatedAt: Date.now() - 5 * MIN, lastReport: { status: 'progress', preview: 'Found the cause' } }),
  ticketRow('tqueued01', 'bot-c', 'queued', 'Translate the docs', { updatedAt: Date.now() - 1 * MIN }),
  ticketRow('tdone0001', 'bot-b', 'done', 'Weekly numbers', { updatedAt: Date.now() - 60 * MIN, lastReport: { status: 'done', preview: 'Revenue up 12%' } }),
  ticketRow('tstopped1', 'bot-c', 'stopped', 'Old idea', { updatedAt: Date.now() - 300 * MIN }),
];
const TICKET_DETAIL = {
  tquestion: {
    text: 'Draw two logo options and ask Kada which one he prefers.',
    sessionId: 'ticket-tquestion',
    origin: { threadKey: 'telegram:tg:42', via: 'telegram', who: 'Kada', label: 'Telegram · Kada' },
    threads: [{ key: 'telegram:tg:42', kind: 'telegram', label: 'Telegram · Kada' }],
    parentId: 'tworking1',
    children: ['tqueued01'],
    reports: [
      { at: Date.now() - 2 * MIN, status: 'question', text: '**Blue** or green?' },
      { at: Date.now() - 30 * MIN, status: 'progress', text: 'Drafted two options.' },
    ],
    runs: [{ id: 'r1', tokens: 12_000, cost: { USD: 0.02 } }, { id: 'r2', tokens: 3_000, cost: { USD: 0.005 } }],
    // The Host's totals include the task's memory summary, outside any run.
    usage: { tokens: 16_000, calls: 4, cost: { USD: 0.03 } },
  },
  tfailed01: {
    text: 'Deploy it.',
    sessionId: 'ticket-tfailed01',
    error: 'Connection refused (3 tries).',
    origin: { threadKey: 'panel:sess-a', who: 'the user' },
    threads: [{ key: 'panel:sess-a', kind: 'panel', label: 'Panel' }],
    reports: [],
    runs: [],
    ended: { at: Date.now() - 20 * MIN, by: 'system', outcome: 'failed' },
  },
};
const ticketView = (id) => {
  const row = TICKETS.find((r) => r.id === id);
  return row ? { ...row, reports: [], threads: [], runs: [], sessionId: `ticket-${id}`, ...(TICKET_DETAIL[id] ?? {}) } : null;
};
const TICKET_AFTER = { stop: 'stopped', retry: 'working', close: 'done' };

function mockFetch(posts = []) {
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push({ path, body });
      if (path.endsWith('/open')) return { ok: true, json: async () => ({ ok: true, sessionId: 'sess-a' }) };
      if (path.endsWith('/teams/hire')) return { ok: true, json: async () => ({ ok: true, team: body.id, bots: [BOTS[0], BOTS[1]], leadId: 'bot-a', kickoff: 'Hi team, introduce yourselves.', skipped: [{ bot: 'atlas', kind: 'skill', name: 'morning' }] }) };
      if (path.endsWith('/skills/github')) return { ok: true, json: async () => GITHUB };
      if (path.endsWith('/skills/local')) return { ok: true, json: async () => LOCAL };
      if (path.endsWith('/skills/import')) return { ok: true, json: async () => ({ ok: true, bot: BOTS[1], added: body.items.map((i) => (i.path ?? i.local).split('/').pop()), updated: [], skipped: [], failed: [] }) };
      if (path.endsWith('/skills/write')) return { ok: true, json: async () => ({ ok: true, sessionId: 'sess-b' }) };
      if (path.endsWith('/apps/import')) return { ok: true, json: async () => ({ ok: true, bot: BOTS[1], added: body.names }) };
      if (path.endsWith('/save')) return { ok: true, json: async () => ({ ok: true, bot: { ...BOTS[0], ...body.bot, id: body.bot.id ?? 'bot-new' } }) };
      const act = /^\/__dsh_bots\/tickets\/([^/]+)\/(stop|retry|close|message)$/.exec(path);
      if (act) {
        const view = ticketView(decodeURIComponent(act[1]));
        if (!view) return { ok: false, status: 404, json: async () => null };
        return { ok: true, json: async () => (act[2] === 'message' ? { ok: true } : { ...view, stage: TICKET_AFTER[act[2]] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (path.startsWith('/__dsh_bots/tickets/')) {
      const view = ticketView(decodeURIComponent(path.slice('/__dsh_bots/tickets/'.length).split('?')[0]));
      return view ? { ok: true, json: async () => view } : { ok: false, status: 404, json: async () => null };
    }
    if (path.startsWith('/__dsh_bots/tickets')) {
      const q = new URL(path, 'http://x').searchParams;
      const items = TICKETS.filter((r) => !q.get('bot') || r.botId === q.get('bot'));
      return { ok: true, json: async () => ({ items, next_offset: null }) };
    }
    if (path.startsWith('/__dsh_bots/state')) return { ok: true, json: async () => STATE };
    if (path.startsWith('/__dsh_bots/catalog')) return { ok: true, json: async () => CATALOG };
    if (path.startsWith('/__dsh_bots/messages')) return { ok: true, json: async () => ({ items: MESSAGES }) };
    if (path.startsWith('/__dsh_bots/schedules')) return { ok: true, json: async () => ({ items: TASKS }) };
    if (path.startsWith('/__dsh_bots/teams')) return { ok: true, json: async () => TEAMS };
    if (path.startsWith('/__dsh_bots/skills/local')) return { ok: true, json: async () => ({ places: [{ path: '/home/me/.claude/skills', label: '~/.claude/skills' }] }) };
    if (path.startsWith('/__dsh_bots/skills/library')) return { ok: true, json: async () => LIBRARY };
    if (path.startsWith('/__dsh_bots/apps/external')) return { ok: true, json: async () => EXTERNAL };
    if (path.startsWith('/__dsh_bots/usage')) return { ok: true, json: async () => USAGE };
    if (path.startsWith('/__dsh_bots/memory')) return { ok: true, json: async () => (path.includes('bot=team') ? TEAM_MEMORY : BOT_MEMORY) };
    if (path.startsWith('/__dsh_bots/models/sources')) return { ok: true, json: async () => SOURCES };
    if (path.startsWith('/__dsh_bots/settings')) return { ok: true, json: async () => ({ settings: SETTINGS }) };
    if (path.startsWith('/__dsh_bots/prices')) return { ok: true, json: async () => PRICES };
    return { ok: false, status: 404, json: async () => null };
  };
  return posts;
}

/** Render the panel until its fetches settle. */
async function renderSettled(component, props, hooks) {
  hooks.reset();
  component(props);
  for (let i = 0; i < 4; i += 1) {
    await flush();
    hooks.rewind();
    component(props);
  }
  await flush();
  hooks.rewind();
  return component(props);
}

test('the client registers its tool views, the panel, the badges and /bots', async () => {
  const { exports } = await loadClient();
  assert.deepEqual(exports.inject, ['slots', 'locale']);
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const names = seen.slots.map((s) => [s.options.name, s.options.key ?? s.options.id]);
  assert.deepEqual(names, [
    ['tool.call.toolview', 'bot_send_message'],
    ['tool.call.toolview', 'bot_create'],
    ['tool.call.toolview', 'bot_update'],
    ['tool.call.toolview', 'bot_delete'],
    ['tool.call.toolview', 'bot_list'],
    ['tool.call.toolview', 'bot_schedule'],
    ['sidebar.panellist', 'bots'],
    ['main', 'bots'],
    ['conversation.session.header.utilities', 'bots'],
    ['sidebar.session.row.leading', 'bots'],
  ]);
  const icon = seen.slots.find((s) => s.options.name === 'sidebar.panellist');
  assert.equal(icon.options.label(), 'Bots');
  assert.equal(icon.options.order, 31);
  assert.equal(icon.component({ size: 20, active: true }).props.width, 20);
  assert.equal(seen.locale.ns, 'bots');
  assert.deepEqual(Object.keys(seen.locale.dict.zh).sort(), Object.keys(seen.locale.dict.en).sort());
  assert.deepEqual(seen.injected, ['commandUi']);
  const [decoration] = seen.decorations;
  assert.equal(decoration.name, 'bots');
  assert.equal(decoration.available(), true);
  decoration.ui.run({});
  assert.deepEqual(seen.selected, ['bots']);
});

test('every literal t() key exists in both dictionaries', async () => {
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const en = seen.locale.dict.en;
  const used = new Set([...source.matchAll(/\bt\('([A-Za-z_0-9]+)'/g)].map((m) => m[1]));
  for (const key of used) assert.ok(key in en, `missing ${key}`);
  for (const prefix of ['status_running', 'status_idle', 'status_offline', 'tab_chat', 'tab_apps', 'wd1', 'wd7', 'mode_cron', 'kind_reply', 'taskStatus_ended', 'personaText_coder']) assert.ok(prefix in en, prefix);
});

test('the panel lists bots, shows the dispatcher and the chat thread, and sends a message', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  const tree = await renderSettled(panel, {}, hooks);
  const text = collect(tree).join(' ');
  assert.match(text, /Ada/);
  assert.match(text, /@bob/);
  assert.match(text, /Dispatcher/);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-row']).length, 3);
  // Initials avatars: derived from the name, pinyin for a Chinese name; no emoji anywhere.
  const letters = findAll(tree, (n) => n.props['data-dsh-bots-initials']).map((n) => n.props['data-dsh-bots-initials']);
  assert.ok(letters.includes('AD'));
  assert.ok(letters.includes('YJ'));
  assert.doesNotMatch(collect(tree).join(' '), /\p{Extended_Pictographic}/u);
  // The primary bot is selected by default, on the Chat tab.
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-detail'] === 'bot-a').length === 1);
  assert.match(text, /Plan the launch/);
  assert.match(text, /Please write the code/);
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-msg'] === 'dm').length >= 1);
  // Running status dot.
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-status'] === 'running').length >= 1);
  // Uploaded image avatar.
  assert.ok(findAll(tree, (n) => n.type === 'img' && n.props.src === '/__dsh_bots/avatar/bot-b?v=1').length >= 1);

  // Type and press Enter.
  const [composer] = findAll(tree, (n) => n.props['data-dsh-bots-composer']);
  composer.props.onChange({ target: { value: 'hello ada' } });
  hooks.rewind();
  const typed = panel({});
  const [box] = findAll(typed, (n) => n.props['data-dsh-bots-composer']);
  let prevented = false;
  box.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  await flush();
  assert.deepEqual(posts.find((p) => p.path.endsWith('/send'))?.body, { to: 'bot-a', text: 'hello ada' });

  // Open conversation → POST open → uiWorkspace.openSession.
  hooks.rewind();
  const again = panel({});
  const [openBtn] = findAll(again, (n) => n.props['data-dsh-bots-open'] === 'bot-a');
  openBtn.props.onClick();
  await flush();
  await flush();
  assert.ok(posts.some((p) => p.path.endsWith('/open') && p.body.id === 'bot-a'));
  assert.deepEqual(seen.opened, ['sess-a']);
  hooks.runCleanups();
});

test('each tab renders: profile, skills, schedules, apps, and the activity view', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const tabTo = async (id) => {
    const [tab] = findAll(tree, (n) => n.props['data-dsh-bots-tab'] === id);
    tab.props.onClick();
    for (let i = 0; i < 3; i += 1) {
      hooks.rewind();
      tree = panel({});
      await flush();
    }
    hooks.rewind();
    tree = panel({});
    return collect(tree).join(' ');
  };

  let text = await tabTo('profile');
  assert.match(text, /Persona/);
  assert.match(text, /Abilities/);
  assert.match(text, /Advanced: per tool \(1 of 2 allowed\)/);
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-avatar-editor']).length === 1);
  const boxes = findAll(tree, (n) => n.type === 'input' && n.props.type === 'checkbox');
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].props.checked, false); // bash denied

  text = await tabTo('skills');
  assert.match(text, /weekly/);
  assert.match(text, /Add from Harness/);
  assert.match(text, /Import from GitHub/);
  assert.match(text, /Let the bot write it/);
  assert.match(text, /Write by hand/);

  text = await tabTo('schedules');
  assert.match(text, /Morning brief/);
  assert.match(text, /Every day 09:00 \(Asia\/Singapore\)/);
  assert.match(text, /Weekdays 10:30 \(UTC\)/);
  assert.match(text, /Next in 1 h/);
  // Create a new schedule: weekly.
  const [add] = findAll(tree, (n) => n.props['data-dsh-bots-add-schedule']);
  add.props.onClick();
  hooks.rewind();
  tree = panel({});
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-schedule-editor']).length === 1);

  text = await tabTo('apps');
  assert.match(text, /Open Computer Use/);
  assert.match(text, /Not installed/);
  assert.match(text, /Install now/);
  assert.match(text, /next time the bot’s conversation starts/);
  assert.match(text, /App gallery/);
  assert.match(text, /Featured/);
  assert.match(text, /Tavily Search/);
  assert.match(text, /China/); // the region badge on Amap
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-cat'] === 'search').length === 1);

  // Activity.
  const [act] = findAll(tree, (n) => n.props['data-dsh-bots-activity']);
  act.props.onClick();
  for (let i = 0; i < 3; i += 1) {
    hooks.rewind();
    tree = panel({});
    await flush();
  }
  hooks.rewind();
  tree = panel({});
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-timeline']).length === 1);
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-event']).length === 3);
  assert.equal(posts.length, 0);
  hooks.runCleanups();
});

test('tool views render with partial args, then with the result meta', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  mockFetch();
  const view = (key) => seen.slots.find((s) => s.options.name === 'tool.call.toolview' && s.options.key === key).component;

  hooks.reset();
  let tree = view('bot_send_message')({ phase: 'preparing', block: { callId: 'c1', argsRaw: '{"to":"@bob","text":"Write the co' } });
  let text = collect(tree).join(' ');
  assert.match(text, /preparing/);
  assert.match(text, /Write the co/);

  hooks.reset();
  tree = view('bot_send_message')({
    phase: 'result',
    block: { callId: 'c1', call: { argsRaw: '{"to":"@bob","text":"Write the code"}' }, content: [{ type: 'text', text: 'Delivered' }], isError: false, meta: { to: { id: 'bot-b', name: 'Bob', handle: 'bob', avatar: BOTS[1].avatar }, from: { id: 'bot-a', name: 'Ada', handle: 'ada', avatar: BOTS[0].avatar } } },
  });
  text = collect(tree).join(' ');
  assert.match(text, /Bob/);
  assert.match(text, /Ada/);
  assert.match(text, /Delivered/);

  for (const key of ['bot_create', 'bot_update', 'bot_delete']) {
    hooks.reset();
    tree = view(key)({ phase: 'running', block: { callId: 'x', argsRaw: '{"name":"Cleo","initials":"CL","bot":"@ada","bio":"x"' } });
    assert.ok(collect(tree).join(' ').length > 0);
    hooks.reset();
    tree = view(key)({ phase: 'result', block: { callId: 'x', argsRaw: '{}', isError: false, content: [], meta: { bot: { id: 'bot-z', name: 'Cleo', handle: 'cleo', avatar: { kind: 'initials', color: '#f00' }, role: 'bot' } } } });
    assert.match(collect(tree).join(' '), /Cleo/);
  }
  hooks.reset();
  tree = view('bot_list')({ phase: 'result', block: { callId: 'l', content: [], meta: { bots: [{ id: 'q', name: 'Quinn', handle: 'quinn', avatar: null, role: 'primary' }] } } });
  assert.match(collect(tree).join(' '), /Quinn/);

  hooks.reset();
  tree = view('bot_schedule')({ phase: 'running', block: { callId: 's', argsRaw: '{"action":"create","title":"Brief","kind":"weekly","time":"08:15","weekdays":[6,7],"time_zone":"UTC"}' } });
  text = collect(tree).join(' ');
  assert.match(text, /Brief/);
  assert.match(text, /Sat, Sun 08:15 \(UTC\)/);
  hooks.reset();
  tree = view('bot_schedule')({ phase: 'result', block: { callId: 's', isError: true, content: [{ type: 'text', text: 'no such task' }] } });
  assert.match(collect(tree).join(' '), /no such task/);
  hooks.runCleanups();
});

test('the header badge and the session row show the bot of a bot conversation', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  mockFetch();
  const badge = seen.slots.find((s) => s.options.name === 'conversation.session.header.utilities').component;
  const row = seen.slots.find((s) => s.options.name === 'sidebar.session.row.leading').component;
  hooks.reset();
  badge({ sessionId: 'sess-b' });
  await flush();
  await flush();
  hooks.rewind();
  const tree = badge({ sessionId: 'sess-b' });
  assert.ok(tree, 'a badge for a bot session');
  assert.equal(tree.props['data-dsh-bots-badge'], 'bot-b');
  assert.match(collect(tree).join(' '), /Bob/);
  tree.props.onClick();
  assert.deepEqual(seen.selected, ['bots']);
  hooks.reset();
  assert.equal(badge({ sessionId: 'other' }), null);
  hooks.reset();
  assert.equal(row({ sessionId: 'sess-a' }).props['data-dsh-bots-row-avatar'], 'bot-a');
  hooks.runCleanups();
});

test('the panel says so when the Host is unreachable', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => null });
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  const tree = await renderSettled(panel, {}, hooks);
  assert.match(collect(tree).join(' '), /not reachable/);
  hooks.runCleanups();
});

test('the client derives initials exactly like the Host, including pinyin', async () => {
  const { initialsOf } = await import('../lib/store.mjs');
  const start = source.indexOf('const PINYIN_BOUNDS');
  const end = source.indexOf('/** The letters an avatar shows');
  const clientInitials = new Function(`${source.slice(start, end)}; return initialsOf;`)();
  for (const name of ['研究员', '数据侠', '文书', '小研', 'Atlas 调度员', 'Data Scout', 'Atlas', 'DataBot', 'ada lovelace', 'x', '', 'Ölaf', '7up']) {
    assert.equal(clientInitials(name), initialsOf(name), name);
  }
  assert.equal(clientInitials('研究员'), 'YJ');
  assert.equal(clientInitials('Atlas 调度员'), 'AD');
});

test('no emoji in the client source', () => {
  const hits = [...source.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]).filter((c) => c !== '↗'); // the text arrow on external links
  assert.deepEqual(hits, []);
  assert.doesNotMatch(source, /EMOJIS|TEMPLATE_ICONS|kind: 'emoji'/);
});

/** Render the panel, pick a bot and open a tab. */
async function openTab(id, botId = 'bot-b') {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const rerender = async (n = 3) => {
    for (let i = 0; i < n; i += 1) {
      hooks.rewind();
      tree = panel({});
      await flush();
    }
    hooks.rewind();
    tree = panel({});
    return tree;
  };
  findAll(tree, (n) => n.props['data-dsh-bots-row'] === botId)[0].props.onClick();
  await rerender();
  findAll(tree, (n) => n.props['data-dsh-bots-tab'] === id)[0].props.onClick();
  await rerender();
  return { hooks, posts, panel, get tree() { return tree; }, rerender };
}

test('apps: installed rows show the setup issue; Configure opens a form built from fields', async () => {
  const v = await openTab('apps');
  let text = collect(v.tree).join(' ');
  assert.match(text, /Tavily Search/);
  assert.match(text, /mcp__tavily__\*/);
  assert.match(text, /Needs setup/);
  assert.match(text, /Tavily Search needs: API key/);
  assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-app-issue'] === 'app2').length === 1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-configure'] === 'app2')[0].props.onClick();
  await v.rerender();
  assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-app-form'] === 'tavily').length === 1);
  let [key] = findAll(v.tree, (n) => n.props['data-dsh-bots-app-field'] === 'TAVILY_API_KEY');
  assert.equal(key.type, 'input');
  assert.equal(key.props.type, 'password');
  text = collect(v.tree).join(' ');
  assert.match(text, /API key/);
  assert.ok(findAll(v.tree, (n) => n.type === 'a' && n.props.href === 'https://app.tavily.com').length >= 1);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-app-save'])[0].props.disabled, true);
  findAll(v.tree, (n) => n.props['data-dsh-bots-eye'] === 'TAVILY_API_KEY')[0].props.onClick();
  await v.rerender(1);
  [key] = findAll(v.tree, (n) => n.props['data-dsh-bots-app-field'] === 'TAVILY_API_KEY');
  assert.equal(key.props.type, 'text');
  key.props.onChange({ target: { value: ' tvly-123 ' } });
  await v.rerender(1);
  const save = findAll(v.tree, (n) => n.props['data-dsh-bots-app-save'])[0];
  assert.equal(save.props.disabled, false);
  save.props.onClick();
  await flush();
  const post = v.posts.find((p) => p.path.endsWith('/save'));
  assert.ok(post, 'saved');
  assert.equal(post.body.bot.id, 'bot-b');
  assert.equal(post.body.bot.apps.length, 2);
  assert.deepEqual(post.body.bot.apps.find((a) => a.id === 'app2').values, { TAVILY_API_KEY: 'tvly-123' });
  v.hooks.runCleanups();
});

test('apps: adding saves at once without required fields, else opens the form with defaults', async () => {
  const v = await openTab('apps');
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-app'] === 'fetch')[0].props.onClick();
  await flush();
  const post = v.posts.find((p) => p.path.endsWith('/save'));
  assert.deepEqual(post.body.bot.apps.map((a) => a.template), ['mcp-stdio', 'tavily', 'fetch']);
  assert.equal(post.body.bot.apps[2].serverName, 'fetch');
  assert.deepEqual(post.body.bot.apps[2].values, {});
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-app'] === 'filesystem')[0].props.onClick();
  await v.rerender(1);
  const [dirs] = findAll(v.tree, (n) => n.props['data-dsh-bots-app-field'] === 'dirs');
  assert.equal(dirs.type, 'textarea');
  assert.equal(dirs.props.value, '/Users/x/Documents');
  assert.match(collect(v.tree).join(' '), /Absolute paths\./);
  dirs.props.onChange({ target: { value: '/a\n\n /b ' } });
  await v.rerender(1);
  v.posts.length = 0;
  findAll(v.tree, (n) => n.props['data-dsh-bots-app-save'])[0].props.onClick();
  await flush();
  const added = v.posts.find((p) => p.path.endsWith('/save')).body.bot.apps.at(-1);
  assert.equal(added.template, 'filesystem');
  assert.equal(added.serverName, 'files2'); // "files" is taken by the custom app
  assert.deepEqual(added.values, { dirs: '/a\n/b' });
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-app-search'])[0].props.onChange({ target: { value: 'amap' } });
  await v.rerender(1);
  const cards = findAll(v.tree, (n) => n.props['data-dsh-bots-template']).map((n) => n.props['data-dsh-bots-template']);
  assert.deepEqual(cards, ['amap']);
  v.hooks.runCleanups();
});

test('apps: a custom server keeps the raw editor', async () => {
  const v = await openTab('apps');
  findAll(v.tree, (n) => n.props['data-dsh-bots-configure'] === 'app1')[0].props.onClick();
  await v.rerender(1);
  assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-app-editor']).length === 1);
  assert.match(collect(v.tree).join(' '), /Command/);
  v.hooks.runCleanups();
});

test('profile avatar: AI generation when imageGen, clearing an image, letters, and the hint without imageGen', async () => {
  let v = await openTab('profile');
  let text = collect(v.tree).join(' ');
  assert.match(text, /Upload image/);
  assert.match(text, /Generate with AI/);
  assert.match(text, /Use letters instead/);
  assert.doesNotMatch(text, /Install the Images plugin/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-avatar-clear'])[0].props.onClick();
  await flush();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/avatar/clear')).body, { id: 'bot-b' });
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-avatar-generate'])[0].props.onClick();
  await v.rerender(1);
  const [form] = findAll(v.tree, (n) => n.props['data-dsh-bots-generate-form']);
  findAll(form, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'pixel art' } });
  await v.rerender(1);
  let release;
  const gate = new Promise((r) => (release = r));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/avatar/generate')) {
      v.posts.push({ path: String(url), body: JSON.parse(init.body) });
      await gate;
      return { ok: true, json: async () => ({ ok: true, bot: { ...BOTS[1], avatar: { kind: 'image', url: '/__dsh_bots/avatar/bot-b?v=2', color: '#3b82f6', source: 'ai' } } }) };
    }
    return realFetch(url, init);
  };
  findAll(v.tree, (n) => n.props['data-dsh-bots-generate-go'])[0].props.onClick();
  await flush();
  v.hooks.rewind();
  const busy = v.panel({});
  assert.match(collect(busy).join(' '), /Generating… \(up to a minute\)/);
  assert.equal(findAll(busy, (n) => n.props['data-dsh-bots-avatar-upload'])[0].props.disabled, true);
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/avatar/generate')).body, { id: 'bot-b', style: 'pixel art' });
  release();
  await v.rerender(2);
  assert.doesNotMatch(collect(v.tree).join(' '), /Generating…/);
  v.hooks.runCleanups();

  CATALOG.imageGen = false;
  try {
    v = await openTab('profile', 'bot-a');
    text = collect(v.tree).join(' ');
    assert.match(text, /Install the Images plugin to generate avatars with AI/);
    assert.doesNotMatch(text, /Generate with AI/);
    const [letters] = findAll(v.tree, (n) => n.props['data-dsh-bots-letters']);
    assert.equal(letters.props.placeholder, 'AD');
    letters.props.onChange({ target: { value: 'xq9' } });
    await v.rerender(1);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-letters'])[0].props.value, 'XQ');
    findAll(v.tree, (n) => n.props['data-dsh-bots-save'])[0].props.onClick();
    await flush();
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/save')).body.bot.avatar, { kind: 'initials', text: 'XQ', color: '#7c5cff' });
    v.hooks.runCleanups();
  } finally {
    CATALOG.imageGen = true;
  }
});

test('the zh dictionary has the Chinese persona templates and the imageGen hint', async () => {
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const { zh } = seen.locale.dict;
  assert.equal(zh.lang, 'zh');
  assert.equal(zh.imageGenMissing, '安装「图片」插件后可用 AI 生成头像');
  for (const id of ['researcher', 'coder', 'writer', 'analyst', 'ops']) assert.match(zh[`personaText_${id}`], /^你是/);
  assert.equal(zh.regionCn, '中国');
});

/** Render the panel with a different roster (restored afterwards). */
async function withRoster(bots, fn) {
  const saved = STATE.bots;
  const savedPrimary = STATE.primaryId;
  STATE.bots = bots;
  STATE.primaryId = bots.find((b) => b.role === 'primary')?.id ?? null;
  try {
    return await fn();
  } finally {
    STATE.bots = saved;
    STATE.primaryId = savedPrimary;
  }
}
async function mountPanel() {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const rerender = async (n = 3) => {
    for (let i = 0; i < n; i += 1) {
      hooks.rewind();
      tree = panel({});
      await flush();
    }
    hooks.rewind();
    tree = panel({});
    return tree;
  };
  return { hooks, posts, panel, get tree() { return tree; }, rerender };
}

test('teams: an (almost) empty roster shows the hero with team cards; details show skill chips and timing', async () => {
  await withRoster([BOTS[0]], async () => {
    const v = await mountPanel();
    let text = collect(v.tree).join(' ');
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-teams'] === 'hero').length === 1);
    assert.match(text, /Build your bot team/);
    assert.match(text, /One-person company/);
    assert.match(text, /2 bots · 3 skills · 2 scheduled tasks/);
    assert.match(text, /Chief of staff/);
    findAll(v.tree, (n) => n.props['data-dsh-bots-team-detail'] === 'opc')[0].props.onClick();
    await v.rerender(1);
    text = collect(v.tree).join(' ');
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-team-modal'] === 'opc').length === 1);
    assert.match(text, /Weekdays 09:00/);
    assert.match(text, /Every Fri 17:30/);
    const morning = findAll(v.tree, (n) => n.props['data-dsh-bots-team-skill'] === 'morning')[0];
    assert.equal(morning.props['data-available'], false);
    assert.match(morning.props.title, /will be skipped/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-team-skill'] === 'webapp-testing')[0].props['data-source'], 'import');
    assert.match(text, /keys are filled in later/);
    v.hooks.runCleanups();
  });
});

test('teams: hiring posts {id, lang, primary}, shows the result, and the kickoff goes to the lead', async () => {
  await withRoster([{ ...BOTS[0], skills: [] }], async () => {
    const v = await mountPanel();
    findAll(v.tree, (n) => n.props['data-dsh-bots-hire'] === 'opc')[0].props.onClick();
    await v.rerender(3);
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/teams/hire')).body, { id: 'opc', lang: 'en', primary: true });
    const text = collect(v.tree).join(' ');
    assert.match(text, /One-person company is ready/);
    assert.match(text, /Hi team, introduce yourselves\./);
    assert.match(text, /Tavily Search/); // Bob's app needs a key
    assert.match(text, /Skipped 1 items/);
    const kick = findAll(v.tree, (n) => n.props['data-dsh-bots-kickoff'] === 'bot-a')[0];
    assert.match(collect(kick).join(' '), /Send the kickoff to Ada/);
    kick.props.onClick();
    await v.rerender(2);
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/send')).body, { to: 'bot-a', text: 'Hi team, introduce yourselves.' });
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-detail'] === 'bot-a').length === 1);
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-tab'] === 'chat' && n.props['data-active'] === true).length === 1);
    v.hooks.runCleanups();
  });
});

test('teams: with a roster, the template list asks first and the dispatcher tick is sent', async () => {
  const v = await mountPanel();
  findAll(v.tree, (n) => n.props['data-dsh-bots-teams-entry'])[0].props.onClick();
  await v.rerender(1);
  assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-teams'] === 'list').length === 1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-team-detail'] === 'opc')[0].props.onClick();
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-hire-primary'])[0].props.onChange({ target: { checked: false } });
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-hire-modal'] === 'opc')[0].props.onClick();
  await v.rerender(3);
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/teams/hire')).body, { id: 'opc', lang: 'en', primary: false });
  // Rail groups by team once a bot has one.
  v.hooks.runCleanups();
  await withRoster([{ ...BOTS[0], team: 'opc' }, { ...BOTS[1], team: 'opc' }, BOTS[2]], async () => {
    const w = await mountPanel();
    const groups = findAll(w.tree, (n) => n.props['data-dsh-bots-group']).map((n) => n.props['data-dsh-bots-group']);
    assert.deepEqual(groups, ['opc', 'other']);
    assert.match(collect(w.tree).join(' '), /One-person company/);
    w.hooks.runCleanups();
  });
});

test('skills: the Harness picker adds dsh skills by name; the GitHub picker imports items', async () => {
  let v = await openTab('skills', 'bot-a');
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-harness'])[0].props.onClick();
  await v.rerender(3);
  const weekly = findAll(v.tree, (n) => n.props['data-dsh-bots-harness-skill'] === 'weekly')[0];
  assert.equal(findAll(weekly, (n) => n.type === 'input')[0].props.disabled, true); // already added
  findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-harness-skill'] === 'deep-research')[0], (n) => n.type === 'input')[0].props.onChange();
  await v.rerender(1);
  findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-harness-skill'] === 'xlsx')[0], (n) => n.type === 'input')[0].props.onChange();
  await v.rerender(1);
  const add = findAll(v.tree, (n) => n.props['data-dsh-bots-harness-add'])[0];
  assert.match(collect(add).join(' '), /Add 2/);
  add.props.onClick();
  await flush();
  const saved = v.posts.find((p) => p.path.endsWith('/save')).body.bot;
  assert.equal(saved.id, 'bot-a');
  assert.deepEqual(saved.skills.slice(1), [
    { name: 'deep-research', source: 'dsh', enabled: true, description: 'Research a topic.' },
    { name: 'xlsx', source: 'dsh', enabled: true, description: 'Spreadsheets.' },
  ]);
  assert.equal(saved.skills[0].name, 'weekly');
  v.hooks.runCleanups();

  v = await openTab('skills', 'bot-b');
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-github'])[0].props.onClick();
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-skill-source-card'] === 'anthropics')[0].props.onClick();
  await v.rerender(3);
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/skills/github')).body, { repo: 'anthropics/skills/skills' });
  assert.match(collect(v.tree).join(' '), /mcp-builder/);
  findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-github-skill'] === 'skills/mcp-builder')[0], (n) => n.type === 'input')[0].props.onChange();
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-github-import'])[0].props.onClick();
  await flush();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/skills/import')).body, { botId: 'bot-b', items: [{ repo: 'anthropics/skills', ref: 'main', path: 'skills/mcp-builder' }] });
  v.hooks.runCleanups();
});

test('skills: past the limit on, the switch refuses and new ones come in off; past the limit kept, adding is refused', async () => {
  const keep = { limits: STATE.limits, skills: BOTS[0].skills };
  STATE.limits = { skills: 3, skillsOn: 1 };
  BOTS[0].skills = [...keep.skills, { id: 's2', name: 'idle', description: 'Off for now', content: '# x', enabled: false }];
  try {
    const v = await openTab('skills', 'bot-a');
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-skills-on'] === 1).length, 1);
    assert.match(collect(v.tree).join(' '), /1\/1 on/);
    // One is on already: switching the other on is refused, nothing is saved.
    findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-skill'] === 's2')[0], (n) => n.props.role === 'switch')[0].props.onClick();
    await v.rerender(1);
    assert.equal(v.posts.filter((p) => p.path.endsWith('/save')).length, 0);
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-toast'] === 'error')[0]).join(' '), /At most 1 skills can be on/);

    // Two from Harness would make four, past three kept: refused.
    findAll(v.tree, (n) => n.props['data-dsh-bots-add-harness'])[0].props.onClick();
    await v.rerender(3);
    const tick = (name) => findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-harness-skill'] === name)[0], (n) => n.type === 'input')[0].props.onChange();
    tick('deep-research');
    await v.rerender(1);
    tick('xlsx');
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-harness-add'])[0].props.onClick();
    await flush();
    assert.equal(v.posts.filter((p) => p.path.endsWith('/save')).length, 0);
    // One fits, and comes in off.
    tick('xlsx');
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-harness-add'])[0].props.onClick();
    await flush();
    const saved = v.posts.find((p) => p.path.endsWith('/save')).body.bot;
    assert.deepEqual(saved.skills.at(-1), { name: 'deep-research', source: 'dsh', enabled: false, description: 'Research a topic.' });
    v.hooks.runCleanups();
  } finally {
    STATE.limits = keep.limits;
    BOTS[0].skills = keep.skills;
  }
});

test('skills: the Harness list scrolls by itself and its rows never shrink', async () => {
  const v = await openTab('skills', 'bot-a');
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-harness'])[0].props.onClick();
  await v.rerender(3);
  const list = findAll(v.tree, (n) => n.props['data-dsh-bots-harness-list'])[0];
  assert.match(list.props.className, /dshb-scroll/);
  assert.notEqual(list.props.style.overflow, 'hidden');
  assert.match(source, /function PickRow[\s\S]{0,400}flex: 'none'/);
  v.hooks.runCleanups();
});

test('skills: the local picker scans a folder, marks conflicts and links by path', async () => {
  const saved = STATE.bots;
  STATE.bots = BOTS.map((b) => (b.id === 'bot-b' ? { ...b, skills: [
    { id: 'k1', name: 'notes', source: 'import', description: '', content: '', enabled: true, origin: '/home/me/skills/notes' },
    { id: 'k2', name: 'Report', source: 'own', description: '', content: '# r', enabled: true },
  ] } : b));
  try {
    const v = await openTab('skills', 'bot-b');
    findAll(v.tree, (n) => n.props['data-dsh-bots-add-local'])[0].props.onClick();
    await v.rerender(3);
    // A known place scans in one click.
    findAll(v.tree, (n) => n.props['data-dsh-bots-local-place'] === '/home/me/.claude/skills')[0].props.onClick();
    await v.rerender(3);
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/skills/local')).body, { path: '/home/me/.claude/skills' });
    const row = (path) => findAll(v.tree, (n) => n.props['data-dsh-bots-local-skill'] === path)[0];
    const box = (path) => findAll(row(path), (n) => n.type === 'input')[0];
    assert.equal(row('/home/me/skills/fresh').props['data-state'], 'new');
    assert.equal(row('/home/me/skills/notes').props['data-state'], 'linked'); // already linked: read live, nothing to add again
    assert.equal(row('/home/me/skills/report').props['data-state'], 'taken'); // same name (any case), another source
    assert.equal(box('/home/me/skills/report').props.disabled, true);
    assert.equal(box('/home/me/skills/notes').props.disabled, true);
    // A linked skill shows its folder and has no editor: it is edited where it lives.
    const card = findAll(v.tree, (n) => n.props['data-dsh-bots-skill'] === 'k1')[0];
    assert.equal(findAll(card, (n) => n.props['data-dsh-bots-skill-origin'] === '/home/me/skills/notes').length, 1);
    assert.equal(findAll(card, (n) => n.props.title === 'Edit').length, 0);
    box('/home/me/skills/fresh').props.onChange();
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-local-import'])[0].props.onClick();
    await flush();
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/skills/import')).body, { botId: 'bot-b', items: [{ local: '/home/me/skills/fresh' }] });
    v.hooks.runCleanups();
  } finally {
    STATE.bots = saved;
  }
});

test('skills: a hand-written skill cannot take a name the bot already has', async () => {
  const v = await openTab('skills', 'bot-a');
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-skill'])[0].props.onClick();
  await v.rerender(1);
  const editor = () => findAll(v.tree, (n) => n.props['data-dsh-bots-skill-editor'])[0];
  findAll(editor(), (n) => n.type === 'input')[0].props.onChange({ target: { value: 'Weekly' } });
  await v.rerender(1);
  const before = v.posts.length;
  findAll(editor(), (n) => typeof n.props.onClick === 'function' && collect(n).join(' ').includes('Save'))[0].props.onClick();
  await flush();
  assert.equal(v.posts.filter((p) => p.path.endsWith('/save')).length, 0);
  assert.equal(v.posts.length, before);
  v.hooks.runCleanups();
});

test('skills: sources are badged, Harness skills are not editable, and "let the bot write it" switches to chat', async () => {
  const saved = BOTS[1].skills;
  BOTS[1].skills = [
    { id: 'k1', name: 'deep-research', source: 'dsh', description: 'Research', content: '', enabled: true },
    { id: 'k2', name: 'pdf', source: 'import', description: 'PDFs', content: '# pdf', enabled: true, origin: 'https://github.com/anthropics/skills/tree/main/skills/pdf' },
    { id: 'k3', name: 'mine', source: 'own', description: 'Mine', content: '# mine', enabled: true },
  ];
  try {
    const v = await openTab('skills', 'bot-b');
    const text = collect(v.tree).join(' ');
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-skill-source']).map((n) => n.props['data-dsh-bots-skill-source']), ['dsh', 'import', 'own']);
    assert.match(text, /Provided by the Harness, kept up to date/);
    assert.ok(findAll(v.tree, (n) => n.type === 'a' && n.props.href === 'https://github.com/anthropics/skills/tree/main/skills/pdf').length === 1);
    const dshCard = findAll(v.tree, (n) => n.props['data-dsh-bots-skill'] === 'k1')[0];
    assert.equal(findAll(dshCard, (n) => n.props.title === 'Edit').length, 0);
    findAll(v.tree, (n) => n.props['data-dsh-bots-add-write'])[0].props.onClick();
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-write-text'])[0].props.onChange({ target: { value: 'Weekly Stripe revenue table' } });
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-write-send'])[0].props.onClick();
    await v.rerender(2);
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/skills/write')).body, { botId: 'bot-b', text: 'Weekly Stripe revenue table' });
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-tab'] === 'chat' && n.props['data-active'] === true).length === 1);
    v.hooks.runCleanups();
  } finally {
    BOTS[1].skills = saved;
  }
});

test('profile abilities: only available ones show, and toggling rewrites the deny list', async () => {
  const v = await openTab('profile', 'bot-a'); // Ada denies bash
  const rows = findAll(v.tree, (n) => n.props['data-dsh-bots-ability']).map((n) => [n.props['data-dsh-bots-ability'], n.props['data-on']]);
  assert.deepEqual(rows, [['web', true], ['code', false], ['plugins', true]]); // images has no tools here
  assert.match(collect(v.tree).join(' '), /Use with care/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-ability-switch'] === 'web')[0].props.onClick({});
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-ability-switch'] === 'code')[0].props.onClick({});
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-save'])[0].props.onClick();
  await flush();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/save')).body.bot.tools.deny, ['web_fetch', 'web_search']);
  v.hooks.runCleanups();
});

test('apps: MCP servers from other agents import by from/name; taken ones are disabled', async () => {
  const v = await openTab('apps', 'bot-b');
  assert.match(collect(v.tree).join(' '), /Found 3 MCP servers \(Codex, Claude Code\)/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-external-open'])[0].props.onClick();
  await v.rerender(1);
  assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-external-group']).map((n) => n.props['data-dsh-bots-external-group']), ['Codex', 'Claude Code']);
  const taken = findAll(v.tree, (n) => n.props['data-dsh-bots-external-item'] === 'Codex/files')[0];
  assert.equal(findAll(taken, (n) => n.type === 'input')[0].props.disabled, true);
  assert.match(collect(v.tree).join(' '), /LOGSEQ_API_TOKEN=lsq…/);
  for (const key of ['Codex/mcp-logseq', 'Claude Code/gh']) {
    findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-external-item'] === key)[0], (n) => n.type === 'input')[0].props.onChange();
    await v.rerender(1);
  }
  findAll(v.tree, (n) => n.props['data-dsh-bots-external-import'])[0].props.onClick();
  await flush();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/apps/import')).body, { botId: 'bot-b', names: ['Codex/mcp-logseq', 'Claude Code/gh'] });
  v.hooks.runCleanups();
});

test('chat: an empty thread shows the bio and suggestions that fill the composer', async () => {
  const saved = MESSAGES.splice(0);
  try {
    const v = await openTab('chat', 'bot-b');
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-chat-empty']).length === 1);
    assert.match(collect(v.tree).join(' '), /Codes/);
    findAll(v.tree, (n) => n.props['data-dsh-bots-suggestion'] === 'b1')[0].props.onClick();
    await v.rerender(1);
    assert.match(findAll(v.tree, (n) => n.props['data-dsh-bots-composer'])[0].props.value, /^Introduce yourself/);
    v.hooks.runCleanups();
  } finally {
    MESSAGES.push(...saved);
  }
});

const TABLE_REPLY = [
  '现在一共 **2** 个 bot：',
  '',
  '| Bot | 角色 |',
  '|---|---|',
  '| **@atlas** Atlas | 拆周计划 |',
  '| `@forge` Forge | [GitHub](https://github.com) |',
  '',
  '- one',
  '- two',
  '',
  'Watch https://youtu.be/dQw4w9WgXcQ and https://x.com/jack/status/20.',
].join('\n');

async function chatWith(text, opts = {}) {
  const { exports, hooks } = await loadClient(opts);
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const base = globalThis.fetch;
  const unfurled = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.startsWith('/__dsh_bots/messages')) return { ok: true, json: async () => ({ items: [{ id: 'r1', from: 'bot-a', to: 'user', text, at: Date.now(), kind: 'reply' }] }) };
    if (path.startsWith('/__dsh_bots/unfurl')) {
      const u = new URL(path, 'http://x').searchParams.get('url');
      unfurled.push(u);
      if (u.includes('youtu')) return { ok: true, json: async () => ({ ok: true, kind: 'youtube', url: u, videoId: 'dQw4w9WgXcQ', title: 'Never Gonna', author: 'Rick', image: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }) };
      if (u.includes('x.com')) return { ok: true, json: async () => ({ ok: true, kind: 'x', url: u, text: 'just setting up my twttr', author: { name: 'jack', handle: 'jack', avatar: '' }, media: [], likes: 3 }) };
      return { ok: true, json: async () => ({ ok: true, kind: 'page', url: u, title: 'GitHub', description: 'Code', site: 'GitHub', image: '' }) };
    }
    return base(url, init);
  };
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  for (let i = 0; i < 3; i += 1) {
    await flush();
    hooks.rewind();
    tree = panel({});
  }
  return { tree, unfurled, posts, hooks };
}

test('bot replies render Markdown: tables, bold, code, lists and links (built-in renderer)', async () => {
  const { tree } = await chatWith(TABLE_REPLY);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-md'] === 'builtin').length, 1);
  const [table] = findAll(tree, (n) => n.type === 'table');
  assert.ok(table, 'a table');
  assert.deepEqual(findAll(table, (n) => n.type === 'th').map((n) => collect(n).join('')), ['Bot', '角色']);
  assert.equal(findAll(table, (n) => n.type === 'tr').length, 3);
  assert.ok(findAll(table, (n) => n.type === 'strong' && collect(n).join('') === '@atlas').length === 1);
  assert.ok(findAll(table, (n) => n.type === 'code' && collect(n).join('') === '@forge').length === 1);
  assert.ok(findAll(table, (n) => n.type === 'a' && n.props.href === 'https://github.com').length === 1);
  assert.equal(findAll(tree, (n) => n.type === 'ul')[0]?.children.length, 2);
  const text = collect(tree).join('');
  assert.doesNotMatch(text, /\|---|\*\*@atlas\*\*/);
});

test('with the shell renderer available, bot replies use its MarkdownText', async () => {
  const seenProps = [];
  const MarkdownText = (props) => (seenProps.push(props), { type: 'md', props, children: [props.text] });
  const { tree } = await chatWith(TABLE_REPLY, { primitives: { MarkdownText } });
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-md'] === 'harness').length, 1);
  assert.equal(seenProps.at(-1).text, TABLE_REPLY);
  assert.equal(seenProps.at(-1).labels.code.copyLabel, 'Copy');
  // One labels object across renders, so the renderer keeps its parse.
  assert.equal(new Set(seenProps.map((p) => p.labels)).size, 1);
});

test('amounts in a reply are not read as math by the shell renderer', async () => {
  const seenProps = [];
  const MarkdownText = (props) => (seenProps.push(props), { type: 'md', props, children: [props.text] });
  await chatWith('Ledger created the $9 monthly / $90 annual prices. Code stays: `$9`, and so does $x^2$.', { primitives: { MarkdownText } });
  assert.equal(seenProps.at(-1).text, 'Ledger created the \\$9 monthly / \\$90 annual prices. Code stays: `$9`, and so does $x^2$.');
});

test('links in a message get rich cards: a playable YouTube video and an X post', async () => {
  const { tree, unfurled } = await chatWith(TABLE_REPLY);
  assert.deepEqual(unfurled.sort(), ['https://github.com/', 'https://x.com/jack/status/20', 'https://youtu.be/dQw4w9WgXcQ'].sort());
  const [yt] = findAll(tree, (n) => n.props['data-dsh-bots-card'] === 'youtube');
  assert.ok(yt);
  assert.match(collect(yt).join(' '), /Never Gonna/);
  assert.ok(findAll(yt, (n) => n.type === 'img' && /hqdefault/.test(n.props.src)).length === 1);
  assert.equal(findAll(yt, (n) => n.type === 'iframe').length, 0);
  const [x] = findAll(tree, (n) => n.props['data-dsh-bots-card'] === 'x');
  assert.match(collect(x).join(' '), /just setting up my twttr/);
  assert.match(collect(x).join(' '), /@jack/);
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-card'] === 'page').length === 1);
});

test('the user bubble links its URLs and a pasted link previews above the composer', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const [composer] = findAll(tree, (n) => n.props['data-dsh-bots-composer']);
  composer.props.onChange({ target: { value: 'look https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
  hooks.rewind();
  panel({});
  await new Promise((r) => setTimeout(r, 450));
  hooks.rewind();
  tree = panel({});
  await flush();
  hooks.rewind();
  tree = panel({});
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-composer-preview']).length, 1);
});

// --- chat channels ---------------------------------------------------------------------------

const TG_ENTRY = {
  id: 'telegram', kind: 'channel', channel: 'telegram', name: { en: 'Telegram', zh: 'Telegram' }, description: { en: 'Message your bot team from Telegram.', zh: '在 Telegram 里给 Bot 团队发消息。' },
  category: 'computer', icon: 'TG', color: '#229ED9', serverName: 'telegram', homepage: 'https://core.telegram.org/bots', keyUrl: 'https://t.me/BotFather', featured: true,
  fields: [{ key: 'token', kind: 'secret', required: true, label: { en: 'Bot token', zh: 'Bot Token' }, help: { en: 'Message @BotFather, send /newbot.', zh: '找 @BotFather，发送 /newbot。' } }],
};
const DC_ENTRY = { ...TG_ENTRY, id: 'discord', channel: 'discord', name: { en: 'Discord', zh: 'Discord' }, icon: 'DC', color: '#5865F2', serverName: 'discord', keyUrl: 'https://discord.com/developers/applications', featured: false };

/** Run `fn` with the shared fixtures changed, then put them back. */
async function withFixtures(change, fn) {
  const saved = { templates: CATALOG.templates.slice(), apps: BOTS.map((b) => b.apps), channels: BOTS.map((b) => b.channels), messages: MESSAGES.slice() };
  change();
  try {
    await fn();
  } finally {
    CATALOG.templates.splice(0, CATALOG.templates.length, ...saved.templates);
    BOTS.forEach((b, i) => {
      b.apps = saved.apps[i];
      if (saved.channels[i] === undefined) delete b.channels;
      else b.channels = saved.channels[i];
    });
    MESSAGES.splice(0, MESSAGES.length, ...saved.messages);
  }
}

test('channels: the gallery offers Telegram as a chat app; its form has the token and no server name', async () => {
  await withFixtures(() => CATALOG.templates.push(TG_ENTRY), async () => {
    const v = await openTab('apps', 'bot-b');
    const [card] = findAll(v.tree, (n) => n.props['data-dsh-bots-template'] === 'telegram');
    assert.ok(card, 'a Telegram card');
    const cardText = collect(card).join(' ');
    assert.match(cardText, /chat app/);
    assert.match(cardText, /Create a bot/);
    assert.ok(findAll(card, (n) => n.type === 'a' && n.props.href === 'https://t.me/BotFather').length === 1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-add-app'] === 'telegram')[0].props.onClick();
    await v.rerender(1);
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-app-form'] === 'telegram').length === 1);
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-channel-how'] === 'telegram').length === 1);
    const text = collect(v.tree).join(' ');
    assert.doesNotMatch(text, /Server name/);
    assert.match(text, /It connects as soon as you save/);
    assert.match(text, /BotFather, send \/newbot/);
    const [token] = findAll(v.tree, (n) => n.props['data-dsh-bots-app-field'] === 'token');
    assert.equal(token.props.type, 'password');
    token.props.onChange({ target: { value: ' 123456:AAtoken ' } });
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-app-save'])[0].props.onClick();
    await flush();
    const added = v.posts.find((p) => p.path.endsWith('/save')).body.bot.apps.at(-1);
    assert.equal(added.template, 'telegram');
    assert.equal(added.serverName, 'telegram');
    assert.deepEqual(added.values, { token: '123456:AAtoken' });
    v.hooks.runCleanups();
  });
});

test('channels: an installed chat app shows its connection, the pairing code and paired people', async () => {
  const view = {
    kind: 'telegram', state: 'connected', account: { username: 'acme_team_bot', name: 'Acme' },
    paired: [{ id: '42', name: 'Kada', at: Date.now() - 86_400_000, direct: true }],
    code: { code: 'ABC234', expiresAt: Date.now() + 9 * 60_000 }, link: 'https://t.me/acme_team_bot?start=ABC234',
    scheduleReplies: true, ignored: { count: 2, lastName: 'Mallory' },
  };
  await withFixtures(() => {
    CATALOG.templates.push(TG_ENTRY, DC_ENTRY);
    BOTS[0].apps = [{ id: 'tg1', template: 'telegram', name: 'Telegram', serverName: 'telegram', enabled: true, values: { token: '••••••••' }, config: {} }];
    BOTS[0].channels = { tg1: view };
  }, async () => {
    const v = await openTab('apps', 'bot-a');
    const [panel] = findAll(v.tree, (n) => n.props['data-dsh-bots-channel'] === 'tg1');
    assert.ok(panel, 'the channel panel');
    const text = collect(panel).join(' ');
    assert.match(text, /Connected as @acme_team_bot/);
    assert.match(text, /Paired people \(1\)/);
    assert.match(text, /Kada/);
    assert.match(text, /gets scheduled reports/);
    assert.match(text, /expires in 9 min/);
    assert.match(text, /Ignored 2 messages from people who are not paired \(last: Mallory\)/);
    assert.match(text, /Only paired people reach the team/);
    assert.equal(findAll(panel, (n) => n.props['data-dsh-bots-pair-code'])[0].props['data-dsh-bots-pair-code'], 'ABC234');
    assert.equal(findAll(panel, (n) => n.props['data-dsh-bots-pair-link'])[0].props.href, 'https://t.me/acme_team_bot?start=ABC234');
    const row = findAll(v.tree, (n) => n.props['data-dsh-bots-app'] === 'tg1')[0];
    assert.match(collect(row).join(' '), /chat app/);
    assert.doesNotMatch(collect(row).join(' '), /mcp__telegram__/);

    findAll(panel, (n) => n.props['data-dsh-bots-new-code'] === 'tg1')[0].props.onClick();
    await flush();
    findAll(panel, (n) => n.props['data-dsh-bots-unpair'] === '42')[0].props.onClick();
    await flush();
    findAll(panel, (n) => n.props['data-dsh-bots-channel-schedules'] === 'tg1')[0].props.onClick({});
    await flush();
    const bodies = Object.fromEntries(v.posts.filter((p) => p.path.includes('/channels/')).map((p) => [p.path.split('/__dsh_bots/')[1], p.body]));
    assert.deepEqual(bodies['channels/code'], { botId: 'bot-a', appId: 'tg1' });
    assert.deepEqual(bodies['channels/unpair'], { botId: 'bot-a', appId: 'tg1', userId: '42' });
    assert.deepEqual(bodies['channels/options'], { botId: 'bot-a', appId: 'tg1', scheduleReplies: false });
    v.hooks.runCleanups();
  });
});

test('channels: a Discord error reads as what to do; nobody paired offers to pair once connected', async () => {
  await withFixtures(() => {
    CATALOG.templates.push(TG_ENTRY, DC_ENTRY);
    BOTS[0].apps = [
      { id: 'dc1', template: 'discord', name: 'Discord', serverName: 'discord', enabled: true, values: { token: '••••••••' }, config: {} },
      { id: 'tg1', template: 'telegram', name: 'Telegram', serverName: 'telegram', enabled: true, values: { token: '••••••••' }, config: {} },
    ];
    BOTS[0].channels = {
      dc1: { kind: 'discord', state: 'error', hint: 'intent', detail: 'Discord refused the Message Content intent (close 4014).', fatal: true, account: null, paired: [], code: null, link: null, invite: null, scheduleReplies: true, ignored: { count: 0 } },
      tg1: { kind: 'telegram', state: 'connected', account: { username: 'acme_team_bot' }, paired: [], code: null, link: null, scheduleReplies: true, ignored: { count: 0 } },
    };
  }, async () => {
    const v = await openTab('apps', 'bot-a');
    const [dc] = findAll(v.tree, (n) => n.props['data-dsh-bots-channel'] === 'dc1');
    const dcText = collect(dc).join(' ');
    assert.match(dcText, /Turn on Message Content Intent/);
    assert.match(dcText, /close 4014/);
    findAll(dc, (n) => n.props['data-dsh-bots-channel-reconnect'] === 'dc1')[0].props.onClick();
    await flush();
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/channels/reconnect')).body, { botId: 'bot-a', appId: 'dc1' });
    const [tg] = findAll(v.tree, (n) => n.props['data-dsh-bots-channel'] === 'tg1');
    assert.match(collect(tg).join(' '), /Nobody yet/);
    const [pair] = findAll(tg, (n) => n.props['data-dsh-bots-new-code'] === 'tg1');
    assert.match(collect(pair).join(' '), /Pair yourself/);
    assert.equal(pair.props.disabled, false);
    v.hooks.runCleanups();
  });
});

test('channels: messages from and to a chat app are marked in the thread and the activity view', async () => {
  await withFixtures(() => {
    MESSAGES.push(
      { id: 'm4', from: 'user', to: 'bot-a', text: 'From my phone', at: Date.now() - 5_000, kind: 'user', via: 'telegram', who: 'Kada' },
      { id: 'm5', from: 'bot-a', to: 'user', text: 'On it.', at: Date.now() - 1_000, kind: 'reply', via: 'telegram' },
    );
  }, async () => {
    const v = await openTab('chat', 'bot-a');
    const marks = findAll(v.tree, (n) => n.props['data-dsh-bots-via'] === 'telegram').map((n) => collect(n).join(''));
    assert.deepEqual(marks, ['Telegram · Kada', '→ Telegram']);
    v.hooks.runCleanups();
  });
  const { exports, seen } = await (async () => {
    const loaded = await loadClient();
    const c = fakeContext();
    loaded.exports.apply(c.ctx);
    return { ...loaded, seen: c.seen };
  })();
  void exports;
  const en = seen.locale.dict.en;
  const zh = seen.locale.dict.zh;
  for (const hint of ['token', 'intent', 'conflict', 'duplicate']) assert.ok(en[`channelHint_${hint}`] && zh[`channelHint_${hint}`], hint);
});


// --- usage, memory, topics, settings, model sources ------------------------------------------

async function openView(attr) {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const rerender = async (n = 3) => {
    for (let i = 0; i < n; i += 1) {
      hooks.rewind();
      tree = panel({});
      await flush();
    }
    hooks.rewind();
    tree = panel({});
    return tree;
  };
  findAll(tree, (n) => n.props[attr])[0].props.onClick();
  await rerender();
  return { hooks, posts, panel, get tree() { return tree; }, rerender };
}

test('usage: tiles, a stacked chart with legend and hover, tables by bot, model, kind, schedule and recent tasks', async () => {
  const v = await openView('data-dsh-bots-usage-entry');
  const text = collect(v.tree).join(' ');
  assert.match(text, /1\.3M/);
  assert.match(text, /95% of input from cache/);
  assert.match(text, /\$1\.23/);
  assert.match(text, /3\.0K tokens have no price/);
  assert.match(text, /\+25% vs the period before/);
  assert.match(text, /Tokens by bot/);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-usage-col'] !== undefined).length, 7);
  assert.match(text, /Conversations/);
  assert.match(text, /Memory summaries/);
  assert.match(text, /Morning brief/);
  assert.match(text, /From Telegram/);
  assert.match(text, /Running/);
  assert.match(text, /Set price/, 'an unpriced model offers to set a price');
  // Hovering a column shows its breakdown.
  findAll(v.tree, (n) => n.props['data-dsh-bots-usage-col'] === 6)[0].props.onMouseEnter();
  await v.rerender(1);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-usage-tip']).length, 1);
  // The range switch asks the Host again.
  findAll(v.tree, (n) => n.props['data-dsh-bots-range'] === '30d')[0].props.onClick();
  await v.rerender();
  assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-range'] === '30d')[0].props['aria-selected']);
  // Prices.
  findAll(v.tree, (n) => n.props['data-dsh-bots-prices'])[0].props.onClick();
  await v.rerender();
  const prices = collect(v.tree).join(' ');
  assert.match(prices, /Model prices/);
  assert.match(prices, /LiteLLM’s public price list \(1800 models/);
  assert.match(prices, /No price/);
  v.hooks.runCleanups();
});

test('memory tab: notes with pin and delete, recent work, topics and a new-topic button', async () => {
  const v = await openTab('memory', 'bot-a');
  const text = collect(v.tree).join(' ');
  assert.match(text, /What Ada remembers/);
  assert.match(text, /Kada prefers short answers/);
  assert.match(text, /after a task/);
  assert.match(text, /Sent the morning brief with three items/);
  assert.match(text, /runs: 3/);
  assert.match(text, /after a quiet spell/);
  assert.match(text, /Plan the launch · Weekly review/);
  assert.match(text, /Memory work runs on each bot’s own model/);
  // Pinned notes sort first.
  const notes = findAll(v.tree, (n) => n.props['data-dsh-bots-note']).map((n) => n.props['data-dsh-bots-note']);
  assert.deepEqual(notes, ['n-2', 'n-1']);
  findAll(v.tree, (n) => n.props['data-dsh-bots-note-pin'] === 'n-1')[0].props.onClick();
  findAll(v.tree, (n) => n.props['data-dsh-bots-note-delete'] === 'n-2')[0].props.onClick();
  findAll(v.tree, (n) => n.props['data-dsh-bots-new-topic'] === 'memory')[0].props.onClick();
  await v.rerender();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/memory/put')).body, { scope: 'bot-a', note: { id: 'n-1', pinned: true } });
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/memory/delete')).body, { scope: 'bot-a', id: 'n-2' });
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/topic/new')).body, { id: 'bot-a' });
  v.hooks.runCleanups();
});

test('team memory: shared notes, digests, journal, and consolidating now', async () => {
  const v = await openView('data-dsh-bots-memory-entry');
  const text = collect(v.tree).join(' ');
  assert.match(text, /Team memory/);
  assert.match(text, /The company is called Acme/);
  assert.match(text, /2026-11-15/);
  assert.match(text, /Last consolidated/);
  assert.match(text, /every day at 03:00/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-dream'])[0].props.onClick();
  await v.rerender();
  assert.ok(v.posts.some((p) => p.path.endsWith('/memory/dream')));
  v.hooks.runCleanups();
});

test('settings: topics and memory controls save as one patch', async () => {
  const v = await openView('data-dsh-bots-settings');
  const text = collect(v.tree).join(' ');
  assert.match(text, /Bots settings/);
  assert.match(text, /New topic after this many quiet hours/);
  assert.match(text, /Model for memory work/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-setting'] === 'idleHours')[0].props.onChange({ target: { value: '3' } });
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-settings-save'])[0].props.onClick();
  await v.rerender();
  const post = v.posts.find((p) => p.path.endsWith('/settings'));
  assert.deepEqual(post.body.patch.topics, { idleHours: 3, maxContextK: 128 });
  assert.equal(post.body.patch.memory.dreamTime, '03:00');
  v.hooks.runCleanups();
});

test('chat: a topic divider and a new-topic button; the profile groups models and offers model sources', async () => {
  MESSAGES.push({ id: 'm4', from: 'system', to: 'bot-a', text: 'context', at: Date.now(), kind: 'topic' });
  BOTS[0].topic = { startedAt: Date.now() - 60_000, tasks: 2, context: 12_000 };
  try {
    const v = await openTab('chat', 'bot-a');
    let text = collect(v.tree).join(' ');
    assert.match(text, /New topic · the conversation grew large/);
    // The thread keeps itself at the bottom: it follows its own scrolling and holds what it observes.
    const [box] = findAll(v.tree, (n) => n.props['data-dsh-bots-thread'] === 'bot-a');
    assert.equal(typeof box.props.onScroll, 'function');
    assert.ok(box.props.ref && box.children[0].props.ref, 'the box and its content are both referenced');
    assert.match(text, /This topic: 12K context · runs: 2/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-new-topic'] === 'chat')[0].props.disabled, true, 'not while the bot is running');
    const p = await openTab('profile', 'bot-b');
    text = collect(p.tree).join(' ');
    assert.match(text, /Model sources/);
    findAll(p.tree, (n) => n.props['data-dsh-bots-model-sources'])[0].props.onClick();
    await p.rerender();
    text = collect(p.tree).join(' ');
    assert.match(text, /Your endpoints/);
    assert.match(text, /Local/);
    assert.match(text, /Codex CLI · ChatGPT/);
    assert.match(text, /k@example\.com · pro/);
    assert.match(text, /Anthropic allows a Claude subscription only in Claude Code/);
    findAll(p.tree, (n) => n.props['data-dsh-bots-login-connect'] === 'codex')[0].props.onClick();
    findAll(p.tree, (n) => n.props['data-dsh-bots-add-endpoint'])[0].props.onClick();
    await p.rerender();
    assert.equal(findAll(p.tree, (n) => n.props['data-dsh-bots-endpoint-form'] === 'new').length, 1);
    assert.deepEqual(p.posts.find((x) => x.path.endsWith('/models/login/connect')).body, { id: 'codex' });
    p.hooks.runCleanups();
    v.hooks.runCleanups();
  } finally {
    MESSAGES.pop();
    delete BOTS[0].topic;
  }
});

test('the model picker groups by provider and shows the thinking levels of the chosen model', async () => {
  const saved = CATALOG.models;
  CATALOG.models = [
    { provider: 'p', model: 'm', label: 'P · M', group: 'P', name: 'M', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high', context: 1_000_000 },
    { provider: 'bots-local', model: 'qwen', label: 'Local · qwen', group: 'Local', name: 'qwen', source: 'custom' },
  ];
  CATALOG.defaultModel = { provider: 'p', model: 'm' };
  try {
    const v = await openTab('profile', 'bot-b');
    const groups = findAll(v.tree, (n) => n.type === 'optgroup').map((n) => n.props.label);
    assert.deepEqual(groups, ['P', 'Local · your endpoint']);
    const text = collect(v.tree).join(' ');
    assert.match(text, /Harness default \(m\)/);
    assert.match(text, /P · context window 1\.0M tokens/);
    const effort = findAll(v.tree, (n) => n.props['data-dsh-bots-effort'])[0];
    assert.ok(effort);
    effort.props.onChange({ target: { value: 'low' } });
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-save'])[0].props.onClick();
    await v.rerender();
    assert.deepEqual(v.posts.find((x) => x.path.endsWith('/save')).body.bot.model, { provider: 'p', model: 'm', reasoningEffort: 'low' });
    v.hooks.runCleanups();
  } finally {
    CATALOG.models = saved;
    delete CATALOG.defaultModel;
  }
});

// --- tasks, the dispatcher's mode, the router notice ------------------------------------------

/** Run `fn` with extra fields on the shared fixtures, put back afterwards. */
async function withTaskState(patch, fn) {
  const saved = { state: { ...STATE }, bots: BOTS.map((b) => ({ tickets: b.tickets, tools: b.tools })) };
  Object.assign(STATE, patch.state ?? {});
  (patch.bots ?? []).forEach((p, i) => p && Object.assign(BOTS[i], p));
  try {
    await fn();
  } finally {
    for (const k of Object.keys(STATE)) if (!(k in saved.state)) delete STATE[k];
    Object.assign(STATE, saved.state);
    BOTS.forEach((b, i) => {
      if (saved.bots[i].tickets === undefined) delete b.tickets;
      else b.tickets = saved.bots[i].tickets;
      b.tools = saved.bots[i].tools;
    });
  }
}
const ATTENTION = TICKETS.filter((r) => ['question', 'failed', 'stalled'].includes(r.stage));
const TASK_COUNTS = { bots: [null, { tickets: { working: 1, question: 1, stalled: 0, queued: 0 } }, { tickets: { working: 0, question: 0, stalled: 1, queued: 1 } }] };
const click = (tree, attr, value = true) => {
  const [node] = findAll(tree, (n) => (value === true ? Boolean(n.props[attr]) : n.props[attr] === value));
  assert.ok(node, `${attr}=${value}`);
  node.props.onClick?.({ stopPropagation() {} });
};
const confirmButton = (tree) => findAll(tree, (n) => n.type === 'button' && n.props.className === 'dshb-btn dshb-btn-primary dshb-btn-danger')[0];

test('tasks: the rail badge counts what needs you; the view groups needs you, in progress and recently done', async () => {
  await withTaskState({ state: { attention: ATTENTION }, ...TASK_COUNTS }, async () => {
    const v = await openView('data-dsh-bots-tasks-entry');
    const [badge] = findAll(v.tree, (n) => n.props['data-dsh-bots-tasks-badge'] !== undefined);
    assert.equal(badge.props['data-dsh-bots-tasks-badge'], 3);
    assert.equal(collect(badge).join(''), '3');
    assert.equal(badge.props['aria-label'], '3 need you');
    const groups = findAll(v.tree, (n) => n.props['data-dsh-bots-task-group']).map((n) => [n.props['data-dsh-bots-task-group'], findAll(n, (x) => x.props['data-dsh-bots-task']).map((x) => x.props['data-dsh-bots-task'])]);
    assert.deepEqual(groups, [
      ['needs', ['tquestion', 'tfailed01', 'tstalled1']],
      ['progress', ['tqueued01', 'tworking1']],
      ['done', ['tdone0001', 'tstopped1']],
    ]);
    const row = findAll(v.tree, (n) => n.props['data-dsh-bots-task'] === 'tquestion')[0];
    const text = collect(row).join(' ');
    assert.match(text, /Which logo do you prefer\?/);
    assert.match(text, /Needs your answer/);
    assert.match(text, /Bob/);
    assert.match(text, /asked by Ada/);
    assert.match(text, /Telegram/);
    assert.match(text, /2 min ago/);
    assert.match(text, /Blue or green\?/);
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-task'] === 'tstalled1')[0]).join(' '), /asked by you .*Panel/);
    // Filtering by bot asks the Host for that bot's tasks.
    const fetched = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (url, init) => (fetched.push(String(url)), inner(url, init));
    findAll(v.tree, (n) => n.props['data-dsh-bots-tasks-bot'])[0].props.onChange({ target: { value: 'bot-c' } });
    await v.rerender();
    assert.ok(fetched.includes('/__dsh_bots/tickets?limit=200&bot=bot-c'), fetched.join(', '));
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-task']).map((n) => n.props['data-dsh-bots-task']), ['tstalled1', 'tqueued01', 'tstopped1']);
    v.hooks.runCleanups();
  });
  // No tasks at all: one empty state; per-section words when only some are empty.
  const saved = TICKETS.splice(0);
  try {
    const v = await openView('data-dsh-bots-tasks-entry');
    const text = collect(v.tree).join(' ');
    assert.match(text, /No tasks yet/);
    assert.match(text, /hands work to a teammate/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-tasks-badge'] !== undefined).length, 0);
    assert.match(text, /Work handed to your bots/);
    v.hooks.runCleanups();
    TICKETS.push(saved.find((r) => r.id === 'tdone0001'));
    const w = await openView('data-dsh-bots-tasks-entry');
    const words = collect(w.tree).join(' ');
    assert.match(words, /Nothing needs you right now\./);
    assert.match(words, /Nothing is in progress\./);
    assert.match(words, /Weekly numbers/);
    w.hooks.runCleanups();
  } finally {
    TICKETS.splice(0, TICKETS.length, ...saved);
  }
});

test('tasks: the detail shows who, where from, the reports and usage; each action posts to its route', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const rerender = async (n = 3) => {
    for (let i = 0; i < n; i += 1) {
      hooks.rewind();
      tree = panel({});
      await flush();
    }
    hooks.rewind();
    tree = panel({});
    return tree;
  };
  click(tree, 'data-dsh-bots-tasks-entry');
  await rerender();
  click(tree, 'data-dsh-bots-task', 'tquestion');
  await rerender();
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-ticket'] === 'tquestion').length, 1);
  let text = collect(tree).join(' ');
  assert.match(text, /Which logo do you prefer\?/);
  assert.match(text, /Needs your answer/);
  const fact = (name) => collect(findAll(tree, (n) => n.props['data-dsh-bots-ticket-fact'] === name)[0]).join(' ');
  assert.match(fact('bot'), /Bob/);
  assert.match(fact('requester'), /Ada/);
  assert.match(fact('from'), /Telegram · Kada/);
  assert.doesNotMatch(fact('from'), /Kada .*Kada/, 'who is not repeated when the label has it');
  assert.match(text, /Draw two logo options/);
  // Reports in time order, rendered like bot replies (Markdown).
  assert.deepEqual(findAll(tree, (n) => n.props['data-dsh-bots-report-item']).map((n) => n.props['data-dsh-bots-report-item']), ['progress', 'question']);
  assert.ok(findAll(tree, (n) => n.type === 'strong' && collect(n).join('') === 'Blue').length === 1);
  // Usage: the Host's totals, and the number of runs.
  const tile = (attr) => collect(findAll(tree, (n) => n.props['data-dsh-bots-tile'] === attr)[0]).join(' ');
  assert.match(tile('ticket-tokens'), /Tokens 16K/);
  assert.match(tile('ticket-cost'), /\$0\.030/);
  assert.match(tile('ticket-runs'), /Runs 2/);
  // The parent and the sub-task show as cards with their own titles.
  assert.match(collect(findAll(tree, (n) => n.props['data-dsh-bots-ticket-parent'] === 'tworking1')[0]).join(' '), /Fix the login bug/);
  assert.match(collect(findAll(tree, (n) => n.props['data-dsh-bots-ticket-children'] === 1)[0]).join(' '), /Translate the docs .*Queued/);
  // A question asks for an answer; no Retry for an open question.
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-ticket-composer'])[0].props.placeholder, 'Answer Bob…');
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-ticket-retry']).length, 0);

  // Open conversation: the task's own Harness session.
  click(tree, 'data-dsh-bots-ticket-open', 'tquestion');
  assert.deepEqual(seen.opened, ['ticket-tquestion']);

  // Stop and Close ask first, then post.
  click(tree, 'data-dsh-bots-ticket-stop', 'tquestion');
  await rerender(1);
  assert.match(collect(tree).join(' '), /Stop “Which logo do you prefer\?”\?/);
  assert.equal(posts.length, 0, 'nothing posted before confirming');
  confirmButton(tree).props.onClick();
  await rerender();
  assert.ok(posts.some((p) => p.path === '/__dsh_bots/tickets/tquestion/stop'));
  assert.match(collect(tree).join(' '), /Task stopped\./);
  click(tree, 'data-dsh-bots-ticket-close', 'tquestion');
  await rerender(1);
  assert.match(collect(tree).join(' '), /Mark “Which logo do you prefer\?” done\?/);
  confirmButton(tree).props.onClick();
  await rerender();
  assert.ok(posts.some((p) => p.path === '/__dsh_bots/tickets/tquestion/close'));

  // A message to the task: Enter sends it.
  const [box] = findAll(tree, (n) => n.props['data-dsh-bots-ticket-composer'] === 'tquestion');
  box.props.onChange({ target: { value: 'Blue, please' } });
  await rerender(1);
  let prevented = false;
  findAll(tree, (n) => n.props['data-dsh-bots-ticket-composer'] === 'tquestion')[0].props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: () => (prevented = true) });
  await rerender();
  assert.equal(prevented, true);
  assert.deepEqual(posts.find((p) => p.path === '/__dsh_bots/tickets/tquestion/message').body, { text: 'Blue, please' });

  // Back to the list, then a failed task: its error, and Retry without asking.
  click(tree, 'data-dsh-bots-tasks-back');
  await rerender();
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-tasks']).length === 1);
  click(tree, 'data-dsh-bots-task', 'tfailed01');
  await rerender();
  text = collect(tree).join(' ');
  assert.match(text, /Connection refused \(3 tries\)\./);
  assert.equal(fact('from'), 'From The Bots panel', 'the panel in words of the page, not the Host');
  assert.doesNotMatch(text, /the user/);
  assert.match(text, /No model calls yet\./);
  assert.match(text, /No report yet\. Bob reports when it is done, stuck, or has a question\./);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-ticket-stop']).length, 0, 'a failed task that ended cannot be stopped');
  click(tree, 'data-dsh-bots-ticket-retry', 'tfailed01');
  await rerender();
  assert.ok(posts.some((p) => p.path === '/__dsh_bots/tickets/tfailed01/retry'));
  hooks.runCleanups();
});

test('tasks: a bot page lists its open tasks and links to all of them', async () => {
  await withTaskState(TASK_COUNTS, async () => {
    const v = await openTab('tasks', 'bot-b');
    const tab = findAll(v.tree, (n) => n.props['data-dsh-bots-tab'] === 'tasks')[0];
    assert.match(collect(tab).join(' '), /Tasks 2/);
    const [list] = findAll(v.tree, (n) => n.props['data-dsh-bots-bot-tasks'] === 'bot-b');
    const ids = findAll(list, (n) => n.props['data-dsh-bots-task']).map((n) => n.props['data-dsh-bots-task']);
    assert.deepEqual(ids, ['tquestion', 'tworking1', 'tfailed01', 'tdone0001']);
    assert.match(collect(list).join(' '), /What Bob is working on/);
    findAll(v.tree, (n) => n.props['data-dsh-bots-bot-tasks-all'] === 'bot-b')[0].props.onClick();
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-tasks-bot'])[0].props.value, 'bot-b');
    // A row opens its task.
    click(v.tree, 'data-dsh-bots-task', 'tworking1');
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ticket'] === 'tworking1').length, 1);
    v.hooks.runCleanups();
  });
});

test('the dispatcher: How it works saves the team setting, and a router gets the light-model hint', async () => {
  const v = await openTab('profile', 'bot-a');
  const modes = () => findAll(v.tree, (n) => n.props['data-dsh-bots-dispatcher-modes'])[0];
  assert.equal(modes().props['data-dsh-bots-dispatcher-modes'], 'router', 'router unless the settings say otherwise');
  assert.equal(modes().props.role, 'radiogroup');
  const radio = (id) => findAll(v.tree, (n) => n.props['data-dsh-bots-dispatcher-mode'] === id)[0];
  assert.equal(radio('router').props['aria-checked'], true);
  assert.match(collect(modes()).join(' '), /Understands, hands out, reports/);
  assert.match(collect(modes()).join(' '), /Also does small things itself/);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-model-hint']).length, 1);
  assert.match(collect(v.tree).join(' '), /a light, fast model is enough/);
  radio('hands-on').props.onClick();
  await v.rerender();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/settings')).body, { patch: { dispatcher: 'hands-on' } });
  assert.equal(modes().props['data-dsh-bots-dispatcher-modes'], 'hands-on');
  assert.equal(radio('hands-on').props['aria-checked'], true);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-model-hint']).length, 0, 'no hint for a hands-on dispatcher');
  assert.match(collect(v.tree).join(' '), /Ada does small things itself again\./);
  v.hooks.runCleanups();
  // Only the dispatcher has it.
  const b = await openTab('profile', 'bot-b');
  assert.equal(findAll(b.tree, (n) => n.props['data-dsh-bots-dispatcher-modes']).length, 0);
  assert.equal(findAll(b.tree, (n) => n.props['data-dsh-bots-router-model-hint']).length, 0);
  b.hooks.runCleanups();
});

test('router mode: abilities a router goes without are marked, and each comes back through routerAllow', async () => {
  const saved = CATALOG.abilities;
  CATALOG.abilities = [
    ...saved,
    { id: 'files', name: { en: 'Files', zh: '读写文件' }, description: { en: 'Read and write files.', zh: '读写文件。' }, tools: ['read', 'write', 'edit'], available: ['read', 'write', 'edit'] },
  ];
  try {
    await withTaskState({ bots: [{ tools: { deny: [] } }] }, async () => {
      const v = await openTab('profile', 'bot-a');
      const rows = () => findAll(v.tree, (n) => n.props['data-dsh-bots-ability']).map((n) => [n.props['data-dsh-bots-ability'], n.props['data-on']]);
      assert.deepEqual(rows(), [['web', true], ['code', false], ['plugins', true], ['files', true]]);
      assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-router-off']).map((n) => [n.props['data-dsh-bots-router-off'], collect(n).join('')]), [['code', 'Off in Router mode'], ['files', 'Partly off in Router mode']]);
      assert.match(collect(v.tree).join(' '), /In Router mode it does not run commands/);
      assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-tool'] === 'bash').length, 1, 'the per-tool list marks it too');
      // Commands back on: through routerAllow; writing files back on: its own link.
      click(v.tree, 'data-dsh-bots-ability-switch', 'code');
      await v.rerender(1);
      click(v.tree, 'data-dsh-bots-router-allow', 'files');
      await v.rerender(1);
      assert.deepEqual(rows(), [['web', true], ['code', true], ['plugins', true], ['files', true]]);
      assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-router-allowed']).map((n) => n.props['data-dsh-bots-router-allowed']), ['code', 'files']);
      click(v.tree, 'data-dsh-bots-save');
      await v.rerender();
      assert.deepEqual(v.posts.find((p) => p.path.endsWith('/save')).body.bot.tools, { deny: [], routerAllow: ['bash', 'edit', 'write'] });
      v.hooks.runCleanups();
    });
    // Allowed back already: switching it off again only drops it from routerAllow (hands-on keeps it).
    await withTaskState({ bots: [{ tools: { deny: [], routerAllow: ['bash'] } }] }, async () => {
      const v = await openTab('profile', 'bot-a');
      assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ability'] === 'code')[0].props['data-on'], true);
      click(v.tree, 'data-dsh-bots-ability-switch', 'code');
      await v.rerender(1);
      click(v.tree, 'data-dsh-bots-save');
      await v.rerender();
      assert.deepEqual(v.posts.find((p) => p.path.endsWith('/save')).body.bot.tools, { deny: [], routerAllow: [] });
      v.hooks.runCleanups();
    });
    // A hands-on dispatcher, and every other bot, see the abilities as before.
    const b = await openTab('profile', 'bot-b');
    assert.equal(findAll(b.tree, (n) => n.props['data-dsh-bots-router-off'] || n.props['data-dsh-bots-router-allowed']).length, 0);
    assert.deepEqual(findAll(b.tree, (n) => n.props['data-dsh-bots-ability']).map((n) => n.props['data-on']), [true, true, true, true]);
    b.hooks.runCleanups();
    // The Host's own list wins when the catalog has one.
    CATALOG.routerDeny = ['bash'];
    try {
      await withTaskState({ bots: [{ tools: { deny: [] } }] }, async () => {
        const v = await openTab('profile', 'bot-a');
        assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-router-off']).map((n) => n.props['data-dsh-bots-router-off']), ['code']);
        v.hooks.runCleanups();
      });
    } finally {
      delete CATALOG.routerDeny;
    }
  } finally {
    CATALOG.abilities = saved;
  }
});

test('settings: concurrent tasks, minutes before stuck and hours before archiving save with the rest', async () => {
  const v = await openView('data-dsh-bots-settings');
  const text = collect(v.tree).join(' ');
  assert.match(text, /Tasks worked on at once/);
  assert.match(text, /Minutes before a quiet task counts as stuck/);
  assert.match(text, /Hours before a finished task’s conversation is archived/);
  const field = (name) => findAll(v.tree, (n) => n.props['data-dsh-bots-setting'] === name)[0];
  assert.deepEqual(['maxWorking', 'stallMinutes', 'archiveHours'].map((k) => field(k).props.value), [4, 20, 24], 'the Host defaults when settings have none');
  field('maxWorking').props.onChange({ target: { value: '6' } });
  field('stallMinutes').props.onChange({ target: { value: '' } });
  field('archiveHours').props.onChange({ target: { value: '0' } });
  await v.rerender(1);
  click(v.tree, 'data-dsh-bots-settings-save');
  await v.rerender();
  const post = v.posts.find((p) => p.path.endsWith('/settings'));
  assert.deepEqual(post.body.patch.tickets, { maxWorking: 6, stallMinutes: 20, archiveHours: 0 });
  assert.deepEqual(post.body.patch.topics, { idleHours: 6, maxContextK: 128 });
  assert.equal('dispatcher' in post.body.patch, false, 'the settings dialog leaves the dispatcher mode alone');
  v.hooks.runCleanups();
});

test('the router notice shows once, opens the dispatcher, and is dismissed through its route', async () => {
  await withTaskState({ state: { routerNoticePending: true } }, async () => {
    const { exports, hooks } = await loadClient();
    const { ctx, seen } = fakeContext();
    exports.apply(ctx);
    const posts = mockFetch();
    const panel = seen.slots.find((s) => s.options.name === 'main').component;
    let tree = await renderSettled(panel, {}, hooks);
    const [notice] = findAll(tree, (n) => n.props['data-dsh-bots-router-notice']);
    assert.ok(notice);
    const words = collect(notice).join(' ');
    assert.match(words, /Your dispatcher now hands out the work/);
    assert.match(words, /set How it works to Hands-on/);
    // Two sentences: what changed, and where to switch back.
    for (const lang of ['en', 'zh']) assert.equal(seen.locale.dict[lang].routerNoticeBody.split(/(?<=[.。])\s*/).filter(Boolean).length, 2, lang);
    click(tree, 'data-dsh-bots-router-notice-open');
    hooks.rewind();
    tree = panel({});
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-tab'] === 'profile')[0].props['data-active'], true);
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-detail'] === 'bot-a').length, 1);
    click(tree, 'data-dsh-bots-router-notice-dismiss');
    await flush();
    hooks.rewind();
    tree = panel({});
    assert.ok(posts.some((p) => p.path === '/__dsh_bots/router-notice/dismiss'));
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-router-notice']).length, 0);
    hooks.runCleanups();
  });
  // Without the flag: no notice.
  const v = await openView('data-dsh-bots-usage-entry');
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-notice']).length, 0);
  v.hooks.runCleanups();
});

test('usage: a by-task table, and the old task counts read as runs', async () => {
  USAGE.tickets = [{ id: 'tquestion', title: 'Which logo do you prefer?', bot: 'bot-b', stage: 'question', runs: 2, tokens: 15_000, cost: { USD: 0.025 } }];
  USAGE.tasks[1].ticket = 'tworking1';
  try {
    const v = await openView('data-dsh-bots-usage-entry');
    const text = collect(v.tree).join(' ');
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-tile'] === 'runs')[0]).join(' '), /Runs 7/);
    assert.match(text, /Recent runs/);
    assert.match(text, /By task/);
    assert.doesNotMatch(text, /Recent tasks/);
    const bots = findAll(v.tree, (n) => n.props['data-dsh-bots-usage-bots'])[0];
    assert.match(collect(bots.children[0]).join(' '), /Bot Runs Tokens Cost/);
    const [row] = findAll(v.tree, (n) => n.props['data-dsh-bots-usage-ticket'] === 'tquestion');
    assert.match(collect(row).join(' '), /Which logo do you prefer\? Needs your answer Bob 2 15K \$0\.025/);
    // A run that belongs to a task links to it; a task row opens it.
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-usage-run-task'] === 'tworking1').length, 1);
    row.props.onClick();
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ticket'] === 'tquestion').length, 1);
    v.hooks.runCleanups();
  } finally {
    delete USAGE.tickets;
    delete USAGE.tasks[1].ticket;
  }
  // zh: runs are 回合, by task is 按任务.
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const zh = seen.locale.dict.zh;
  assert.equal(zh.tileRuns, '回合');
  assert.equal(zh.recentRuns, '最近的回合');
  assert.equal(zh.byTask, '按任务');
  assert.equal(zh.tasks, '任务');
});

test('chat: a delegation shows as a task card that opens the detail; a report shows its status', async () => {
  await withFixtures(() => {
    MESSAGES.push(
      { id: 'm6', from: 'bot-a', to: 'bot-b', text: 'Draw two logos and ask Kada', at: Date.now() - 4_000, kind: 'dm', ticket: 'tquestion' },
      { id: 'm7', from: 'bot-b', to: 'bot-a', text: 'Blue or green?', at: Date.now() - 2_000, kind: 'dm', ticket: 'tquestion', status: 'question' },
    );
  }, async () => {
    const v = await openTab('chat', 'bot-a');
    await v.rerender();
    const [card] = findAll(v.tree, (n) => n.props['data-dsh-bots-task-card'] === 'tquestion');
    assert.ok(card, 'the delegation is a task card');
    const words = collect(card).join(' ');
    assert.match(words, /Which logo do you prefer\?/, 'the title from the Host');
    assert.match(words, /Task · Bob/);
    assert.match(words, /Needs your answer/);
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-report']).map((n) => n.props['data-dsh-bots-report']), ['question']);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-task-card']).length, 1, 'a report is not a second card');
    card.props.onClick({ stopPropagation() {} });
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ticket'] === 'tquestion').length, 1);
    // The activity view marks the same two messages.
    click(v.tree, 'data-dsh-bots-activity');
    await v.rerender();
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-event-task']).map((n) => n.props['data-dsh-bots-event-task']), ['tquestion', 'tquestion']);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-report'] === 'question').length, 1);
    v.hooks.runCleanups();
  });
});

test('the conversation: bot_send_message shows the task it opened, a report its status; a task conversation’s badge opens the task', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  mockFetch();
  const view = seen.slots.find((s) => s.options.name === 'tool.call.toolview' && s.options.key === 'bot_send_message').component;
  const meta = { to: { id: 'bot-b', name: 'Bob', handle: 'bob', avatar: BOTS[1].avatar }, from: { id: 'bot-a', name: 'Ada', handle: 'ada', avatar: BOTS[0].avatar }, ticket: { id: 'tqueued01', title: 'Translate the docs' }, stage: 'queued' };
  hooks.reset();
  let tree = view({ phase: 'result', block: { callId: 'c2', call: { argsRaw: '{"to":"@bob","text":"Translate the docs into German"}' }, content: [{ type: 'text', text: 'Task tqueued01 opened' }], isError: false, meta } });
  const [card] = findAll(tree, (n) => n.props['data-dsh-bots-task-card'] === 'tqueued01');
  assert.match(collect(card).join(' '), /Translate the docs .*Task · Bob .*Queued/);
  card.props.onClick({ stopPropagation() {} });
  assert.deepEqual(seen.selected, ['bots'], 'it opens the panel on the task');
  hooks.reset();
  tree = view({ phase: 'result', block: { callId: 'c3', call: { argsRaw: '{"status":"done","text":"All translated."}' }, content: [], isError: false, meta: { from: meta.to, ticket: 'tqueued01' } } });
  assert.match(collect(tree).join(' '), /Report/);
  assert.deepEqual(findAll(tree, (n) => n.props['data-dsh-bots-report']).map((n) => n.props['data-dsh-bots-report']), ['done']);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-task-card']).length, 0);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-report-task'] === 'tqueued01').length, 1);

  const badge = seen.slots.find((s) => s.options.name === 'conversation.session.header.utilities').component;
  hooks.reset();
  badge({ sessionId: 'ticket-tquestion' });
  await flush();
  await flush();
  hooks.rewind();
  const b = badge({ sessionId: 'ticket-tquestion' });
  assert.equal(b.props['data-dsh-bots-badge'], 'bot-b', 'the bot from the task when the session map lacks it');
  assert.equal(b.props['data-dsh-bots-badge-task'], 'tquestion');
  assert.match(b.props.title, /A task of Bob: Which logo do you prefer\?/);
  b.props.onClick();
  assert.deepEqual(seen.selected, ['bots', 'bots']);
  hooks.runCleanups();
});

// --- what the Host emits since the Thread routing (PLAN-0.8 §13) -------------------------------

test('router mode waits for a teammate: one line under How it works, and no router-only tools or notice while the dispatcher is alone', async () => {
  await withTaskState({ state: { routerActive: false, routerNoticePending: true }, bots: [{ tools: { deny: [] } }] }, async () => {
    const v = await openTab('profile', 'bot-a');
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-dispatcher-modes'])[0].props['data-dsh-bots-dispatcher-modes'], 'router', 'the setting still reads router');
    const [waiting] = findAll(v.tree, (n) => n.props['data-dsh-bots-router-waiting']);
    assert.ok(waiting);
    assert.equal(collect(waiting).join(''), 'Router mode starts once the team has another bot; until then Ada does the work itself.');
    // Alone, it keeps every tool: nothing is marked off for a router, and no light-model hint.
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-off'] || n.props['data-dsh-bots-router-allowed'] || n.props['data-dsh-bots-router-tool']).length, 0);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ability'] === 'code')[0].props['data-on'], true);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-model-hint']).length, 0);
    assert.doesNotMatch(collect(v.tree).join(' '), /In Router mode it does not run commands/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-notice']).length, 0, 'the notice waits until it applies');
    // Hands-on has nothing to wait for.
    click(v.tree, 'data-dsh-bots-dispatcher-mode', 'hands-on');
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-waiting']).length, 0);
    v.hooks.runCleanups();
  });
  // With a teammate it routes: no line, the router's view of its tools, and the notice.
  await withTaskState({ state: { routerActive: true, routerNoticePending: true }, bots: [{ tools: { deny: [] } }] }, async () => {
    const v = await openTab('profile', 'bot-a');
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-waiting']).length, 0);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-model-hint']).length, 1);
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-router-off']).map((n) => n.props['data-dsh-bots-router-off']), ['code']);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-notice']).length, 1);
    v.hooks.runCleanups();
  });
});

const TG1 = 'telegram:bot-a/tg1:42';
const TG2 = 'telegram:bot-a/tg1:77';
const SL = 'slack:bot-a/sl1:C042:1700000000.0001';
const DC = 'discord:bot-a/dc1:998877';

test('chat: with several chats in a turn, the plain reply says it reached none of them and each bot_reply names its chat', async () => {
  const now = Date.now();
  await withFixtures(() => {
    MESSAGES.push(
      { id: 'm10', from: 'user', to: 'bot-a', text: 'Book the flights', at: now - 9_000, kind: 'user', via: 'telegram', who: 'Kada', thread: TG1 },
      { id: 'm11', from: 'user', to: 'bot-a', text: 'Book the hotel', at: now - 8_500, kind: 'user', via: 'telegram', who: 'Lin', thread: TG2 },
      { id: 'm12', from: 'user', to: 'bot-a', text: 'And the car', at: now - 8_000, kind: 'user', via: 'slack', who: 'Bob', thread: SL },
      { id: 'm13', from: 'bot-a', to: 'user', text: 'All three are on their way.', at: now - 7_000, kind: 'reply', thread: 'panel:sess-a', notSent: true, choices: [TG1, TG2, SL, DC] },
      { id: 'm14', from: 'bot-a', to: 'user', text: 'Flights booked.', at: now - 6_000, kind: 'reply', via: 'telegram', thread: TG1 },
      { id: 'm15', from: 'bot-a', to: 'user', text: 'Hotel booked.', at: now - 5_500, kind: 'reply', via: 'telegram', thread: TG2 },
      { id: 'm16', from: 'bot-a', to: 'user', text: 'Car booked.', at: now - 5_000, kind: 'reply', via: 'slack', thread: SL },
    );
  }, async () => {
    const v = await openTab('chat', 'bot-a');
    // Two chats of the same app keep their own headers, so every answer shows where it went.
    const marks = findAll(v.tree, (n) => n.props['data-dsh-bots-via']).map((n) => collect(n).join(''));
    assert.deepEqual(marks, ['Telegram · Kada', 'Telegram · Lin', 'Slack · Bob', '→ Telegram · Kada', '→ Telegram · Lin', '→ Slack · Bob · thread']);
    const notSent = findAll(v.tree, (n) => n.props['data-dsh-bots-not-sent']);
    assert.equal(notSent.length, 1);
    // A chat nobody in the timeline wrote from reads by its id.
    assert.equal(collect(notSent[0]).join(''), 'Not sent to any chat: this turn involved several (Telegram · Kada, Telegram · Lin, Slack · Bob · thread, Discord · 998877).');
    // The activity view marks the same.
    click(v.tree, 'data-dsh-bots-activity');
    await v.rerender();
    const [badge] = findAll(v.tree, (n) => n.props['data-dsh-bots-not-sent']);
    assert.equal(collect(badge).join(''), 'Not sent');
    assert.equal(badge.props.title, 'Telegram · Kada, Telegram · Lin, Slack · Bob · thread, Discord · 998877');
    const sent = findAll(v.tree, (n) => n.props['data-dsh-bots-event'] === 'reply' && findAll(n, (x) => x.props['data-dsh-bots-via']).length).map((n) => collect(findAll(n, (x) => x.props['data-dsh-bots-via'])[0]).join(''));
    assert.deepEqual(sent, ['Slack · Bob · thread', 'Telegram · Lin', 'Telegram · Kada']);
    v.hooks.runCleanups();
  });
});

test('chat: a follow-up that went straight to a task links to it; a stuck or failed notice shows the task’s stage', async () => {
  const now = Date.now();
  await withFixtures(() => {
    MESSAGES.push(
      { id: 'm20', from: 'user', to: 'bot-b', text: 'Green, please', at: now - 6_000, kind: 'user', via: 'telegram', who: 'Kada', thread: TG1, ticket: 'tquestion' },
      { id: 'm21', from: 'bot-b', to: 'bot-a', text: 'Task tworking1 stalled: no report after a status check.', at: now - 4_000, kind: 'dm', ticket: 'tworking1', status: 'stalled' },
      { id: 'm22', from: 'bot-b', to: 'bot-a', text: 'Task tfailed01 failed: Connection refused (3 tries).', at: now - 3_000, kind: 'dm', ticket: 'tfailed01', status: 'failed' },
      // A task you asked for yourself: the notice is to you.
      { id: 'm23', from: 'bot-c', to: 'user', text: 'Task tstalled1 stalled: no report after a status check.', at: now - 2_000, kind: 'dm', ticket: 'tstalled1', status: 'stalled' },
    );
  }, async () => {
    const v = await openTab('chat', 'bot-b');
    await v.rerender();
    const [link] = findAll(v.tree, (n) => n.props['data-dsh-bots-report-task'] === 'tquestion');
    assert.equal(collect(link).join(''), 'Went to its task');
    assert.match(link.props.title, /goes straight to that task/);
    // Notices: the stage of a task and a link to it, not a delegation card or a report.
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-stage']).map((n) => [n.props['data-dsh-bots-stage'], collect(n).join('')]), [['stalled', 'Stuck'], ['failed', 'Failed'], ['stalled', 'Stuck']]);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-task-card']).length, 0);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-report']).length, 0);
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-report-task']).map((n) => n.props['data-dsh-bots-report-task']), ['tquestion', 'tworking1', 'tfailed01', 'tstalled1']);
    link.props.onClick();
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ticket'] === 'tquestion').length, 1);
    // The activity view shows the stages too.
    click(v.tree, 'data-dsh-bots-activity');
    await v.rerender();
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-stage']).map((n) => n.props['data-dsh-bots-stage']), ['stalled', 'failed', 'stalled']);
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-event-task']).map((n) => n.props['data-dsh-bots-event-task']), ['tstalled1', 'tfailed01', 'tworking1', 'tquestion']);
    v.hooks.runCleanups();
  });
});

test('task words: every stage, report status and action has English and Chinese', async () => {
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const { en, zh } = seen.locale.dict;
  const keys = [
    ...['question', 'failed', 'stalled', 'queued', 'working', 'done', 'stopped'].map((s) => `stage_${s}`),
    ...['progress', 'done', 'blocked', 'question'].map((s) => `report_${s}`),
    ...['stop', 'retry', 'close'].map((a) => `taskDid_${a}`),
    'kind_report',
    ...['notSent', 'notSentChats', 'threadPart', 'threadTopic', 'followUpTask', 'followUpHint', 'routerWaiting'],
  ];
  for (const k of keys) {
    assert.ok(en[k], `en ${k}`);
    assert.ok(zh[k] && zh[k] !== en[k], `zh ${k}`);
  }
  // The screen says task, never ticket.
  for (const [k, v] of Object.entries(en)) assert.doesNotMatch(String(v), /ticket/i, k);
  for (const [k, v] of Object.entries(zh)) assert.doesNotMatch(String(v), /ticket|工单/i, k);
});

// --- questions a bot asks (ask_user_question) -------------------------------------------------------

const DB_ASK = { id: 'ask-1', botId: 'bot-a', sessionId: 'sess-a', at: Date.now(), questions: [{ id: 'db', question: 'Which database?', header: 'Storage', detail: 'For the launch site.', options: [{ label: 'Postgres', description: 'A server.' }, { label: 'SQLite' }] }] };
/** The panel with some questions waiting (state `asks`), and what it posted; `answer` replies to the answer route. */
async function withAsks({ asks, rows = {}, answer = () => ({ ok: true }) }, fn) {
  const saved = { asks: STATE.asks, asking: BOTS.map((b) => b.asking), rows: TICKETS.map((r) => r.asking) };
  STATE.asks = asks;
  BOTS.forEach((b) => (b.asking = asks.filter((a) => a.botId === b.id && !a.ticketId).length));
  TICKETS.forEach((r) => (r.asking = rows[r.id]));
  try {
    const { exports, hooks } = await loadClient();
    const { ctx, seen } = fakeContext();
    exports.apply(ctx);
    const posts = mockFetch();
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => (/\/asks\/[^/]+\/answer$/.test(String(url)) ? (posts.push({ path: String(url), body: JSON.parse(init.body) }), { ok: true, json: async () => answer() }) : inner(url, init));
    const panel = seen.slots.find((s) => s.options.name === 'main').component;
    const v = { hooks, posts, seen, tree: await renderSettled(panel, {}, hooks) };
    v.rerender = async (n = 3) => {
      for (let i = 0; i < n; i += 1) {
        hooks.rewind();
        v.tree = panel({});
        await flush();
      }
      hooks.rewind();
      v.tree = panel({});
      return v.tree;
    };
    await fn(v);
    hooks.runCleanups();
  } finally {
    STATE.asks = saved.asks;
    if (saved.asks === undefined) delete STATE.asks;
    BOTS.forEach((b, i) => (saved.asking[i] === undefined ? delete b.asking : (b.asking = saved.asking[i])));
    TICKETS.forEach((r, i) => (saved.rows[i] === undefined ? delete r.asking : (r.asking = saved.rows[i])));
  }
}
const askCard = (tree, id) => findAll(tree, (n) => n.props['data-dsh-bots-ask'] === id)[0];
const askOption = (tree, label) => findAll(tree, (n) => n.props['data-dsh-bots-ask-option'] === label)[0];

test('questions: the bot\'s chat shows its question, one click answers it, and it leaves with the next state', async () => {
  await withAsks({ asks: [DB_ASK] }, async (v) => {
    const [badge] = findAll(v.tree, (n) => n.props['data-dsh-bots-row-asking'] !== undefined);
    assert.equal(badge.props['data-dsh-bots-row-asking'], 1);
    assert.equal(badge.props['aria-label'], '1 waiting for your answer');
    const card = askCard(v.tree, 'ask-1');
    const text = collect(card).join(' ');
    for (const s of ['Ada is asking you', 'Storage', 'Which database?', 'For the launch site.', 'Postgres', 'A server.', 'SQLite']) assert.ok(text.includes(s), s);
    assert.equal(findAll(card, (n) => n.props['data-dsh-bots-ask-submit']).length, 0, 'one single choice needs no Submit');
    assert.equal(askOption(card, 'SQLite').props.role, undefined);
    askOption(v.tree, 'Postgres').props.onClick();
    await v.rerender(0);
    assert.equal(askOption(v.tree, 'Postgres').props.disabled, true, 'disabled while posting');
    delete STATE.asks;
    await v.rerender();
    assert.deepEqual(v.posts.filter((p) => p.path.includes('/asks/')), [{ path: '/__dsh_bots/asks/ask-1/answer', body: { answers: [{ id: 'db', selected: ['Postgres'] }] } }]);
    assert.equal(askCard(v.tree, 'ask-1'), undefined, 'answered: gone');
  });
  // Your own words go as `custom`; a refusal shows its reason and the card stays.
  await withAsks({ asks: [DB_ASK], answer: () => ({ ok: false, reason: 'the question is no longer waiting for an answer' }) }, async (v) => {
    const [other] = findAll(v.tree, (n) => n.props['data-dsh-bots-ask-other'] === 'db');
    assert.equal(other.props.placeholder, 'Or type your own answer');
    other.props.onChange({ target: { value: ' DuckDB ' } });
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-ask-send'] === 'db')[0].props.onClick();
    await v.rerender();
    assert.deepEqual(v.posts.at(-1).body, { answers: [{ id: 'db', selected: [], custom: 'DuckDB' }] });
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-ask-error'])[0]).join(''), /no longer waiting/);
    assert.ok(askCard(v.tree, 'ask-1'));
  });
});

test('questions: a task\'s question puts it under Needs you; several questions are ticked and submitted; an approval opens the conversation', async () => {
  const taskAsk = { id: 'ask-2', botId: 'bot-b', sessionId: 'ticket-tworking1', ticketId: 'tworking1', at: Date.now(), continued: true, questions: [{ id: 'tools', question: 'Which checks?', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Test' }] }, { id: 'name', question: 'Name the release?' }] };
  const approval = { id: 'ask-3', botId: 'bot-a', sessionId: 'sess-a', at: Date.now(), native: true, questions: [{ id: 'perm', question: 'Allow rm -rf build?' }] };
  await withAsks({ asks: [taskAsk, approval], rows: { tworking1: true } }, async (v) => {
    // The home's approval: answered in the conversation.
    const native = askCard(v.tree, 'ask-3');
    assert.match(collect(native).join(' '), /Ada is waiting for you in the conversation .*Allow rm -rf build\? .*Answer this one in the conversation\./);
    assert.equal(findAll(native, (n) => n.props['data-dsh-bots-ask-option'] !== undefined || n.props['data-dsh-bots-ask-other'] !== undefined).length, 0);
    click(v.tree, 'data-dsh-bots-ask-open', 'sess-a');
    assert.deepEqual(v.seen.opened, ['sess-a']);
    assert.equal(askCard(v.tree, 'ask-2'), undefined, 'a task\'s question is not in the home chat');
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-row-asking'] !== undefined).map((n) => n.props['data-dsh-bots-row-asking']), [1], 'only Ada\'s row: Bob\'s question is a task\'s');
    // The task needs you, and says why.
    click(v.tree, 'data-dsh-bots-tasks-entry');
    await v.rerender();
    const needs = findAll(v.tree, (n) => n.props['data-dsh-bots-task-group'] === 'needs')[0];
    assert.ok(findAll(needs, (n) => n.props['data-dsh-bots-task'] === 'tworking1').length === 1);
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-task-asking'] === 'tworking1')[0]).join(''), /Asks you/);
    click(v.tree, 'data-dsh-bots-task', 'tworking1');
    await v.rerender();
    const card = askCard(v.tree, 'ask-2');
    assert.match(collect(card).join(' '), /Bob is asking you .*Choose all that apply/);
    assert.match(collect(card).join(' '), /Bob went on with other work; your answer still reaches it\./);
    const submit = () => findAll(v.tree, (n) => n.props['data-dsh-bots-ask-submit'] === 'ask-2')[0];
    assert.equal(submit().props.disabled, true, 'every question needs an answer');
    assert.equal(askOption(v.tree, 'Lint').props.role, 'checkbox');
    askOption(v.tree, 'Lint').props.onClick();
    await v.rerender(1);
    askOption(v.tree, 'Test').props.onClick();
    await v.rerender(1);
    assert.equal(askOption(v.tree, 'Test').props['aria-checked'], true);
    const [free] = findAll(v.tree, (n) => n.props['data-dsh-bots-ask-other'] === 'name');
    assert.equal(free.props.placeholder, 'Type your answer');
    free.props.onChange({ target: { value: 'Apollo' } });
    await v.rerender(1);
    assert.equal(submit().props.disabled, false);
    submit().props.onClick();
    await v.rerender();
    assert.deepEqual(v.posts.filter((p) => p.path.includes('/asks/')), [{ path: '/__dsh_bots/asks/ask-2/answer', body: { answers: [{ id: 'tools', selected: ['Lint', 'Test'] }, { id: 'name', selected: [], custom: 'Apollo' }] } }]);
  });
});
