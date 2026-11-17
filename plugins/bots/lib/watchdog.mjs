/**
 * The ticket watchdog's rules, deterministic only: which errors are worth a
 * retry and when, which quiet workers get a status check or are marked
 * stalled, and which requesters get one reminder. The host gathers the facts
 * (stage, session status, background jobs) and carries out the actions; no
 * model judges anything here.
 *
 * @module @kadaliao/dsh-bots/lib/watchdog
 */

/** Delays before the 1st, 2nd and 3rd "continue" after a temporary error; then the ticket fails. */
export const RETRY_DELAYS_MS = Object.freeze([15_000, 30_000, 60_000]);

/** Default minutes without events (or without a report after a status check) before the watchdog acts. */
export const STALL_MINUTES = 20;

/** Stages in which a requester has nothing left to wait for. */
export const SETTLED_STAGES = Object.freeze(['done', 'failed', 'stopped', 'stalled']);

/**
 * The delay before the next retry, given how many were already made;
 * undefined once they are used up (the ticket then fails).
 * @param {number} retries
 * @returns {number|undefined}
 */
export function retryDelay(retries) {
  const n = Math.max(0, Math.floor(Number(retries) || 0));
  return RETRY_DELAYS_MS[n];
}

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const transientStatus = (s) => s === 408 || s === 429 || (s >= 500 && s <= 599);

/** "status code 503", "HTTP 429", "Error: 502", or a message that starts with the status ("529 Overloaded", "APIError: 500 …"). */
const STATUS_IN_TEXT = [/\b(?:status(?:\s+code)?|http(?:\/\d(?:\.\d)?)?|error|code)\s*[:=]?\s*(\d{3})\b/i, /^\s*(?:[A-Za-z]*Error:\s*)?(\d{3})\b/];
const TRANSIENT_TEXT =
  /\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE|EAI_AGAIN|ENETDOWN|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)\b|connection (?:was )?(?:refused|reset|closed|aborted|timed out)|socket hang up|\btimed out\b|\btimeout\b|rate.?limit|too many requests|overloaded|service unavailable|bad gateway|gateway time-?out|internal server error|temporarily unavailable|fetch failed|network error|premature close/i;

/** Out of money or quota: some providers send these as 429, but waiting does not help. */
const NOT_TRANSIENT_TEXT = /insufficient[_ ](?:quota|balance|funds)|billing/i;

/** true / false when the text says, undefined when it does not. */
function textVerdict(text) {
  if (NOT_TRANSIENT_TEXT.test(text)) return false;
  for (const re of STATUS_IN_TEXT) {
    const m = re.exec(text);
    if (m) {
      const n = Number(m[1]);
      if (n >= 100 && n <= 599) return transientStatus(n);
    }
  }
  return TRANSIENT_TEXT.test(text) ? true : undefined;
}

/**
 * Is an error worth retrying: HTTP 408, 429 or 5xx, or a refused, reset or
 * timed-out connection? Accepts Error objects (their `cause` too), `{status}`
 * / `{statusCode}` / `{response: {status}}`, `{code}`, `{error: …}` wrappers,
 * a bare status number, and message strings. A known status decides on its
 * own, except that running out of quota or balance is never transient (some
 * providers send it as 429), nor is an AbortError (someone stopped the run).
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransient(error) {
  return verdict(error, 0) === true;
}

function verdict(error, depth) {
  if (error === null || error === undefined || depth > 4) return undefined;
  if (typeof error === 'string') return textVerdict(error);
  if (typeof error === 'number') return transientStatus(error);
  if (typeof error !== 'object') return undefined;
  if (error.name === 'AbortError') return false;
  if ([error.code, error.type, error.message].some((s) => typeof s === 'string' && NOT_TRANSIENT_TEXT.test(s))) return false;
  const status = Number(error.status ?? error.statusCode ?? error.response?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return transientStatus(status);
  if (typeof error.code === 'number' && error.code >= 100 && error.code <= 599) return transientStatus(error.code);
  if (typeof error.code === 'string' && TRANSIENT_CODES.has(error.code.toUpperCase())) return true;
  if (error.name === 'TimeoutError') return true;
  const said = typeof error.message === 'string' ? textVerdict(error.message) : undefined;
  if (said === false) return false;
  for (const inner of [error.cause, error.error]) {
    const v = verdict(inner, depth + 1);
    if (v !== undefined) return v;
  }
  if (said !== undefined) return said;
  if (typeof error.code === 'string') return textVerdict(error.code);
  return undefined;
}

const toMs = (v) => (typeof v === 'number' ? v : v ? Date.parse(v) : NaN);
/** The latest of some timestamps (numbers or ISO strings), NaN when none is set. */
function latest(...values) {
  const ms = values.map(toMs).filter(Number.isFinite);
  return ms.length ? Math.max(...ms) : NaN;
}
const lastReportAt = (t) => latest(...(Array.isArray(t.reports) ? t.reports.map((r) => r?.at) : []));

/**
 * The watchdog pass over working tickets (PLAN-0.8 §4.5). Only a ticket in
 * stage `working` whose session is idle with no background jobs is looked
 * at; queued, question and ended tickets are never touched.
 *
 * - Quiet for `stallMinutes` (no session event, report, or message from a
 *   person or the requester; counted from the start when there was none) and
 *   not yet checked → one `nudge` (the host sends the status check and sets
 *   `nudgedAt`).
 * - Checked, and `stallMinutes` since the check went by without a report or
 *   such a message → `stall` (the host sets `stalledAt` and tells the
 *   requester). A report or a message (`lastHumanAt`, `lastRequesterAt`)
 *   after the check answers it; the next quiet spell may get its own check.
 *
 * @param {Array<{ticket: object, stage: string, agentStatus: 'running'|'idle'|'offline', backgroundJobs?: number}>} items
 * @param {{stallMinutes?: number}} [rules]
 * @param {number} [now]
 * @returns {Array<{kind: 'nudge'|'stall', ticketId: string, quietMinutes: number}>}
 */
export function checkTickets(items, rules = {}, now = Date.now()) {
  const stallMs = Math.max(1, Number(rules.stallMinutes) || STALL_MINUTES) * 60_000;
  const actions = [];
  for (const item of items ?? []) {
    const t = item?.ticket;
    if (!t?.id || item.stage !== 'working' || t.ended || t.archivedAt) continue;
    if (item.agentStatus !== 'idle' || Number(item.backgroundJobs ?? 0) > 0) continue;
    const reportAt = lastReportAt(t);
    const humanAt = latest(t.lastHumanAt, t.lastRequesterAt);
    const nudgedAt = toMs(t.nudgedAt);
    const answered = Number.isFinite(nudgedAt) && (reportAt > nudgedAt || humanAt > nudgedAt);
    if (Number.isFinite(nudgedAt) && !answered) {
      if (now - nudgedAt >= stallMs) actions.push({ kind: 'stall', ticketId: t.id, quietMinutes: Math.floor((now - nudgedAt) / 60_000) });
      continue;
    }
    const last = latest(t.lastEventAt, reportAt, humanAt, t.startedAt, t.createdAt);
    if (Number.isFinite(last) && now - last >= stallMs) actions.push({ kind: 'nudge', ticketId: t.id, quietMinutes: Math.floor((now - last) / 60_000) });
  }
  return actions;
}

/** When a settled ticket settled: its end, the stall, or its last report. */
function settledAt(t) {
  const at = latest(t.ended?.at, t.stalledAt, lastReportAt(t));
  return Number.isFinite(at) ? at : latest(t.updatedAt, t.createdAt);
}

/**
 * Requesters to remind once: every unarchived ticket a requester session
 * asked for is settled (done, failed, stopped, stalled), the session is idle,
 * and it has said nothing (no report to its own asker, no reply to the
 * person) since the last of them settled. `ticketIds` lists the tickets that
 * settled after its last word or reminder. The host records `remindedAt`
 * after reminding, which keeps it to once per batch.
 *
 * Tickets requested by the user (requester.kind 'user') have no session to
 * remind and are skipped. A grace period (default 1 minute) leaves time for
 * the relay of the last report to wake the requester first.
 *
 * @param {Array<{ticket: object, stage: string}>} items - tickets with their stages; archived ones are ignored.
 * @param {Map<string, object>|Record<string, object>|((sessionId: string) => object|undefined)} requesters -
 *   per requester session: `{status: 'running'|'idle'|'offline', reportedAt?, remindedAt?}`.
 * @param {number} [now]
 * @param {{graceMs?: number}} [rules]
 * @returns {Array<{sessionId: string, botId?: string, ticketIds: string[]}>}
 */
export function requesterReminders(items, requesters, now = Date.now(), rules = {}) {
  const graceMs = Math.max(0, Number(rules.graceMs ?? 60_000));
  const factsOf = (id) =>
    typeof requesters === 'function' ? requesters(id) : requesters instanceof Map ? requesters.get(id) : requesters?.[id];
  const groups = new Map();
  for (const item of items ?? []) {
    const t = item?.ticket;
    const r = t?.requester;
    if (!t?.id || t.archivedAt || r?.kind !== 'session' || !r.sessionId) continue;
    if (!groups.has(r.sessionId)) groups.set(r.sessionId, []);
    groups.get(r.sessionId).push(item);
  }
  const out = [];
  for (const [sessionId, list] of groups) {
    if (!list.every((it) => SETTLED_STAGES.includes(it.stage))) continue;
    const facts = factsOf(sessionId);
    if (facts?.status !== 'idle') continue;
    const told = latest(facts.reportedAt, facts.remindedAt);
    const fresh = list.filter((it) => !(settledAt(it.ticket) <= told));
    if (fresh.length === 0) continue;
    const last = latest(...fresh.map((it) => settledAt(it.ticket)));
    if (Number.isFinite(last) && now - last < graceMs) continue;
    const botId = list[0].ticket.requester.botId;
    out.push({ sessionId, ...(botId ? { botId } : {}), ticketIds: fresh.map((it) => it.ticket.id) });
  }
  return out;
}
