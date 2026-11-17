/**
 * What models read about tickets (tasks) and threads: compact cards, the
 * notices relayed between conversations, and the paged reader behind
 * `bot_recall`. Inline & Spill: long text is clipped where it is shown, the
 * full length rides along, and every id on a card can be expanded with
 * `readResource`. Pure functions; the ticket store, thread store, stage rule
 * and transcripts are injected. Shapes follow PLAN-0.8 §10.
 *
 * @module @kadaliao/dsh-bots/lib/cards
 */

/** Characters of a report relayed to the requester. */
export const REPORT_CHARS = 600;
/** Characters of the assignment in a worker's first message. */
export const ASSIGNMENT_CHARS = 1500;
/** Characters of a report or message preview on a card. */
export const PREVIEW_CHARS = 200;
/** Characters of one text page. */
export const PAGE_CHARS = 4000;
/** Items of one list page, and the most a caller may ask for. */
export const PAGE_ITEMS = 20;
export const MAX_ITEMS = 50;
/** Recent messages shown for a thread. */
export const RECENT_MESSAGES = 10;

/**
 * The ticket store as this module reads it. An array of tickets works too.
 * @typedef {object} TicketsView
 * @property {(id: string) => object|undefined} get
 * @property {() => object[]} list - every ticket, archived ones included.
 * @property {(id: string) => object[]} [children] - sub-tickets; defaults to `list()` filtered by `parentId`.
 */

/**
 * The thread store as this module reads it. A Map, an array of threads or a
 * `(key) => thread` function works for `ticketCard`.
 * @typedef {object} ThreadsView
 * @property {(key: string) => object|undefined} thread - or `get(key)`; the ticket store (which has `thread`) works as is.
 * @property {(key: string) => Array<object|string>} [subscribers] - tickets (or ids) subscribed to a thread; defaults to `thread.tickets`.
 * @property {(key: string) => Array<{at?: number|string, who?: string, text: string}>|Promise<Array<object>>} [recent] - latest messages, oldest first.
 */

/**
 * Who reads: the router (dispatcher home), any bot's home, or a ticket session.
 * @typedef {{kind: 'router'|'home'|'ticket', ticketId?: string}} Viewer
 */

/**
 * What text builders need besides the ticket.
 * @typedef {object} CardContext
 * @property {object[]|Map|Function} [bots] - bots ({id, handle, name}), a Map by id, or `(id) => bot`.
 * @property {ThreadsView|Map|object[]|Function} [threads]
 * @property {TicketsView|object[]} [tickets] - for children ids.
 * @property {object[]} [children] - sub-tickets (or ids), when the caller has them.
 * @property {string} [stage] - the ticket's stage, when known.
 * @property {(ticket: object, opts: {now: number}) => string} [stageOf] - otherwise asked here.
 * @property {number} [now]
 */

const toMs = (v) => (typeof v === 'number' ? v : v ? Date.parse(v) : NaN);
const iso = (v) => {
  const ms = toMs(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};
const quote = (s) => JSON.stringify(String(s ?? ''));
const recallHint = (ref) => `bot_recall {"ref":${quote(ref)}}`;

/** Drop undefined, null, '' and empty arrays so cards stay compact. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * One entry of an injected source: function, Map, array, or an object with
 * `method(key)` (`thread` for threads, so the ticket store itself, whose `get`
 * returns tickets, can serve as the thread source) or `get(key)`.
 */
function lookup(src, key, field = 'id', method = 'get') {
  if (!src || key === undefined || key === null) return undefined;
  if (typeof src === 'function') return src(key);
  if (src instanceof Map) return src.get(key);
  if (Array.isArray(src)) return src.find((x) => x?.[field] === key);
  if (typeof src[method] === 'function') return src[method](key);
  if (typeof src.get === 'function') return src.get(key);
  return undefined;
}

const botOf = (bots, id) => lookup(bots, id);
const handleOf = (bots, id) => {
  const b = botOf(bots, id);
  return b?.handle ? `@${b.handle}` : '(removed bot)';
};
const threadOf = (threads, key) => lookup(threads, key, 'key', 'thread');

/** The ticket store as {get, list, children}. */
function ticketsView(src) {
  if (!src) return { get: () => undefined, list: () => [], children: () => [] };
  if (Array.isArray(src)) {
    return { get: (id) => src.find((t) => t.id === id), list: () => src, children: (id) => src.filter((t) => t.parentId === id) };
  }
  const list = () => (typeof src.list === 'function' ? src.list() ?? [] : []);
  return {
    get: (id) => (typeof src.get === 'function' ? src.get(id) : list().find((t) => t.id === id)),
    list,
    children: (id) => (typeof src.children === 'function' ? src.children(id) ?? [] : list().filter((t) => t.parentId === id)),
  };
}

/** The stage of a ticket from the context: given, computed, or stored on the ticket. */
function stageIn(ticket, ctx = {}) {
  if (ctx.stage !== undefined) return ctx.stage;
  if (typeof ctx.stageOf === 'function') return ctx.stageOf(ticket, { now: ctx.now ?? Date.now() });
  return ticket.stage;
}

const parentOf = (t) => t.parentId ?? t.requester?.ticketId;
const lastReport = (t) => (Array.isArray(t.reports) && t.reports.length ? t.reports[t.reports.length - 1] : undefined);

function childIds(ticket, ctx) {
  const kids = ctx.children ?? ticket.children ?? (ctx.tickets ? ticketsView(ctx.tickets).children(ticket.id) : []);
  return (kids ?? []).map((k) => (typeof k === 'string' ? k : k?.id)).filter(Boolean);
}

/**
 * Text cut to at most `max` characters (an ellipsis included), with the full
 * length when it was cut.
 * @param {string} text
 * @param {number} max
 * @returns {{text: string, chars?: number}}
 */
export function clip(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s };
  let end = Math.max(0, max - 1);
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return { text: `${s.slice(0, end).trimEnd()}…`, chars: s.length };
}

/** Who asked, on a card: '@atlas' or 'user'. A parent ticket shows as `parent`. */
function requesterOf(t, bots) {
  const r = t.requester ?? {};
  if (r.kind === 'user' || !r.botId) return 'user';
  return handleOf(bots, r.botId);
}

/** Who asked, in a sentence: '@atlas', '@coder (task t…)', 'the user'. */
function requesterPhrase(t, bots) {
  const who = requesterOf(t, bots);
  const parent = parentOf(t);
  if (who === 'user') return parent ? `task ${parent}` : 'the user';
  return parent ? `${who} (task ${parent})` : who;
}

/** Where a ticket came from, in a sentence: 'Kada in #general (Slack)', or ''. */
function originPhrase(t, threads) {
  const o = t.origin ?? {};
  const label = threadOf(threads, o.threadKey)?.label;
  const parts = [o.who, label ? `in ${label}` : '', o.via ? `(${o.via})` : ''].filter(Boolean);
  return parts.join(' ');
}

/**
 * A compact card for one ticket. Every id on it can be read with
 * `readResource`: `id`, `parent` and `children` as `ticket/<id>`, the origin
 * thread and `threads` as `thread/<key>`, `bot` as `bot/<handle>`.
 * @param {object} ticket
 * @param {CardContext} [ctx]
 * @returns {{id: string, title: string, bot: string, stage?: string, requester: string, parent?: string, children?: string[], origin?: {thread?: string, label?: string, via?: string, who?: string}, threads?: string[], last_report?: {status: string, at?: string, preview: string}, error?: string, archived?: true, updated_at?: string}}
 */
export function ticketCard(ticket, ctx = {}) {
  const t = ticket;
  const stage = stageIn(t, ctx);
  const o = t.origin ?? {};
  const report = lastReport(t);
  return compact({
    id: t.id,
    title: t.title,
    bot: handleOf(ctx.bots, t.botId),
    stage,
    requester: requesterOf(t, ctx.bots),
    parent: parentOf(t),
    children: childIds(t, ctx),
    origin: compact({ thread: o.threadKey, label: threadOf(ctx.threads, o.threadKey)?.label, via: o.via, who: o.who }),
    threads: (t.threads ?? []).filter((k) => k !== o.threadKey),
    last_report: report ? compact({ status: report.status, at: iso(report.at), preview: clip(String(report.text ?? '').trim(), PREVIEW_CHARS).text }) : undefined,
    error: stage === 'failed' && t.error ? clip(t.error, PREVIEW_CHARS).text : undefined,
    archived: t.archivedAt ? true : undefined,
    updated_at: iso(t.updatedAt),
  });
}

/** A list row: the card without children, extra threads and error. */
function ticketRow(t, ctx) {
  const { children, threads, error, ...row } = ticketCard(t, { ...ctx, children: [] });
  return row;
}

const NEXT_STEP = {
  done: () => 'Pass the result on to whoever asked for it.',
  question: (t, bot) => `${bot} needs an answer to go on. Answer with bot_send_message (ticket: ${quote(t.id)}) if you know it; otherwise ask the person and send their answer the same way.`,
  blocked: (t, bot) => `${bot} is blocked. Unblock it with bot_send_message (ticket: ${quote(t.id)}), ask the person what to do, or stop the task with bot_ticket.`,
  progress: () => 'No action needed; more reports will follow.',
};

/**
 * What the requester reads when a worker reports: who, the status, the
 * report (≤ 600 characters, with a pointer to the full text when cut), the
 * ticket card and the next step.
 * @param {object} ticket
 * @param {{status: string, text: string, at?: number|string}} report
 * @param {CardContext} [ctx]
 */
export function reportRelayText(ticket, report, ctx = {}) {
  const bot = handleOf(ctx.bots, ticket.botId);
  const status = report?.status ?? 'progress';
  const body = clip(String(report?.text ?? '').trim(), REPORT_CHARS);
  const lines = [`Report from ${bot} on task ${ticket.id} — status: ${status}`, body.text || '(empty report)'];
  if (body.chars) lines.push(`[${REPORT_CHARS} of ${body.chars} characters shown. Read the whole report with ${recallHint(`ticket/${ticket.id}/reports`)}.]`);
  lines.push('', `Task: ${JSON.stringify(ticketCard(ticket, ctx))}`, (NEXT_STEP[status] ?? NEXT_STEP.progress)(ticket, bot));
  return lines.join('\n');
}

/**
 * The first message a worker reads in its ticket session: the task, up to
 * 1500 characters of the assignment, who asked and from where, and how to
 * report.
 * @param {object} ticket
 * @param {CardContext} [ctx]
 */
export function assignmentText(ticket, ctx = {}) {
  const body = clip(String(ticket.text ?? '').trim(), ASSIGNMENT_CHARS);
  const origin = originPhrase(ticket, ctx.threads);
  const lines = [`New task ${ticket.id} from ${requesterPhrase(ticket, ctx.bots)}: ${String(ticket.title ?? '').trim()}`];
  if (origin) lines.push(`It started with ${origin}.`);
  lines.push('', body.text || '(no details: the title is the whole task)');
  if (body.chars) lines.push(`[${ASSIGNMENT_CHARS} of ${body.chars} characters shown. Read the rest with ${recallHint(`ticket/${ticket.id}/text`)}.]`);
  lines.push(
    '',
    'Report with bot_send_message (leave out "to") and a status: "done" with the result when you are finished, "progress" for an update worth keeping, "question" when you need an answer, "blocked" when you cannot go on. Your plain text reaches no one.',
  );
  return lines.join('\n');
}

/** `t1 (@coder, working: Fix the login bug)` for notices. */
function ticketPhrase(t, ctx) {
  const stage = stageIn(t, { ...ctx, stage: undefined });
  return `${t.id} (${handleOf(ctx.bots, t.botId)}${stage ? `, ${stage}` : ''}: ${String(t.title ?? '').trim()})`;
}

/**
 * What the router gets injected (without waking) when a person's follow-up
 * on a subscribed thread went straight to the tickets.
 * @param {{tickets: object[], thread?: string|object, who?: string, via?: string, text: string}} notice
 * @param {CardContext} [ctx]
 */
export function followUpNoticeText(notice, ctx = {}) {
  const tickets = notice?.tickets ?? [];
  const key = typeof notice?.thread === 'string' ? notice.thread : notice?.thread?.key;
  const thread = typeof notice?.thread === 'object' && notice.thread ? notice.thread : threadOf(ctx.threads, key);
  const where = [thread?.label ? `in ${thread.label}` : '', notice?.via ? `(${notice.via})` : ''].filter(Boolean).join(' ');
  const noun = tickets.length === 1 ? 'task' : 'tasks';
  return [
    `[follow_up] ${notice?.who || 'Someone'}${where ? ` ${where}` : ''} wrote about ${noun} ${tickets.map((t) => ticketPhrase(t, ctx)).join(', ')}${key ? ` on thread ${key}` : ''}:`,
    quote(clip(String(notice?.text ?? '').trim(), PREVIEW_CHARS).text),
    `It went to the ${noun} directly and needs no reply from you. Stop a task with bot_ticket only if the person asks to stop it.`,
  ].join('\n');
}

/**
 * Prepended when a ticket that was working is restarted after Harness came
 * back: look before repeating anything that left the conversation.
 * @param {object} ticket
 */
export function recoveryNoteText(ticket) {
  return [
    `[Recovery] DeepSeek Harness restarted while you were working on task ${ticket.id}: ${quote(String(ticket.title ?? '').trim())}.`,
    'Before you go on, check what you already did: files in the working directory, commands you ran, messages, posts or commits you sent, anything outside this conversation. Do not repeat an outside action that already happened.',
    'Then continue where you left off, and report with bot_send_message as usual.',
  ].join('\n');
}

/**
 * The one status check a quiet worker gets from the watchdog.
 * @param {object} ticket
 */
export function nudgeText(ticket) {
  return [
    `[Status check] Task ${ticket.id} (${quote(String(ticket.title ?? '').trim())}) has had no report for a while and nothing is running.`,
    'Report now with bot_send_message: "done" with the result if it is finished, "progress" with what is left if you are still on it, "blocked" or "question" if you are stuck. Without a report the task is marked stalled.',
  ].join('\n');
}

/**
 * What the requester reads when the watchdog marks a ticket stalled.
 * @param {object} ticket
 * @param {CardContext} [ctx]
 */
export function stalledNoticeText(ticket, ctx = {}) {
  return [
    `[Stalled] Task ${ticket.id} (${handleOf(ctx.bots, ticket.botId)}: ${String(ticket.title ?? '').trim()}) stopped making progress: its conversation is idle, nothing runs in the background, and it did not answer a status check.`,
    `Decide what to do: send it a message with bot_send_message (ticket: ${quote(ticket.id)}), retry or stop it with bot_ticket, or tell the person.`,
  ].join('\n');
}

/**
 * What the requester reads when a ticket failed for good (retries used up).
 * @param {object} ticket
 * @param {CardContext} [ctx]
 */
export function failedNoticeText(ticket, ctx = {}) {
  const why = ticket.error ? ` Last error: ${clip(String(ticket.error).trim(), PREVIEW_CHARS).text}` : '';
  return [
    `[Failed] Task ${ticket.id} (${handleOf(ctx.bots, ticket.botId)}: ${String(ticket.title ?? '').trim()}) failed.${why}`,
    'Retry it with bot_ticket, hand it to another bot, or tell the person.',
  ].join('\n');
}

/**
 * The "continue" a worker gets after a temporary error, before retries run out.
 * @param {object} ticket
 * @param {{attempt?: number, error?: string}} [info]
 */
export function retryText(ticket, info = {}) {
  const why = info.error ? ` (${clip(String(info.error).trim(), PREVIEW_CHARS).text})` : '';
  return `[Retry${info.attempt ? ` ${info.attempt}` : ''}] The last step of task ${ticket.id} failed with a temporary error${why}. Continue where you left off; do not repeat outside actions that already went through.`;
}

/**
 * The one reminder a requester gets when every ticket it waited for has
 * settled and it has not told anyone.
 * @param {object[]} tickets
 * @param {CardContext} [ctx]
 */
export function reminderText(tickets, ctx = {}) {
  return [
    `[Reminder] Every task you were waiting for has settled: ${(tickets ?? []).map((t) => ticketPhrase(t, ctx)).join(', ')}.`,
    'Tell whoever asked what came of them; bot_recall reads the details.',
  ].join('\n');
}

const RANK = { question: 0, stalled: 0, working: 0, queued: 0, failed: 1, done: 2, stopped: 2 };
/** Open tickets first, then failed, then ended, archived last; newest first within each. */
function sortTickets(tickets, ctx) {
  const rank = (t, stage) => (t.archivedAt ? 3 : RANK[stage] ?? (t.ended ? 2 : 0));
  return tickets
    .map((t) => ({ t, stage: stageIn(t, ctx) }))
    .sort((a, b) => rank(a.t, a.stage) - rank(b.t, b.stage) || (toMs(b.t.updatedAt) || 0) - (toMs(a.t.updatedAt) || 0));
}

function itemPage(entries, offset, limit, row) {
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.min(MAX_ITEMS, Math.max(1, Math.floor(Number(limit) || PAGE_ITEMS)));
  const end = Math.min(entries.length, start + size);
  const page = { items: entries.slice(start, end).map(row), total: entries.length };
  if (end < entries.length) page.next_offset = end;
  return page;
}

function textPage(text, offset, size = PAGE_CHARS) {
  const total = text.length;
  const start = Math.min(total, Math.max(0, Math.floor(Number(offset) || 0)));
  let end = Math.min(total, start + size);
  if (end < total && end > start + 1) {
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  }
  return compact({ text: text.slice(start, end), offset: start, chars: total, next_offset: end < total ? end : undefined });
}

/** `tickets` · `ticket/<id>[/text|/reports|/transcript]` · `thread/<key>` · `bot/<handle>`; also `task/…`, a bare ticket id and `@handle`. */
function parseRef(ref) {
  const s = String(ref ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (/^(?:tickets|tasks)$/i.test(s)) return { kind: 'tickets' };
  let m = /^(?:tickets?|tasks?)\/([^/\s]+)(?:\/(text|reports|transcript))?$/i.exec(s);
  if (m) return { kind: m[2]?.toLowerCase() ?? 'ticket', id: m[1] };
  m = /^threads?\/(.+)$/i.exec(s);
  if (m) return { kind: 'thread', key: m[1] };
  m = /^(?:bots?\/)?@([^/\s]+)$/.exec(s) ?? /^bots?\/([^/\s]+)$/i.exec(s);
  if (m) return { kind: 'bot', handle: m[1] };
  if (/^t[0-9a-z]{8}$/.test(s)) return { kind: 'ticket', id: s };
  return undefined;
}

const REFS = 'tickets, ticket/<id>, ticket/<id>/text, ticket/<id>/reports, ticket/<id>/transcript, thread/<key> or bot/<handle>';

/** What a ticket viewer may read: its ticket, the parent, the children, and its threads. Others read everything (null). */
function scopeOf(viewer, view) {
  if (viewer?.kind !== 'ticket') return null;
  const self = viewer.ticketId ? view.get(viewer.ticketId) : undefined;
  if (!self) throw new Error(`bot_recall: this conversation's task${viewer.ticketId ? ` ${viewer.ticketId}` : ''} is not on record.`);
  const ids = new Set([self.id]);
  const parent = parentOf(self);
  if (parent) ids.add(parent);
  for (const c of view.children(self.id)) if (c?.id) ids.add(c.id);
  const threads = new Set([...(self.threads ?? []), self.origin?.threadKey].filter(Boolean));
  return { self, ids, threads };
}

/** A card as a ticket viewer sees it: only ids it can read (no sibling tasks, no threads it is not on). */
function scoped(card, scope) {
  if (!scope) return card;
  const out = { ...card };
  if (out.children) out.children = out.children.filter((id) => scope.ids.has(id));
  if (out.threads) out.threads = out.threads.filter((k) => scope.threads.has(k));
  if (out.origin?.thread && !scope.threads.has(out.origin.thread)) {
    const { thread, ...rest } = out.origin;
    out.origin = rest;
  }
  return compact(out);
}

const outOfScope = (what, scope) =>
  new Error(`bot_recall: ${what} is outside this task. From task ${scope.self.id} you can read that task, its parent and its sub-tasks, and the threads it belongs to.`);

function reportsText(t) {
  const reports = Array.isArray(t.reports) ? t.reports : [];
  if (reports.length === 0) return `No reports on task ${t.id} yet.`;
  return [...reports]
    .reverse()
    .map((r) => `--- ${[iso(r.at), r.status].filter(Boolean).join(' · ')} ---\n${String(r.text ?? '').trim()}`)
    .join('\n\n');
}

function transcriptText(raw) {
  if (typeof raw === 'string') return raw;
  return (Array.isArray(raw) ? raw : [])
    .map((e) => (typeof e === 'string' ? e : `${e?.role ?? e?.who ?? 'message'}: ${String(e?.text ?? '').trim()}`))
    .join('\n\n');
}

/**
 * The reader behind `bot_recall`. Lists come in pages of 20 items (`limit` up
 * to 50) and text in pages of 4000 characters; a page that is not the last
 * carries `next_offset`. Throws an Error with a model-facing message for an
 * unknown ref, a missing ticket/thread/bot, or a ref a ticket viewer may not
 * read.
 *
 * | ref | result |
 * | --- | --- |
 * | `tickets` | `{items: rows, total, next_offset?}`, open tickets first |
 * | `ticket/<id>` | `{card, text, chars?, more}`: the card, a preview of the assignment, and the refs below |
 * | `ticket/<id>/text` | the full assignment, paged |
 * | `ticket/<id>/reports` | every report, newest first, paged |
 * | `ticket/<id>/transcript` | the ticket session's transcript, paged |
 * | `thread/<key>` | `{thread, items: subscribed tickets, total, recent?}` |
 * | `bot/<handle>` | `{bot, items: its tickets, total}`, open ones first |
 *
 * @param {string} ref
 * @param {object} opts
 * @param {Viewer} [opts.viewer] - who reads; a ticket viewer is limited to its own ticket, the parent, the children and its threads, and the cards it gets leave out ids beyond those. Absent means unrestricted.
 * @param {TicketsView|object[]} opts.tickets
 * @param {ThreadsView} [opts.threads]
 * @param {object[]|Map|Function} [opts.bots]
 * @param {(ticket: object, opts: {now: number}) => string} [opts.stageOf]
 * @param {(ticket: object) => string|Array<object|string>|Promise<string|Array<object|string>>} [opts.transcript] - the ticket session's messages.
 * @param {number} [opts.offset]
 * @param {number} [opts.limit] - list page size, 1–50.
 * @param {number} [opts.now]
 * @returns {Promise<object>}
 */
export async function readResource(ref, opts = {}) {
  const now = opts.now ?? Date.now();
  const view = ticketsView(opts.tickets);
  const threads = opts.threads;
  const ctx = { bots: opts.bots, threads, stageOf: opts.stageOf, tickets: view, now };
  const scope = scopeOf(opts.viewer, view);
  const r = parseRef(ref);
  if (!r) throw new Error(`bot_recall: unknown ref ${quote(ref)}. Use ${REFS}.`);
  const refText = r.kind === 'tickets' ? 'tickets' : r.kind === 'thread' ? `thread/${r.key}` : r.kind === 'bot' ? `bot/${r.handle}` : r.kind === 'ticket' ? `ticket/${r.id}` : `ticket/${r.id}/${r.kind}`;
  const rows = (entries) => itemPage(entries, opts.offset, opts.limit, ({ t, stage }) => scoped(ticketRow(t, { ...ctx, stage }), scope));

  if (r.kind === 'tickets') {
    const all = view.list().filter((t) => !scope || scope.ids.has(t.id));
    return { ref: refText, ...rows(sortTickets(all, ctx)) };
  }

  if (r.kind === 'bot') {
    const want = r.handle.toLowerCase();
    const list = Array.isArray(opts.bots) ? opts.bots : opts.bots instanceof Map ? [...opts.bots.values()] : [];
    const bot = list.find((b) => String(b.handle ?? '').toLowerCase() === want || b.id === r.handle);
    if (!bot) throw new Error(`bot_recall: no bot @${r.handle}. bot_list shows the team.`);
    const mine = view.list().filter((t) => t.botId === bot.id && (!scope || scope.ids.has(t.id)));
    return {
      ref: refText,
      bot: compact({ handle: `@${bot.handle}`, name: bot.name, bio: bot.bio, dispatcher: bot.role === 'primary' ? true : undefined }),
      ...rows(sortTickets(mine, ctx)),
    };
  }

  if (r.kind === 'thread') {
    if (scope && !scope.threads.has(r.key)) throw outOfScope(`thread ${r.key}`, scope);
    const thread = threadOf(threads, r.key);
    if (!thread) throw new Error(`bot_recall: no thread ${r.key}.`);
    const subs = typeof threads?.subscribers === 'function' ? threads.subscribers(r.key) ?? [] : thread.tickets ?? [];
    const subscribed = subs
      .map((s) => (typeof s === 'string' ? view.get(s) : s))
      .filter((t) => t && (!scope || scope.ids.has(t.id)));
    const recent = typeof threads?.recent === 'function' ? (await threads.recent(r.key)) ?? [] : [];
    const out = {
      ref: refText,
      thread: compact({ key: thread.key ?? r.key, kind: thread.kind, label: thread.label, last_at: iso(thread.lastAt) }),
      ...rows(sortTickets(subscribed, ctx)),
    };
    if (recent.length) out.recent = recent.slice(-RECENT_MESSAGES).map((m) => compact({ at: iso(m.at), who: m.who, text: clip(String(m.text ?? '').trim(), PREVIEW_CHARS * 1.5).text }));
    return out;
  }

  if (scope && !scope.ids.has(r.id)) throw outOfScope(`task ${r.id}`, scope);
  const t = view.get(r.id);
  if (!t) throw new Error(`bot_recall: no task ${r.id}. bot_recall {"ref":"tickets"} lists them.`);

  if (r.kind === 'ticket') {
    const text = clip(String(t.text ?? '').trim(), PREVIEW_CHARS);
    return compact({
      ref: refText,
      card: scoped(ticketCard(t, ctx), scope),
      text: text.text,
      chars: text.chars,
      more: [`ticket/${t.id}/text`, `ticket/${t.id}/reports`, `ticket/${t.id}/transcript`],
    });
  }
  if (r.kind === 'text') return { ref: refText, ...textPage(String(t.text ?? '').trim(), opts.offset) };
  if (r.kind === 'reports') return { ref: refText, ...textPage(reportsText(t), opts.offset) };
  // transcript
  if (!t.sessionId) throw new Error(`bot_recall: task ${t.id} has not started yet, so it has no transcript.`);
  if (typeof opts.transcript !== 'function') throw new Error(`bot_recall: the transcript of task ${t.id} cannot be read here.`);
  return { ref: refText, ...textPage(transcriptText(await opts.transcript(t)), opts.offset) };
}
