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
 * @module @kadaliao/dsh-bots
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createStore, initialsOf, slugify, SKILL_RE, PALETTE } from './lib/store.mjs';
import { catalog as appCatalog, CATEGORIES, mcpConfigFor } from './lib/apps.mjs';
import { ABILITIES } from './lib/abilities.mjs';
import { SKILL_SOURCES, importGithubSkill, importUrlSkill, listGithubSkills, parseGithub } from './lib/skills.mjs';
import { TEAMS, teamTiming, teamView } from './lib/teams.mjs';
import { maskedApp, scanExternalMcp } from './lib/mcp-import.mjs';
import { createUnfurler } from './lib/unfurl.mjs';
import { describeTiming, dmBody, dmHeader, personaText, textOf, timingFrom, timingOfEntry } from './lib/prompt.mjs';

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

export const TOOL_NAMES = ['bot_list', 'bot_create', 'bot_update', 'bot_delete', 'bot_send_message', 'bot_schedule'];

function homeDir() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
}

export function ocuPath() {
  return OCU_PATHS.find((p) => existsSync(p)) ?? '';
}

/** The app catalog the Apps tab offers, with the open-computer-use path in force. */
export function templates() {
  return appCatalog(ocuPath());
}

/** The mcp-client row of one app of `bot`. Throws APP_INCOMPLETE when a required field is empty. */
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

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const dir = join(homeDir(), 'cache', 'bots');
  const store = createStore(dir);
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

  const signatureOf = (bot) => JSON.stringify({ s: bot.skills, a: bot.apps, t: bot.tools, h: bot.handle });

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
        for (const s of local) {
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
    const apps = bot.apps.filter((a) => a.enabled);
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
              return now ? personaText(now, store.list(), { skillsInline, skillNames, apps: appNames }) : '';
            },
          }),
        );
      } catch (error) {
        ctx.logger?.warn?.(`bots: persona for @${bot.handle}: ${error?.message ?? error}`);
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
      if (bot.model) {
        try {
          agent.model?.select?.({ provider: bot.model.provider, model: bot.model.model });
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
    const agent = await agentOf(target);
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

  /** The user writes to a bot from the panel: an ordinary user prompt in its conversation. */
  async function userSend(target, text) {
    const body = String(text ?? '').trim();
    if (body === '') throw new Error('text must not be empty');
    const agent = await agentOf(target);
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }));
    await flush(agent);
    return agent.session.id;
  }

  // The timeline: what the user typed to a bot, what the bot answered, scheduled runs.
  const trigger = new Map();
  /** Sessions whose current turn already sent a bot_send_message. */
  const answered = new Set();
  ctx.on('session/event', (session, event) => {
    try {
      const bot = store.bySession(session?.id);
      if (!bot || !event) return;
      if (event.type === 'user/message') {
        let kind = event.data?.source?.kind;
        // The Harness tells a session about task edits made elsewhere; that is not a delivery.
        if (kind === 'schedule' && /^\[SCHEDULE CHANGE\]/.test(textOf(event.data.content))) kind = 'schedule-notice';
        trigger.set(session.id, kind);
        answered.delete(session.id);
        if (kind === 'user') store.log({ from: 'user', to: bot.id, text: textOf(event.data.content), kind: 'user' });
        else if (kind === 'schedule') store.log({ from: 'schedule', to: bot.id, text: textOf(event.data.content), kind: 'system' });
      } else if (event.type === 'assistant/message') {
        const content = event.data?.message?.content ?? [];
        const calls = content.filter((b) => b?.type === 'tool-call');
        if (calls.some((b) => (b.name ?? b.toolName) === 'bot_send_message')) answered.add(session.id);
        if (calls.length > 0) return;
        const text = textOf(content);
        const why = trigger.get(session.id);
        // Shown in the bot's chat: what it says to the user. Hidden: acknowledging a schedule notice,
        // and the closing words of a turn that answered a bot by DM (they reach no one). The
        // dispatcher reporting back after its teammates answered is a message to the user.
        const hidden = why === 'schedule-notice' || (why === 'agent-message' && (bot.role !== 'primary' || answered.has(session.id)));
        if (text && !hidden) store.log({ from: bot.id, to: 'user', text, kind: 'reply' });
      }
    } catch {
      // The timeline must never disturb a conversation.
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
        agent.model?.select?.({ provider: bot.model.provider, model: bot.model.model });
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
        return { ok: true, text: `Created ${card(bot)}. Message it with bot_send_message to @${bot.handle}.`, bot: face(bot) };
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
        add_skills: { ...skillInput, description: 'Skills to add (a skill with the same name is replaced).' },
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
        }
        if (args.make_dispatcher === true) next.role = 'primary';
        const saved = store.save(next);
        return { ok: true, text: `Updated ${card(saved)}.`, bot: face(saved) };
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
      for (const p of llm?.listProviders?.() ?? []) {
        try {
          for (const m of await llm.listModels(p.id)) models.push({ provider: p.id, model: m.id, label: `${p.name ?? p.id} · ${m.name ?? m.id}` });
        } catch {
          // One provider down leaves the rest.
        }
      }
    } catch {
      // No model service.
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
      skills: skills.map((s) => ({ name: s.name, description: String(s.description ?? '').slice(0, 300) })),
      ocu: { installed: ocu !== '', path: ocu || OCU_PATHS[0] },
      mcp: Boolean(mcpClient),
      zone,
    };
  }

  function state() {
    const bots = store.list().map((b) => {
      const appIssues = {};
      for (const app of b.apps) {
        try {
          mcpConfigOf(app, b);
        } catch (error) {
          appIssues[app.id] = error?.message ?? String(error);
        }
      }
      const skills = b.skills.map((s) => (s.source === 'dsh' && !s.description && dshSkillInfo.get(s.name) ? { ...s, description: dshSkillInfo.get(s.name) } : s));
      return { ...b, skills, status: botStatus(b), appIssues };
    });
    const sessionMap = {};
    for (const b of bots) if (b.sessionId) sessionMap[b.sessionId] = b.id;
    return { bots, primaryId: store.primary()?.id ?? null, sessionMap, messageCount: store.messageCount(), version: store.version() };
  }

  let ocuInstalling = false;
  // --- skills from elsewhere -------------------------------------------------------
  const skillDir = join(dir, 'skills');
  /** Import one skill (GitHub folder or URL) as a bot skill object, files kept under the cache. */
  async function importSkill(spec) {
    const signal = AbortSignal.timeout(120_000);
    const id = `skill-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const gh = spec.repo ? { ...parseGithub(spec.repo), ...(spec.path !== undefined ? { path: spec.path } : {}), ...(spec.ref ? { ref: spec.ref } : {}) } : parseGithub(spec.url ?? '');
    if (gh) {
      const got = await importGithubSkill(gh, skillDir, id, { signal });
      return { id, source: 'import', enabled: true, ...got };
    }
    if (/^https?:\/\//.test(String(spec.url ?? ''))) return { id, source: 'import', enabled: true, ...(await importUrlSkill(spec.url, { signal })) };
    throw new Error('give a GitHub repository or folder (owner/repo/path) or a SKILL.md URL');
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
      post: async (body) => ({ ok: true, ...(await hireTeam(String(body.id ?? ''), body.lang === 'zh' ? 'zh' : 'en', { primary: body.primary !== false })) }),
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
        const saved = store.save({ id: bot.id, skills: [...store.get(bot.id).skills, ...added] });
        return { ok: added.length > 0 || failed.length === 0, bot: saved, added: added.map((x) => x.name), failed, ...(failed.length && !added.length ? { reason: failed[0].reason } : {}) };
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
        return { ok: true, bot: saved, added: apps.map((a) => a.name) };
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
        const bot = store.save(input, { createdBy: 'user' });
        applyModel(bot);
        return { ok: true, bot: { ...bot, status: botStatus(bot) } };
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
        return { ok: true, bot: saved };
      },
    },
    'avatar/generate': {
      post: async (body) => {
        const bot = store.get(String(body.id ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        return { ok: true, bot: await generateAvatar(bot, body.style) };
      },
    },
    'avatar/clear': {
      post: (body) => {
        const bot = store.get(String(body.id ?? ''));
        if (!bot) return { ok: false, reason: 'no such bot' };
        for (const f of [bot.id, `${bot.id}.type`]) rmSync(join(dir, 'avatars', f), { force: true });
        return { ok: true, bot: store.patch(bot.id, { avatar: { kind: 'initials', color: bot.avatar.color } }) };
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
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountRoutes);
  else if (ctx.webServer) mountRoutes({ webServer: ctx.webServer, effect: (fn) => ctx.effect(fn) });

  return { store, state, deliver, install, reconcile, installed, routes };
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
