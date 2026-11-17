/**
 * Tickets: work one bot hands to another. A ticket has one worker bot, its own
 * Harness Session (`ticket-<id>`), one requester (a Session, or the user), the
 * Threads (outside conversations) it is subscribed to, and the structured
 * reports its worker sent. Its stage is its own: an idle Session is not a
 * finished ticket.
 *
 * `tickets.json` under the bots cache holds `{version: 1, tickets, threads}` in
 * the shapes of docs/PLAN-0.8.md §10, plus `lastRequesterAt` (below). It is read
 * on first use and written whole through a temp file and a rename; a missing
 * file starts empty, and an unreadable one is set aside as `tickets.json.corrupt`
 * before the first write replaces it. Fields this module does not know (set
 * through `patch`) are kept.
 *
 * Stages ({@link stageOf}): the first row that matches wins. "Answered" means a
 * message from outside the worker reached the ticket after that report: a
 * person's (`lastHumanAt`) or the requester's (`lastRequesterAt`, an addition to
 * §10: a parent ticket's worker or the Router answering a `question` must clear
 * it as a person's answer does).
 *
 * | stage      | stored fields                                                                     |
 * | ---------- | --------------------------------------------------------------------------------- |
 * | `failed`   | `ended.outcome === 'failed'`, or open and the latest report is an unanswered `blocked` |
 * | `question` | open and the latest report is an unanswered `question`                           |
 * | `stalled`  | open and `stalledAt` is set (the watchdog stores it; a report, an answer or `resume` clears it) |
 * | `queued`   | open and no `startedAt` (a started ticket put back in the queue has `startedAt` cleared) |
 * | `working`  | open: started and nothing above (running, a background job, or not judged yet)    |
 * | `done`     | `ended.outcome === 'done'`: a `done` report, or closed by the requester or user  |
 * | `stopped`  | `ended.outcome === 'stopped'`: stopped by a person, the requester or the system  |
 *
 * "Open" is no `ended`. An archived ticket is always ended. Reports never reopen
 * a ticket; only {@link createTickets}'s `resume` does.
 *
 * Worker slots ({@link createSlots}) are in memory only: after a restart the
 * caller acquires them again for the tickets it restarts.
 *
 * @module @kadaliao/dsh-bots/lib/tickets
 */

import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STAGES = ['failed', 'question', 'stalled', 'queued', 'working', 'done', 'stopped'];
export const REPORT_STATUSES = ['progress', 'done', 'blocked', 'question'];
export const END_BY = ['worker', 'requester', 'user', 'system'];
export const OUTCOMES = ['done', 'stopped', 'failed'];

/** Longest title, in characters. */
export const MAX_TITLE = 120;
/** Longest delegated text one ticket keeps. */
export const MAX_TEXT = 50_000;
/** Longest text one report keeps. */
export const MAX_REPORT = 20_000;
/** Reports one ticket keeps; past this the oldest go. */
export const KEEP_REPORTS = 200;
/** Archived tickets {@link createTickets}'s `prune` keeps by default. */
export const KEEP_ENDED = 500;
/** Worker slots when no number is given. */
export const DEFAULT_MAX_WORKING = 4;

export const TICKET_ID_RE = /^t[a-z0-9]{8}$/;
const SESSION_PREFIX = 'ticket-';
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_KEY = 500;
const MAX_LABEL = 200;

/** `t` and 8 random lowercase letters and digits. */
export function newTicketId() {
  let id = 't';
  for (let i = 0; i < 8; i += 1) id += ALNUM[randomInt(ALNUM.length)];
  return id;
}

/** The Session a ticket runs in. */
export const sessionIdOf = (ticketId) => `${SESSION_PREFIX}${ticketId}`;

/** The ticket id inside a ticket Session's id, or ''. */
export function ticketIdOf(sessionId) {
  const s = String(sessionId ?? '');
  const id = s.startsWith(SESSION_PREFIX) ? s.slice(SESSION_PREFIX.length) : '';
  return TICKET_ID_RE.test(id) ? id : '';
}

/** One line of at most `max` characters (code points); a cut one ends with `…`. */
export function clampTitle(text, max = MAX_TITLE) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** A title from delegated text: its first line with words on it. */
export function titleFrom(text) {
  const line = String(text ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
  return clampTitle(line);
}

const str = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : '');
const time = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/** Not ended. */
export const isOpen = (ticket) => !ticket?.ended;

/** Still takes messages from its Threads: not archived, and not stopped by a person. */
export const isLive = (ticket) => Boolean(ticket) && !ticket.archivedAt && !(ticket.ended?.by === 'user' && ticket.ended.outcome === 'stopped');

/**
 * The stage of a ticket, from its stored fields (table in the module header).
 * @param {object} ticket
 * @param {{now?: number}} [_at] - accepted for symmetry with the watchdog, unused: time-based
 *   judgements are the watchdog's, which stores `stalledAt`.
 * @returns {'failed'|'question'|'stalled'|'queued'|'working'|'done'|'stopped'}
 */
export function stageOf(ticket, _at) {
  const t = ticket ?? {};
  const open = !t.ended;
  const last = Array.isArray(t.reports) ? t.reports.at(-1) : undefined;
  const unanswered = (r) => Math.max(time(t.lastHumanAt), time(t.lastRequesterAt)) <= time(r.at);
  if (t.ended?.outcome === 'failed' || (open && last?.status === 'blocked' && unanswered(last))) return 'failed';
  if (open && last?.status === 'question' && unanswered(last)) return 'question';
  if (open && t.stalledAt) return 'stalled';
  if (open && !t.startedAt) return 'queued';
  if (open) return 'working';
  if (t.ended.outcome === 'done') return 'done';
  return 'stopped';
}

/**
 * Worker slots: at most `max` tickets work at once, plus one extra slot that
 * only a person's message may take, so new work cannot crowd out a follow-up.
 * The extra slot is simply "one beyond `max`": once any slot frees, the next
 * person's message can use it again.
 * @param {number} [max]
 */
export function createSlots(max = DEFAULT_MAX_WORKING) {
  const capOf = (n) => (Number.isFinite(Number(n)) ? Math.max(1, Math.floor(Number(n))) : DEFAULT_MAX_WORKING);
  let cap = capOf(max);
  const held = new Set();
  return {
    /** Take a slot for `ticketId`; true when it holds one (again) now. */
    acquire(ticketId, { human = false } = {}) {
      if (!ticketId) return false;
      if (held.has(ticketId)) return true;
      if (held.size < cap || (human && held.size < cap + 1)) {
        held.add(ticketId);
        return true;
      }
      return false;
    },
    /** Free the slot of `ticketId`; true when it held one. */
    release(ticketId) {
      return held.delete(ticketId);
    },
    holds(ticketId) {
      return held.has(ticketId);
    },
    count() {
      return held.size;
    },
    max() {
      return cap;
    },
    /** A new limit; holders keep their slots, new ones wait until the count is under it. */
    setMax(n) {
      cap = capOf(n);
    },
  };
}

/** Kind, app, chat and root from a Thread key (`kind:appKey:chatId[:rootId]`, `panel:<sessionId>`). */
function partsOfKey(key) {
  const [kind = '', ...rest] = key.split(':');
  if (kind === 'panel') return { kind, appKey: '', chatId: rest.join(':') };
  const [appKey = '', chatId = '', ...root] = rest;
  return { kind, appKey, chatId, ...(root.length > 0 && root.join(':') !== '' ? { rootId: root.join(':') } : {}) };
}

const validKey = (key) => typeof key === 'string' && key !== '' && key.length <= MAX_KEY;

function normalizeRequester(r) {
  const out = { kind: r?.kind === 'session' || (r?.kind !== 'user' && typeof r?.sessionId === 'string' && r.sessionId) ? 'session' : 'user' };
  for (const k of ['sessionId', 'botId', 'ticketId']) if (typeof r?.[k] === 'string' && r[k] !== '') out[k] = r[k];
  return out;
}

function normalizeOrigin(o) {
  const out = {};
  if (validKey(o?.threadKey)) out.threadKey = o.threadKey;
  for (const k of ['via', 'who']) if (typeof o?.[k] === 'string' && o[k] !== '') out[k] = o[k].slice(0, MAX_LABEL);
  return out;
}

function normalizeReport(r) {
  if (!r || !REPORT_STATUSES.includes(r.status)) return null;
  return { at: time(r.at), status: r.status, text: str(r.text, MAX_REPORT) };
}

const OPTIONAL_TIMES = ['startedAt', 'lastEventAt', 'lastHumanAt', 'lastRequesterAt', 'nudgedAt', 'stalledAt', 'archivedAt'];

/** A stored ticket as read back: known fields checked, unknown ones kept, `null` when unusable. */
function normalizeTicket(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '' || typeof raw.botId !== 'string' || raw.botId === '') return null;
  const t = { ...raw };
  t.title = clampTitle(raw.title) || titleFrom(raw.text);
  t.text = str(raw.text);
  t.sessionId = typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null;
  t.requester = normalizeRequester(raw.requester);
  t.origin = normalizeOrigin(raw.origin);
  t.threads = [...new Set((Array.isArray(raw.threads) ? raw.threads : []).filter(validKey))];
  t.reports = (Array.isArray(raw.reports) ? raw.reports : []).map(normalizeReport).filter(Boolean).slice(-KEEP_REPORTS);
  t.createdAt = time(raw.createdAt);
  t.updatedAt = time(raw.updatedAt) || t.createdAt;
  t.retries = Number.isInteger(raw.retries) && raw.retries > 0 ? raw.retries : 0;
  for (const k of OPTIONAL_TIMES) {
    if (time(raw[k])) t[k] = time(raw[k]);
    else delete t[k];
  }
  if (typeof raw.parentId !== 'string' || raw.parentId === '') delete t.parentId;
  if (typeof raw.error !== 'string') delete t.error;
  if (raw.ended && typeof raw.ended === 'object') {
    t.ended = { at: time(raw.ended.at) || t.updatedAt, by: END_BY.includes(raw.ended.by) ? raw.ended.by : 'system', outcome: OUTCOMES.includes(raw.ended.outcome) ? raw.ended.outcome : 'stopped' };
  } else {
    delete t.ended;
  }
  if (t.archivedAt && !t.ended) t.ended = { at: t.archivedAt, by: 'system', outcome: 'stopped' };
  return t;
}

function normalizeThread(raw) {
  if (!raw || typeof raw !== 'object' || !validKey(raw.key)) return null;
  const th = { key: raw.key, ...partsOfKey(raw.key), tickets: Array.isArray(raw.tickets) ? raw.tickets.filter((x) => typeof x === 'string') : [], lastAt: time(raw.lastAt) };
  applyMeta(th, raw);
  return th;
}

/** Copy the descriptive fields of `meta` onto a Thread record. */
function applyMeta(th, meta) {
  for (const k of ['kind', 'appKey', 'chatId', 'rootId']) if (typeof meta?.[k] === 'string' && meta[k] !== '') th[k] = meta[k].slice(0, MAX_KEY);
  if (typeof meta?.label === 'string' && meta.label.trim() !== '') th.label = clampTitle(meta.label, MAX_LABEL);
}

/**
 * The tickets file under `dir`.
 *
 * Returned tickets and Threads are the stored objects: read them, change them
 * through these methods. Every change is written at once, except a plain
 * {@link touch} (a Session event), which waits for the next write or `flush()`.
 *
 * @param {string} dir
 * @param {{now?: () => number}} [options] - `now`: the clock (tests).
 */
export function createTickets(dir, { now = Date.now } = {}) {
  const file = join(dir, 'tickets.json');
  /** @type {{version: 1, tickets: object[], threads: object[]}|null} */
  let data = null;
  const byId = new Map();
  const byKey = new Map();
  const listeners = new Set();
  let dirty = false;

  const setAside = () => {
    try {
      renameSync(file, `${file}.corrupt`);
    } catch {
      // It goes when the next write replaces it.
    }
  };

  const load = () => {
    if (data) return data;
    let parsed = null;
    let text = null;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // First run.
    }
    if (text !== null) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tickets)) {
        parsed = null;
        setAside();
      }
    }
    data = { version: 1, tickets: [], threads: [] };
    for (const raw of parsed?.tickets ?? []) {
      const t = normalizeTicket(raw);
      if (!t || byId.has(t.id)) continue;
      data.tickets.push(t);
      byId.set(t.id, t);
    }
    for (const raw of Array.isArray(parsed?.threads) ? parsed.threads : []) {
      const th = normalizeThread(raw);
      if (!th || byKey.has(th.key)) continue;
      data.threads.push(th);
      byKey.set(th.key, th);
    }
    // The tickets' own lists are the truth: Thread lists keep their order, lose what the
    // tickets do not say, and gain what they do.
    const subscribed = new Map();
    for (const t of data.tickets) {
      for (const key of t.threads) {
        if (!subscribed.has(key)) subscribed.set(key, []);
        subscribed.get(key).push(t.id);
      }
    }
    for (const th of data.threads) {
      const ids = subscribed.get(th.key) ?? [];
      th.tickets = [...new Set([...th.tickets.filter((id) => ids.includes(id)), ...ids])];
    }
    for (const [key, ids] of subscribed) {
      if (byKey.has(key)) continue;
      const th = { key, ...partsOfKey(key), tickets: ids, lastAt: 0 };
      data.threads.push(th);
      byKey.set(key, th);
    }
    return data;
  };

  const save = () => {
    dirty = false;
    try {
      mkdirSync(dir, { recursive: true });
      // Delegated work can quote anything the user said: readable by this user only.
      writeFileSync(`${file}.tmp`, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {
      dirty = true; // Kept in memory; the next write tries again.
    }
  };

  const changed = (ticket = null) => {
    save();
    for (const fn of listeners) {
      try {
        fn(ticket);
      } catch {
        // A listener must not break a write.
      }
    }
  };

  const ensureThread = (key, meta) => {
    let th = byKey.get(key);
    if (!th) {
      th = { key, ...partsOfKey(key), tickets: [], lastAt: now() };
      data.threads.push(th);
      byKey.set(key, th);
    }
    if (meta) {
      applyMeta(th, meta);
      th.lastAt = time(meta.lastAt) || now();
    }
    return th;
  };

  /** Subscribe without writing; true when something changed. */
  const link = (t, key, meta) => {
    if (!validKey(key)) return false;
    const th = ensureThread(key, meta);
    let did = Boolean(meta);
    if (!t.threads.includes(key)) {
      t.threads.push(key);
      did = true;
    }
    if (!th.tickets.includes(t.id)) {
      th.tickets.push(t.id);
      did = true;
    }
    return did;
  };

  const unlink = (t, key) => {
    const had = t.threads.includes(key);
    t.threads = t.threads.filter((k) => k !== key);
    const th = byKey.get(key);
    if (th) th.tickets = th.tickets.filter((id) => id !== t.id);
    return had;
  };

  const find = (id) => {
    load();
    return typeof id === 'string' ? byId.get(id) : undefined;
  };

  return {
    file,

    /**
     * Open a ticket. Throws a readable error without a bot or without any text.
     * `parentId` defaults to the requesting ticket (`requester.ticketId`); the
     * origin Thread is subscribed, as is each of `threads` (keys, or Thread
     * metadata with a `key`).
     * @param {{title?: string, text: string, botId: string, requester?: object, parentId?: string, origin?: {threadKey?: string, via?: string, who?: string}, threads?: Array<string|{key: string}>}} input
     */
    create({ title, text, botId, requester, parentId, origin, threads = [] } = {}) {
      load();
      if (typeof botId !== 'string' || botId === '') throw new Error('a ticket needs the bot that does the work');
      const body = str(text);
      const name = clampTitle(title) || titleFrom(body);
      if (name === '') throw new Error('a ticket needs a title or text');
      let id = newTicketId();
      while (byId.has(id)) id = newTicketId();
      const at = now();
      const req = normalizeRequester(requester);
      const parent = typeof parentId === 'string' && parentId !== '' ? parentId : req.ticketId;
      const t = {
        id,
        title: name,
        text: body,
        botId,
        sessionId: null,
        requester: req,
        ...(parent ? { parentId: parent } : {}),
        origin: normalizeOrigin(origin),
        threads: [],
        reports: [],
        createdAt: at,
        updatedAt: at,
        retries: 0,
      };
      data.tickets.push(t);
      byId.set(id, t);
      if (t.origin.threadKey) link(t, t.origin.threadKey);
      for (const th of Array.isArray(threads) ? threads : []) {
        if (typeof th === 'string') link(t, th);
        else if (th && typeof th === 'object') link(t, th.key, th);
      }
      changed(t);
      return t;
    },

    get: find,

    /**
     * Tickets, newest first.
     * @param {{botId?: string, stage?: string|string[], open?: boolean, archived?: boolean}} [filter]
     *   `open`: true for not ended, false for ended; `archived` likewise.
     */
    list({ botId, stage, open, archived } = {}) {
      load();
      const stages = stage === undefined ? null : new Set([stage].flat());
      const at = now();
      return data.tickets
        .filter(
          (t) =>
            (botId === undefined || t.botId === botId) &&
            (open === undefined || isOpen(t) === open) &&
            (archived === undefined || Boolean(t.archivedAt) === archived) &&
            (!stages || stages.has(stageOf(t, { now: at }))),
        )
        .reverse();
    },

    /** Tickets not ended, oldest first (the queue's order). */
    open() {
      load();
      return data.tickets.filter(isOpen);
    },

    /** The tickets `id` handed on, oldest first. */
    children(id) {
      load();
      return data.tickets.filter((t) => t.parentId === id);
    },

    /**
     * The ticket a Session belongs to: its stored `sessionId`, or a `ticket-<id>`
     * Session not stored yet (it is being created).
     */
    bySession(sessionId) {
      load();
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;
      const t = byId.get(ticketIdOf(sessionId));
      if (t && (t.sessionId === sessionId || t.sessionId === null)) return t;
      return data.tickets.find((x) => x.sessionId === sessionId);
    },

    /**
     * Set fields as given (`undefined` removes one); `id` stays, `title` is
     * clamped, and a new `threads` list subscribes and unsubscribes to match.
     */
    patch(id, fields) {
      const t = find(id);
      if (!t) return undefined;
      const { id: _id, threads, ...rest } = fields ?? {};
      const title = t.title;
      for (const [k, v] of Object.entries(rest)) {
        if (v === undefined) delete t[k];
        else t[k] = v;
      }
      if ('title' in rest) t.title = clampTitle(rest.title) || title;
      if (Array.isArray(threads)) {
        const want = threads.filter(validKey);
        for (const key of [...t.threads]) if (!want.includes(key)) unlink(t, key);
        for (const key of want) link(t, key);
      }
      t.updatedAt = now();
      changed(t);
      return t;
    },

    /**
     * The ticket started in its Session (default `ticket-<id>`). A first start
     * time is kept (a restart delivers it again); to queue a started ticket
     * again, `patch(id, {startedAt: undefined})`.
     */
    start(id, { sessionId } = {}) {
      const t = find(id);
      if (!t) return undefined;
      const at = now();
      t.sessionId = typeof sessionId === 'string' && sessionId !== '' ? sessionId : t.sessionId ?? sessionIdOf(t.id);
      t.startedAt ??= at;
      t.lastEventAt = at;
      t.updatedAt = at;
      changed(t);
      return t;
    },

    /**
     * A report from the worker. Any report clears `nudgedAt` and `stalledAt`; a
     * `done` one ends an open ticket (by 'worker', outcome 'done'). Throws on an
     * unknown status.
     * @param {string} id
     * @param {{status: 'progress'|'done'|'blocked'|'question', text?: string}} report
     */
    addReport(id, { status, text } = {}) {
      if (!REPORT_STATUSES.includes(status)) throw new Error(`a report status is one of ${REPORT_STATUSES.join(', ')}`);
      const t = find(id);
      if (!t) return undefined;
      const at = now();
      t.reports = [...t.reports, { at, status, text: str(text, MAX_REPORT) }].slice(-KEEP_REPORTS);
      delete t.nudgedAt;
      delete t.stalledAt;
      t.lastEventAt = at;
      t.updatedAt = at;
      if (status === 'done' && !t.ended) t.ended = { at, by: 'worker', outcome: 'done' };
      changed(t);
      return t;
    },

    /**
     * End a ticket (again: the newest end wins, so a requester may close a failed one).
     * Throws on an unknown `by` or `outcome`.
     * @param {string} id
     * @param {{by: 'worker'|'requester'|'user'|'system', outcome: 'done'|'stopped'|'failed', error?: string}} end
     */
    end(id, { by, outcome, error } = {}) {
      if (!END_BY.includes(by)) throw new Error(`a ticket is ended by one of ${END_BY.join(', ')}`);
      if (!OUTCOMES.includes(outcome)) throw new Error(`a ticket ends as one of ${OUTCOMES.join(', ')}`);
      const t = find(id);
      if (!t) return undefined;
      const at = now();
      t.ended = { at, by, outcome };
      if (typeof error === 'string' && error !== '') t.error = error.slice(0, MAX_REPORT);
      t.updatedAt = at;
      changed(t);
      return t;
    },

    /**
     * Open an ended ticket again (a follow-up after `done`, a retry): clears
     * `ended`, `stalledAt` and `nudgedAt`, and sets `retries` back to 0. Refused
     * (`null`) when archived, or when a person stopped it unless `force` (that
     * person asking for it again). A ticket failed by an unanswered `blocked`
     * report stays failed until a message answers it ({@link touch}).
     * @returns {object|null|undefined} the ticket, `null` when refused, `undefined` when unknown
     */
    resume(id, { force = false } = {}) {
      const t = find(id);
      if (!t) return undefined;
      if (t.archivedAt) return null;
      if (!force && t.ended?.by === 'user' && t.ended.outcome === 'stopped') return null;
      delete t.ended;
      delete t.stalledAt;
      delete t.nudgedAt;
      t.retries = 0;
      t.updatedAt = now();
      changed(t);
      return t;
    },

    /**
     * Something happened in the ticket: sets `lastEventAt`. A message from a
     * person (`human`) or from the requester (`requester`) also sets
     * `lastHumanAt` / `lastRequesterAt`, answers a `question` or `blocked`
     * report, and clears `nudgedAt` / `stalledAt`; it is written at once. A plain
     * event is kept in memory until the next write or `flush()`.
     */
    touch(id, { human = false, requester = false } = {}) {
      const t = find(id);
      if (!t) return undefined;
      const at = now();
      t.lastEventAt = at;
      if (!human && !requester) {
        dirty = true;
        return t;
      }
      if (human) t.lastHumanAt = at;
      if (requester) t.lastRequesterAt = at;
      delete t.nudgedAt;
      delete t.stalledAt;
      t.updatedAt = at;
      changed(t);
      return t;
    },

    /** Archive a ticket; one still open is ended first (stopped by the system). */
    archive(id) {
      const t = find(id);
      if (!t) return undefined;
      const at = now();
      t.ended ??= { at, by: 'system', outcome: 'stopped' };
      t.archivedAt ??= at;
      t.updatedAt = at;
      changed(t);
      return t;
    },

    /** Subscribe a ticket to a Thread, made from its key (and `threadMeta`) when new. */
    subscribe(id, threadKey, threadMeta) {
      const t = find(id);
      if (!t) return undefined;
      if (link(t, threadKey, threadMeta ? { ...threadMeta, key: threadKey } : undefined)) {
        t.updatedAt = now();
        changed(t);
      }
      return t;
    },

    unsubscribe(id, threadKey) {
      const t = find(id);
      if (!t) return undefined;
      if (unlink(t, threadKey)) {
        t.updatedAt = now();
        changed(t);
      }
      return t;
    },

    thread(key) {
      load();
      return typeof key === 'string' ? byKey.get(key) : undefined;
    },

    /**
     * The tickets subscribed to a Thread, in the order they subscribed. `live`:
     * only those that still take its messages ({@link isLive}).
     */
    subscribers(threadKey, { live = false } = {}) {
      load();
      const th = typeof threadKey === 'string' ? byKey.get(threadKey) : undefined;
      if (!th) return [];
      return th.tickets.map((id) => byId.get(id)).filter((t) => t && (!live || isLive(t)));
    },

    /**
     * Record a Thread's metadata (`{key, kind?, appKey?, chatId?, rootId?, label?, lastAt?}`)
     * and its latest activity (`lastAt`, default now). Its tickets are left as they are.
     */
    upsertThread(meta) {
      load();
      if (!validKey(meta?.key)) return undefined;
      const th = ensureThread(meta.key, meta);
      changed(null);
      return th;
    },

    /** `fn(ticket)` after each write: the ticket that changed, or `null` (Thread metadata, a prune). Returns an unsubscribe. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * Retention: keep the newest `keepEnded` archived tickets (by `archivedAt`),
     * drop older ones, then drop Threads no ticket is subscribed to. Tickets not
     * archived are never dropped.
     * @returns {{tickets: number, threads: number}} how many went
     */
    prune({ keepEnded = KEEP_ENDED } = {}) {
      load();
      const keep = Number.isFinite(Number(keepEnded)) ? Math.max(0, Math.floor(Number(keepEnded))) : KEEP_ENDED;
      const archived = data.tickets.filter((t) => t.archivedAt).sort((a, b) => a.archivedAt - b.archivedAt || a.createdAt - b.createdAt);
      const drop = new Set(archived.slice(0, Math.max(0, archived.length - keep)).map((t) => t.id));
      if (drop.size > 0) {
        data.tickets = data.tickets.filter((t) => !drop.has(t.id));
        for (const id of drop) byId.delete(id);
        for (const th of data.threads) th.tickets = th.tickets.filter((id) => !drop.has(id));
      }
      const empty = data.threads.filter((th) => th.tickets.length === 0);
      for (const th of empty) byKey.delete(th.key);
      if (empty.length > 0) data.threads = data.threads.filter((th) => th.tickets.length > 0);
      const gone = { tickets: drop.size, threads: empty.length };
      if (gone.tickets > 0 || gone.threads > 0) changed(null);
      return gone;
    },

    /** Write what plain touches left in memory. */
    flush() {
      load();
      if (dirty) save();
    },
  };
}
