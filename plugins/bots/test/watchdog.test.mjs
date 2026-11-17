import assert from 'node:assert/strict';
import test from 'node:test';

import { RETRY_DELAYS_MS, SETTLED_STAGES, checkTickets, isTransient, requesterReminders, retryDelay } from '../lib/watchdog.mjs';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (min) => NOW - min * 60_000;
const isoAgo = (min) => new Date(ago(min)).toISOString();

test('transient errors: HTTP 408, 429 and 5xx', () => {
  for (const status of [408, 429, 500, 502, 503, 504, 529]) assert.equal(isTransient({ status }), true, String(status));
  for (const status of [400, 401, 403, 404, 413, 422]) assert.equal(isTransient({ status }), false, String(status));
  assert.equal(isTransient({ statusCode: 503 }), true);
  assert.equal(isTransient({ response: { status: 502 } }), true);
  assert.equal(isTransient({ code: 503 }), true);
  assert.equal(isTransient(503), true);
  assert.equal(isTransient(401), false);
  const e = new Error('Service Unavailable');
  e.status = 503;
  assert.equal(isTransient(e), true);
  const bad = new Error('upstream timeout');
  bad.status = 400;
  assert.equal(isTransient(bad), false, 'a known status decides on its own');
});

test('transient errors: refused, reset and timed-out connections', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']) {
    assert.equal(isTransient({ code }), true, code);
    const err = new Error(`connect ${code} 127.0.0.1:443`);
    err.code = code;
    assert.equal(isTransient(err), true, `Error ${code}`);
  }
  assert.equal(isTransient({ code: 'ENOENT' }), false);
  assert.equal(isTransient({ code: 'ENOTFOUND' }), false);
  // Node fetch: TypeError('fetch failed') with the socket error as cause.
  assert.equal(isTransient(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })), true);
  assert.equal(isTransient(new Error('wrapped', { cause: { status: 504 } })), true);
  assert.equal(isTransient({ error: { status: 500, message: 'oops' } }), true, 'event data wrapper');
  assert.equal(isTransient({ error: { message: 'Invalid API key' } }), false);
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  assert.equal(isTransient(timeout), true);
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  assert.equal(isTransient(abort), false, 'someone stopped the run');
});

test('transient errors: message strings', () => {
  for (const s of [
    '503 Service Unavailable',
    'APIError: 529 overloaded_error',
    'Request failed with status code 502',
    'HTTP 429 Too Many Requests',
    'status: 500',
    'Error: 504 Gateway Timeout',
    'read ECONNRESET',
    'connect ECONNREFUSED 127.0.0.1:8080',
    'socket hang up',
    'Connection reset by peer',
    'The request timed out',
    'Rate limit reached for requests',
    'The server is overloaded, please try again',
    'fetch failed',
  ]) assert.equal(isTransient(s), true, s);
  for (const s of [
    '400 Bad Request: invalid timeout parameter',
    'HTTP 401 Unauthorized',
    'Invalid API key',
    'This model maximum context length is 65536 tokens',
    '429 You exceeded your current quota: insufficient_quota',
    'Insufficient Balance',
    'Model limit is 500 tokens per minute? no: just text',
    '',
  ]) assert.equal(isTransient(s), false, s);
  assert.equal(isTransient({ status: 429, code: 'insufficient_quota' }), false, 'out of quota does not clear by waiting');
  assert.equal(isTransient({ code: 'rate_limit_exceeded' }), true);
  for (const v of [null, undefined, 0, true, {}, []]) assert.equal(isTransient(v), false, String(v));
});

test('retries wait 15, 30, 60 seconds, then stop', () => {
  assert.deepEqual([...RETRY_DELAYS_MS], [15_000, 30_000, 60_000]);
  assert.equal(retryDelay(0), 15_000);
  assert.equal(retryDelay(1), 30_000);
  assert.equal(retryDelay(2), 60_000);
  assert.equal(retryDelay(3), undefined);
  assert.equal(retryDelay(9), undefined);
  assert.equal(retryDelay(undefined), 15_000);
  assert.equal(retryDelay(-1), 15_000);
  assert.ok(Object.isFrozen(RETRY_DELAYS_MS));
});

/** A working ticket whose session was last active `quiet` minutes ago. */
const working = (id, quiet, over = {}) => ({
  ticket: { id, startedAt: ago(120), createdAt: ago(121), lastEventAt: ago(quiet), reports: [], ...over },
  stage: 'working',
  agentStatus: 'idle',
  backgroundJobs: 0,
});

test('a quiet working ticket gets one status check after stallMinutes', () => {
  const rules = { stallMinutes: 20 };
  assert.deepEqual(checkTickets([working('t1', 19)], rules, NOW), []);
  assert.deepEqual(checkTickets([working('t1', 20)], rules, NOW), [{ kind: 'nudge', ticketId: 't1', quietMinutes: 20 }]);
  assert.deepEqual(checkTickets([working('t1', 45)], {}, NOW), [{ kind: 'nudge', ticketId: 't1', quietMinutes: 45 }], 'default 20 minutes');
  assert.deepEqual(checkTickets([working('t1', 12)], { stallMinutes: 10 }, NOW).map((a) => a.kind), ['nudge']);
  // ISO strings work as well as numbers.
  assert.equal(checkTickets([working('t1', 25, { lastEventAt: isoAgo(25) })], rules, NOW).length, 1);
  // Without events, the start counts.
  assert.equal(checkTickets([working('t1', 0, { lastEventAt: undefined, startedAt: ago(30) })], rules, NOW).length, 1);
  assert.equal(checkTickets([working('t1', 0, { lastEventAt: undefined, startedAt: ago(5) })], rules, NOW).length, 0);
  // A recent report or human message keeps it quiet-free.
  assert.equal(checkTickets([working('t1', 30, { reports: [{ at: ago(3), status: 'progress', text: '…' }] })], rules, NOW).length, 0);
  assert.equal(checkTickets([working('t1', 30, { lastHumanAt: ago(3) })], rules, NOW).length, 0);
});

test('the watchdog leaves busy, offline and non-working tickets alone', () => {
  const rules = { stallMinutes: 20 };
  const quiet = (over) => ({ ...working('t1', 90), ...over });
  assert.deepEqual(checkTickets([quiet({ agentStatus: 'running' })], rules, NOW), []);
  assert.deepEqual(checkTickets([quiet({ agentStatus: 'offline' })], rules, NOW), []);
  assert.deepEqual(checkTickets([quiet({ backgroundJobs: 1 })], rules, NOW), []);
  for (const stage of ['queued', 'question', 'done', 'stopped', 'failed', 'stalled']) assert.deepEqual(checkTickets([quiet({ stage })], rules, NOW), [], stage);
  const ended = working('t1', 90, { ended: { at: ago(80), by: 'worker', outcome: 'done' } });
  assert.deepEqual(checkTickets([ended], rules, NOW), []);
  assert.deepEqual(checkTickets([working('t1', 90, { archivedAt: ago(1) })], rules, NOW), []);
  assert.deepEqual(checkTickets([null, {}, { ticket: {} }], rules, NOW), []);
  assert.deepEqual(checkTickets(undefined, rules, NOW), []);
});

test('a checked ticket that still does not report is marked stalled', () => {
  const rules = { stallMinutes: 20 };
  // Nudged 10 minutes ago, the worker ran (events) but did not report: wait.
  assert.deepEqual(checkTickets([working('t1', 5, { nudgedAt: ago(10) })], rules, NOW), []);
  // Another full cycle since the check, no report: stall, even though the nudge woke it.
  assert.deepEqual(checkTickets([working('t1', 2, { nudgedAt: ago(20) })], rules, NOW), [{ kind: 'stall', ticketId: 't1', quietMinutes: 20 }]);
  // Never a second nudge for the same quiet spell.
  assert.ok(checkTickets([working('t1', 60, { nudgedAt: ago(19) })], rules, NOW).every((a) => a.kind !== 'nudge'));
  // A report after the check answers it; the next quiet spell gets its own check.
  const answered = working('t1', 30, { nudgedAt: ago(40), reports: [{ at: ago(30), status: 'progress', text: 'still on it' }] });
  assert.deepEqual(checkTickets([answered], rules, NOW), [{ kind: 'nudge', ticketId: 't1', quietMinutes: 30 }]);
  const answeredRecently = working('t1', 5, { nudgedAt: ago(40), reports: [{ at: ago(5), status: 'progress', text: '…' }] });
  assert.deepEqual(checkTickets([answeredRecently], rules, NOW), []);
  // A human message after the check counts as an answer too.
  assert.deepEqual(checkTickets([working('t1', 2, { nudgedAt: ago(30), lastHumanAt: ago(2) })], rules, NOW), []);
  assert.deepEqual(checkTickets([working('t1', 2, { nudgedAt: ago(30), lastRequesterAt: ago(2) })], rules, NOW), [], 'so does a requester message');
  // Still running after the check: leave it.
  assert.deepEqual(checkTickets([{ ...working('t1', 0, { nudgedAt: ago(60) }), agentStatus: 'running' }], rules, NOW), []);
});

test('several tickets get their own actions', () => {
  const actions = checkTickets(
    [working('a', 30), working('b', 1), working('c', 1, { nudgedAt: ago(25) }), { ...working('d', 50), stage: 'queued' }],
    { stallMinutes: 20 },
    NOW,
  );
  assert.deepEqual(actions.map((a) => `${a.kind}:${a.ticketId}`), ['nudge:a', 'stall:c']);
});

/** A settled (or not) ticket requested by a session. */
const asked = (id, stage, over = {}) => ({
  ticket: {
    id,
    requester: { kind: 'session', sessionId: 'home-atlas', botId: 'b-atlas' },
    reports: [],
    updatedAt: ago(10),
    ...(stage === 'done' ? { ended: { at: ago(10), by: 'worker', outcome: 'done' } } : {}),
    ...over,
  },
  stage,
});

test('a requester whose tickets have all settled is reminded once', () => {
  const idle = { 'home-atlas': { status: 'idle' } };
  const items = [asked('t1', 'done'), asked('t2', 'failed', { ended: { at: ago(12), outcome: 'failed' } }), asked('t3', 'stalled', { stalledAt: ago(15) }), asked('t4', 'stopped')];
  assert.deepEqual(SETTLED_STAGES, ['done', 'failed', 'stopped', 'stalled']);
  assert.deepEqual(requesterReminders(items, idle, NOW), [{ sessionId: 'home-atlas', botId: 'b-atlas', ticketIds: ['t1', 't2', 't3', 't4'] }]);
  // A Map or a function works as well.
  assert.equal(requesterReminders(items, new Map(Object.entries(idle)), NOW).length, 1);
  assert.equal(requesterReminders(items, (id) => idle[id], NOW).length, 1);
  // Once: after the reminder is recorded, nothing until something else settles.
  assert.deepEqual(requesterReminders(items, { 'home-atlas': { status: 'idle', remindedAt: ago(5) } }, NOW), []);
  const later = [...items, asked('t5', 'done', { ended: { at: ago(2), outcome: 'done' } })];
  assert.deepEqual(requesterReminders(later, { 'home-atlas': { status: 'idle', remindedAt: ago(5) } }, NOW), [
    { sessionId: 'home-atlas', botId: 'b-atlas', ticketIds: ['t5'] },
  ]);
});

test('no reminder while anything is open, the requester is busy, or it already reported', () => {
  const idle = { 'home-atlas': { status: 'idle' } };
  for (const stage of ['working', 'queued', 'question']) assert.deepEqual(requesterReminders([asked('t1', 'done'), asked('t2', stage)], idle, NOW), [], stage);
  assert.deepEqual(requesterReminders([asked('t1', 'done')], { 'home-atlas': { status: 'running' } }, NOW), []);
  assert.deepEqual(requesterReminders([asked('t1', 'done')], { 'home-atlas': { status: 'offline' } }, NOW), []);
  assert.deepEqual(requesterReminders([asked('t1', 'done')], {}, NOW), [], 'unknown requester');
  assert.deepEqual(requesterReminders([asked('t1', 'done')], { 'home-atlas': { status: 'idle', reportedAt: ago(5) } }, NOW), []);
  assert.deepEqual(requesterReminders([asked('t1', 'done')], { 'home-atlas': { status: 'idle', reportedAt: isoAgo(5) } }, NOW), [], 'ISO times');
  // Reported before the ticket settled: still owed.
  assert.equal(requesterReminders([asked('t1', 'done')], { 'home-atlas': { status: 'idle', reportedAt: ago(30) } }, NOW).length, 1);
  // Grace: the relay of the last report gets a minute to wake the requester.
  assert.deepEqual(requesterReminders([asked('t1', 'done', { ended: { at: NOW - 30_000, outcome: 'done' } })], idle, NOW), []);
  assert.equal(requesterReminders([asked('t1', 'done', { ended: { at: NOW - 30_000, outcome: 'done' } })], idle, NOW, { graceMs: 0 }).length, 1);
  // A blocked report that failed the ticket settles at the report.
  const blocked = asked('t1', 'failed', { reports: [{ at: ago(20), status: 'blocked', text: 'no access' }] });
  assert.deepEqual(requesterReminders([blocked], { 'home-atlas': { status: 'idle', reportedAt: ago(25) } }, NOW)[0].ticketIds, ['t1']);
  assert.deepEqual(requesterReminders([blocked], { 'home-atlas': { status: 'idle', reportedAt: ago(15) } }, NOW), []);
});

test('reminders are per requester; user and archived tickets are skipped', () => {
  const facts = { 'home-atlas': { status: 'idle' }, 'ticket-t9': { status: 'idle' } };
  const items = [
    asked('t1', 'done'),
    asked('t2', 'working', { requester: { kind: 'session', sessionId: 'ticket-t9', botId: 'b-coder', ticketId: 't9' } }),
    asked('t3', 'done', { requester: { kind: 'session', sessionId: 'ticket-t9', botId: 'b-coder', ticketId: 't9' } }),
    asked('t4', 'done', { requester: { kind: 'user' } }),
    asked('t5', 'working', { archivedAt: ago(1) }),
  ];
  assert.deepEqual(requesterReminders(items, facts, NOW), [{ sessionId: 'home-atlas', botId: 'b-atlas', ticketIds: ['t1'] }]);
  assert.deepEqual(requesterReminders(undefined, facts, NOW), []);
});
