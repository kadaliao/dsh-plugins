/**
 * Host half of the bots bundle: Grok-style bots inside DeepSeek Harness.
 *
 * A bot is a named persona with its own conversation (a DSH Session), avatar,
 * skills, tool access, apps (MCP servers, e.g. open-computer-use) and scheduled
 * tasks. Bots message each other: `bot_send_message` drops the text into the
 * other bot's inbox, which wakes it; the reply travels back the same way. One
 * bot is the dispatcher that delegates work and schedules tasks.
 *
 * Everything a bot is made of is applied to its Agent's own scope when that
 * Agent comes up (and re-applied when the bot changes): a persona prompt
 * section, runtime skills, a tool restriction and agent-scoped MCP clients.
 * Nothing touches other conversations, except the bot tools themselves, which
 * every conversation gets so the user can manage bots from anywhere.
 *
 * Chat channel apps (Telegram, Discord, Feishu / Lark, Slack) are no MCP servers: lib/channels.mjs
 * keeps a connector running for each, so paired people can message the team
 * from that chat app and read the replies there.
 *
 * @module @kadaliao/dsh-bots
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createStore, initialsOf, slugify, SKILL_RE, PALETTE, MAX_SKILLS, MAX_SKILLS_ON } from './lib/store.mjs';
import { catalog as appCatalog, CATEGORIES, mcpConfigFor } from './lib/apps.mjs';
import { ABILITIES } from './lib/abilities.mjs';
import { SKILL_SOURCES, importGithubSkill, importUrlSkill, linkLocalSkill, listGithubSkills, listLocalSkills, mergeImported, parseGithub, readLinkedSkill, resolveLocalPath } from './lib/skills.mjs';
import { TEAMS, teamTiming, teamView } from './lib/teams.mjs';
import { maskedApp, scanExternalMcp } from './lib/mcp-import.mjs';
import { createUnfurler } from './lib/unfurl.mjs';
import { isLogoName, withLogo } from './lib/logos.mjs';
import { CHANNEL_LABELS, channelEntry, channelIssue, createChannels, maskBot, unmaskApps } from './lib/channels.mjs';
import { describeTiming, dmBody, dmHeader, personaText, textOf, timingFrom, timingOfEntry } from './lib/prompt.mjs';
import { createSettings } from './lib/settings.mjs';
import { createPriceCatalog, priceOf } from './lib/prices.mjs';
import { createLedger, promptTokens, report, todayByBot, usageRow } from './lib/usage.mjs';
import { createMemory, dreamBotPrompt, dreamTeamPrompt, KINDS as MEMORY_KINDS, looksSecret, parseJsonReply, reflectionPrompt } from './lib/memory.mjs';
import { createTopics, rotationReason } from './lib/topics.mjs';
import { API_KINDS, CODEX_ROUTE, PI_SCOPE, ROUTE_PREFIX, codexAuthFile, createCodexSync, detectLogins, discoverModels, endpointView, keyRefFor, profileFor, readCodexAuth, codexCredential } from './lib/models.mjs';

/**
 * Import one Harness package: by bare name when this directory resolves it,
 * else from the running Harness's own module tree (a linked working copy sits
 * outside it), else undefined.
 */
async function harnessModule(name) {
  try {
    return await import(name);
  } catch {
    // Not reachable from here; ask the Harness entry below.
  }
  try {
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    for (const entry of [process.argv[1], ...process.argv.slice(2).filter((a) => a.endsWith('.js'))]) {
      if (!entry) continue;
      try {
        return await import(pathToFileURL(createRequire(entry).resolve(name)).href);
      } catch {
        // The next candidate.
      }
    }
  } catch {
    // No module system to ask.
  }
  return undefined;
}

const toolsModule = await harnessModule('@deepseek-ai/dsh-tools');
const llmModule = await harnessModule('@deepseek-ai/dsh-llm');
/** The MCP client plugin, mounted per bot for its apps; absent outside a Harness. */
const mcpClient = (await harnessModule('@deepseek-ai/dsh-mcp-client')) ?? null;
const scopeOf = (await harnessModule('@deepseek-ai/dsh-scope'))?.scopeOf ?? (() => undefined);
// The registry wants the compiled definition; outside a Harness the raw one stands in.
const defineTool = toolsModule?.defineTool ?? ((definition) => definition);
const createUserMessage = llmModule?.createUserMessage ?? ((input) => Object.freeze({ ...structuredClone(input), role: 'user', id: randomUUID() }));

export const inject = ['tools'];
export const name = 'bots';

const R = '/__dsh_bots';
const OCU_PATHS = [join(homedir(), '.local', 'share', 'ocu', 'ocu'), join(homedir(), '.local', 'bin', 'ocu')];
/** DMs one pair of bots may exchange within the window before the next is refused. */
const PAIR_LIMIT = 16;
const PAIR_WINDOW_MS = 10 * 60_000;
const PERSONA_SECTION = 'bots:persona';
const PERSONA_ORDER = 50;
const MAX_AVATAR = 2 * 1024 * 1024;
/** Tries one avatar gets when the image service fails in a way that may pass. */
const AVATAR_ATTEMPTS = 3;
/** Errors from a gateway or the network rather than from the request itself. */
export const TRANSIENT = /\b(408|409|429|500|502|503|504|520|522|524)\b|connection (lost|reset|closed)|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|could not reach|did not answer within|overloaded|temporarily/i;

export const TOOL_NAMES = ['bot_list', 'bot_create', 'bot_update', 'bot_delete', 'bot_send_message', 'bot_schedule', 'memory_save', 'memory_forget', 'memory_search'];
const MEMORY_SECTION = 'bots:memory';
const MEMORY_ORDER = 60;
/** How often idle conversations are checked for a new topic, and the daily consolidation for being due. */
const SWEEP_MS = 5 * 60_000;
/** One transcript line a task keeps for its summary, and the whole transcript. */
const LOG_LINE = 1500;
const LOG_MAX = 40_000;
const DAY_MS = 86_400_000;
/** How long a new topic waits for the last task's memory summary. */
const REFLECT_WAIT_MS = 20_000;
/** The local zone's offset east of UTC, in minutes. */
const tzMinutes = () => -new Date().getTimezoneOffset();

function homeDir() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
}

export function ocuPath() {
  return OCU_PATHS.find((p) => existsSync(p)) ?? '';
}

/** The app catalog the Apps tab offers, with the open-computer-use path in force. */
export function templates() {
  return appCatalog(ocuPath()).map(withLogo);
}

/**
 * The mcp-client row of one app of `bot`. Throws APP_INCOMPLETE when a required
 * field is empty; null for a chat channel app, which is no MCP server.
 */
export function mcpConfigOf(app, bot) {
  return mcpConfigFor(app, templates(), { bot: bot?.handle ?? 'bot' });
}

const OCU_REPO = 'kadaliao/open-computer-use';

/**
 * Install the latest open-computer-use release: download its macOS tarball,
 * unpack it and run its own install.sh (→ ~/.local/share/ocu, ~/.local/bin/ocu).
 * @returns {{version: string, path: string, log: string}}
 */
export async function installOcu({ signal, fetchImpl = fetch } = {}) {
  if (process.platform !== 'darwin') throw new Error('Open Computer Use runs on macOS only');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFile } = await import('node:child_process');
  const run = (cmd, args, opts = {}) =>
    new Promise((resolve, reject) =>
      execFile(cmd, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...opts }, (error, stdout, stderr) =>
        error ? reject(new Error(`${cmd} failed: ${String(stderr || error.message).trim().slice(0, 400)}`)) : resolve(String(stdout)),
      ),
    );
  const res = await fetchImpl(`https://api.github.com/repos/${OCU_REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-bots' }, signal });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest release`);
  const release = await res.json();
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const asset = (release.assets ?? []).find((a) => /macos/i.test(a.name) && a.name.includes(arch) && a.name.endsWith('.tar.gz'));
  if (!asset) throw new Error(`release ${release.tag_name} has no macOS ${arch} build`);
  const bin = await fetchImpl(asset.browser_download_url, { signal, redirect: 'follow' });
  if (!bin.ok) throw new Error(`download failed (${bin.status})`);
  const work = mkdtempSync(join(tmpdir(), 'dsh-bots-ocu-'));
  try {
    const tgz = join(work, asset.name);
    writeFileSync(tgz, Buffer.from(await bin.arrayBuffer()));
    await run('tar', ['xzf', tgz, '-C', work]);
    const dirName = asset.name.replace(/\.tar\.gz$/, '');
    const script = join(work, dirName, 'install.sh');
    if (!existsSync(script)) throw new Error('the release has no install.sh');
    const log = await run('/bin/sh', [script], { cwd: join(work, dirName) });
    const path = ocuPath();
    if (!path) throw new Error('install.sh finished but ~/.local/share/ocu/ocu is missing');
    return { version: release.tag_name, path, log };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** What the page and tool cards show of a bot. */
function face(bot) {
  return bot ? { id: bot.id, name: bot.name, handle: bot.handle, avatar: bot.avatar, role: bot.role } : null;
}

const service = (ctx, name) => {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
};

/**
 * @param {object} ctx
 * @param {object} config
 * @param {{loadConnector?: (kind: string) => Promise<object>, typingEveryMs?: number}} [deps] - for tests: a stand-in chat connector.
 */
export function apply(ctx, config, deps = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const dir = join(homeDir(), 'cache', 'bots');
  const store = createStore(dir);
  const settings = createSettings(dir);
  const ledger = createLedger(dir);
  const memory = createMemory(join(dir, 'memory'));
  const topics = createTopics(dir);
  const prices = createPriceCatalog(dir, { enabled: deps.prices !== false, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const home = deps.home ?? homedir();
  const workdir = typeof cfg.workdir === 'string' && cfg.workdir.trim() ? cfg.workdir.trim() : join(homeDir(), 'bots', 'workspace');
  const zone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  })();

  // --- seeding: a dispatcher on the very first run ---------------------------------
  const seededFile = join(dir, 'seeded');
  const zh = /^zh/i.test(String(cfg.language ?? '') || Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || '');
  if (store.list().length === 0 && !existsSync(seededFile)) {
    try {
      store.save({
        name: 'Atlas',
        handle: 'atlas',
        role: 'primary',
        avatar: { kind: 'initials', color: '#7c5cff' },
        bio: zh ? '调度员：拆解需求，分派给合适的 bot，并安排定时任务。 / Dispatcher: plans, delegates, schedules.' : 'Dispatcher: plans the work, hands it to the right bot, and keeps the schedule. / 调度员：拆解、分派、排期。',
        persona: zh
          ? '你沉稳、有条理、说话简洁。你把模糊的需求变成清楚的计划，交给合适的专家 bot，跟进进度，最后用简短的总结向用户汇报。默认用用户使用的语言回答。'
          : 'Calm, organised and brief. You turn vague requests into clear plans, delegate to specialists, follow up, and report back with a short summary. Answer in the language the user writes in.',
      });
      mkdirSync(dir, { recursive: true });
      writeFileSync(seededFile, String(Date.now()));
    } catch (error) {
      ctx.logger?.warn?.(`bots: could not seed the dispatcher: ${error?.message ?? error}`);
    }
  }

  // --- applying a bot to its Agent ----------------------------------------------------
  /** sessionId → {agent, signature, disposers[]} */
  const installed = new Map();

  const isChannel = (app) => Boolean(channelEntry(app, templates()));
  // Chat channels run outside the Agent; changing one does not restart the bot's MCP clients.
  // A linked local skill counts by what its SKILL.md is now, so an edit there re-installs it.
  const signatureOf = (bot) => JSON.stringify({ s: bot.skills, l: bot.skills.filter((s) => s.linked && s.enabled).map((s) => readLinkedSkill(s.dir)?.stamp ?? ''), a: bot.apps.filter((a) => !isChannel(a)), t: bot.tools, h: bot.handle });
  /** The chat apps the team can be reached from ('Telegram'), for the persona. */
  const channelNames = (bots) => {
    const tpl = templates();
    return [...new Set(bots.flatMap((b) => b.apps.filter((a) => a.enabled && channelEntry(a, tpl)).map((a) => CHANNEL_LABELS[channelEntry(a, tpl).channel] ?? channelEntry(a, tpl).name.en)))];
  };

  function uninstall(sessionId) {
    const rec = installed.get(sessionId);
    if (!rec) return;
    installed.delete(sessionId);
    for (const dispose of rec.disposers.reverse()) {
      try {
        const r = dispose();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {
        // Already gone with the Agent.
      }
    }
  }

  function install(agent, bot) {
    const actx = agent.ctx;
    const disposers = [];
    const skillNames = {};
    const skills = service(actx, 'skills');
    let skillsInline = false;
    const enabledSkills = bot.skills.filter((s) => s.enabled);
    // A Harness skill is already in every conversation's catalog under its own name;
    // the persona points the bot at it. Own and imported skills are registered here,
    // for this conversation only, under a name prefixed with the bot's handle.
    for (const s of enabledSkills) if (s.source === 'dsh') skillNames[s.id] = s.name;
    const local = enabledSkills.filter((s) => s.source !== 'dsh');
    if (local.length > 0) {
      if (skills && typeof skills.register === 'function') {
        for (const stored of local) {
          // A linked folder speaks for itself; what was stored when it was linked stands in if it is gone.
          const live = stored.linked ? readLinkedSkill(stored.dir) : null;
          if (stored.linked && !live) ctx.logger?.warn?.(`bots: skill folder ${stored.dir} of @${bot.handle} is gone; using what was read when it was linked`);
          const s = live ? { ...stored, description: live.description || stored.description, content: live.content } : stored;
          let n = slugify(s.name, 'skill');
          if (!SKILL_RE.test(n)) n = `skill-${s.id.slice(-5)}`;
          n = `${bot.handle}-${n}`.slice(0, 64).replace(/-+$/, '');
          skillNames[s.id] = n;
          try {
            disposers.push(
              skills.register({
                name: n,
                description: s.description || s.name,
                content: s.content || s.description || s.name,
                source: 'bots',
                invocation: { modelInvocable: true, userInvocable: true },
                ...(s.dir && existsSync(s.dir) ? { resourceBase: { kind: 'directory', path: s.dir } } : {}),
              }),
            );
          } catch (error) {
            ctx.logger?.warn?.(`bots: skill ${n} for @${bot.handle}: ${error?.message ?? error}`);
          }
        }
      } else skillsInline = true;
    }
    const apps = bot.apps.filter((a) => a.enabled && !isChannel(a));
    const appNames = [];
    if (apps.length > 0 && mcpClient && typeof actx.plugin === 'function') {
      for (const app of apps) {
        try {
          const fiber = actx.plugin(mcpClient, mcpConfigOf(app, bot));
          appNames.push(app.serverName);
          disposers.push(() => fiber?.dispose?.());
          Promise.resolve(fiber).catch((error) => ctx.logger?.warn?.(`bots: app ${app.serverName} for @${bot.handle}: ${error?.message ?? error}`));
        } catch (error) {
          // An app missing a required key stays off for this run; the panel says what it needs.
          ctx.logger?.warn?.(`bots: app ${app.serverName} for @${bot.handle}: ${error?.message ?? error}`);
        }
      }
    }
    const prompts = service(actx, 'systemPrompt');
    if (prompts && typeof prompts.section === 'function') {
      try {
        disposers.push(
          prompts.section({
            name: PERSONA_SECTION,
            order: PERSONA_ORDER,
            interpolate: false,
            // Read on every assembly: a renamed teammate or edited persona applies at once.
            text: () => {
              const now = store.get(bot.id);
              const roster = store.list();
              return now ? personaText(now, roster, { skillsInline, skillNames, apps: appNames, channels: channelNames(roster) }) : '';
            },
          }),
        );
      } catch (error) {
        ctx.logger?.warn?.(`bots: persona for @${bot.handle}: ${error?.message ?? error}`);
      }
      try {
        // Memory is read once per task, not per step: a note saved mid-task must not break the prompt cache.
        disposers.push(prompts.section({ name: MEMORY_SECTION, order: MEMORY_ORDER, interpolate: false, text: () => memoryTextFor(agent.session.id) }));
      } catch (error) {
        ctx.logger?.warn?.(`bots: memory for @${bot.handle}: ${error?.message ?? error}`);
      }
    }
    if (bot.tools.deny.length > 0) {
      const tools = service(actx, 'tools');
      try {
        const view = ctx.tools?.view?.(scopeOf(actx));
        const known = view?.restrictableNames instanceof Set ? view.restrictableNames : new Set((ctx.tools?.definitions?.() ?? []).map((d) => d.name));
        const deny = bot.tools.deny.filter((n) => known.has(n) && n !== 'run_code');
        if (deny.length > 0 && tools?.restrict) disposers.push(tools.restrict({ deny }));
      } catch (error) {
        ctx.logger?.warn?.(`bots: tool access for @${bot.handle}: ${error?.message ?? error}`);
      }
    }
    installed.set(agent.session.id, { agent, signature: signatureOf(bot), disposers });
  }

  function reconcile(agent) {
    const sessionId = agent?.session?.id;
    if (!sessionId) return;
    const bot = store.bySession(sessionId);
    const rec = installed.get(sessionId);
    if (!bot) {
      if (rec) uninstall(sessionId);
      return;
    }
    if (rec && rec.agent === agent && rec.signature === signatureOf(bot)) return;
    if (rec) uninstall(sessionId);
    install(agent, bot);
  }

  const agents = () => {
    try {
      return ctx.get('agents');
    } catch {
      return undefined;
    }
  };
  ctx.inject?.(['agents'], (scope) => {
    scope.on('agent/created', ({ agent }) => reconcile(agent));
    scope.on('agent/disposed', (payload) => {
      const id = payload?.agent?.session?.id ?? payload?.agent?.id;
      if (id && installed.get(id)?.agent === payload?.agent) installed.delete(id);
    });
    for (const agent of scope.agents.list?.() ?? []) reconcile(agent);
  });
  ctx.effect(
    () =>
      store.onChange(() => {
        const live = agents();
        for (const bot of store.list()) {
          const agent = bot.sessionId ? live?.get?.(bot.sessionId) : undefined;
          if (agent) reconcile(agent);
        }
        for (const sessionId of [...installed.keys()]) if (!store.bySession(sessionId)) uninstall(sessionId);
      }),
    'bots: re-apply changed bots',
  );
  ctx.effect(() => () => {
    for (const id of [...installed.keys()]) uninstall(id);
  }, 'bots: unwind bot scopes');

  // --- sessions ---------------------------------------------------------------------
  async function workspaceId() {
    const reg = service(ctx, 'workspaceRegistry');
    if (!reg?.create) return undefined;
    mkdirSync(workdir, { recursive: true });
    const ws = await reg.create(workdir, 'Bots');
    return ws?.id;
  }

  /** The bot's home session, created on first need. Returns the session id. */
  async function ensureSession(bot) {
    const controller = service(ctx, 'sessionController');
    if (!controller) throw new Error('bot conversations need the Web profile (no session controller here)');
    const archived = service(ctx, 'workspaceRegistry')?.archivedSessionIds ?? [];
    if (bot.sessionId && !archived.includes(bot.sessionId)) {
      const found = await controller.resolveAgent(bot.sessionId).catch((error) => ({ error }));
      if (found && !('error' in found)) return bot.sessionId;
    }
    return createSession(bot);
  }

  /** A fresh home session for the bot (its next topic). Returns the session id. */
  async function createSession(bot) {
    const controller = service(ctx, 'sessionController');
    if (!controller) throw new Error('bot conversations need the Web profile (no session controller here)');
    const sessionId = `session-${randomUUID()}`;
    // Mapped before the Agent exists, so its creation already finds the bot.
    store.patch(bot.id, { sessionId });
    const wsId = await workspaceId().catch(() => undefined);
    try {
      const created = await controller.create({ sessionId, ...(wsId ? { workspaceId: wsId } : { cwd: workdir }) });
      if (created?.sessionId && created.sessionId !== sessionId) store.patch(bot.id, { sessionId: created.sessionId });
    } catch (error) {
      store.patch(bot.id, { sessionId: null });
      throw error;
    }
    const id = store.get(bot.id).sessionId;
    const agent = agents()?.get?.(id);
    if (agent) {
      reconcile(agent);
      try {
        service(ctx, 'sessionTitle')?.rename?.(agent.session, bot.name);
      } catch {
        // A title is cosmetic.
      }
      const fresh = store.get(bot.id) ?? bot;
      if (fresh.model) {
        try {
          agent.model?.select?.(selectionOf(fresh.model));
        } catch {
          // The default model stays.
        }
      }
    }
    return id;
  }

  async function agentOf(bot) {
    const id = await ensureSession(bot);
    const found = await service(ctx, 'sessionController').resolveAgent(id);
    if ('error' in found) throw found.error;
    return found.agent;
  }

  async function flush(agent) {
    try {
      await ctx.get('sessions')?.flush?.(agent.session);
    } catch {
      // Ordinary persistence follows.
    }
  }

  // --- models ----------------------------------------------------------------------------
  const selectionOf = (m) => ({ provider: m.provider, model: m.model, ...(m.reasoningEffort ? { reasoningEffort: m.reasoningEffort } : {}) });
  /** The model a bot runs on now: its own choice, its conversation's, else the Harness default. */
  function modelOfBot(bot) {
    if (bot?.model) return selectionOf(bot.model);
    const agent = bot?.sessionId ? agents()?.get?.(bot.sessionId) : undefined;
    try {
      const cur = agent?.model?.current?.();
      if (cur?.provider && cur?.model) return { provider: cur.provider, model: cur.model };
    } catch {
      // Not resolvable.
    }
    try {
      const def = service(ctx, 'agentDefaultModel')?.currentSelection?.();
      if (def?.provider && def?.model) return { provider: def.provider, model: def.model };
    } catch {
      // No default either.
    }
    return null;
  }
  /** The model memory work for `bot` runs on: the setting, else the bot's own. */
  const memoryModelOf = (bot) => settings.get().memory.model ?? modelOfBot(bot);

  /**
   * One model call outside any conversation (memory summaries): the text of the
   * answer and its token usage. `deps.complete` stands in for tests.
   */
  async function complete(sel, system, prompt, { purpose = 'bots-memory', sessionId, maxTokens = 2000, timeoutMs = 120_000 } = {}) {
    if (deps.complete) return deps.complete({ ...sel, system, prompt, purpose, maxTokens });
    const llm = service(ctx, 'llm');
    if (!llm?.stream) throw new Error('no model service in this Harness');
    const signal = AbortSignal.timeout(timeoutMs);
    const parts = new Map();
    let usage;
    let failure;
    for await (const c of llm.stream({ provider: sel.provider, model: sel.model, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens, purpose, signal, ...(sessionId ? { sessionId } : {}) })) {
      if (c?.type === 'text-delta') parts.set(c.index, (parts.get(c.index) ?? '') + c.text);
      else if (c?.type === 'usage') usage = c.usage;
      else if (c?.type === 'finish' && (c.reason?.kind === 'error' || c.reason?.kind === 'aborted')) failure = c.reason.failure?.message ?? c.reason.kind;
    }
    if (failure) throw new Error(String(failure));
    return { text: [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join(''), usage };
  }

  // --- tasks and usage ------------------------------------------------------------------------
  /** sessionId → the task the bot is on now. */
  const openTasks = new Map();
  /** schedule id → title, as last listed. */
  const scheduleTitles = new Map();
  /**
   * sessionId → the memory section text. It holds for the whole topic, so the system prompt (and the
   * provider's prompt cache over the conversation) stays the same from task to task; what the bot learns
   * within a topic is in that conversation already. It is read again at the next task after the user
   * edits memory in the panel or the daily consolidation ran, and at every new topic.
   */
  const memoText = new Map();
  const memoStale = new Set();
  /**
   * Memory changed outside the conversations (a panel edit, the nightly consolidation). An idle bot
   * reads it at its next task; a working one once its task is over. The Harness assembles a step's
   * prompt before it reports the step's message, so this never waits for a task to start.
   */
  const staleMemory = (only) => {
    for (const id of only ? [only].filter((x) => memoText.has(x)) : [...memoText.keys()]) {
      if (openTasks.has(id) || agents()?.get?.(id)?.status === 'running') memoStale.add(id);
      else memoText.delete(id);
    }
  };
  function memoryTextFor(sessionId) {
    let text = memoText.get(sessionId);
    if (text === undefined) {
      const bot = store.bySession(sessionId);
      try {
        text = bot ? memory.promptFor(bot, { tz: tzMinutes() }) : '';
      } catch {
        text = '';
      }
      memoText.set(sessionId, text);
    }
    return text;
  }
  const firstLine = (s, max = 100) => {
    const line = String(s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? '';
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  };
  /** What a task is about, from the message that started it. */
  function taskTitle(kind, content, said) {
    if (kind === 'agent-message') return firstLine(Array.isArray(content) && content[1]?.text ? content[1].text : said);
    if (kind === 'schedule') {
      const id = /schedule_id_json:\s*"([^"]+)"/.exec(said)?.[1] ?? /"schedule_id":\s*"([^"]+)"/.exec(said)?.[1];
      if (id && scheduleTitles.has(id)) return scheduleTitles.get(id);
      try {
        const p = /reminder_prompt_json:\s*(".*")\s*$/m.exec(said)?.[1];
        if (p) return firstLine(JSON.parse(p));
      } catch {
        // Fall through.
      }
    }
    return firstLine(said);
  }
  function startTask(bot, sessionId, kind, event, via) {
    const content = event.data?.content;
    const said = textOf(content);
    const sched = kind === 'schedule' ? (/schedule_id_json:\s*"([^"]+)"/.exec(said)?.[1] ?? /"schedule_id":\s*"([^"]+)"/.exec(said)?.[1] ?? '') : '';
    const from = kind === 'agent-message' ? (store.bySession(event.data?.source?.senderSessionId)?.id ?? 'user') : '';
    const task = {
      id: `task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      b: bot.id,
      s: sessionId,
      trigger: kind === 'schedule' ? 'schedule' : kind === 'agent-message' ? 'dm' : via ? 'chat' : 'user',
      ...(via ? { via: via.kind } : {}),
      ...(from ? { from } : {}),
      ...(sched ? { sched } : {}),
      title: taskTitle(kind, content, said) || '…',
      start: Number(event.time) || Date.now(),
      status: 'running',
      log: [],
      size: 0,
      replied: false,
    };
    openTasks.set(sessionId, task);
    topics.current(bot.id, sessionId);
    return task;
  }
  function logLine(task, line) {
    if (!task || !line) return;
    const s = line.length > LOG_LINE ? `${line.slice(0, LOG_LINE)}…` : line;
    task.log.push(s);
    task.size += s.length;
    // Keep the start and the latest; the middle of a long task matters least.
    while (task.size > LOG_MAX && task.log.length > 4) task.size -= task.log.splice(2, 1)[0].length;
  }
  function recordUsage(bot, sessionId, { at, kind, provider, model, usage }) {
    if (!usage) return;
    const task = openTasks.get(sessionId);
    ledger.record(usageRow({ at, botId: bot.id, sessionId, taskId: kind === 'chat' || kind === 'compaction' ? task?.id : undefined, kind, provider, model, usage }));
    if (kind === 'chat') topics.noteCall(bot.id, sessionId, promptTokens(usage));
  }
  /** The task of `sessionId` is over when its Agent is idle again. */
  function settleSoon(sessionId, delay = 1200) {
    const t = setTimeout(() => {
      const task = openTasks.get(sessionId);
      if (!task) return;
      const agent = agents()?.get?.(sessionId);
      if (agent && agent.status === 'running') return;
      finishTask(task);
    }, delay);
    t.unref?.();
  }
  function finishTask(task, status) {
    if (openTasks.get(task.s) !== task) return;
    openTasks.delete(task.s);
    if (memoStale.delete(task.s)) memoText.delete(task.s);
    const bot = store.get(task.b);
    const { log, size, replied, ...row } = task;
    row.end = Date.now();
    row.status = status ?? (task.status === 'running' ? 'done' : task.status);
    ledger.finishTask(row);
    topics.noteTask(task.b, task.s, task.title);
    if (bot) queueReflection(bot, { ...row, log });
  }

  // --- memory ----------------------------------------------------------------------------------
  const reflecting = new Map();
  /** Summarize a finished task into the journal and the bot's notes, one bot at a time. */
  function queueReflection(bot, task) {
    const prev = reflecting.get(bot.id) ?? Promise.resolve();
    const next = prev
      .then(() => reflect(bot, task))
      .catch((error) => ctx.logger?.warn?.(`bots: memory for @${bot.handle}: ${error?.message ?? error}`));
    reflecting.set(bot.id, next);
    void next.finally(() => {
      if (reflecting.get(bot.id) === next) reflecting.delete(bot.id);
    });
    return next;
  }
  const triggerWords = (task) =>
    task.trigger === 'schedule' ? 'a scheduled task' : task.trigger === 'dm' ? `a message from ${task.from === 'user' ? 'the user' : `@${store.get(task.from)?.handle ?? 'another bot'}`}` : task.trigger === 'chat' ? `a ${task.via ?? 'chat'} message from the user` : 'a message from the user';
  async function reflect(bot, task) {
    // A bot deleted while its summary waited keeps nothing.
    if (!store.get(bot.id)) return;
    const transcript = task.log.join('\n');
    const worth = task.log.some((l) => l.startsWith('[assistant]') || l.startsWith('[tool]'));
    // A short exchange (an acknowledgement, a one-line answer to a teammate) gets a journal line, not a model call.
    const big = transcript.length >= (task.trigger === 'dm' && task.from !== 'user' ? 1200 : 300);
    const sel = settings.get().memory.auto && worth && big ? memoryModelOf(bot) : null;
    let summary = '';
    if (sel) {
      try {
        const p = reflectionPrompt({ bot, notes: memory.notes(bot.id), team: memory.notes('team'), transcript, trigger: triggerWords(task) });
        const r = await complete(sel, p.system, p.user, { purpose: 'bots-memory', sessionId: task.s });
        ledger.record(usageRow({ botId: bot.id, sessionId: task.s, taskId: task.id, kind: 'memory', provider: sel.provider, model: sel.model, usage: r.usage }));
        const parsed = parseJsonReply(r.text) ?? {};
        summary = String(parsed.summary ?? '').trim();
        if (Array.isArray(parsed.notes) && parsed.notes.length) memory.edit(bot.id, parsed.notes, { source: 'auto' });
        if (Array.isArray(parsed.team) && parsed.team.length) memory.edit('team', parsed.team, { source: 'auto' });
      } catch (error) {
        ctx.logger?.warn?.(`bots: summarizing a task of @${bot.handle} failed: ${error?.message ?? error}`);
      }
    }
    if (worth || summary) memory.addJournal({ bot: bot.id, task: task.id, trigger: task.trigger, title: task.title, summary: summary || task.title });
    // The bot started a new topic before this summary was written: that topic reads its memory again.
    const now = store.get(bot.id)?.sessionId;
    if (now && now !== task.s) staleMemory(now);
  }

  let dreaming = null;
  /** Consolidate every bot's notes and write the team digest (the daily "dream"). */
  function dream({ reason = 'schedule' } = {}) {
    if (dreaming) return dreaming;
    dreaming = (async () => {
      const now = Date.now();
      const tz = tzMinutes();
      const before = memory.dreamState();
      const since = Number(before.lastAt) || now - DAY_MS;
      const bots = store.list();
      const result = { at: now, reason, bots: [], digest: null, errors: [] };
      for (const bot of bots) {
        const journal = memory.journal({ bot: bot.id, since: now - 7 * DAY_MS, limit: 300 });
        const fresh = journal.some((j) => j.at >= since);
        const notes = memory.notes(bot.id);
        if (!fresh && notes.length < 40) continue;
        const sel = memoryModelOf(bot);
        if (!sel) continue;
        try {
          const p = dreamBotPrompt({ bot, notes, journal, tz });
          const r = await complete(sel, p.system, p.user, { purpose: 'bots-dream', maxTokens: 4000, timeoutMs: 180_000 });
          ledger.record(usageRow({ botId: bot.id, kind: 'dream', provider: sel.provider, model: sel.model, usage: r.usage }));
          const parsed = parseJsonReply(r.text);
          if (!parsed) throw new Error('the model did not answer with JSON');
          result.bots.push({ bot: bot.id, ...memory.edit(bot.id, Array.isArray(parsed.notes) ? parsed.notes : [], { source: 'dream' }) });
        } catch (error) {
          result.errors.push({ bot: bot.id, reason: error?.message ?? String(error) });
        }
      }
      const journal = memory.journal({ since, limit: 2000 });
      if (journal.length > 0) {
        const lead = store.primary() ?? bots[0];
        const sel = lead ? memoryModelOf(lead) : settings.get().memory.model;
        const date = memory.dayOf(journal[journal.length - 1].at, tz);
        if (sel) {
          try {
            const p = dreamTeamPrompt({ bots, team: memory.notes('team'), journal, date, tz });
            const r = await complete(sel, p.system, p.user, { purpose: 'bots-dream', maxTokens: 4000, timeoutMs: 180_000 });
            ledger.record(usageRow({ botId: lead?.id ?? 'team', kind: 'dream', provider: sel.provider, model: sel.model, usage: r.usage }));
            const parsed = parseJsonReply(r.text);
            if (!parsed) throw new Error('the model did not answer with JSON');
            if (String(parsed.digest ?? '').trim()) result.digest = memory.addDigest({ date, text: parsed.digest });
            if (Array.isArray(parsed.team)) result.team = memory.edit('team', parsed.team, { source: 'dream' });
          } catch (error) {
            result.errors.push({ bot: 'team', reason: error?.message ?? String(error) });
          }
        }
      }
      // A day whose every step failed is tried again from the same point tomorrow.
      const tried = result.bots.length + result.errors.length + (result.digest || result.team ? 1 : 0);
      const advanced = tried === 0 || result.bots.length > 0 || Boolean(result.digest || result.team);
      memory.setDreamState({ lastDate: memory.dayOf(now, tz), lastAt: advanced ? now : (before.lastAt ?? null), result });
      staleMemory();
      return result;
    })().finally(() => {
      dreaming = null;
    });
    return dreaming;
  }
  /** Whether today's consolidation is due: past the set time and not yet run today. */
  function dreamDue(now = Date.now()) {
    const m = settings.get().memory;
    if (!m.dream) return false;
    const tz = tzMinutes();
    if (memory.dreamState().lastDate === memory.dayOf(now, tz)) return false;
    const [hh, mm] = m.dreamTime.split(':').map(Number);
    const local = new Date(now + tz * 60_000);
    return local.getUTCHours() * 60 + local.getUTCMinutes() >= hh * 60 + mm;
  }

  // --- topics ------------------------------------------------------------------------------------
  const rotating = new Map();
  /**
   * Start `bot`'s next topic: a fresh conversation (the old one is archived, its
   * scheduled tasks move to the new one). Refused while the bot is working.
   */
  function newTopic(ref, reason = 'manual') {
    const bot = store.get(ref.id) ?? ref;
    if (rotating.has(bot.id)) return rotating.get(bot.id);
    const job = (async () => {
      const prev = bot.sessionId;
      const agent = prev ? agents()?.get?.(prev) : undefined;
      if (agent?.status === 'running') throw new Error(`${bot.name} is still working; start a new topic when it is done`);
      const open = prev ? openTasks.get(prev) : undefined;
      if (open) finishTask(open);
      // The last task's summary belongs in the memory the new topic starts with.
      const pending = reflecting.get(bot.id);
      if (pending) await Promise.race([pending, new Promise((r) => setTimeout(r, REFLECT_WAIT_MS).unref?.())]);
      let next;
      try {
        next = await createSession(store.get(bot.id) ?? bot);
      } catch (error) {
        if (prev) store.patch(bot.id, { sessionId: prev });
        throw error;
      }
      if (prev && prev !== next) {
        // Every scheduled task moves along, or none does: one left behind would run in a conversation no bot owns.
        let entries = [];
        try {
          entries = (await schedule().catalog()).filter((e) => e.target?.kind === 'session' && e.target.sessionId === prev);
        } catch {
          entries = []; // No schedule service: nothing targets it.
        }
        const retarget = async (id, sessionId) => {
          const r = await schedule().edit({ id, action: 'update', patch: { target: { kind: 'session', sessionId } } });
          if (r && typeof r === 'object' && 'code' in r && !('title' in r) && r.code !== 'schedule_not_found') throw new Error(String(r.code));
        };
        const moved = [];
        let failed = null;
        for (const e of entries) {
          try {
            await retarget(e.id, next);
            moved.push(e.id);
          } catch (error) {
            failed = error;
            break;
          }
        }
        if (failed) {
          for (const id of moved) await retarget(id, prev).catch(() => {});
          store.patch(bot.id, { sessionId: prev });
          uninstall(next);
          const back = agents()?.get?.(prev);
          if (back) reconcile(back);
          await Promise.resolve(service(ctx, 'workspaceRegistry')?.archiveSession?.(next)).catch(() => {});
          throw new Error(`could not move the scheduled tasks of @${bot.handle} to a new topic (${failed?.message ?? failed}); it stays in the current one`);
        }
        uninstall(prev);
        memoText.delete(prev);
        memoStale.delete(prev);
        try {
          await service(ctx, 'workspaceRegistry')?.archiveSession?.(prev);
        } catch (error) {
          ctx.logger?.warn?.(`bots: archiving the last topic of @${bot.handle}: ${error?.message ?? error}`);
        }
      }
      topics.rotate(bot.id, next, reason);
      store.log({ from: 'system', to: bot.id, kind: 'topic', text: reason });
      return next;
    })().finally(() => rotating.delete(bot.id));
    rotating.set(bot.id, job);
    return job;
  }
  /** Start a new topic first when the conversation has gone quiet for long or grown too big. */
  async function autoTopic(bot, trigger) {
    // A topic starting right now: wait for it, so this message goes to the new conversation.
    if (bot?.id && rotating.has(bot.id)) {
      await rotating.get(bot.id).catch(() => {});
      return;
    }
    if (!bot?.sessionId || openTasks.has(bot.sessionId)) return;
    const agent = agents()?.get?.(bot.sessionId);
    if (agent?.status === 'running') return;
    const current = topics.peek(bot.id);
    if (!current || current.sessionId !== bot.sessionId) return;
    const reason = rotationReason(current, settings.get().topics, { trigger });
    if (!reason) return;
    try {
      await newTopic(bot, reason);
    } catch (error) {
      ctx.logger?.warn?.(`bots: new topic for @${bot.handle}: ${error?.message ?? error}`);
    }
  }
  const TOPIC_COMMAND = /^\/(new|clear|reset|新话题|新对话)(?=$|\s)\s*/i;

  // --- delivering messages ---------------------------------------------------------------
  const pairs = new Map();
  function admitPair(a, b) {
    const key = [a, b].sort().join('|');
    const now = Date.now();
    const times = (pairs.get(key) ?? []).filter((t) => now - t < PAIR_WINDOW_MS);
    if (times.length >= PAIR_LIMIT) return false;
    times.push(now);
    pairs.set(key, times);
    return true;
  }

  /** A DM from `sender` (a bot, or null for the user) to `target`. */
  async function deliver(sender, target, text, senderSessionId) {
    const body = String(text ?? '').trim();
    if (body === '') throw new Error('text must not be empty');
    if (sender && sender.id === target.id) throw new Error('a bot cannot message itself');
    if (sender && !admitPair(sender.id, target.id)) throw new Error(`@${sender.handle} and @${target.handle} exchanged ${PAIR_LIMIT} messages in the last 10 minutes; stop and report to the user instead of continuing.`);
    // A teammate's message may answer this bot's own question: only a long quiet starts a new topic here.
    await autoTopic(store.get(target.id) ?? target, sender ? 'dm' : 'user');
    const agent = await agentOf(store.get(target.id) ?? target);
    const message = createUserMessage({
      content: [
        { type: 'text', text: dmHeader(sender) },
        { type: 'text', text: dmBody(body, sender) },
      ],
      source: senderSessionId ? { kind: 'agent-message', form: 'relay', senderSessionId } : { kind: 'user' },
    });
    agent.followup(message);
    await flush(agent);
    store.log({ from: sender ? sender.id : 'user', to: target.id, text: body, kind: 'dm' });
    return agent.session.id;
  }

  /**
   * The user writes to a bot from the panel: an ordinary user prompt in its conversation.
   * `/new` (or `/clear`, `/新话题`) first starts a new topic; text after it goes there.
   */
  async function userSend(target, text) {
    let body = String(text ?? '').trim();
    if (body === '') throw new Error('text must not be empty');
    const cmd = TOPIC_COMMAND.exec(body);
    if (cmd) {
      const sessionId = await newTopic(target, 'manual');
      body = body.slice(cmd[0].length).trim();
      if (!body) return sessionId;
    } else await autoTopic(store.get(target.id) ?? target, 'user');
    const agent = await agentOf(store.get(target.id) ?? target);
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }));
    await flush(agent);
    return agent.session.id;
  }

  // --- chat channels: Telegram, Discord, Feishu / Lark, Slack -------------------------------
  const channels = createChannels({
    file: join(dir, 'channels.json'),
    bots: () => store.list(),
    entries: () => templates(),
    // A chat message is a user prompt like one typed in the panel, after a line naming where it came from.
    deliver: async (target, { header, body }) => {
      await autoTopic(store.get(target.id) ?? target, 'user');
      const agent = await agentOf(store.get(target.id) ?? target);
      agent.followup(createUserMessage({ content: [{ type: 'text', text: header }, { type: 'text', text: body }], source: { kind: 'user' } }));
      await flush(agent);
      return agent.session.id;
    },
    running: (sessionId) => agents()?.get?.(sessionId)?.status === 'running',
    newTopic: (bot) => newTopic(bot, 'manual'),
    ...(deps.loadConnector ? { loadConnector: deps.loadConnector } : {}),
    ...(deps.typingEveryMs ? { typingEveryMs: deps.typingEveryMs } : {}),
    log: (line) => ctx.logger?.info?.(`bots: ${line}`),
  });
  ctx.effect(() => {
    channels.sync();
    const off = store.onChange(() => channels.sync());
    return () => {
      off();
      void channels.stopAll();
    };
  }, 'bots: chat channels');

  // The timeline: what the user typed to a bot, what the bot answered, scheduled runs.
  const trigger = new Map();
  /** Sessions whose current turn already sent a bot_send_message. */
  const answered = new Set();
  /** Kinds of user message that start (or join) a task. */
  const TASK_KINDS = new Set(['user', 'schedule', 'agent-message']);
  ctx.on('session/event', (session, event) => {
    let bot;
    let via = null;
    let kind;
    try {
      bot = store.bySession(session?.id);
      if (!bot || !event) return;
      if (event.type === 'user/message') {
        kind = event.data?.source?.kind;
        // The Harness tells a session about task edits made elsewhere; that is not a delivery.
        if (kind === 'schedule' && /^\[SCHEDULE CHANGE\]/.test(textOf(event.data.content))) kind = 'schedule-notice';
        trigger.set(session.id, kind);
        answered.delete(session.id);
        const said = textOf(event.data.content);
        // A chat message makes its chat where replies go; any other user message brings them back here.
        via = channels.noteUserMessage(session.id, bot, kind, said);
        if (kind === 'user') store.log(via ? { from: 'user', to: bot.id, text: via.body, kind: 'user', via: via.kind, who: via.who } : { from: 'user', to: bot.id, text: said, kind: 'user' });
        else if (kind === 'schedule') store.log({ from: 'schedule', to: bot.id, text: said, kind: 'system' });
      } else if (event.type === 'assistant/message') {
        const content = event.data?.message?.content ?? [];
        const calls = content.filter((b) => b?.type === 'tool-call');
        if (calls.some((b) => (b.name ?? b.toolName) === 'bot_send_message')) answered.add(session.id);
        const text = calls.length > 0 ? '' : textOf(content);
        const why = trigger.get(session.id);
        // Shown in the bot's chat: what it says to the user. Hidden: acknowledging a schedule notice,
        // and the closing words of a turn that answered a bot by DM (they reach no one). The
        // dispatcher reporting back after its teammates answered is a message to the user.
        const hidden = why === 'schedule-notice' || (why === 'agent-message' && (bot.role !== 'primary' || answered.has(session.id)));
        if (text && !hidden) {
          // Also to the chat the user wrote from, when that is where the conversation is.
          const sent = channels.noteReply(session.id, text);
          store.log({ from: bot.id, to: 'user', text, kind: 'reply', ...(sent ? { via: sent.kind } : {}) });
        }
      } else if (event.type === 'turn/end') {
        channels.noteTurnEnd(session.id);
      }
    } catch {
      // The timeline must never disturb a conversation.
    }
    // Tasks, usage and the transcript memory is written from; never in the way either.
    try {
      if (!bot || !event) return;
      const sid = session.id;
      if (event.type === 'user/message') {
        if (!TASK_KINDS.has(kind)) return;
        const task = openTasks.get(sid) ?? startTask(bot, sid, kind, event, via);
        const said = textOf(event.data?.content);
        const who = kind === 'schedule' ? 'scheduled' : kind === 'agent-message' ? 'bot message' : via ? `user via ${via.kind}` : 'user';
        logLine(task, `[${who}] ${via ? via.body : said}`);
      } else if (event.type === 'assistant/message') {
        const msg = event.data?.message ?? {};
        recordUsage(bot, sid, { at: event.time, kind: 'chat', provider: msg.source?.provider, model: msg.source?.model, usage: event.data?.usage });
        const task = openTasks.get(sid);
        if (!task) return;
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          if (b?.type === 'text' && b.text?.trim()) logLine(task, `[assistant] ${b.text.trim()}`);
          else if (b?.type === 'tool-call') {
            let args = '';
            try {
              args = typeof b.argsRaw === 'string' ? b.argsRaw : JSON.stringify(b.args ?? b.arguments ?? b.input ?? {});
            } catch {
              args = '';
            }
            logLine(task, `[tool] ${b.name ?? b.toolName ?? 'tool'} ${args.slice(0, 400)}`);
          }
        }
      } else if (event.type === 'tool/result') {
        const task = openTasks.get(sid);
        const text = textOf(event.data?.message?.content ?? event.data?.content);
        if (task && text) logLine(task, `[result] ${text.slice(0, 300)}`);
      } else if (event.type === 'compaction/summary') {
        const d = event.data ?? {};
        recordUsage(bot, sid, { at: event.time, kind: 'compaction', provider: d.provider, model: d.model, usage: d.usage });
      } else if (event.type === 'turn/end') {
        const task = openTasks.get(sid);
        const reason = event.data?.reason?.kind;
        if (task && reason && reason !== 'completed') task.status = reason === 'error' ? 'error' : reason === 'aborted' ? 'stopped' : task.status;
        settleSoon(sid);
      }
    } catch (error) {
      ctx.logger?.debug?.(`bots: usage: ${error?.message ?? error}`);
    }
  });
  // The surest sign a task is over: the bot's Agent went idle.
  ctx.on('agent/status', (payload) => {
    try {
      const sid = payload?.agent?.session?.id;
      if (sid && payload.status === 'idle' && openTasks.has(sid)) settleSoon(sid, 300);
      else if (sid && payload.status === 'idle' && memoStale.delete(sid)) memoText.delete(sid);
    } catch {
      // Ignored.
    }
  });

  // --- schedules ------------------------------------------------------------------------
  const schedule = () => {
    const s = service(ctx, 'schedule');
    if (!s) throw new Error('scheduled tasks are unavailable in this Harness');
    return s;
  };
  const entryView = (e) => ({
    id: e.id,
    title: e.title,
    prompt: e.prompt,
    kind: e.kind,
    scheduledAt: e.scheduledAt,
    status: e.status,
    timing: timingOfEntry(e),
    describe: describeTiming(timingOfEntry(e)),
    ...(e.executionActive ? { executionActive: true } : {}),
    ...(e.lastDelivery ? { lastDelivery: e.lastDelivery } : {}),
    sessionId: e.target?.kind === 'session' ? e.target.sessionId : null,
  });
  async function schedulesOf(bot) {
    const all = await schedule().catalog();
    for (const e of all) if (e?.id && e.title) scheduleTitles.set(e.id, e.title);
    const sessions = new Set(store.list().map((b) => b.sessionId).filter(Boolean));
    return all
      .filter((e) => e.target?.kind === 'session' && (bot ? e.target.sessionId === bot.sessionId : sessions.has(e.target.sessionId)))
      .map((e) => ({ ...entryView(e), botId: store.bySession(e.target.sessionId)?.id ?? null }));
  }
  const checkEntry = (result) => {
    if (result && typeof result === 'object' && 'code' in result && !('title' in result)) throw new Error(result.code === 'schedule_not_found' ? 'no such scheduled task' : String(result.code));
    return result;
  };
  async function scheduleSave(bot, { id, title, prompt, timing }, actor) {
    const t = String(title ?? '').trim().slice(0, 120);
    const p = String(prompt ?? '').trim();
    if (id) {
      const patch = {};
      if (t) patch.title = t;
      if (p) patch.prompt = p;
      if (timing) patch.timing = timing;
      return entryView(checkEntry(await schedule().edit({ id, action: 'update', patch }, actor)));
    }
    if (!t || !p || !timing) throw new Error('a new task needs a title, a prompt and a timing');
    const sessionId = await ensureSession(bot);
    return entryView(await schedule().create({ title: t, prompt: p, timing, target: { kind: 'session', sessionId } }, actor));
  }

  // --- bot lifecycle helpers -----------------------------------------------------------
  async function removeBot(bot) {
    try {
      for (const task of await schedulesOf(bot)) await schedule().edit({ id: task.id, action: 'delete' });
    } catch {
      // No schedule service or nothing to remove.
    }
    if (bot.sessionId) {
      uninstall(bot.sessionId);
      try {
        service(ctx, 'workspaceRegistry')?.archiveSession?.(bot.sessionId);
      } catch {
        // The conversation stays where it is.
      }
    }
    store.remove(bot.id);
    memory.dropBot(bot.id);
    topics.drop(bot.id);
    if (bot.avatar.kind === 'image') for (const f of [bot.id, `${bot.id}.type`]) rmSync(join(dir, 'avatars', f), { force: true });
  }

  function botStatus(bot) {
    const agent = bot.sessionId ? agents()?.get?.(bot.sessionId) : undefined;
    return agent ? (agent.status === 'running' ? 'running' : 'idle') : 'offline';
  }

  function applyModel(bot) {
    const agent = bot.sessionId ? agents()?.get?.(bot.sessionId) : undefined;
    if (agent && bot.model) {
      try {
        agent.model?.select?.(selectionOf(bot.model));
      } catch {
        // Kept on its current model.
      }
    }
  }

  // --- AI avatars, through the images plugin's generate_image tool ---------------------
  const imageTool = () => {
    try {
      return ctx.tools?.get?.('generate_image');
    } catch {
      return undefined;
    }
  };
  function imageGenAvailable() {
    return Boolean(imageTool());
  }
  /** The prompt an avatar is drawn from: who the bot is, as a flat, legible profile picture. */
  function avatarPrompt(bot, extra) {
    const who = [bot.name, bot.bio, bot.persona.split(/\n/)[0]].filter(Boolean).join(' — ').slice(0, 500);
    return [
      `A square profile avatar for an AI assistant character: ${who}.`,
      extra ? `Style notes from the user: ${String(extra).slice(0, 400)}.` : 'Modern flat vector illustration, a friendly character or emblem centred, bold simple shapes, soft gradient background in one dominant colour, high contrast, no text, no letters, no watermark, no border.',
      'It must read clearly at 32×32 pixels.',
    ].join(' ');
  }
  async function generateAvatar(bot, extra) {
    const tool = imageTool();
    if (!tool) throw new Error('the Images plugin (generate_image) is not installed or turned off');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    let value;
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          value = await tool.execute({ prompt: avatarPrompt(bot, extra), size: '1024x1024', n: 1 }, { signal: controller.signal });
          break;
        } catch (error) {
          const message = String(error?.message ?? error);
          // Gateways drop long image requests now and then; those are worth another try.
          if (attempt >= AVATAR_ATTEMPTS || controller.signal.aborted || !TRANSIENT.test(message)) {
            throw new Error(TRANSIENT.test(message) ? `the image service failed ${attempt} times in a row (${message}); try again in a moment` : message);
          }
          ctx.logger?.warn?.(`bots: avatar for @${bot.handle}, attempt ${attempt} failed: ${message}; retrying`);
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        }
      }
    } finally {
      clearTimeout(timer);
    }
    const path = value?.images?.[0]?.path;
    const type = value?.images?.[0]?.mediaType;
    if (!path || !/^image\/(png|jpeg|webp|gif)$/.test(String(type))) throw new Error('the image model returned no picture');
    const bytes = readFileSync(path);
    if (bytes.length > 8 * 1024 * 1024) throw new Error('the generated picture is too large');
    mkdirSync(join(dir, 'avatars'), { recursive: true });
    writeFileSync(join(dir, 'avatars', bot.id), bytes);
    writeFileSync(join(dir, 'avatars', `${bot.id}.type`), type);
    return store.patch(bot.id, { avatar: { kind: 'image', source: 'ai', url: `${R}/avatar/${bot.id}?v=${Date.now().toString(36)}`, color: bot.avatar.color } });
  }

  // --- the model's tools ------------------------------------------------------------------
  const callerBot = (exec) => store.bySession(exec?.agent?.session?.id);
  const resolve = (ref, what = 'bot') => {
    const bot = store.find(ref);
    if (!bot) throw new Error(`no ${what} "${ref}". Known bots: ${store.list().map((b) => `@${b.handle}`).join(', ') || 'none'}`);
    return bot;
  };
  const anyValue = { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } };
  const text = (s) => [{ type: 'text', text: s }];
  const skillInput = {
    type: 'array',
    items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, description: { type: 'string' }, content: { type: 'string', description: 'Markdown instructions the bot loads when the skill applies.' } } },
  };
  const card = (bot) => `@${bot.handle} — ${bot.name}${bot.role === 'primary' ? ' (dispatcher)' : ''}`;
  const tooManySkills = (n) => {
    if (n > MAX_SKILLS) throw new Error(`a bot keeps at most ${MAX_SKILLS} skills (this would make ${n}); remove some first`);
  };
  /** The tool-result sentence for skills asked on that the store had to leave off (past MAX_SKILLS_ON). */
  const offNote = (asked, saved) => {
    const names = new Set((asked ?? []).map((s) => String(s?.name ?? '').trim().toLowerCase()));
    const off = saved.skills.filter((s) => !s.enabled && names.has(s.name.toLowerCase())).map((s) => s.name);
    return off.length ? ` Added switched off, since at most ${MAX_SKILLS_ON} skills can be on at once: ${off.join(', ')}. To use them, remove skills it no longer needs (remove_skills) or ask the user to switch some off in Bots.` : '';
  };

  const tools = [
    defineTool({
      name: 'bot_list',
      description: "List the user's bots: handle, name, role, status, bio, skills, apps and scheduled tasks. Use it before delegating to find the right bot.",
      parameters: {},
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ bots: v.bots }) },
      isConcurrencySafe: () => true,
      execute: async () => {
        const bots = store.list();
        let tasks = [];
        try {
          tasks = await schedulesOf(null);
        } catch {
          tasks = [];
        }
        const lines = bots.map((b) => {
          const sk = b.skills.filter((s) => s.enabled).map((s) => s.name);
          const ap = b.apps.filter((a) => a.enabled).map((a) => a.name);
          const ts = tasks.filter((t) => t.botId === b.id).map((t) => `${t.title} (${t.describe}${t.status !== 'active' ? `, ${t.status}` : ''})`);
          return [`${card(b)} [${botStatus(b)}]${b.bio ? `: ${b.bio}` : ''}`, sk.length ? `  skills: ${sk.join(', ')}` : '', ap.length ? `  apps: ${ap.join(', ')}` : '', ts.length ? `  scheduled: ${ts.join('; ')}` : ''].filter(Boolean).join('\n');
        });
        return { ok: true, text: lines.length ? lines.join('\n') : 'No bots yet.', bots: bots.map(face) };
      },
    }),
    defineTool({
      name: 'bot_create',
      description: 'Create a new bot with its own persona, avatar and skills, and its own conversation. Do it when the user asks, or when a recurring kind of work clearly needs a specialist; say what you created.',
      parameters: {
        name: { type: 'string', required: true, description: 'Display name.' },
        handle: { type: 'string', description: 'Lowercase a-z, 0-9 and dashes; derived from the name when left out.' },
        bio: { type: 'string', description: 'One line describing what the bot does, shown on its card and to other bots.' },
        persona: { type: 'string', description: 'Who the bot is and how it works, in the second person ("You are …"). Several sentences.' },
        initials: { type: 'string', description: 'Avatar letters, at most two; derived from the name (pinyin initials for a Chinese name) when left out.' },
        color: { type: 'string', description: 'Avatar background colour, CSS hex.' },
        skills: { ...skillInput, description: 'Skills to give it.' },
      },
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ bot: v.bot }) },
      execute: async (args, exec) => {
        const by = callerBot(exec);
        tooManySkills((args.skills ?? []).length);
        const bot = store.save(
          {
            name: args.name,
            handle: args.handle ? slugify(args.handle) : '',
            bio: args.bio ?? '',
            persona: args.persona ?? '',
            avatar: { kind: 'initials', ...(args.initials ? { text: args.initials } : {}), ...(args.color ? { color: args.color } : {}) },
            skills: (args.skills ?? []).map((s) => ({ ...s, enabled: true })),
          },
          { createdBy: by?.id ?? 'user' },
        );
        return { ok: true, text: `Created ${card(bot)}. Message it with bot_send_message to @${bot.handle}.${offNote(args.skills, bot)}`, bot: face(bot) };
      },
    }),
    defineTool({
      name: 'bot_update',
      description: "Change a bot: name, bio, persona, avatar, skills, or make it the dispatcher. Only the fields you pass change.",
      parameters: {
        bot: { type: 'string', required: true, description: '@handle, id or name of the bot.' },
        name: { type: 'string' },
        bio: { type: 'string' },
        persona: { type: 'string', description: 'Replaces the whole persona.' },
        initials: { type: 'string', description: 'Avatar letters, at most two.' },
        color: { type: 'string', description: 'Avatar background colour, CSS hex.' },
        add_skills: { ...skillInput, description: `Skills to add (a skill with the same name is replaced). At most ${MAX_SKILLS_ON} can be on at once; past that they are added switched off.` },
        remove_skills: { type: 'array', items: { type: 'string' }, description: 'Names of skills to remove.' },
        make_dispatcher: { type: 'boolean', description: 'true to make this bot the dispatcher.' },
      },
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ bot: v.bot }) },
      execute: async (args) => {
        const bot = resolve(args.bot);
        const next = { id: bot.id };
        for (const k of ['name', 'bio', 'persona']) if (typeof args[k] === 'string') next[k] = args[k];
        if (args.initials || args.color) next.avatar = { ...(bot.avatar.kind === 'image' ? { kind: 'initials' } : bot.avatar), kind: 'initials', ...(args.initials ? { text: args.initials } : {}), color: args.color ?? bot.avatar.color };
        if (args.add_skills || args.remove_skills) {
          const drop = new Set([...(args.remove_skills ?? []), ...(args.add_skills ?? []).map((s) => s.name)].map((s) => String(s).toLowerCase()));
          next.skills = [...bot.skills.filter((s) => !drop.has(s.name.toLowerCase())), ...(args.add_skills ?? []).map((s) => ({ ...s, enabled: true }))];
          tooManySkills(next.skills.length);
        }
        if (args.make_dispatcher === true) next.role = 'primary';
        const saved = store.save(next);
        return { ok: true, text: `Updated ${card(saved)}.${offNote(args.add_skills, saved)}`, bot: face(saved) };
      },
    }),
    defineTool({
      name: 'bot_delete',
      description: 'Delete a bot, its scheduled tasks, and archive its conversation. Only when the user asked for it.',
      parameters: { bot: { type: 'string', required: true, description: '@handle, id or name.' } },
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ bot: v.bot }) },
      execute: async (args, exec) => {
        const bot = resolve(args.bot);
        if (callerBot(exec)?.id === bot.id) throw new Error('a bot cannot delete itself; ask the dispatcher or the user');
        if (bot.role === 'primary' && store.list().length > 1) throw new Error('make another bot the dispatcher first (bot_update make_dispatcher)');
        await removeBot(bot);
        return { ok: true, text: `Deleted @${bot.handle}.`, bot: face(bot) };
      },
    }),
    defineTool({
      name: 'bot_send_message',
      description:
        "Send a direct message to another bot. It lands in that bot's own conversation and wakes it; it works on it there and answers you with its own bot_send_message, which arrives here as a new message. Use it to delegate, ask, or report back. Make the text self-contained — the other bot cannot see this conversation. Do not reply to acknowledgements.",
      parameters: {
        to: { type: 'string', required: true, description: '@handle (or id / name) of the bot.' },
        text: { type: 'string', required: true, description: 'The whole message.' },
      },
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ to: v.to, from: v.from }) },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const target = resolve(args.to);
        const sender = callerBot(exec);
        await deliver(sender ?? null, target, args.text, exec?.agent?.session?.id);
        return { ok: true, text: `Delivered to @${target.handle}. Its answer will arrive as a new message; continue with other work or end your turn.`, to: face(target), from: face(sender) };
      },
    }),
    defineTool({
      name: 'bot_schedule',
      description:
        "Manage a bot's scheduled tasks: at each occurrence the prompt is delivered to that bot's conversation as a scheduled instruction. Actions: create, list, update, delete, pause, resume, run (now). Timing: kind=at (at: ISO date-time with offset), every (every_minutes), daily (time HH:MM), weekly (time + weekdays 1=Mon…7=Sun), cron (five fields). Times are in time_zone, default the user's zone.",
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'list', 'update', 'delete', 'pause', 'resume', 'run'] },
        bot: { type: 'string', description: '@handle of the bot the task belongs to (create/list); defaults to yourself.' },
        id: { type: 'string', description: 'Task id for update/delete/pause/resume/run.' },
        title: { type: 'string' },
        prompt: { type: 'string', description: 'Instruction delivered to the bot each time, self-contained.' },
        kind: { type: 'string', enum: ['at', 'every', 'daily', 'weekly', 'cron'] },
        at: { type: 'string' },
        every_minutes: { type: 'number' },
        time: { type: 'string' },
        weekdays: { type: 'array', items: { type: 'integer' } },
        cron: { type: 'string' },
        time_zone: { type: 'string', description: `IANA zone, default ${zone}.` },
      },
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ bot: v.bot, task: v.task }) },
      execute: async (args, exec) => {
        const actor = exec?.agent?.session?.id;
        const bot = args.bot ? resolve(args.bot) : callerBot(exec) ?? store.primary();
        if (!bot && (args.action === 'create' || args.action === 'list')) throw new Error('say which bot with `bot`');
        switch (args.action) {
          case 'list': {
            const items = await schedulesOf(bot);
            return { ok: true, bot: face(bot), text: items.length ? items.map((t) => `${t.id}: ${t.title} — ${t.describe}, ${t.status}, next ${t.scheduledAt}`).join('\n') : `@${bot.handle} has no scheduled tasks.` };
          }
          case 'create':
          case 'update': {
            const timing = args.kind ? timingFrom(args, zone) : undefined;
            const task = await scheduleSave(bot, { id: args.action === 'update' ? args.id : undefined, title: args.title, prompt: args.prompt, timing }, actor);
            return { ok: true, bot: face(bot), task, text: `${args.action === 'create' ? 'Scheduled' : 'Updated'} "${task.title}" for @${bot.handle}: ${task.describe}; next at ${task.scheduledAt} (id ${task.id}).` };
          }
          case 'delete':
            checkEntry(await schedule().edit({ id: String(args.id ?? ''), action: 'delete' }, actor));
            return { ok: true, text: `Deleted task ${args.id}.` };
          case 'pause':
          case 'resume': {
            const task = entryView(checkEntry(await schedule().edit({ id: String(args.id ?? ''), action: 'update', patch: { active: args.action === 'resume' } }, actor)));
            return { ok: true, task, text: `${args.action === 'pause' ? 'Paused' : 'Resumed'} "${task.title}".` };
          }
          case 'run':
            checkEntry(await schedule().run({ id: String(args.id ?? '') }));
            return { ok: true, text: `Task ${args.id} was delivered now.` };
          default:
            throw new Error('unknown action');
        }
      },
    }),
    defineTool({
      name: 'memory_save',
      description:
        "Save a note to long-term memory, which outlasts this conversation and every new topic. Use it when the user asks you to remember something, or you learn a lasting fact, preference, decision or lesson. scope 'self' is your own memory; 'team' is read by every bot (only for what all of them should know). One self-contained sentence; never secrets.",
      parameters: {
        text: { type: 'string', required: true, description: 'The note: one sentence, in the language the user uses.' },
        scope: { type: 'string', enum: ['self', 'team'], description: "Default 'self'." },
        kind: { type: 'string', enum: MEMORY_KINDS },
        replace_id: { type: 'string', description: 'Id of an existing note this one corrects or replaces.' },
      },
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ note: v.note, scope: v.scope }) },
      execute: async (args, exec) => {
        const me = callerBot(exec);
        const scope = args.scope === 'team' ? 'team' : 'self';
        if (scope === 'self' && !me) throw new Error("only a bot has its own memory; use scope 'team' to save a note every bot reads");
        const key = scope === 'team' ? 'team' : me.id;
        const ops = args.replace_id ? [{ op: 'update', id: String(args.replace_id), text: args.text, kind: args.kind }] : [{ op: 'add', text: args.text, kind: args.kind }];
        if (args.replace_id && !memory.notes(key).some((n) => n.id === String(args.replace_id))) throw new Error(`no note ${args.replace_id} in ${scope === 'team' ? 'team' : 'your'} memory`);
        const r = memory.edit(key, ops, { source: 'tool' });
        const note = memory.notes(key).find((n) => n.id === r.touched[0]) ?? null;
        if (!note) {
          if (args.replace_id) throw new Error(`note ${args.replace_id} is pinned by the user; it stays as it is (ask the user to change it)`);
          throw new Error(looksSecret(args.text) ? 'not saved: it looks like a secret (keys, passwords and tokens are never stored)' : String(args.text ?? '').trim() ? 'not saved: memory is full of pinned notes; ask the user to unpin some' : 'not saved: the note is empty');
        }
        return { ok: true, scope, note, text: `${r.added ? 'Saved' : args.replace_id ? 'Updated' : 'Already remembered'} (${scope === 'team' ? 'team memory' : 'your memory'}${note ? `, id ${note.id}` : ''}).` };
      },
    }),
    defineTool({
      name: 'memory_forget',
      description: 'Remove a note from long-term memory that is wrong or no longer true, by its id (shown in brackets in your memory).',
      parameters: { id: { type: 'string', required: true }, scope: { type: 'string', enum: ['self', 'team'], description: "Default 'self'." } },
      output: { schema: anyValue, render: (_a, v) => text(v.text) },
      execute: async (args, exec) => {
        const me = callerBot(exec);
        const scope = args.scope === 'team' || String(args.id).startsWith('t-') ? 'team' : 'self';
        if (scope === 'self' && !me) throw new Error('only a bot has its own memory');
        const key = scope === 'team' ? 'team' : me.id;
        const target = memory.notes(key).find((n) => n.id === String(args.id));
        if (!target) throw new Error(`no note ${args.id} in ${scope === 'team' ? 'team' : 'your'} memory`);
        if (target.pinned) throw new Error(`note ${args.id} is pinned by the user; ask the user before removing it`);
        memory.remove(key, String(args.id));
        return { ok: true, text: `Forgot ${args.id}.` };
      },
    }),
    defineTool({
      name: 'memory_search',
      description: "Search long-term memory and the team's work journal (what every bot did, task by task) and daily digests, for words in the query. Use it when the user refers to earlier work that is not in this conversation.",
      parameters: { query: { type: 'string', required: true, description: 'Words that should all appear.' } },
      output: { schema: anyValue, render: (_a, v) => text(v.text) },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const me = callerBot(exec);
        const r = memory.search(args.query, { bot: me?.id ?? '' });
        const tz = tzMinutes();
        const when = (ms) => new Date(ms + tz * 60_000).toISOString().slice(0, 16).replace('T', ' ');
        const lines = [
          ...r.notes.map((n) => `[${n.id}] (${n.scope === 'team' ? 'team' : 'yours'}) ${n.text}`),
          ...r.journal.map((j) => `${when(j.at)} @${store.get(j.bot)?.handle ?? 'removed'}: ${j.summary || j.title}`),
          ...r.digests.map((d) => `Digest ${d.date}: ${d.text.slice(0, 600)}`),
        ];
        return { ok: true, text: lines.length ? lines.join('\n') : `Nothing in memory matches "${args.query}".` };
      },
    }),
  ];

  ctx.effect(() => {
    const disposers = tools.map((t) => ctx.tools.register(t));
    return () => {
      for (const d of disposers) if (typeof d === 'function') d();
    };
  }, 'bots: tools');

  const commands = service(ctx, 'commands');
  if (commands?.register) {
    ctx.effect(() =>
      commands.register({
        name: 'bots',
        description: 'Open the Bots panel: your bots, their conversations, skills, apps and schedules',
        handler: () => ({ kind: 'success', text: `${store.list().length} bot(s). Open the Bots panel from the sidebar.` }),
      }),
    );
  }

  // --- routes --------------------------------------------------------------------------
  /** A live Agent to read scoped registries through (presets mount skill discovery per Agent). */
  function sampleAgent() {
    const live = agents();
    return store.list().map((b) => (b.sessionId ? live?.get?.(b.sessionId) : undefined)).find(Boolean) ?? live?.list?.()?.[0];
  }
  /** Description of each Harness skill as of the last registry read; fills skills stored without one. */
  const dshSkillInfo = new Map();
  /** The skills installed in this Harness, as a bot would see them (bot-registered ones left out). */
  async function dshSkills() {
    const registry = service(ctx, 'skills');
    if (!registry?.list) return [];
    const agent = sampleAgent();
    let rows = [];
    try {
      rows = await registry.list(agent ? { scope: agent, cwd: workdir } : {});
    } catch {
      try {
        rows = await registry.list({});
      } catch {
        rows = [];
      }
    }
    const out = rows
      .filter((r) => r.provider !== 'runtime' && r.source !== 'bots')
      .map((r) => ({ name: r.name, description: String(r.description ?? '').replace(/\s+/g, ' ').slice(0, 400), source: r.source ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const r of out) dshSkillInfo.set(r.name, r.description);
    return out;
  }

  async function catalog() {
    const toolRows = [];
    try {
      // Preset tools live in an Agent's scope: read them through a live bot (or any live Agent).
      const live = agents();
      const sample = store.list().map((b) => (b.sessionId ? live?.get?.(b.sessionId) : undefined)).find(Boolean) ?? live?.list?.()?.[0];
      const scope = sample ? scopeOf(sample.ctx) : undefined;
      for (const d of ctx.tools.definitions(scope)) {
        if (TOOL_NAMES.includes(d.name) || d.name.startsWith('mcp__') || d.name === 'run_code') continue;
        toolRows.push({ name: d.name, description: String(d.description ?? '').split(/(?<=\.)\s/)[0].slice(0, 200) });
      }
    } catch {
      // No registry view.
    }
    toolRows.sort((a, b) => a.name.localeCompare(b.name));
    const models = [];
    try {
      const llm = service(ctx, 'llm');
      const logins = await loginRoutes();
      for (const p of llm?.listProviders?.() ?? []) {
        try {
          const list = await llm.listModels(p.id);
          const infos = await Promise.all(
            list.slice(0, 200).map((m) =>
              Promise.resolve()
                .then(() => (typeof llm.resolveModelInfo === 'function' ? llm.resolveModelInfo(p.id, m.id, AbortSignal.timeout(3000)) : null))
                .catch(() => null),
            ),
          );
          list.forEach((m, i) => {
            const efforts = Array.isArray(infos[i]?.reasoning?.efforts) ? infos[i].reasoning.efforts.map((e) => ({ id: String(e.id), name: String(e.name ?? e.id) })) : [];
            models.push({
              provider: p.id,
              model: m.id,
              label: `${p.name ?? p.id} · ${m.name ?? m.id}`,
              group: p.name ?? p.id,
              name: m.name ?? m.id,
              ...(p.id.startsWith(ROUTE_PREFIX) ? { source: 'custom' } : logins.has(p.id) ? { source: 'login' } : {}),
              ...(efforts.length ? { efforts, ...(infos[i].reasoning.defaultEffort ? { defaultEffort: String(infos[i].reasoning.defaultEffort) } : {}) } : {}),
              ...(infos[i]?.context?.contextWindow ? { context: infos[i].context.contextWindow } : {}),
            });
          });
        } catch {
          // One provider down leaves the rest.
        }
      }
    } catch {
      // No model service.
    }
    let defaultModel = null;
    try {
      const def = service(ctx, 'agentDefaultModel')?.currentSelection?.();
      if (def?.provider && def?.model) defaultModel = { provider: def.provider, model: def.model };
    } catch {
      defaultModel = null;
    }
    const skills = await dshSkills();
    const ocu = ocuPath();
    return {
      templates: templates(),
      categories: CATEGORIES,
      abilities: ABILITIES.map((a) => ({ ...a, available: a.tools.filter((t) => toolRows.some((r) => r.name === t)) })),
      skillSources: SKILL_SOURCES,
      imageGen: imageGenAvailable(),
      tools: toolRows,
      models,
      defaultModel,
      skills: skills.map((s) => ({ name: s.name, description: String(s.description ?? '').slice(0, 300) })),
      ocu: { installed: ocu !== '', path: ocu || OCU_PATHS[0] },
      mcp: Boolean(mcpClient),
      zone,
    };
  }

  // --- model sources: custom endpoints and other agents' logins -----------------------------
  /** The settings namespace of Harness's pi-ai adapter (where provider routes live). */
  function piNamespace() {
    try {
      // Other adapters (DeepSeek's own) configure providers elsewhere; the pi-ai one keeps a `providers` dict.
      const rows = service(ctx, 'llm')?.listConfigurableProviders?.() ?? [];
      if (rows.some((p) => p.settingsNs === PI_SCOPE)) return PI_SCOPE;
      const row = rows.find((p) => p.settingsNs && Array.isArray(p.settingsPath) && p.settingsPath[0] === 'providers');
      if (row) return row.settingsNs;
    } catch {
      // Default below.
    }
    return PI_SCOPE;
  }
  /** The provider routes configured in Harness now (secrets redacted). */
  function piProviders() {
    try {
      const d = service(ctx, 'settings')?.describe?.({ redactSecrets: true })?.find((x) => x.ns === piNamespace());
      return d?.value?.providers && typeof d.value.providers === 'object' ? d.value.providers : {};
    } catch {
      return {};
    }
  }
  async function writeProvider(route, value) {
    const s = service(ctx, 'settings');
    if (!s?.mutate) throw new Error('this Harness cannot change its model settings from a plugin');
    await s.mutate(piNamespace(), [value === undefined ? { op: 'unset', path: ['providers', route] } : { op: 'set', path: ['providers', route], value }]);
  }
  const creds = () => {
    const c = service(ctx, 'credentials');
    if (!c) throw new Error('this Harness has no credential store');
    return c;
  };
  const CODEX_KEY = `${PI_SCOPE}/${CODEX_ROUTE}`;
  /** Routes signed in with a subscription (a stored login, not a key). */
  async function loginRoutes() {
    try {
      const rows = (await service(ctx, 'credentials')?.listRecords?.()) ?? [];
      return new Set(rows.filter((r) => String(r.key).startsWith(`${PI_SCOPE}/`) && r.kind === 'grant').map((r) => String(r.key).slice(PI_SCOPE.length + 1)));
    } catch {
      return new Set();
    }
  }
  async function modelSources() {
    const providers = piProviders();
    const c = service(ctx, 'credentials');
    const custom = [];
    for (const [route, profile] of Object.entries(providers)) {
      if (!route.startsWith(ROUTE_PREFIX)) continue;
      let configured = false;
      try {
        configured = Boolean((await c?.describe?.(keyRefFor(route)))?.configured);
      } catch {
        configured = false;
      }
      custom.push(endpointView(route, profile, configured));
    }
    const grants = await loginRoutes();
    const logins = detectLogins(home).map((l) => (l.id === 'codex' ? { ...l, connected: Boolean(providers[CODEX_ROUTE]) && grants.has(CODEX_ROUTE), sync: settings.get().codex.sync } : l));
    return { custom, logins, apis: API_KINDS, writable: Boolean(service(ctx, 'settings')?.mutate && c) };
  }
  async function saveEndpoint(body) {
    const prevRoute = typeof body.route === 'string' && body.route.startsWith(ROUTE_PREFIX) ? body.route : '';
    const { route, profile } = profileFor({ ...body, ...(prevRoute ? { route: prevRoute } : {}) });
    const key = String(body.key ?? '').trim();
    if (!prevRoute) {
      const taken = Object.keys(piProviders()).includes(route) || (service(ctx, 'llm')?.listProviders?.() ?? []).some((p) => p.id === route);
      if (taken) throw new Error(`a provider "${route}" exists already; give this endpoint another name`);
      if (!key) throw new Error('enter the API key (any text for a local server that needs none)');
    }
    if (key) await creds().set(keyRefFor(route), key);
    await writeProvider(route, profile);
    return { ok: true, route };
  }
  async function deleteEndpoint(route) {
    if (!String(route).startsWith(ROUTE_PREFIX)) throw new Error('only endpoints added in Bots can be removed here');
    await writeProvider(route, undefined);
    try {
      await creds().unset(keyRefFor(route));
    } catch {
      // The key may be gone already.
    }
    // Bots on it go back to the Harness default.
    for (const b of store.list()) if (b.model?.provider === route) store.save({ id: b.id, model: null });
    return { ok: true };
  }
  async function testEndpoint(body) {
    let key = String(body.key ?? '').trim();
    let { api, baseURL } = body;
    if (!key && typeof body.route === 'string' && body.route.startsWith(ROUTE_PREFIX)) {
      // The saved key only ever goes to the address it was saved for.
      const stored = piProviders()[body.route];
      if (stored) ({ api, baseURL } = { api: stored.api ?? api, baseURL: stored.baseURL ?? baseURL });
      try {
        key = (await creds().resolve(keyRefFor(body.route)))?.value ?? '';
      } catch {
        key = '';
      }
    }
    const models = await discoverModels({ api, baseURL, key, ...(deps.fetch ? { fetchImpl: deps.fetch } : {}) });
    return { ok: true, models: models.slice(0, 500) };
  }
  const codexSync = createCodexSync({
    file: codexAuthFile(home),
    readRecord: async () => {
      const r = await service(ctx, 'credentials')?.readRecord?.(CODEX_KEY);
      return r?.kind === 'grant' ? r.payload : undefined;
    },
    writeRecord: async (cred) => {
      await creds().modifyRecord(CODEX_KEY, async () => ({ kind: 'grant', payload: cred }));
    },
    log: (line) => ctx.logger?.info?.(`bots: ${line}`),
  });
  async function connectLogin(id) {
    if (id !== 'codex') throw new Error('this login cannot be used here');
    const a = readCodexAuth(codexAuthFile(home));
    if (!a.ok) throw new Error(a.reason === 'api-key' ? 'the Codex CLI is signed in with an API key, not a ChatGPT login' : 'no Codex CLI login found; run `codex login` first');
    // Harness signed in to ChatGPT by itself: that login is used as it is, never replaced.
    const existing = await service(ctx, 'credentials')?.readRecord?.(CODEX_KEY);
    if (existing && !settings.get().codex.sync) throw new Error('Harness is already signed in to ChatGPT (Settings → Models); its models are in the list already');
    await creds().modifyRecord(CODEX_KEY, async () => ({ kind: 'grant', payload: codexCredential(a) }));
    const created = !piProviders()[CODEX_ROUTE];
    if (created) await writeProvider(CODEX_ROUTE, { displayName: 'ChatGPT (Codex)' });
    settings.save({ codex: { sync: true, route: created || settings.get().codex.route } });
    return { ok: true, route: CODEX_ROUTE };
  }
  async function disconnectLogin(id) {
    if (id !== 'codex') throw new Error('unknown login');
    const { sync, route } = settings.get().codex;
    if (!sync) return { ok: true };
    settings.save({ codex: { sync: false, route: false } });
    try {
      await creds().deleteRecord(CODEX_KEY);
    } catch {
      // Gone already.
    }
    // Only what connecting added goes: a route the user had configured before stays.
    if (route && piProviders()[CODEX_ROUTE]) {
      await writeProvider(CODEX_ROUTE, undefined);
      for (const b of store.list()) if (b.model?.provider === CODEX_ROUTE) store.save({ id: b.id, model: null });
    }
    return { ok: true };
  }
  ctx.on('credentials/record-updated', (key) => {
    if (String(key) !== CODEX_KEY || !settings.get().codex.sync) return;
    const t = setTimeout(() => void codexSync.syncOnce().catch((error) => ctx.logger?.warn?.(`bots: codex login sync: ${error?.message ?? error}`)), 500);
    t.unref?.();
  });

  // --- upkeep: idle topics, the daily dream, the borrowed login --------------------------------
  let sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const bot of store.list()) await autoTopic(bot, 'sweep');
      if (dreamDue()) await dream({ reason: 'schedule' }).catch((error) => ctx.logger?.warn?.(`bots: dream: ${error?.message ?? error}`));
      if (settings.get().codex.sync) await codexSync.syncOnce().catch((error) => ctx.logger?.warn?.(`bots: codex login sync: ${error?.message ?? error}`));
    } finally {
      sweeping = false;
    }
  }
  if (deps.sweep !== false) {
    ctx.effect(() => {
      const timer = setInterval(() => void sweep(), deps.sweepMs ?? SWEEP_MS);
      timer.unref?.();
      const first = setTimeout(() => void sweep(), 30_000);
      first.unref?.();
      return () => {
        clearInterval(timer);
        clearTimeout(first);
      };
    }, 'bots: topics and memory upkeep');
  }

  // --- usage, memory and settings for the page ---------------------------------------------------
  function usageReport(url) {
    const tz = url.searchParams.has('tz') ? Number(url.searchParams.get('tz')) : NaN;
    const overrides = settings.get().prices;
    const catalog = prices.peek();
    const running = [...openTasks.values()].map(({ log, size, replied, ...t }) => t);
    const r = report(
      { calls: ledger.calls(), tasks: ledger.tasks(), running },
      { range: url.searchParams.get('range') || '7d', bot: url.searchParams.get('bot') || '', tz: Number.isFinite(tz) ? tz : tzMinutes(), price: (m) => priceOf(m, overrides, catalog), schedules: scheduleTitles },
    );
    return { ...r, priceList: prices.status() };
  }
  function pricesView() {
    const overrides = settings.get().prices;
    const catalog = prices.peek();
    const seen = new Map();
    for (const r of ledger.calls()) if (r.m && !seen.has(r.m)) seen.set(r.m, r.p);
    return {
      overrides,
      list: prices.status(),
      models: [...seen].map(([model, provider]) => ({ model, provider, price: priceOf(model, overrides, catalog) })).sort((a, b) => a.model.localeCompare(b.model)),
    };
  }
  function memoryView(scope) {
    const tz = tzMinutes();
    const dreamState = memory.dreamState();
    if (!scope || scope === 'team') {
      return { scope: 'team', notes: memory.notes('team'), digests: memory.digests().slice(-30).reverse(), journal: memory.journal({ limit: 150 }).reverse(), dream: dreamState, settings: settings.get().memory, tz };
    }
    const bot = store.get(scope);
    if (!bot) return { ok: false, reason: 'no such bot' };
    return {
      scope: bot.id,
      notes: memory.notes(bot.id),
      journal: memory.journal({ bot: bot.id, limit: 100 }).reverse(),
      topic: topics.peek(bot.id),
      topics: topics.history(bot.id).slice(0, 20),
      model: memoryModelOf(bot),
      settings: settings.get().memory,
      tz,
    };
  }

  /** A bot as the page sees it: channel tokens masked. */
  const publicBot = (bot) => (bot ? maskBot(bot, templates()) : bot);

  function state() {
    const tpl = templates();
    const today = todayByBot(ledger.calls(), tzMinutes());
    const bots = store.list().map((b) => {
      const appIssues = {};
      for (const app of b.apps) {
        const entry = channelEntry(app, tpl);
        if (entry) {
          const issue = channelIssue(app, entry);
          if (issue) appIssues[app.id] = issue;
          continue;
        }
        try {
          mcpConfigOf(app, b);
        } catch (error) {
          appIssues[app.id] = error?.message ?? String(error);
        }
      }
      const skills = b.skills.map((s) => {
        if (s.source === 'dsh' && !s.description && dshSkillInfo.get(s.name)) return { ...s, description: dshSkillInfo.get(s.name) };
        if (!s.linked) return s;
        // A linked folder is shown as it is now, or flagged when it is gone.
        const live = readLinkedSkill(s.dir);
        return live ? { ...s, description: live.description || s.description, content: live.content } : { ...s, missing: true };
      });
      const topic = topics.peek(b.id);
      return {
        ...publicBot(b),
        skills,
        status: botStatus(b),
        appIssues,
        channels: channels.view(b),
        topic: topic && topic.sessionId === b.sessionId ? { startedAt: topic.startedAt, lastActiveAt: topic.lastActiveAt, tasks: topic.tasks, context: topic.lastPrompt } : null,
        usageToday: today[b.id] ?? 0,
        memoryNotes: memory.notes(b.id).length,
      };
    });
    const sessionMap = {};
    for (const b of bots) if (b.sessionId) sessionMap[b.sessionId] = b.id;
    return { bots, primaryId: store.primary()?.id ?? null, sessionMap, messageCount: store.messageCount(), version: store.version(), limits: { skills: MAX_SKILLS, skillsOn: MAX_SKILLS_ON }, teamNotes: memory.notes('team').length };
  }

  let ocuInstalling = false;
  // --- skills from elsewhere -------------------------------------------------------
  const skillDir = join(dir, 'skills');
  /** Import one skill (local folder, GitHub folder or URL) as a bot skill object, files kept under the cache. */
  async function importSkill(spec) {
    const signal = AbortSignal.timeout(120_000);
    const id = `skill-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (typeof spec.local === 'string' && spec.local.trim() !== '') return { id, source: 'import', enabled: true, ...linkLocalSkill(spec.local) };
    const gh = spec.repo ? { ...parseGithub(spec.repo), ...(spec.path !== undefined ? { path: spec.path } : {}), ...(spec.ref ? { ref: spec.ref } : {}) } : parseGithub(spec.url ?? '');
    if (gh) {
      const got = await importGithubSkill(gh, skillDir, id, { signal });
      return { id, source: 'import', enabled: true, ...got };
    }
    if (/^https?:\/\//.test(String(spec.url ?? ''))) return { id, source: 'import', enabled: true, ...(await importUrlSkill(spec.url, { signal })) };
    throw new Error('give a local folder, a GitHub repository or folder (owner/repo/path) or a SKILL.md URL');
  }
  /** Remove copied skill folders nothing points at any more (only ever inside the bots cache). */
  function dropSkillDirs(skills) {
    const used = new Set(store.list().flatMap((b) => b.skills.map((s) => s.dir).filter(Boolean)));
    for (const s of skills) {
      if (typeof s.dir === 'string' && s.dir.startsWith(skillDir + sep) && !used.has(s.dir)) rmSync(s.dir, { recursive: true, force: true });
    }
  }
  /** Folders on this machine where other agents keep skills, as one-click starting points. */
  function localSkillPlaces() {
    const home = homedir();
    return [join(home, '.claude', 'skills'), join(home, '.codex', 'skills'), join(home, '.agents', 'skills')]
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      })
      .map((p) => ({ path: p, label: `~${p.slice(home.length)}` }));
  }

  // --- teams -------------------------------------------------------------------------
  async function teamsView() {
    const names = new Set((await dshSkills()).map((x) => x.name));
    const appIds = new Set(templates().map((t) => t.id));
    return TEAMS.map((t) => teamView(t, { dshSkillNames: names, appIds }));
  }

  /**
   * Hire a team: create its bots (handles made unique), attach the Harness skills it has,
   * import the GitHub skills it names, add its apps (left for the user to fill keys),
   * schedule its tasks, and make its lead the dispatcher. Returns what was skipped.
   */
  async function hireTeam(teamId, lang, { primary = true } = {}) {
    const team = TEAMS.find((t) => t.id === teamId);
    if (!team) throw new Error(`no team "${teamId}"`);
    const zh = lang === 'zh';
    const pick = (v) => (zh ? v.zh : v.en);
    const have = new Map((await dshSkills()).map((x) => [x.name, x.description]));
    const tpl = templates();
    const created = [];
    const skipped = [];
    const imports = new Map();
    for (const b of team.bots) {
      const skills = [];
      for (const n of b.dshSkills ?? []) {
        if (have.has(n)) skills.push({ name: n, source: 'dsh', description: have.get(n) ?? '', enabled: true });
        else skipped.push({ bot: b.handle, kind: 'skill', name: n });
      }
      for (const spec of b.importSkills ?? []) {
        const key = `${spec.repo}/${spec.path}`;
        try {
          if (!imports.has(key)) imports.set(key, importSkill(spec));
          const got = await imports.get(key);
          skills.push({ ...got, id: undefined });
        } catch (error) {
          skipped.push({ bot: b.handle, kind: 'skill', name: spec.path.split('/').pop(), reason: error?.message ?? String(error) });
        }
      }
      const apps = [];
      for (const id of b.apps ?? []) {
        const t = tpl.find((x) => x.id === id);
        if (!t) {
          skipped.push({ bot: b.handle, kind: 'app', name: id });
          continue;
        }
        apps.push({ template: t.id, name: pick(t.name), serverName: t.serverName, enabled: true, values: {} });
      }
      const deny = [];
      // Team bots never need to reconfigure Harness itself; plugin management starts off.
      for (const off of [...new Set([...(b.off ?? []), 'plugins'])]) for (const t of ABILITIES.find((a) => a.id === off)?.tools ?? []) deny.push(t);
      // The seeded dispatcher (or any bot with this handle that is not in another team) becomes this member.
      const existing = store.list().find((x) => x.handle === b.handle && (!x.team || x.team === team.id));
      const bot = store.save(
        {
          ...(existing ? { id: existing.id, skills: [...existing.skills.filter((x) => !skills.some((y) => y.name === x.name)), ...skills], apps: [...existing.apps.filter((x) => !apps.some((y) => y.serverName === x.serverName)), ...apps] } : {}),
          name: pick(b.name),
          handle: existing ? b.handle : store.find(b.handle) ? '' : b.handle,
          bio: pick(b.bio),
          persona: pick(b.persona),
          // Same letters in both languages: from the English name ("Atlas" → AT), not "Atlas 幕僚长".
          avatar: { kind: 'initials', text: initialsOf(b.name.en), color: b.color },
          role: b.role === 'primary' && primary ? 'primary' : existing?.role === 'primary' ? 'primary' : 'bot',
          ...(existing ? {} : { skills, apps }),
          tools: { deny },
          team: team.id,
        },
        { createdBy: 'user' },
      );
      created.push({ bot, spec: b });
    }
    // Scheduled tasks need each bot's conversation; create them after all bots exist.
    for (const { bot, spec } of created) {
      for (const task of spec.tasks ?? []) {
        try {
          await scheduleSave(bot, { title: pick(task.title), prompt: pick(task.prompt), timing: teamTiming(task.when, zone) });
        } catch (error) {
          skipped.push({ bot: bot.handle, kind: 'schedule', name: pick(task.title), reason: error?.message ?? String(error) });
        }
      }
    }
    const lead = created.find((c) => c.spec.role === 'primary')?.bot;
    return { team: team.id, bots: created.map((c) => store.get(c.bot.id)), leadId: lead?.id ?? null, kickoff: pick(team.kickoff), skipped };
  }

  const unfurlLink = createUnfurler();
  const routes = {
    teams: { get: () => teamsView() },
    'teams/hire': {
      post: async (body) => {
        const r = await hireTeam(String(body.id ?? ''), body.lang === 'zh' ? 'zh' : 'en', { primary: body.primary !== false });
        return { ok: true, ...r, bots: r.bots.map(publicBot) };
      },
    },
    'skills/library': { get: async () => ({ skills: await dshSkills(), sources: SKILL_SOURCES }) },
    'skills/github': {
      post: async (body) => {
        const loc = parseGithub(String(body.repo ?? body.url ?? ''));
        if (!loc) return { ok: false, reason: 'give owner/repo, owner/repo/path or a github.com URL' };
        return { ok: true, ...(await listGithubSkills(loc, { signal: AbortSignal.timeout(60_000) })) };
      },
    },
    'skills/import': {
      post: async (body) => {
        const bot = store.get(String(body.botId ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        const specs = Array.isArray(body.items) ? body.items : [body];
        const added = [];
        const failed = [];
        for (const spec of specs.slice(0, 30)) {
          try {
            added.push(await importSkill(spec));
          } catch (error) {
            failed.push({ spec, reason: error?.message ?? String(error) });
          }
        }
        // No doubles: a name the bot already has is updated (same origin) or skipped, never added again.
        const merged = mergeImported(store.get(bot.id).skills, added);
        const changed = merged.added.length + merged.updated.length > 0;
        const saved = changed ? store.save({ id: bot.id, skills: merged.skills }) : store.get(bot.id);
        dropSkillDirs(merged.dropped);
        return {
          ok: changed || failed.length === 0,
          bot: publicBot(saved),
          added: merged.added,
          updated: merged.updated,
          off: merged.off,
          skipped: merged.skipped,
          failed,
          ...(failed.length && !changed ? { reason: failed[0].reason } : {}),
        };
      },
    },
    'skills/local': {
      get: () => ({ places: localSkillPlaces() }),
      post: (body) => {
        try {
          return { ok: true, ...listLocalSkills(String(body.path ?? '')) };
        } catch (error) {
          return { ok: false, reason: error?.message ?? String(error), path: resolveLocalPath(String(body.path ?? '')) };
        }
      },
    },
    'skills/write': {
      post: async (body) => {
        // The bot writes its own skill: a DM asking it to draft one with skill-creator and save it with bot_update.
        const bot = store.get(String(body.botId ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        const ask = String(body.text ?? '').trim();
        if (!ask) return { ok: false, reason: 'describe the skill' };
        const zhText = /[\u4e00-\u9fff]/.test(ask);
        const text = zhText
          ? `请为你自己写一个新技能：${ask}\n\n如果有 skill-creator 技能，先加载它并按它的方法写。写好后调用 bot_update（bot: @${bot.handle}，add_skills）保存：name 用小写英文短横线，description 一句话写清楚何时使用，content 是完整的 Markdown 指南。最后用两三句话告诉我这个技能能做什么。`
          : `Write a new skill for yourself: ${ask}\n\nIf the skill-creator skill is available, load it and follow it. Save the result with bot_update (bot: @${bot.handle}, add_skills): a lowercase-dashed name, a one-sentence description of when to use it, and the full Markdown instructions as content. Then tell me in two or three sentences what the skill does.`;
        return { ok: true, sessionId: await userSend(bot, text) };
      },
    },
    'apps/external': { get: () => ({ items: scanExternalMcp().map(maskedApp) }) },
    'apps/import': {
      post: (body) => {
        const bot = store.get(String(body.botId ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        const wanted = new Set((Array.isArray(body.names) ? body.names : []).map(String));
        const found = scanExternalMcp().filter((a) => wanted.has(`${a.from}/${a.name}`));
        const taken = new Set(bot.apps.map((a) => a.serverName));
        const apps = found.map((a) => {
          let serverName = a.serverName;
          for (let n = 2; taken.has(serverName); n += 1) serverName = `${a.serverName.slice(0, 29)}-${n}`;
          taken.add(serverName);
          return { template: a.template, name: a.name, serverName, enabled: true, config: a.config, values: {} };
        });
        const saved = store.save({ id: bot.id, apps: [...bot.apps, ...apps] });
        return { ok: true, bot: publicBot(saved), added: apps.map((a) => a.name) };
      },
    },
    // The first read fills Harness skill descriptions for skills stored without one.
    state: { get: async () => (dshSkillInfo.size ? state() : dshSkills().then(state, state)) },
    catalog: { get: () => catalog() },
    // A link preview card for the chat: YouTube, X posts, or any page's OpenGraph meta.
    unfurl: { get: (url) => unfurlLink(url.searchParams.get('url') ?? '') },
    messages: {
      get: (url) => ({ items: store.messages({ bot: url.searchParams.get('bot') ?? '', limit: Number(url.searchParams.get('limit')) || 200 }) }),
    },
    schedules: {
      get: async (url) => {
        const id = url.searchParams.get('bot');
        const bot = id ? store.get(id) : null;
        if (id && !bot) return { items: [] };
        if (bot && !bot.sessionId) return { items: [] };
        return { items: await schedulesOf(bot) };
      },
    },
    save: {
      post: (body) => {
        const prev = body.bot?.id ? store.get(body.bot.id) : undefined;
        const input = { ...(body.bot ?? {}) };
        delete input.sessionId;
        delete input.status;
        if (prev?.avatar?.kind === 'image' && input.avatar?.kind === 'image') input.avatar = { ...input.avatar, url: prev.avatar.url };
        // The page holds channel tokens masked; a mask sent back keeps the stored token.
        if (Array.isArray(input.apps)) input.apps = unmaskApps(input.apps, prev?.apps ?? [], templates());
        const bot = store.save(input, { createdBy: 'user' });
        applyModel(bot);
        return { ok: true, bot: { ...publicBot(bot), status: botStatus(bot) } };
      },
    },
    delete: {
      post: async (body) => {
        const bot = store.get(String(body.id ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        if (bot.role === 'primary' && store.list().length > 1) return { ok: false, reason: 'Make another bot the dispatcher first.' };
        await removeBot(bot);
        return { ok: true };
      },
    },
    primary: { post: (body) => ({ ok: store.setPrimary(String(body.id ?? '')) }) },
    open: {
      post: async (body) => {
        const bot = store.get(String(body.id ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        return { ok: true, sessionId: await ensureSession(bot) };
      },
    },
    send: {
      post: async (body) => {
        const bot = store.get(String(body.to ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        return { ok: true, sessionId: await userSend(bot, body.text) };
      },
    },
    avatar: {
      post: (body) => {
        const bot = store.get(String(body.id ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(String(body.dataUrl ?? ''));
        if (!m) return { ok: false, reason: 'send a PNG, JPEG, WebP or GIF image' };
        const bytes = Buffer.from(m[2], 'base64');
        if (bytes.length > MAX_AVATAR) return { ok: false, reason: 'the image is larger than 2 MB' };
        mkdirSync(join(dir, 'avatars'), { recursive: true });
        writeFileSync(join(dir, 'avatars', bot.id), bytes);
        writeFileSync(join(dir, 'avatars', `${bot.id}.type`), m[1]);
        const saved = store.patch(bot.id, { avatar: { kind: 'image', url: `${R}/avatar/${bot.id}?v=${Date.now().toString(36)}`, color: bot.avatar.color } });
        return { ok: true, bot: publicBot(saved) };
      },
    },
    'avatar/generate': {
      post: async (body) => {
        const bot = store.get(String(body.id ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        return { ok: true, bot: publicBot(await generateAvatar(bot, body.style)) };
      },
    },
    'avatar/clear': {
      post: (body) => {
        const bot = store.get(String(body.id ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        for (const f of [bot.id, `${bot.id}.type`]) rmSync(join(dir, 'avatars', f), { force: true });
        return { ok: true, bot: publicBot(store.patch(bot.id, { avatar: { kind: 'initials', color: bot.avatar.color } })) };
      },
    },
    'ocu/install': {
      post: async () => {
        if (ocuInstalling) return { ok: false, reason: 'an install is already running' };
        ocuInstalling = true;
        try {
          const result = await installOcu({ signal: AbortSignal.timeout(300_000) });
          // Bots already running with the app retry it now instead of at their next start.
          const live = agents();
          for (const bot of store.list()) {
            if (!bot.sessionId || !bot.apps.some((a) => a.enabled && a.template === 'open-computer-use')) continue;
            const agent = live?.get?.(bot.sessionId);
            if (!agent) continue;
            uninstall(bot.sessionId);
            reconcile(agent);
          }
          return { ok: true, version: result.version, path: result.path, ocu: { installed: true, path: result.path } };
        } finally {
          ocuInstalling = false;
        }
      },
    },
    'schedules/save': {
      post: async (body) => {
        const bot = store.get(String(body.botId ?? ''));
        if (!bot && !body.id) return { ok: false, reason: 'no such bot' };
        return { ok: true, task: await scheduleSave(bot, body) };
      },
    },
    'schedules/delete': { post: async (body) => (checkEntry(await schedule().edit({ id: String(body.id ?? ''), action: 'delete' })), { ok: true }) },
    'schedules/toggle': {
      post: async (body) => ({ ok: true, task: entryView(checkEntry(await schedule().edit({ id: String(body.id ?? ''), action: 'update', patch: { active: body.active === true } }))) }),
    },
    'schedules/run': { post: async (body) => (checkEntry(await schedule().run({ id: String(body.id ?? '') })), { ok: true }) },
    // Usage, prices, memory, topics, settings, model sources.
    usage: { get: (url) => usageReport(url) },
    prices: {
      get: () => pricesView(),
      post: (body) => {
        const model = String(body.model ?? '').trim().toLowerCase();
        if (!model) return { ok: false, reason: 'which model?' };
        const next = { ...settings.get().prices };
        if (body.price === null) delete next[model];
        else next[model] = body.price;
        settings.save({ prices: next });
        return { ok: true, ...pricesView() };
      },
    },
    'prices/refresh': { post: async () => (await prices.refresh(true), { ok: true, ...pricesView() }) },
    settings: {
      get: () => ({ settings: settings.get() }),
      post: (body) => {
        const patch = body.patch && typeof body.patch === 'object' ? { ...body.patch } : {};
        delete patch.codex;
        delete patch.prices;
        return { ok: true, settings: settings.save(patch) };
      },
    },
    memory: { get: (url) => memoryView(url.searchParams.get('bot') ?? 'team') },
    'memory/put': {
      post: (body) => {
        const scope = body.scope === 'team' ? 'team' : store.get(String(body.scope ?? ''))?.id;
        if (!scope) return { ok: false, reason: 'no such bot' };
        const note = memory.put(scope, body.note ?? {});
        staleMemory();
        return { ok: true, note };
      },
    },
    'memory/delete': {
      post: (body) => {
        const scope = body.scope === 'team' ? 'team' : store.get(String(body.scope ?? ''))?.id;
        if (!scope) return { ok: false, reason: 'no such bot' };
        const ok = memory.remove(scope, String(body.id ?? ''));
        if (ok) staleMemory();
        return { ok };
      },
    },
    'memory/dream': { post: async () => ({ ok: true, result: await dream({ reason: 'manual' }) }) },
    'topic/new': {
      post: async (body) => {
        const bot = store.get(String(body.id ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        return { ok: true, sessionId: await newTopic(bot, 'manual') };
      },
    },
    'models/sources': { get: () => modelSources() },
    'models/custom/test': { post: (body) => testEndpoint(body) },
    'models/custom/save': { post: (body) => saveEndpoint(body) },
    'models/custom/delete': { post: (body) => deleteEndpoint(String(body.route ?? '')) },
    'models/login/connect': { post: (body) => connectLogin(String(body.id ?? '')) },
    'models/login/disconnect': { post: (body) => disconnectLogin(String(body.id ?? '')) },
    // Chat channels: a pairing code, forgetting a paired person, options, reconnecting.
    'channels/code': { post: (body) => ({ ok: true, ...channels.newCode(String(body.botId ?? ''), String(body.appId ?? '')) }) },
    'channels/unpair': {
      post: (body) => (channels.unpair(String(body.botId ?? ''), String(body.appId ?? ''), String(body.userId ?? '')) ? { ok: true } : { ok: false, reason: 'no such paired person' }),
    },
    'channels/options': {
      post: (body) => ({ ok: true, ...channels.setOptions(String(body.botId ?? ''), String(body.appId ?? ''), { ...(typeof body.scheduleReplies === 'boolean' ? { scheduleReplies: body.scheduleReplies } : {}) }) }),
    },
    'channels/reconnect': { post: (body) => ({ ok: channels.reconnect(String(body.botId ?? ''), String(body.appId ?? '')) }) },
  };

  const mountRoutes = (scope) => {
    const web = scope.webServer;
    if (!web?.register) return;
    for (const [path, route] of Object.entries(routes)) {
      scope.effect(() =>
        web.register({
          kind: 'exact',
          path: `${R}/${path}`,
          handler: (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (req.method === 'GET' && route.get) return serveJson(res, () => route.get(url));
            if (route.post) return postJson(req, res, route.post);
            res.statusCode = 405;
            res.end();
          },
        }),
      );
    }
    scope.effect(() => web.register({ kind: 'prefix', path: `${R}/avatar`, handler: (req, res) => serveAvatar(dir, req, res) }));
    scope.effect(() => web.register({ kind: 'prefix', path: `${R}/logo`, handler: (req, res) => serveLogo(req, res) }));
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountRoutes);
  else if (ctx.webServer) mountRoutes({ webServer: ctx.webServer, effect: (fn) => ctx.effect(fn) });

  return { store, state, deliver, install, reconcile, installed, routes, channels, memory, ledger, topics, settings, newTopic, dream, sweep, userSend, openTasks, codexSync, finishTask };
}

function serveAvatar(dir, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = decodeURIComponent(url.pathname.slice(`${R}/avatar/`.length));
  const file = join(dir, 'avatars', id);
  let size = 0;
  let type = 'image/png';
  try {
    if (!/^bot-[a-z0-9]+$/.test(id)) throw new Error('bad id');
    size = statSync(file).size;
    type = readSmall(`${file}.type`) || type;
  } catch {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', type);
  res.setHeader('content-length', String(size));
  res.setHeader('cache-control', 'private, max-age=31536000, immutable');
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

const LOGO_DIR = fileURLToPath(new URL('./logos/', import.meta.url));

/** `${R}/logo/<name>.png`: an app logo shipped with the plugin. */
export function serveLogo(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const m = /^([a-z0-9-]+)\.png$/.exec(decodeURIComponent(url.pathname.slice(`${R}/logo/`.length)));
  const file = m && isLogoName(m[1]) ? join(LOGO_DIR, `${m[1]}.png`) : '';
  let size = 0;
  try {
    if (!file) throw new Error('bad name');
    size = statSync(file).size;
  } catch {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'image/png');
  res.setHeader('content-length', String(size));
  res.setHeader('cache-control', 'public, max-age=86400');
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

function readSmall(path) {
  try {
    return statSync(path).size < 100 ? readFileSync(path, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

function postJson(req, res, produce) {
  const type = String(req.headers?.['content-type'] ?? '');
  if (req.method !== 'POST' || !/^application\/json\b/i.test(type)) {
    res.statusCode = req.method === 'POST' ? 415 : 405;
    res.end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size <= 4 * 1024 * 1024) chunks.push(chunk);
  });
  req.on('end', () => {
    serveJson(res, () => {
      if (size > 4 * 1024 * 1024) return { ok: false, reason: 'request too large' };
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return { ok: false, reason: 'bad-request' };
      }
      return produce(body && typeof body === 'object' ? body : {});
    });
  });
}

function serveJson(res, produce) {
  Promise.resolve()
    .then(produce)
    .then((body) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    })
    .catch((error) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, reason: error?.message ?? 'error' }));
    });
}
