/**
 * Discussions (讨论串, Bots 0.10): a reply to one message, talked over in a
 * Session of its own.
 *
 * As in open-super-agent, a discussion sees the conversation it branched from
 * up to the message it answers, then its own messages; what the main
 * conversation says later never reaches it, and what is said in it never
 * reaches the main conversation. Bots gets that from Harness's
 * `sessionController.fork({sessionId, atSeq})`: the bot's conversation is
 * forked at the replied message, and the fork is the discussion.
 *
 * A discussion is keyed by its Thread key (lib/threads.mjs): in the panel
 * `panel:<homeSessionId>:<rootId>`, in a chat app `kind:appKey:chatId:rootId`.
 *
 * Anchors say where a message sits in a Session (`{sessionId, seq}`), so a
 * discussion can be forked at it:
 * - `msg:<id>`: a timeline message (the panel's own ids);
 * - `chat:<appKey>:<chatId>:<messageId>`: a chat app's message, one the bot
 *   took in or one it sent;
 * - a Thread key: where that Thread last spoke with the bot's home (a group
 *   thread the bot answered in before anyone replied).
 *
 * The file `discussions.json` holds `{items, anchors, seen, told, since}`; anchors and old
 * discussions are bounded. `told`: per bot, when its main conversation last heard what was said
 * in its threads (the panel shows those replies in the chat, so the main conversation hears of
 * them with the person's next message there); `since`: when the file began, the default.
 *
 * @module @kadaliao/dsh-bots/lib/discussions
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A discussion with no message for this long has its Session archived (it opens again on the next reply). */
export const IDLE_ARCHIVE_MS = 24 * 3600_000;
/** Anchors kept: the newest win. */
export const KEEP_ANCHORS = 4000;
/** Discussions kept: the most recently active win; an archived one past this is forgotten. */
export const KEEP_DISCUSSIONS = 2000;

const str = (v) => (v == null ? '' : String(v).trim());
const seqOf = (v) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);

/** The anchor ref of a timeline message. */
export const messageRef = (id) => `msg:${str(id)}`;
/** The anchor ref of a chat app's message. */
export const chatMessageRef = (appKey, chatId, messageId) => `chat:${str(appKey)}:${str(chatId)}:${str(messageId)}`;

/** A position `{sessionId, seq}` when both parts are valid, else null. */
export function positionOf(p) {
  const sessionId = str(p?.sessionId);
  const seq = seqOf(p?.seq);
  return sessionId && seq !== undefined ? { sessionId, seq } : null;
}

/**
 * Where a discussion forks, first match wins:
 * 1. `thread`: where its Thread last spoke with the home (a chat thread answered there before);
 * 2. `root`: the replied message itself;
 * 3. `fallback`: a Session to fork at its latest completed turn (`seq` left out).
 * Returns `{sessionId, seq?}`, or null when there is nothing to fork.
 */
export function forkPoint({ thread, root, fallback } = {}) {
  return positionOf(thread) ?? positionOf(root) ?? (str(fallback) ? { sessionId: str(fallback) } : null);
}

/**
 * The event of a timeline message in a Session's log, by time, for a message logged before
 * anchors were kept (Bots 0.9 and older). A bot's message sits at the last event at or before
 * the moment it was logged; a person's message at the end of the turn that took it, so the
 * discussion includes the answer it got (or at the message itself while that turn runs).
 * @param {object[]} events - the Session's log (or its tail), oldest first, with `seq`, `time`, `type`
 * @param {{at: number, fromPerson?: boolean}} message
 * @param {number} [slackMs] - how far after `at` an event still counts as the message's own
 * @returns {number|undefined} the seq
 */
export function seqByTime(events, { at, fromPerson = false }, slackMs = 1500) {
  const list = Array.isArray(events) ? events : [];
  const t = Number(at);
  if (!Number.isFinite(t) || list.length === 0) return undefined;
  const timeOf = (e) => (typeof e?.time === 'number' ? e.time : Date.parse(e?.time ?? '') || 0);
  let mine = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (timeOf(list[i]) <= t + slackMs) mine = i;
    else break;
  }
  if (mine < 0) return undefined;
  if (fromPerson) {
    // Logged when it was sent, maybe a while before a model took it: its own event is the first
    // person's message from that moment on, and the end of the turn that took it counts.
    const own = list.findIndex((e) => e?.type === 'user/message' && timeOf(e) >= t - 50);
    if (own < 0) return seqOf(list[mine].seq);
    for (let i = own; i < list.length; i += 1) if (list[i]?.type === 'turn/end') return seqOf(list[i].seq);
    return seqOf(list[own].seq);
  }
  return seqOf(list[mine].seq);
}

/**
 * The discussions file.
 * @param {string} dir
 * @param {{now?: () => number}} [opts]
 */
export function createDiscussions(dir, { now = Date.now } = {}) {
  const file = join(dir, 'discussions.json');
  /** @type {{items: Record<string, object>, anchors: Record<string, {sessionId: string, seq: number, at: number}>, seen: Record<string, number>, told: Record<string, number>, since: number}} */
  let state = { items: {}, anchors: {}, seen: {}, told: {}, since: now() };
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      state = {
        items: raw?.items && typeof raw.items === 'object' ? raw.items : {},
        anchors: raw?.anchors && typeof raw.anchors === 'object' ? raw.anchors : {},
        seen: raw?.seen && typeof raw.seen === 'object' ? raw.seen : {},
        told: raw?.told && typeof raw.told === 'object' ? raw.told : {},
        since: Number(raw?.since) || now(),
      };
    }
  } catch {
    // A damaged file starts over: discussions are reopened by forking again.
  }
  const bySid = new Map();
  const index = () => {
    bySid.clear();
    for (const d of Object.values(state.items)) if (d?.sessionId) bySid.set(d.sessionId, d.key);
  };
  index();

  let timer = null;
  const write = () => {
    timer = null;
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, file);
    } catch {
      // Kept in memory; written with the next change.
    }
  };
  /** Written soon, not at once: anchors change on every message. */
  const save = () => {
    if (timer) return;
    timer = setTimeout(write, 200);
    timer.unref?.();
  };

  const prune = () => {
    const refs = Object.keys(state.anchors);
    if (refs.length > KEEP_ANCHORS) {
      refs.sort((a, b) => (state.anchors[a].at ?? 0) - (state.anchors[b].at ?? 0));
      for (const r of refs.slice(0, refs.length - KEEP_ANCHORS)) delete state.anchors[r];
    }
    const keys = Object.keys(state.items);
    if (keys.length > KEEP_DISCUSSIONS) {
      const old = keys.filter((k) => state.items[k].archivedAt).sort((a, b) => (state.items[a].lastAt ?? 0) - (state.items[b].lastAt ?? 0));
      for (const k of old.slice(0, keys.length - KEEP_DISCUSSIONS)) {
        delete state.seen[state.items[k].rootId];
        delete state.items[k];
      }
      index();
    }
  };

  const copy = (d) => (d ? { ...d, ...(d.source ? { source: { ...d.source } } : {}) } : undefined);

  return {
    /** The discussion of a Thread key, or undefined. */
    get(key) {
      return copy(state.items[str(key)]);
    },
    /** The discussion a Session is, or undefined. */
    bySession(sessionId) {
      const key = bySid.get(str(sessionId));
      return key ? copy(state.items[key]) : undefined;
    },
    /** The discussion of a panel root message, or undefined. */
    byRoot(rootId) {
      const r = str(rootId);
      return copy(Object.values(state.items).find((d) => d.rootId === r));
    },
    /** Discussions, the most recently active first; `botId` narrows. */
    list({ botId = '', archived } = {}) {
      return Object.values(state.items)
        .filter((d) => (!botId || d.botId === botId) && (archived === undefined || Boolean(d.archivedAt) === archived))
        .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
        .map(copy);
    },
    /**
     * Add a discussion. `{key, botId, sessionId, rootId, source: {sessionId, seq?}, title?}`;
     * `createdAt` and `lastAt` are set here. Replaces one with the same key.
     */
    add(rec) {
      const key = str(rec?.key);
      const sessionId = str(rec?.sessionId);
      if (!key || !sessionId || !str(rec?.botId)) throw new Error('a discussion needs a key, a bot and a Session');
      const at = now();
      const prev = state.items[key];
      if (prev?.sessionId) bySid.delete(prev.sessionId);
      const d = {
        key,
        botId: str(rec.botId),
        sessionId,
        rootId: str(rec.rootId),
        ...(rec.source?.sessionId ? { source: { sessionId: str(rec.source.sessionId), ...(seqOf(rec.source.seq) !== undefined ? { seq: seqOf(rec.source.seq) } : {}) } } : {}),
        ...(str(rec.title) ? { title: str(rec.title).slice(0, 200) } : {}),
        createdAt: prev?.createdAt ?? at,
        lastAt: at,
      };
      state.items[key] = d;
      bySid.set(sessionId, key);
      prune();
      // Written at once: a fork whose record is lost would be a conversation no bot owns.
      if (timer) clearTimeout(timer);
      write();
      return copy(d);
    },
    /** Change fields of a discussion (`lastAt`, `archivedAt`, `noted`, …); `null` removes a field. */
    patch(key, fields = {}) {
      const d = state.items[str(key)];
      if (!d) return undefined;
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'key' || k === 'sessionId' || k === 'botId') continue;
        if (v === null || v === undefined) delete d[k];
        else d[k] = v;
      }
      save();
      return copy(d);
    },
    /** A message was said in the discussion now: it is active. */
    touch(key) {
      const d = state.items[str(key)];
      if (!d) return undefined;
      d.lastAt = now();
      save();
      return copy(d);
    },
    /** Forget a discussion (its Session is someone else's to archive). */
    remove(key) {
      const d = state.items[str(key)];
      if (!d) return false;
      bySid.delete(d.sessionId);
      delete state.items[str(key)];
      save();
      return true;
    },
    /** Discussions quiet for `idleMs` and not archived yet: the ones to archive. */
    idle(idleMs = IDLE_ARCHIVE_MS) {
      const cut = now() - idleMs;
      return Object.values(state.items)
        .filter((d) => !d.archivedAt && (d.lastAt ?? 0) < cut)
        .map(copy);
    },

    /** Note where `ref` (see the module notes) sits: `{sessionId, seq}`. The newest note wins. */
    anchor(ref, pos) {
      const r = str(ref);
      const p = positionOf(pos);
      if (!r || !p) return;
      state.anchors[r] = { ...p, at: now() };
      prune();
      save();
    },
    /** Where `ref` sits, or null. */
    anchorOf(ref) {
      const a = state.anchors[str(ref)];
      return a ? positionOf(a) : null;
    },

    /** When the person last looked at the discussion under `rootId` (0: never). */
    seenAt(rootId) {
      return Number(state.seen[str(rootId)]) || 0;
    },
    /** The person looked at the discussion under `rootId` at `at` (default now). */
    markSeen(rootId, at = now()) {
      const r = str(rootId);
      if (!r) return;
      state.seen[r] = Math.max(Number(state.seen[r]) || 0, Number(at) || 0);
      save();
    },

    /** When `botId`'s main conversation last heard what was said in its threads (at first: when this file began). */
    toldAt(botId) {
      return Number(state.told[str(botId)]) || Number(state.since) || 0;
    },
    /** `botId`'s main conversation heard what was said in its threads up to `at` (default now). */
    markTold(botId, at = now()) {
      const b = str(botId);
      if (!b) return;
      state.told[b] = Math.max(Number(state.told[b]) || 0, Number(at) || 0);
      save();
    },

    /** Write now (tests, shutdown). */
    flush() {
      if (timer) clearTimeout(timer);
      write();
    },
  };
}
