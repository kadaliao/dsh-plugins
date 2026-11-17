/**
 * Host half of the bots bundle: Grok-style bots inside DeepSeek Harness.
 *
 * A bot is a named persona with its own conversation (a DSH Session, its
 * "home"), avatar, skills, tool access, apps (MCP servers, e.g.
 * open-computer-use) and scheduled tasks. One bot is the dispatcher that
 * delegates work and schedules tasks.
 *
 * How bots hand work to each other depends on the team's `dispatcher` setting:
 *
 * - `router` (the default since 0.8): `bot_send_message` from a bot's home opens
 *   a ticket (lib/tickets.mjs) for the other bot, which works on it in a
 *   Session of its own (`ticket-<id>`) and reports back with a status; the
 *   dispatcher's home only understands, hands out and reports (its tools are
 *   limited and it may not wait). At most `tickets.maxWorking` ticket Sessions
 *   run at once; the rest queue.
 * - `hands-on` (0.7): `bot_send_message` drops the text into the other bot's
 *   home inbox, which wakes it; the reply travels back the same way.
 *
 * A ticket Session works the same way in both modes: reports go to whoever
 * asked, and asking another bot opens a sub-ticket.
 *
 * Everything a bot is made of is applied to its Agent's own scope when that
 * Agent comes up (and re-applied when the bot changes): a persona prompt
 * section, runtime skills, a tool restriction and agent-scoped MCP clients. A
 * ticket Session is decorated as its executing bot the same way. Nothing
 * touches other conversations, except the bot tools themselves, which every
 * conversation gets so the user can manage bots from anywhere.
 *
 * Chat channel apps (Telegram, Discord, Feishu / Lark, Slack) are no MCP servers: lib/channels.mjs
 * keeps a connector running for each, so paired people can message the team
 * from that chat app and read the replies there.
 *
 * @module @kadaliao/dsh-bots
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
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
import { askNoticeText, CHANNEL_LABELS, channelEntry, channelIssue, createChannels, credentialsOf, maskBot, threadNote, unmaskApps } from './lib/channels.mjs';
import { createActivity } from './lib/activity.mjs';
import { describeTiming, dmBody, dmHeader, noWaitReason, personaText, reportsGoDirect, ROUTER_DENY, textOf, timingFrom, timingOfEntry } from './lib/prompt.mjs';
import { createSettings } from './lib/settings.mjs';
import { createPriceCatalog, priceOf } from './lib/prices.mjs';
import { createLedger, promptTokens, report, ticketUsage, todayByBot, usageRow } from './lib/usage.mjs';
import { createSlots, createTickets, parkedOf, REPORT_STATUSES, sessionIdOf, stageOf } from './lib/tickets.mjs';
import { assignmentText, clip, failedNoticeText, followUpNoticeText, nudgeText, panelHeaderText, PREVIEW_CHARS, readResource, recoveryNoteText, reminderText, reportRelayText, retryText, shownNoticeText, stalledNoticeText } from './lib/cards.mjs';
import { checkTickets, isTransient, requesterReminders, retryDelay } from './lib/watchdog.mjs';
import { isLiveSubscriber, isPanelThread, isTopicThread, panelThreadKey, panelTopicOf, parseThreadKey, threadLabel, toThreadKey } from './lib/threads.mjs';
import { createMemory, dreamBotPrompt, dreamTeamPrompt, KINDS as MEMORY_KINDS, looksSecret, parseJsonReply, reflectionPrompt, searchTickets } from './lib/memory.mjs';
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
/** A message whose id the caller chose (an idempotent delivery); detached and frozen like Harness's own. */
const freezeMessage = llmModule?.freezeMessage ?? ((message) => Object.freeze(structuredClone(message)));

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

export const TOOL_NAMES = ['bot_list', 'bot_create', 'bot_update', 'bot_delete', 'bot_send_message', 'bot_reply', 'bot_recall', 'bot_ticket', 'bot_schedule', 'memory_save', 'memory_forget', 'memory_search'];
/** Message ids of the plugin's own deliveries start with this, so a retry can tell it already delivered one. */
const MESSAGE_PREFIX = 'bots:';
/**
 * Relays about a ticket, by the kind in their message id (`bots:<kind>:<ticketId>:…`). These are
 * inputs of the requester's turn: the ticket's origin Thread joins it (replies to the person go there).
 */
const RELAY_KINDS = new Set(['report', 'failed', 'stalled']);
/** When queued tickets are first launched after the plugin starts (Harness services settle first); working ones get their recovery notes then. */
const STARTUP_PUMP_MS = 3000;
/** Events read from the end of a Session's stored log for its delivered message ids, and the largest log read at all. */
const HISTORY_TAIL = 4000;
const HISTORY_MAX_BYTES = 32 * 1024 * 1024;
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
 * @param {{loadConnector?: (kind: string) => Promise<object>, typingEveryMs?: number, now?: () => number,
 *   setTimeout?: Function, clearTimeout?: Function}} [deps] - for tests: a stand-in chat connector; the clock and
 *   the timers the task watchdog (status checks, retries after temporary errors) runs on.
 */
export function apply(ctx, config, deps = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const dir = join(homeDir(), 'cache', 'bots');
  const nowMs = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const store = createStore(dir);
  const settings = createSettings(dir);
  const ledger = createLedger(dir);
  const memory = createMemory(join(dir, 'memory'));
  const topics = createTopics(dir);
  const tickets = createTickets(dir, { now: nowMs });
  // A tasks file that is there but cannot be read stops the plugin now, before anything writes over it.
  try {
    tickets.open();
  } catch (error) {
    (ctx.logger?.error ?? ctx.logger?.warn)?.call(ctx.logger, `bots: not starting: ${error?.message ?? error}`);
    throw error;
  }
  const slots = createSlots(settings.get().tickets.maxWorking);
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
  /** Bots from an earlier version: this team was there before 0.8 made router mode the default. */
  const hadBots = store.list().length > 0;
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

  // The first run of 0.8 decides once whether the panel tells the user that the dispatcher now routes.
  if (settings.get().routerNotice === null) {
    try {
      settings.save({ routerNotice: hadBots ? 'pending' : 'dismissed' });
    } catch {
      // Asked again at the next start.
    }
  }

  // --- which bot a conversation belongs to ---------------------------------------------
  /** Ticket Sessions the controller named something other than `ticket-<id>`. */
  const otherTicketSessions = new Set();
  /** The ticket a Session runs, if it is a ticket Session. */
  const ticketOf = (sessionId) => (typeof sessionId === 'string' && (sessionId.startsWith('ticket-') || otherTicketSessions.has(sessionId)) ? tickets.bySession(sessionId) : undefined);
  // --- what each bot does right now (the panel's live status) -----------------------------
  /** The tokens of every chat app, kept out of what the page is shown of a running tool. */
  function channelSecrets() {
    const tpl = templates();
    const out = [];
    for (const b of store.list()) {
      for (const app of b.apps) {
        const entry = channelEntry(app, tpl);
        if (entry) out.push(...credentialsOf(app, entry).secrets);
      }
    }
    return out;
  }
  const activity = createActivity({ now: nowMs, secrets: channelSecrets, handleOf: (ref) => (store.find(String(ref)) ? `@${store.find(String(ref)).handle}` : '') });

  /** The bot of a home Session or of a ticket Session (its executing bot). */
  function botOfSession(sessionId) {
    if (!sessionId) return undefined;
    const home = store.bySession(sessionId);
    if (home) return home;
    const t = ticketOf(sessionId);
    return t ? store.get(t.botId) : undefined;
  }
  const dispatcherMode = () => settings.get().dispatcher;
  /**
   * Router mode is in effect: the setting says so and the dispatcher has someone to hand work to. A
   * dispatcher that is the only bot works hands-on (a router alone would have no hands); adding a
   * second bot makes it a router, removing the last teammate makes it hands-on again.
   */
  const routerActive = () => dispatcherMode() === 'router' && store.list().length > 1;
  /** The dispatcher works as a router (in its home; its ticket Sessions are ordinary workers). */
  const isRouter = (bot) => Boolean(bot) && bot.role === 'primary' && routerActive();
  const isRouterHome = (bot, sessionId) => isRouter(bot) && Boolean(sessionId) && bot.sessionId === sessionId && !ticketOf(sessionId);
  /** Bot-to-bot work opens tickets (router mode), or goes to the other bot's home as in 0.7 (hands-on). */
  const ticketsOn = () => dispatcherMode() === 'router';

  /**
   * Questions a bot's home or ticket Session put to the person with `ask_user_question`, by id, while
   * they wait (see "questions a bot asks" below). In memory only: they die with the process, as the
   * tool call does.
   */
  const asks = new Map();
  const askingIn = (sessionId) => Boolean(sessionId) && [...asks.values()].some((a) => a.sessionId === sessionId);
  /** The questions still waiting. One past its timed wait (`continued`) goes with its task's end, or with its home (a new topic). */
  function pendingAsks() {
    for (const a of asks.values()) {
      if (!a.continued) continue;
      const t = a.ticketId ? tickets.get(a.ticketId) : null;
      if (a.ticketId ? !t || t.ended || t.archivedAt : store.get(a.botId)?.sessionId !== a.sessionId) asks.delete(a.id);
    }
    return [...asks.values()];
  }

  // --- applying a bot to its Agent ----------------------------------------------------
  /** sessionId → {agent, signature, disposers[]} */
  const installed = new Map();

  const isChannel = (app) => Boolean(channelEntry(app, templates()));
  // Chat channels run outside the Agent; changing one does not restart the bot's MCP clients.
  // A linked local skill counts by what its SKILL.md is now, so an edit there re-installs it.
  // A router home also changes with the dispatcher mode and the role (its tool limits and guard).
  const signatureOf = (bot, sessionId) =>
    JSON.stringify({ s: bot.skills, l: bot.skills.filter((s) => s.linked && s.enabled).map((s) => readLinkedSkill(s.dir)?.stamp ?? ''), a: bot.apps.filter((a) => !isChannel(a)), t: bot.tools, h: bot.handle, r: isRouterHome(bot, sessionId) ? 1 : 0 });
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
    const sessionId = agent.session.id;
    // A ticket Session is its executing bot working on one task; the persona says so.
    const ticketId = ticketOf(sessionId)?.id ?? '';
    const router = isRouterHome(bot, sessionId);
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
              const ticket = ticketId ? tickets.get(ticketId) : undefined;
              return now
                ? personaText(now, roster, { skillsInline, skillNames, apps: appNames, channels: channelNames(roster), dispatcher: routerActive() ? 'router' : 'hands-on', tickets: ticketsOn(), ...(ticket ? { ticket } : {}) })
                : '';
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
    // A router home is also denied the tools that do the work, except those the user gave back.
    const allowed = new Set(bot.tools.routerAllow ?? []);
    const wanted = [...new Set([...bot.tools.deny, ...(router ? ROUTER_DENY.filter((n) => !allowed.has(n)) : [])])];
    if (wanted.length > 0) {
      const tools = service(actx, 'tools');
      try {
        const view = ctx.tools?.view?.(scopeOf(actx));
        const known = view?.restrictableNames instanceof Set ? view.restrictableNames : new Set((ctx.tools?.definitions?.() ?? []).map((d) => d.name));
        const deny = wanted.filter((n) => known.has(n) && n !== 'run_code');
        if (deny.length > 0 && tools?.restrict) disposers.push(tools.restrict({ deny }));
      } catch (error) {
        ctx.logger?.warn?.(`bots: tool access for @${bot.handle}: ${error?.message ?? error}`);
      }
    }
    if (router) {
      // Even with `bash` given back, a router may not sleep or wait long: reports arrive by themselves.
      const tools = service(actx, 'tools');
      try {
        if (typeof tools?.guard === 'function') disposers.push(tools.guard((execution) => noWaitReason(execution)));
      } catch (error) {
        ctx.logger?.warn?.(`bots: dispatcher guard for @${bot.handle}: ${error?.message ?? error}`);
      }
    }
    installed.set(sessionId, { agent, signature: signatureOf(bot, sessionId), disposers });
  }

  function reconcile(agent) {
    const sessionId = agent?.session?.id;
    if (!sessionId) return;
    const bot = botOfSession(sessionId);
    const rec = installed.get(sessionId);
    if (!bot) {
      if (rec) uninstall(sessionId);
      return;
    }
    if (rec && rec.agent === agent && rec.signature === signatureOf(bot, sessionId)) return;
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
      store.onChange(() => reapply()),
    'bots: re-apply changed bots',
  );
  ctx.effect(() => () => {
    for (const id of [...installed.keys()]) uninstall(id);
  }, 'bots: unwind bot scopes');
  /** Apply every bot again to its live home and ticket Sessions (a bot, the roles or the dispatcher mode changed). */
  function reapply() {
    const live = agents();
    for (const bot of store.list()) {
      const agent = bot.sessionId ? live?.get?.(bot.sessionId) : undefined;
      if (agent) reconcile(agent);
    }
    for (const [sessionId, rec] of [...installed]) {
      if (!botOfSession(sessionId)) uninstall(sessionId);
      else reconcile(rec.agent);
    }
  }

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
      const bot = botOfSession(sessionId);
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
  function startTask(bot, sessionId, kind, event, via, typed) {
    const content = event.data?.content;
    const said = typed ?? textOf(content);
    const sched = kind === 'schedule' ? (/schedule_id_json:\s*"([^"]+)"/.exec(said)?.[1] ?? /"schedule_id":\s*"([^"]+)"/.exec(said)?.[1] ?? '') : '';
    const from = kind === 'agent-message' ? (botOfSession(event.data?.source?.senderSessionId)?.id ?? 'user') : '';
    const ticket = ticketOf(sessionId);
    const task = {
      id: `task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      b: bot.id,
      s: sessionId,
      ...(ticket ? { t: ticket.id } : {}),
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
    // A ticket Session is no topic of the bot's: rotation only ever looks at its home.
    if (!ticket) topics.current(bot.id, sessionId);
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
    const ticketId = ticketOf(sessionId)?.id;
    ledger.record(usageRow({ at, botId: bot.id, sessionId, taskId: kind === 'chat' || kind === 'compaction' ? task?.id : undefined, ticketId, kind, provider, model, usage }));
    if (kind === 'chat' && !ticketId) topics.noteCall(bot.id, sessionId, promptTokens(usage));
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
    if (task.t) {
      // A run of a ticket: its transcript waits for the ticket's end, which is summarized once.
      keepTicketLog(task.t, log);
      const t = tickets.get(task.t);
      if (t?.ended) reflectTicket(t);
      return;
    }
    topics.noteTask(task.b, task.s, task.title);
    if (bot) queueReflection(bot, { ...row, log });
  }
  /** ticketId → transcript lines of its finished runs, for the summary written when it ends. */
  const ticketLogs = new Map();
  function keepTicketLog(ticketId, lines) {
    const rec = ticketLogs.get(ticketId) ?? { log: [], size: 0 };
    for (const line of lines ?? []) logLine(rec, line);
    ticketLogs.set(ticketId, rec);
  }
  /** ticketId → the transcript lines of an ended ticket, kept for bot_recall when Harness keeps no log (the latest 50). */
  const doneLogs = new Map();
  /** A ticket ended: its executing bot summarizes the work into its memory, as after any task. */
  function reflectTicket(t) {
    const rec = ticketLogs.get(t.id);
    ticketLogs.delete(t.id);
    if (rec?.log.length) {
      doneLogs.delete(t.id);
      doneLogs.set(t.id, [...rec.log]);
      if (doneLogs.size > 50) doneLogs.delete(doneLogs.keys().next().value);
    }
    const bot = store.get(t.botId);
    if (!bot || !rec?.log.length) return;
    queueReflection(bot, { id: t.id, ticket: t.id, b: bot.id, s: t.sessionId, trigger: 'ticket', from: t.requester?.botId ?? 'user', title: t.title, log: rec.log });
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
    task.trigger === 'ticket'
      ? `task ${task.ticket} from ${task.from === 'user' ? 'the user' : `@${store.get(task.from)?.handle ?? 'another bot'}`}`
      : task.trigger === 'schedule'
        ? 'a scheduled task'
        : task.trigger === 'dm'
          ? `a message from ${task.from === 'user' ? 'the user' : `@${store.get(task.from)?.handle ?? 'another bot'}`}`
          : task.trigger === 'chat'
            ? `a ${task.via ?? 'chat'} message from the user`
            : 'a message from the user';
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
        ledger.record(usageRow({ botId: bot.id, sessionId: task.s, taskId: task.id, ticketId: task.ticket, kind: 'memory', provider: sel.provider, model: sel.model, usage: r.usage }));
        const parsed = parseJsonReply(r.text) ?? {};
        summary = String(parsed.summary ?? '').trim();
        if (Array.isArray(parsed.notes) && parsed.notes.length) memory.edit(bot.id, parsed.notes, { source: 'auto' });
        if (Array.isArray(parsed.team) && parsed.team.length) memory.edit('team', parsed.team, { source: 'auto' });
      } catch (error) {
        ctx.logger?.warn?.(`bots: summarizing a task of @${bot.handle} failed: ${error?.message ?? error}`);
      }
    }
    if (worth || summary) memory.addJournal({ bot: bot.id, task: task.id, trigger: task.trigger, ...(task.ticket ? { ticket: task.ticket } : {}), title: task.title, summary: summary || task.title });
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
        forgetSession(prev);
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

  const pairRefusal = (sender, target) => new Error(`@${sender.handle} and @${target.handle} exchanged ${PAIR_LIMIT} messages in the last 10 minutes; stop and report to the user instead of continuing.`);

  /**
   * Deliveries the plugin made with an id of its own, per Session: what this process handed over
   * or saw arrive, and (read once per Session, see `loadHistory`) what its stored log says arrived
   * before a restart. With the Agent's pending inbox (durable too) it tells a retry the message is
   * there already.
   */
  const deliveredIds = new Map();
  /**
   * The tail of a Session's stored log (Harness `sessionPersistence`, a read handle beside the live
   * writer), or null when there is no such service, no such Session, the log is too large to read
   * cheaply, or the read comes back in a shape not known here. `deps.history(sessionId)` stands in for tests.
   * @returns {Promise<object[]|null>}
   */
  async function readHistory(sessionId) {
    if (!sessionId) return null;
    if (typeof deps.history === 'function') return (await deps.history(sessionId)) ?? null;
    const persistence = service(ctx, 'sessionPersistence');
    if (typeof persistence?.open !== 'function') return null;
    let snap;
    try {
      snap = await persistence.stat?.(sessionId);
    } catch {
      snap = undefined;
    }
    if (persistence.stat && snap === undefined) return null;
    if (Number(snap?.sizeBytes) > HISTORY_MAX_BYTES) return null;
    let handle;
    try {
      handle = await persistence.open(sessionId, 'read');
      const count = Number(snap?.eventCount);
      const offset = Number.isSafeInteger(count) && count > HISTORY_TAIL ? count - HISTORY_TAIL : 0;
      let read = await handle.read(offset, HISTORY_TAIL);
      if (offset > 0 && !(read?.events?.length > 0)) read = await handle.read(0);
      // A read in a shape not known here tells nothing (null), rather than an empty log.
      return Array.isArray(read?.events) ? read.events : null;
    } catch {
      return null;
    } finally {
      try {
        await handle?.close?.();
      } catch {
        // Closed with the process.
      }
    }
  }
  /** Sessions whose stored log was read for delivered ids in this process. */
  const historyRead = new Map();
  /** Read the delivered ids of `sessionId`'s stored log once per process (cheap: its tail; nothing without the service). */
  function loadHistory(sessionId) {
    if (!sessionId) return Promise.resolve();
    if (!historyRead.has(sessionId)) {
      historyRead.set(
        sessionId,
        readHistory(sessionId)
          .then((events) => {
            for (const e of events ?? []) if (e?.type === 'user/message') noteDelivered(sessionId, e.data?.id);
          })
          .catch(() => {}),
      );
    }
    return historyRead.get(sessionId);
  }
  const noteDelivered = (sessionId, id) => {
    if (!sessionId || typeof id !== 'string' || !id.startsWith(MESSAGE_PREFIX)) return;
    const set = deliveredIds.get(sessionId) ?? new Set();
    set.add(id);
    // Bounded: ids are only needed while a retry of the same request may come.
    if (set.size > 2000) set.delete(set.values().next().value);
    deliveredIds.set(sessionId, set);
  };
  /** An Agent's pending messages: Harness's `{nextTurn, nextStep}` (or a plain list). */
  const pendingOf = (agent) => {
    const inbox = agent?.inbox;
    if (Array.isArray(inbox)) return inbox;
    return [...(Array.isArray(inbox?.nextTurn) ? inbox.nextTurn : []), ...(Array.isArray(inbox?.nextStep) ? inbox.nextStep : [])];
  };
  const holds = (agent, id) => Boolean(deliveredIds.get(agent?.session?.id)?.has(id)) || pendingOf(agent).some((m) => m?.id === id);

  /**
   * Hand one message to an Agent.
   * - `mode`: 'steer' (the current turn's next step, or a new turn when idle: messages that arrive
   *   while it works are taken together), 'followup' (a turn of its own; 0.7's only way) or 'inject'
   *   (into the conversation without waking it). A Harness without `steer` gets a followup; one
   *   without `inject` gets nothing for an 'inject' (`dropped`): such a note never wakes a turn.
   * - `key`: makes the message id `bots:<key>`; a message with that id already pending or delivered
   *   is not delivered again, so a retried request is harmless.
   * @returns {{message: object, mode: string, skipped: boolean, dropped?: true}}
   */
  async function sendTo(agent, { content: blocks, source, mode = 'followup', key }) {
    // Providers that take a message as one string join its blocks with nothing in between:
    // a header block ends its line itself, so the text under it starts on a new one.
    const content = blocks.map((b, i) => (i < blocks.length - 1 && b?.type === 'text' && !b.text.endsWith('\n') ? { ...b, text: `${b.text}\n` } : b));
    const message = key ? freezeMessage({ id: `${MESSAGE_PREFIX}${key}`, role: 'user', content, source }) : createUserMessage({ content, source });
    // A note that must not wake anyone is dropped where Harness cannot inject: it is "good to know", never worth a turn.
    if (mode === 'inject' && typeof agent.inject !== 'function') return { message, mode, skipped: true, dropped: true };
    if (key) await loadHistory(agent.session?.id);
    if (key && holds(agent, message.id)) return { message, mode, skipped: true };
    const how = mode === 'inject' ? 'inject' : mode !== 'followup' && typeof agent.steer === 'function' ? 'steer' : 'followup';
    agent[how](message);
    if (key) noteDelivered(agent.session?.id, message.id);
    await flush(agent);
    return { message, mode: how, skipped: false };
  }
  /** How a bot's home takes new input: a router steers (backlog is handled together), every other home as in 0.7. */
  const homeMode = (bot) => (isRouter(store.get(bot.id) ?? bot) ? 'steer' : 'followup');

  /** A DM from `sender` (a bot, or null for the user) to `target`'s home: 0.7's bot-to-bot message. */
  async function deliver(sender, target, text, senderSessionId) {
    const body = String(text ?? '').trim();
    if (body === '') throw new Error('text must not be empty');
    if (sender && sender.id === target.id) throw new Error('a bot cannot message itself');
    if (sender && !admitPair(sender.id, target.id)) throw pairRefusal(sender, target);
    // A teammate's message may answer this bot's own question: only a long quiet starts a new topic here.
    await autoTopic(store.get(target.id) ?? target, sender ? 'dm' : 'user');
    const agent = await agentOf(store.get(target.id) ?? target);
    await sendTo(agent, {
      content: [
        { type: 'text', text: dmHeader(sender) },
        { type: 'text', text: dmBody(body, sender) },
      ],
      source: senderSessionId ? { kind: 'agent-message', form: 'relay', senderSessionId } : { kind: 'user' },
      mode: homeMode(target),
    });
    store.log({ from: sender ? sender.id : 'user', to: target.id, text: body, kind: 'dm' });
    return agent.session.id;
  }

  // --- the panel chat: topics (Bots 0.9) -------------------------------------------------
  /** A new id for a message typed in the panel: `p` and 8 letters or digits, short enough for a model to copy. */
  const newPanelId = () => {
    for (;;) {
      const id = `p${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      if (!store.message(id)) return id;
    }
  };
  /** Whether a timeline message belongs to `botId`'s panel chat (lib/store.mjs `messages`). */
  const inChat = (m, botId) => Boolean(m) && (m.chat ? m.chat === botId : m.from === botId || m.to === botId);
  /** Who wrote a timeline message, as a header names them. */
  const writerOf = (m) => (m.from === 'user' ? 'the user' : store.get(m.from) ? `@${store.get(m.from).handle}` : 'a bot');
  /** The tasks a dispatcher's panel message may continue: open, or ended within a day; the latest change first. */
  function openTasksOf(bot) {
    const since = nowMs() - 24 * 3600_000;
    return tickets
      .list({ archived: false })
      .filter((t) => t.requester?.botId === bot.id && !t.requester?.ticketId && (!t.ended || t.ended.at >= since))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  /**
   * The topic a panel message goes into: a new one it starts, or for a reply the topic of the
   * message it answers (one filed under another topic counts as there). A message that was in no
   * topic becomes the first of one. `{root, key, quoted}`.
   */
  function topicFor(bot, sessionId, id, replyTo) {
    if (!replyTo) return { root: id, key: panelThreadKey(sessionId, id), quoted: null };
    const quoted = store.message(replyTo);
    if (!quoted || !inChat(quoted, bot.id)) throw new Error('that message is not in this chat');
    const root = quoted.movedTo || quoted.topic || quoted.id;
    const first = root === quoted.id ? quoted : store.message(root);
    const key = first?.thread && panelTopicOf(first.thread) === root ? first.thread : panelThreadKey(sessionId, root);
    if (first && first.topic !== root) store.patchMessage(first.id, { topic: root, thread: key });
    return { root, key, quoted };
  }
  /** A timeline message as the panel reads it: `pending` while no model has taken it yet; internal fields left out. */
  function messageView(m) {
    const { sid, ...rest } = m;
    if (m.from !== 'user' || m.kind !== 'user' || !/^p[a-z0-9]{8}$/.test(m.id)) return rest;
    const waiting = (sessionId, msgId) => pendingOf(agents()?.get?.(sessionId)).some((x) => x?.id === `${MESSAGE_PREFIX}${msgId}`);
    let pending = false;
    if (m.ticket && !sid) {
      const t = tickets.get(m.ticket);
      const key = `panel:${m.id}:${m.ticket}`;
      // Queued (its assignment carries the message), waiting for a worker slot, or not taken yet.
      pending = Boolean(t) && !t.ended && (!t.startedAt || parkedOf(t).some((x) => x.key === key) || (Boolean(t.sessionId) && waiting(t.sessionId, key)));
    } else if (sid) pending = waiting(sid, `panel:${m.id}`);
    return pending ? { ...rest, pending: true } : rest;
  }

  /**
   * The user writes to a bot from the panel. `/new` (or `/clear`, `/新话题`) first starts a new
   * topic of its conversation; text after it goes there. Every message is logged before it is
   * handed over (the panel shows it at once, `pending` until a model takes it) and is a topic of
   * its own, or with `replyTo` joins the topic of that message. A reply in a topic with live tasks
   * goes to them directly (the bot's home hears of it without waking); anything else goes to the
   * bot's home: a router steers it (a header names its topic and the tasks it may continue), other
   * homes take it as a turn of its own. Returns `{sessionId, message?}`.
   */
  async function userSend(target, text, { replyTo = '' } = {}) {
    let body = String(text ?? '').trim();
    if (body === '') throw new Error('text must not be empty');
    const cmd = TOPIC_COMMAND.exec(body);
    if (cmd) {
      const sessionId = await newTopic(target, 'manual');
      body = body.slice(cmd[0].length).trim();
      if (!body) return { sessionId };
    } else await autoTopic(store.get(target.id) ?? target, 'user');
    const bot = store.get(target.id) ?? target;
    const agent = await agentOf(bot);
    const sid = agent.session.id;
    const id = newPanelId();
    const { root, key, quoted } = topicFor(bot, sid, id, String(replyTo ?? '').trim());
    const live = quoted ? tickets.subscribers(key).filter(isLiveSubscriber) : [];
    const base = { id, from: 'user', to: bot.id, chat: bot.id, kind: 'user', text: body, thread: key, topic: root, ...(quoted ? { replyTo: quoted.id } : {}) };
    store.log(base);
    if (live.length) {
      try {
        const sessions = await toTopicTasks(bot, live, body, { key, root, id, quoted });
        return { sessionId: sessions[0] ?? sid, message: messageView(store.message(id)) };
      } catch (error) {
        // No task took it (one ended meanwhile, say): the bot's home does.
        ctx.logger?.warn?.(`bots: a panel reply did not reach its task (${error?.message ?? error}); @${bot.handle} takes it`);
      }
    }
    store.patchMessage(id, { sid });
    const router = isRouterHome(bot, sid);
    const header = router || quoted ? panelHeaderText({ topic: root, ...(quoted ? { replyTo: { who: writerOf(quoted), text: quoted.text } } : {}), open: router ? openTasksOf(bot) : [] }, cardCtx()) : '';
    try {
      await sendTo(agent, { content: header ? [{ type: 'text', text: header }, { type: 'text', text: body }] : [{ type: 'text', text: body }], source: { kind: 'user' }, mode: homeMode(bot), key: `panel:${id}` });
    } catch (error) {
      store.patchMessage(id, { failed: true });
      throw error;
    }
    return { sessionId: sid, message: messageView(store.message(id)) };
  }

  /**
   * A reply in a panel topic whose tasks are live: into each task's Session as the person's
   * message (a done one opens again; it may take the extra slot), and the chat's bot hears of it
   * without waking. Returns the task Sessions; throws when no task took it.
   */
  async function toTopicTasks(bot, list, body, { key, root, id, quoted }) {
    const reached = [];
    let lastError = null;
    const header = quoted && quoted.id !== root ? panelHeaderText({ replyTo: { who: writerOf(quoted), text: quoted.text } }) : '';
    for (const t of list) {
      const cur = tickets.get(t.id) ?? t;
      try {
        reached.push(await appendToTicket(cur, body, { human: true, logged: true, header, key: `panel:${id}:${cur.id}` }));
      } catch (error) {
        lastError = error;
        ctx.logger?.warn?.(`bots: a panel reply did not reach task ${cur.id}: ${error?.message ?? error}`);
      }
    }
    if (!reached.length) throw lastError ?? new Error('no task took the reply');
    store.patchMessage(id, { ticket: reached[0].id });
    if (bot.sessionId) {
      try {
        const found = await service(ctx, 'sessionController')?.resolveAgent?.(bot.sessionId);
        if (found?.agent) {
          const text = followUpNoticeText({ tickets: reached, thread: { key: root, label: threadLabel({ threadKey: key, threadTitle: store.message(root)?.text }) }, who: 'The user', text: body }, cardCtx());
          await sendTo(found.agent, { content: [{ type: 'text', text }], source: { kind: 'agent-message', form: 'relay' }, mode: 'inject', key: `followup:panel:${id}` });
        }
      } catch (error) {
        ctx.logger?.warn?.(`bots: the follow-up notice for @${bot.handle}: ${error?.message ?? error}`);
      }
    }
    return reached.map((t) => t.sessionId).filter(Boolean);
  }

  /**
   * A thread a tool call names, as a key: a key as is; a panel topic by the id its header shows
   * (`p…`), or by any message in it (one filed under another topic names that one). '' for none.
   */
  function threadRef(ref, sessionId) {
    const r = String(ref ?? '').trim().replace(/^(?:thread|topic)\//, '');
    if (!r || parseThreadKey(r)) return r;
    const hit = channels.current(sessionId).find((o) => o.kind === 'panel' && o.rootId === r);
    if (hit) return hit.threadKey;
    const m = store.message(r);
    if (!m) return r;
    const root = m.movedTo || m.topic || '';
    const first = root ? store.message(root) : undefined;
    return first?.thread && panelTopicOf(first.thread) === root ? first.thread : r;
  }
  /** The panel topics of a turn, and its chat Threads, as a tool error lists them. */
  const turnChoices = (sessionId) =>
    channels
      .current(sessionId)
      .filter((o) => o.kind !== 'panel' || o.rootId)
      .map((o) => (o.kind === 'panel' ? `${o.rootId} (${threadLabel(o)})` : `${o.threadKey} (${threadLabel(o)}${o.tickets?.length ? `; task ${o.tickets.join(', ')}` : ''})`));
  /**
   * A home added a person's new message to an open task (`bot_send_message` with `ticket`): when
   * that task came from a panel topic and this turn has one other panel topic that is only that
   * message (or the one `chosen` names), the message is filed under the task's topic (`movedTo`),
   * and this turn's replies go there. Returns the task's topic root, or ''.
   */
  function fileUnder(t, sessionId, chosen) {
    const target = t.origin?.threadKey;
    const toRoot = target ? panelTopicOf(target) : '';
    if (!toRoot) return '';
    const candidates = channels.current(sessionId).filter((o) => o.kind === 'panel' && o.rootId && o.threadKey !== target && tickets.subscribers(o.threadKey).length === 0);
    const pick = chosen ? candidates.find((o) => o.threadKey === chosen) : candidates.length === 1 ? candidates[0] : undefined;
    if (!pick) return '';
    const first = store.message(pick.rootId);
    if (!first || first.from !== 'user' || first.movedTo) return '';
    // Only a topic nobody answered in yet is filed away whole.
    if (store.messages({ topic: pick.rootId, limit: 5 }).some((m) => m.id !== pick.rootId)) return '';
    store.patchMessage(pick.rootId, { movedTo: toRoot });
    channels.retarget(sessionId, pick.threadKey, target, { threadTitle: clip(store.message(toRoot)?.text ?? '', 60).text });
    return toRoot;
  }

  // --- tickets: delegated work in Sessions of their own ---------------------------------
  /** What cards and relays read about the team and the tickets. */
  const cardCtx = () => ({ bots: store.list(), threads: tickets, tickets, stageOf });
  const handleOf = (botId) => (store.get(botId) ? `@${store.get(botId).handle}` : 'a removed bot');

  /** A ticket as the panel lists it (PLAN-0.8 §6.3 `TicketRow`). */
  function ticketRow(t) {
    const last = t.reports.at(-1);
    return {
      id: t.id,
      title: t.title,
      botId: t.botId,
      stage: stageOf(t),
      requester: t.requester?.kind === 'session' && t.requester.botId ? { kind: 'bot', botId: t.requester.botId } : { kind: 'user' },
      ...(t.origin?.via ? { via: t.origin.via } : {}),
      // Its conversation waits for the person's answer to a question (state `asks`): it needs you.
      ...(askingIn(t.sessionId) ? { asking: true } : {}),
      // What its conversation does right now (lib/activity.mjs), while it runs.
      ...(!t.ended && activity.get(t.sessionId) ? { activity: activity.get(t.sessionId) } : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      ...(last ? { lastReport: { status: last.status, preview: clip(String(last.text ?? '').trim(), PREVIEW_CHARS).text } } : {}),
    };
  }
  const threadView = (key) => {
    const th = tickets.thread(key);
    const parsed = parseThreadKey(key);
    return { key, kind: th?.kind ?? parsed?.kind ?? '', label: th?.label ?? threadLabel(key) };
  };
  /** One ticket in full for the panel (`TicketView`): the row, the text, reports, Threads, runs with their cost. */
  function ticketView(t) {
    const overrides = settings.get().prices;
    const catalog = prices.peek();
    const running = [...openTasks.values()].map(({ log, size, replied, ...x }) => x);
    const use = ticketUsage({ calls: ledger.calls(), tasks: ledger.tasks(), running }, t.id, (m) => priceOf(m, overrides, catalog));
    return {
      ...ticketRow(t),
      text: t.text,
      ...(t.parentId ? { parentId: t.parentId } : {}),
      children: tickets.children(t.id).map((c) => c.id),
      requesterSessionId: t.requester?.sessionId ?? null,
      origin: t.origin ?? {},
      ...(t.startedAt ? { startedAt: t.startedAt } : {}),
      ...(t.ended ? { ended: t.ended } : {}),
      ...(t.error ? { error: t.error } : {}),
      ...(t.archivedAt ? { archivedAt: t.archivedAt } : {}),
      ...(t.nudgedAt ? { nudgedAt: t.nudgedAt } : {}),
      ...(t.stalledAt ? { stalledAt: t.stalledAt } : {}),
      ...(t.retries ? { retries: t.retries } : {}),
      reports: t.reports.map((r) => ({ at: r.at, status: r.status, text: r.text })),
      threads: t.threads.map(threadView),
      runs: use.runs,
      usage: { tokens: use.tokens, calls: use.calls, cost: use.cost },
      sessionId: t.sessionId,
      running: Boolean(t.sessionId && agents()?.get?.(t.sessionId)?.status === 'running'),
    };
  }

  /** A Thread as a ticket subscribes to it: its key and label (`Slack · Acme #general · thread`). */
  const threadRecordOf = (o) => ({ key: o.threadKey, label: threadLabel(o) });
  /** A ticket's `origin` from one of the turn's Threads; `replyTo`: the chat message that started it, which its answer quotes. */
  const originFrom = (o) =>
    o.kind === 'panel'
      ? { origin: { threadKey: o.threadKey, who: 'the user' }, thread: threadRecordOf(o) }
      : { origin: { threadKey: o.threadKey, via: o.kind, ...(o.who ? { who: o.who } : {}), ...(o.replyTo ? { replyTo: String(o.replyTo) } : {}) }, thread: threadRecordOf(o) };
  /** The choices a delegating call may name with `thread`, for an error. */
  const threadChoices = (list) => list.map((o) => `${o.threadKey} (${threadLabel(o)})`).join(', ');

  /**
   * Where the turn that is delegating now came from (PLAN-0.8 §4.3, §10 `origin`): its one chat
   * Thread (which the ticket then subscribes to); the Thread the call names with `thread` when the
   * turn has several; the panel conversation when only the panel spoke; no Thread at all for a
   * scheduled run without a chat, or several Threads and none named. A sub-ticket tells who it is
   * for but takes no Thread: follow-ups on it reach the parent.
   * @param {string} sessionId
   * @param {string} [chosen] - a Thread key of this turn the delegating call named
   */
  function originOfTurn(sessionId, chosen) {
    const parent = ticketOf(sessionId);
    if (parent) {
      if (chosen) throw new Error('a sub-task takes no thread: follow-ups reach the task that asked for it; leave out `thread`');
      return { origin: { ...(parent.origin?.via ? { via: parent.origin.via } : {}), ...(parent.origin?.who ? { who: parent.origin.who } : {}) } };
    }
    const plan = channels.replyPlan(sessionId);
    if (chosen) {
      const key = toThreadKey(String(chosen).trim().replace(/^thread\//, ''));
      const hit = key ? plan.origins.find((o) => o.threadKey === key) : undefined;
      if (!hit) throw new Error(`\`thread\` must be one of this turn's threads: ${threadChoices(plan.origins) || 'none (this turn has no thread); leave it out'}`);
      return originFrom(hit);
    }
    if (plan.mode === 'thread') return originFrom(plan.target);
    if (plan.mode === 'choose') {
      // Several topics or chats a person is waiting in (Bots 0.9): the task must say which one is its own.
      const topics = plan.origins.filter((o) => isTopicThread(o.threadKey));
      if (topics.length > 1) throw new Error(`this turn involves several topics or chats: say which one this task is for with \`thread\`: ${turnChoices(sessionId).join('; ')}`);
      // Several Threads and none named: the task belongs to none of them (its report reaches the requester only).
      const people = [...new Set(plan.origins.map((o) => o.who).filter(Boolean))];
      return { origin: { ...(people.length === 1 ? { who: people[0] } : { who: 'the user' }) } };
    }
    if (trigger.get(sessionId) === 'schedule') return { origin: { who: 'the user', via: 'schedule' } };
    return originFrom({ threadKey: panelThreadKey(sessionId), kind: 'panel' });
  }

  /**
   * The Session a ticket works in: resolved when it exists, else made in the Bots workspace and
   * decorated as its bot. `info.created` says it had to be made.
   */
  async function ticketAgent(t, info = {}) {
    const controller = service(ctx, 'sessionController');
    if (!controller) throw new Error('tasks need the Web profile (no session controller here)');
    const bot = store.get(t.botId);
    if (!bot) throw new Error('the bot of this task was removed');
    const wanted = t.sessionId ?? sessionIdOf(t.id);
    const archived = service(ctx, 'workspaceRegistry')?.archivedSessionIds ?? [];
    // Also when nothing is stored yet: a crash may have come between making the Session and recording it.
    if (!archived.includes(wanted)) {
      const found = await controller.resolveAgent(wanted).catch((error) => ({ error }));
      if (found && !('error' in found) && found.agent) {
        reconcile(found.agent);
        return found.agent;
      }
    }
    const wsId = await workspaceId().catch(() => undefined);
    // The Agent's creation already finds the ticket by the `ticket-<id>` name and installs the bot.
    const created = await controller.create({ sessionId: wanted, ...(wsId ? { workspaceId: wsId } : { cwd: workdir }) });
    info.created = true;
    const id = created?.sessionId ?? wanted;
    if (id !== wanted) {
      otherTicketSessions.add(id);
      tickets.patch(t.id, { sessionId: id });
    }
    let agent = agents()?.get?.(id);
    if (!agent) {
      const found = await controller.resolveAgent(id).catch((error) => ({ error }));
      if (!found || 'error' in found) throw found?.error ?? new Error('the task conversation did not start');
      agent = found.agent;
    }
    reconcile(agent);
    const title = t.title;
    try {
      const titles = service(ctx, 'sessionTitle');
      if (typeof titles?.rename === 'function') titles.rename(agent.session, title);
      else await controller.rename?.({ sessionId: id, title });
    } catch {
      // A title is cosmetic.
    }
    if (bot.model) {
      try {
        agent.model?.select?.(selectionOf(bot.model));
      } catch {
        // The default model stays.
      }
    }
    return agent;
  }

  /** How a ticket's requester appears as a message source in the worker's Session. */
  const sourceFrom = (requester) => (requester?.kind === 'session' && requester.sessionId ? { kind: 'agent-message', form: 'relay', senderSessionId: requester.sessionId } : { kind: 'user' });

  /** Failures of tickets the caller is opening right now: its tool result says so, no notice is sent. */
  const quietFailures = new Set();

  /**
   * Start a queued ticket that holds a slot: its Session, then the assignment as the first message.
   * One ended while its Session was being made (a person stopped it) does not start, and frees the slot.
   */
  async function launch(t) {
    try {
      const agent = await ticketAgent(t);
      const now = tickets.get(t.id);
      if (!now || now.ended || now.startedAt) {
        // Its Session stays known to it, so upkeep archives it with the ticket.
        if (now && !now.startedAt && !now.sessionId) tickets.patch(now.id, { sessionId: agent.session.id });
        if (!now?.startedAt) slots.release(t.id);
        return false;
      }
      const started = tickets.start(t.id, { sessionId: agent.session.id });
      await sendTo(agent, { content: [{ type: 'text', text: assignmentText(started, cardCtx()) }], source: sourceFrom(started.requester), mode: 'steer', key: `assign:${t.id}` });
      return true;
    } catch (error) {
      const reason = String(error?.message ?? error);
      ctx.logger?.warn?.(`bots: task ${t.id} for ${handleOf(t.botId)} did not start: ${reason}`);
      slots.release(t.id);
      // Stopped while it was starting: it stays as the person left it.
      if (tickets.get(t.id)?.ended) return false;
      const failed = tickets.end(t.id, { by: 'system', outcome: 'failed', error: `did not start: ${reason}` });
      if (failed && !quietFailures.has(t.id)) void notifyRequester(failed, `[Failed] Task ${t.id} (${handleOf(t.botId)}: ${t.title}) could not start: ${reason}`, { key: `failed:${t.id}:${failed.ended.at}` });
      return false;
    }
  }

  /**
   * Hand a message to a started ticket's Session once it holds a worker slot: at once when it has one
   * or one is free (`human`: a person's message may take the extra slot), else parked on the ticket
   * (`parked`, kept in tickets.json, so it outlasts a restart) for the pump to deliver in order when a
   * slot frees. Messages already parked go first. Returns `{parked}`.
   */
  async function toTicket(t, { content, source, key, human = false }) {
    const waiting = parkedOf(tickets.get(t.id) ?? t);
    if (waiting.some((m) => m.key === key)) return { parked: true };
    if (waiting.length === 0 && slots.acquire(t.id, { human })) {
      const agent = await ticketAgent(t);
      await sendTo(agent, { content, source, mode: 'steer', key });
      return { parked: false };
    }
    tickets.patch(t.id, { parked: [...waiting, { key, content, source, at: nowMs(), ...(human ? { human: true } : {}) }] });
    void pump();
    return { parked: true };
  }

  /** Deliver the messages parked on a ticket that now holds a slot, oldest first; stops if it ends meanwhile. */
  async function deliverParked(t) {
    try {
      const agent = await ticketAgent(t);
      for (;;) {
        const cur = tickets.get(t.id);
        const [next, ...rest] = parkedOf(cur);
        if (!cur || cur.ended || !next) break;
        await sendTo(agent, { content: next.content, source: next.source, mode: 'steer', key: next.key });
        tickets.patch(cur.id, { parked: rest.length ? rest : undefined });
      }
    } catch (error) {
      ctx.logger?.warn?.(`bots: messages for task ${t.id} wait for the next try: ${error?.message ?? error}`);
      slots.release(t.id);
    }
  }

  let pumping = null;
  let pumpAgain = false;
  /**
   * While slots are free, oldest first: launch queued tickets, and hand started ones the messages parked
   * for them. A full pass still lets a person's parked message take the extra slot.
   */
  function pump() {
    if (pumping) {
      pumpAgain = true;
      return pumping;
    }
    pumping = (async () => {
      do {
        pumpAgain = false;
        // No Session controller (yet, or in this profile): queued tickets wait for the next pump.
        if (!service(ctx, 'sessionController')) break;
        let full = false;
        for (const listed of tickets.open()) {
          // Read again: an earlier launch awaited, and a person may have stopped this one meanwhile.
          const t = tickets.get(listed.id);
          if (!t || t.ended) continue;
          const waiting = parkedOf(t);
          if (t.startedAt && waiting.length === 0) continue;
          if (!t.startedAt && !store.get(t.botId)) {
            tickets.end(t.id, { by: 'system', outcome: 'stopped', error: 'the bot was removed' });
            continue;
          }
          const human = waiting.some((m) => m.human);
          if (full && !human) continue;
          if (!slots.acquire(t.id, { human })) {
            if (!human) full = true;
            continue;
          }
          if (t.startedAt) await deliverParked(t);
          else await launch(t);
        }
      } while (pumpAgain);
    })().finally(() => {
      pumping = null;
    });
    return pumping;
  }

  /** The Agent of whoever asked for a ticket: a parent ticket's Session, or a bot's current home. */
  async function requesterAgent(t) {
    const r = t.requester ?? {};
    if (r.kind !== 'session' || !r.sessionId) return null;
    const controller = service(ctx, 'sessionController');
    // An archived conversation (a removed bot's, an old topic's) is nobody's to wake.
    const archived = service(ctx, 'workspaceRegistry')?.archivedSessionIds ?? [];
    const resolveId = async (id) => {
      const found = id && !archived.includes(id) ? await controller?.resolveAgent?.(id).catch((error) => ({ error })) : null;
      return found && !('error' in found) ? found.agent : null;
    };
    if (r.ticketId) {
      const parent = tickets.get(r.ticketId);
      if (!parent || parent.archivedAt) return null;
      return resolveId(parent.sessionId ?? r.sessionId);
    }
    const bot = r.botId ? store.get(r.botId) : undefined;
    // The asking bot may have started a new topic since: its report goes to the conversation it has now.
    if (bot && bot.sessionId !== r.sessionId) return agentOf(bot);
    return (await resolveId(r.sessionId)) ?? (bot ? agentOf(bot) : null);
  }

  /** A notice for the requester's Session (steered; `inject` for one that need not wake it). */
  async function notifyRequester(t, text, { key, mode = 'steer' } = {}) {
    try {
      const agent = await requesterAgent(t);
      if (!agent) return false;
      await sendTo(agent, { content: [{ type: 'text', text }], source: { kind: 'agent-message', form: 'relay', ...(t.sessionId ? { senderSessionId: t.sessionId } : {}) }, mode, key });
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`bots: a notice about task ${t.id} did not reach its requester: ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * A ticket ended (done, stopped, failed; by anyone): its slot frees for the next queued one, and
   * its bot's memory summary runs now, or after the run still being recorded in its Session.
   */
  function ticketEnded(t) {
    slots.release(t.id);
    // Messages still waiting for a slot were for work that is over now.
    if (parkedOf(t).length) tickets.patch(t.id, { parked: undefined });
    void pump();
    if (!(t.sessionId && openTasks.has(t.sessionId))) reflectTicket(t);
  }

  /**
   * Where a ticket's own lines go in the panel (Bots 0.9): a ticket that came from a panel topic
   * logs its delegation, the messages added to it and its notices into that topic, in the chat of
   * the bot that asked. Others log as in 0.8 (`{}`).
   */
  const topicFieldsOf = (t) => {
    const key = t?.origin?.threadKey;
    const topic = key ? panelTopicOf(key) : '';
    return topic ? { chat: t.requester?.botId ?? t.botId, thread: key, topic } : {};
  };

  /** Who may add to a ticket from `sessionId`: its requester (or the requesting bot from its current home), or the router. */
  function mayAppend(t, sender, sessionId) {
    const r = t.requester ?? {};
    if (r.sessionId === sessionId) return true;
    if (sender && r.botId === sender.id && !r.ticketId && sender.sessionId === sessionId) return true;
    return Boolean(sender) && isRouterHome(sender, sessionId);
  }

  /**
   * Add a message to a ticket: from its requester (a bot), or from a person (`human`: the panel, or a
   * follow-up on one of its chat Threads, which brings its `header` line and `chat` details for the
   * timeline, and a delivery `key`). An ended ticket is opened again unless it is archived, or a
   * person stopped it and this is not a person asking (`force`). A ticket still queued keeps the
   * text for its assignment. A started one gets it once it holds a worker slot (a person's message may
   * take the extra one); until then it waits on the ticket. A message whose `key` was delivered (or
   * parked) already changes nothing: a replay after a restart neither reopens nor wakes the ticket.
   */
  async function appendToTicket(t, text, { sender = null, senderSessionId = '', human = false, force = false, header = '', chat = null, key = '', logged = false } = {}) {
    const body = String(text ?? '').trim();
    if (body === '') throw new Error('text must not be empty');
    if (t.archivedAt) throw new Error(`task ${t.id} is archived; open a new task instead`);
    if (key && t.sessionId) {
      await loadHistory(t.sessionId);
      const live = agents()?.get?.(t.sessionId) ?? { session: { id: t.sessionId } };
      if (holds(live, `${MESSAGE_PREFIX}${key}`) || parkedOf(tickets.get(t.id) ?? t).some((m) => m.key === key)) return tickets.get(t.id) ?? t;
    }
    if (sender && t.botId !== sender.id) {
      const target = store.get(t.botId);
      if (target && !admitPair(sender.id, target.id)) throw pairRefusal(sender, target);
    }
    let cur = t;
    if (cur.ended) {
      const back = tickets.resume(cur.id, { force });
      if (back === null) throw new Error(`task ${t.id} was stopped by the user; it stays stopped (open a new task if the work is still wanted)`);
      cur = back ?? cur;
    }
    cur = tickets.touch(cur.id, human ? { human: true } : { requester: true }) ?? cur;
    const who = sender ? `@${sender.handle} (${sender.name})` : 'the user';
    if (!cur.startedAt) {
      cur = tickets.patch(cur.id, { text: `${cur.text}\n\n--- Added by ${who} ---\n${body}` }) ?? cur;
      void pump();
      return cur;
    }
    const content = sender
      ? [
          { type: 'text', text: `Bot message from ${who} about task ${cur.id}:` },
          { type: 'text', text: `${body}\n\n(Answer in a report: bot_send_message with a status, without "to".)` },
        ]
      : header
        ? [
            { type: 'text', text: header },
            { type: 'text', text: body },
          ]
        : [{ type: 'text', text: body }];
    // A person's follow-up may take the extra slot (new work cannot crowd it out); a bot's may not.
    await toTicket(cur, { content, source: sender && senderSessionId ? { kind: 'agent-message', form: 'relay', senderSessionId } : { kind: 'user' }, key: key || `msg:${cur.id}:${randomUUID()}`, human: human && !sender });
    // A panel message is in the timeline already (logged when it was sent).
    if (logged) return tickets.get(cur.id) ?? cur;
    store.log(
      chat
        ? { from: 'user', to: cur.botId, text: body, kind: 'user', via: chat.kind, ...(chat.who ? { who: chat.who } : {}), ...(chat.threadKey ? { thread: chat.threadKey } : {}), ticket: cur.id }
        : { from: sender ? sender.id : 'user', to: cur.botId, text: body, kind: 'dm', ticket: cur.id, ...topicFieldsOf(cur) },
    );
    return tickets.get(cur.id) ?? cur;
  }

  /**
   * Open a ticket for `target`, asked from `senderSessionId` (a bot's home or a ticket Session),
   * and start it when a slot is free. Returns the ticket; a start that failed shows as stage `failed`.
   */
  async function openTicket(sender, target, text, senderSessionId, { title, thread: chosen, relay = false } = {}) {
    const body = String(text ?? '').trim();
    if (body === '') throw new Error('text must not be empty');
    // The dispatcher may hand work to itself (Bots 0.9): it does it in a task of its own, with all its tools.
    if (sender.id === target.id && !isRouterHome(sender, senderSessionId)) throw new Error('a bot cannot message itself');
    if (!service(ctx, 'sessionController')) throw new Error('tasks need the Web profile (no session controller here)');
    const parent = ticketOf(senderSessionId);
    const { origin, thread } = originOfTurn(senderSessionId, chosen);
    if (!admitPair(sender.id, target.id)) throw pairRefusal(sender, target);
    const t = tickets.create({
      title,
      text: body,
      botId: target.id,
      requester: { kind: 'session', sessionId: senderSessionId, botId: sender.id, ...(parent ? { ticketId: parent.id } : {}) },
      origin,
      threads: thread ? [thread] : [],
      relay,
    });
    store.log({ from: sender.id, to: target.id, text: body, kind: 'dm', ticket: t.id, ...topicFieldsOf(t) });
    quietFailures.add(t.id);
    try {
      await pump();
    } finally {
      quietFailures.delete(t.id);
    }
    return tickets.get(t.id) ?? t;
  }

  /** A worker reports on its ticket. `progress` is only recorded; the rest reach the requester. */
  async function reportTicket(t, status, text) {
    if (!REPORT_STATUSES.includes(status)) throw new Error('a report to whoever asked needs a status: progress, done, blocked or question');
    const body = String(text ?? '').trim();
    if (body === '') throw new Error('text must not be empty');
    if (t.archivedAt) throw new Error(`task ${t.id} is archived; nobody reads reports on it`);
    const wasOpen = !t.ended;
    const next = tickets.addReport(t.id, { status, text: body });
    const index = next.reports.length - 1;
    const report = next.reports[index];
    let relayed = false;
    // An ended task's late words, or a sub-task's report to a task that has ended since, wake no one:
    // they are kept on the task (its reports) and the panel shows them.
    const parent = next.requester?.ticketId ? tickets.get(next.requester.ticketId) : undefined;
    const unread = !wasOpen ? 'ended' : next.requester?.ticketId && (!parent || parent.ended) ? 'parent' : '';
    // Bots 0.9: the person reads it as it is, where the task came from; whoever asked is told without waking.
    const shown = status !== 'progress' && !unread && reportsGoDirect(next) ? showReport(next, report) : null;
    if (shown) {
      relayed = true;
      if (next.requester?.kind === 'session') {
        await notifyRequester(next, shownNoticeText(next, report, { ...cardCtx(), where: shown.where }), { mode: 'inject', key: `shown:${next.id}:${index}:${report.at}` });
      }
    } else if (status !== 'progress' && !unread) {
      store.log({ from: next.botId, to: next.requester?.botId ?? 'user', text: body, kind: 'dm', ticket: next.id, status, ...topicFieldsOf(next) });
      // A ticket the user asked for has no Session to tell: the panel shows it (attention).
      if (next.requester?.kind === 'session') {
        // The requester's turn takes this ticket's origin Thread as an input when the relay arrives in it
        // (its `user/message`, see RELAY_KINDS below), not here: a turn ending in between would lose it.
        relayed = await notifyRequester(next, reportRelayText(next, report, cardCtx()), { key: `report:${next.id}:${index}:${report.at}` });
      }
    }
    if (status === 'done' && wasOpen) ticketEnded(next);
    return { ticket: next, relayed, ...(shown ? { shown } : {}), ...(unread ? { unread, ...(parent ? { parent: parent.id } : {}) } : {}) };
  }

  /**
   * Post a worker's report where its task came from (Bots 0.9): a panel topic (or the panel as a
   * whole, for a task from before topics) shows it in the chat of the bot that asked; a chat Thread
   * gets it through that chat's app, signed with the worker's name when the worker is not the one
   * the chat belongs to. Returns `{where}` (how the place reads), or null when it cannot be reached
   * (the report then goes to whoever asked, as in 0.8).
   */
  function showReport(t, report) {
    const key = t.origin?.threadKey;
    if (!key) return null;
    const worker = store.get(t.botId);
    const owner = t.requester?.botId ? store.get(t.requester.botId) : undefined;
    const chat = owner?.id ?? t.botId;
    const body = String(report.text ?? '').trim();
    if (isPanelThread(key)) {
      const topic = panelTopicOf(key);
      store.log({ from: t.botId, to: 'user', chat, text: body, kind: 'reply', thread: key, ...(topic ? { topic } : {}), ticket: t.id, status: report.status });
      return { where: threadLabel({ threadKey: key, ...(topic ? { threadTitle: store.message(topic)?.text } : {}) }) };
    }
    const signed = worker && owner && worker.id !== owner.id ? `【${worker.name}】\n${body}` : body;
    let sent = null;
    try {
      sent = channels.post({ thread: key }, signed, { replyTo: t.origin?.replyTo ?? '', typingOf: t.sessionId ?? '' });
    } catch (error) {
      ctx.logger?.warn?.(`bots: the report on task ${t.id} was not posted to its chat: ${error?.message ?? error}`);
    }
    if (!sent) return null;
    store.log({ from: t.botId, to: 'user', chat, text: body, kind: 'reply', via: sent.kind, thread: key, ticket: t.id, status: report.status });
    return { where: tickets.thread(key)?.label ?? threadLabel(sent) };
  }

  /** A person (the panel) or the requester ends a ticket (stop, or close as done); either cancels its running turn. */
  function endTicket(t, { by, outcome, error }) {
    const wasOpen = !t.ended;
    const next = tickets.end(t.id, { by, outcome, ...(error ? { error } : {}) });
    if (next.sessionId) {
      try {
        agents()?.get?.(next.sessionId)?.cancel?.(by === 'user' ? { kind: 'user' } : { kind: 'hook', reason: `bots: task ${t.id} ${outcome === 'done' ? 'closed' : 'stopped'}` });
      } catch {
        // Nothing running.
      }
    }
    if (wasOpen) ticketEnded(next);
    else slots.release(next.id);
    // The requester learns of it next time it works; it need not wake for it.
    if (by === 'user' && next.requester?.kind === 'session') {
      void notifyRequester(next, `[${outcome === 'done' ? 'Closed' : 'Stopped'}] The user ${outcome === 'done' ? 'closed' : 'stopped'} task ${next.id} (${handleOf(next.botId)}: ${next.title}).`, { mode: 'inject', key: `ended:${next.id}:${next.ended.at}` });
    }
    return next;
  }

  /**
   * A retry: open the ticket again and hand the assignment over afresh. From the panel (`by`
   * 'user', even one the user stopped), or from the requester (`sender`, a bot, with its Session);
   * a requester cannot retry a ticket the user stopped.
   */
  async function retryTicket(t, { sender = null, senderSessionId = '' } = {}) {
    const back = tickets.resume(t.id, { force: !sender });
    if (back === null && sender && !t.archivedAt) throw new Error(`task ${t.id} was stopped by the user; it stays stopped (open a new task if the work is still wanted)`);
    if (!back) throw new Error(`task ${t.id} is archived; open a new task instead`);
    tickets.touch(back.id, sender ? { requester: true } : { human: true });
    if (!back.startedAt) {
      await pump();
      return tickets.get(back.id) ?? back;
    }
    const who = sender ? `@${sender.handle}` : 'The user';
    const note = `[Retry] ${who} asked you to take task ${back.id} up again. Check what is already done before you repeat anything, then go on and report as usual.\n\n${assignmentText(back, cardCtx())}`;
    const source = sender && senderSessionId ? { kind: 'agent-message', form: 'relay', senderSessionId } : { kind: 'user' };
    // A person's retry may take the extra slot; the requester's waits for a free one like new work.
    await toTicket(back, { content: [{ type: 'text', text: note }], source, key: `retry:${back.id}:${back.updatedAt}`, human: !sender });
    return tickets.get(back.id) ?? back;
  }

  /** A ticket Session went idle: a ticket that waits on others (question, blocked, stalled) gives its slot back. */
  function ticketIdle(t) {
    if (!t || t.ended) return;
    const stage = stageOf(t);
    if ((stage === 'question' || stage === 'failed' || stage === 'stalled') && slots.release(t.id)) void pump();
  }

  // --- the task watchdog (PLAN-0.8 §4.5): deterministic rules from lib/watchdog.mjs ---------------
  const agentStatusOf = (sessionId) => (sessionId && agents()?.get?.(sessionId)?.status === 'running' ? 'running' : 'idle');

  /**
   * What keeps a ticket Session busy in the background: its shell jobs still running (Harness
   * `jobs.list`) and its subagents still running (`subagents.listChildren`, or `listDescendants` as
   * Harness 0.2.2 has it). Nothing is waited for; a service that is missing counts nothing.
   */
  async function backgroundOf(sessionId) {
    let n = 0;
    const jobs = service(ctx, 'jobs');
    try {
      if (typeof jobs?.list === 'function') n += (jobs.list(sessionId) ?? []).filter((j) => j?.owner === sessionId && (j.status === 'running' || j.status === 'stopping')).length;
    } catch {
      // No job registry view for this Session.
    }
    const subagents = service(ctx, 'subagents');
    try {
      const list = typeof subagents?.listChildren === 'function' ? subagents.listChildren.bind(subagents) : typeof subagents?.listDescendants === 'function' ? subagents.listDescendants.bind(subagents) : null;
      if (list) n += ((await list(sessionId, AbortSignal.timeout(5000))) ?? []).filter((c) => c && c.kind !== 'diagnostic' && c.activity === 'running').length;
    } catch {
      // A catalog that cannot be read counts nothing.
    }
    return n;
  }

  /** The time a bot's home last spoke to a person (a reply in the timeline), for reminders. */
  function lastReplyAt(botId) {
    const rows = store.messages({ bot: botId, limit: 2000 });
    // Plain text that reached no chat (`notSent`: the turn had several) told nobody.
    for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].from === botId && rows[i].kind === 'reply' && !rows[i].notSent) return Number(rows[i].at) || 0;
    return 0;
  }

  /** One watchdog pass (the 5-minute sweep): status checks, stalls, and reminders for requesters with nothing left to wait for. */
  async function watch(now = nowMs()) {
    const stallMinutes = settings.get().tickets.stallMinutes;
    const open = tickets.open();
    const items = [];
    for (const t of open) {
      // A ticket whose messages wait for a slot is `queued`: it is not judged until it has one. One
      // waiting for the person's answer to its question is not quiet either.
      const stage = stageOf(t);
      if (stage !== 'working' || askingIn(t.sessionId)) continue;
      const status = agentStatusOf(t.sessionId);
      // A sub-task still working (or waiting for a slot) is this ticket's background work too: it waits for its report.
      const children = tickets.children(t.id).filter((c) => ['working', 'queued'].includes(stageOf(c))).length;
      items.push({ ticket: t, stage, agentStatus: status, backgroundJobs: status === 'idle' ? children + (t.sessionId ? await backgroundOf(t.sessionId) : 0) : 0 });
    }
    for (const action of checkTickets(items, { stallMinutes }, now)) {
      const t = tickets.get(action.ticketId);
      if (!t || t.ended) continue;
      try {
        if (action.kind === 'nudge') {
          tickets.patch(t.id, { nudgedAt: now });
          await toTicket(t, { content: [{ type: 'text', text: nudgeText(t) }], source: sourceFrom(t.requester), key: `nudge:${t.id}:${now}` });
        } else {
          const stalled = tickets.patch(t.id, { stalledAt: now });
          store.log({ from: t.botId, to: t.requester?.botId ?? 'user', text: `Task ${t.id} stalled: no report after a status check.`, kind: 'dm', ticket: t.id, status: 'stalled', ...topicFieldsOf(t) });
          if (slots.release(t.id)) void pump();
          // A ticket the user asked for has no Session to tell: the panel shows it (attention).
          if (stalled.requester?.kind === 'session') await notifyRequester(stalled, stalledNoticeText(stalled, cardCtx()), { key: `stalled:${t.id}:${now}` });
        }
      } catch (error) {
        ctx.logger?.warn?.(`bots: watchdog on task ${t.id}: ${error?.message ?? error}`);
      }
    }
    // Requesters whose every task settled and who have said nothing since: one reminder per batch.
    const all = tickets.list({ archived: false });
    const facts = (sessionId) => {
      const asTicket = ticketOf(sessionId);
      // A task that has ended asks nothing more of anyone: it is not reminded.
      if (asTicket?.ended) return { status: 'idle', ended: true };
      const bot = botOfSession(sessionId);
      const mine = all.filter((x) => x.requester?.sessionId === sessionId);
      const remindedAt = Math.max(0, ...mine.map((x) => Number(x.remindedAt) || 0));
      const reportedAt = asTicket ? Number(asTicket.reports.at(-1)?.at) || 0 : bot ? lastReplyAt(bot.id) : 0;
      return { status: agents()?.get?.(sessionId) ? agentStatusOf(sessionId) : 'offline', reportedAt, remindedAt };
    };
    // A task that answers the person itself (Bots 0.9) leaves its requester nothing to pass on.
    const relayed = all.filter((t) => !reportsGoDirect(t));
    for (const r of requesterReminders(relayed.map((t) => ({ ticket: t, stage: stageOf(t) })), facts, now)) {
      const list = r.ticketIds.map((id) => tickets.get(id)).filter(Boolean);
      if (!list.length) continue;
      try {
        const key = `remind:${r.sessionId}:${now}`;
        reminded.set(`${MESSAGE_PREFIX}${key}`, list.map((t) => t.id));
        if (reminded.size > 200) reminded.delete(reminded.keys().next().value);
        if (await notifyRequester(list[0], reminderText(list, cardCtx()), { key })) {
          for (const t of list) tickets.patch(t.id, { remindedAt: now });
        }
      } catch (error) {
        ctx.logger?.warn?.(`bots: reminder for ${r.sessionId}: ${error?.message ?? error}`);
      }
    }
  }

  /** ticketId → the pending "continue" after a temporary error. Cleared on dispose. */
  const retryTimers = new Map();
  ctx.effect(() => () => {
    for (const timer of retryTimers.values()) clearTimer(timer);
    retryTimers.clear();
  }, 'bots: task retry timers');

  /**
   * A ticket Session's turn failed (`agent/error`). A temporary error (HTTP 408, 429, 5xx, a dropped
   * connection) gets a "continue" after 15, 30 and 60 s; then, or for any other error, the ticket
   * fails and its requester hears of it.
   */
  function ticketError(t, error) {
    if (!t || t.ended || retryTimers.has(t.id)) return;
    if (error?.name === 'AbortError') return; // stopped on purpose (Harness reports no cancellation here anyway)
    // A model failure is an `LlmError` whose `failure` holds the facts (`status`, `message`, `code`).
    const facts = error?.failure && typeof error.failure === 'object' ? error.failure : error;
    const reason = String(facts?.message ?? error?.message ?? error?.error?.message ?? (typeof error === 'string' ? error : '') ?? '').trim() || 'the model call failed';
    const delay = isTransient(facts) || isTransient(error) ? retryDelay(t.retries) : undefined;
    if (delay !== undefined) {
      const attempt = (t.retries ?? 0) + 1;
      const timer = setTimer(() => {
        retryTimers.delete(t.id);
        const cur = tickets.get(t.id);
        if (!cur || cur.ended || agentStatusOf(cur.sessionId) === 'running') return;
        tickets.patch(cur.id, { retries: attempt, error: reason });
        void toTicket(cur, { content: [{ type: 'text', text: retryText(cur, { attempt, error: reason }) }], source: sourceFrom(cur.requester), key: `continue:${cur.id}:${attempt}:${nowMs()}` }).catch((e) =>
          ctx.logger?.warn?.(`bots: retrying task ${cur.id}: ${e?.message ?? e}`),
        );
      }, delay);
      timer?.unref?.();
      retryTimers.set(t.id, timer);
      return;
    }
    const failed = tickets.end(t.id, { by: 'system', outcome: 'failed', error: reason });
    if (!failed) return;
    store.log({ from: failed.botId, to: failed.requester?.botId ?? 'user', text: `Task ${failed.id} failed: ${reason}`, kind: 'dm', ticket: failed.id, status: 'failed', ...topicFieldsOf(failed) });
    ticketEnded(failed);
    if (failed.requester?.kind === 'session') void notifyRequester(failed, failedNoticeText(failed, cardCtx()), { key: `failed:${failed.id}:${failed.ended.at}` });
  }
  ctx.on('agent/error', (payload) => {
    try {
      ticketError(ticketOf(payload?.agent?.session?.id), payload?.error);
    } catch (error) {
      ctx.logger?.warn?.(`bots: a task error: ${error?.message ?? error}`);
    }
  });
  // A ticket's background jobs starting or ending are events of that ticket (the watchdog's clock).
  ctx.inject?.(['jobs'], (scope) => {
    const jobs = scope?.jobs ?? service(scope, 'jobs');
    if (typeof jobs?.events?.subscribe !== 'function') return;
    const off = jobs.events.subscribe({ owners: 'all' }, (event) => {
      const owner = event?.job?.owner ?? event?.owner;
      const t = owner ? ticketOf(owner) : undefined;
      if (t && (event.type === 'registered' || event.type === 'settled')) tickets.touch(t.id);
    });
    if (typeof off !== 'function') return;
    if (typeof scope.effect === 'function') scope.effect(() => off, 'bots: task background jobs');
    else ctx.effect(() => off, 'bots: task background jobs');
  });

  /**
   * After a restart (PLAN-0.8 §4.5): a working ticket whose Session was in the middle of a turn
   * (its stored log ends inside a turn, or with the turn Harness closed as `interrupted` when it
   * resumed it), or holds input it never took, gets one recovery note: look before repeating
   * anything, then go on. A Session that had to be made anew gets its assignment again, and so does
   * one whose stored log holds no message at all (the assignment never landed). Idle tickets that
   * had reported stay as they are. The note's id names the interrupted turn, so a second restart
   * before it is read sends nothing new, while a recovery turn cut off again gets its own note.
   */
  async function recoverTickets() {
    if (!service(ctx, 'sessionController')) return;
    for (const t of tickets.open()) {
      if (!t.startedAt || !t.sessionId || stageOf(t) !== 'working') continue;
      try {
        const events = await readHistory(t.sessionId);
        const info = {};
        const agent = await ticketAgent(t, info);
        const cur = tickets.get(t.id) ?? t;
        const pending = pendingOf(agent).length > 0;
        // The first event of the latest turn that did not end cleanly: one the log ends inside, or one
        // Harness closed as `interrupted` with no turn after it (none: the log ends after a clean turn).
        // A recovery turn cut off by a second restart is a turn of its own, so it gets a note of its own.
        let interrupted = null;
        let inTurn = false;
        let lastEnd = 0;
        (events ?? []).forEach((e, i) => {
          const seq = e?.seq ?? i;
          if (e?.type === 'turn/end') {
            lastEnd = seq;
            inTurn = false;
            if (e.data?.reason?.kind !== 'interrupted') interrupted = null;
          } else if (!inTurn && ['turn/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(e?.type)) {
            inTurn = true;
            interrupted = seq;
          }
        });
        // A stored log, read whole (shorter than the tail read), without a single message: the Session was
        // made and the start recorded, but the assignment never landed (Harness went down in between). Its
        // own id keeps one still in the inbox from doubling.
        const neverTook = Array.isArray(events) && events.length < HISTORY_TAIL && !events.some((e) => e?.type === 'user/message');
        if (info.created) {
          await sendTo(agent, { content: [{ type: 'text', text: `${recoveryNoteText(cur)}\n\n${assignmentText(cur, cardCtx())}` }], source: sourceFrom(cur.requester), mode: 'steer', key: `recover:${cur.id}:new` });
        } else if (neverTook) {
          await sendTo(agent, { content: [{ type: 'text', text: assignmentText(cur, cardCtx()) }], source: sourceFrom(cur.requester), mode: 'steer', key: `assign:${cur.id}` });
        } else if (interrupted !== null || pending) {
          const mark = interrupted !== null ? `t${interrupted}` : `p${lastEnd}`;
          await sendTo(agent, { content: [{ type: 'text', text: recoveryNoteText(cur) }], source: sourceFrom(cur.requester), mode: 'steer', key: `recover:${cur.id}:${mark}` });
        }
      } catch (error) {
        ctx.logger?.warn?.(`bots: recovering task ${t.id}: ${error?.message ?? error}`);
      }
    }
  }

  /** Archive the Sessions of tickets ended `archiveHours` ago, run the watchdog; keep the file small. */
  async function ticketUpkeep(now = nowMs()) {
    const hours = settings.get().tickets.archiveHours;
    for (const t of tickets.list({ open: false, archived: false })) {
      if (now - (t.ended?.at ?? 0) < hours * 3_600_000) continue;
      if (t.sessionId && (openTasks.has(t.sessionId) || agents()?.get?.(t.sessionId)?.status === 'running')) continue;
      if (t.sessionId) {
        uninstall(t.sessionId);
        forgetSession(t.sessionId);
        try {
          await service(ctx, 'workspaceRegistry')?.archiveSession?.(t.sessionId);
        } catch (error) {
          ctx.logger?.warn?.(`bots: archiving the conversation of task ${t.id}: ${error?.message ?? error}`);
        }
      }
      tickets.archive(t.id);
      slots.release(t.id);
    }
    await watch(now);
    tickets.flush();
    tickets.prune();
    await pump();
  }

  // After a restart: tickets that were working keep their slots and, once Harness is up, get their
  // recovery notes; queued ones start then.
  for (const t of tickets.open()) if (t.startedAt && stageOf(t) === 'working') slots.acquire(t.id);
  /** The startup pass, once: recovery notes, then the queue. Resolves when done (tests wait on it). */
  let startupDone = null;
  const startup = () => (startupDone ??= recoverTickets()
    .catch((error) => ctx.logger?.warn?.(`bots: task recovery: ${error?.message ?? error}`))
    .then(() => pump())
    .catch(() => {}));
  ctx.effect(() => {
    const timer = setTimer(() => void startup(), deps.startupPumpMs ?? STARTUP_PUMP_MS);
    timer?.unref?.();
    return () => clearTimer(timer);
  }, 'bots: recover working tasks, start queued ones');

  // --- chat channels: Telegram, Discord, Feishu / Lark, Slack -------------------------------
  /**
   * A person's follow-up on a Thread with live tickets (lib/threads.mjs `routeInbound`): it goes
   * into each ticket Session as their message (a done ticket opens again; a follow-up may take the
   * extra slot), and the Router (the channel owner's home) is told without being woken. That notice
   * is no input of its turn: its replies do not go to that Thread because of it.
   */
  async function followUp(list, { header, body }, { threadKey: key, origin, owner, key: messageKey }) {
    const router = owner ? store.get(owner.id) : null;
    // A message handed out again after a restart that the Router already took (it opened these very
    // tickets) is no follow-up: it is not run twice.
    if (messageKey && router?.sessionId) {
      await loadHistory(router.sessionId);
      if (deliveredIds.get(router.sessionId)?.has(`${MESSAGE_PREFIX}${messageKey}`)) return [];
    }
    const sessions = [];
    const reached = [];
    let lastError = null;
    for (const t of list) {
      const cur = tickets.get(t.id) ?? t;
      try {
        const next = await appendToTicket(cur, body, { human: true, header: `${header}${threadNote(key)}`, chat: { kind: origin?.kind, who: origin?.who, threadKey: key }, ...(messageKey ? { key: `${messageKey}:${cur.id}` } : {}) });
        reached.push(next);
        if (next.sessionId) sessions.push(next.sessionId);
      } catch (error) {
        lastError = error;
        ctx.logger?.warn?.(`bots: a follow-up did not reach task ${cur.id}: ${error?.message ?? error}`);
      }
    }
    if (!reached.length) throw lastError ?? new Error('no task took the follow-up');
    if (router?.sessionId) {
      try {
        const found = await service(ctx, 'sessionController')?.resolveAgent?.(router.sessionId);
        if (found?.agent) {
          // The Thread's label names the chat app already ("Telegram · Kada"), so no `via` beside it.
          const text = followUpNoticeText({ tickets: reached, thread: key, who: origin?.who, ...(tickets.thread(key)?.label ? {} : { via: CHANNEL_LABELS[origin?.kind] ?? origin?.kind }), text: body }, cardCtx());
          await sendTo(found.agent, { content: [{ type: 'text', text }], source: { kind: 'agent-message', form: 'relay' }, mode: 'inject', key: `followup:${messageKey ?? randomUUID()}` });
        }
      } catch (error) {
        ctx.logger?.warn?.(`bots: the follow-up notice for @${router.handle}: ${error?.message ?? error}`);
      }
    }
    return sessions;
  }

  const channels = createChannels({
    file: join(dir, 'channels.json'),
    bots: () => store.list(),
    entries: () => templates(),
    // A chat message is a user prompt like one typed in the panel, after a line naming where it came from
    // and its Thread (so the bot can name it in bot_reply). Its id comes from the chat message's, so a
    // message handed out again after a restart is not run twice.
    deliver: async (target, { header, body }, meta = {}) => {
      await autoTopic(store.get(target.id) ?? target, 'user');
      const agent = await agentOf(store.get(target.id) ?? target);
      const sent = await sendTo(agent, {
        content: [
          { type: 'text', text: `${header}${threadNote(meta.threadKey)}` },
          { type: 'text', text: body },
        ],
        source: { kind: 'user' },
        mode: homeMode(target),
        ...(meta.key ? { key: meta.key } : {}),
      });
      return { sessionId: agent.session.id, messageId: sent.message.id, ...(sent.skipped ? { skipped: true } : {}) };
    },
    toTickets: (list, msg, meta) => followUp(list, msg, meta),
    subscribers: (key) => tickets.subscribers(key),
    knownThread: (key) => tickets.thread(key),
    ticketThread: (id) => tickets.get(String(id ?? ''))?.origin?.threadKey,
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
  /**
   * Per home Session, its turn so far (dropped at the turn's end): `other`, an input that was no report
   * or note about a task (a person's message, a schedule run, a teammate's DM); `reports`, the tasks
   * whose reports or notes came in; and since the latest input, `answers`, those of them it messaged
   * with bot_send_message (`ticket`), and `acted`, any other bot_send_message (a new task, say).
   */
  const turnState = new Map();
  /**
   * Closing words that reach no one: the turn's only inputs were reports, and all the bot did about
   * them was answer those tasks. Anything more (a person in the turn, a new task) and its text is a
   * message to the person.
   */
  const closingOnly = (sessionId) => {
    const st = turnState.get(sessionId);
    return Boolean(st) && !st.other && st.reports.size > 0 && st.answers.size > 0 && !st.acted;
  };
  /** A tool call's arguments as an object (`argsRaw` or Harness's `arguments`, a JSON string). */
  const callArgs = (b) => {
    const raw = b?.argsRaw ?? b?.arguments ?? b?.args ?? b?.input;
    if (raw && typeof raw === 'object') return raw;
    try {
      const v = JSON.parse(String(raw ?? ''));
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  };
  /** Drop what is kept per Session for one that is gone: an archived task's, a topic left behind, a removed bot's. */
  function forgetSession(sessionId) {
    if (!sessionId) return;
    memoText.delete(sessionId);
    memoStale.delete(sessionId);
    deliveredIds.delete(sessionId);
    historyRead.delete(sessionId);
    trigger.delete(sessionId);
    answered.delete(sessionId);
    turnState.delete(sessionId);
    activity.clear(sessionId);
  }
  /** Kinds of user message that start (or join) a task. */
  const TASK_KINDS = new Set(['user', 'schedule', 'agent-message']);
  /** The tickets a relay is about, from its message id (`bots:report:<id>:…`) or its sender (a ticket Session). */
  function relayTickets(message) {
    const id = String(message?.id ?? '');
    const m = /^bots:([a-z-]+):(t[a-z0-9]{8}):/.exec(id);
    if (m && RELAY_KINDS.has(m[1])) return [tickets.get(m[2])].filter(Boolean);
    if (/^bots:remind:/.test(id)) return [...(reminded.get(id) ?? [])].map((x) => tickets.get(x)).filter(Boolean);
    if (/^bots:/.test(id)) return [];
    const sender = ticketOf(message?.source?.senderSessionId);
    return sender ? [sender] : [];
  }
  /** Reminder message id → the tickets it names (their origin Threads join the requester's turn). */
  const reminded = new Map();
  ctx.on('session/event', (session, event) => {
    let bot;
    let via = null;
    let kind;
    let ticket;
    // A panel message's own text, without the header it reached the model with.
    let typedText;
    try {
      bot = botOfSession(session?.id);
      if (!bot || !event) return;
      ticket = ticketOf(session.id);
      if (event.type === 'user/message') noteDelivered(session.id, event.data?.id);
      if (ticket) {
        // A ticket Session talks to no one directly: its reports go through bot_send_message, its
        // plain text stays in it (no timeline reply, nothing to a chat app).
        tickets.touch(ticket.id);
        if (event.type === 'user/message') {
          kind = event.data?.source?.kind;
          trigger.set(session.id, kind);
        } else if (event.type === 'turn/end') {
          channels.noteTurnEnd(session.id);
          // A turn that went through ends a run of temporary errors.
          if (event.data?.reason?.kind === 'completed' && ticket.retries > 0 && !ticket.ended) tickets.patch(ticket.id, { retries: 0 });
        }
      } else if (event.type === 'user/message') {
        kind = event.data?.source?.kind;
        const id = String(event.data?.id ?? '');
        // The Harness tells a session about task edits made elsewhere; that is not a delivery.
        if (kind === 'schedule' && /^\[SCHEDULE CHANGE\]/.test(textOf(event.data.content))) kind = 'schedule-notice';
        if (/^bots:(?:followup|shown):/.test(id)) {
          // A follow-up went to its tasks directly, or a report went to the person (injected notes that
          // woke nothing): no input of the turn.
          kind = 'followup-notice';
        } else {
          // A report (or notice) on a ticket this conversation asked for: answering it is speaking to the user.
          const about = kind === 'agent-message' ? relayTickets(event.data) : [];
          // A note that a drawing the bot asked for ended is news for the person too, like a report.
          const isReport = kind === 'agent-message' && (about.length > 0 || /^bots:(?:report|failed|ended|stalled|remind|avatar):/.test(id));
          trigger.set(session.id, isReport ? 'report' : kind);
          answered.delete(session.id);
          const st = turnState.get(session.id) ?? { other: false, reports: new Set() };
          if (isReport) for (const t of about) st.reports.add(t.id);
          else if (kind !== 'schedule-notice') st.other = true;
          st.answers = new Set();
          st.acted = false;
          turnState.set(session.id, st);
          let said = textOf(event.data.content);
          // A message typed in the panel (Bots 0.9) is logged already; its topic joins the turn's Threads.
          const panelId = kind === 'user' ? /^bots:panel:(p[a-z0-9]{8})$/.exec(id)?.[1] : undefined;
          const typed = panelId ? store.message(panelId) : undefined;
          if (typed) said = typedText = typed.text;
          const topicTitle = typed?.thread ? store.message(panelTopicOf(typed.thread))?.text : undefined;
          // A chat message adds its Thread to the turn's; a panel message its topic, or the panel (lib/threads.mjs).
          via = channels.noteUserMessage(session.id, bot, kind, said, { id, report: isReport, ...(typed?.thread ? { threadKey: typed.thread, origin: topicTitle ? { threadTitle: clip(topicTitle, 60).text } : {} } : {}) });
          // A drawing's note: the answer goes to the chats the person asked for it in.
          for (const o of drawingOrigins.get(id) ?? []) channels.noteInput(session.id, { threadKey: o.threadKey, origin: o });
          drawingOrigins.delete(id);
          // A report's ticket came from a Thread: the answer to the person goes there (PLAN-0.8 §4.3).
          for (const t of about) {
            const key = t.origin?.threadKey;
            if (!key) continue;
            const th = tickets.thread(key);
            // The answer quotes the message that started the task, not whatever was said there last.
            channels.noteInput(session.id, { threadKey: key, origin: { ...(t.origin?.who ? { who: t.origin.who } : {}), ...(th?.label ? { label: th.label } : {}), ...(t.origin?.replyTo ? { replyTo: t.origin.replyTo } : {}) }, ticket: t.id });
          }
          const thread = via ? via.threadKey : panelThreadKey(session.id);
          if (kind === 'user' && typed) {
            // Logged when it was sent.
          } else if (kind === 'user') store.log(via ? { from: 'user', to: bot.id, text: via.body, kind: 'user', via: via.kind, who: via.who, ...(thread ? { thread } : {}) } : { from: 'user', to: bot.id, text: said, kind: 'user', ...(thread ? { thread } : {}) });
          else if (kind === 'schedule') store.log({ from: 'schedule', to: bot.id, text: said, kind: 'system' });
        }
      } else if (event.type === 'assistant/message') {
        const content = event.data?.message?.content ?? [];
        const calls = content.filter((b) => b?.type === 'tool-call');
        if (calls.some((b) => (b.name ?? b.toolName) === 'bot_send_message')) answered.add(session.id);
        const st = turnState.get(session.id);
        for (const b of calls) {
          if (!st || (b.name ?? b.toolName) !== 'bot_send_message') continue;
          const id = String(callArgs(b).ticket ?? '').trim().replace(/^(?:ticket|task)\//, '');
          if (id && st.reports.has(id)) st.answers.add(id);
          else st.acted = true;
        }
        const text = calls.length > 0 ? '' : textOf(content);
        const why = trigger.get(session.id);
        // Shown in the bot's chat: what it says to the user. Hidden: acknowledging a schedule notice,
        // the closing words of a turn that answered a bot by DM, and those of a turn whose only inputs
        // were reports and that only answered those tasks (they reach no one). The dispatcher reporting
        // back after its teammates answered is a message to the user, and so is any bot passing on a
        // report from a task it asked for, also in a turn where it hands out more work.
        const plan = channels.replyPlan(session.id);
        // Closing words after bot_reply answered every topic or chat of the turn (Bots 0.9): each has its answer already.
        const topicsOfTurn = plan.origins.filter((o) => isTopicThread(o.threadKey));
        const allAnswered = topicsOfTurn.length > 0 && topicsOfTurn.every((o) => st?.replied?.has(o.threadKey));
        const hidden = why === 'schedule-notice' || (why === 'agent-message' && (bot.role !== 'primary' || answered.has(session.id))) || (why === 'report' && closingOnly(session.id)) || allAnswered;
        if (text && !hidden) {
          // To the turn's one chat Thread; with several (or the panel and a chat) it stays in the panel,
          // and bot_reply says where each answer goes.
          const sent = channels.noteReply(session.id, text);
          const thread = sent ? sent.threadKey : panelThreadKey(session.id);
          // A topic in the panel (Bots 0.9): the reply is shown in it.
          const topic = sent?.kind === 'panel' ? panelTopicOf(sent.threadKey) : '';
          const choices = plan.mode === 'choose' ? plan.origins.filter((o) => o.kind !== 'panel').map((o) => o.threadKey) : [];
          store.log({ from: bot.id, to: 'user', chat: bot.id, text, kind: 'reply', ...(sent && sent.kind !== 'panel' ? { via: sent.kind } : {}), ...(thread ? { thread } : {}), ...(topic ? { topic } : {}), ...(choices.length ? { notSent: true, choices } : {}) });
        }
      } else if (event.type === 'turn/end') {
        channels.noteTurnEnd(session.id);
        turnState.delete(session.id);
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
        const task = openTasks.get(sid) ?? startTask(bot, sid, kind, event, via, typedText);
        const said = typedText ?? textOf(event.data?.content);
        const who = kind === 'schedule' ? 'scheduled' : kind === 'agent-message' ? (ticket ? 'task message' : 'bot message') : via ? `user via ${via.kind}` : 'user';
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
  // What a bot's home or task Session does right now, for the panel (lib/activity.mjs).
  ctx.on('session/event', (session, event) => {
    try {
      if (session?.id && botOfSession(session.id)) activity.note(session.id, event);
    } catch {
      // Live status is a nicety.
    }
  });
  // The surest sign a task is over: the bot's Agent went idle.
  ctx.on('agent/status', (payload) => {
    try {
      const sid = payload?.agent?.session?.id;
      if (sid && payload.status === 'idle') activity.clear(sid);
      if (sid && payload.status === 'idle' && openTasks.has(sid)) settleSoon(sid, 300);
      else if (sid && payload.status === 'idle' && memoStale.delete(sid)) memoText.delete(sid);
      if (sid && payload.status === 'idle') ticketIdle(ticketOf(sid));
    } catch {
      // Ignored.
    }
  });

  // --- questions a bot asks (Harness's ask_user_question), answered from the panel too --------------
  /** The code of a user-questions error (`UserQuestionError`, or one a Client sent back as plain data). */
  const codeOf = (error) => (error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '');
  /** One question as the panel shows it; an approval or a plan review only by its text (the conversation answers it). */
  function askItem(q, native) {
    const options = Array.isArray(q?.options) ? q.options.filter((o) => typeof o?.label === 'string').map((o) => ({ label: o.label, ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}) })) : null;
    return {
      id: String(q?.id ?? ''),
      question: String(q?.question ?? ''),
      ...(native
        ? {}
        : {
            ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
            ...(typeof q.detail === 'string' && q.detail ? { detail: q.detail } : {}),
            ...(options ? { options } : {}),
            ...(q.multiSelect === true ? { multiSelect: true } : {}),
          }),
    };
  }
  /** A waiting question in state (`asks`). */
  const askView = (a) => ({ id: a.id, botId: a.botId, sessionId: a.sessionId, ...(a.ticketId ? { ticketId: a.ticketId } : {}), at: a.at, ...(a.native ? { native: true } : {}), ...(a.continued ? { continued: true } : {}), questions: a.questions });
  /** The chats the asking turn came from (a home's), or the chat its task came from, hear once that it waits for an answer in Harness. */
  function askNotice(ask, bot) {
    const targets = ask.ticketId ? [channels.resolveReply(ask.sessionId, { ticket: ask.ticketId })] : channels.current(ask.sessionId);
    for (const target of targets) {
      if (!target || target.kind === 'panel' || !target.chatId) continue;
      try {
        channels.replyTo(ask.sessionId, target, askNoticeText(bot, ask.questions));
      } catch (error) {
        ctx.logger?.info?.(`bots: question notice: ${error?.message ?? error}`);
      }
    }
  }
  /**
   * One `user-questions/request` (the Agent-scoped waterfall `ctx.userQuestions.ask` runs). A request
   * from a bot's home or a task Session is recorded and settles with whichever answers first: the
   * rest of the chain (`next()`: the Harness window's card) or the panel (`answerAsk`). When no window
   * can ask (`NO_PROVIDER`) it waits for the panel; the request's abort, or any other failure, ends
   * it. The chain gets a signal that also aborts once the panel answered, so the window's card closes.
   * A timed question whose wait ran out (`ASK_TIMED_OUT`) stays answerable (`continued`): the panel
   * answers it through `userQuestions.answer`. Approvals and plan reviews are only recorded; the
   * conversation answers them.
   */
  function askRequest(request, next) {
    const sessionId = request?.agent?.session?.id;
    const bot = botOfSession(sessionId);
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    if (!bot || questions.length === 0) return next();
    const native = questions.some((q) => q?.intent?.kind === 'approval' || q?.intent?.kind === 'plan-review');
    const ticket = ticketOf(sessionId);
    const ask = { id: `ask-${randomUUID()}`, botId: bot.id, sessionId, ...(ticket ? { ticketId: ticket.id } : {}), at: nowMs(), ...(native ? { native: true } : {}), questions: questions.map((q) => askItem(q, native)) };
    asks.set(ask.id, ask);
    askNotice(ask, bot);
    const chain = () => {
      try {
        return Promise.resolve(next());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    if (native) return chain().finally(() => asks.delete(ask.id));
    const original = request.signal instanceof AbortSignal ? request.signal : undefined;
    const panel = new AbortController();
    try {
      request.signal = original ? AbortSignal.any([original, panel.signal]) : panel.signal;
    } catch {
      // A frozen request keeps its own signal: the window's card then stays until the call ends.
    }
    const callId = request.wait?.timed === true && typeof request.wait.callId === 'string' ? request.wait.callId : '';
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (ok, value) => {
        if (done) return;
        done = true;
        original?.removeEventListener('abort', onAbort);
        delete ask.settle;
        if (!ok && callId && codeOf(value) === 'ASK_TIMED_OUT') Object.assign(ask, { continued: true, callId });
        else asks.delete(ask.id);
        panel.abort(new Error('the question was settled'));
        (ok ? resolve : reject)(value);
      };
      const onAbort = () => finish(false, original.reason);
      ask.settle = (answer) => finish(true, answer);
      if (original?.aborted) return onAbort();
      original?.addEventListener('abort', onAbort, { once: true });
      chain().then(
        (answer) => finish(true, answer),
        (error) => {
          if (codeOf(error) !== 'NO_PROVIDER') finish(false, error);
        },
      );
    });
  }
  // First in the chain: the Harness forwards the request to its window and holds it there until that
  // card is answered, so a listener after it would never hear of the question while a window is open.
  ctx.on('user-questions/request', (request, next) => askRequest(request, next), { prepend: true });
  // A continued question answered in the conversation: its reply reaches the Session.
  ctx.on('session/event', (session, event) => {
    const source = event?.type === 'user/message' ? event.data?.source : null;
    if (source?.kind !== 'user-question-reply') return;
    for (const a of asks.values()) if (a.continued && a.sessionId === session?.id && a.callId === source.callId) asks.delete(a.id);
  });

  /** One item per question, ids matching; labels among its options; a single-select question takes one answer. A reason when not. */
  function checkAnswers(questions, answers) {
    if (!Array.isArray(answers) || answers.length !== questions.length) return `give one answer for each of the ${questions.length} question(s)`;
    const out = [];
    for (const q of questions) {
      const mine = answers.filter((a) => a && typeof a === 'object' && a.id === q.id);
      if (mine.length !== 1) return `answer question "${q.id}" exactly once`;
      const a = mine[0];
      if (!Array.isArray(a.selected) || a.selected.some((s) => typeof s !== 'string')) return `"selected" of question "${q.id}" must be a list of option labels`;
      const selected = [...new Set(a.selected)];
      const custom = typeof a.custom === 'string' ? a.custom.trim().slice(0, 4000) : '';
      const unknown = selected.find((s) => !(q.options ?? []).some((o) => o.label === s));
      if (unknown !== undefined) return `"${unknown}" is not an option of question "${q.id}"`;
      if (selected.length === 0 && !custom) return `question "${q.id}" has no answer`;
      if (!q.multiSelect && selected.length + (custom ? 1 : 0) > 1) return `question "${q.id}" takes one answer`;
      out.push({ id: q.id, selected, ...(custom ? { custom } : {}) });
    }
    return out;
  }
  /** POST /asks/:id/answer `{answers}`: the panel answers a waiting question; the timeline shows what was answered. */
  async function answerAsk(id, body) {
    const ask = asks.get(String(id ?? ''));
    if (!ask) return { ok: false, reason: 'no such question: it was answered already or is no longer waiting' };
    if (ask.native) return { ok: false, reason: 'this one is answered in the conversation' };
    const items = checkAnswers(ask.questions, body?.answers);
    if (typeof items === 'string') return { ok: false, reason: items };
    if (ask.continued) {
      const uq = service(ctx, 'userQuestions');
      const agent = agents()?.get?.(ask.sessionId);
      if (typeof uq?.answer !== 'function' || !agent) return { ok: false, reason: 'the conversation is not running; answer the question there' };
      try {
        const taken = await uq.answer(agent, ask.callId, { answers: items });
        asks.delete(ask.id);
        if (!taken) return { ok: false, reason: 'the question is no longer waiting for an answer' };
      } catch (error) {
        if (codeOf(error) === 'REPLY_QUEUED') asks.delete(ask.id);
        return { ok: false, reason: error?.message ?? String(error) };
      }
    } else if (ask.settle) ask.settle({ answers: items });
    else return { ok: false, reason: 'the question is no longer waiting for an answer' };
    const said = (q) => {
      const a = items.find((x) => x.id === q.id);
      return `${q.question}\n→ ${[...a.selected, ...(a.custom ? [a.custom] : [])].join(', ')}`;
    };
    store.log({ from: 'user', to: ask.botId, text: ask.questions.map(said).join('\n\n'), kind: 'user', ...(ask.ticketId ? { ticket: ask.ticketId } : { thread: panelThreadKey(ask.sessionId) }) });
    return { ok: true };
  }

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
    dropDrawing(bot.id, 'deleted');
    try {
      for (const task of await schedulesOf(bot)) await schedule().edit({ id: task.id, action: 'delete' });
    } catch {
      // No schedule service or nothing to remove.
    }
    if (bot.sessionId) {
      uninstall(bot.sessionId);
      forgetSession(bot.sessionId);
      try {
        service(ctx, 'workspaceRegistry')?.archiveSession?.(bot.sessionId);
      } catch {
        // The conversation stays where it is.
      }
    }
    // Its tickets end with it; their conversations are archived now.
    for (const t of tickets.list({ botId: bot.id, archived: false })) {
      if (!t.ended) endTicket(t, { by: 'system', outcome: 'stopped' });
      if (t.sessionId) {
        uninstall(t.sessionId);
        forgetSession(t.sessionId);
        try {
          await service(ctx, 'workspaceRegistry')?.archiveSession?.(t.sessionId);
        } catch {
          // Archived at the next upkeep, or left as it is.
        }
      }
      tickets.archive(t.id);
    }
    // The tasks it asked for (from its home or its tasks) end too: nobody is left to read their reports.
    // They stay in the panel, stopped, where the user can still retry one.
    for (const t of tickets.list({ open: true })) {
      if (t.requester?.botId === bot.id) endTicket(t, { by: 'system', outcome: 'stopped', error: `@${bot.handle}, who asked for it, was removed` });
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
    if (!bot.model) return;
    const live = agents();
    const ids = [bot.sessionId, ...tickets.list({ botId: bot.id, open: true }).map((t) => t.sessionId)].filter(Boolean);
    for (const id of ids) {
      try {
        live?.get?.(id)?.model?.select?.(selectionOf(bot.model));
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
  /** Draw a picture for `bot` with the Images plugin's generate_image; its bytes and type. `signal` gives up on it. */
  async function drawAvatar(bot, extra, signal) {
    const tool = imageTool();
    if (!tool) throw new Error('the Images plugin (generate_image) is not installed or turned off');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('the image service did not answer within 5 minutes')), 300_000);
    const stop = () => controller.abort(signal?.reason ?? new Error('stopped'));
    if (signal?.aborted) stop();
    else signal?.addEventListener?.('abort', stop, { once: true });
    let value;
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          value = await tool.execute({ prompt: avatarPrompt(bot, extra), size: '1024x1024', n: 1 }, { signal: controller.signal });
          break;
        } catch (error) {
          const message = String(error?.message ?? error);
          // Gateways drop long image requests now and then; those are worth another try.
          // Given up on (out of time, or replaced): why, rather than the tool's own abort message.
          if (controller.signal.aborted) throw new Error(controller.signal.reason instanceof Error ? controller.signal.reason.message : message);
          if (attempt >= AVATAR_ATTEMPTS || !TRANSIENT.test(message)) {
            throw new Error(TRANSIENT.test(message) ? `the image service failed ${attempt} times in a row (${message}); try again in a moment` : message);
          }
          ctx.logger?.warn?.(`bots: avatar for @${bot.handle}, attempt ${attempt} failed: ${message}; retrying`);
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        }
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', stop);
    }
    const path = value?.images?.[0]?.path;
    const type = value?.images?.[0]?.mediaType;
    if (!path || !/^image\/(png|jpeg|webp|gif)$/.test(String(type))) throw new Error('the image model returned no picture');
    const bytes = readFileSync(path);
    if (bytes.length > 8 * 1024 * 1024) throw new Error('the generated picture is too large');
    return { bytes, type };
  }

  /**
   * Drawings under way, by bot: only the latest asked for a bot counts. `sessionId`: the bot
   * conversation that asked (it gets a note when the drawing ends), none for a person's own
   * conversation or the panel (they wait for it). Kept in memory only: a restart drops them, and
   * nobody hears of one dropped that way.
   */
  const drawings = new Map();
  /** Message id of a drawing's note → the Threads of the turn that asked for it (the answer to the person goes there). */
  const drawingOrigins = new Map();
  /** One drawing whose outcome nobody waits for any more: an avatar change since replaced it. */
  function dropDrawing(botId, by) {
    const job = drawings.get(botId);
    if (!job) return;
    drawings.delete(botId);
    job.droppedBy = by ?? 'panel';
    job.controller.abort(new Error('replaced by a newer avatar change'));
  }
  /**
   * Draw `bot`'s avatar: the drawing replaces any still under way for it, and its picture is saved
   * when it is still the latest asked once it is ready. `job.done` resolves to the bot with its new
   * picture, or rejects with why not (`dropped`: replaced meanwhile, or the bot is gone).
   */
  function startDrawing(bot, extra, { sessionId = null, by = null } = {}) {
    dropDrawing(bot.id, sessionId ?? 'panel');
    const job = { id: `a${randomUUID().replace(/-/g, '').slice(0, 12)}`, botId: bot.id, handle: bot.handle, name: bot.name, sessionId, by, at: nowMs(), controller: new AbortController() };
    drawings.set(bot.id, job);
    const current = () => drawings.get(bot.id) === job;
    job.done = (async () => {
      try {
        const { bytes, type } = await drawAvatar(store.get(bot.id) ?? bot, extra, job.controller.signal);
        const now = store.get(bot.id);
        if (!current() || !now) throw Object.assign(new Error(now ? 'its avatar was changed meanwhile' : 'the bot was deleted'), { dropped: true });
        return savePicture(now, bytes, type, 'ai');
      } catch (error) {
        if (error?.dropped || (current() && store.get(bot.id))) throw error;
        throw Object.assign(new Error(store.get(bot.id) ? 'its avatar was changed meanwhile' : 'the bot was deleted'), { dropped: true });
      } finally {
        if (current()) drawings.delete(bot.id);
      }
    })();
    return job;
  }
  /** Draw `bot`'s avatar and wait for it (the panel, a person's own conversation): the bot with its picture. */
  async function generateAvatar(bot, extra) {
    if (!imageTool()) throw new Error('the Images plugin (generate_image) is not installed or turned off');
    try {
      return await startDrawing(bot, extra).done;
    } catch (error) {
      throw new Error(error?.dropped ? `no picture was saved: ${error.message}` : String(error?.message ?? error));
    }
  }
  /**
   * A drawing a bot asked for goes on without it: the caller's turn goes on, and its conversation
   * gets one note when the drawing ends (ready, or why not). A home takes it steered, so drawings that
   * end together arrive together; a task's Session takes it like any message for its task (once it
   * has a worker slot), unless the task has ended. A drawing replaced from the same conversation, or
   * dropped by a restart, sends nothing.
   */
  function drawInBackground(bot, extra, caller) {
    const job = startDrawing(bot, extra, { sessionId: caller.sessionId, by: caller.bot.id });
    // The Threads of the asking turn: the note's answer goes back where the person asked.
    const origins = (() => {
      try {
        return channels.replyPlan(caller.sessionId).origins.map(({ body: _b, tickets: _t, ...o }) => o).filter((o) => o.threadKey);
      } catch {
        return [];
      }
    })();
    const who = `@${job.handle}`;
    job.done.then(
      (saved) => noteDrawing(job, origins, `[Avatar ready] The new avatar of ${who} (${saved?.name ?? job.name}) is ready and shows in Bots now. Tell the person if they are waiting for it.`),
      (error) => {
        const reason = String(error?.message ?? error).slice(0, 300);
        if (!error?.dropped) return noteDrawing(job, origins, `[Avatar failed] The picture for ${who} could not be drawn: ${reason}. Its avatar is unchanged.`);
        if (job.droppedBy !== job.sessionId) return noteDrawing(job, origins, `[Avatar dropped] The picture for ${who} was not used: ${reason}.`);
        return undefined;
      },
    );
    return job;
  }
  /** A drawing's note to the conversation that asked for it (`job.sessionId`): see `drawInBackground`. */
  async function noteDrawing(job, origins, text) {
    try {
      const key = `avatar:${job.id}`;
      const content = [{ type: 'text', text }];
      const source = { kind: 'agent-message', form: 'relay' };
      const t = ticketOf(job.sessionId);
      if (t) {
        const cur = tickets.get(t.id);
        if (cur && !cur.ended && !cur.archivedAt) await toTicket(cur, { content, source, key });
        return;
      }
      const asker = store.get(job.by);
      if (!asker) return;
      if (origins.length) {
        drawingOrigins.set(`${MESSAGE_PREFIX}${key}`, origins);
        // A note never delivered (Harness gone meanwhile) leaves nothing behind for long.
        while (drawingOrigins.size > 200) drawingOrigins.delete(drawingOrigins.keys().next().value);
      }
      // The asking bot may have started a new topic since: the note goes to the conversation it has now.
      await sendTo(await agentOf(asker), { content, source, mode: 'steer', key });
    } catch (error) {
      ctx.logger?.warn?.(`bots: the note about @${job.handle}'s avatar did not arrive: ${error?.message ?? error}`);
    }
  }
  /** Store `bytes` as the bot's picture avatar. */
  function savePicture(bot, bytes, type, source) {
    mkdirSync(join(dir, 'avatars'), { recursive: true });
    writeFileSync(join(dir, 'avatars', bot.id), bytes);
    writeFileSync(join(dir, 'avatars', `${bot.id}.type`), type);
    return store.patch(bot.id, { avatar: { kind: 'image', ...(source ? { source } : {}), url: `${R}/avatar/${bot.id}?v=${Date.now().toString(36)}`, color: bot.avatar.color } });
  }
  /** The image type of `bytes` by its first bytes: PNG, JPEG, WebP or GIF; else ''. */
  function pictureType(bytes) {
    if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    if (bytes.length > 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif';
    return '';
  }
  /** A picture file on this computer becomes the bot's avatar (a tool's `avatar_file`). */
  function avatarFromFile(bot, file) {
    const path = String(file ?? '').trim().replace(/^~(?=\/)/, homedir());
    if (!isAbsolute(path)) throw new Error('avatar_file must be an absolute path to an image file');
    let bytes;
    try {
      if (statSync(path).size > MAX_AVATAR) throw new Error('the image is larger than 2 MB');
      bytes = readFileSync(path);
    } catch (error) {
      throw new Error(/2 MB/.test(String(error?.message)) ? error.message : `cannot read ${path}: ${error?.code ?? error?.message ?? error}`);
    }
    const type = pictureType(bytes);
    if (!type) throw new Error('avatar_file must be a PNG, JPEG, WebP or GIF image');
    return savePicture(bot, bytes, type);
  }
  /** Back to letters: the picture is removed. */
  function clearPicture(bot) {
    for (const f of [bot.id, `${bot.id}.type`]) rmSync(join(dir, 'avatars', f), { force: true });
    return store.patch(bot.id, { avatar: { kind: 'initials', color: bot.avatar.color } });
  }
  const AVATAR_PARAMS = {
    avatar_prompt: {
      type: 'string',
      description:
        'Draw a picture avatar with AI from this description of the look and style (e.g. "photorealistic portrait of a woman in her thirties, studio light"). Needs the Images plugin (the result says so when it is not available). Called from a bot\'s conversation, the drawing runs in the background: the call returns at once and a note arrives in this conversation when the picture is ready (or why it failed), so never wait or poll for it. A restart of Harness drops a drawing still under way, without a note.',
    },
    avatar_file: { type: 'string', description: 'Absolute path of an image file on this computer (PNG, JPEG, WebP or GIF, at most 2 MB) to use as the avatar picture.' },
  };
  /**
   * Apply a tool's picture arguments to `bot`; the note says what happened (a failed drawing leaves
   * the rest of the change in place). From a bot's conversation (`caller.bot`), a drawing runs in the
   * background and the note says a message will come; from a person's own conversation it is awaited.
   * Any other avatar change replaces a drawing still under way.
   */
  async function applyPicture(bot, args, caller = {}) {
    const by = caller.sessionId ?? 'panel';
    if (typeof args.avatar_file === 'string' && args.avatar_file.trim()) {
      const saved = avatarFromFile(bot, args.avatar_file);
      dropDrawing(bot.id, by);
      return { bot: saved, note: ' Its avatar is now that picture.' };
    }
    if (typeof args.avatar_prompt === 'string' && args.avatar_prompt.trim()) {
      if (!imageGenAvailable()) return { bot, note: ' No picture was drawn: AI avatars need the Images plugin (generate_image), which is not installed or is turned off. The user can install it from the plugin market, or upload a picture on the bot\'s Profile page; avatar_file takes an image file.' };
      if (caller.bot && caller.sessionId) {
        drawInBackground(bot, args.avatar_prompt, caller);
        return { bot, drawing: true, note: ' Its avatar picture is being drawn in the background (often a minute or more); the current avatar stays until then. A note arrives in this conversation when it is ready, or with the reason if it fails: do not wait or poll for it, carry on.' };
      }
      try {
        return { bot: await generateAvatar(bot, args.avatar_prompt), note: ' Its avatar is now a picture drawn from that description.' };
      } catch (error) {
        return { bot, note: ` The picture could not be drawn: ${String(error?.message ?? error).slice(0, 300)}` };
      }
    }
    if (args.avatar_clear === true && bot.avatar.kind === 'image') {
      dropDrawing(bot.id, by);
      return { bot: clearPicture(bot), note: ' Its avatar is back to letters.' };
    }
    if (args.avatar_clear === true || args.initials || args.color) dropDrawing(bot.id, by);
    return { bot, note: '' };
  }

  // --- who calls a tool ----------------------------------------------------------------------
  /**
   * Who calls a tool: the conversation it runs in; or, for a Harness subagent or fork (its Session
   * header says `origin: 'subagent'` and names the `parentSession` that made it), the bot home or task
   * Session it descends from, which it then acts as (a helper inside task t1 is task t1, with its
   * limits). `bot`: that conversation's bot; none for a person's own conversation (a top-level Session
   * no bot owns, or a helper of one). `restricted`: a helper whose line cannot be traced to a
   * conversation (a creator that is gone was no bot's, or a loop); it acts for no one.
   * @returns {{sessionId: string|undefined, bot?: object, restricted?: true}}
   */
  function actorOf(exec) {
    const own = exec?.agent?.session?.id;
    const ownBot = botOfSession(own);
    if (!own || ownBot) return { sessionId: own, ...(ownBot ? { bot: ownBot } : {}) };
    const live = agents();
    let header = exec.agent.session.header ?? live?.get?.(own)?.session?.header;
    const seen = new Set([own]);
    while (header?.origin === 'subagent' && typeof header.parentSession === 'string' && header.parentSession !== '') {
      const parent = header.parentSession;
      if (seen.has(parent)) return { sessionId: own, restricted: true };
      seen.add(parent);
      const bot = botOfSession(parent);
      if (bot) return { sessionId: parent, bot };
      const up = live?.get?.(parent);
      if (!up) return { sessionId: own, restricted: true };
      // A live creator without a header cannot be a helper itself: a top-level conversation.
      header = up.session?.header ?? {};
    }
    return { sessionId: own };
  }
  /** The caller (`actorOf`); one that acts for no one is refused. */
  function actor(exec) {
    const a = actorOf(exec);
    if (a.restricted) throw new Error('this conversation is a helper whose starting conversation cannot be traced (it is gone), so it cannot act on bots or tasks; report what you found to whoever started you instead');
    return a;
  }

  // --- what bot_recall reads ---------------------------------------------------------------
  /**
   * Who reads with bot_recall (an `actorOf` caller): a ticket Session (limited to its task), the router
   * home, another home; a helper that cannot be traced reads nothing; else unlimited (the user).
   */
  function viewerOf(caller) {
    if (caller?.restricted) return { kind: 'restricted' };
    const sessionId = caller?.sessionId;
    const t = ticketOf(sessionId);
    if (t) return { kind: 'ticket', ticketId: t.id };
    const bot = store.bySession(sessionId);
    if (!bot) return undefined;
    return isRouterHome(bot, sessionId) ? { kind: 'router' } : { kind: 'home' };
  }
  /** Threads as bot_recall reads them: stored with tickets, seen lately in a chat, or a panel conversation; the timeline's latest messages there. */
  const recallThreads = {
    thread: (key) => {
      const stored = tickets.thread(key);
      if (stored) return stored;
      const info = channels.threadInfo(key);
      if (info) return { key, kind: info.kind, label: threadLabel(info) };
      return isPanelThread(key) ? { key, kind: 'panel', label: threadLabel(key) } : undefined;
    },
    subscribers: (key) => tickets.subscribers(key),
    recent: (key) =>
      store
        .messages({ limit: 2000 })
        .filter((m) => m.thread === key)
        .slice(-10)
        .map((m) => ({ at: m.at, who: m.from === 'user' ? m.who || 'the user' : m.from === 'schedule' ? 'schedule' : handleOf(m.from), text: m.text })),
  };
  /** One stored Session event as a transcript line, or ''. */
  function eventLine(e) {
    const d = e?.data ?? {};
    if (e?.type === 'user/message') {
      const said = textOf(d.content);
      return said ? `[${d.source?.kind === 'user' ? 'user' : 'message'}] ${said}` : '';
    }
    if (e?.type === 'assistant/message') {
      const parts = [];
      for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (b?.type === 'text' && b.text?.trim()) parts.push(`[assistant] ${b.text.trim()}`);
        else if (b?.type === 'tool-call') {
          let args = '';
          try {
            args = typeof b.argsRaw === 'string' ? b.argsRaw : JSON.stringify(b.args ?? b.arguments ?? b.input ?? {});
          } catch {
            args = '';
          }
          parts.push(`[tool] ${b.name ?? b.toolName ?? 'tool'} ${args.slice(0, 400)}`);
        }
      }
      return parts.join('\n');
    }
    if (e?.type === 'tool/result') {
      const said = textOf(d.message?.content ?? d.content);
      return said ? `[result] ${said.slice(0, 600)}` : '';
    }
    return '';
  }
  /** A ticket Session's conversation: from its stored log when Harness has one, else from the runs this process recorded. */
  async function transcriptOf(t) {
    const events = t.sessionId ? await readHistory(t.sessionId).catch(() => null) : null;
    const fromLog = (events ?? []).map(eventLine).filter(Boolean);
    if (fromLog.length) return fromLog;
    const lines = [...(doneLogs.get(t.id) ?? []), ...(ticketLogs.get(t.id)?.log ?? []), ...(t.sessionId ? openTasks.get(t.sessionId)?.log ?? [] : [])];
    return lines.length ? lines : `(No transcript of task ${t.id} is kept here; its reports are at ticket/${t.id}/reports.)`;
  }

  // --- the model's tools ------------------------------------------------------------------
  const callerBot = (exec) => actor(exec).bot;
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
          const open = tickets.list({ botId: b.id, open: true }).length;
          return [`${card(b)} [${botStatus(b)}${open ? `, ${open} open task${open === 1 ? '' : 's'}` : ''}]${b.bio ? `: ${b.bio}` : ''}`, sk.length ? `  skills: ${sk.join(', ')}` : '', ap.length ? `  apps: ${ap.join(', ')}` : '', ts.length ? `  scheduled: ${ts.join('; ')}` : ''].filter(Boolean).join('\n');
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
        ...AVATAR_PARAMS,
        skills: { ...skillInput, description: 'Skills to give it.' },
      },
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ bot: v.bot }) },
      execute: async (args, exec) => {
        const caller = actor(exec);
        const by = caller.bot;
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
        const pic = await applyPicture(bot, args, caller);
        return { ok: true, text: `Created ${card(pic.bot)}. Message it with bot_send_message to @${bot.handle}.${pic.note}${offNote(args.skills, bot)}`, bot: face(pic.bot) };
      },
    }),
    defineTool({
      name: 'bot_update',
      description: "Change a bot (yourself included): name, bio, persona, avatar (letters and colour, a picture drawn by AI, or an image file), skills, or make it the dispatcher. Only the fields you pass change.",
      parameters: {
        bot: { type: 'string', required: true, description: '@handle, id or name of the bot.' },
        name: { type: 'string' },
        bio: { type: 'string' },
        persona: { type: 'string', description: 'Replaces the whole persona.' },
        initials: { type: 'string', description: 'Avatar letters, at most two.' },
        color: { type: 'string', description: 'Avatar background colour, CSS hex.' },
        ...AVATAR_PARAMS,
        avatar_clear: { type: 'boolean', description: 'true to remove the avatar picture and go back to letters.' },
        add_skills: { ...skillInput, description: `Skills to add (a skill with the same name is replaced). At most ${MAX_SKILLS_ON} can be on at once; past that they are added switched off.` },
        remove_skills: { type: 'array', items: { type: 'string' }, description: 'Names of skills to remove.' },
        make_dispatcher: { type: 'boolean', description: 'true to make this bot the dispatcher.' },
      },
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ bot: v.bot }) },
      execute: async (args, exec) => {
        // A helper whose line cannot be traced still changes bots, as before; it waits for a drawing.
        const caller = actorOf(exec);
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
        const pic = await applyPicture(store.save(next), args, caller.restricted ? {} : caller);
        const saved = pic.bot;
        return { ok: true, text: `Updated ${card(saved)}.${pic.note}${offNote(args.add_skills, saved)}`, bot: face(saved) };
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
      description: [
        'Message another bot, or report on the task this conversation works on. Make the text self-contained: the other bot cannot see this conversation. Do not reply to acknowledgements.',
        "- To delegate: `to` (the bot's @handle) and `text`. Depending on how the team works, this opens a task (ticket) that the bot works on in a conversation of its own, or drops the text into that bot's own conversation; the result says which. Either way the call returns at once and the answer (a report, or a bot message) arrives here by itself: never wait or poll for it.",
        '- When this turn involves several topics or chats, name the one a new task is for with `thread` (as its message header shows it), so its answer goes there.',
        '- The dispatcher may name itself in `to`: it then does the work in a task conversation of its own, with all its tools.',
        '- A task from a topic or chat answers the person there itself; pass `report_to: "me"` to get its reports back instead (to combine several results).',
        '- To add to an open task you asked for (an answer to its question, a change, a message of the person\'s that continues it): `ticket` (its id) and `text`.',
        '- In a task conversation, to report to whoever asked: leave out `to`, give `text` and a `status` (progress, done, blocked, question).',
      ].join('\n'),
      parameters: {
        to: { type: 'string', description: '@handle (or id / name) of the bot. Leave it out to report on your own task.' },
        text: { type: 'string', required: true, description: 'The whole message or report.' },
        ticket: { type: 'string', description: 'Id of an open task to add this message to.' },
        status: { type: 'string', enum: REPORT_STATUSES, description: 'Required when reporting from a task conversation: progress (an update worth keeping), done (with the result), blocked, question.' },
        title: { type: 'string', description: 'A short title for a new task; taken from the first line of text when left out.' },
        thread: { type: 'string', description: 'Only when this turn involves several topics or chats: the thread (as the message header "(thread …)" shows it) the new task, or the message added to a task, is for. A new task then answers there, and follow-ups there reach it. Left out with several, a new task belongs to none of them.' },
        report_to: { type: 'string', enum: ['thread', 'me'], description: 'For a new task: "thread" (default) — its bot answers the person in the topic or chat the request came from; "me" — its reports come back to you.' },
      },
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ to: v.to, from: v.from, ...(v.ticket ? { ticket: v.ticket } : {}) }) },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const { sessionId, bot: sender } = actor(exec);
        const mine = ticketOf(sessionId);
        const named = args.to !== undefined && String(args.to).trim() !== '' ? resolve(args.to) : null;
        const wantTicket = typeof args.ticket === 'string' && args.ticket.trim() !== '' ? args.ticket.trim().replace(/^ticket\//, '') : '';
        const row = (t) => ticketRow(t);
        const status = typeof args.status === 'string' && args.status.trim() !== '' ? args.status.trim().toLowerCase() : '';

        // In a ticket Session: a report to whoever asked (no `to`, the requester, or its own ticket).
        if (mine && sender) {
          const requesterBot = mine.requester?.botId;
          const isReport = wantTicket ? wantTicket === mine.id : !named || (named.id === requesterBot && named.id !== sender.id);
          if (isReport) {
            if (!status) throw new Error(`a report on task ${mine.id} needs a status: progress (an update), done (with the result), blocked or question`);
            const { ticket, relayed, unread, parent, shown } = await reportTicket(mine, status, args.text);
            const to = requesterBot ? store.get(requesterBot) : null;
            const said =
              status === 'progress'
                ? `Recorded on task ${ticket.id}; progress does not interrupt whoever asked. Go on with the work.`
                : shown
                  ? `Shown to the person as it is, in ${shown.where}${to ? `; @${to.handle} is told` : ''}.${status === 'done' ? ' The task is done: end your turn without a summary.' : ' Their answer will arrive here by itself; end your turn now.'}`
                : unread
                  ? `Recorded "${status}" on task ${ticket.id}, but nobody is told: ${unread === 'ended' ? `the task has ended (${stageOf(ticket)})` : `the task that asked for it${parent ? `, ${parent},` : ''} has ended`}. The report is kept on the task; end your turn now.`
                  : `Reported "${status}" on task ${ticket.id} to ${to ? `@${to.handle}` : 'the user'}${relayed || !to ? '' : ' (it could not be reached just now; the report is kept on the task)'}.${status === 'done' ? ' The task is done: end your turn without a summary.' : ' An answer will arrive here by itself; end your turn now.'}`;
            return { ok: true, text: said, ticket: row(ticket), to: face(to), from: face(sender) };
          }
        }
        if (status) throw new Error(mine ? `\`status\` is for reports to whoever asked for task ${mine.id} (leave out "to"); to ask @${named?.handle ?? 'a bot'} for help, leave out \`status\`` : '`status` is only for reports from a task conversation; leave it out here');

        const chosen = typeof args.thread === 'string' && args.thread.trim() !== '' ? threadRef(args.thread, sessionId) : '';
        // Adding to an existing ticket.
        if (wantTicket) {
          const t = tickets.get(wantTicket);
          if (!t) throw new Error(`no task ${wantTicket}`);
          if (named && named.id !== t.botId) throw new Error(`task ${t.id} belongs to ${handleOf(t.botId)}, not @${named.handle}; leave out "to" or name its bot`);
          if (!mayAppend(t, sender, sessionId)) throw new Error(`task ${t.id} was not asked for from this conversation; message its bot with a new task instead`);
          const next = await appendToTicket(t, args.text, { sender: sender ?? null, senderSessionId: sessionId });
          const target = store.get(next.botId);
          const waits = next.startedAt && parkedOf(next).length > 0 ? ': every worker slot is taken, so it is handed over when one frees' : '';
          // The person's new message that continues this task joins the task's topic (Bots 0.9).
          const filed = !mine && sender ? fileUnder(next, sessionId, chosen) : '';
          const after = reportsGoDirect(next) ? `${handleOf(next.botId)} answers the person in the task's ${isPanelThread(next.origin?.threadKey) ? 'topic' : 'chat'} itself` : `${handleOf(next.botId)}'s report will arrive here by itself`;
          return { ok: true, text: `Added to task ${next.id} (${stageOf(next)}${waits}).${filed ? " The person's message is filed under that task's topic." : ''} ${after}; do not wait for it.`, ticket: row(next), to: face(target), from: face(sender) };
        }
        if (!named) throw new Error(mine ? 'say which bot with `to`, or leave it out and give a `status` to report on your task' : 'say which bot with `to`');

        // A new ticket: from a task conversation (a sub-task), or from a bot's home when tasks are on.
        if (sender && sessionId && (mine || (ticketsOn() && sender.sessionId === sessionId))) {
          const relay = String(args.report_to ?? '').trim().toLowerCase() === 'me';
          const t = await openTicket(sender, named, args.text, sessionId, { title: args.title, thread: chosen, relay });
          const stage = stageOf(t);
          const who = named.id === sender.id ? 'yourself' : `@${named.handle}`;
          const answer = reportsGoDirect(t)
            ? `${named.id === sender.id ? 'You answer' : `@${named.handle} answers`} the person in ${isPanelThread(t.origin?.threadKey) ? 'the topic' : 'the chat'} it came from, and you get a note; do not wait for it or repeat it — tell the person in one line who is on it and end your turn.`
            : 'Its report will arrive here by itself; never wait or poll for it — go on with other work or end your turn.';
          const said =
            stage === 'failed'
              ? `Task ${t.id} for ${who} could not start: ${t.error ?? 'unknown error'}.`
              : `Opened task ${t.id} for ${who} (${stage === 'queued' ? 'queued: it starts when another task finishes' : stage}). ${answer}`;
          return { ok: stage !== 'failed', text: said, ticket: row(t), stage, to: face(named), from: face(sender) };
        }
        // 0.7: into the other bot's home (the user from any conversation; any home in hands-on mode).
        if (chosen) throw new Error('`thread` is for opening a task; this message goes to the bot\'s own conversation, so leave it out');
        await deliver(sender ?? null, named, args.text, sessionId);
        return { ok: true, text: `Delivered to @${named.handle}. Its answer will arrive as a new message; continue with other work or end your turn.`, to: face(named), from: face(sender) };
      },
    }),
    defineTool({
      name: 'bot_reply',
      description:
        'Answer in a topic or chat: the one a task came from (`ticket`: its id), or a thread (`thread`: as message headers "(thread …)" and task cards show it — a panel topic `p…`, or a chat thread key). Use it when this turn involves more than one topic or chat, so each answer stays in its own; your plain text then reaches none of them. With a single one in the turn, plain text goes there already.',
      parameters: {
        ticket: { type: 'string', description: 'Id of a task (t…): the reply goes to the topic or chat that task came from.' },
        thread: { type: 'string', description: 'A panel topic (p…) or chat thread key of this turn (or of a task you know of).' },
        text: { type: 'string', required: true, description: 'The reply, as the person should read it.' },
      },
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ via: v.via, thread: v.thread }) },
      execute: async (args, exec) => {
        const { sessionId, bot } = actor(exec);
        if (ticketOf(sessionId)) throw new Error('a task conversation talks to no chat: report with bot_send_message (leave out "to"), and whoever asked passes it on');
        if (!bot) throw new Error("bot_reply answers from a bot's own conversation; this conversation has no chats");
        const body = String(args.text ?? '').trim();
        if (body === '') throw new Error('text must not be empty');
        const thread = typeof args.thread === 'string' && args.thread.trim() !== '' ? threadRef(args.thread, sessionId) : '';
        const ticketId = typeof args.ticket === 'string' && args.ticket.trim() !== '' ? args.ticket.trim().replace(/^(?:ticket|task)\//, '') : '';
        const options = () => {
          const list = turnChoices(sessionId);
          return list.length ? `This turn's topics and chats: ${list.join('; ')}.` : 'This turn has no topic or chat; a task id names the one it came from.';
        };
        if (!thread && !ticketId) throw new Error(`say where: \`ticket\` (a task id) or \`thread\` (a topic or thread). ${options()}`);
        // A topic in the panel (Bots 0.9): this turn's, one a task came from, or any the bot's chat has.
        const panelKey = thread ? (panelTopicOf(thread) ? thread : '') : panelTopicOf(tickets.get(ticketId)?.origin?.threadKey) ? tickets.get(ticketId).origin.threadKey : '';
        const target = panelKey ? { kind: 'panel', threadKey: panelKey } : channels.resolveReply(sessionId, thread ? { thread } : { ticket: ticketId });
        if (!target) throw new Error(`${thread ? `no topic or chat thread "${thread}"` : `no topic or chat for task ${ticketId}`} can be reached from here. ${options()}`);
        const st = turnState.get(sessionId);
        if (st) (st.replied ??= new Set()).add(target.threadKey);
        if (target.kind === 'panel') {
          const topic = panelTopicOf(target.threadKey);
          const chat = (topic && store.message(topic)?.chat) || bot.id;
          store.log({ from: bot.id, to: 'user', chat, text: body, kind: 'reply', thread: topic ? target.threadKey : panelThreadKey(sessionId), ...(topic ? { topic } : {}) });
          return { ok: true, text: topic ? `Shown in the panel, in topic ${topic}.` : 'That thread is the panel: the reply is shown there.', thread: target.threadKey };
        }
        channels.replyTo(sessionId, target, body);
        store.log({ from: bot.id, to: 'user', chat: bot.id, text: body, kind: 'reply', via: target.kind, thread: target.threadKey });
        return { ok: true, text: `Sent to ${threadLabel(target)}.`, thread: target.threadKey, via: target.kind };
      },
    }),
    defineTool({
      name: 'bot_recall',
      description:
        'Read tasks (tickets) and chat threads by reference instead of guessing: `tickets` (a page of them, open ones first), `ticket/<id>` (its card), `ticket/<id>/text` (what was asked), `ticket/<id>/reports`, `ticket/<id>/transcript` (its conversation), `thread/<key>` (a chat thread: its tasks and latest messages), `bot/<handle>` (that bot\'s tasks). Every id on a card can be read this way; long text comes in pages (`offset`). From a task conversation you can read that task, its parent and sub-tasks, and its threads.',
      parameters: {
        ref: { type: 'string', required: true, description: 'tickets, ticket/<id>, ticket/<id>/text, ticket/<id>/reports, ticket/<id>/transcript, thread/<key> or bot/<handle>.' },
        offset: { type: 'number', description: 'Where the next page starts: the `next_offset` of the last one.' },
      },
      output: { schema: anyValue, render: (_a, v) => text(v.text) },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const result = await readResource(String(args.ref ?? ''), {
          viewer: viewerOf(actorOf(exec)),
          tickets,
          threads: recallThreads,
          bots: store.list(),
          stageOf,
          transcript: (t) => transcriptOf(t),
          offset: args.offset,
          now: nowMs(),
        });
        return { ok: true, ...result, text: JSON.stringify(result, null, 1) };
      },
    }),
    defineTool({
      name: 'bot_ticket',
      description:
        'Act on a task (ticket) you asked for: `stop` it (its work is cancelled), `close` it as done, `retry` it (its bot takes it up again from the assignment), or `status` (asks its bot for a report when it is idle; the report arrives here by itself, never wait for it). From a task conversation you can act only on the sub-tasks it opened.',
      parameters: {
        id: { type: 'string', required: true, description: 'The task id (t…), as on its card.' },
        action: { type: 'string', required: true, enum: ['stop', 'close', 'retry', 'status'] },
      },
      output: { schema: anyValue, render: (_a, v) => text(v.text), presentationMeta: (_a, v) => ({ ticket: v.ticket }) },
      execute: async (args, exec) => {
        const caller = actor(exec);
        const sessionId = caller.sessionId;
        const sender = caller.bot ?? null;
        const id = String(args.id ?? '').trim().replace(/^(?:ticket|task)\//, '');
        const action = String(args.action ?? '').trim().toLowerCase();
        if (!['stop', 'close', 'retry', 'status'].includes(action)) throw new Error('action is one of stop, close, retry, status');
        const t = tickets.get(id);
        if (!t) throw new Error(`no task ${id}. bot_recall {"ref":"tickets"} lists them.`);
        const mine = ticketOf(sessionId);
        if (mine) {
          if (t.parentId !== mine.id) throw new Error(`from task ${mine.id} you can act only on the sub-tasks it opened${t.id === mine.id ? '; to finish this task, report "done" with bot_send_message' : ''}`);
        } else if (sender && !mayAppend(t, sender, sessionId)) {
          throw new Error(`task ${t.id} was not asked for from this conversation; only whoever asked for it (or the dispatcher) can ${action} it`);
        }
        if (t.archivedAt) throw new Error(`task ${t.id} is archived; open a new task instead`);
        const by = sender ? 'requester' : 'user';
        const bot = handleOf(t.botId);
        let next = t;
        let said = '';
        if (action === 'stop' || action === 'close') {
          next = endTicket(t, { by, outcome: action === 'stop' ? 'stopped' : 'done' });
          said = action === 'stop' ? `Stopped task ${t.id} (${bot}).` : `Closed task ${t.id} (${bot}) as done.`;
        } else if (action === 'retry') {
          next = await retryTicket(t, sender ? { sender, senderSessionId: sessionId } : {});
          said = `Task ${t.id} (${bot}) is ${stageOf(next)} again; its report will arrive here by itself.`;
        } else if (t.ended) {
          said = `Task ${t.id} (${bot}) is ${stageOf(t)}; there is no work to report on. bot_recall reads its reports.`;
        } else if (!t.startedAt) {
          said = `Task ${t.id} (${bot}) is queued: it has not started yet.`;
        } else if (parkedOf(t).length > 0) {
          said = `Task ${t.id} (${bot}) waits for a free worker slot; the messages for it are handed over then, and its report arrives here by itself.`;
        } else if (agentStatusOf(t.sessionId) === 'running') {
          said = `${bot} is working on task ${t.id} right now; its next report arrives here by itself.`;
        } else {
          const who = sender ? `@${sender.handle}` : 'The user';
          const ask = `[Status request] ${who} asks how task ${t.id} ("${t.title}") stands. Report now with bot_send_message: "progress" with what is done and what is left, "done" with the result if it is finished, "blocked" or "question" if you are stuck.`;
          // A person's question may take the extra slot; a bot's waits for a free one.
          const { parked } = await toTicket(t, { content: [{ type: 'text', text: ask }], source: sender && sessionId ? { kind: 'agent-message', form: 'relay', senderSessionId: sessionId } : { kind: 'user' }, key: `status:${t.id}:${nowMs()}`, human: !sender });
          said = parked ? `Every worker slot is taken: ${bot} gets the status request on task ${t.id} when one frees; the report arrives here by itself, do not wait for it.` : `Asked ${bot} for a status report on task ${t.id}; it arrives here by itself, do not wait for it.`;
        }
        return { ok: true, text: said, ticket: ticketRow(tickets.get(next.id) ?? next) };
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
        const actorId = exec?.agent?.session?.id;
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
            const task = await scheduleSave(bot, { id: args.action === 'update' ? args.id : undefined, title: args.title, prompt: args.prompt, timing }, actorId);
            return { ok: true, bot: face(bot), task, text: `${args.action === 'create' ? 'Scheduled' : 'Updated'} "${task.title}" for @${bot.handle}: ${task.describe}; next at ${task.scheduledAt} (id ${task.id}).` };
          }
          case 'delete':
            checkEntry(await schedule().edit({ id: String(args.id ?? ''), action: 'delete' }, actorId));
            return { ok: true, text: `Deleted task ${args.id}.` };
          case 'pause':
          case 'resume': {
            const task = entryView(checkEntry(await schedule().edit({ id: String(args.id ?? ''), action: 'update', patch: { active: args.action === 'resume' } }, actorId)));
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
      description:
        "Search long-term memory, the team's work journal (what every bot did, task by task), daily digests, and tasks (their titles and reports), for words in the query. Use it when the user refers to earlier work that is not in this conversation; a task it finds can be read with bot_recall (ticket/<id>).",
      parameters: { query: { type: 'string', required: true, description: 'Words that should all appear.' } },
      output: { schema: anyValue, render: (_a, v) => text(v.text) },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const { sessionId, bot: me } = actor(exec);
        const r = memory.search(args.query, { bot: me?.id ?? '' });
        const tz = tzMinutes();
        const when = (ms) => new Date(ms + tz * 60_000).toISOString().slice(0, 16).replace('T', ' ');
        // A task conversation finds only what it may read with bot_recall: its task, the parent, the sub-tasks;
        // journal lines of those tasks, none of other work (lines without a task, digests of everyone's day).
        const mine = ticketOf(sessionId);
        const scope = mine ? new Set([mine.id, mine.parentId, ...tickets.children(mine.id).map((c) => c.id)].filter(Boolean)) : null;
        const found = searchTickets(args.query, tickets.list().filter((t) => !scope || scope.has(t.id)));
        const journal = scope ? r.journal.filter((j) => j.ticket && scope.has(j.ticket)) : r.journal;
        const digests = scope ? [] : r.digests;
        const lines = [
          ...r.notes.map((n) => `[${n.id}] (${n.scope === 'team' ? 'team' : 'yours'}) ${n.text}`),
          ...journal.map((j) => `${when(j.at)} @${store.get(j.bot)?.handle ?? 'removed'}: ${j.summary || j.title}${j.ticket ? ` (task ${j.ticket})` : ''}`),
          ...digests.map((d) => `Digest ${d.date}: ${d.text.slice(0, 600)}`),
          ...found.map((f) => `Task ${f.ticket.id} (${handleOf(f.ticket.botId)}, ${stageOf(f.ticket)}): ${f.ticket.title}${f.where === 'report' ? ` — ${f.status} report: ${f.snippet}` : ''} [bot_recall "ticket/${f.ticket.id}"]`),
        ];
        return { ok: true, text: lines.length ? lines.join('\n') : `Nothing in memory matches "${args.query}".`, tickets: found.map((f) => f.ticket.id) };
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
      // Off for a router dispatcher unless its bot lists them in `tools.routerAllow`.
      routerDeny: [...ROUTER_DENY],
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
      await ticketUpkeep().catch((error) => ctx.logger?.warn?.(`bots: task upkeep: ${error?.message ?? error}`));
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
    const names = new Map(tickets.list().map((t) => [t.id, { title: t.title, botId: t.botId }]));
    const r = report(
      { calls: ledger.calls(), tasks: ledger.tasks(), running },
      { range: url.searchParams.get('range') || '7d', bot: url.searchParams.get('bot') || '', tz: Number.isFinite(tz) ? tz : tzMinutes(), price: (m) => priceOf(m, overrides, catalog), schedules: scheduleTitles, tickets: names },
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

  /**
   * Tickets that need a person (not archived): an unanswered question, a failure, a stall; and a
   * ticket the user asked for whose latest report (done, blocked, question) has no Session to go to,
   * until the user answers it or closes the ticket.
   */
  const ATTENTION = new Set(['question', 'failed', 'stalled']);
  const needsPerson = (t) => {
    if (ATTENTION.has(stageOf(t))) return true;
    if (t.requester?.kind === 'session') return false;
    const last = t.reports.at(-1);
    return Boolean(last && last.status !== 'progress' && t.ended?.by !== 'user' && !((t.lastHumanAt ?? 0) > last.at));
  };
  function state() {
    const tpl = templates();
    const today = todayByBot(ledger.calls(), tzMinutes());
    const live = tickets.list({ archived: false });
    const waiting = pendingAsks();
    const counts = new Map();
    for (const t of live) {
      const stage = stageOf(t);
      const c = counts.get(t.botId) ?? counts.set(t.botId, { working: 0, question: 0, stalled: 0, queued: 0 }).get(t.botId);
      if (stage in c) c[stage] += 1;
    }
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
        tickets: counts.get(b.id) ?? { working: 0, question: 0, stalled: 0, queued: 0 },
        // Questions its own conversation waits to have answered (`asks`); a task's count under `attention`.
        asking: waiting.filter((a) => a.botId === b.id && !a.ticketId).length,
        ...liveOf(b),
      };
    });
    const sessionMap = {};
    for (const b of bots) if (b.sessionId) sessionMap[b.sessionId] = b.id;
    // Ticket Sessions carry their bot's badge in Harness too; `ticketMap` says which task each one is.
    const ticketMap = {};
    for (const t of live) {
      if (!t.sessionId || !store.get(t.botId)) continue;
      sessionMap[t.sessionId] = t.botId;
      ticketMap[t.sessionId] = t.id;
    }
    const s = settings.get();
    return {
      // The Host's clock, so the page can time what runs.
      at: nowMs(),
      bots,
      primaryId: store.primary()?.id ?? null,
      sessionMap,
      ticketMap,
      messageCount: store.messageCount(),
      version: store.version(),
      limits: { skills: MAX_SKILLS, skillsOn: MAX_SKILLS_ON },
      teamNotes: memory.notes('team').length,
      dispatcher: s.dispatcher,
      // The setting asks for a router, and the dispatcher has a teammate to hand work to: it routes now.
      routerActive: routerActive(),
      routerNoticePending: s.routerNotice === 'pending',
      // A task whose conversation waits for an answer to its question needs you too (its row says `asking`).
      attention: live.filter((t) => needsPerson(t) || askingIn(t.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50).map(ticketRow),
      asks: waiting.sort((a, b) => a.at - b.at).map(askView),
      // What each running task Session does now, by task id (with its bot); a bot's home under `bots[].activity`.
      taskActivity: taskActivity(),
      // How the panel shows what bots say to each other ('line' | 'short' | 'full').
      display: s.display,
    };
  }
  /** A bot's live fields in state: what its home does now (`activity`), and a picture being drawn for it (`avatarPending`). */
  function liveOf(b) {
    const now = activity.get(b.sessionId);
    return { ...(now ? { activity: now } : {}), ...(drawings.has(b.id) ? { avatarPending: true } : {}) };
  }
  /** Task id → what its running Session does now, with the task's bot and title. */
  function taskActivity() {
    const out = {};
    for (const sid of activity.sessions()) {
      const t = ticketOf(sid);
      const now = t && !t.ended ? activity.get(sid) : undefined;
      if (now) out[t.id] = { ...now, botId: t.botId, title: t.title };
    }
    return out;
  }
  /**
   * GET /activity: only what moves while bots work, for the panel to poll often while something
   * runs: each bot's status and live fields, and the running tasks' activity.
   */
  function activityView() {
    const bots = {};
    for (const b of store.list()) bots[b.id] = { status: botStatus(b), ...liveOf(b) };
    return { ok: true, at: nowMs(), bots, taskActivity: taskActivity() };
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
        return { ok: true, sessionId: (await userSend(bot, text)).sessionId };
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
    messages: { get: (url) => messagesView(url) },
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
        const sent = await userSend(bot, body.text, { replyTo: String(body.replyTo ?? '') });
        return { ok: true, sessionId: sent.sessionId, ...(sent.message ? { message: sent.message } : {}) };
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
        dropDrawing(bot.id, 'panel');
        return { ok: true, bot: publicBot(savePicture(bot, bytes, m[1])) };
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
        dropDrawing(bot.id, 'panel');
        return { ok: true, bot: publicBot(clearPicture(bot)) };
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
    // The live part of `state`, cheap enough to poll every second or two while bots work.
    activity: { get: () => activityView() },
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
        // Picking a dispatcher mode is having seen the notice about it.
        if (patch.dispatcher !== undefined) patch.routerNotice = 'dismissed';
        const saved = settings.save(patch);
        settingsChanged();
        return { ok: true, settings: saved };
      },
    },
    // The one-time notice that an upgraded team's dispatcher now routes: dismissed for good.
    'router-notice/dismiss': { post: () => (settings.save({ routerNotice: 'dismissed' }), { ok: true, routerNoticePending: false }) },
    // Tasks (tickets), PLAN-0.8 §6.3. `tickets/:id…` and `threads/:key` are under `paramRoutes`.
    tickets: { get: (url) => ticketList(url) },
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

  /**
   * GET /messages?bot=&topic=&limit=: a bot's chat (or one topic of it, or everything), oldest first,
   * and per topic seen there its key and the tasks it has (PLAN-0.9 §7.3).
   */
  function messagesView(url) {
    const bot = url.searchParams.get('bot') ?? '';
    const topic = url.searchParams.get('topic') ?? '';
    const limit = Number(url.searchParams.get('limit')) || (topic ? 500 : 200);
    const items = store.messages({ bot, limit, topic }).map(messageView);
    const roots = new Set(items.flatMap((m) => [m.topic, m.movedTo]).filter(Boolean));
    const topics = {};
    for (const root of roots) {
      const first = items.find((m) => m.id === root) ?? store.message(root);
      const key = first?.thread && panelTopicOf(first.thread) === root ? first.thread : items.find((m) => m.topic === root && m.thread)?.thread;
      if (!key) continue;
      topics[root] = { key, tickets: tickets.subscribers(key).filter((t) => !t.archivedAt).map(ticketRow) };
    }
    return { items, topics };
  }

  /** GET /tickets?bot=&stage=&limit=&offset=: rows, the latest change first; `stage` may list several (a,b). */
  function ticketList(url) {
    const bot = url.searchParams.get('bot') || undefined;
    const stage = (url.searchParams.get('stage') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const archived = url.searchParams.get('archived');
    const limit = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 50)));
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
    const all = tickets
      .list({ botId: bot, ...(stage.length ? { stage } : {}), ...(archived === '0' || archived === 'false' ? { archived: false } : archived === '1' || archived === 'true' ? { archived: true } : {}) })
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
    const items = all.slice(offset, offset + limit).map(ticketRow);
    return { items, next_offset: offset + limit < all.length ? offset + limit : null };
  }
  /** GET /threads/:key: a Thread, the tickets subscribed to it and what was said there lately. */
  function threadRoute(key) {
    const th = tickets.thread(key);
    const parsed = parseThreadKey(key);
    if (!th && !parsed) return { ok: false, reason: 'no such thread' };
    // The panel as a whole holds its topics (`panel:<sessionId>:<root>`).
    const whole = isPanelThread(key) && !panelTopicOf(key);
    const recent = store
      .messages({ limit: 2000 })
      .filter((m) => m.thread === key || (whole && String(m.thread ?? '').startsWith(`${key}:`)))
      .slice(-10)
      .map((m) => ({ at: m.at, from: m.from, to: m.to, ...(m.who ? { who: m.who } : {}), text: clip(String(m.text ?? ''), 300).text }));
    return { key, label: th?.label ?? threadLabel(key), kind: th?.kind ?? parsed?.kind ?? '', tickets: tickets.subscribers(key).map(ticketRow), recent };
  }
  const ticketOr404 = (id) => {
    const t = tickets.get(String(id ?? ''));
    if (!t) throw new Error('no such task');
    return t;
  };
  /** Routes with a path parameter: `tickets/<id>[/<action>]`, `threads/<key>` (the key URI-encoded). */
  const paramRoutes = {
    tickets: {
      get: (rest) => {
        if (rest.length !== 1) throw new Error('no such route');
        return ticketView(ticketOr404(rest[0]));
      },
      post: async (rest, body) => {
        const [id, action] = rest;
        const t = ticketOr404(id);
        switch (action) {
          case 'stop':
            return { ok: true, ...ticketView(endTicket(t, { by: 'user', outcome: 'stopped' })) };
          case 'close':
            return { ok: true, ...ticketView(endTicket(t, { by: 'user', outcome: 'done' })) };
          case 'retry':
            return { ok: true, ...ticketView(await retryTicket(t)) };
          case 'message':
            return { ok: true, ...ticketView(await appendToTicket(t, body.text, { human: true, force: true })) };
          default:
            throw new Error('no such route');
        }
      },
    },
    threads: {
      get: (rest) => threadRoute(rest.join('/')),
    },
    // `asks/<id>/answer`: the panel answers a bot's question (state `asks`).
    asks: {
      post: (rest, body) => {
        if (rest.length !== 2 || rest[1] !== 'answer') throw new Error('no such route');
        return answerAsk(rest[0], body);
      },
    },
  };
  /** One request as the web server would route it (also for tests): exact routes, then the parameter ones. */
  async function request(method, path, body = {}) {
    const url = new URL(path, 'http://localhost');
    const rel = url.pathname.startsWith(`${R}/`) ? url.pathname.slice(R.length + 1) : url.pathname.replace(/^\//, '');
    const exact = routes[rel];
    if (exact) return method === 'GET' ? exact.get(url) : exact.post(body);
    const [head, ...parts] = rel.split('/');
    const route = paramRoutes[head];
    if (!route) throw new Error('no such route');
    const rest = head === 'threads' ? [decodeURIComponent(parts.join('/'))] : parts.map((p) => decodeURIComponent(p));
    if (method === 'GET' && route.get) return route.get(rest, url);
    if (method === 'POST' && route.post) return route.post(rest, body);
    throw new Error('no such route');
  }
  /** The ticket settings or the dispatcher mode changed: slots, router homes and the queue follow. */
  function settingsChanged() {
    slots.setMax(settings.get().tickets.maxWorking);
    reapply();
    void pump();
  }

  const mountRoutes = (scope) => {
    const web = scope.webServer;
    if (!web?.register) return;
    for (const head of Object.keys(paramRoutes)) {
      scope.effect(() =>
        web.register({
          kind: 'prefix',
          path: `${R}/${head}`,
          handler: (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (req.method === 'GET') return serveJson(res, () => request('GET', `${url.pathname}${url.search}`));
            if (req.method === 'POST') return postJson(req, res, (body) => request('POST', url.pathname, body));
            res.statusCode = 405;
            res.end();
          },
        }),
      );
    }
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

  /** For tests: which per-Session records this process still keeps for `sessionId`. */
  const tracked = (sessionId) => ({ trigger: trigger.has(sessionId), answered: answered.has(sessionId), turn: turnState.has(sessionId), delivered: deliveredIds.has(sessionId), history: historyRead.has(sessionId) });
  return { store, state, deliver, install, reconcile, installed, routes, channels, memory, ledger, topics, settings, newTopic, dream, sweep, userSend: async (...a) => (await userSend(...a)).sessionId, panelSend: userSend, openTasks, codexSync, finishTask, tickets, slots, pump, botOfSession, request, ticketView, ticketUpkeep, watch, startup, recoverTickets, tracked };
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
