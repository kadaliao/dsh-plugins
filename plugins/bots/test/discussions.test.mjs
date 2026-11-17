import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { chatMessageRef, createDiscussions, forkPoint, IDLE_ARCHIVE_MS, messageRef, positionOf, seqByTime } from '../lib/discussions.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'bots-discussions-'));

test('a discussion is found by its key, its Session and its root, and survives a reload', () => {
  const dir = tmp();
  try {
    let t = 1000;
    const d = createDiscussions(dir, { now: () => t });
    const rec = d.add({ key: 'panel:s1:pabc12345', botId: 'b1', sessionId: 'session-f1', rootId: 'pabc12345', source: { sessionId: 's1', seq: 12 }, title: 'token 账' });
    assert.equal(rec.createdAt, 1000);
    assert.deepEqual(d.get('panel:s1:pabc12345').source, { sessionId: 's1', seq: 12 });
    assert.equal(d.bySession('session-f1').key, 'panel:s1:pabc12345');
    assert.equal(d.byRoot('pabc12345').sessionId, 'session-f1');
    t = 2000;
    d.touch('panel:s1:pabc12345');
    d.flush();
    const again = createDiscussions(dir, { now: () => t });
    assert.equal(again.bySession('session-f1').lastAt, 2000);
    assert.equal(again.list({ botId: 'b1' }).length, 1);
    assert.equal(again.list({ botId: 'b2' }).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a discussion needs a key, a bot and a Session; adding the same key again keeps when it started', () => {
  const dir = tmp();
  try {
    let t = 1;
    const d = createDiscussions(dir, { now: () => t });
    assert.throws(() => d.add({ key: 'k', botId: 'b' }), /Session/);
    d.add({ key: 'k', botId: 'b', sessionId: 's-a' });
    t = 5;
    const next = d.add({ key: 'k', botId: 'b', sessionId: 's-b' });
    assert.equal(next.createdAt, 1);
    assert.equal(d.bySession('s-a'), undefined);
    assert.equal(d.bySession('s-b').key, 'k');
    assert.equal(d.remove('k'), true);
    assert.equal(d.bySession('s-b'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('idle discussions are listed for archiving; an archived one is not listed again', () => {
  const dir = tmp();
  try {
    let t = 0;
    const d = createDiscussions(dir, { now: () => t });
    d.add({ key: 'a', botId: 'b', sessionId: 's-a' });
    t = 10;
    d.add({ key: 'b', botId: 'b', sessionId: 's-b' });
    t = IDLE_ARCHIVE_MS + 5;
    assert.deepEqual(d.idle().map((x) => x.key), ['a']);
    d.patch('a', { archivedAt: t });
    assert.deepEqual(d.idle(), []);
    d.patch('a', { archivedAt: null });
    assert.equal(d.get('a').archivedAt, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anchors keep the newest position; seen times only move forward', () => {
  const dir = tmp();
  try {
    const d = createDiscussions(dir);
    d.anchor(messageRef('p1'), { sessionId: 's', seq: 3 });
    d.anchor(messageRef('p1'), { sessionId: 's', seq: 9 });
    d.anchor(chatMessageRef('bot/app', 'c1', 'm1'), { sessionId: 's', seq: 'x' });
    assert.deepEqual(d.anchorOf('msg:p1'), { sessionId: 's', seq: 9 });
    assert.equal(d.anchorOf('chat:bot/app:c1:m1'), null);
    d.markSeen('p1', 50);
    d.markSeen('p1', 20);
    assert.equal(d.seenAt('p1'), 50);
    assert.equal(d.seenAt('p2'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the fork point: the Thread\'s own last exchange, else the replied message, else the latest turn', () => {
  assert.deepEqual(forkPoint({ thread: { sessionId: 'h', seq: 40 }, root: { sessionId: 'h', seq: 12 }, fallback: 'h' }), { sessionId: 'h', seq: 40 });
  assert.deepEqual(forkPoint({ root: { sessionId: 'h', seq: 12 }, fallback: 'h' }), { sessionId: 'h', seq: 12 });
  assert.deepEqual(forkPoint({ root: { sessionId: 'h' }, fallback: 'h2' }), { sessionId: 'h2' });
  assert.equal(forkPoint({}), null);
  assert.equal(positionOf({ sessionId: 's', seq: -1 }), null);
});

test('a message without an anchor is found in the log by time: a bot\'s at its event, a person\'s at the end of its turn', () => {
  const events = [
    { seq: 0, time: 100, type: 'session/created' },
    { seq: 1, time: 200, type: 'user/message' },
    { seq: 2, time: 260, type: 'assistant/message' },
    { seq: 3, time: 270, type: 'turn/end' },
    { seq: 4, time: 500, type: 'user/message' },
    { seq: 5, time: 560, type: 'assistant/message' },
  ];
  assert.equal(seqByTime(events, { at: 261 }, 0), 2);
  assert.equal(seqByTime(events, { at: 200, fromPerson: true }, 0), 3);
  // Its turn still runs: the message itself.
  assert.equal(seqByTime(events, { at: 500, fromPerson: true }, 0), 4);
  assert.equal(seqByTime(events, { at: 50 }, 0), undefined);
  assert.equal(seqByTime([], { at: 50 }), undefined);
});

test('a person\'s message logged before a model took it is found by its own event, with the answer its turn gave', () => {
  const events = [
    { seq: 0, time: 100, type: 'user/message' },
    { seq: 1, time: 150, type: 'assistant/message' },
    { seq: 2, time: 160, type: 'turn/end' },
    // Sent at 300 while nothing ran; taken at 900.
    { seq: 3, time: 900, type: 'user/message' },
    { seq: 4, time: 950, type: 'assistant/message' },
    { seq: 5, time: 960, type: 'turn/end' },
  ];
  assert.equal(seqByTime(events, { at: 300, fromPerson: true }, 0), 5);
  // The log's tail starts after the message: its place is not known.
  assert.equal(seqByTime(events.slice(3), { at: 300, fromPerson: true }, 0), undefined);
});

test('the main chat hears of its threads from when the file began, then from the last time it heard', () => {
  const dir = tmp();
  try {
    let t = 500;
    const d = createDiscussions(dir, { now: () => t });
    assert.equal(d.toldAt('b1'), 500);
    t = 900;
    d.markTold('b1', 800);
    d.markTold('b1', 700);
    assert.equal(d.toldAt('b1'), 800);
    assert.equal(d.toldAt('b2'), 500);
    d.flush();
    const again = createDiscussions(dir, { now: () => 2000 });
    assert.deepEqual([again.toldAt('b1'), again.toldAt('b2')], [800, 500]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
