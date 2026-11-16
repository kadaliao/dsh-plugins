/**
 * Slack transport for bot chat channels, over Socket Mode: Slack pushes events
 * down a WebSocket the connector opens, so the computer running the Harness
 * needs no public URL. Replies and lookups go through the Web API.
 *
 * Transport only: it knows nothing about bots, pairing or the store
 * (lib/channels.mjs decides what a message means).
 *
 * - Two tokens: the bot token (`xoxb-…`, `values.token`) for the Web API and
 *   the app-level token (`xapp-…`, `values.appToken`, scope connections:write)
 *   for `apps.connections.open`, which hands out a short-lived wss URL.
 * - Every envelope is acknowledged with its `envelope_id` as soon as it
 *   arrives. A `disconnect` (warning / refresh_requested) opens a replacement
 *   socket first and closes the old one once the new one says hello, so no
 *   event falls in a gap; `link_disabled` (Socket Mode turned off) is fatal.
 * - Dropped connections reconnect with backoff (1 s … 60 s). Slack pings the
 *   socket; when the runtime reports those pings and they stop for a minute
 *   (a dead link, a laptop waking up), the connector reconnects.
 * - DMs arrive as `message` events (`channel_type: 'im'`), channel mentions as
 *   `app_mention`; one message seen as both is handled once. Bots, the app
 *   itself, edits and other subtypes are dropped.
 * - Replies go out as a `markdown` block (Slack renders the Markdown models
 *   write, tables and code included) with a plain `text` fallback for
 *   notifications and screen readers. In a channel they go to the thread of
 *   the message they answer.
 * - No secret appears in a log line, an error or a status.
 *
 * `apiBase` defaults to `BOTS_SLACK_API` or https://slack.com/api, so a local
 * stand-in can be used for testing.
 *
 * @module @kadaliao/dsh-bots/lib/channels/slack
 */

import { channel as diagnosticsChannel } from 'node:diagnostics_channel';

import { redact, toPlainText } from '../channels.mjs';
import { backoffDelay, splitMessage } from './discord.mjs';

export const kind = 'slack';
/** What one `send` takes; it posts that as messages of at most PART_LIMIT, all in the same thread. */
export const TEXT_LIMIT = 40_000;
/** Replies are Markdown: Slack's `markdown` block renders it. */
export const MARKDOWN = true;
/** Replies in a channel go into the thread of the message they answer, every part of them. */
export const THREADS = true;

/** Slack caps the `markdown` blocks of one message at 12,000 characters in all. */
const PART_LIMIT = 11_000;
const DEFAULT_API = 'https://slack.com/api';
const HELLO_TIMEOUT_MS = 15_000;
/** Slack pings every few seconds; this long without one means the link is dead. */
const PING_TIMEOUT_MS = 60_000;
/** Another program may share the app: confirm with a fresh connection after this long, then re-check now and then. */
const CONFLICT_CHECK_MS = 2 * 60_000;
const CONFLICT_RECHECK_MS = 10 * 60_000;
const RATE_LIMIT_RETRIES = 4;
const MAX_RETRY_WAIT = 60_000;
/** The "is thinking…" status lasts two minutes unless a reply clears it; refresh it this often. */
const STATUS_EVERY_MS = 45_000;
const NAME_TTL_MS = 6 * 3600_000;

/** Bot token scopes the app needs: what the manifest asks for. */
export const BOT_SCOPES = ['app_mentions:read', 'channels:read', 'chat:write', 'groups:read', 'im:history', 'users:read'];
/** Without these nothing works: no mentions, no replies, no DMs. The rest only name people and channels. */
const REQUIRED_SCOPES = ['app_mentions:read', 'chat:write', 'im:history'];
export const BOT_EVENTS = ['app_mention', 'message.im'];

const BOT_TOKEN_REJECTED = "Slack rejected the bot token. Copy the Bot User OAuth Token (xoxb-…) again from your app's OAuth & Permissions page; if the app was removed from the workspace, install it again.";
const APP_TOKEN_REJECTED = 'Slack rejected the app-level token. In your app open Basic Information → App-Level Tokens, generate a token with the connections:write scope and paste it (xapp-…).';
const APP_TOKEN_SCOPE = 'The app-level token lacks the connections:write scope. In your app open Basic Information → App-Level Tokens, generate a token with connections:write and paste it.';
const APP_TOKEN_KIND = "The App-level token field must hold an app-level token (xapp-…) from Basic Information → App-Level Tokens, not the bot token.";
const BOT_TOKEN_KIND = "The Bot token field must hold the Bot User OAuth Token (xoxb-…) from your app's OAuth & Permissions page.";
const SOCKET_MODE_OFF = 'Socket Mode is off for this Slack app. Turn it on (your app → Socket Mode → Enable Socket Mode), then reconnect.';
const WS_TROUBLE = '. If this keeps happening, check that Socket Mode is on for the app and that this network allows WebSockets';

const BOT_AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'user_removed_from_team', 'team_disabled']);
const BLOCK_ERRORS = new Set(['invalid_blocks', 'invalid_blocks_format', 'msg_blocks_too_long']);
const STATUS_UNSUPPORTED = new Set(['missing_scope', 'method_not_supported_for_channel_type', 'not_allowed_token_type', 'unknown_method', 'method_deprecated', 'deprecated_endpoint', 'no_permission']);
/** Message subtypes that are a person writing (a file with a caption, a reply also sent to the channel, /me). */
const HUMAN_SUBTYPES = new Set(['file_share', 'thread_broadcast', 'me_message']);
const TOKEN_SHAPES = /\b(?:xox[a-z]|xapp|xoxe)(?:\.xox[a-z])?-[A-Za-z0-9-]{6,}/g;

/** Bot user id → {teamId, appId} of running connectors, for `links`. */
const APPS = new Map();

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

function remember(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}

/** A Slack `ts` ("1700000000.000100") as a decimal string that rises with it: the hub's replay guard. */
export function orderOf(ts) {
  const m = /^(\d{1,20})(?:\.(\d{1,9}))?$/.exec(String(ts ?? ''));
  if (!m) return '';
  return `${m[1]}${(m[2] ?? '').padEnd(6, '0').slice(0, 6)}`.replace(/^0+(?=\d)/, '');
}

/** Required scopes missing from an `X-OAuth-Scopes` header ([] when the header is absent). */
export function missingScopes(header, wanted = REQUIRED_SCOPES) {
  if (typeof header !== 'string' || !header.trim()) return [];
  const have = header.split(',').map((s) => s.trim()).filter(Boolean);
  return wanted.filter((w) => !have.some((h) => h === w || h.startsWith(`${w}:`)));
}

/** Why these two strings cannot be a Slack bot token and app-level token, or ''. */
export function tokenProblem(botToken, appToken) {
  const bot = String(botToken ?? '').trim();
  const app = String(appToken ?? '').trim();
  if (/^xapp-/i.test(bot) && /^xox/i.test(app)) return 'The two Slack tokens are swapped: the Bot token starts with xoxb-, the App-level token with xapp-.';
  if (/^xapp-/i.test(bot)) return `The Bot token field holds an app-level token (xapp-…). ${BOT_TOKEN_KIND}`;
  if (/^xoxp-/i.test(bot)) return `That is a user token (xoxp-…). ${BOT_TOKEN_KIND}`;
  if (/^xox[a-z]-/i.test(app)) return APP_TOKEN_KIND;
  return '';
}

/**
 * Slack message text as plain chat text: the bot's own mention removed, other
 * mentions, channels and links readable, `&lt;` and friends decoded.
 * @param {string} text
 * @param {{botUserId?: string, names?: Map<string, string>}} [ctx] names of mentioned users
 */
export function fromSlack(text, { botUserId = '', names } = {}) {
  let s = String(text ?? '');
  if (botUserId) {
    s = s
      .replace(new RegExp(`<@${escapeRe(botUserId)}(?:\\|[^>]*)?>`, 'g'), '\u0000')
      .replace(/[ \t]*\u0000[ \t]*(?=[,，.。!?！？:：;；])/g, '')
      .replace(/[ \t]*\u0000[ \t]*/g, ' ');
  }
  s = s
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `@${names?.get?.(id) || label || id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `#${label || id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label) => label || '@group')
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, '$1')
    .replace(/<!([a-z]+)(?:\|([^>]*))?>/g, (_, k, label) => label || `@${k}`)
    .replace(/<((?:https?|mailto|tel|ftp):[^|>\s]+)\|([^>]+)>/g, (_, url, label) => {
      const bare = url.replace(/^(?:mailto|tel):/, '');
      return label === url || label === bare ? bare : `${label} (${url})`;
    })
    .replace(/<((?:https?|mailto|tel|ftp):[^|>\s]+)>/g, (_, url) => url.replace(/^(?:mailto|tel):/, ''))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return s.replace(/^[ \t,，:：;；]+/, '').trim();
}

/** Outgoing Markdown with Slack's broadcast mentions (`<!channel>`, `<!here>`, user groups) made plain text: no reply pings a whole channel. */
export function defuse(md) {
  return String(md ?? '')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label) => label || '@group');
}

/** The plain `text` of a reply: Markdown markers dropped, Slack's control characters escaped (a user mention stays a mention). */
export function fallbackText(md) {
  const plain = toPlainText(defuse(md))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;@([UW][A-Z0-9]+)&gt;/g, '<@$1>');
  return plain || ' ';
}

/**
 * An Events API `message` / `app_mention` event as the start of a channel
 * message, or null when it is not a person writing to the bot. `raw` is still
 * Slack-formatted; `thread` is the thread a reply belongs in.
 * @param {object} ev
 * @param {{userId: string, botId?: string}} me
 */
export function normalizeEvent(ev, me) {
  if (!ev || typeof ev !== 'object' || !me?.userId) return null;
  if (ev.type !== 'message' && ev.type !== 'app_mention') return null;
  if (ev.subtype != null && ev.subtype !== '' && !HUMAN_SUBTYPES.has(ev.subtype)) return null;
  if (ev.hidden || ev.bot_id || ev.bot_profile || !ev.user) return null;
  if (String(ev.user) === me.userId) return null;
  const chatId = String(ev.channel ?? '');
  const ts = String(ev.ts ?? '');
  const order = orderOf(ts);
  if (!chatId || !order) return null;
  const raw = typeof ev.text === 'string' ? ev.text : '';
  if (!raw.trim()) return null;
  const isDirect = ev.type === 'message' ? ev.channel_type === 'im' : chatId.startsWith('D');
  const mentioned =
    isDirect ||
    ev.type === 'app_mention' ||
    new RegExp(`<@${escapeRe(me.userId)}(?:\\|[^>]*)?>`).test(raw) ||
    (Boolean(ev.parent_user_id) && String(ev.parent_user_id) === me.userId);
  const profile = ev.user_profile ?? {};
  return {
    chatId,
    messageId: ts,
    order,
    userId: String(ev.user),
    raw,
    isDirect,
    mentioned,
    thread: String(ev.thread_ts || ts),
    profileName: cleanName(profile.display_name || profile.real_name || profile.name || ''),
  };
}

/**
 * A link the panel offers next to the pairing code: it opens the app's DM in
 * Slack. Known once the connector has connected in this process.
 */
export function links({ account } = {}) {
  const a = APPS.get(String(account?.id ?? ''));
  if (!a?.appId) return {};
  return { link: `https://slack.com/app_redirect?app=${encodeURIComponent(a.appId)}${a.teamId ? `&team=${encodeURIComponent(a.teamId)}` : ''}` };
}

/**
 * The app manifest for "Create New App → From a manifest": Socket Mode on, the
 * Messages tab open for DMs, the bot scopes and events the connector uses.
 * @param {{name?: string, description?: string}} [opts]
 */
export function appManifest({ name = 'Bot Team', description = 'Message your bot team from Slack: DM the app, or @mention it in a channel.' } = {}) {
  const n = cleanName(name).slice(0, 35) || 'Bot Team';
  return {
    display_information: { name: n, description: cleanName(description).slice(0, 140), background_color: '#4a154b' },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: n, always_online: true },
    },
    oauth_config: { scopes: { bot: [...BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: [...BOT_EVENTS] },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

async function readJson(res) {
  try {
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

function retryAfterMs(headers) {
  const sec = Number(headers?.get?.('retry-after'));
  return Number.isFinite(sec) && sec >= 0 ? Math.min(MAX_RETRY_WAIT, Math.max(1000, Math.ceil(sec * 1000))) : 1000;
}

/**
 * @typedef {object} ChannelMessage
 * @property {string} chatId the conversation: D… for a DM, C…/G… for a channel
 * @property {string} messageId the message `ts`
 * @property {string} order `ts` as a rising decimal string
 * @property {string} userId
 * @property {string} userName
 * @property {string} text the bot's own mention removed, trimmed
 * @property {boolean} isDirect a DM with the app
 * @property {boolean} mentioned @mentioned; always true in a DM
 * @property {string} [chatTitle] `Workspace #channel`, when Slack names it
 */

/**
 * @param {object} opts
 * @param {string} [opts.token] the bot token (else `values.token`)
 * @param {{token?: string, appToken?: string}} [opts.values] the app's fields
 * @param {(msg: ChannelMessage) => void} opts.onMessage
 * @param {(s: {state: 'connecting'|'connected'|'error'|'stopped', detail?: string, hint?: string, fatal?: boolean}) => void} [opts.onStatus]
 * @param {(line: string) => void} [opts.log]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 * @param {string} [opts.apiBase]
 * @param {{subscribe: Function, unsubscribe: Function} | null} [opts.pingChannel] where the runtime reports WebSocket pings; null turns the watchdog off
 * @param {typeof setTimeout} [opts.setTimeoutImpl] for tests
 * @param {typeof clearTimeout} [opts.clearTimeoutImpl] for tests
 * @param {() => number} [opts.now] for tests
 * @param {() => number} [opts.random] for tests (backoff jitter)
 */
export function createConnector(opts = {}) {
  const values = opts.values ?? {};
  const botToken = String(opts.token || values.token || '').trim();
  const appToken = String(values.appToken || opts.appToken || '').trim();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const WebSocketImpl = opts.WebSocketImpl ?? globalThis.WebSocket;
  const base = String(opts.apiBase || process.env.BOTS_SLACK_API || DEFAULT_API).replace(/\/+$/, '');
  const onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : () => {};
  const setT = opts.setTimeoutImpl ?? setTimeout;
  const clearT = opts.clearTimeoutImpl ?? clearTimeout;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  let pings = null;
  try {
    pings = opts.pingChannel === undefined ? diagnosticsChannel('undici:websocket:ping') : opts.pingChannel;
  } catch {
    pings = null;
  }

  /** No string leaves this module with a token (or a connection ticket) in it. */
  const scrub = (v) =>
    redact(String(v ?? ''), [botToken, appToken])
      .replace(TOKEN_SHAPES, '<token>')
      .replace(/ticket=[^&\s"']+/g, 'ticket=<redacted>');
  const log = (line) => {
    try {
      opts.log?.(scrub(line));
    } catch {
      // Logging is a convenience.
    }
  };
  const status = (state, detail = '', extra = {}) => {
    const s = { state };
    if (detail) s.detail = scrub(detail);
    if (extra.hint) s.hint = extra.hint;
    if (state === 'error') s.fatal = Boolean(extra.fatal);
    try {
      opts.onStatus?.(s);
    } catch (e) {
      log(`slack: onStatus threw: ${e?.message ?? e}`);
    }
  };
  const guard = (fn) => (...args) => {
    try {
      fn(...args);
    } catch (e) {
      log(`slack: ${e?.message ?? e}`);
    }
  };
  const cancel = (h) => {
    if (h != null) clearT(h);
  };

  let stopped = false;
  let dead = false;
  const halted = () => stopped || dead;
  const halt = new AbortController();
  const stoppedError = () => new Error('Slack connector stopped');

  const sleepers = new Set();
  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      if (halted()) return reject(stoppedError());
      const entry = { reject };
      entry.timer = setT(() => {
        sleepers.delete(entry);
        resolve();
      }, ms);
      sleepers.add(entry);
    });

  // --- Web API ---------------------------------------------------------------------------

  /** One Web API call: `{data, headers}`. Errors carry `code` (Slack's `error`), `status` and `needed`. */
  async function call(method, params = {}, { token = botToken, timeoutMs = 15_000, retries = RATE_LIMIT_RETRIES } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      if (stopped) throw stoppedError();
      const signal = AbortSignal.any([halt.signal, AbortSignal.timeout(timeoutMs)]);
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      let res;
      let data;
      try {
        res = await fetchImpl(`${base}/${method}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
          body: form.toString(),
          signal,
        });
        data = await readJson(res);
      } catch (error) {
        if (stopped) throw stoppedError();
        const why = error?.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError' ? 'timed out' : error?.cause?.code ?? error?.cause?.message ?? error?.message ?? 'network error';
        throw Object.assign(new Error(scrub(`could not reach Slack (${method}: ${why})`)), { network: true });
      }
      const limited = res.status === 429 || data?.error === 'ratelimited' || data?.error === 'rate_limited';
      if (limited && attempt < retries) {
        const wait = retryAfterMs(res.headers);
        log(`slack: rate limited on ${method}, retrying in ${wait} ms`);
        await sleep(wait);
        continue;
      }
      if (data?.ok === true) return { data, headers: res.headers };
      const code = String(data?.error || `HTTP ${res.status}`);
      const err = new Error(scrub(`Slack ${method}: ${code}${data?.needed ? ` (needs ${data.needed})` : ''}`));
      err.code = code;
      err.status = res.status;
      if (data?.needed) err.needed = String(data.needed);
      if (limited) err.rateLimited = true;
      throw err;
    }
  }
  const api = async (method, params, o) => (await call(method, params, o)).data;

  // --- who is who ------------------------------------------------------------------------

  let me = null;
  let appId = '';
  const names = new Map(); // user id → {name, at}
  const titles = new Map(); // channel id → {title, at}
  let usersOff = false;

  function failBotToken() {
    fail(BOT_TOKEN_REJECTED, 'token');
  }

  async function nameOf(userId) {
    const hit = names.get(userId);
    if (hit && now() - hit.at < NAME_TTL_MS) return hit.name;
    if (usersOff || halted()) return hit?.name ?? '';
    try {
      const u = (await api('users.info', { user: userId }, { timeoutMs: 5000, retries: 1 })).user ?? {};
      const name = cleanName(u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || '');
      remember(names, userId, { name, at: now() }, 1000);
      return name;
    } catch (e) {
      if (e.code === 'missing_scope') {
        usersOff = true;
        log('slack: the bot token lacks users:read, so people show by their Slack ID; add the scope and reinstall the app');
      } else if (BOT_AUTH_ERRORS.has(e.code)) failBotToken();
      else if (e.code === 'user_not_found') remember(names, userId, { name: '', at: now() }, 1000);
      else if (!halted()) log(`slack: ${e.message}`);
      return hit?.name ?? '';
    }
  }

  async function titleOf(channelId) {
    const hit = titles.get(channelId);
    if (hit && now() - hit.at < NAME_TTL_MS) return hit.title;
    if (halted()) return hit?.title ?? '';
    let title = '';
    try {
      const c = (await api('conversations.info', { channel: channelId }, { timeoutMs: 5000, retries: 1 })).channel ?? {};
      const name = cleanName(c.is_mpim ? 'group DM' : c.name ? `#${c.name}` : '');
      title = name && me?.team && !c.is_mpim ? `${me.team} ${name}` : name;
    } catch (e) {
      if (BOT_AUTH_ERRORS.has(e.code)) failBotToken();
      else if (e.code !== 'missing_scope' && e.code !== 'channel_not_found' && !halted()) log(`slack: ${e.message}`);
    }
    remember(titles, channelId, { title, at: now() }, 500);
    return title;
  }

  // --- inbound ---------------------------------------------------------------------------

  const events = new Map(); // event_id → true
  const handled = new Map(); // `${chat}|${ts}` → true: one message as both `message` and `app_mention`
  const roots = new Map(); // `${chat}|${ts}` → its thread
  const lastThread = new Map(); // chat → thread of its latest mention (for the "is thinking…" status)
  let inbound = Promise.resolve();

  function emit(msg) {
    try {
      const r = onMessage(msg);
      if (r && typeof r.catch === 'function') r.catch((e) => log(`slack: onMessage failed: ${e?.message ?? e}`));
    } catch (e) {
      log(`slack: onMessage threw: ${e?.message ?? e}`);
    }
  }

  async function finish(n) {
    const ids = [...new Set([...n.raw.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]).filter((id) => id !== me.userId))].slice(0, 10);
    const [userName, title, ...others] = await Promise.all([nameOf(n.userId), n.isDirect ? '' : titleOf(n.chatId), ...ids.map((id) => nameOf(id))]);
    const known = new Map(ids.map((id, i) => [id, others[i]]));
    const text = fromSlack(n.raw, { botUserId: me.userId, names: known });
    if (!text) return null;
    return {
      chatId: n.chatId,
      messageId: n.messageId,
      order: n.order,
      userId: n.userId,
      userName: userName || n.profileName || n.userId,
      text,
      isDirect: n.isDirect,
      mentioned: n.mentioned,
      ...(title ? { chatTitle: title } : {}),
    };
  }

  function onEvent(payload) {
    if (!me) return;
    const eventId = String(payload?.event_id ?? '');
    if (eventId) {
      if (events.has(eventId)) return;
      remember(events, eventId, true, 1000);
    }
    const n = normalizeEvent(payload?.event, me);
    if (!n) return;
    const k = `${n.chatId}|${n.messageId}`;
    if (handled.has(k)) return;
    remember(handled, k, true, 2000);
    remember(roots, k, n.thread, 2000);
    if (!n.isDirect && n.mentioned) remember(lastThread, n.chatId, n.thread, 500);
    // One at a time, so messages reach the hub in the order Slack sent them.
    inbound = inbound
      .then(() => finish(n))
      .then((msg) => {
        if (msg && !halted()) emit(msg);
      })
      .catch((e) => log(`slack: a message could not be read: ${e?.message ?? e}`));
  }

  // --- Socket Mode -----------------------------------------------------------------------

  /** The socket events come from (it said hello), and one being opened to replace or restore it. */
  let active = null;
  let opening = null;
  let reconnectTimer = null;
  let checkTimer = null;
  let attempts = 0;
  let healthy = false;
  let earlyCloses = 0; // sockets in a row that closed before hello
  let strikes = 0; // hellos in a row that counted other connections
  let pending = null;
  let startPromise = null;

  function closeSlot(slot) {
    if (!slot) return;
    slot.closed = true;
    cancel(slot.helloTimer);
    cancel(slot.pingTimer);
    slot.helloTimer = slot.pingTimer = null;
    if (slot.onPing) {
      try {
        pings?.unsubscribe?.(slot.onPing);
      } catch {
        // Gone already.
      }
      slot.onPing = null;
    }
    try {
      slot.ws?.close(1000);
    } catch {
      // Already closed.
    }
  }

  function schedule(delay) {
    cancel(reconnectTimer);
    reconnectTimer = setT(
      guard(() => {
        reconnectTimer = null;
        void openSocket();
      }),
      delay,
    );
  }

  /** Something failed: try again with backoff. The first drop after a good connection reads as `connecting`, repeats as `error`. */
  function retry(why) {
    if (halted()) return;
    const delay = backoffDelay(attempts, random);
    attempts += 1;
    const detail = `${why}; reconnecting in ${Math.max(1, Math.round(delay / 1000))} s${earlyCloses >= 3 ? WS_TROUBLE : ''}`;
    log(`slack: ${detail}`);
    if (!active) {
      status(healthy ? 'connecting' : 'error', detail);
      healthy = false;
    }
    schedule(delay);
  }

  /** Unrecoverable: no reconnects; `start` rejects if it is still waiting. */
  function fail(detail, hint) {
    if (halted()) return;
    dead = true;
    cancel(reconnectTimer);
    cancel(checkTimer);
    reconnectTimer = checkTimer = null;
    closeSlot(active);
    closeSlot(opening);
    active = opening = null;
    for (const s of sleepers) {
      cancel(s.timer);
      s.reject(stoppedError());
    }
    sleepers.clear();
    log(`slack: ${detail}`);
    status('error', detail, { fatal: true, hint });
    if (pending) {
      pending.reject(Object.assign(new Error(scrub(detail)), { fatal: true, ...(hint ? { hint } : {}) }));
      pending = null;
    }
  }

  function watchPings(slot) {
    if (typeof pings?.subscribe !== 'function') return;
    slot.onPing = (m) => {
      try {
        if (!slot.ws || m?.websocket !== slot.ws || slot.closed) return;
        cancel(slot.pingTimer);
        slot.pingTimer = setT(
          guard(() => {
            slot.pingTimer = null;
            if (slot !== active || halted()) return;
            log('slack: no ping from Slack for a minute; reconnecting');
            active = null;
            closeSlot(slot);
            if (!opening) {
              status('connecting', 'The Slack connection went quiet; reconnecting');
              healthy = false;
              void openSocket();
            }
          }),
          PING_TIMEOUT_MS,
        );
        slot.pingTimer?.unref?.();
      } catch {
        // A watchdog must not break the socket.
      }
    };
    try {
      pings.subscribe(slot.onPing);
    } catch {
      slot.onPing = null;
    }
  }

  /** Open a socket: the first one, a reconnect, or a replacement while the current one still works. */
  async function openSocket() {
    if (halted() || opening) return;
    cancel(reconnectTimer);
    reconnectTimer = null;
    const slot = { ws: null, closed: false, helloTimer: null, pingTimer: null, onPing: null };
    opening = slot;
    let url;
    try {
      url = (await api('apps.connections.open', {}, { token: appToken })).url;
    } catch (e) {
      if (opening === slot) opening = null;
      if (halted()) return;
      if (BOT_AUTH_ERRORS.has(e.code)) return fail(APP_TOKEN_REJECTED, 'app_token');
      if (e.code === 'missing_scope') return fail(APP_TOKEN_SCOPE, 'app_scope');
      if (e.code === 'not_allowed_token_type') return fail(APP_TOKEN_KIND, 'token_kind');
      if (/socket/i.test(e.code ?? '')) return fail(SOCKET_MODE_OFF, 'socket_mode');
      return retry(e.message);
    }
    if (halted() || opening !== slot) return;
    if (typeof url !== 'string' || !/^wss?:\/\//i.test(url)) {
      opening = null;
      return retry('Slack returned no Socket Mode URL');
    }
    appId = /[?&]app_id=([A-Z0-9]+)/.exec(url)?.[1] ?? appId;
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch (e) {
      opening = null;
      return retry(`could not open the Slack connection: ${e?.message ?? e}`);
    }
    slot.ws = ws;
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      // Not every implementation has it.
    }
    watchPings(slot);
    slot.helloTimer = setT(
      guard(() => {
        slot.helloTimer = null;
        if (opening !== slot) return;
        opening = null;
        closeSlot(slot);
        earlyCloses += 1;
        retry('Slack did not greet the new connection');
      }),
      HELLO_TIMEOUT_MS,
    );
    ws.addEventListener('message', guard((ev) => onFrame(slot, ev?.data)));
    ws.addEventListener('close', guard((ev) => onClose(slot, ev?.code, ev?.reason)));
    ws.addEventListener('error', guard(() => {}));
  }

  function onFrame(slot, data) {
    if (slot.closed || (slot !== active && slot !== opening)) return;
    let p;
    try {
      p = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return log('slack: ignored an unreadable Socket Mode frame');
    }
    if (p?.type === 'hello') return onHello(slot, p);
    if (p?.type === 'disconnect') return onDisconnect(slot, String(p.reason ?? ''));
    if (p?.envelope_id) {
      // Acknowledge first: Slack retries an envelope it does not hear back about within 3 s.
      try {
        slot.ws.send(JSON.stringify({ envelope_id: p.envelope_id }));
      } catch (e) {
        log(`slack: could not acknowledge an event: ${e?.message ?? e}`);
      }
    }
    if (p?.type === 'events_api') onEvent(p.payload);
  }

  function onHello(slot, p) {
    if (slot !== opening) return;
    cancel(slot.helloTimer);
    slot.helloTimer = null;
    opening = null;
    const old = active;
    active = slot;
    attempts = 0;
    earlyCloses = 0;
    healthy = true;
    appId = String(p?.connection_info?.app_id || appId || '');
    if (me) remember(APPS, me.userId, { teamId: me.teamId, appId }, 200);
    // Ours: this socket, and the one it replaces until it is closed below.
    const others = Math.max(0, (Number(p?.num_connections) || 1) - (old ? 2 : 1));
    if (old) closeSlot(old);
    cancel(checkTimer);
    checkTimer = null;
    if (others === 0) {
      strikes = 0;
      status('connected');
    } else {
      // A socket of ours that died a moment ago may still be counted: look again with a fresh connection before saying so.
      strikes += 1;
      log(`slack: Slack counts ${others} other Socket Mode connection${others === 1 ? '' : 's'} for this app`);
      if (strikes >= 2) {
        status('error', `Another program is connected to this Slack app (${others} other connection${others === 1 ? '' : 's'}), and Slack hands each message to only one of them. Stop it, or create a separate Slack app for the team.`, { hint: 'conflict' });
      } else status('connected');
      checkTimer = setT(
        guard(() => {
          checkTimer = null;
          if (!halted() && active === slot) void openSocket();
        }),
        strikes >= 2 ? CONFLICT_RECHECK_MS : CONFLICT_CHECK_MS,
      );
      checkTimer?.unref?.();
    }
    if (pending) {
      pending.resolve({ id: me.userId, username: me.user, name: me.name || me.user });
      pending = null;
    }
  }

  function onDisconnect(slot, reason) {
    log(`slack: Slack asked to reconnect (${reason || 'no reason'})`);
    if (reason === 'link_disabled') return fail(SOCKET_MODE_OFF, 'socket_mode');
    if (slot === active) {
      // warning (it closes in about 10 s), refresh_requested, or anything else: replace it now.
      if (!opening) void openSocket();
      return;
    }
    if (slot === opening) {
      opening = null;
      closeSlot(slot);
      retry(`Slack ended the new connection (${reason || 'disconnect'})`);
    }
  }

  function onClose(slot, code, reason) {
    const wasOpening = slot === opening;
    const wasActive = slot === active;
    if (!wasOpening && !wasActive) return;
    closeSlot(slot);
    if (wasOpening) opening = null;
    if (wasActive) active = null;
    if (halted()) return;
    const why = `Slack connection closed (${code ?? 'no code'}${reason ? `: ${reason}` : ''})`;
    if (wasOpening) {
      earlyCloses += 1;
      return retry(why);
    }
    if (opening || reconnectTimer) return; // a replacement is already on its way
    retry(why);
  }

  async function boot() {
    if (!botToken) return fail(`No Slack bot token. ${BOT_TOKEN_KIND}`, 'token');
    if (!appToken) return fail(`No Slack app-level token. ${APP_TOKEN_KIND}`, 'app_token');
    const problem = tokenProblem(botToken, appToken);
    if (problem) return fail(problem, 'token_kind');
    if (typeof WebSocketImpl !== 'function') return fail('This runtime has no WebSocket');
    if (typeof fetchImpl !== 'function') return fail('This runtime has no fetch');
    status('connecting', 'Connecting to Slack');
    let auth;
    let headers;
    for (let attempt = 0; ; attempt += 1) {
      try {
        ({ data: auth, headers } = await call('auth.test', {}, { timeoutMs: 20_000 }));
        break;
      } catch (e) {
        if (halted()) return;
        if (BOT_AUTH_ERRORS.has(e.code)) return fail(BOT_TOKEN_REJECTED, 'token');
        if (e.code === 'not_allowed_token_type') return fail(BOT_TOKEN_KIND, 'token_kind');
        const delay = backoffDelay(attempt, random);
        status('error', `${e.message}; retrying in ${Math.max(1, Math.round(delay / 1000))} s`);
        try {
          await sleep(delay);
        } catch {
          return;
        }
      }
    }
    if (halted()) return;
    if (!auth?.user_id) return fail(`Slack did not say which bot this token belongs to. ${BOT_TOKEN_KIND}`, 'token_kind');
    me = { userId: String(auth.user_id), botId: String(auth.bot_id ?? ''), user: String(auth.user ?? ''), teamId: String(auth.team_id ?? ''), team: cleanName(auth.team), name: '' };
    const granted = headers?.get?.('x-oauth-scopes');
    const missing = missingScopes(granted);
    if (missing.length) {
      return fail(
        `The Slack app is missing the ${missing.join(', ')} scope${missing.length > 1 ? 's' : ''}. Add ${missing.length > 1 ? 'them' : 'it'} under OAuth & Permissions → Bot Token Scopes (or create the app from the manifest), reinstall the app to the workspace, then reconnect.`,
        'scopes',
      );
    }
    const optional = missingScopes(granted, BOT_SCOPES).filter((s) => !REQUIRED_SCOPES.includes(s));
    if (optional.length) log(`slack: the bot token lacks ${optional.join(', ')}; people or channels show by their Slack IDs`);
    me.name = (await nameOf(me.userId)) || me.user;
    if (halted()) return;
    void openSocket();
  }

  // --- Public ----------------------------------------------------------------------------

  /** Check the bot token, open Socket Mode, resolve with the bot once Slack says hello. Transient failures keep retrying; fatal ones reject. */
  function start() {
    if (stopped) return Promise.reject(new Error('This Slack connector is stopped; create a new one'));
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      pending = { resolve, reject };
    });
    startPromise.catch(() => {}); // a fatal error is also reported through onStatus
    void boot().catch((e) => fail(e?.message ?? String(e)));
    return startPromise;
  }

  /** Close for good: no reconnects, no timers; pending rate-limit waits are cancelled. Idempotent. */
  async function stop() {
    if (stopped) return;
    stopped = true;
    halt.abort();
    cancel(reconnectTimer);
    cancel(checkTimer);
    reconnectTimer = checkTimer = null;
    closeSlot(active);
    closeSlot(opening);
    active = opening = null;
    for (const s of sleepers) {
      cancel(s.timer);
      s.reject(stoppedError());
    }
    sleepers.clear();
    if (pending) {
      pending.reject(new Error('Slack connector stopped before it connected'));
      pending = null;
    }
    status('stopped');
  }

  async function post(channel, md, thread) {
    const where = { channel, ...(thread ? { thread_ts: thread } : {}) };
    try {
      await api('chat.postMessage', { ...where, text: fallbackText(md), blocks: [{ type: 'markdown', text: defuse(md) }] });
    } catch (e) {
      if (BOT_AUTH_ERRORS.has(e.code)) failBotToken();
      if (!BLOCK_ERRORS.has(e.code)) throw e;
      log(`slack: Slack did not take the Markdown block (${e.code}); sending plain text`);
      await api('chat.postMessage', { ...where, text: fallbackText(md) });
    }
  }

  /**
   * Post Markdown `text` to a conversation, in parts of at most 11,000
   * characters (code fences closed and reopened at a cut). With `replyTo` (a
   * message `ts`) every part goes to that message's thread.
   */
  async function send(chatId, text, sendOpts = {}) {
    if (stopped) throw new Error('Slack connector is stopped');
    const channel = String(chatId);
    const replyTo = sendOpts?.replyTo ? String(sendOpts.replyTo) : '';
    const thread = replyTo ? roots.get(`${channel}|${replyTo}`) ?? replyTo : '';
    for (const part of splitMessage(text, PART_LIMIT)) await post(channel, part, thread);
  }

  const statusAt = new Map();
  let statusOff = false;
  /**
   * Show "<app> is thinking…" under the thread a channel reply will go to;
   * Slack clears it when the reply arrives, or after two minutes. Nothing in a
   * DM: a status there would turn the person's message into a thread.
   */
  async function typing(chatId) {
    if (halted() || statusOff) return;
    const channel = String(chatId);
    if (channel.startsWith('D')) return;
    const thread = lastThread.get(channel);
    if (!thread) return;
    const k = `${channel}|${thread}`;
    const at = statusAt.get(k);
    if (at !== undefined && now() - at < STATUS_EVERY_MS) return;
    remember(statusAt, k, now(), 200);
    try {
      await api('assistant.threads.setStatus', { channel_id: channel, thread_ts: thread, status: 'is thinking…' }, { timeoutMs: 10_000, retries: 0 });
    } catch (e) {
      if (STATUS_UNSUPPORTED.has(e.code)) {
        statusOff = true;
        log(`slack: no "is thinking…" status in threads (${e.code})`);
      } else if (!halted()) log(`slack: thinking status failed: ${e.message}`);
    }
  }

  return { start, stop, send, typing };
}
