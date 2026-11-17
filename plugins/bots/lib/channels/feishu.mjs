/**
 * Feishu / Lark transport for chat channels: events over Feishu's long
 * connection (the WebSocket protocol the official SDK's WSClient speaks), and
 * the Open API with a tenant_access_token for replies and lookups.
 *
 * Transport only: it knows nothing about bots, pairing or the store
 * (lib/channels.mjs decides what a message means).
 *
 * - Long connection: POST {base}/callback/ws/endpoint with the App ID and App
 *   Secret answers a wss URL and a ClientConfig (ping interval). Frames are
 *   protobuf `pbbp2.Frame`, encoded by hand below: method 0 is control
 *   (ping / pong), method 1 is data (an event as JSON, possibly split over
 *   several frames by the `sum` / `seq` headers). A complete event is acked at
 *   once with a response frame (`{"code":200}`); Feishu pushes again what is
 *   not acked within 3 s. No public URL is needed, and events arrive as plain
 *   JSON (the channel itself is encrypted).
 * - Feishu (open.feishu.cn) and Lark (open.larksuite.com) apps have the same
 *   App ID format. The App ID is first looked up on Feishu with a dummy secret;
 *   when Feishu does not know it the app is a Lark app, so a Lark app's secret
 *   is only ever sent to Lark. Messages from Lark carry `source: 'Lark'`.
 * - Replies are `post` messages holding one `md` element (CommonMark + GFM),
 *   hence `MARKDOWN`; in a group the first part answers the person's message.
 * - Threads: `threadId` on a message is the `message_id` of the root of the
 *   conversation it is in: `root_id` for a reply (a reply chain, or a reply in
 *   a topic: Feishu points both at the root), or the message itself when it
 *   opens a topic (`thread_id` and no `root_id`, as in a topic group). The
 *   root's id, not the topic's `omt_` id, because only a message can be
 *   answered, and a chain the bot's reply turns into a topic keeps its root.
 *   A message that answers nothing and opens no topic has none.
 *   `send(…, {threadId})` answers that root with every part, so the parts land
 *   in its topic, or join its reply chain; `reply_in_thread` is not forced, so
 *   a chain is not turned into a topic. With `replyTo` as well, the first part
 *   answers `replyTo` (which stays in the same topic or chain). A recalled
 *   `replyTo` falls back to the root, a recalled root to the chat.
 * - Feishu delivers a message twice now and then; duplicates are dropped by
 *   message_id, and `order` (the message's create_time in ms, rising within a
 *   chat) feeds the hub's replay guard across restarts.
 * - Feishu has no typing indicator for bots: a "Typing" reaction on the
 *   person's message stands in while the bot works and goes away when the
 *   reply is sent or the work stops.
 * - The App Secret, tenant tokens and the connection URL (it carries a ticket)
 *   never appear in log lines, errors or statuses.
 *
 * `apiBase` defaults to `BOTS_FEISHU_API` or https://open.feishu.cn, and
 * `larkApiBase` to `BOTS_LARK_API` or https://open.larksuite.com; with a custom
 * Feishu base and no Lark base there is no Lark fallback, so test credentials
 * never reach a real server.
 *
 * @module @kadaliao/dsh-bots/lib/channels/feishu
 */

import { randomUUID } from 'node:crypto';
import { redact, splitText, toPlainText } from '../channels.mjs';

export const kind = 'feishu';
export const TEXT_LIMIT = 4000;
export const MARKDOWN = true;

const FEISHU_API = 'https://open.feishu.cn';
const LARK_API = 'https://open.larksuite.com';
/** Post messages may be 30 KB; leave room for Feishu's own accounting. */
const MAX_BODY_BYTES = 28_000;
const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 60_000;
/** How often to look again whether the bot capability is live. */
const BOT_RETRY_MS = 15_000;
const CONN_LIMIT_RETRY_MS = 60_000;
const DEFAULT_PING_MS = 120_000;
const PONG_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 20_000;
/** Fragments of an event that never completes are dropped after this long. */
const FRAGMENT_TTL_MS = 10_000;
/** A name lookup must not hold a message up for long. */
const LOOKUP_TIMEOUT_MS = 4000;
const NAME_TTL_MS = 6 * 3600_000;
const LOOKUP_RETRY_MS = 10 * 60_000;
const LOOKUP_OFF_MS = 30 * 60_000;
/** The hub asks for "typing" every ~5 s while a bot works; silence this long means it stopped. */
const TYPING_IDLE_MS = 15_000;
/** Only a person's recent message gets the "Typing" reaction. */
const TYPING_FRESH_MS = 2 * 60_000;
/** Sent in place of the App Secret to learn whether Feishu knows the App ID. */
const PROBE_SECRET = 'dsh-bots-domain-probe';

const TOKEN_CODES = new Set([99991661, 99991663, 99991664, 99991665, 99991671]);
const RATE_CODES = new Set([99991400, 230020]);
const SCOPE_CODES = new Set([99991672, 99991679, 230027]);
/** The message being answered is gone: post to the chat instead. */
const REPLY_GONE = new Set([230011, 230019, 230110, 231003]);
/** Feishu would not take the reply as Markdown: send it as plain text instead. */
const POST_REJECTED = new Set([230001, 230025]);

/** App IDs that turned out to be Lark apps, for `links`. */
const larkApps = new Set();

const enc = new TextEncoder();
const dec = new TextDecoder();
const trimSlash = (s) => String(s).replace(/\/+$/, '');
const secs = (ms) => Math.max(1, Math.round(ms / 1000));

/**
 * Reconnect delay for the n-th consecutive failure (0-based): doubles from 1 s,
 * capped at 60 s, ±20 % jitter.
 */
export function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** Math.max(0, attempt));
  return Math.round(Math.min(MAX_BACKOFF, Math.max(MIN_BACKOFF, base * (0.8 + 0.4 * random()))));
}

// --- pbbp2.Frame ------------------------------------------------------------------------
//
// message Header { required string key = 1; required string value = 2; }
// message Frame {
//   required uint64 SeqID = 1; required uint64 LogID = 2;
//   required int32 service = 3; required int32 method = 4;
//   repeated Header headers = 5;
//   optional string payloadEncoding = 6; optional string payloadType = 7;
//   optional bytes payload = 8; optional string LogIDNew = 9;
// }

class Writer {
  constructor() {
    this.chunks = [];
    this.size = 0;
  }
  raw(bytes) {
    this.chunks.push(bytes);
    this.size += bytes.length;
  }
  varint(value) {
    let n = BigInt.asUintN(64, BigInt(value));
    const out = [];
    while (n > 0x7fn) {
      out.push(Number(n & 0x7fn) | 0x80);
      n >>= 7n;
    }
    out.push(Number(n));
    this.raw(Uint8Array.from(out));
  }
  tag(field, wire) {
    this.varint((field << 3) | wire);
  }
  bytes(field, bytes) {
    this.tag(field, 2);
    this.varint(bytes.length);
    this.raw(bytes);
  }
  string(field, s) {
    this.bytes(field, enc.encode(String(s)));
  }
  finish() {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

function reader(buf) {
  let pos = 0;
  const need = (n) => {
    if (pos + n > buf.length) throw new Error('truncated frame');
  };
  const varint = () => {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      need(1);
      const b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return BigInt.asUintN(64, result);
    }
    throw new Error('malformed varint');
  };
  const bytes = () => {
    const n = Number(varint());
    need(n);
    const out = buf.slice(pos, pos + n);
    pos += n;
    return out;
  };
  const skip = (wire) => {
    if (wire === 0) varint();
    else if (wire === 1) (need(8), (pos += 8));
    else if (wire === 2) bytes();
    else if (wire === 5) (need(4), (pos += 4));
    else throw new Error(`unknown wire type ${wire}`);
  };
  return { varint, bytes, skip, done: () => pos >= buf.length };
}

/** A frame object as protobuf bytes. */
export function encodeFrame(f) {
  const w = new Writer();
  w.tag(1, 0);
  w.varint(f.SeqID ?? 0);
  w.tag(2, 0);
  w.varint(f.LogID ?? 0);
  w.tag(3, 0);
  w.varint(f.service ?? 0);
  w.tag(4, 0);
  w.varint(f.method ?? 0);
  for (const h of f.headers ?? []) {
    const hw = new Writer();
    hw.string(1, h.key);
    hw.string(2, h.value);
    w.bytes(5, hw.finish());
  }
  if (f.payloadEncoding != null) w.string(6, f.payloadEncoding);
  if (f.payloadType != null) w.string(7, f.payloadType);
  if (f.payload != null) w.bytes(8, f.payload instanceof Uint8Array ? f.payload : enc.encode(String(f.payload)));
  if (f.LogIDNew != null) w.string(9, f.LogIDNew);
  return w.finish();
}

/** Protobuf bytes as a frame object: SeqID / LogID as BigInt (echoed back exactly in acks). */
export function decodeFrame(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = reader(buf);
  const f = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [] };
  while (!r.done()) {
    const tag = Number(r.varint());
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) f.SeqID = r.varint();
    else if (field === 2 && wire === 0) f.LogID = r.varint();
    else if (field === 3 && wire === 0) f.service = Number(BigInt.asIntN(32, r.varint()));
    else if (field === 4 && wire === 0) f.method = Number(BigInt.asIntN(32, r.varint()));
    else if (field === 5 && wire === 2) {
      const hr = reader(r.bytes());
      const h = { key: '', value: '' };
      while (!hr.done()) {
        const t = Number(hr.varint());
        if (t >>> 3 === 1 && (t & 7) === 2) h.key = dec.decode(hr.bytes());
        else if (t >>> 3 === 2 && (t & 7) === 2) h.value = dec.decode(hr.bytes());
        else hr.skip(t & 7);
      }
      f.headers.push(h);
    } else if (field === 6 && wire === 2) f.payloadEncoding = dec.decode(r.bytes());
    else if (field === 7 && wire === 2) f.payloadType = dec.decode(r.bytes());
    else if (field === 8 && wire === 2) f.payload = r.bytes();
    else if (field === 9 && wire === 2) f.LogIDNew = dec.decode(r.bytes());
    else r.skip(wire);
  }
  return f;
}

const headersOf = (frame) => Object.fromEntries((frame?.headers ?? []).map((h) => [h.key, h.value]));

// --- messages ---------------------------------------------------------------------------

const REMOVED = '\u0000';

/** Text with the removed mentions closed up: "hey @bot, plan it" → "hey, plan it". */
function closeUp(s) {
  return s
    .replace(/(^|\n)[ \t]*\u0000[ \t]*[,，:：]?[ \t]*/g, '$1')
    .replace(/[ \t]*\u0000[ \t]*([,，:：]?)[ \t]*/g, (_, p) => (p ? `${p} ` : ' '))
    .replace(/\u0000/g, '')
    .replace(/^[\s,，:：]+/, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The readable text of a received `post` (either shape: `{title, content}` or one per locale). */
function postText(c, at) {
  const body = c && typeof c === 'object' && !Array.isArray(c.content) ? (c.zh_cn ?? c.en_us ?? c.ja_jp ?? Object.values(c).find((v) => v && Array.isArray(v.content))) : c;
  const lines = [];
  if (typeof body?.title === 'string' && body.title.trim()) lines.push(body.title.trim());
  for (const para of Array.isArray(body?.content) ? body.content : []) {
    let line = '';
    for (const el of Array.isArray(para) ? para : []) {
      const text = typeof el?.text === 'string' ? el.text : '';
      switch (el?.tag) {
        case 'text':
        case 'md':
          line += text;
          break;
        case 'a': {
          const href = typeof el.href === 'string' ? el.href : '';
          line += !href || text === href ? text || href : text ? `${text} (${href})` : href;
          break;
        }
        case 'at':
          line += at(String(el.user_id ?? ''), el.user_name);
          break;
        case 'code_block':
          line += `\n\`\`\`${String(el.language ?? '').toLowerCase()}\n${text}\n\`\`\`\n`;
          break;
        case 'emotion':
          line += el.emoji_type ? `[${el.emoji_type}]` : '';
          break;
        case 'hr':
          line += '\n---\n';
          break;
        default:
          break; // images and video: nothing to read
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * An `im.message.receive_v1` event as a channel message (without `userName`,
 * which takes a lookup), or null when it is not a person's text or post.
 * In a group, `mentioned` means the bot's own open_id is among the mentions
 * (with no open_id known yet: any bot mention), or the message replies to one
 * the bot sent. The bot's `@_user_N` placeholder is removed, other people's
 * become `@Name`. `threadId` is the root message of the reply chain or topic
 * the message is in (its own id when it opens a topic), absent otherwise.
 * @param {object} event the event body (`sender`, `message`)
 * @param {{botOpenId?: string, sentIds?: {has(id: string): boolean}}} [me]
 */
export function normalizeEvent(event, { botOpenId = '', sentIds } = {}) {
  const m = event?.message;
  const s = event?.sender;
  if (!m || !s || s.sender_type !== 'user') return null;
  const userId = String(s.sender_id?.open_id ?? '');
  if (!userId || userId === botOpenId || !m.chat_id || !m.message_id) return null;
  let content;
  try {
    content = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
  } catch {
    return null;
  }
  const mentions = new Map((Array.isArray(m.mentions) ? m.mentions : []).map((x) => [String(x?.key ?? ''), x]));
  const isBot = (x) => (botOpenId ? String(x?.id?.open_id ?? '') === botOpenId : x?.mentioned_type === 'bot');
  let mentioned = false;
  const at = (key, fallbackName) => {
    const x = mentions.get(key);
    if (x && isBot(x)) {
      mentioned = true;
      return REMOVED;
    }
    if (key === '@_all' || key === 'all') return '@all';
    const name = String(x?.name ?? fallbackName ?? '').trim();
    return name ? `@${name}` : REMOVED;
  };
  let raw;
  if (m.message_type === 'text') raw = String(content?.text ?? '').replace(/@_user_\d+|@_all/g, (key) => at(key));
  else if (m.message_type === 'post') raw = postText(content, at);
  else return null;
  const text = closeUp(raw);
  if (!text) return null;
  const isDirect = m.chat_type === 'p2p';
  if (!isDirect && m.parent_id && sentIds?.has(String(m.parent_id))) mentioned = true;
  const created = String(m.create_time ?? '');
  // A reply (in a chain or a topic) names its root; a topic's first message is its own root.
  const threadId = String(m.root_id || m.parent_id || (m.thread_id ? m.message_id : ''));
  return {
    chatId: String(m.chat_id),
    messageId: String(m.message_id),
    ...(/^\d{1,30}$/.test(created) ? { order: created } : {}),
    userId,
    text,
    isDirect,
    mentioned: isDirect || mentioned,
    ...(threadId ? { threadId } : {}),
  };
}

/** Model Markdown made safe for a Feishu `md` element: no mentions (least of all @all), remote images as links. */
function safeMarkdown(md) {
  return String(md)
    .replace(/<(\/?)at\b/gi, '<$1​at')
    .replace(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (_, alt, url) => `[${alt || url}](${url})`);
}

const postBody = (md) => ({ msg_type: 'post', content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: safeMarkdown(md) }]] } }) });

/** Reply parts of at most TEXT_LIMIT characters whose request body stays under the 30 KB post limit. */
function partsOf(text) {
  const out = [];
  const queue = splitText(text, TEXT_LIMIT);
  while (queue.length) {
    const part = queue.shift();
    if (part.length < 400 || Buffer.byteLength(JSON.stringify(postBody(part))) <= MAX_BODY_BYTES) out.push(part);
    else queue.unshift(...splitText(part, Math.floor(part.length / 2)));
  }
  return out;
}

/** Remember `id` in an insertion-ordered set of at most `max` entries. */
function remember(set, id, max) {
  set.delete(id);
  set.add(id);
  if (set.size > max) set.delete(set.values().next().value);
}

// --- panel links ------------------------------------------------------------------------

/** "Open in Feishu": the AppLink that opens a chat with the bot. */
export function links({ values } = {}) {
  const appId = String(values?.appId ?? '').trim();
  if (!/^cli_[A-Za-z0-9]+$/.test(appId)) return {};
  const host = larkApps.has(appId) ? 'applink.larksuite.com' : 'applink.feishu.cn';
  return { link: `https://${host}/client/bot/open?appId=${appId}` };
}

// --- the connector ----------------------------------------------------------------------

/**
 * @param {{
 *   token?: string,                                  // the App Secret (the app's first secret field)
 *   values?: {appId?: string, appSecret?: string},
 *   onMessage: (msg: object) => void,
 *   onStatus?: (s: {state: 'connecting'|'connected'|'error'|'stopped', detail?: string, fatal?: boolean, hint?: string}) => void,
 *   log?: (line: string) => void,
 *   fetchImpl?: typeof fetch,
 *   WebSocketImpl?: typeof WebSocket,
 *   apiBase?: string,
 *   larkApiBase?: string,
 *   setTimeoutImpl?: typeof setTimeout,              // for tests
 *   clearTimeoutImpl?: typeof clearTimeout,          // for tests
 *   random?: () => number,                           // for tests (backoff jitter)
 *   now?: () => number,                              // for tests
 * }} opts
 */
export function createConnector(opts = {}) {
  const appId = String(opts.values?.appId ?? '').trim();
  const secret = String(opts.values?.appSecret ?? opts.token ?? '').trim();
  const onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : () => {};
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const WebSocketImpl = opts.WebSocketImpl ?? globalThis.WebSocket;
  const setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const customBase = opts.apiBase || process.env.BOTS_FEISHU_API;
  const feishuBase = trimSlash(customBase || FEISHU_API);
  const larkSetting = opts.larkApiBase || process.env.BOTS_LARK_API;
  const larkBase = larkSetting ? trimSlash(larkSetting) : customBase ? '' : LARK_API;

  /** Everything that must never leave this module: the secret, tokens, connection URLs. */
  const hidden = new Set([secret]);
  const clean = (s) => redact(String(s ?? ''), [...hidden]).replace(/(wss?:\/\/[^\s?"']+)\?[^\s"']*/g, '$1?…');
  const log = (line) => {
    try {
      opts.log?.(clean(line));
    } catch {
      // Logging is a convenience.
    }
  };
  const status = (state, detail = '', { fatal = false, hint = '' } = {}) => {
    try {
      opts.onStatus?.({ state, ...(detail ? { detail: clean(detail) } : {}), ...(fatal ? { fatal: true } : {}), ...(hint ? { hint } : {}) });
    } catch {
      // The listener's problem.
    }
  };
  const guard =
    (fn) =>
    (...args) => {
      try {
        const r = fn(...args);
        if (r && typeof r.catch === 'function') r.catch((e) => log(`feishu: ${e?.message ?? e}`));
      } catch (e) {
        log(`feishu: ${e?.message ?? e}`);
      }
    };

  let stopped = false;
  let dead = false;
  let fatalError = null;
  let started = false;
  let startPromise = null;
  let stopping = null;
  /** {base, lark} once the App ID is known on one of them. */
  let domain = null;
  /** {openId, name} of the bot, from bot/v3/info. */
  let me = null;
  let tokenCache = null;
  let tokenFlight = null;
  const halt = new AbortController();
  const halted = () => stopped || dead;
  const label = () => (domain?.lark ? 'Lark' : 'Feishu');
  const stoppedError = () => fatalError ?? new Error('the Feishu connector was stopped');

  // Waits that stop() and fail() cut short.
  const sleepers = new Set();
  const sleep = (ms) =>
    new Promise((resolve) => {
      if (halted()) return resolve();
      const s = { resolve };
      s.timer = setTimeoutImpl(() => {
        sleepers.delete(s);
        resolve();
      }, ms);
      sleepers.add(s);
    });
  const wakeAll = () => {
    for (const s of sleepers) {
      clearTimeoutImpl(s.timer);
      s.resolve();
    }
    sleepers.clear();
  };
  const cancel = (...timers) => {
    for (const t of timers) if (t != null) clearTimeoutImpl(t);
  };

  // --- HTTP -----------------------------------------------------------------------------

  async function http(method, url, { body, token, timeoutMs = 20_000, afterStop = false } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = afterStop ? timeout : AbortSignal.any([halt.signal, timeout]);
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (token) headers.authorization = `Bearer ${token}`;
    const where = new URL(url).pathname;
    let res;
    try {
      res = await fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    } catch (error) {
      const why = error?.name === 'TimeoutError' || timeout.aborted ? 'timed out' : error?.cause?.code ?? error?.cause?.message ?? error?.message ?? 'network error';
      throw Object.assign(new Error(clean(`could not reach ${label()} (${where}: ${why})`)), { network: true });
    }
    let json = null;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers };
  }

  function apiError(what, r) {
    const code = Number(r.json?.code) || 0;
    const msg = String(r.json?.msg ?? r.json?.message ?? `HTTP ${r.status}`);
    return Object.assign(new Error(clean(`${label()} ${what}: ${msg}${code ? ` (code ${code})` : ''}`)), { code, httpStatus: r.status, msg: clean(msg) });
  }

  /** Why a token request failed, classified: unknown App ID, wrong secret, disabled app, or try again. */
  function credentialError(r, lark) {
    const where = lark ? 'Lark' : 'Feishu';
    const code = Number(r.json?.code) || 0;
    const msg = clean(String(r.json?.msg ?? `HTTP ${r.status}`));
    const e = (message, extra) => Object.assign(new Error(message), { code, msg, ...extra });
    if (code === 10014 && /not\s*exist/i.test(msg)) return e(`${where} does not know this App ID (${msg}).`, { notFound: true, fatal: true, hint: 'appId' });
    if (code === 10015) return e(`${where} rejected the App Secret (${msg}). Copy it again from the developer console: your app → Credentials & Basic Info.`, { fatal: true, hint: 'secret' });
    if (code === 10003) return e(`${where} says the App ID or App Secret is malformed (${msg}). Copy both again from the developer console: your app → Credentials & Basic Info.`, { fatal: true, hint: 'appId' });
    if (code === 10014 || code === 99991662 || code === 99991673)
      return e(`${where} will not sign this app in (${msg}, code ${code}). Check in the developer console that the app is enabled.`, { fatal: true, hint: 'disabled' });
    return e(`${where} sign-in failed: ${msg}${code ? ` (code ${code})` : ''}`, {});
  }

  async function requestToken(base, appSecret, lark) {
    const r = await http('POST', `${base}/open-apis/auth/v3/tenant_access_token/internal`, { body: { app_id: appId, app_secret: appSecret }, timeoutMs: 15_000 });
    if (Number(r.json?.code) === 0 && typeof r.json?.tenant_access_token === 'string' && r.json.tenant_access_token) {
      const value = r.json.tenant_access_token;
      hidden.add(value);
      const life = Math.max(60, Number(r.json.expire) || 7200) * 1000;
      // Feishu hands out a fresh token once less than 30 minutes remain; renew 20 minutes before expiry.
      return { value, refreshAt: now() + Math.max(life / 2, life - 20 * 60_000) };
    }
    throw credentialError(r, lark);
  }

  /** The cached tenant_access_token, renewed before it expires (one request at a time). */
  async function tenantToken() {
    if (tokenCache && tokenCache.refreshAt > now()) return tokenCache.value;
    if (!tokenFlight) {
      tokenFlight = requestToken(domain.base, secret, domain.lark)
        .then((t) => {
          tokenCache = t;
          return t.value;
        })
        .catch((e) => {
          // The secret was changed or the app disabled while connected: nothing to retry.
          if (e.fatal) fail(e.message, e.hint);
          throw e;
        })
        .finally(() => {
          tokenFlight = null;
        });
    }
    return tokenFlight;
  }

  /** One Open API call with the tenant token: renews a rejected token once, waits out rate limits, retries network errors. */
  async function api(method, path, body, { retries = 2, what = path } = {}) {
    let renewed = false;
    for (let attempt = 0; ; attempt += 1) {
      if (halted()) throw stoppedError();
      const token = await tenantToken();
      let r;
      try {
        r = await http(method, `${domain.base}${path}`, { body, token });
      } catch (e) {
        if (e.network && attempt < retries && !halted()) {
          await sleep(backoffDelay(attempt, random));
          continue;
        }
        throw e;
      }
      const code = Number(r.json?.code);
      if (code === 0) return r.json;
      if (TOKEN_CODES.has(code) && !renewed) {
        renewed = true;
        tokenCache = null;
        continue;
      }
      if ((RATE_CODES.has(code) || r.status === 429) && attempt < retries + 1) {
        const reset = Number(r.headers?.get?.('x-ogw-ratelimit-reset'));
        await sleep(Number.isFinite(reset) && reset > 0 ? Math.min(30, reset) * 1000 : backoffDelay(attempt, random));
        continue;
      }
      if (r.status >= 500 && attempt < retries) {
        await sleep(backoffDelay(attempt, random));
        continue;
      }
      throw apiError(what, r);
    }
  }

  // --- sign-in --------------------------------------------------------------------------

  /** Find the platform that knows the App ID and get a token there. */
  async function chooseDomain() {
    const feishu = { base: feishuBase, lark: false };
    const lark = larkBase ? { base: larkBase, lark: true } : null;
    let order = [feishu];
    if (lark) {
      let unknown = false;
      try {
        await requestToken(feishu.base, PROBE_SECRET, false);
      } catch (e) {
        if (e.network) throw e;
        unknown = e.notFound === true;
      }
      order = unknown ? [lark] : [feishu, lark];
    }
    for (const d of order) {
      try {
        tokenCache = await requestToken(d.base, secret, d.lark);
        domain = d;
        return;
      } catch (e) {
        if (e.notFound && d !== order.at(-1)) continue;
        if (e.notFound) {
          throw Object.assign(
            new Error(`${lark ? 'Neither Feishu nor Lark knows' : 'Feishu does not know'} this App ID. Copy it again from the developer console: your app → Credentials & Basic Info (it starts with cli_).`),
            { fatal: true, hint: 'appId' },
          );
        }
        throw e;
      }
    }
  }

  async function signIn() {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await chooseDomain();
        return;
      } catch (e) {
        if (halted()) throw stoppedError();
        if (e.fatal) throw e;
        const ms = backoffDelay(attempt, random);
        status('error', `${e.message}; retrying in ${secs(ms)} s`);
        log(`feishu: ${e.message}`);
        await sleep(ms);
        if (halted()) throw stoppedError();
      }
    }
  }

  /** The bot's open_id and name. Until the bot capability is live, says so and looks again every 15 s. */
  async function loadBot() {
    for (let attempt = 0; ; attempt += 1) {
      if (halted()) throw stoppedError();
      try {
        const r = await api('GET', '/open-apis/bot/v3/info', undefined, { retries: 0, what: 'bot info' });
        const b = r?.bot ?? r?.data?.bot ?? {};
        if (b.open_id) {
          me = { openId: String(b.open_id), name: String(b.app_name ?? '').trim() };
          if (b.activate_status !== undefined && b.activate_status !== 2) log(`feishu: the bot's activate_status is ${b.activate_status} (2 = enabled); publish a version if messages do not arrive`);
          return;
        }
        throw Object.assign(new Error(`${label()} bot info: this app has no bot`), { code: -1 });
      } catch (e) {
        if (halted()) throw stoppedError();
        if (e.fatal) throw e;
        if (e.network || e.httpStatus >= 500 || RATE_CODES.has(e.code)) {
          const ms = backoffDelay(attempt, random);
          status('error', `${e.message}; retrying in ${secs(ms)} s`);
          await sleep(ms);
          continue;
        }
        status(
          'error',
          `${e.message}. Turn on the bot: developer console → your app → Add features → Bot, then publish a version (Version Management & Release). The channel connects by itself once that is live.`,
          { hint: 'bot' },
        );
        log(`feishu: ${e.message}; waiting for the bot capability`);
        await sleep(BOT_RETRY_MS);
      }
    }
  }

  // --- long connection ------------------------------------------------------------------

  let ws = null;
  let wsOpen = false;
  let healthy = false;
  let attempts = 0;
  let serviceId = 0;
  let pingMs = DEFAULT_PING_MS;
  let pingTimer = null;
  let pongTimer = null;
  let openTimer = null;
  let reconnectTimer = null;
  let waitOpen = null;
  /** message_id → {parts, got, at}: an event split over several frames */
  const fragments = new Map();

  function applyConfig(cfg) {
    const ping = Number(cfg?.PingInterval);
    if (Number.isFinite(ping) && ping > 0) pingMs = Math.min(600_000, Math.max(10_000, ping * 1000));
  }

  /** The wss URL of a new connection. Errors carry `fatal` (credentials) or `retryMs`. */
  async function endpoint() {
    const r = await http('POST', `${domain.base}/callback/ws/endpoint`, { body: { AppID: appId, AppSecret: secret }, timeoutMs: 15_000 });
    const code = Number(r.json?.code);
    const url = r.json?.data?.URL;
    if (code === 0 && typeof url === 'string' && /^wss?:\/\//.test(url)) {
      hidden.add(url);
      try {
        serviceId = Number(new URL(url).searchParams.get('service_id')) || 0;
      } catch {
        serviceId = 0;
      }
      applyConfig(r.json.data.ClientConfig);
      return url;
    }
    const msg = clean(String(r.json?.msg ?? `HTTP ${r.status}`));
    if (code === 1000040345 || code === 514) {
      throw Object.assign(new Error(`${label()} rejected the App ID or App Secret for the long connection (${msg}). Copy both again from the developer console: your app → Credentials & Basic Info.`), { fatal: true, hint: 'secret' });
    }
    if (code === 1000040350) {
      throw Object.assign(new Error(`${label()} refused another long connection for this app (${msg}): it allows 50. Stop other programs that use this App ID.`), { retryMs: CONN_LIMIT_RETRY_MS, hint: 'connlimit' });
    }
    throw Object.assign(new Error(`${label()} long connection: ${msg}${code ? ` (code ${code})` : ''}`), code === 403 ? { retryMs: CONN_LIMIT_RETRY_MS } : {});
  }

  function detach() {
    const sock = ws;
    ws = null;
    wsOpen = false;
    cancel(pingTimer, pongTimer, openTimer);
    pingTimer = pongTimer = openTimer = null;
    if (sock) {
      try {
        sock.close(1000);
      } catch {
        // Already closed.
      }
    }
  }

  /** Something failed: reconnect with backoff. The first drop after a good connection reads as `connecting`, repeats as `error`. */
  function retry(why, minDelay = 0, hint = '') {
    detach();
    if (halted()) return;
    const delay = Math.max(minDelay, backoffDelay(attempts, random));
    attempts += 1;
    const detail = `${why}; reconnecting in ${secs(delay)} s`;
    log(`feishu: ${detail}`);
    status(healthy ? 'connecting' : 'error', detail, { hint });
    healthy = false;
    cancel(reconnectTimer);
    reconnectTimer = setTimeoutImpl(
      guard(() => {
        reconnectTimer = null;
        openSocket();
      }),
      delay,
    );
  }

  /** Unrecoverable: no reconnects. Rejects a pending start. */
  function fail(detail, hint = '') {
    if (halted()) return;
    dead = true;
    fatalError = Object.assign(new Error(clean(detail)), { fatal: true, ...(hint ? { hint } : {}) });
    cancel(reconnectTimer);
    reconnectTimer = null;
    detach();
    wakeAll();
    log(`feishu: ${detail}`);
    status('error', detail, { fatal: true, hint });
    if (waitOpen) {
      waitOpen.reject(fatalError);
      waitOpen = null;
    }
  }

  async function openSocket() {
    if (halted()) return;
    let url;
    try {
      url = await endpoint();
    } catch (e) {
      if (halted()) return;
      if (e.fatal) return fail(e.message, e.hint);
      return retry(e.message, e.retryMs ?? 0, e.hint ?? '');
    }
    if (halted()) return;
    let sock;
    try {
      sock = new WebSocketImpl(url);
    } catch (e) {
      return retry(`could not open the ${label()} connection: ${e?.message ?? e}`);
    }
    try {
      sock.binaryType = 'arraybuffer';
    } catch {
      // Not every implementation lets it be set.
    }
    ws = sock;
    openTimer = setTimeoutImpl(
      guard(() => {
        if (sock === ws && !wsOpen) retry(`the ${label()} connection did not open within ${secs(OPEN_TIMEOUT_MS)} s`);
      }),
      OPEN_TIMEOUT_MS,
    );
    sock.addEventListener('open', guard(() => onOpen(sock)));
    sock.addEventListener('message', guard((ev) => onData(sock, ev?.data)));
    sock.addEventListener('close', guard((ev) => onClose(sock, ev)));
    sock.addEventListener('error', guard(() => {
      if (sock === ws) log('feishu: connection error');
    }));
  }

  function onOpen(sock) {
    if (sock !== ws) return;
    cancel(openTimer);
    openTimer = null;
    wsOpen = true;
    attempts = 0;
    healthy = true;
    if (started) status('connected');
    if (waitOpen) {
      waitOpen.resolve();
      waitOpen = null;
    }
    ping(sock);
  }

  function sendFrame(sock, frame) {
    try {
      sock.send(encodeFrame(frame));
    } catch (e) {
      log(`feishu: could not send a frame: ${e?.message ?? e}`);
    }
  }

  function ping(sock) {
    if (sock !== ws || !wsOpen) return;
    sendFrame(sock, { SeqID: 0, LogID: 0, service: serviceId, method: 0, headers: [{ key: 'type', value: 'ping' }] });
    // Armed by the first unanswered ping and cleared by any frame; a later ping does not push it back.
    pongTimer ??= setTimeoutImpl(
      guard(() => {
        pongTimer = null;
        if (sock === ws) retry(`${label()} did not answer a ping within ${secs(PONG_TIMEOUT_MS)} s`);
      }),
      PONG_TIMEOUT_MS,
    );
    cancel(pingTimer);
    pingTimer = setTimeoutImpl(guard(() => ping(sock)), pingMs);
  }

  function onClose(sock, ev) {
    if (sock !== ws) return;
    ws = null;
    wsOpen = false;
    cancel(pingTimer, pongTimer, openTimer);
    pingTimer = pongTimer = openTimer = null;
    if (halted()) return;
    const code = ev?.code;
    retry(`${label()} closed the connection (${code ?? 'no code'}${ev?.reason ? `: ${clean(ev.reason)}` : ''})`);
  }

  async function onData(sock, data) {
    if (sock !== ws) return;
    let bytes;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data && typeof data.arrayBuffer === 'function') bytes = new Uint8Array(await data.arrayBuffer());
    else return;
    if (sock !== ws) return;
    // Any frame proves the connection is alive.
    cancel(pongTimer);
    pongTimer = null;
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch (e) {
      return log(`feishu: ignored an unreadable frame (${e.message})`);
    }
    const h = headersOf(frame);
    if (frame.method === 0) {
      if (h.type === 'pong' && frame.payload?.length) {
        try {
          applyConfig(JSON.parse(dec.decode(frame.payload)));
        } catch {
          // A pong without settings.
        }
      }
      return;
    }
    if (frame.method !== 1) return;
    const whole = assemble(h, frame.payload ?? new Uint8Array(0));
    if (!whole) return;
    const began = now();
    let event = null;
    try {
      event = JSON.parse(dec.decode(whole));
    } catch {
      log(`feishu: ignored an unreadable event (${h.type ?? 'no type'})`);
    }
    // Acked at once, whatever happens next: Feishu pushes again what is not acked within 3 s.
    sendFrame(sock, { ...frame, headers: [...frame.headers, { key: 'biz_rt', value: String(Math.max(0, now() - began)) }], payload: enc.encode(JSON.stringify({ code: 200 })) });
    if (event && h.type === 'event') handleEvent(event);
  }

  /** The whole payload of a data frame, or null while parts are missing. */
  function assemble(h, payload) {
    const sum = Number(h.sum ?? 1);
    const seq = Number(h.seq ?? 0);
    if (!h.sum || sum === 1) return payload;
    if (!Number.isInteger(sum) || sum < 1 || sum > 1000 || !Number.isInteger(seq) || seq < 0 || seq >= sum) {
      log(`feishu: ignored an event part with bad numbering (sum ${h.sum}, seq ${h.seq})`);
      return null;
    }
    const t = now();
    for (const [id, f] of fragments) if (t - f.at > FRAGMENT_TTL_MS) fragments.delete(id);
    const id = String(h.message_id ?? '');
    let f = fragments.get(id);
    if (!f || f.parts.length !== sum) {
      f = { parts: new Array(sum).fill(null), got: 0, at: t };
      fragments.set(id, f);
    }
    if (!f.parts[seq]) f.got += 1;
    f.parts[seq] = payload;
    if (f.got < sum) return null;
    fragments.delete(id);
    const out = new Uint8Array(f.parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of f.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  // --- inbound messages -----------------------------------------------------------------

  /** message ids seen lately (Feishu may push one twice) */
  const seenIds = new Set();
  /** message ids the bot sent (a reply to one of them addresses the bot) */
  const sentIds = new Set();
  /** chatId → the latest person's message there, for the "Typing" reaction */
  const lastInbound = new Map();
  let inbound = Promise.resolve();
  let warnedEncrypted = false;

  function handleEvent(data) {
    if (data?.encrypt) {
      if (!warnedEncrypted) log('feishu: an encrypted event arrived; long-connection events should be plain. Ignored.');
      warnedEncrypted = true;
      return;
    }
    const type = data?.header?.event_type ?? data?.event?.type;
    if (type !== 'im.message.receive_v1') return;
    const event = data.event;
    // One at a time, in arrival order: a name lookup must not let a later message overtake.
    inbound = inbound.then(() => deliver(event)).catch((e) => log(`feishu: a message was not handled: ${e?.message ?? e}`));
  }

  async function deliver(event) {
    const msg = normalizeEvent(event, { botOpenId: me?.openId ?? '', sentIds });
    if (!msg || seenIds.has(msg.messageId)) return;
    remember(seenIds, msg.messageId, 2000);
    msg.userName = await nameOf(msg.userId);
    if (!msg.isDirect) {
      const title = await titleOf(msg.chatId);
      if (title) msg.chatTitle = title;
    }
    if (domain?.lark) msg.source = 'Lark';
    lastInbound.delete(msg.chatId);
    lastInbound.set(msg.chatId, { messageId: msg.messageId, at: now(), used: false });
    if (lastInbound.size > 500) lastInbound.delete(lastInbound.keys().next().value);
    if (halted()) return;
    try {
      const r = onMessage(msg);
      if (r && typeof r.catch === 'function') r.catch((e) => log(`feishu: a message handler failed: ${e?.message ?? e}`));
    } catch (e) {
      log(`feishu: a message handler failed: ${e?.message ?? e}`);
    }
  }

  /**
   * A cached lookup with an off switch: a missing permission stops asking for a
   * while (logged once). An answer slower than LOOKUP_TIMEOUT_MS does not hold
   * the message up; it lands in the cache for the next one.
   */
  function lookup({ what, fetchOne, advice }) {
    const cache = new Map();
    const flights = new Map();
    let offUntil = 0;
    let warned = false;
    const warn = (why) => {
      if (!warned) log(`feishu: ${why}; ${advice}`);
      warned = true;
    };
    const fetchAndCache = (id, previous) =>
      Promise.resolve()
        .then(() => fetchOne(id))
        .then((v) => {
          const value = String(v ?? '').trim();
          cache.set(id, { value, until: now() + (value ? NAME_TTL_MS : LOOKUP_RETRY_MS) });
          if (cache.size > 2000) cache.delete(cache.keys().next().value);
          if (!value) warn(`${what} came back empty`);
          return value;
        })
        .catch((e) => {
          if (SCOPE_CODES.has(e.code)) offUntil = now() + LOOKUP_OFF_MS;
          if (SCOPE_CODES.has(e.code) || e.code === 41050) warn(`no ${what} (${e.message})`);
          cache.set(id, { value: previous, until: now() + LOOKUP_RETRY_MS });
          return previous;
        })
        .finally(() => flights.delete(id));
    return async (id) => {
      const hit = cache.get(id);
      if (hit && hit.until > now()) return hit.value;
      const previous = hit?.value ?? '';
      if (offUntil > now() || halted()) return previous;
      let flight = flights.get(id);
      if (flight?.late) return previous; // already too slow once: the next messages do not wait for it again
      if (!flight) {
        flight = { promise: fetchAndCache(id, previous), late: false };
        flights.set(id, flight);
      }
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeoutImpl(() => {
          flight.late = true;
          resolve(previous);
        }, LOOKUP_TIMEOUT_MS);
      });
      return Promise.race([flight.promise, late]).finally(() => clearTimeoutImpl(timer));
    };
  }

  const userName = lookup({
    what: 'sender names',
    advice: 'add the permissions contact:contact.base:readonly and contact:user.base:readonly, and check Permissions & Scopes → Data permissions → contact range covers these people',
    fetchOne: async (openId) => {
      const r = await api('GET', `/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`, undefined, { retries: 0, what: 'user lookup' });
      const u = r?.data?.user ?? {};
      return u.name || u.en_name || u.nickname || '';
    },
  });
  const nameOf = async (openId) => (await userName(openId)) || `user ${openId.slice(-6)}`;

  const titleOf = lookup({
    what: 'group names',
    advice: 'add the permission im:chat:readonly to show them',
    fetchOne: async (chatId) => {
      const r = await api('GET', `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, undefined, { retries: 0, what: 'group lookup' });
      return r?.data?.name ?? '';
    },
  });

  // --- typing: a "Typing" reaction -------------------------------------------------------

  /** chatId → {messageId, reactionId, timer, adding} */
  const marks = new Map();
  let reactionsOff = false;

  function removeMark(chatId, { afterStop = false } = {}) {
    const mark = marks.get(chatId);
    if (!mark) return Promise.resolve();
    marks.delete(chatId);
    cancel(mark.timer);
    return Promise.resolve(mark.adding)
      .then(async () => {
        if (!mark.reactionId) return;
        const path = `/open-apis/im/v1/messages/${encodeURIComponent(mark.messageId)}/reactions/${encodeURIComponent(mark.reactionId)}`;
        if (afterStop) {
          if (tokenCache?.value) await http('DELETE', `${domain.base}${path}`, { token: tokenCache.value, timeoutMs: 3000, afterStop: true });
        } else await api('DELETE', path, undefined, { retries: 1, what: 'typing reaction' });
      })
      .catch((e) => log(`feishu: could not remove the typing reaction: ${e?.message ?? e}`));
  }

  async function typing(chatId) {
    chatId = String(chatId);
    if (halted() || !domain) return;
    const mark = marks.get(chatId);
    if (mark) {
      cancel(mark.timer);
      mark.timer = setTimeoutImpl(guard(() => removeMark(chatId)), TYPING_IDLE_MS);
      return;
    }
    const last = lastInbound.get(chatId);
    if (reactionsOff || !last || last.used || now() - last.at > TYPING_FRESH_MS) return;
    last.used = true;
    const m = { messageId: last.messageId, reactionId: '', timer: null, adding: null };
    m.timer = setTimeoutImpl(guard(() => removeMark(chatId)), TYPING_IDLE_MS);
    marks.set(chatId, m);
    m.adding = api('POST', `/open-apis/im/v1/messages/${encodeURIComponent(m.messageId)}/reactions`, { reaction_type: { emoji_type: 'Typing' } }, { retries: 0, what: 'typing reaction' })
      .then((r) => {
        m.reactionId = String(r?.data?.reaction_id ?? '');
      })
      .catch((e) => {
        if (SCOPE_CODES.has(e.code)) {
          reactionsOff = true;
          log(`feishu: no typing reaction (${e.message}); add the permission im:message.reactions:write_only to show one`);
        } else log(`feishu: typing reaction: ${e?.message ?? e}`);
      });
    await m.adding;
  }

  // --- sending --------------------------------------------------------------------------

  let sendTrouble = false;

  /** Post `body` as an answer to the first of `replyTo` (message ids) still there, else to the chat. Ids found gone are added to `gone`. */
  async function deliverBody(chatId, body, replyTo, gone = new Set()) {
    let r = null;
    for (const id of new Set(replyTo)) {
      if (!id || gone.has(id)) continue;
      try {
        r = await api('POST', `/open-apis/im/v1/messages/${encodeURIComponent(id)}/reply`, { ...body, uuid: randomUUID() }, { what: 'reply' });
        break;
      } catch (e) {
        if (!REPLY_GONE.has(e.code)) throw e;
        gone.add(id);
        r = null;
      }
    }
    if (!r) r = await api('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', { receive_id: chatId, ...body, uuid: randomUUID() }, { what: 'send' });
    const id = r?.data?.message_id;
    if (id) remember(sentIds, String(id), 500);
    return r;
  }

  async function sendPart(chatId, md, replyTo, gone) {
    try {
      return await deliverBody(chatId, postBody(md), replyTo, gone);
    } catch (e) {
      if (!POST_REJECTED.has(e.code)) throw e;
      log(`feishu: ${label()} did not take a reply as Markdown (${e.message}); sending it as plain text`);
      return deliverBody(chatId, { msg_type: 'text', content: JSON.stringify({ text: toPlainText(md) }) }, replyTo, gone);
    }
  }

  /** A send that failed on the app's own setup reads in the panel until a later send works. */
  function noteSendTrouble(e) {
    if (SCOPE_CODES.has(e?.code)) {
      sendTrouble = true;
      status('error', `${label()} would not let the app send messages (${e.msg ?? e.message}). Add the permission im:message:send_as_bot (Permissions & Scopes), then publish a version.`, { hint: 'scopes' });
    } else if (e?.code === 230006) {
      sendTrouble = true;
      status('error', `${label()} says the bot capability is off (${e.msg ?? e.message}). Turn it on (Add features → Bot) and publish a version.`, { hint: 'bot' });
    }
  }

  // --- public ---------------------------------------------------------------------------

  async function run() {
    if (!appId || !secret) throw failStart('Fill in the App ID and the App Secret from the developer console: your app → Credentials & Basic Info.', 'appId');
    if (!/^cli_[A-Za-z0-9]{6,64}$/.test(appId)) throw failStart('That is not a Feishu / Lark App ID: it starts with cli_. Copy it from the developer console: your app → Credentials & Basic Info.', 'appId');
    if (typeof WebSocketImpl !== 'function') throw failStart('This runtime has no WebSocket.');
    if (typeof fetchImpl !== 'function') throw failStart('This runtime has no fetch.');
    status('connecting');
    try {
      await signIn();
    } catch (e) {
      if (e.fatal) fail(e.message, e.hint);
      throw stoppedError();
    }
    if (domain.lark) larkApps.add(appId);
    else larkApps.delete(appId);
    log(`feishu: signed in to ${label()}; opening the long connection`);
    await new Promise((resolve, reject) => {
      waitOpen = { resolve, reject };
      void openSocket();
    });
    await loadBot();
    if (halted()) throw stoppedError();
    started = true;
    if (wsOpen) status('connected');
    return { id: appId, username: me.name, name: me.name };
  }

  function failStart(detail, hint = '') {
    fail(detail, hint);
    return fatalError;
  }

  return {
    /**
     * Sign in, open the long connection, then learn the bot's identity.
     * Resolves with {id: App ID, username: bot name, name}; network trouble
     * keeps retrying, bad credentials reject (fatal).
     */
    start() {
      if (stopped) return Promise.reject(new Error('the Feishu connector was stopped'));
      if (!startPromise) {
        startPromise = run();
        startPromise.catch(() => {});
      }
      return startPromise;
    },

    /** Close the connection for good; a "Typing" reaction still showing is removed (best effort). */
    stop() {
      if (stopping) return stopping;
      stopped = true;
      halt.abort();
      cancel(reconnectTimer);
      reconnectTimer = null;
      detach();
      wakeAll();
      if (waitOpen) {
        waitOpen.reject(new Error('the Feishu connector was stopped'));
        waitOpen = null;
      }
      const chats = [...marks.keys()];
      stopping = Promise.allSettled(chats.map((c) => removeMark(c, { afterStop: true }))).then(() => status('stopped'));
      return stopping;
    },

    /**
     * Send Markdown as `post` messages of at most TEXT_LIMIT; the first part
     * answers `replyTo`. With `threadId` (a root message) every part answers
     * that root (the first one `replyTo` when given), so all of it lands in
     * the root's topic or reply chain.
     */
    async send(chatId, text, sendOpts = {}) {
      if (halted()) throw new Error(`the ${label()} connector is stopped`);
      if (!domain) throw new Error(`the ${label()} connector is not signed in yet`);
      chatId = String(chatId);
      const replyTo = sendOpts?.replyTo ? String(sendOpts.replyTo) : '';
      const root = sendOpts?.threadId ? String(sendOpts.threadId) : '';
      const gone = new Set();
      let first = true;
      const ids = [];
      try {
        for (const part of partsOf(text)) {
          const r = await sendPart(chatId, part, first ? [replyTo, root] : [root], gone);
          if (r?.data?.message_id) ids.push(String(r.data.message_id));
          first = false;
        }
        if (sendTrouble) {
          sendTrouble = false;
          if (wsOpen && started) status('connected');
        }
      } catch (e) {
        noteSendTrouble(e);
        throw e;
      } finally {
        void removeMark(chatId);
      }
      return { ids };
    },

    /** Called every ~5 s while a bot works: a "Typing" reaction on the person's message, removed when the work stops. */
    typing,
  };
}
