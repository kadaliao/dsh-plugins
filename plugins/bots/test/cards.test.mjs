import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSIGNMENT_CHARS,
  PAGE_CHARS,
  REPORT_CHARS,
  assignmentText,
  clip,
  failedNoticeText,
  followUpNoticeText,
  nudgeText,
  readResource,
  recoveryNoteText,
  reminderText,
  reportRelayText,
  retryText,
  stalledNoticeText,
  ticketCard,
} from '../lib/cards.mjs';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const at = (min) => NOW - min * 60_000;

const bots = [
  { id: 'b-atlas', handle: 'atlas', name: 'Atlas', role: 'primary', bio: 'Runs the team' },
  { id: 'b-coder', handle: 'coder', name: 'Coder', role: 'bot' },
  { id: 'b-writer', handle: 'writer', name: 'Writer', role: 'bot' },
];

const SLACK = 'slack:acme:C1:1700.1';
const TG = 'telegram:tg:42';

function ticket(id, over = {}) {
  return {
    id,
    title: `Title of ${id}`,
    text: `Do the thing for ${id}.`,
    botId: 'b-coder',
    sessionId: `ticket-${id}`,
    requester: { kind: 'session', sessionId: 'home-atlas', botId: 'b-atlas' },
    origin: { threadKey: SLACK, via: 'Slack', who: 'Kada' },
    threads: [SLACK],
    reports: [],
    createdAt: at(60),
    updatedAt: at(30),
    retries: 0,
    ...over,
  };
}

/** A small world: a parent with two children, a sibling, an ended one, an archived one, a queued one. */
function world() {
  const list = [
    ticket('t0000par1', { reports: [{ at: at(40), status: 'progress', text: 'Started.' }], updatedAt: at(40) }),
    ticket('t0000kid1', { parentId: 't0000par1', botId: 'b-writer', requester: { kind: 'session', sessionId: 'ticket-t0000par1', botId: 'b-coder', ticketId: 't0000par1' }, updatedAt: at(5) }),
    ticket('t0000kid2', { parentId: 't0000par1', requester: { kind: 'session', sessionId: 'ticket-t0000par1', botId: 'b-coder', ticketId: 't0000par1' }, updatedAt: at(6), threads: [SLACK, TG] }),
    ticket('t0000sib1', { origin: { threadKey: TG, via: 'Telegram', who: 'Lee' }, threads: [TG], updatedAt: at(1) }),
    ticket('t0000end1', { ended: { at: at(10), by: 'worker', outcome: 'done' }, reports: [{ at: at(10), status: 'done', text: 'All done.' }], updatedAt: at(2) }),
    ticket('t0000arc1', { ended: { at: at(3000), by: 'worker', outcome: 'done' }, archivedAt: at(1500), updatedAt: at(1500) }),
    ticket('t0000que1', { sessionId: null, updatedAt: at(20) }),
  ];
  const stages = { t0000par1: 'working', t0000kid1: 'working', t0000kid2: 'question', t0000sib1: 'working', t0000end1: 'done', t0000arc1: 'done', t0000que1: 'queued' };
  const tickets = { get: (id) => list.find((t) => t.id === id), list: () => list };
  const threadList = [
    { key: SLACK, kind: 'slack', appKey: 'acme', chatId: 'C1', rootId: '1700.1', label: '#general', tickets: list.filter((t) => t.threads.includes(SLACK)).map((t) => t.id), lastAt: at(1) },
    { key: TG, kind: 'telegram', appKey: 'tg', chatId: '42', label: 'Lee (DM)', tickets: ['t0000sib1', 't0000kid2'], lastAt: at(1) },
  ];
  const threads = {
    get: (key) => threadList.find((t) => t.key === key),
    recent: async (key) => (key === SLACK ? [{ at: at(2), who: 'Kada', text: 'Any news?' }] : []),
  };
  const stageOf = (t, opts) => {
    assert.equal(typeof opts.now, 'number', 'stageOf gets {now}');
    return stages[t.id];
  };
  return { list, tickets, threads, stageOf, opts: { tickets, threads, bots, stageOf, now: NOW } };
}

test('clip keeps short text and cuts long text with the full length', () => {
  assert.deepEqual(clip('hello', 10), { text: 'hello' });
  assert.deepEqual(clip('', 10), { text: '' });
  assert.deepEqual(clip(undefined, 10), { text: '' });
  const long = 'x'.repeat(1000);
  const c = clip(long, 600);
  assert.equal(c.chars, 1000);
  assert.ok(c.text.length <= 600);
  assert.ok(c.text.endsWith('…'));
  // A surrogate pair at the cut is not split.
  const emoji = `${'a'.repeat(8)}😀😀😀`;
  const e = clip(emoji, 10);
  assert.ok(e.text.length <= 10);
  assert.doesNotMatch(e.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test('a ticket card is compact and names bots by handle', () => {
  const { list, opts } = world();
  const parent = list[0];
  const card = ticketCard(parent, { ...opts, tickets: opts.tickets });
  assert.equal(card.id, 't0000par1');
  assert.equal(card.title, 'Title of t0000par1');
  assert.equal(card.bot, '@coder');
  assert.equal(card.stage, 'working');
  assert.equal(card.requester, '@atlas');
  assert.deepEqual(card.children, ['t0000kid1', 't0000kid2']);
  assert.deepEqual(card.origin, { thread: SLACK, label: '#general', via: 'Slack', who: 'Kada' });
  assert.equal(card.threads, undefined, 'the origin thread is not repeated');
  assert.deepEqual(card.last_report, { status: 'progress', at: new Date(at(40)).toISOString(), preview: 'Started.' });
  assert.equal(card.parent, undefined);
  assert.equal(card.error, undefined);

  const kid = ticketCard(list[2], { stage: 'question', bots, threads: opts.threads });
  assert.equal(kid.parent, 't0000par1');
  assert.deepEqual(kid.threads, [TG]);
  assert.equal(kid.stage, 'question');
  assert.equal(kid.children, undefined);

  const failed = ticketCard(ticket('t0000fai1', { error: 'HTTP 503 '.repeat(100) }), { stage: 'failed', bots });
  assert.ok(failed.error.length <= 200);
  const user = ticketCard(ticket('t0000usr1', { requester: { kind: 'user' }, origin: {} }), { bots });
  assert.equal(user.requester, 'user');
  assert.equal(user.origin, undefined);
  assert.equal(user.stage, undefined, 'no stage without stage or stageOf');
  assert.equal(ticketCard(ticket('t0000gon1', { botId: 'gone' }), { bots }).bot, '(removed bot)');
});

test('a card preview is clipped and long reports never inline whole', () => {
  const t = ticket('t0000lng1', { reports: [{ at: at(1), status: 'done', text: 'word '.repeat(400) }] });
  const card = ticketCard(t, { stage: 'done', bots });
  assert.ok(card.last_report.preview.length <= 200);
  assert.ok(JSON.stringify(card).length < 900);
});

test('every id on a card can be read with readResource', async () => {
  const { list, opts } = world();
  for (const t of list) {
    const card = ticketCard(t, opts);
    const refs = [`ticket/${card.id}`, `bot/${card.bot.slice(1)}`];
    if (card.parent) refs.push(`ticket/${card.parent}`);
    for (const c of card.children ?? []) refs.push(`ticket/${c}`);
    if (card.origin?.thread) refs.push(`thread/${card.origin.thread}`);
    for (const k of card.threads ?? []) refs.push(`thread/${k}`);
    for (const ref of refs) {
      const r = await readResource(ref, { ...opts, viewer: { kind: 'router' } });
      assert.equal(r.ref, ref, ref);
    }
    // A ticket can read everything on its own card.
    for (const ref of refs.filter((x) => !x.startsWith('bot/'))) {
      const r = await readResource(ref, { ...opts, viewer: { kind: 'ticket', ticketId: t.id } });
      assert.equal(r.ref, ref, `${t.id} reads ${ref}`);
    }
  }
});

test('a relayed report shows up to 600 characters and points to the rest', () => {
  const { list, opts } = world();
  const t = list[4];
  const short = reportRelayText(t, { status: 'done', text: 'Fixed and deployed.' }, { ...opts, stage: 'done' });
  assert.match(short, /^Report from @coder on task t0000end1 — status: done\nFixed and deployed\./);
  assert.doesNotMatch(short, /characters shown/);
  assert.match(short, /Task: \{"id":"t0000end1"/);
  assert.match(short, /Pass the result on/);

  const text = `${'a'.repeat(2000)}END`;
  const long = reportRelayText(t, { status: 'done', text }, { ...opts, stage: 'done' });
  assert.doesNotMatch(long, /END/);
  assert.match(long, /\[600 of 2003 characters shown\. Read the whole report with bot_recall \{"ref":"ticket\/t0000end1\/reports"\}\.\]/);
  const body = long.split('\n')[1];
  assert.ok(body.length <= REPORT_CHARS);

  const q = reportRelayText(list[2], { status: 'question', text: 'Which branch?' }, { ...opts, stage: 'question' });
  assert.match(q, /@coder needs an answer/);
  assert.match(q, /bot_send_message \(ticket: "t0000kid2"\)/);
  const b = reportRelayText(list[2], { status: 'blocked', text: 'No access.' }, { bots });
  assert.match(b, /@coder is blocked/);
  assert.match(b, /bot_ticket/);
});

test('the assignment a worker reads: task, who asked, where from, how to report', () => {
  const { list, opts } = world();
  const text = assignmentText(list[0], opts);
  assert.match(text, /^New task t0000par1 from @atlas: Title of t0000par1/);
  assert.match(text, /It started with Kada in #general \(Slack\)\./);
  assert.match(text, /Do the thing for t0000par1\./);
  assert.match(text, /bot_send_message \(leave out "to"\)/);
  for (const s of ['done', 'progress', 'question', 'blocked']) assert.match(text, new RegExp(`"${s}"`));
  assert.match(text, /plain text reaches no one/);
  assert.doesNotMatch(text, /characters shown/);

  const sub = assignmentText(list[1], opts);
  assert.match(sub, /^New task t0000kid1 from @coder \(task t0000par1\)/);

  const huge = ticket('t0000big1', { text: `${'b'.repeat(3000)}TAIL`, origin: {}, requester: { kind: 'user' } });
  const big = assignmentText(huge, { bots });
  assert.match(big, /^New task t0000big1 from the user:/);
  assert.doesNotMatch(big, /TAIL/);
  assert.doesNotMatch(big, /It started with/);
  assert.match(big, /\[1500 of 3004 characters shown\. Read the rest with bot_recall \{"ref":"ticket\/t0000big1\/text"\}\.\]/);
  const bodyLine = big.split('\n').find((l) => l.startsWith('b'));
  assert.ok(bodyLine.length <= ASSIGNMENT_CHARS);
});

test('the follow-up notice tells the router it needs no reply', () => {
  const { list, opts } = world();
  const one = followUpNoticeText({ tickets: [list[0]], thread: SLACK, who: 'Kada', via: 'Slack', text: 'Also add tests please.' }, opts);
  assert.match(one, /^\[follow_up\] Kada in #general \(Slack\) wrote about task t0000par1 \(@coder, working: Title of t0000par1\) on thread slack:acme:C1:1700\.1:/);
  assert.match(one, /"Also add tests please\."/);
  assert.match(one, /needs no reply/);
  assert.match(one, /only if the person asks to stop/);
  const two = followUpNoticeText({ tickets: [list[0], list[2]], thread: { key: TG, label: 'Lee (DM)' }, text: 'x'.repeat(500) }, opts);
  assert.match(two, /^\[follow_up\] Someone in Lee \(DM\) wrote about tasks t0000par1 .*, t0000kid2 \(@coder, question:/);
  assert.ok(two.split('\n')[1].length <= 202);
});

test('recovery, nudge, stall, failure, retry and reminder texts', () => {
  const { list, opts } = world();
  const t = list[0];
  const rec = recoveryNoteText(t);
  assert.match(rec, /restarted while you were working on task t0000par1/);
  assert.match(rec, /check what you already did/);
  assert.match(rec, /Do not repeat an outside action/);
  const nudge = nudgeText(t);
  assert.match(nudge, /\[Status check\] Task t0000par1/);
  assert.match(nudge, /bot_send_message/);
  assert.match(nudge, /marked stalled/);
  const stalled = stalledNoticeText(t, { bots });
  assert.match(stalled, /\[Stalled\] Task t0000par1 \(@coder: Title of t0000par1\)/);
  assert.match(stalled, /bot_send_message \(ticket: "t0000par1"\)/);
  assert.match(stalledNoticeText(t), /\(removed bot\)/, 'works without bots');
  assert.match(failedNoticeText({ ...t, error: 'HTTP 503' }, { bots }), /failed\. Last error: HTTP 503/);
  assert.match(retryText(t, { attempt: 2, error: 'ECONNRESET' }), /^\[Retry 2\] The last step of task t0000par1 failed with a temporary error \(ECONNRESET\)/);
  const rem = reminderText([list[4], list[2]], opts);
  assert.match(rem, /t0000end1 \(@coder, done: Title of t0000end1\), t0000kid2 \(@coder, question:/);
});

test('tickets: open ones first, newest first, 20 a page, at most 50', async () => {
  const { opts } = world();
  const r = await readResource('tickets', opts);
  assert.equal(r.ref, 'tickets');
  assert.equal(r.total, 7);
  assert.deepEqual(
    r.items.map((i) => i.id),
    ['t0000sib1', 't0000kid1', 't0000kid2', 't0000que1', 't0000par1', 't0000end1', 't0000arc1'],
  );
  assert.equal(r.next_offset, undefined);
  assert.equal(r.items[6].archived, true);
  assert.equal(r.items[0].children, undefined, 'rows stay small');

  const many = Array.from({ length: 75 }, (_, i) => ticket(`t${String(i).padStart(8, '0')}`, { updatedAt: at(i) }));
  const page1 = await readResource('tickets', { tickets: many, bots });
  assert.equal(page1.items.length, 20);
  assert.equal(page1.next_offset, 20);
  const page2 = await readResource('tickets', { tickets: many, bots, offset: 20, limit: 500 });
  assert.equal(page2.items.length, 50);
  assert.equal(page2.next_offset, 70);
  const last = await readResource('tickets', { tickets: many, bots, offset: 70 });
  assert.equal(last.items.length, 5);
  assert.equal(last.next_offset, undefined);
  const none = await readResource('tickets', { tickets: [] });
  assert.deepEqual(none, { ref: 'tickets', items: [], total: 0 });
});

test('ticket/<id>: card, assignment preview and where to read more', async () => {
  const { opts } = world();
  const r = await readResource('ticket/t0000par1', opts);
  assert.equal(r.card.id, 't0000par1');
  assert.equal(r.card.stage, 'working');
  assert.equal(r.text, 'Do the thing for t0000par1.');
  assert.deepEqual(r.more, ['ticket/t0000par1/text', 'ticket/t0000par1/reports', 'ticket/t0000par1/transcript']);
  // Aliases: a bare id, task/…, a leading slash.
  assert.equal((await readResource('t0000par1', opts)).card.id, 't0000par1');
  assert.equal((await readResource('/task/t0000par1/', opts)).card.id, 't0000par1');
});

test('text, reports and transcript come in 4000-character pages', async () => {
  const long = `${'x'.repeat(5000)}END`;
  const t = ticket('t0000pag1', {
    text: long,
    reports: [
      { at: at(20), status: 'progress', text: 'first' },
      { at: at(1), status: 'done', text: `last ${'y'.repeat(4500)}` },
    ],
  });
  const opts = { tickets: [t], bots };
  const p1 = await readResource('ticket/t0000pag1/text', opts);
  assert.equal(p1.text.length, PAGE_CHARS);
  assert.equal(p1.chars, 5003);
  assert.equal(p1.offset, 0);
  assert.equal(p1.next_offset, 4000);
  const p2 = await readResource('ticket/t0000pag1/text', { ...opts, offset: p1.next_offset });
  assert.ok(p2.text.endsWith('END'));
  assert.equal(p2.next_offset, undefined);

  const reports = await readResource('ticket/t0000pag1/reports', opts);
  assert.match(reports.text, /^--- [^\n]+ · done ---\nlast y/, 'newest first');
  assert.equal(reports.next_offset, 4000);
  const rest = await readResource('ticket/t0000pag1/reports', { ...opts, offset: 4000 });
  assert.match(rest.text, /· progress ---\nfirst$/);
  assert.match((await readResource('ticket/t0000emp1/reports', { tickets: [ticket('t0000emp1')] })).text, /No reports on task t0000emp1 yet/);

  const transcript = async (tk) => [{ role: 'user', text: `Assignment of ${tk.id}` }, { role: 'assistant', text: 'z'.repeat(4100) }];
  const tr = await readResource('ticket/t0000pag1/transcript', { ...opts, transcript });
  assert.match(tr.text, /^user: Assignment of t0000pag1\n\nassistant: z/);
  assert.equal(tr.next_offset, 4000);
  const trs = await readResource('ticket/t0000pag1/transcript', { ...opts, transcript: () => 'plain transcript' });
  assert.equal(trs.text, 'plain transcript');
  await assert.rejects(readResource('ticket/t0000pag1/transcript', opts), /cannot be read here/);
  await assert.rejects(readResource('ticket/t0000que1/transcript', { tickets: [ticket('t0000que1', { sessionId: null })], transcript }), /has not started yet/);
});

test('thread/<key>: label, subscribed tickets and recent messages', async () => {
  const { opts } = world();
  const r = await readResource(`thread/${SLACK}`, opts);
  assert.deepEqual(r.thread, { key: SLACK, kind: 'slack', label: '#general', last_at: new Date(at(1)).toISOString() });
  assert.equal(r.total, 6);
  assert.ok(r.items.every((i) => i.id && i.stage));
  assert.deepEqual(r.recent, [{ at: new Date(at(2)).toISOString(), who: 'Kada', text: 'Any news?' }]);
  const tg = await readResource(`thread/${TG}`, opts);
  assert.equal(tg.recent, undefined);
  assert.deepEqual(tg.items.map((i) => i.id), ['t0000sib1', 't0000kid2']);
  await assert.rejects(readResource('thread/slack:acme:nope', opts), /no thread slack:acme:nope/);
});

test('bot/<handle>: its tickets, open ones first', async () => {
  const { opts } = world();
  const r = await readResource('bot/@writer', opts);
  assert.deepEqual(r.bot, { handle: '@writer', name: 'Writer' });
  assert.deepEqual(r.items.map((i) => i.id), ['t0000kid1']);
  const atlas = await readResource('@atlas', opts);
  assert.equal(atlas.bot.dispatcher, true);
  assert.equal(atlas.total, 0);
  const coder = await readResource('bot/CODER', opts);
  assert.equal(coder.items[0].stage, 'working');
  assert.equal(coder.items.at(-1).id, 't0000arc1');
  await assert.rejects(readResource('bot/nobody', opts), /no bot @nobody/);
});

test('a ticket reads only itself, its parent, its children and its threads', async () => {
  const { opts } = world();
  const asKid = { ...opts, viewer: { kind: 'ticket', ticketId: 't0000kid2' } };
  assert.equal((await readResource('ticket/t0000kid2', asKid)).card.id, 't0000kid2');
  assert.equal((await readResource('ticket/t0000par1/reports', asKid)).ref, 'ticket/t0000par1/reports');
  await assert.rejects(readResource('ticket/t0000kid1', asKid), /task t0000kid1 is outside this task\. From task t0000kid2 you can read that task, its parent and its sub-tasks/);
  await assert.rejects(readResource('ticket/t0000sib1/transcript', asKid), /outside this task/);
  await assert.rejects(readResource('ticket/tnotthere', asKid), /outside this task/, 'existence is not revealed');
  assert.equal((await readResource(`thread/${TG}`, asKid)).thread.key, TG);
  const tgFromKid = await readResource(`thread/${TG}`, asKid);
  assert.deepEqual(tgFromKid.items.map((i) => i.id), ['t0000kid2'], 'only visible subscribers are listed');

  const asSib = { ...opts, viewer: { kind: 'ticket', ticketId: 't0000sib1' } };
  await assert.rejects(readResource(`thread/${SLACK}`, asSib), /thread slack:acme:C1:1700\.1 is outside this task/);
  const mine = await readResource('tickets', asSib);
  assert.deepEqual(mine.items.map((i) => i.id), ['t0000sib1']);
  const coder = await readResource('bot/coder', asSib);
  assert.deepEqual(coder.items.map((i) => i.id), ['t0000sib1']);

  // Cards it gets carry only ids it can read: not its sibling, not the parent's threads it is not on.
  const asKid1 = { ...opts, viewer: { kind: 'ticket', ticketId: 't0000kid1' } };
  const parentCard = (await readResource('ticket/t0000par1', asKid1)).card;
  assert.deepEqual(parentCard.children, ['t0000kid1']);
  assert.equal(parentCard.origin.thread, SLACK, 'kid1 is on that thread too');
  const lonely = ticket('t0000lon1', { parentId: 't0000par1', threads: [], origin: {} });
  const view = { get: (id) => [...opts.tickets.list(), lonely].find((t) => t.id === id), list: () => [...opts.tickets.list(), lonely] };
  const seen = await readResource('ticket/t0000par1', { ...opts, tickets: view, viewer: { kind: 'ticket', ticketId: 't0000lon1' } });
  assert.equal(seen.card.origin.thread, undefined);
  assert.deepEqual(seen.card.children, ['t0000lon1']);
  const fromKid2 = (await readResource('ticket/t0000kid2', asKid)).card;
  assert.deepEqual(fromKid2.threads, [TG], 'its own threads stay');

  const asParent = { ...opts, viewer: { kind: 'ticket', ticketId: 't0000par1' } };
  const fam = await readResource('tickets', asParent);
  assert.deepEqual(fam.items.map((i) => i.id).sort(), ['t0000kid1', 't0000kid2', 't0000par1']);

  // Router and home viewers read everything.
  assert.equal((await readResource('ticket/t0000sib1', { ...opts, viewer: { kind: 'router' } })).card.id, 't0000sib1');
  assert.equal((await readResource('ticket/t0000sib1', { ...opts, viewer: { kind: 'home' } })).card.id, 't0000sib1');
  await assert.rejects(readResource('tickets', { ...opts, viewer: { kind: 'ticket', ticketId: 'tmissing0' } }), /task tmissing0 is not on record/);
});

test('unknown refs and tickets get a clear error', async () => {
  const { opts } = world();
  await assert.rejects(readResource('everything', opts), /unknown ref "everything"\. Use tickets, ticket\/<id>/);
  await assert.rejects(readResource('', opts), /unknown ref/);
  await assert.rejects(readResource('ticket/t9999zzz9', opts), /no task t9999zzz9/);
  await assert.rejects(readResource('ticket/t0000par1/secrets', opts), /unknown ref/);
});

test('the ticket store itself serves as the thread source (thread() before get())', async () => {
  const t = ticket('t0000sto1');
  const thread = { key: SLACK, kind: 'slack', label: '#general', tickets: ['t0000sto1'] };
  const store = {
    get: (id) => (id === t.id ? t : undefined),
    list: () => [t],
    children: () => [],
    thread: (key) => (key === SLACK ? thread : undefined),
    subscribers: (key) => (key === SLACK ? [t] : []),
  };
  assert.equal(ticketCard(t, { bots, threads: store }).origin.label, '#general');
  const r = await readResource(`thread/${SLACK}`, { tickets: store, threads: store, bots });
  assert.equal(r.thread.label, '#general');
  assert.deepEqual(r.items.map((i) => i.id), ['t0000sto1']);
});

test('children come from the store when it has them', async () => {
  const parent = ticket('t0000pp01');
  const kid = ticket('t0000kk01', { parentId: 't0000pp01' });
  const store = { get: (id) => [parent, kid].find((t) => t.id === id), list: () => [parent, kid], children: (id) => (id === 't0000pp01' ? [kid] : []) };
  const r = await readResource('ticket/t0000pp01', { tickets: store, bots });
  assert.deepEqual(r.card.children, ['t0000kk01']);
  assert.deepEqual(ticketCard(parent, { bots, children: ['t0000kk01'] }).children, ['t0000kk01']);
});
