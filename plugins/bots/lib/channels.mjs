/**
 * Chat channels: people message the bot team from a chat app (Telegram,
 * Discord, …) and get the bots' replies back in that chat.
 *
 * A channel is an app on a bot (`kind: 'channel'` in the catalog) holding a
 * chat bot token. For each one the Host runs a connector,
 * `lib/channels/<kind>.mjs`, which is transport only. This module decides the
 * rest:
 *
 * - who may talk to the team: only people paired with a one-time code from
 *   the panel; everyone else is ignored (at most one "this bot is private"
 *   note per chat per day);
 * - which bot a message is for: the bot owning the channel, or the one named
 *   by a leading `@handle`;
 * - where a bot's replies go: back to the chat its latest human input came
 *   from, including the dispatcher's report after teammates answer by DM; a
 *   message typed in the panel takes the conversation back to the panel.
 *
 * A connector gets the app's field values (`values`; `token` is its first
 * secret) and reports messages as {chatId, userId, userName, text, isDirect,
 * mentioned, messageId, order?, chatTitle?, source?}. Optional module exports:
 * `TEXT_LIMIT`, `MARKDOWN` (true when the chat app renders Markdown replies)
 * and `links({account, code, values})` → {link?, invite?} for the panel.
 *
 * @module @kadaliao/dsh-bots/lib/channels
 */

import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Connector modules by channel kind, loaded on first use. */
const CONNECTORS = {
  telegram: () => import('./channels/telegram.mjs'),
  discord: () => import('./channels/discord.mjs'),
  feishu: () => import('./channels/feishu.mjs'),
  slack: () => import('./channels/slack.mjs'),
};
export const CHANNEL_KINDS = Object.keys(CONNECTORS);
export const CHANNEL_LABELS = { telegram: 'Telegram', discord: 'Discord', feishu: 'Feishu', slack: 'Slack' };
/** Chat apps that render Markdown themselves; the rest get replies as plain text. */
const RENDERS_MARKDOWN = new Set(['discord']);

/** What the page sees in place of a stored token. Saving it back keeps the stored value. */
export const SECRET_MASK = '••••••••';
/** How long a pairing code works. */
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_LENGTH = 6;
/** No 0/O, 1/I/L: a code read off a screen and typed on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Wrong codes one person may try against one code. */
const MAX_TRIES_PER_PERSON = 5;
/** Wrong codes in all before the code stops working. */
const MAX_FAILS_PER_CODE = 20;
/** One "this bot is private" note per chat per this long. */
const NOTICE_EVERY_MS = 24 * 3600_000;
const TYPING_EVERY_MS = 5000;
const TYPING_MAX_MS = 10 * 60_000;
/** A delivered channel message not seen in its conversation by then is forgotten. */
const PENDING_TTL_MS = 30 * 60_000;

/** Load the connector module of `kind`. */
export async function loadConnector(kind) {
  const load = CONNECTORS[kind];
  if (!load) throw new Error(`no connector for "${kind}"`);
  return load();
}

// --- apps --------------------------------------------------------------------------

/** The catalog entry of a channel app, or null for any other app. */
export function channelEntry(app, entries) {
  const e = (entries ?? []).find((x) => x.id === app?.template);
  return e && e.kind === 'channel' ? e : null;
}

/** The token of a channel app: its first secret field. */
export function tokenOf(app, entry) {
  const f = (entry?.fields ?? []).find((x) => x.kind === 'secret');
  const v = f ? app?.values?.[f.key] : '';
  return typeof v === 'string' ? v.trim() : '';
}

/** All non-empty field values of a channel app, and its secrets (for redaction). */
export function credentialsOf(app, entry) {
  const values = {};
  const secrets = [];
  for (const f of entry?.fields ?? []) {
    const v = app?.values?.[f.key];
    if (typeof v !== 'string' || v.trim() === '') continue;
    values[f.key] = v.trim();
    if (f.kind === 'secret') secrets.push(v.trim());
  }
  return { values, secrets };
}

/** Why a channel app cannot connect (a required field is empty), or ''. */
export function channelIssue(app, entry) {
  const missing = (entry?.fields ?? []).filter((f) => f.required && String(app?.values?.[f.key] ?? '').trim() === '').map((f) => f.label.en);
  return missing.length ? `${entry.name.en} needs: ${missing.join(', ')}` : '';
}

/** A bot as the page may see it: channel tokens masked. */
export function maskBot(bot, entries) {
  if (!bot || !Array.isArray(bot.apps)) return bot;
  let changed = false;
  const apps = bot.apps.map((app) => {
    const entry = channelEntry(app, entries);
    if (!entry) return app;
    const values = { ...(app.values ?? {}) };
    for (const f of entry.fields ?? []) {
      if (f.kind === 'secret' && String(values[f.key] ?? '') !== '') {
        values[f.key] = SECRET_MASK;
        changed = true;
      }
    }
    return { ...app, values };
  });
  return changed ? { ...bot, apps } : bot;
}

/** Apps posted by the page: a masked token keeps the stored one of the same app. */
export function unmaskApps(apps, prevApps, entries) {
  if (!Array.isArray(apps)) return apps;
  return apps.map((app) => {
    const entry = channelEntry(app, entries);
    if (!entry || !app?.values) return app;
    const prev = (prevApps ?? []).find((p) => p.id === app.id);
    const values = { ...app.values };
    for (const f of entry.fields ?? []) {
      if (f.kind !== 'secret' || values[f.key] !== SECRET_MASK) continue;
      if (prev?.values?.[f.key]) values[f.key] = prev.values[f.key];
      else delete values[f.key];
    }
    return { ...app, values };
  });
}

// --- text ----------------------------------------------------------------------------

/** Remove secrets from text bound for a log, an error or the page. */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 6) s = s.split(secret).join('<token>');
  return s
    .replace(/bot\d{4,}:[A-Za-z0-9_-]{20,}/g, 'bot<token>')
    .replace(/\b\d{4,}:[A-Za-z0-9_-]{30,}\b/g, '<token>')
    .replace(/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, '<token>')
    .replace(/\b(?:xox[a-z]|xapp|xoxe)(?:\.xox[a-z])?-[A-Za-z0-9-]{6,}/g, '<token>');
}

/**
 * Split text into parts of at most `limit` UTF-16 units, at a blank line, a
 * line break or a space when one is near, never inside a surrogate pair.
 */
export function splitText(text, limit) {
  const max = Math.max(16, Math.floor(Number(limit)) || 4096);
  let rest = String(text ?? '').trim();
  const parts = [];
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    const c = rest.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^(\n+| )/, '');
  }
  if (rest) parts.push(rest);
  return parts.filter((p) => p !== '');
}

/** Markdown a model writes, as plain chat text: no emphasis markers, fences or heading hashes. */
export function toPlainText(md) {
  const out = [];
  let code = false;
  for (const line of String(md ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      code = !code;
      continue;
    }
    if (code) {
      out.push(line);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('');
      continue;
    }
    out.push(
      line
        .replace(/^(\s*)#{1,6}\s+/, '$1')
        .replace(/^(\s*)[-*+]\s+/, '$1• ')
        .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '$1')
        .replace(/__(?=\S)([^_\n]*?\S)__/g, '$1')
        .replace(/!?\[([^\]\n]+)\]\((\S+?)\)/g, (_, label, url) => (label === url ? url : `${label} (${url})`)),
    );
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A fresh pairing code. */
export function newPairingCode(pick = randomInt) {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[pick(CODE_ALPHABET.length)];
  return code;
}

/** The code a message offers: `/start CODE` (a Telegram deep link) or the code alone. */
export function pairingCandidate(text) {
  const t = String(text ?? '').trim();
  const m = /^\/start(?:@\S+)?\s+([A-Za-z0-9]{4,12})$/i.exec(t) ?? /^([A-Za-z0-9]{6})$/.exec(t);
  return m ? m[1].toUpperCase() : '';
}

/** `/start`, `/start@bot` or `/help` with nothing else. */
export function isGreeting(text) {
  return /^\/(start|help)(@\S+)?$/i.test(String(text ?? '').trim());
}

/** The bot a message is for: the one named by a leading `@handle`, else `owner`. */
export function routeMessage(text, owner, roster) {
  const t = String(text ?? '').trim();
  const m = /^@([a-z0-9][a-z0-9-]{0,31})(?=$|[\s,，:：.。!?！？;；])[\s,，:：;；]*/i.exec(t);
  if (m) {
    const bot = (roster ?? []).find((b) => b.handle === m[1].toLowerCase());
    if (bot) return { bot, text: t.slice(m[0].length).trim() };
  }
  return { bot: owner, text: t };
}

const cleanName = (s, max = 60) =>
  String(s ?? '')
    .replace(/[[\]\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** The line a bot reads before a chat message: `[Telegram · Kada]`, with the group in a group. */
export function sourceHeader(kind, msg) {
  const parts = [cleanName(msg?.source) || CHANNEL_LABELS[kind] || kind, cleanName(msg?.userName) || 'someone'];
  if (!msg?.isDirect && cleanName(msg?.chatTitle)) parts.push(cleanName(msg.chatTitle));
  return `[${parts.join(' · ')}]`;
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const zhBot = (bot) => /[一-鿿]/.test(`${bot?.name ?? ''}${bot?.persona ?? ''}`);

/** What a newly paired person (or `/start`) reads. */
export function welcomeText(bot, roster, { paired = false } = {}) {
  const others = (roster ?? []).filter((b) => b.id !== bot.id).slice(0, 6).map((b) => `@${b.handle}`);
  if (zhBot(bot)) {
    return [
      `${paired ? '配对成功。' : ''}你在这里发的消息会交给 ${bot.name}（@${bot.handle}）。`,
      others.length ? `想直接找其他 Bot，就在开头写它的 @handle：${others.join('、')}。` : '',
    ].filter(Boolean).join('');
  }
  return [
    `${paired ? 'Paired. ' : ''}What you send here goes to ${bot.name} (@${bot.handle}).`,
    others.length ? `To reach another bot directly, start with its @handle: ${others.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}
export const PRIVATE_TEXT = 'This bot is private. / 这是私人 Bot，不对外开放。';

/**
 * A "start a new topic" command at the start of a message: `/new`, `/clear`,
 * `/reset` (with an optional `@botname` suffix) or `/新话题`. Returns the rest of
 * the message, or null when it is no such command.
 */
export function topicCommand(text) {
  const m = /^\/(new|clear|reset|新话题|新对话)(@\S+)?(?=$|\s)\s*/i.exec(String(text ?? '').trim());
  return m ? { rest: String(text).trim().slice(m[0].length).trim() } : null;
}

/** What a chat app hears when a new topic started. */
export function newTopicText(bot) {
  return zhBot(bot)
    ? `已开始新话题：${bot.name} 的对话从头开始，它记得的事都还在。`
    : `New topic: ${bot.name} starts a fresh conversation and keeps what it remembers.`;
}

// --- hint for the panel ----------------------------------------------------------------

/** A short code the panel words in its own language, from a connector's error text. */
export function hintOf(detail) {
  const d = String(detail ?? '');
  if (/4014|disallowed intent|message content intent/i.test(d)) return 'intent';
  if (/\b401\b|unauthori[sz]ed|4004|invalid token|token was rejected|rejected the (bot )?token/i.test(d)) return 'token';
  if (/\b409\b|conflict|another program/i.test(d)) return 'conflict';
  return '';
}

// --- the channel hub ---------------------------------------------------------------------

/**
 * Every channel of every bot: connectors, pairing, routing and reply targets.
 *
 * @param {{
 *   file: string,                                   // channels.json: paired people and options per channel
 *   bots: () => object[],                           // the roster
 *   entries: () => object[],                        // the app catalog
 *   deliver: (bot: object, msg: {header: string, body: string}) => Promise<string>,  // hand a prompt to a bot; resolves to its session id
 *   running?: (sessionId: string) => boolean,       // whether that conversation is working
 *   loadConnector?: (kind: string) => Promise<{createConnector: Function, TEXT_LIMIT?: number}>,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   random?: (n: number) => number,
 *   typingEveryMs?: number,
 *   retryMs?: number,
 * }} deps
 */
export function createChannels(deps) {
  const now = deps.now ?? Date.now;
  const log = (line) => {
    try {
      deps.log?.(line);
    } catch {
      // Logging is a convenience.
    }
  };
  const load = deps.loadConnector ?? loadConnector;
  const typingEvery = deps.typingEveryMs ?? TYPING_EVERY_MS;
  const retryBase = deps.retryMs ?? 15_000;
  const running = deps.running ?? (() => false);

  // Persistent: {channels: {[key]: {paired: Person[], scheduleReplies: boolean, account?: {id, username}}}}
  let data = { version: 1, channels: {} };
  try {
    const parsed = JSON.parse(readFileSync(deps.file, 'utf8'));
    if (parsed && typeof parsed.channels === 'object' && parsed.channels) data = { version: 1, channels: parsed.channels };
  } catch {
    // First run.
  }
  const save = () => {
    try {
      mkdirSync(dirname(deps.file), { recursive: true });
      const tmp = `${deps.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, deps.file);
    } catch (error) {
      log(`channels: could not save pairings: ${error?.message ?? error}`);
    }
  };
  const recordOf = (key) => {
    const r = (data.channels[key] ??= {});
    if (!Array.isArray(r.paired)) r.paired = [];
    if (typeof r.scheduleReplies !== 'boolean') r.scheduleReplies = true;
    return r;
  };

  /** key → running connector record */
  const live = new Map();
  /** key → {code, expiresAt, fails} */
  const codes = new Map();
  /** `${key}|${userId}` → {n, since} */
  const tries = new Map();
  /** `${key}|${chatId}` → time of the last "private" note */
  const notices = new Map();
  /** key → {count, lastName, lastAt} */
  const ignored = new Map();
  /** botId → [{text, origin, at}] channel messages handed to a bot, not yet seen in its conversation */
  const pending = new Map();
  /** sessionId → where its replies go */
  const targets = new Map();
  /** sessionId → {timer, key, chatId, claimed} */
  const typing = new Map();
  /** `${key}|${chatId}` → the tail of its send queue, so parts arrive in order */
  const queues = new Map();
  let disposed = false;

  const keyOf = (botId, appId) => `${botId}/${appId}`;
  const sig = (kind, token) => `${kind}:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;

  /** The channels that should run now, from the roster. */
  function wanted() {
    const entries = deps.entries();
    const out = [];
    const byToken = new Map();
    for (const bot of deps.bots()) {
      for (const app of bot.apps ?? []) {
        const entry = channelEntry(app, entries);
        if (!entry || app.enabled === false) continue;
        const token = tokenOf(app, entry);
        if (!token || channelIssue(app, entry)) continue;
        const kind = entry.channel ?? entry.id;
        const { values, secrets } = credentialsOf(app, entry);
        const s = sig(kind, token);
        const first = byToken.get(s);
        if (!first) byToken.set(s, bot);
        const all = sig(kind, JSON.stringify(Object.entries(values).sort()));
        out.push({ key: keyOf(bot.id, app.id), botId: bot.id, appId: app.id, kind, token, values, secrets, sig: first ? `${all}:dup` : all, duplicateOf: first ?? null });
      }
    }
    return out;
  }

  /** Start, stop and restart connectors to match the roster. Cheap; call it on every change. */
  function sync() {
    if (disposed) return;
    const want = wanted();
    for (const [key, rec] of [...live]) {
      const w = want.find((x) => x.key === key);
      if (!w || w.sig !== rec.sig) {
        live.delete(key);
        void stopRecord(rec);
      }
    }
    for (const w of want) if (!live.has(w.key)) startRecord(w);
    // Pairings of a channel app that no longer exists go with it.
    const entries = deps.entries();
    const exists = new Set();
    for (const bot of deps.bots()) for (const app of bot.apps ?? []) if (channelEntry(app, entries)) exists.add(keyOf(bot.id, app.id));
    let pruned = false;
    for (const key of Object.keys(data.channels)) {
      if (!exists.has(key)) {
        delete data.channels[key];
        codes.delete(key);
        ignored.delete(key);
        pruned = true;
      }
    }
    if (pruned) save();
  }

  function setStatus(rec, s) {
    const detail = s?.detail ? redact(String(s.detail), rec.secrets).slice(0, 400) : '';
    const hint = s?.hint ?? (s?.state === 'error' ? hintOf(detail) : '');
    rec.status = { state: s?.state ?? 'error', ...(detail ? { detail } : {}), ...(hint ? { hint } : {}), ...(s?.fatal ? { fatal: true } : {}), at: now() };
  }

  function startRecord(w) {
    const rec = { ...w, conn: null, gen: null, limit: 2000, status: { state: 'connecting', at: now() }, account: null, retries: 0, retryTimer: null };
    live.set(w.key, rec);
    if (w.duplicateOf) {
      setStatus(rec, { state: 'error', detail: `This token is already connected on @${w.duplicateOf.handle}; one token can run in one place.`, hint: 'duplicate' });
      return;
    }
    void connect(rec);
  }

  async function connect(rec) {
    const gen = {};
    rec.gen = gen;
    const current = () => !disposed && live.get(rec.key) === rec && rec.gen === gen;
    setStatus(rec, { state: 'connecting' });
    let mod;
    try {
      mod = await load(rec.kind);
    } catch (error) {
      if (current()) setStatus(rec, { state: 'error', detail: `${CHANNEL_LABELS[rec.kind] ?? rec.kind} support could not load: ${error?.message ?? error}`, fatal: true });
      return;
    }
    if (!current()) return;
    rec.limit = Number(mod.TEXT_LIMIT) || 2000;
    rec.mod = mod;
    let conn;
    try {
      conn = mod.createConnector({
        token: rec.token,
        values: { ...rec.values },
        onMessage: (msg) => {
          if (current()) void inbound(rec, msg).catch((error) => log(`channels: ${rec.kind} message: ${redact(error?.message ?? error, rec.secrets)}`));
        },
        onStatus: (s) => {
          if (current() && s && s.state !== 'stopped') setStatus(rec, s);
        },
        log: (line) => log(`channels: ${rec.kind}: ${redact(line, rec.secrets)}`),
      });
    } catch (error) {
      if (current()) setStatus(rec, { state: 'error', detail: error?.message ?? String(error), fatal: true });
      return;
    }
    rec.conn = conn;
    try {
      const account = await conn.start();
      if (!current()) {
        await Promise.resolve(conn.stop()).catch(() => {});
        return;
      }
      rec.account = { id: String(account?.id ?? ''), username: String(account?.username ?? ''), name: String(account?.name ?? '') };
      rec.retries = 0;
      setStatus(rec, { state: 'connected' });
      const record = recordOf(rec.key);
      if (record.account?.id && record.account.id !== rec.account.id) {
        // Another chat bot behind this app: chats with the old one are not chats with this one.
        for (const p of record.paired) delete p.chatId;
        delete record.seen;
      }
      record.account = { id: rec.account.id, username: rec.account.username };
      save();
      if (record.paired.length === 0 && !activeCode(rec.key)) issueCode(rec.key);
    } catch (error) {
      if (!current()) return;
      const message = redact(error?.message ?? String(error), rec.secrets);
      const fatal = error?.fatal === true || rec.status.fatal === true || hintOf(message) === 'token';
      // The connector's own error status, when it gave one, words the problem best.
      const detail = rec.status.state === 'error' && rec.status.detail ? rec.status.detail : message;
      setStatus(rec, { state: 'error', detail, ...(rec.status.hint ? { hint: rec.status.hint } : {}), fatal });
      rec.conn = null;
      await Promise.resolve(conn.stop()).catch(() => {});
      if (!fatal && current()) {
        const wait = Math.min(300_000, retryBase * 2 ** Math.min(rec.retries, 5));
        rec.retries += 1;
        rec.retryTimer = setTimeout(() => {
          if (current()) void connect(rec);
        }, wait);
        rec.retryTimer.unref?.();
      }
    }
  }

  async function stopRecord(rec) {
    rec.gen = null;
    if (rec.retryTimer) clearTimeout(rec.retryTimer);
    for (const [sessionId, loop] of [...typing]) if (loop.key === rec.key) stopTyping(sessionId);
    const conn = rec.conn;
    rec.conn = null;
    if (conn) {
      try {
        await conn.stop();
      } catch (error) {
        log(`channels: stopping ${rec.kind}: ${redact(error?.message ?? error, rec.secrets)}`);
      }
    }
  }

  // --- pairing -----------------------------------------------------------------------

  function activeCode(key) {
    const c = codes.get(key);
    if (c && c.expiresAt > now()) return c;
    if (c) codes.delete(key);
    return null;
  }
  function issueCode(key) {
    const c = { code: newPairingCode(deps.random), expiresAt: now() + CODE_TTL_MS, fails: 0 };
    codes.set(key, c);
    for (const k of [...tries.keys()]) if (k.startsWith(`${key}|`)) tries.delete(k);
    return c;
  }
  /** Whether this person may still try a code; counts a wrong one. */
  function wrongCode(key, userId, code) {
    const k = `${key}|${userId}`;
    const t = tries.get(k);
    const n = t && now() - t.since < CODE_TTL_MS ? t.n + 1 : 1;
    tries.set(k, { n, since: t && n > 1 ? t.since : now() });
    code.fails += 1;
    if (code.fails >= MAX_FAILS_PER_CODE) codes.delete(key);
  }
  const tooManyTries = (key, userId) => {
    const t = tries.get(`${key}|${userId}`);
    return Boolean(t && now() - t.since < CODE_TTL_MS && t.n >= MAX_TRIES_PER_PERSON);
  };

  async function reply(rec, chatId, text) {
    if (!rec.conn) return;
    await enqueue(rec, String(chatId), async () => {
      for (const part of splitText(text, rec.limit)) await rec.conn?.send(String(chatId), part);
    });
  }

  function enqueue(rec, chatId, job) {
    const k = `${rec.key}|${chatId}`;
    const tail = (queues.get(k) ?? Promise.resolve()).then(job).catch((error) => log(`channels: sending to ${rec.kind}: ${redact(error?.message ?? error, rec.secrets)}`));
    queues.set(k, tail);
    void tail.then(() => {
      if (queues.get(k) === tail) queues.delete(k);
    });
    return tail;
  }

  /** `a` ≤ `b` for decimal ids without leading zeros (Telegram message ids, Discord snowflakes, a connector's `order`). */
  const notAfter = (a, b) => (a.length !== b.length ? a.length < b.length : a <= b);
  /**
   * Whether this message was handled before. A chat app hands a message out again
   * when the connector stopped before confirming it (a restart, a new token, a
   * resumed session); a task must not run twice. Ids rise within a chat, so the
   * highest one handled per chat is enough, and it is kept across restarts.
   */
  function replayed(key, chatId, messageId) {
    if (!/^\d{1,30}$/.test(messageId)) return false;
    const record = recordOf(key);
    const seen = (record.seen ??= {});
    const last = seen[chatId];
    if (last && notAfter(messageId, last)) return true;
    delete seen[chatId];
    seen[chatId] = messageId;
    const chats = Object.keys(seen);
    if (chats.length > 300) delete seen[chats[0]];
    save();
    return false;
  }

  /** One message from a connector. */
  async function inbound(rec, msg) {
    const owner = deps.bots().find((b) => b.id === rec.botId);
    if (!owner || !msg) return;
    const text = String(msg.text ?? '').trim();
    const userId = String(msg.userId ?? '');
    const chatId = String(msg.chatId ?? '');
    if (!text || !userId || !chatId) return;
    // In a group the bot only listens when it is addressed.
    if (!msg.isDirect && !msg.mentioned) return;
    if (replayed(rec.key, chatId, String(msg.order ?? msg.messageId ?? ''))) return;
    const record = recordOf(rec.key);
    const person = record.paired.find((p) => p.id === userId);
    const candidate = pairingCandidate(text);
    const code = activeCode(rec.key);

    if (!person) {
      if (msg.isDirect && candidate && code && !tooManyTries(rec.key, userId)) {
        if (candidate === code.code) {
          codes.delete(rec.key);
          record.paired.push({ id: userId, name: cleanName(msg.userName) || userId, chatId, at: now() });
          save();
          log(`channels: ${rec.kind}: paired ${cleanName(msg.userName) || userId} with @${owner.handle}`);
          await reply(rec, chatId, welcomeText(owner, deps.bots(), { paired: true }));
          return;
        }
        wrongCode(rec.key, userId, code);
      }
      const seen = ignored.get(rec.key) ?? { count: 0 };
      ignored.set(rec.key, { count: seen.count + 1, lastName: cleanName(msg.userName) || userId, lastAt: now() });
      if (msg.isDirect) {
        const k = `${rec.key}|${chatId}`;
        const last = notices.get(k);
        if (!last || now() - last >= NOTICE_EVERY_MS) {
          notices.set(k, now());
          await reply(rec, chatId, PRIVATE_TEXT);
        }
      }
      return;
    }

    // A paired person: keep where to reach them privately, and their current name.
    let dirty = false;
    if (msg.isDirect && person.chatId !== chatId) {
      person.chatId = chatId;
      dirty = true;
    }
    const name = cleanName(msg.userName);
    if (name && person.name !== name) {
      person.name = name;
      dirty = true;
    }
    if (dirty) save();
    if (code && candidate === code.code) {
      codes.delete(rec.key);
      await reply(rec, chatId, welcomeText(owner, deps.bots(), { paired: true }));
      return;
    }
    if (isGreeting(text) || /^\/start(@\S+)?\s/i.test(text)) {
      await reply(rec, chatId, welcomeText(owner, deps.bots()));
      return;
    }
    const routed = routeMessage(text, owner, deps.bots());
    if (!routed.text) return;
    // `/new` starts the bot's next topic; text after it goes to the new one.
    const cmd = typeof deps.newTopic === 'function' ? topicCommand(routed.text) : null;
    if (cmd) {
      try {
        await deps.newTopic(routed.bot);
      } catch (error) {
        await reply(rec, chatId, redact(error?.message ?? error, rec.secrets).slice(0, 200));
        return;
      }
      if (!cmd.rest) {
        await reply(rec, chatId, newTopicText(routed.bot));
        return;
      }
      routed.text = cmd.rest;
    }
    const header = sourceHeader(rec.kind, msg);
    const origin = {
      key: rec.key,
      kind: rec.kind,
      chatId,
      ...(msg.isDirect ? {} : { replyTo: String(msg.messageId ?? '') }),
      who: name || person.name,
      body: routed.text,
    };
    // Noted before the hand-over: the conversation may show the message before deliver returns.
    const list = (pending.get(routed.bot.id) ?? []).filter((p) => now() - p.at < PENDING_TTL_MS);
    const item = { text: `${header}\n${routed.text}`, origin, at: now() };
    list.push(item);
    pending.set(routed.bot.id, list);
    let sessionId;
    try {
      sessionId = await deps.deliver(routed.bot, { header, body: routed.text });
    } catch (error) {
      const left = pending.get(routed.bot.id) ?? [];
      if (left.includes(item)) left.splice(left.indexOf(item), 1);
      log(`channels: could not hand a ${rec.kind} message to @${routed.bot.handle}: ${error?.message ?? error}`);
      await reply(rec, chatId, `Could not reach ${routed.bot.name}: ${redact(error?.message ?? error, rec.secrets).slice(0, 200)}`);
      return;
    }
    if (sessionId) startTyping(sessionId, rec.key, chatId);
  }

  // --- typing -------------------------------------------------------------------------

  function startTyping(sessionId, key, chatId) {
    stopTyping(sessionId);
    const started = now();
    const tick = () => {
      const conn = live.get(key)?.conn;
      if (!conn) return void stopTyping(sessionId);
      Promise.resolve()
        .then(() => conn.typing(chatId))
        .catch(() => {});
    };
    const timer = setInterval(() => {
      const elapsed = now() - started;
      if (elapsed > TYPING_MAX_MS || (elapsed > typingEvery * 2 && !running(sessionId))) return void stopTyping(sessionId);
      tick();
    }, typingEvery);
    timer.unref?.();
    typing.set(sessionId, { timer, key, chatId, claimed: false });
    tick();
  }
  function stopTyping(sessionId) {
    const loop = typing.get(sessionId);
    if (!loop) return;
    clearInterval(loop.timer);
    typing.delete(sessionId);
  }

  // --- reply targets --------------------------------------------------------------------

  /** Where a scheduled run of `bot` reports: its channel's first paired person, privately. */
  function scheduleTarget(bot) {
    const entries = deps.entries();
    for (const app of bot.apps ?? []) {
      const entry = channelEntry(app, entries);
      if (!entry || app.enabled === false) continue;
      const key = keyOf(bot.id, app.id);
      const record = data.channels[key];
      if (!record || record.scheduleReplies === false) continue;
      const person = (record.paired ?? []).find((p) => p.chatId);
      if (person) return { key, kind: entry.channel ?? entry.id, chatId: person.chatId, who: person.name, origin: 'schedule' };
    }
    return null;
  }

  function claim(botId, text) {
    const list = (pending.get(botId) ?? []).filter((p) => now() - p.at < PENDING_TTL_MS);
    const i = list.findIndex((p) => norm(p.text) === norm(text));
    if (i === -1) {
      pending.set(botId, list);
      return null;
    }
    const [hit] = list.splice(i, 1);
    if (list.length) pending.set(botId, list);
    else pending.delete(botId);
    return hit.origin;
  }

  /** Links a connector module offers the panel (a deep link to pair, an invite). */
  function linksOf(rec, account, code) {
    if (typeof rec?.mod?.links !== 'function' || !account) return {};
    try {
      const l = rec.mod.links({ account, code: code?.code ?? null, values: { ...rec.values } }) ?? {};
      return { ...(typeof l.link === 'string' && l.link ? { link: l.link } : {}), ...(typeof l.invite === 'string' && l.invite ? { invite: l.invite } : {}) };
    } catch {
      return {};
    }
  }

  return {
    sync,

    /**
     * A message entered `bot`'s conversation. A channel message makes that chat
     * the reply target (and returns where it came from); any other user message
     * (the panel) takes replies back to the panel. A scheduled run reports to
     * the channel's first paired person when the channel allows it.
     * @param {string} sessionId
     * @param {object} bot
     * @param {string} kind - the message source kind ('user', 'schedule', 'agent-message', …)
     * @param {string} text - the message text
     */
    noteUserMessage(sessionId, bot, kind, text) {
      if (!sessionId || !bot) return null;
      if (kind === 'user') {
        const origin = claim(bot.id, text);
        if (origin) {
          targets.set(sessionId, { key: origin.key, kind: origin.kind, chatId: origin.chatId, ...(origin.replyTo ? { replyTo: origin.replyTo } : {}), who: origin.who, origin: 'chat' });
          const loop = typing.get(sessionId);
          if (loop) loop.claimed = true;
          return origin;
        }
        targets.delete(sessionId);
        return null;
      }
      if (kind === 'schedule') {
        const t = scheduleTarget(bot);
        if (t) targets.set(sessionId, t);
        else targets.delete(sessionId);
      }
      return null;
    },

    /**
     * A user-facing reply of the conversation `sessionId`: sent to its chat when
     * its latest human input came from one. Returns the target (or null) at once;
     * sending continues in the background.
     */
    noteReply(sessionId, text) {
      const target = targets.get(sessionId);
      if (!target || !String(text ?? '').trim()) return null;
      const rec = live.get(target.key);
      stopTyping(sessionId);
      if (!rec?.conn) {
        log(`channels: a reply for ${target.kind} was not sent: the channel is not connected`);
        return null;
      }
      const plain = rec.mod?.MARKDOWN === true || RENDERS_MARKDOWN.has(target.kind) ? String(text).trim() : toPlainText(text);
      void enqueue(rec, target.chatId, async () => {
        let first = true;
        for (const part of splitText(plain, rec.limit)) {
          if (!rec.conn) break;
          // A chat app that threads replies (Slack) keeps every part in the thread; elsewhere only the first part quotes.
          await rec.conn.send(target.chatId, part, target.replyTo && (first || rec.mod?.THREADS === true) ? { replyTo: target.replyTo } : undefined);
          first = false;
        }
      });
      return target;
    },

    /** A turn of `sessionId` ended: the typing indicator of the message it answered stops. */
    noteTurnEnd(sessionId) {
      if (typing.get(sessionId)?.claimed) stopTyping(sessionId);
    },

    /** Where `sessionId`'s replies go now, if to a chat. */
    targetOf(sessionId) {
      return targets.get(sessionId) ?? null;
    },

    /** What the panel shows of `bot`'s channels: {[appId]: ChannelView}. */
    view(bot) {
      const entries = deps.entries();
      const out = {};
      for (const app of bot?.apps ?? []) {
        const entry = channelEntry(app, entries);
        if (!entry) continue;
        const key = keyOf(bot.id, app.id);
        const kind = entry.channel ?? entry.id;
        const rec = live.get(key);
        const record = data.channels[key] ?? { paired: [], scheduleReplies: true };
        const code = activeCode(key);
        const state = app.enabled === false ? 'off' : !tokenOf(app, entry) || channelIssue(app, entry) ? 'missing' : rec?.status?.state ?? 'connecting';
        const account = rec?.account ?? (record.account?.username ? { id: record.account.id, username: record.account.username, name: '' } : null);
        out[app.id] = {
          kind,
          state,
          ...(state === 'error' || state === 'connecting' ? { ...(rec?.status?.detail ? { detail: rec.status.detail } : {}), ...(rec?.status?.hint ? { hint: rec.status.hint } : {}), ...(rec?.status?.fatal ? { fatal: true } : {}) } : {}),
          account: account ? { username: account.username, name: account.name ?? '' } : null,
          paired: (record.paired ?? []).map((p) => ({ id: p.id, name: p.name, at: p.at, direct: Boolean(p.chatId) })),
          code: code ? { code: code.code, expiresAt: code.expiresAt } : null,
          link: code && kind === 'telegram' && account?.username ? `https://t.me/${account.username}?start=${code.code}` : null,
          invite: kind === 'discord' && account?.id ? `https://discord.com/oauth2/authorize?client_id=${account.id}&scope=bot&permissions=68608` : null,
          ...linksOf(rec, account, code),
          scheduleReplies: record.scheduleReplies !== false,
          ignored: ignored.get(key) ?? { count: 0 },
        };
      }
      return out;
    },

    /** A new pairing code for a channel (the old one stops working). */
    newCode(botId, appId) {
      const key = keyOf(botId, appId);
      if (!deps.bots().some((b) => b.id === botId && (b.apps ?? []).some((a) => a.id === appId && channelEntry(a, deps.entries())))) throw new Error('no such chat channel');
      const c = issueCode(key);
      return { code: c.code, expiresAt: c.expiresAt };
    },

    /** Forget a paired person: their next message is ignored like a stranger's. */
    unpair(botId, appId, userId) {
      const record = data.channels[keyOf(botId, appId)];
      if (!record) return false;
      const before = record.paired.length;
      record.paired = record.paired.filter((p) => p.id !== String(userId));
      if (record.paired.length === before) return false;
      save();
      for (const [sessionId, t] of [...targets]) if (t.key === keyOf(botId, appId)) targets.delete(sessionId);
      return true;
    },

    /** Channel options: `scheduleReplies` (scheduled runs report to the first paired person). */
    setOptions(botId, appId, options) {
      if (!deps.bots().some((b) => b.id === botId && (b.apps ?? []).some((a) => a.id === appId && channelEntry(a, deps.entries())))) throw new Error('no such chat channel');
      const record = recordOf(keyOf(botId, appId));
      if (typeof options?.scheduleReplies === 'boolean') record.scheduleReplies = options.scheduleReplies;
      save();
      return { scheduleReplies: record.scheduleReplies };
    },

    /** Drop and reconnect one channel (after fixing a setting in the chat app's own console). */
    reconnect(botId, appId) {
      const key = keyOf(botId, appId);
      const rec = live.get(key);
      if (rec) {
        live.delete(key);
        void stopRecord(rec);
      }
      sync();
      return live.has(key);
    },

    /** Stop every connector; nothing restarts afterwards. */
    async stopAll() {
      disposed = true;
      for (const sessionId of [...typing.keys()]) stopTyping(sessionId);
      const recs = [...live.values()];
      live.clear();
      await Promise.all(recs.map((rec) => stopRecord(rec)));
    },

    /** For tests: the live record of a channel. */
    _live: live,
  };
}
