/**
 * Discord transport for bot chat channels: a Gateway (API v10) connection for
 * inbound messages and the REST API for replies and the typing indicator.
 *
 * Transport only: it knows nothing about bots, pairing or the store. Messages
 * from humans arrive normalised through `onMessage` (the caller decides which
 * ones to answer); `send` splits long replies at Discord's 2000-character limit.
 *
 * - Heartbeats on the Hello interval, the first one jittered. A beat that goes
 *   unacknowledged means a dead connection: the session resumes on a new socket.
 * - Reconnect (op 7), Invalid Session (op 9) and dropped connections resume when
 *   Discord allows it and identify again otherwise, with exponential backoff
 *   (1 s … 60 s) while the network is down.
 * - A bad token (HTTP 401 / close 4004), a missing Message Content intent (4014)
 *   and the other unrecoverable close codes (4010–4013) are fatal: no reconnects.
 * - The token never appears in log lines, thrown errors or status details.
 *
 * @module @kadaliao/dsh-bots/lib/channels/discord
 */

export const kind = 'discord';
export const TEXT_LIMIT = 2000;

/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

const API_BASE = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/kadaliao/dsh-plugins, 0.4)';
const GATEWAY_QUERY = '/?v=10&encoding=json';
const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 60_000;
const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT = 60_000;
/** Any close code but 1000/1001 keeps the session resumable. */
const RESUME_CLOSE = 4000;
const FENCE = '```';
const CLOSE_FENCE = `\n${FENCE}`;

const INVALID_TOKEN = 'Discord rejected the bot token (invalid bot token). Copy it again from the Developer Portal: your app → Bot → Reset Token.';
const FATAL_CLOSE = {
  4004: INVALID_TOKEN,
  4010: 'Discord rejected the connection (close 4010: invalid shard).',
  4011: 'Discord requires sharding for this bot (close 4011): it is in too many servers for one connection.',
  4012: 'Discord rejected the gateway version (close 4012).',
  4013: 'Discord rejected the requested intents (close 4013: invalid intents).',
  4014: 'Discord refused the Message Content intent (close 4014). In the Developer Portal open your app → Bot → Privileged Gateway Intents, turn on Message Content Intent, save, then reconnect the channel.',
};
/** The session is gone: start a new one instead of resuming. */
const REIDENTIFY_CLOSE = new Set([4007, 4009]);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reconnect delay for the n-th consecutive failure (0-based): doubles from 1 s,
 * capped at 60 s, ±20 % jitter.
 * @param {number} attempt
 * @param {() => number} [random]
 */
export function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** Math.max(0, attempt));
  return Math.round(Math.min(MAX_BACKOFF, Math.max(MIN_BACKOFF, base * (0.8 + 0.4 * random()))));
}

/**
 * A `MESSAGE_CREATE` payload as a channel message, or null when it is not a
 * human's text message (bots, webhooks, the bot itself, system messages, empty).
 * @param {object} d the event payload
 * @param {string} botId the bot's own user id
 * @param {string[]} [botRoleIds] the bot's managed role in this guild (people often @ the role by mistake)
 */
export function normalizeMessage(d, botId, botRoleIds = []) {
  const author = d?.author;
  if (!author?.id || !botId) return null;
  if (author.bot || author.system || d.webhook_id || author.id === botId) return null;
  if (d.type != null && d.type !== 0 && d.type !== 19) return null; // default and reply only
  const raw = typeof d.content === 'string' ? d.content : '';
  if (!raw.trim()) return null;
  const isDirect = !d.guild_id;
  const roles = (botRoleIds ?? []).map(String);
  const mentioned = isDirect
    || (Array.isArray(d.mentions) && d.mentions.some((u) => u?.id === botId))
    || d.referenced_message?.author?.id === botId
    || (Array.isArray(d.mention_roles) && d.mention_roles.some((r) => roles.includes(String(r))))
    || raw.includes(`<@${botId}>`) || raw.includes(`<@!${botId}>`);
  let text = raw.replace(new RegExp(`<@!?${escapeRe(botId)}>\\s*`, 'g'), '');
  if (roles.length) text = text.replace(new RegExp(`<@&(?:${roles.map(escapeRe).join('|')})>\\s*`, 'g'), '');
  text = text.trim();
  if (!text) return null;
  return {
    chatId: String(d.channel_id),
    messageId: String(d.id),
    userId: String(author.id),
    userName: String(d.member?.nick ?? author.global_name ?? author.username ?? author.id),
    text,
    isDirect,
    mentioned,
  };
}

/** Whether `s` ends inside a ``` block, where that block opened, and its language tag. */
function fenceState(s) {
  let open = false;
  let at = -1;
  let lang = '';
  for (let i = s.indexOf(FENCE); i !== -1; i = s.indexOf(FENCE, i + FENCE.length)) {
    open = !open;
    if (open) {
      at = i;
      lang = /^([\w+#.-]{1,16})?(?=\n|$)/.exec(s.slice(i + FENCE.length, i + FENCE.length + 18))?.[1] ?? '';
    }
  }
  return { open, at, lang };
}

/** Where to cut `s` so the head is at most `budget` long: a late newline, a late space, any newline, any space, or a hard cut. */
function cutPoint(s, budget) {
  const win = s.slice(0, budget + 1); // a separator right at the budget is dropped, so it may sit there
  const half = budget / 2;
  const nl = win.lastIndexOf('\n');
  const sp = win.lastIndexOf(' ');
  if (nl >= half) return { cut: nl, skip: 1 };
  if (sp >= half) return { cut: sp, skip: 1 };
  if (nl > 0) return { cut: nl, skip: 1 };
  if (sp > 0) return { cut: sp, skip: 1 };
  let cut = Math.max(1, budget);
  const code = s.charCodeAt(cut - 1);
  if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut -= 1; // don't split a surrogate pair
  return { cut, skip: 0 };
}

/**
 * Split a reply into Discord-sized messages. Cuts prefer the last newline, then
 * the last space; a cut inside a ``` block closes it at the end of the chunk
 * and reopens it (same language) at the start of the next. Never yields an
 * empty or whitespace-only chunk.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitMessage(text, limit = TEXT_LIMIT) {
  let rest = String(text ?? '').replace(/\r\n?/g, '\n');
  const out = [];
  let reopen = '';
  while (rest) {
    if (!reopen) rest = rest.replace(/^\n+/, '');
    if (!rest) break;
    if (reopen.length + rest.length <= limit) {
      if (rest.trim()) out.push(reopen + rest.trimEnd());
      break;
    }
    const budget = Math.max(1, limit - reopen.length - CLOSE_FENCE.length);
    let { cut, skip } = cutPoint(rest, budget);
    let chunk = reopen + rest.slice(0, cut);
    let fence = fenceState(chunk);
    if (fence.open && fence.at > reopen.length && !chunk.slice(fence.at + FENCE.length + fence.lang.length).trim()) {
      // The chunk would end on a bare opening fence: start the next one with it instead.
      cut = fence.at - reopen.length;
      skip = 0;
      chunk = reopen + rest.slice(0, cut);
      fence = fenceState(chunk);
    }
    if (chunk.slice(reopen.length).trim()) out.push(fence.open ? `${chunk.trimEnd()}${CLOSE_FENCE}` : chunk.trimEnd());
    reopen = fence.open ? `${FENCE}${fence.lang}\n` : '';
    rest = rest.slice(cut + skip);
  }
  return out;
}

/** Seconds to wait from a 429 (JSON `retry_after` or the `Retry-After` header), in ms. */
function retryAfterMs(data, headers) {
  const sec = Number(data?.retry_after ?? headers?.get?.('retry-after'));
  return Number.isFinite(sec) && sec >= 0 ? Math.min(MAX_RETRY_WAIT, Math.ceil(sec * 1000)) : 1000;
}

async function readJson(res) {
  try {
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} ChannelMessage
 * @property {string} chatId
 * @property {string} messageId
 * @property {string} userId
 * @property {string} userName
 * @property {string} text the bot's own mention removed, trimmed
 * @property {boolean} isDirect a 1:1 DM with the bot
 * @property {boolean} mentioned @mentioned or replied to; always true in a DM
 * @property {string} [chatTitle] `Server #channel`, when the channel is known
 */

/**
 * @param {object} opts
 * @param {string} opts.token the bot token (a pasted `Bot ` prefix is dropped)
 * @param {(msg: ChannelMessage) => void} opts.onMessage
 * @param {(s: { state: 'connecting'|'connected'|'error'|'stopped', detail?: string, fatal?: boolean }) => void} [opts.onStatus]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 * @param {string} [opts.apiBase]
 * @param {(line: string) => void} [opts.log]
 * @param {typeof setTimeout} [opts.setTimeoutImpl] for tests
 * @param {typeof clearTimeout} [opts.clearTimeoutImpl] for tests
 * @param {() => number} [opts.random] for tests (heartbeat and backoff jitter)
 */
export function createConnector(opts = {}) {
  const {
    onMessage = () => {},
    onStatus,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    log: logImpl,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    random = Math.random,
  } = opts;
  const token = String(opts.token ?? '').trim().replace(/^Bot\s+/i, '');
  const apiBase = String(opts.apiBase || API_BASE).replace(/\/+$/, '');

  /** Belt and braces: no string leaves this module with the token in it. */
  const scrub = (v) => {
    const s = String(v ?? '');
    return token.length >= 8 ? s.split(token).join('[token]') : s;
  };
  const log = (line) => {
    try { logImpl?.(scrub(line)); } catch { /* a broken logger must not break the connection */ }
  };
  const status = (state, detail, fatal = false) => {
    const s = { state };
    if (detail) s.detail = scrub(detail);
    if (state === 'error') s.fatal = fatal;
    try { onStatus?.(s); } catch (e) { log(`discord: onStatus threw: ${e?.message ?? e}`); }
  };
  const guard = (fn) => (...args) => {
    try { fn(...args); } catch (e) { log(`discord: ${e?.message ?? e}`); }
  };

  // --- REST ---------------------------------------------------------------------------

  const sleepers = new Set();
  const sleep = (ms) => new Promise((resolve, reject) => {
    const entry = { reject };
    entry.timer = setTimeoutImpl(() => { sleepers.delete(entry); resolve(); }, ms);
    sleepers.add(entry);
  });

  async function api(method, path, body, retries = RATE_LIMIT_RETRIES) {
    const headers = { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(`${apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        throw new Error(scrub(`Discord ${method} ${path} failed: ${e?.message ?? e}`));
      }
      const data = await readJson(res);
      if (res.status === 429 && attempt < retries) {
        const wait = retryAfterMs(data, res.headers);
        log(`discord: rate limited on ${method} ${path}, retrying in ${wait} ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const why = [data?.message, data?.code ? `(code ${data.code})` : ''].filter(Boolean).join(' ');
        const err = new Error(scrub(`Discord ${method} ${path} failed: HTTP ${res.status}${why ? ` ${why}` : ''}`));
        err.status = res.status;
        if (data?.code) err.code = data.code;
        throw err;
      }
      return data;
    }
  }

  async function gatewayBase() {
    let data;
    try {
      data = await api('GET', '/gateway/bot', undefined, 0);
    } catch (e) {
      if (e.status === 401) throw Object.assign(new Error(INVALID_TOKEN), { fatal: true });
      throw e;
    }
    if (typeof data?.url !== 'string' || !/^wss?:\/\//.test(data.url)) throw new Error('Discord returned no gateway URL');
    if (data.session_start_limit?.remaining === 0) log('discord: daily session start limit reached; Discord may refuse to identify until it resets');
    return data.url;
  }

  // --- Gateway ------------------------------------------------------------------------

  let ws = null;
  let gatewayUrl = '';
  let resumeUrl = '';
  let sessionId = '';
  let seq = null;
  let me = null;
  let attempts = 0;
  let healthy = false;
  let stopped = false;
  let dead = false;
  let startPromise = null;
  let pending = null;
  let hbTimer = null;
  let acked = true;
  let reconnectTimer = null;
  const guildNames = new Map();
  const channels = new Map(); // id → { guildId, name }
  const botRoles = new Map(); // guild id → the bot's managed role ids

  const halted = () => stopped || dead;
  const cancel = (h) => { if (h != null) clearTimeoutImpl(h); };

  function sendFrame(sock, frame) {
    try { sock.send(JSON.stringify(frame)); } catch (e) { log(`discord: could not send op ${frame.op}: ${e?.message ?? e}`); }
  }
  const identifyFrame = () => ({ op: 2, d: { token, intents: INTENTS, properties: { os: process.platform, browser: 'dsh-bots', device: 'dsh-bots' } } });
  const resumeFrame = () => ({ op: 6, d: { token, session_id: sessionId, seq } });

  function stopHeartbeat() {
    cancel(hbTimer);
    hbTimer = null;
  }

  function startHeartbeat(sock, interval) {
    stopHeartbeat();
    acked = true;
    const beat = guard(() => {
      hbTimer = null;
      if (sock !== ws) return;
      if (!acked) return reconnectSoon('resume', 0, 'heartbeat not acknowledged; resuming on a new connection');
      acked = false;
      sendFrame(sock, { op: 1, d: seq });
      hbTimer = setTimeoutImpl(beat, interval);
    });
    hbTimer = setTimeoutImpl(beat, Math.round(interval * random()));
  }

  /** Forget the current socket (its events are ignored from now on) and close it. */
  function detach(code) {
    const sock = ws;
    ws = null;
    stopHeartbeat();
    if (sock) try { sock.close(code); } catch { /* already closed */ }
  }

  function schedule(mode, delay) {
    cancel(reconnectTimer);
    reconnectTimer = setTimeoutImpl(guard(() => { reconnectTimer = null; run(mode); }), delay);
  }

  /** Discord asked for it (op 7 / op 9) or the socket went quiet: reconnect without backoff. */
  function reconnectSoon(mode, delay, why) {
    log(`discord: ${why}`);
    detach(RESUME_CLOSE);
    schedule(mode, delay);
  }

  /** Something failed: reconnect with backoff. The first drop after a good connection reads as `connecting`, repeats as `error`. */
  function retry(why, mode) {
    detach(RESUME_CLOSE);
    const delay = backoffDelay(attempts, random);
    attempts += 1;
    const detail = `${why}; reconnecting in ${Math.max(1, Math.round(delay / 1000))} s`;
    log(`discord: ${detail}`);
    status(healthy ? 'connecting' : 'error', detail);
    healthy = false;
    schedule(mode, delay);
  }

  function fail(detail) {
    if (halted()) return;
    dead = true;
    cancel(reconnectTimer);
    reconnectTimer = null;
    detach(1000);
    log(`discord: ${detail}`);
    status('error', detail, true);
    if (pending) {
      const err = Object.assign(new Error(scrub(detail)), { fatal: true });
      pending.reject(err);
      pending = null;
    }
  }

  function connected(detail) {
    attempts = 0;
    healthy = true;
    status('connected', detail);
    if (pending && me) {
      pending.resolve({ ...me });
      pending = null;
    }
  }

  const run = (mode) => { open(mode).catch((e) => log(`discord: ${e?.message ?? e}`)); };

  async function open(mode) {
    if (halted()) return;
    if (mode === 'resume' && !(sessionId && resumeUrl)) mode = 'identify';
    status('connecting', mode === 'resume' ? 'Resuming the Discord session' : 'Connecting to Discord');
    let base = mode === 'resume' ? resumeUrl : gatewayUrl;
    if (!base) {
      try {
        base = gatewayUrl = await gatewayBase();
      } catch (e) {
        if (halted()) return;
        if (e.fatal) return fail(e.message);
        return retry(e.message, 'identify');
      }
      if (halted()) return;
    }
    let sock;
    try {
      sock = new WebSocketImpl(`${base.replace(/\/+$/, '')}${GATEWAY_QUERY}`);
    } catch (e) {
      return retry(`Could not open the Discord gateway: ${e?.message ?? e}`, mode);
    }
    ws = sock;
    sock.addEventListener('message', guard((ev) => onFrame(sock, mode, ev?.data)));
    sock.addEventListener('close', guard((ev) => onClose(sock, ev?.code, ev?.reason)));
    sock.addEventListener('error', guard(() => { if (sock === ws) log('discord: gateway socket error'); }));
  }

  function onFrame(sock, mode, data) {
    if (sock !== ws) return;
    let p;
    try {
      p = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return log('discord: ignored an unreadable gateway frame');
    }
    if (typeof p?.s === 'number') seq = p.s;
    switch (p?.op) {
      case 0: return dispatch(p.t, p.d);
      case 1: return sendFrame(sock, { op: 1, d: seq });
      case 7: return reconnectSoon('resume', 0, 'Discord asked to reconnect; resuming');
      case 9: return invalidSession(p.d === true);
      case 10:
        startHeartbeat(sock, Number(p.d?.heartbeat_interval) || 41_250);
        return sendFrame(sock, mode === 'resume' ? resumeFrame() : identifyFrame());
      case 11:
        acked = true;
        return undefined;
      default: return undefined;
    }
  }

  function invalidSession(resumable) {
    if (resumable && sessionId) return reconnectSoon('resume', 0, 'Discord invalidated the session; resuming');
    sessionId = '';
    resumeUrl = '';
    seq = null;
    return reconnectSoon('identify', Math.round(1000 + random() * 4000), 'Discord invalidated the session; identifying again');
  }

  function onClose(sock, code, reason) {
    if (sock !== ws) return;
    ws = null;
    stopHeartbeat();
    if (halted()) return;
    if (FATAL_CLOSE[code]) return fail(FATAL_CLOSE[code]);
    if (REIDENTIFY_CLOSE.has(code)) {
      sessionId = '';
      resumeUrl = '';
      seq = null;
      return retry(`Discord ended the session (close ${code})`, 'identify');
    }
    return retry(`Discord connection closed (${code ?? 'no code'}${reason ? `: ${reason}` : ''})`, 'resume');
  }

  function rememberChannel(c, guildId = c?.guild_id) {
    if (c?.id && c.name && guildId) channels.set(c.id, { guildId, name: c.name });
  }
  function rememberGuild(g) {
    if (!g?.id || g.unavailable) return;
    if (g.name) guildNames.set(g.id, g.name);
    for (const c of g.channels ?? []) rememberChannel(c, g.id);
    for (const c of g.threads ?? []) rememberChannel(c, g.id);
    if (Array.isArray(g.roles) && me) botRoles.set(g.id, g.roles.filter((r) => r?.tags?.bot_id === me.id).map((r) => r.id));
  }
  function forgetGuild(id) {
    guildNames.delete(id);
    botRoles.delete(id);
    for (const [cid, c] of channels) if (c.guildId === id) channels.delete(cid);
  }
  function titleOf(channelId) {
    const c = channels.get(channelId);
    if (!c) return undefined;
    const g = guildNames.get(c.guildId);
    return g ? `${g} #${c.name}` : `#${c.name}`;
  }

  function deliver(d) {
    if (!me) return;
    const msg = normalizeMessage(d, me.id, botRoles.get(d?.guild_id));
    if (!msg) return;
    const title = msg.isDirect ? undefined : titleOf(msg.chatId);
    if (title) msg.chatTitle = title;
    try {
      const r = onMessage(msg);
      if (r && typeof r.catch === 'function') r.catch((e) => log(`discord: onMessage failed: ${e?.message ?? e}`));
    } catch (e) {
      log(`discord: onMessage threw: ${e?.message ?? e}`);
    }
  }

  function dispatch(t, d) {
    switch (t) {
      case 'READY': {
        sessionId = String(d?.session_id ?? '');
        resumeUrl = String(d?.resume_gateway_url ?? '');
        const u = d?.user ?? {};
        me = { id: String(u.id ?? ''), username: String(u.username ?? ''), name: String(u.global_name || u.username || '') };
        return connected(`Signed in as ${me.username}`);
      }
      case 'RESUMED': return connected(me ? `Signed in as ${me.username}` : 'Session resumed');
      case 'MESSAGE_CREATE': return deliver(d);
      case 'GUILD_CREATE':
      case 'GUILD_UPDATE': return rememberGuild(d);
      case 'GUILD_DELETE': return d?.unavailable ? undefined : forgetGuild(d?.id);
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE': return rememberChannel(d);
      case 'CHANNEL_DELETE':
      case 'THREAD_DELETE': return void channels.delete(d?.id);
      default: return undefined;
    }
  }

  // --- Public -------------------------------------------------------------------------

  /** Connect and resolve with the bot's identity once Discord says READY. Transient failures keep retrying; fatal ones reject. */
  function start() {
    if (stopped) return Promise.reject(new Error('This Discord connector is stopped; create a new one'));
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => { pending = { resolve, reject }; });
    startPromise.catch(() => {}); // the caller may not await it; a fatal error is also reported through onStatus
    if (!token) fail('No Discord bot token. Paste the token from the Developer Portal: your app → Bot.');
    else if (typeof WebSocketImpl !== 'function') fail('This runtime has no WebSocket');
    else if (typeof fetchImpl !== 'function') fail('This runtime has no fetch');
    else run('identify');
    return startPromise;
  }

  /** Close the connection for good: no reconnects, no timers, pending rate-limit waits are cancelled. */
  async function stop() {
    if (stopped) return;
    stopped = true;
    cancel(reconnectTimer);
    reconnectTimer = null;
    detach(1000);
    for (const s of sleepers) {
      clearTimeoutImpl(s.timer);
      s.reject(new Error('Discord connector stopped'));
    }
    sleepers.clear();
    if (pending) {
      pending.reject(new Error('Discord connector stopped before it connected'));
      pending = null;
    }
    status('stopped');
  }

  /** Post `text` to a channel, split at the 2000-character limit; `replyTo` threads the first chunk under that message. */
  async function send(chatId, text, sendOpts = {}) {
    if (stopped) throw new Error('Discord connector is stopped');
    const path = `/channels/${encodeURIComponent(String(chatId))}/messages`;
    const chunks = splitMessage(text);
    for (let i = 0; i < chunks.length; i += 1) {
      const body = { content: chunks[i], allowed_mentions: { parse: [] } };
      if (i === 0 && sendOpts?.replyTo) body.message_reference = { message_id: String(sendOpts.replyTo), fail_if_not_exists: false };
      await api('POST', path, body);
    }
  }

  /** Show "bot is typing…" for about ten seconds. Failures are logged and ignored. */
  async function typing(chatId) {
    if (stopped) return;
    try {
      await api('POST', `/channels/${encodeURIComponent(String(chatId))}/typing`, undefined, 0);
    } catch (e) {
      log(`discord: typing indicator failed: ${e?.message ?? e}`);
    }
  }

  return { start, stop, send, typing };
}
