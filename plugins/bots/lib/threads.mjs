/**
 * Threads: an outside conversation a request came from, and where replies go.
 *
 * A Thread is a Slack thread, a Feishu topic or reply chain, a Discord reply
 * chain or thread channel, a Telegram topic or private chat, or a home
 * conversation in the panel. Its key is `kind:appKey:chatId[:rootId]`
 * (`appKey` is the channel's record key in channels.mjs, `botId/appId`); a
 * message with no thread id of its own belongs to the whole-chat thread
 * `kind:appKey:chatId`. A panel conversation is `panel:<sessionId>`. Inside a
 * part, `%` and `:` are written `%25` and `%3A`, so any id survives the trip.
 *
 * This module decides, with no I/O:
 *
 * - where an inbound chat message goes (`routeInbound`): a leading `@handle`
 *   reaches that bot's home as in 0.7; otherwise the live tickets subscribed
 *   to the message's thread take it (and the Router hears of it without being
 *   woken); otherwise the Router (the channel owner's home) does;
 * - where a conversation's plain replies go (`createOrigins`): each turn
 *   collects the threads its inputs came from (user messages, and the origin
 *   threads of the tickets whose reports arrived). One chat thread: replies go
 *   there. Only the panel, or nothing: the panel. More than one, including the
 *   panel plus one chat: the panel only, and the bot names a target with
 *   `bot_reply` (`resolve`).
 *
 * @module @kadaliao/dsh-bots/lib/threads
 */

/** A turn's source threads are forgotten this long after its latest input, unless its session still runs. */
export const ORIGIN_TTL_MS = 30 * 60_000;

/** How a thread's kind reads in a label. */
export const KIND_LABELS = { telegram: 'Telegram', discord: 'Discord', feishu: 'Feishu', slack: 'Slack', panel: 'Panel' };

/** Kinds are short lowercase words, so they are never escaped. */
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PANEL = 'panel';

const part = (v) => (v == null ? '' : String(v).trim());
const esc = (s) => s.replace(/%/g, '%25').replace(/:/g, '%3A');
const unesc = (s) => s.replace(/%(25|3A)/gi, (_, c) => (c === '25' ? '%' : ':'));

// --- keys ------------------------------------------------------------------------------

/**
 * The key of the thread a chat message belongs to.
 * @param {string} kind - 'telegram' | 'discord' | 'feishu' | 'slack' (… or 'panel', keyed by `msg.sessionId`)
 * @param {string} appKey - the channel's record key (`botId/appId`)
 * @param {{chatId: string|number, threadId?: string|number|null, rootId?: string|number|null, sessionId?: string}} msg
 *   `threadId` as a connector reports it (`rootId` is accepted too, so a parsed key rebuilds);
 *   none means the whole chat
 * @returns {string|null} null when the kind, app or chat is missing
 */
export function threadKey(kind, appKey, msg = {}) {
  const k = part(kind);
  if (k === PANEL) return panelThreadKey(msg?.sessionId ?? msg?.chatId);
  if (!KIND_RE.test(k)) return null;
  const app = part(appKey);
  const chat = part(msg?.chatId);
  if (!app || !chat) return null;
  const root = part(msg?.threadId ?? msg?.rootId);
  return [k, esc(app), esc(chat), ...(root ? [esc(root)] : [])].join(':');
}

/** The thread of a home conversation in the panel: replies to it stay in the panel. */
export function panelThreadKey(sessionId) {
  const s = part(sessionId);
  return s ? `${PANEL}:${esc(s)}` : null;
}

/**
 * A thread key taken apart.
 * @returns {{kind: string, appKey: string, chatId: string, rootId?: string} | {kind: 'panel', sessionId: string} | null}
 */
export function parseThreadKey(key) {
  if (typeof key !== 'string' || key === '') return null;
  const parts = key.split(':');
  const kind = parts[0];
  if (!KIND_RE.test(kind)) return null;
  if (kind === PANEL) {
    if (parts.length !== 2 || parts[1] === '') return null;
    return { kind: PANEL, sessionId: unesc(parts[1]) };
  }
  if (parts.length < 3 || parts.length > 4 || parts.slice(1).some((p) => p === '')) return null;
  const [, app, chat, root] = parts;
  return { kind, appKey: unesc(app), chatId: unesc(chat), ...(root !== undefined ? { rootId: unesc(root) } : {}) };
}

/**
 * The canonical key of whatever names a thread: a key, a parsed key, an
 * origin (`threadKey`, or kind/appKey/chatId/rootId with `key` as the 0.7
 * channel key) or a stored Thread record (`key` is the thread key there).
 * @returns {string|null}
 */
export function toThreadKey(ref) {
  if (typeof ref === 'string') {
    const p = parseThreadKey(ref);
    return p ? (p.kind === PANEL ? panelThreadKey(p.sessionId) : threadKey(p.kind, p.appKey, p)) : null;
  }
  if (!ref || typeof ref !== 'object') return null;
  if (typeof ref.threadKey === 'string') return toThreadKey(ref.threadKey);
  if (ref.kind === PANEL) return panelThreadKey(ref.sessionId ?? ref.chatId);
  if (ref.appKey == null && typeof ref.key === 'string' && parseThreadKey(ref.key)) return toThreadKey(ref.key);
  return threadKey(ref.kind, ref.appKey ?? ref.key, ref);
}

/** Whether two references (keys, origins, Thread records) name the same thread. */
export function sameThread(a, b) {
  const ka = toThreadKey(a);
  return ka !== null && ka === toThreadKey(b);
}

/** Whether a reference names a panel conversation. */
export function isPanelThread(ref) {
  const k = toThreadKey(ref);
  return k !== null && k.startsWith(`${PANEL}:`);
}

const cleanName = (s, max = 60) =>
  String(s ?? '')
    .replace(/[[\]\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * How a thread reads to a person or a bot: `Slack · Acme #general · thread`,
 * `Telegram · Kada`, `Panel`. The chat is its title when known (a group),
 * else who wrote (a private chat), else its id.
 * @param {string | {threadKey?: string, kind?: string, source?: string, chatTitle?: string, who?: string,
 *   chatId?: string, rootId?: string, threadTitle?: string}} meta - a key, an origin or a Thread record
 */
export function threadLabel(meta) {
  const parsed = typeof meta === 'string' ? parseThreadKey(meta) : parseThreadKey(meta?.threadKey ?? (meta?.appKey == null ? meta?.key : undefined));
  const m = { ...(parsed ?? {}), ...(meta && typeof meta === 'object' ? meta : {}) };
  const kind = part(m.kind);
  const parts = [cleanName(m.source) || KIND_LABELS[kind] || cleanName(kind) || 'Chat'];
  const chat = cleanName(m.chatTitle) || (kind === PANEL ? '' : cleanName(m.who) || cleanName(m.chatId));
  if (chat) parts.push(chat);
  if (kind !== PANEL && part(m.rootId)) parts.push(cleanName(m.threadTitle) || (kind === 'telegram' ? 'topic' : 'thread'));
  return parts.join(' · ');
}

// --- inbound -----------------------------------------------------------------------------

/** A leading `@handle`: the same rule as `routeMessage` in channels.mjs (duplicated, as channels.mjs will import this module). */
const LEADING_HANDLE = /^@([a-z0-9][a-z0-9-]{0,31})(?=$|[\s,，:：.。!?！？;；])[\s,，:：;；]*/i;

/** The roster bot a message names with a leading `@handle`, and the text after it; null when it names none. */
export function addressedBot(text, roster) {
  const t = String(text ?? '').trim();
  const m = LEADING_HANDLE.exec(t);
  if (!m) return null;
  const bot = (roster ?? []).find((b) => b?.handle === m[1].toLowerCase());
  return bot ? { bot, text: t.slice(m[0].length).trim() } : null;
}

/**
 * Whether a subscribed ticket still takes its threads' messages: not
 * archived and not stopped. A done ticket does (a follow-up reopens it), and
 * so does a failed one (a person's answer may unblock it).
 */
export function isLiveSubscriber(ticket) {
  return Boolean(ticket) && !ticket.archivedAt && ticket.ended?.outcome !== 'stopped';
}

const sameBot = (a, b) => Boolean(a && b) && (a === b || (a.id != null && a.id === b.id));

/**
 * Where an inbound chat message goes.
 *
 * 1. A leading `@handle` of a roster bot: that bot's home (`bot-home`), even on
 *    a subscribed thread. Naming the owner itself is `router` with
 *    `addressed: true`: the owner's home is the Router, and the person asked
 *    for it rather than the tickets.
 * 2. Live tickets subscribed to the thread: `tickets`, and the Router gets a
 *    notice that does not wake it (`notifyRouter`).
 * 3. Otherwise the owner's home: `router`.
 *
 * `text` is the message without the handle; an empty one is dropped by the
 * caller, as in 0.7.
 *
 * @param {{text: string, threadKey?: string, mentionsHandle?: string}} msg - `mentionsHandle`: a roster
 *   handle the chat app's own mention markup resolved to; used only when the text has no leading handle
 * @param {{subscribers?: object[] | ((threadKey: string) => object[]), owner: object, roster?: object[],
 *   live?: (ticket: object) => boolean}} ctx - `subscribers`: tickets (or a lookup by thread key); a ticket
 *   counts when `live` (default `isLiveSubscriber`) and its `threads` hold the message's thread
 * @returns {{to: 'bot-home', bot: object, text: string, threadKey: string|null}
 *   | {to: 'tickets', tickets: object[], notifyRouter: true, router: object, text: string, threadKey: string}
 *   | {to: 'router', bot: object, text: string, threadKey: string|null, addressed?: true}}
 */
export function routeInbound(msg, ctx = {}) {
  const { owner = null, roster = [], subscribers, live = isLiveSubscriber } = ctx;
  const text = String(msg?.text ?? '').trim();
  const key = toThreadKey(msg?.threadKey);
  let addressed = addressedBot(text, roster);
  if (!addressed && msg?.mentionsHandle) {
    const handle = part(msg.mentionsHandle).replace(/^@/, '').toLowerCase();
    const bot = (roster ?? []).find((b) => b?.handle === handle);
    if (bot) addressed = { bot, text };
  }
  if (addressed) {
    if (sameBot(addressed.bot, owner)) return { to: 'router', bot: owner, text: addressed.text, threadKey: key, addressed: true };
    return { to: 'bot-home', bot: addressed.bot, text: addressed.text, threadKey: key };
  }
  if (key) {
    const list = typeof subscribers === 'function' ? subscribers(key) : subscribers;
    const seen = new Set();
    const tickets = [];
    for (const t of Array.isArray(list) ? list : []) {
      if (!t || seen.has(t.id ?? t) || !live(t)) continue;
      if (!Array.isArray(t.threads) || !t.threads.some((k) => sameThread(k, key))) continue;
      seen.add(t.id ?? t);
      tickets.push(t);
    }
    if (tickets.length) return { to: 'tickets', tickets, notifyRouter: true, router: owner, text, threadKey: key };
  }
  return { to: 'router', bot: owner, text, threadKey: key };
}

// --- a turn's source threads ----------------------------------------------------------------

/**
 * An input's origin, keyed: identity fields come from the key; the rest
 * (`replyTo`, `who`, `chatTitle`, …) from what the caller gave. `key` is the
 * channel's record key as in 0.7's reply target (the same as `appKey`).
 */
function originOf(key, given) {
  const { tickets: _ticketsOfThread, threadKey: _given, ...rest } = given && typeof given === 'object' ? given : {};
  const p = parseThreadKey(key);
  const { rootId: _root, key: _key, appKey: _app, chatId: _chat, ...extra } = rest;
  if (p.kind === PANEL) {
    const { replyTo: _replyTo, ...panelExtra } = extra;
    return { ...panelExtra, threadKey: key, kind: PANEL, sessionId: p.sessionId };
  }
  return { ...extra, threadKey: key, kind: p.kind, key: p.appKey, appKey: p.appKey, chatId: p.chatId, ...(p.rootId !== undefined ? { rootId: p.rootId } : {}) };
}

const copyOrigin = (o) => ({ ...o, ...(o.tickets ? { tickets: [...o.tickets] } : {}) });

/** `{thread: key}` or `{ticket: id}` from what `bot_reply` names: a key, `thread/<key>`, `ticket/<id>`, an id or an object. */
function refOf(ref) {
  if (typeof ref === 'string') {
    const r = ref.trim();
    if (!r) return null;
    if (r.startsWith('thread/')) return { thread: r.slice(7) };
    if (r.startsWith('ticket/')) return r.length > 7 ? { ticket: r.slice(7) } : null;
    return parseThreadKey(r) ? { thread: r } : { ticket: r };
  }
  if (!ref || typeof ref !== 'object') return null;
  const thread = ref.thread ?? ref.threadKey;
  if (thread != null && thread !== '') return { thread };
  const ticket = part(ref.ticket ?? ref.ticketId);
  return ticket ? { ticket } : null;
}

/**
 * Per conversation, the threads this turn's inputs came from (plan §4.3).
 *
 * Rules for plain replies (`replyPlan`, `replyTarget`):
 * - no input, or only panel inputs: `panel` (the text stays in the panel);
 * - exactly one chat thread and no panel input: `thread`, sent there (0.7's behaviour);
 * - anything more, including the panel plus one chat: `choose` (the text stays
 *   in the panel; `bot_reply` names where it goes).
 *
 * The set lives until `endTurn`. As a guard against a turn end never seen, a
 * session's whole set is dropped once its latest input is `ttlMs` old, unless
 * `running(sessionId)` says it still works. It is dropped whole, never entry
 * by entry: losing one of two threads would turn "choose" into a wrong target.
 *
 * @param {{now?: () => number, ttlMs?: number, running?: (sessionId: string) => boolean,
 *   lookup?: (ref: {thread: string} | {ticket: string}) => object|string|null}} [opts]
 *   `lookup`: for `resolve`, a known thread or a ticket's origin thread outside this turn
 *   (a key, an origin or a Thread record); without it `resolve` only knows this turn's threads
 */
export function createOrigins(opts = {}) {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? ORIGIN_TTL_MS;
  /** sessionId → {at, items: Map<threadKey, origin>} */
  const sessions = new Map();

  const running = (sessionId) => {
    try {
      return Boolean(opts.running?.(sessionId));
    } catch {
      return false;
    }
  };
  /** The live set of a session, or null after dropping an expired one. */
  const setOf = (sessionId) => {
    const s = sessions.get(sessionId);
    if (!s) return null;
    if (now() - s.at >= ttlMs && !running(sessionId)) {
      sessions.delete(sessionId);
      return null;
    }
    return s;
  };
  const list = (sessionId) => [...(setOf(sessionId)?.items.values() ?? [])];

  function replyPlan(sessionId) {
    const origins = list(sessionId);
    const chats = origins.filter((o) => o.kind !== PANEL);
    const mode = chats.length === 0 ? 'panel' : chats.length === 1 && origins.length === 1 ? 'thread' : 'choose';
    return { mode, target: mode === 'thread' ? copyOrigin(chats[0]) : null, origins: origins.map(copyOrigin) };
  }

  return {
    /**
     * An input of this turn arrived in `sessionId`: a user message (from a
     * chat or the panel), or a ticket's report (pass the ticket's origin thread
     * and `ticket`). The thread is `threadKey`, else the one `origin` names;
     * an input with neither came from inside Harness and counts as the panel.
     * The same thread twice is one entry, keeping its first place and the
     * latest details (the newest message to quote).
     * @param {string} sessionId
     * @param {{threadKey?: string, origin?: {kind?: string, appKey?: string, key?: string, chatId?: string,
     *   rootId?: string, replyTo?: string, who?: string, chatTitle?: string}, ticket?: string|string[]}} input
     * @returns {object|null} the origin as now stored
     */
    noteInput(sessionId, input = {}) {
      const sid = part(sessionId);
      if (!sid) return null;
      for (const other of [...sessions.keys()]) setOf(other);
      const key = toThreadKey(input.threadKey) ?? toThreadKey(input.origin) ?? panelThreadKey(sid);
      const s = sessions.get(sid) ?? { at: now(), items: new Map() };
      const prev = s.items.get(key);
      const next = originOf(key, { ...(prev ?? {}), ...(input.origin ?? {}) });
      const tickets = [...(prev?.tickets ?? [])];
      for (const t of [input.ticket].flat()) if (part(t) && !tickets.includes(part(t))) tickets.push(part(t));
      if (tickets.length) next.tickets = tickets;
      s.items.set(key, next);
      s.at = now();
      sessions.set(sid, s);
      return copyOrigin(next);
    },

    /** The distinct threads of this turn, in the order they first arrived. */
    current(sessionId) {
      return list(sessionId).map(copyOrigin);
    },

    /** `{mode: 'panel' | 'thread' | 'choose', target, origins}`; see the rules above. */
    replyPlan,

    /** Where this turn's plain replies go: the one chat thread, or null (the panel; or a choice to make). */
    replyTarget(sessionId) {
      return replyPlan(sessionId).target;
    },

    /**
     * The thread `bot_reply` names: a thread key (or `thread/<key>`, `{thread}`)
     * or a ticket id (or `ticket/<id>`, `{ticket}`) meaning that ticket's origin
     * thread. This turn's threads first, then `lookup`; null when unknown, so a
     * made-up key never becomes a target.
     */
    resolve(sessionId, ref) {
      const r = refOf(ref);
      if (!r) return null;
      const items = list(sessionId);
      const key = r.thread != null ? toThreadKey(r.thread) : null;
      if (r.thread != null && !key) return null;
      const hit = key ? items.find((o) => o.threadKey === key) : items.find((o) => (o.tickets ?? []).includes(r.ticket));
      if (hit) return copyOrigin(hit);
      let found = null;
      try {
        found = opts.lookup?.(key ? { thread: key } : { ticket: r.ticket }) ?? null;
      } catch {
        found = null;
      }
      const foundKey = toThreadKey(found);
      if (!foundKey || (key && foundKey !== key)) return null;
      const origin = originOf(foundKey, typeof found === 'object' ? found : {});
      if (r.ticket) origin.tickets = [r.ticket];
      return origin;
    },

    /** The turn ended: its threads are forgotten. Returns them. */
    endTurn(sessionId) {
      const out = list(part(sessionId)).map(copyOrigin);
      sessions.delete(part(sessionId));
      return out;
    },
  };
}
