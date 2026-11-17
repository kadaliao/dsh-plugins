import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clampTitle, createSlots, createTickets, isLive, newTicketId, sessionIdOf, stageOf, ticketIdOf, titleFrom, TICKET_ID_RE } from '../lib/tickets.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'bots-tickets-'));
/** A clock the test moves by hand, 1 s per read unless told otherwise. */
function clock(start = 1_000_000) {
  let t = start;
  const now = () => (t += 1000);
  now.set = (v) => (t = v);
  return now;
}
const fresh = () => {
  const now = clock();
  const dir = tmp();
  return { dir, now, tickets: createTickets(dir, { now }) };
};
const onDisk = (dir) => JSON.parse(readFileSync(join(dir, 'tickets.json'), 'utf8'));
const base = { id: 'tabcd1234', botId: 'bot-a', reports: [], createdAt: 1, updatedAt: 1 };
const rep = (status, at) => ({ at, status, text: status });

// --- ids and titles ------------------------------------------------------------------------------

test('ticket ids are t + 8 lowercase letters and digits; Sessions map both ways', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newTicketId()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, TICKET_ID_RE);
  assert.equal(sessionIdOf('tabcd1234'), 'ticket-tabcd1234');
  assert.equal(ticketIdOf('ticket-tabcd1234'), 'tabcd1234');
  assert.equal(ticketIdOf('ticket-nope'), '');
  assert.equal(ticketIdOf('session-1'), '');
  assert.equal(ticketIdOf(undefined), '');
});

test('titles are one line of at most 120 characters, cut with an ellipsis', () => {
  assert.equal(clampTitle('  Find   the\nbug  '), 'Find the bug');
  const long = clampTitle('x'.repeat(300));
  assert.equal([...long].length, 120);
  assert.ok(long.endsWith('…'));
  const han = clampTitle('研'.repeat(130));
  assert.equal([...han].length, 120);
  assert.equal(clampTitle('😀'.repeat(121)).length, 119 * 2 + 1, 'cuts between code points, not inside a pair');
  assert.equal(titleFrom('\n\n  Fix the build  \nthen ship it'), 'Fix the build');
  assert.equal(titleFrom(''), '');
});

// --- stages, row by row --------------------------------------------------------------------------

test('failed: retries used up, or an unanswered blocked report', () => {
  assert.equal(stageOf({ ...base, startedAt: 2, ended: { at: 9, by: 'system', outcome: 'failed' } }), 'failed');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('question', 5)], ended: { at: 9, by: 'system', outcome: 'failed' } }), 'failed', 'an ended failure beats an open question');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('progress', 4), rep('blocked', 5)] }), 'failed');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('blocked', 5)], lastHumanAt: 5 }), 'failed', 'a message at the same instant is not after it');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('blocked', 5)], lastHumanAt: 4 }), 'failed', 'an older message is no answer');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('blocked', 5)], lastHumanAt: 6 }), 'working', 'a person answered');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('blocked', 5)], lastRequesterAt: 6 }), 'working', 'the requester answered');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('blocked', 5)], ended: { at: 6, by: 'user', outcome: 'stopped' } }), 'stopped', 'blocked and then stopped is stopped');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('blocked', 5)], ended: { at: 6, by: 'requester', outcome: 'done' } }), 'done', 'blocked and then closed is done');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('blocked', 5), rep('progress', 7)] }), 'working', 'only the latest report counts');
});

test('question: the latest report asks, and nobody answered yet', () => {
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('question', 5)] }), 'question');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('question', 5)], stalledAt: 8 }), 'question', 'question is above stalled');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('question', 5)], lastHumanAt: 6 }), 'working');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('question', 5)], lastRequesterAt: 6 }), 'working');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('question', 5)], ended: { at: 6, by: 'requester', outcome: 'stopped' } }), 'stopped');
});

test('stalled: the watchdog said so, and the ticket is still open', () => {
  assert.equal(stageOf({ ...base, startedAt: 2, stalledAt: 8 }), 'stalled');
  assert.equal(stageOf({ ...base, startedAt: 2, stalledAt: 8, nudgedAt: 7 }), 'stalled');
  assert.equal(stageOf({ ...base, startedAt: 2, nudgedAt: 7 }), 'working', 'a nudge alone is not a stall');
  assert.equal(stageOf({ ...base, startedAt: 2, stalledAt: 8, ended: { at: 9, by: 'worker', outcome: 'done' } }), 'done');
});

test('queued, working, done and stopped', () => {
  assert.equal(stageOf({ ...base }), 'queued');
  assert.equal(stageOf({ ...base, sessionId: 'ticket-tabcd1234' }), 'queued', 'a Session without a start time is back in the queue');
  assert.equal(stageOf({ ...base, startedAt: 2 }), 'working');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('progress', 3)] }), 'working');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('done', 3)] }), 'working', 'a done report on a resumed (open) ticket is history');
  assert.equal(stageOf({ ...base, startedAt: 2, reports: [rep('done', 3)], ended: { at: 3, by: 'worker', outcome: 'done' } }), 'done');
  assert.equal(stageOf({ ...base, startedAt: 2, ended: { at: 3, by: 'requester', outcome: 'done' } }), 'done', 'closed by the requester');
  assert.equal(stageOf({ ...base, ended: { at: 3, by: 'user', outcome: 'stopped' } }), 'stopped', 'stopped before it started');
  assert.equal(stageOf({ ...base, startedAt: 2, ended: { at: 3, by: 'requester', outcome: 'stopped' } }), 'stopped');
  assert.equal(stageOf({ ...base, startedAt: 2, ended: { at: 3, by: 'system', outcome: 'weird' } }), 'stopped');
  assert.equal(stageOf(undefined), 'queued');
});

// --- the store -----------------------------------------------------------------------------------

test('create: an id, no Session yet, a title from the text, and its origin Thread subscribed', () => {
  const { dir, tickets } = fresh();
  const t = tickets.create({ text: 'Look into the flaky login test\nIt fails one run in five.', botId: 'bot-b', requester: { kind: 'session', sessionId: 'home-1', botId: 'bot-a' }, origin: { threadKey: 'slack:T1:C1:1700.01', via: 'slack', who: 'Kada' } });
  assert.match(t.id, TICKET_ID_RE);
  assert.equal(t.sessionId, null);
  assert.equal(t.title, 'Look into the flaky login test');
  assert.deepEqual(t.requester, { kind: 'session', sessionId: 'home-1', botId: 'bot-a' });
  assert.deepEqual(t.origin, { threadKey: 'slack:T1:C1:1700.01', via: 'slack', who: 'Kada' });
  assert.deepEqual(t.threads, ['slack:T1:C1:1700.01']);
  assert.equal(t.retries, 0);
  assert.deepEqual(t.reports, []);
  assert.equal(stageOf(t), 'queued');
  const th = tickets.thread('slack:T1:C1:1700.01');
  assert.deepEqual({ kind: th.kind, appKey: th.appKey, chatId: th.chatId, rootId: th.rootId, tickets: th.tickets }, { kind: 'slack', appKey: 'T1', chatId: 'C1', rootId: '1700.01', tickets: [t.id] });
  const saved = onDisk(dir);
  assert.equal(saved.version, 1);
  assert.equal(saved.tickets[0].id, t.id);
  assert.equal(saved.threads[0].key, 'slack:T1:C1:1700.01');

  const child = tickets.create({ title: 'Check the CI logs', text: 'Check the CI logs for the login test', botId: 'bot-c', requester: { kind: 'session', sessionId: sessionIdOf(t.id), botId: 'bot-b', ticketId: t.id } });
  assert.equal(child.parentId, t.id, 'a ticket a ticket asked for is its child');
  assert.deepEqual(tickets.children(t.id).map((c) => c.id), [child.id]);
  const panel = tickets.create({ text: 'Draft the notes', botId: 'bot-c', requester: { kind: 'user' }, threads: ['panel:home-9', { key: 'telegram:bot1:42', label: 'Kada (DM)' }] });
  assert.equal(tickets.thread('panel:home-9').chatId, 'home-9');
  assert.equal(tickets.thread('telegram:bot1:42').label, 'Kada (DM)');
  assert.equal(tickets.thread('telegram:bot1:42').rootId, undefined);
  assert.deepEqual(panel.requester, { kind: 'user' });

  assert.throws(() => tickets.create({ text: 'x' }), /bot/);
  assert.throws(() => tickets.create({ text: '   ', botId: 'bot-b' }), /title or text/);
  assert.equal([...tickets.create({ title: 'y'.repeat(200), text: 'z', botId: 'bot-b' }).title].length, 120);
});

test('a ticket goes queued → working → question → working → done, and its Session finds it', () => {
  const { tickets } = fresh();
  const t = tickets.create({ text: 'Summarize the RFC', botId: 'bot-b' });
  assert.equal(tickets.bySession(sessionIdOf(t.id)), t, 'found while its Session is being made');
  assert.equal(tickets.bySession('home-1'), undefined);
  assert.equal(tickets.bySession(''), undefined);
  tickets.start(t.id);
  assert.equal(t.sessionId, `ticket-${t.id}`);
  const first = t.startedAt;
  assert.ok(first > 0);
  assert.equal(stageOf(t), 'working');
  assert.equal(tickets.bySession(t.sessionId), t);
  tickets.start(t.id);
  assert.equal(t.startedAt, first, 'a restart keeps the first start');

  tickets.addReport(t.id, { status: 'progress', text: 'Read half of it.' });
  assert.equal(stageOf(t), 'working');
  assert.equal(t.ended, undefined);
  tickets.addReport(t.id, { status: 'question', text: 'Which section matters most?' });
  assert.equal(stageOf(t), 'question');
  tickets.touch(t.id);
  assert.equal(stageOf(t), 'question', 'the worker’s own events answer nothing');
  tickets.touch(t.id, { human: true });
  assert.equal(stageOf(t), 'working');
  assert.ok(t.lastHumanAt > t.reports.at(-1).at);
  tickets.addReport(t.id, { status: 'done', text: 'Summary: …' });
  assert.equal(stageOf(t), 'done');
  assert.deepEqual({ by: t.ended.by, outcome: t.ended.outcome }, { by: 'worker', outcome: 'done' });
  assert.equal(t.reports.length, 3);
  assert.deepEqual(t.reports.map((r) => r.status), ['progress', 'question', 'done']);
});

test('reports: blocked fails until answered, any report clears a nudge or stall, odd ones are refused', () => {
  const { tickets } = fresh();
  const t = tickets.create({ text: 'Deploy the site', botId: 'bot-b' });
  tickets.start(t.id);
  tickets.patch(t.id, { nudgedAt: 5, stalledAt: 6 });
  assert.equal(stageOf(t), 'stalled');
  tickets.addReport(t.id, { status: 'blocked', text: 'No deploy key.' });
  assert.equal(t.nudgedAt, undefined);
  assert.equal(t.stalledAt, undefined);
  assert.equal(stageOf(t), 'failed');
  assert.equal(t.ended, undefined, 'blocked does not end it');
  tickets.touch(t.id, { requester: true });
  assert.equal(stageOf(t), 'working', 'the requester sent the key');
  assert.ok(t.lastRequesterAt > 0);
  assert.equal(t.lastHumanAt, undefined);
  tickets.addReport(t.id, { status: 'question', text: 'Prod or staging?' });
  assert.equal(t.ended, undefined, 'question does not end it');
  assert.throws(() => tickets.addReport(t.id, { status: 'finished' }), /status/);
  assert.equal(tickets.addReport('tnope0000', { status: 'progress' }), undefined);
  const long = tickets.addReport(t.id, { status: 'progress', text: 'x'.repeat(30_000) });
  assert.equal(long.reports.at(-1).text.length, 20_000);
  for (let i = 0; i < 210; i += 1) tickets.addReport(t.id, { status: 'progress', text: `step ${i}` });
  assert.equal(t.reports.length, 200);
  assert.equal(t.reports.at(-1).text, 'step 209');
  // A report on a ticket already ended is kept but does not change how it ended.
  tickets.end(t.id, { by: 'user', outcome: 'stopped' });
  tickets.addReport(t.id, { status: 'done', text: 'late' });
  assert.equal(stageOf(t), 'stopped');
  assert.equal(t.reports.at(-1).text, 'late');
});

test('end: by and outcome are checked; the newest end wins; a failure keeps its error', () => {
  const { tickets } = fresh();
  const t = tickets.create({ text: 'Crawl the docs', botId: 'bot-b' });
  tickets.start(t.id);
  assert.throws(() => tickets.end(t.id, { by: 'robot', outcome: 'done' }), /ended by/);
  assert.throws(() => tickets.end(t.id, { by: 'system', outcome: 'gone' }), /ends as/);
  tickets.patch(t.id, { retries: 3 });
  tickets.end(t.id, { by: 'system', outcome: 'failed', error: '503 Service Unavailable' });
  assert.equal(stageOf(t), 'failed');
  assert.equal(t.error, '503 Service Unavailable');
  tickets.end(t.id, { by: 'requester', outcome: 'done' });
  assert.equal(stageOf(t), 'done', 'the requester closed the failed ticket');
  assert.equal(tickets.end('tnope0000', { by: 'user', outcome: 'stopped' }), undefined);
});

test('resume: a done or requester-stopped ticket opens again; a person’s stop and an archive refuse', () => {
  const { tickets } = fresh();
  const done = tickets.create({ text: 'Write the changelog', botId: 'bot-b' });
  tickets.start(done.id);
  tickets.addReport(done.id, { status: 'done', text: 'Written.' });
  tickets.patch(done.id, { stalledAt: 9, nudgedAt: 8, retries: 2 });
  assert.equal(tickets.resume(done.id), done);
  assert.equal(stageOf(done), 'working');
  assert.equal(done.ended, undefined);
  assert.equal(done.stalledAt, undefined);
  assert.equal(done.nudgedAt, undefined);
  assert.equal(done.retries, 0);

  const failed = tickets.create({ text: 'Fetch the data', botId: 'bot-b' });
  tickets.start(failed.id);
  tickets.end(failed.id, { by: 'system', outcome: 'failed', error: 'timeout' });
  assert.equal(stageOf(tickets.resume(failed.id)), 'working', 'retry');

  const byRequester = tickets.create({ text: 'Translate the page', botId: 'bot-b' });
  tickets.end(byRequester.id, { by: 'requester', outcome: 'stopped' });
  assert.equal(stageOf(tickets.resume(byRequester.id)), 'queued', 'never started, so back in the queue');

  const byUser = tickets.create({ text: 'Book the room', botId: 'bot-b' });
  tickets.start(byUser.id);
  tickets.end(byUser.id, { by: 'user', outcome: 'stopped' });
  assert.equal(tickets.resume(byUser.id), null);
  assert.equal(stageOf(byUser), 'stopped');
  assert.equal(tickets.resume(byUser.id, { force: true }), byUser, 'the person asked for it again');
  assert.equal(stageOf(byUser), 'working');

  const closedByUser = tickets.create({ text: 'Rename the repo', botId: 'bot-b' });
  tickets.end(closedByUser.id, { by: 'user', outcome: 'done' });
  assert.ok(tickets.resume(closedByUser.id), 'only a person’s stop is final');

  const archived = tickets.create({ text: 'Old work', botId: 'bot-b' });
  tickets.addReport(archived.id, { status: 'done' });
  tickets.archive(archived.id);
  assert.equal(tickets.resume(archived.id), null);
  assert.equal(tickets.resume(archived.id, { force: true }), null);
  assert.equal(tickets.resume('tnope0000'), undefined);

  const blocked = tickets.create({ text: 'Sign the release', botId: 'bot-b' });
  tickets.start(blocked.id);
  tickets.addReport(blocked.id, { status: 'blocked', text: 'No key.' });
  tickets.resume(blocked.id);
  assert.equal(stageOf(blocked), 'failed', 'resume is about ended; the blocked report needs an answer');
  tickets.touch(blocked.id, { human: true });
  assert.equal(stageOf(blocked), 'working');
});

test('touch: Session events wait for the next write; a person’s message is written at once and clears a stall', () => {
  const { dir, tickets } = fresh();
  const t = tickets.create({ text: 'Watch the queue', botId: 'bot-b' });
  tickets.start(t.id);
  const written = onDisk(dir).tickets[0].lastEventAt;
  tickets.touch(t.id);
  assert.ok(t.lastEventAt > written);
  assert.equal(onDisk(dir).tickets[0].lastEventAt, written, 'a plain event is not written yet');
  tickets.flush();
  assert.equal(onDisk(dir).tickets[0].lastEventAt, t.lastEventAt);
  tickets.patch(t.id, { nudgedAt: 1, stalledAt: 2 });
  tickets.touch(t.id, { human: true });
  assert.equal(onDisk(dir).tickets[0].lastHumanAt, t.lastHumanAt);
  assert.equal(t.lastEventAt, t.lastHumanAt);
  assert.equal(t.stalledAt, undefined);
  assert.equal(t.nudgedAt, undefined);
  assert.equal(stageOf(t), 'working');
  assert.equal(tickets.touch('tnope0000'), undefined);
});

test('subscriptions are many-to-many, and live ones leave out archived and person-stopped tickets', () => {
  const { tickets } = fresh();
  const chat = 'feishu:app1:oc_1:om_root';
  const a = tickets.create({ text: 'A', botId: 'bot-b', origin: { threadKey: chat } });
  const b = tickets.create({ text: 'B', botId: 'bot-c', origin: { threadKey: chat } });
  const c = tickets.create({ text: 'C', botId: 'bot-b' });
  tickets.subscribe(c.id, chat);
  tickets.subscribe(a.id, 'discord:g1:ch1:m1', { label: '#general', kind: 'discord' });
  tickets.subscribe(a.id, 'discord:g1:ch1:m1');
  assert.deepEqual(a.threads, [chat, 'discord:g1:ch1:m1']);
  assert.deepEqual(tickets.subscribers(chat).map((t) => t.id), [a.id, b.id, c.id]);
  assert.deepEqual(tickets.subscribers('discord:g1:ch1:m1').map((t) => t.id), [a.id]);
  assert.equal(tickets.thread('discord:g1:ch1:m1').label, '#general');
  assert.deepEqual(tickets.subscribers('slack:none:none'), []);

  tickets.addReport(a.id, { status: 'done' });
  tickets.end(b.id, { by: 'user', outcome: 'stopped' });
  tickets.end(c.id, { by: 'requester', outcome: 'stopped' });
  assert.deepEqual(tickets.subscribers(chat, { live: true }).map((t) => t.id), [a.id, c.id], 'done and requester-stopped still take messages');
  tickets.archive(a.id);
  assert.deepEqual(tickets.subscribers(chat, { live: true }).map((t) => t.id), [c.id]);
  assert.deepEqual(tickets.subscribers(chat).map((t) => t.id), [a.id, b.id, c.id], 'the old ones are still there to point at');
  assert.equal(isLive(a), false);
  assert.equal(isLive(b), false);
  assert.equal(isLive(c), true);

  tickets.unsubscribe(c.id, chat);
  assert.deepEqual(c.threads, []);
  assert.deepEqual(tickets.thread(chat).tickets, [a.id, b.id]);
  tickets.patch(b.id, { threads: ['telegram:bot1:7', 'telegram:bot1:7:12'] });
  assert.deepEqual(b.threads, ['telegram:bot1:7', 'telegram:bot1:7:12']);
  assert.deepEqual(tickets.thread(chat).tickets, [a.id]);
  assert.equal(tickets.thread('telegram:bot1:7:12').rootId, '12');
  assert.equal(tickets.subscribe('tnope0000', chat), undefined);
  assert.equal(tickets.thread('tnope0000'), undefined);
});

test('upsertThread records labels and activity without touching subscriptions', () => {
  const { dir, now, tickets } = fresh();
  const seen = [];
  tickets.onChange((t) => seen.push(t));
  assert.equal(tickets.upsertThread({ kind: 'slack' }), undefined);
  const th = tickets.upsertThread({ key: 'slack:T1:C9', label: '  #ops  ', tickets: ['tjunk0000'] });
  assert.deepEqual(th.tickets, []);
  assert.equal(th.label, '#ops');
  const t = tickets.create({ text: 'Rotate the logs', botId: 'bot-b', origin: { threadKey: 'slack:T1:C9' } });
  now.set(5_000_000);
  tickets.upsertThread({ key: 'slack:T1:C9' });
  assert.equal(th.lastAt, 5_001_000);
  assert.equal(th.label, '#ops');
  assert.deepEqual(th.tickets, [t.id]);
  assert.equal(onDisk(dir).threads[0].lastAt, 5_001_000);
  assert.deepEqual(seen.map((x) => x?.id ?? null), [null, t.id, null]);
});

test('list filters by bot, stage, open and archived, newest first; open() is the queue, oldest first', () => {
  const { tickets } = fresh();
  const a = tickets.create({ text: 'A', botId: 'bot-b' });
  const b = tickets.create({ text: 'B', botId: 'bot-c' });
  const c = tickets.create({ text: 'C', botId: 'bot-b' });
  const d = tickets.create({ text: 'D', botId: 'bot-b' });
  tickets.start(a.id);
  tickets.addReport(a.id, { status: 'question' });
  tickets.start(b.id);
  tickets.addReport(c.id, { status: 'done' });
  tickets.archive(c.id);
  const ids = (xs) => xs.map((t) => t.id);
  assert.deepEqual(ids(tickets.list()), [d.id, c.id, b.id, a.id]);
  assert.deepEqual(ids(tickets.list({ botId: 'bot-b' })), [d.id, c.id, a.id]);
  assert.deepEqual(ids(tickets.list({ stage: 'question' })), [a.id]);
  assert.deepEqual(ids(tickets.list({ stage: ['working', 'queued'] })), [d.id, b.id]);
  assert.deepEqual(ids(tickets.list({ open: false })), [c.id]);
  assert.deepEqual(ids(tickets.list({ archived: false, botId: 'bot-b' })), [d.id, a.id]);
  assert.deepEqual(ids(tickets.open()), [a.id, b.id, d.id]);
  assert.equal(tickets.get(b.id), b);
  assert.equal(tickets.get('tnope0000'), undefined);
  assert.equal(tickets.get(undefined), undefined);
});

test('patch sets fields as given, removes undefined ones, keeps the id and clamps the title', () => {
  const { tickets } = fresh();
  const t = tickets.create({ text: 'Patch me', botId: 'bot-b' });
  const id = t.id;
  tickets.start(id);
  tickets.patch(id, { id: 'tother000', retries: 2, error: 'ECONNRESET', runs: [{ k: 'task-1' }], title: '   ' });
  assert.equal(t.id, id);
  assert.equal(tickets.get(id), t);
  assert.equal(t.title, 'Patch me', 'an empty title keeps the old one');
  assert.equal(t.retries, 2);
  assert.deepEqual(t.runs, [{ k: 'task-1' }]);
  tickets.patch(id, { startedAt: undefined, title: 'Patched' });
  assert.equal('startedAt' in t, false);
  assert.equal(stageOf(t), 'queued', 'put back in the queue');
  assert.equal(t.title, 'Patched');
  assert.equal(tickets.patch('tnope0000', { title: 'x' }), undefined);
});

test('archive ends an open ticket as stopped by the system and keeps an earlier end', () => {
  const { tickets } = fresh();
  const open = tickets.create({ text: 'Abandoned', botId: 'bot-b' });
  tickets.archive(open.id);
  assert.deepEqual({ by: open.ended.by, outcome: open.ended.outcome }, { by: 'system', outcome: 'stopped' });
  assert.ok(open.archivedAt > 0);
  const done = tickets.create({ text: 'Finished', botId: 'bot-b' });
  tickets.addReport(done.id, { status: 'done' });
  const at = done.ended.at;
  tickets.archive(done.id);
  assert.equal(stageOf(done), 'done');
  assert.equal(done.ended.at, at);
});

test('the file round-trips, keeps unknown fields, and heals Thread lists from the tickets', () => {
  const { dir, now, tickets } = fresh();
  const a = tickets.create({ text: 'First', botId: 'bot-b', requester: { kind: 'session', sessionId: 'home-1', botId: 'bot-a' }, origin: { threadKey: 'slack:T1:C1:1.1', via: 'slack' } });
  tickets.start(a.id);
  tickets.addReport(a.id, { status: 'question', text: 'Which?' });
  tickets.patch(a.id, { runs: [{ k: 'task-9', tokens: 1200 }] });
  const b = tickets.create({ text: 'Second', botId: 'bot-c', requester: { kind: 'session', sessionId: sessionIdOf(a.id), botId: 'bot-b', ticketId: a.id } });
  tickets.upsertThread({ key: 'slack:T1:C1:1.1', label: 'Launch thread' });

  const again = createTickets(dir, { now });
  const a2 = again.get(a.id);
  assert.deepEqual(a2, JSON.parse(JSON.stringify(a)));
  assert.equal(stageOf(a2), 'question');
  assert.deepEqual(a2.runs, [{ k: 'task-9', tokens: 1200 }]);
  assert.equal(again.get(b.id).parentId, a.id);
  assert.equal(again.bySession(sessionIdOf(a.id)).id, a.id);
  assert.equal(again.thread('slack:T1:C1:1.1').label, 'Launch thread');
  assert.deepEqual(again.subscribers('slack:T1:C1:1.1').map((t) => t.id), [a.id]);

  // A file edited by hand: a Thread list that disagrees with the tickets, a key with no
  // Thread record, a duplicate and an unusable ticket, an archive without an end.
  writeFileSync(
    join(dir, 'tickets.json'),
    JSON.stringify({
      version: 1,
      tickets: [
        { id: 'taaaa0001', botId: 'bot-b', title: 'One', text: 'One', threads: ['slack:T1:C1', 'panel:home-2'], reports: [{ at: 5, status: 'progress', text: 'ok' }, { at: 6, status: 'bogus' }], createdAt: 1, updatedAt: 6 },
        { id: 'taaaa0001', botId: 'bot-z', title: 'Duplicate' },
        { id: 'taaaa0002', title: 'No bot' },
        { id: 'taaaa0003', botId: 'bot-c', title: 'Old', archivedAt: 50, createdAt: 2, retries: -4, startedAt: 'soon' },
      ],
      threads: [{ key: 'slack:T1:C1', kind: 'slack', appKey: 'T1', chatId: 'C1', label: '#dev', tickets: ['tgone0000', 'taaaa0003'], lastAt: 40 }, { key: '' }],
    }),
  );
  const healed = createTickets(dir, { now });
  assert.deepEqual(healed.list().map((t) => t.id), ['taaaa0003', 'taaaa0001']);
  assert.equal(healed.get('taaaa0001').botId, 'bot-b');
  assert.deepEqual(healed.get('taaaa0001').reports, [{ at: 5, status: 'progress', text: 'ok' }]);
  assert.deepEqual(healed.thread('slack:T1:C1').tickets, ['taaaa0001']);
  assert.equal(healed.thread('slack:T1:C1').label, '#dev');
  assert.deepEqual(healed.subscribers('panel:home-2').map((t) => t.id), ['taaaa0001']);
  const old = healed.get('taaaa0003');
  assert.deepEqual(old.ended, { at: 50, by: 'system', outcome: 'stopped' });
  assert.equal(old.retries, 0);
  assert.equal(old.startedAt, undefined);
  assert.equal(old.sessionId, null);
  assert.deepEqual(old.requester, { kind: 'user' });
  assert.deepEqual(old.threads, []);
  assert.equal(stageOf(old), 'stopped');
});

test('a missing or corrupt file starts empty; a corrupt one is set aside, not lost', () => {
  const nowhere = createTickets(join(tmp(), 'not', 'there'));
  assert.deepEqual(nowhere.list(), []);
  nowhere.create({ text: 'Made the folder', botId: 'bot-b' });
  assert.equal(onDisk(join(nowhere.file, '..')).tickets.length, 1);

  for (const junk of ['{"tickets": [', '', '[1,2,3]', '{"version":1,"tickets":"nope"}']) {
    const dir = tmp();
    writeFileSync(join(dir, 'tickets.json'), junk);
    const tickets = createTickets(dir);
    assert.deepEqual(tickets.list(), []);
    assert.deepEqual(tickets.open(), []);
    assert.equal(readFileSync(join(dir, 'tickets.json.corrupt'), 'utf8'), junk);
    tickets.create({ text: 'After the crash', botId: 'bot-b' });
    assert.equal(onDisk(dir).tickets.length, 1);
    assert.equal(onDisk(dir).version, 1);
  }
  const dir = tmp();
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ version: 1, tickets: [], threads: 'nope' }));
  createTickets(dir).list();
  assert.equal(existsSync(join(dir, 'tickets.json.corrupt')), false, 'a bad Thread list alone is not a corrupt file');
});

test('onChange hears each write with the ticket, survives a throwing listener, and unsubscribes', () => {
  const { tickets } = fresh();
  const heard = [];
  tickets.onChange(() => {
    throw new Error('listener bug');
  });
  const off = tickets.onChange((t) => heard.push(t?.id ?? null));
  const t = tickets.create({ text: 'Listen', botId: 'bot-b' });
  tickets.start(t.id);
  tickets.touch(t.id);
  tickets.addReport(t.id, { status: 'progress' });
  off();
  tickets.addReport(t.id, { status: 'done' });
  assert.deepEqual(heard, [t.id, t.id, t.id], 'a plain touch is not a write');
});

test('prune keeps the newest archived tickets and the Threads still in use', () => {
  const { dir, tickets } = fresh();
  const made = [];
  for (let i = 0; i < 5; i += 1) {
    const t = tickets.create({ text: `Archived ${i}`, botId: 'bot-b', origin: { threadKey: `telegram:bot1:${i}` } });
    tickets.addReport(t.id, { status: 'done' });
    made.push(t);
  }
  // Archived out of creation order: by archive time is what counts.
  for (const i of [3, 0, 4, 1, 2]) tickets.archive(made[i].id);
  const endedOnly = tickets.create({ text: 'Ended, not archived', botId: 'bot-b', origin: { threadKey: 'telegram:bot1:0' } });
  tickets.end(endedOnly.id, { by: 'user', outcome: 'stopped' });
  const open = tickets.create({ text: 'Still open', botId: 'bot-b' });
  tickets.upsertThread({ key: 'slack:T1:lonely', label: 'nobody here' });

  assert.deepEqual(tickets.prune({ keepEnded: 2 }), { tickets: 3, threads: 3 });
  const left = tickets.list().map((t) => t.id);
  assert.deepEqual(left, [open.id, endedOnly.id, made[2].id, made[1].id]);
  assert.equal(tickets.get(made[3].id), undefined);
  assert.equal(tickets.thread('telegram:bot1:3'), undefined);
  assert.equal(tickets.thread('telegram:bot1:4'), undefined);
  assert.equal(tickets.thread('slack:T1:lonely'), undefined);
  assert.deepEqual(tickets.thread('telegram:bot1:0').tickets, [endedOnly.id], 'a Thread keeps going while another ticket uses it');
  assert.ok(tickets.thread('telegram:bot1:1'));
  assert.equal(onDisk(dir).tickets.length, 4);
  assert.deepEqual(tickets.prune({ keepEnded: 2 }), { tickets: 0, threads: 0 });
  assert.deepEqual(tickets.prune({ keepEnded: 0 }), { tickets: 2, threads: 2 });
  assert.deepEqual(tickets.list().map((t) => t.id), [open.id, endedOnly.id]);
  assert.deepEqual(tickets.prune(), { tickets: 0, threads: 0 }, 'the default cap is 500');
});

// --- slots ---------------------------------------------------------------------------------------

test('worker slots: max at once, one more for a person’s message, idempotent per ticket', () => {
  const slots = createSlots(2);
  assert.equal(slots.max(), 2);
  assert.equal(slots.acquire('t1'), true);
  assert.equal(slots.acquire('t1'), true, 'again for the same ticket');
  assert.equal(slots.count(), 1);
  assert.equal(slots.acquire('t2'), true);
  assert.equal(slots.acquire('t3'), false, 'full');
  assert.equal(slots.acquire('h1', { human: true }), true, 'the extra slot');
  assert.equal(slots.acquire('h2', { human: true }), false, 'only one extra');
  assert.equal(slots.acquire('h1', { human: true }), true);
  assert.equal(slots.count(), 3);
  assert.equal(slots.holds('h1'), true);
  assert.equal(slots.holds('t3'), false);

  assert.equal(slots.release('t1'), true);
  assert.equal(slots.release('t1'), false);
  assert.equal(slots.acquire('t3'), false, 'the freed slot only brings the count back to max');
  assert.equal(slots.acquire('h2', { human: true }), true, 'so the extra slot is a person’s again');
  assert.equal(slots.count(), 3);

  slots.setMax(1);
  assert.equal(slots.acquire('h3', { human: true }), false, 'lowered: holders stay, nobody new');
  assert.equal(slots.count(), 3);
  slots.setMax(5);
  assert.equal(slots.acquire('t3'), true);
  assert.equal(slots.acquire(''), false);

  assert.equal(createSlots().max(), 4);
  assert.equal(createSlots(0).max(), 1);
  assert.equal(createSlots('x').max(), 4);
  assert.equal(createSlots(2.7).max(), 2);
});
