import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBook } from '../lib/book.mjs';
import { classify, keyOf, ownWords } from '../lib/prompt.mjs';
import {
  DAY_MS,
  MAX_CARDS,
  cardId,
  collect,
  excerpt,
  fromReview,
  importPast,
  importedText,
  listText,
  parsePair,
  parsePicks,
  pick,
  schedule,
} from '../lib/vocab.mjs';

const NOW = 1_000_000_000;
const ZH = '帮我把这个函数改成异步的，顺便加上超时';
const ZH_EN = "Make this function async, and add a timeout while you're at it.";
const ZH2 = '先别急着提交，等测试跑完再说';
const ZH2_EN = 'Hold off on committing until the tests finish.';
const EN = 'Make this function async and add timeout';

const card = (over = {}) => ({
  id: 'c1',
  kind: 'fix',
  cue: 'add timeout',
  answer: 'add a timeout',
  addedAt: NOW,
  seen: 1,
  box: 0,
  due: NOW,
  lapses: 0,
  ...over,
});

const fixReview = {
  key: keyOf(EN),
  status: 'done',
  kind: 'review',
  verdict: 'fix',
  base: EN,
  text: 'Make this function async and add a timeout',
  note: 'article: "add timeout" → "add a timeout"',
};

// --- host notes ---------------------------------------------------------------------

test('a host note is left out of the words and the key; a prompt without one keeps both', () => {
  const note = '<system-reminder>\nThe workspace is a scratch folder.\n</system-reminder>\n';
  assert.equal(ownWords(`${note}帮我看看`), '帮我看看');
  assert.equal(classify(`${note}帮我看看这个构建`).key, keyOf('帮我看看这个构建'));
  assert.equal(ownWords('mention <system-reminder> only'), 'mention <system-reminder> only');
  assert.equal(classify(`${note}ok`), null);
});

// --- reading what the English taught -------------------------------------------------

test('a review note gives its change, and the kind of change as why', () => {
  assert.deepEqual(parsePair('article: "add timeout" → "add a timeout"'), {
    cue: 'add timeout',
    answer: 'add a timeout',
    why: 'article',
  });
  assert.deepEqual(parsePair('"more faster" -> "faster"'), { cue: 'more faster', answer: 'faster' });
  assert.deepEqual(parsePair('“make it works” → “make it work” (verb form)'), {
    cue: 'make it works',
    answer: 'make it work',
    why: 'verb form',
  });
  assert.equal(parsePair('changed the tone'), null);
  assert.equal(parsePair('"Fix it" → "fix it"'), null);
});

test('a review that reads well gives no card; a long one, one per fix', () => {
  assert.deepEqual(fromReview({ status: 'done', kind: 'review', verdict: 'ok', text: '', base: 'Looks good to me' }), []);
  const long = {
    status: 'done',
    kind: 'review',
    verdict: 'fix',
    text: '',
    base: 'long prompt',
    fixes: ['"informations" → "information"', '"discuss about" → "discuss"', 'not a pair'],
  };
  assert.deepEqual(
    fromReview(long).map((f) => f.answer),
    ['information', 'discuss'],
  );
  const [one] = fromReview(fixReview);
  assert.equal(one.context, EN);
  assert.equal(one.example, 'Make this function async and add a timeout');
});

test('a phrase is kept only where both texts hold it', () => {
  const reply = [
    "PHRASE: 顺便 => while you're at it",
    'PHRASE: 不在原文里 => add a timeout',
    'PHRASE: 超时 => graceful shutdown',
    'PHRASE: 函数 => function',
  ].join('\n');
  const picks = parsePicks(reply, [{ source: ZH, english: ZH_EN }]);
  assert.deepEqual(
    picks[0].map((f) => [f.cue, f.answer]),
    [['顺便', "while you're at it"]],
  );
  assert.deepEqual(parsePicks('NONE', [{ source: ZH, english: ZH_EN }]), [[]]);
  const hyphened = parsePicks('PHRASE: 过度设计 => over-engineered', [
    { source: '有点过度设计了', english: 'It is a bit over-engineered.' },
  ]);
  assert.equal(hyphened[0][0].answer, 'over-engineered');
});

const PLAN = '你要先调研、然后制定完善的开发计划，然后跟我沟通确认之后再动手';
const PLAN_ZH = `我有剧本资源，有 codex 可以生成图片。${'之前的做法我都不喜欢，太简陋，处处穿帮。'.repeat(8)}\n\n${PLAN}`;
const PLAN_EN = `I have a script for the story, and Codex can generate images.${" I didn't like the earlier approaches.".repeat(8)}\n\nFirst, research the options. Then draw up a solid development plan. Then check it with me before building anything.`;

test("a phrase card holds the sentences its two sides stand in, not the prompt's start", () => {
  const [found] = parsePicks('PHRASE: 制定完善的开发计划 => draw up a solid development plan', [
    { source: PLAN_ZH, english: PLAN_EN },
  ]);
  assert.deepEqual(found, [
    {
      kind: 'phrase',
      cue: '制定完善的开发计划',
      answer: 'draw up a solid development plan',
      context: PLAN,
      example: 'Then draw up a solid development plan.',
    },
  ]);

  // English the person typed among their Chinese is no cue; the words around it are.
  const mixed = { source: '要让人一眼就能 get 到重点', english: 'People should get the point at a glance.' };
  const reply = 'PHRASE: get => get the point at a glance\nPHRASE: 一眼就能 get 到重点 => get the point at a glance';
  assert.deepEqual(
    parsePicks(reply, [mixed])[0].map((f) => f.cue),
    ['一眼就能 get 到重点'],
  );
});

test('an excerpt is the sentence that holds the words, cut around them when long', () => {
  assert.equal(excerpt('First line.\nThen  Draw up\na plan. Next one.', 'draw up a plan'), 'Then Draw up a plan.');
  assert.equal(excerpt('一。二。三。四。', '三。'), '三。');
  assert.equal(excerpt('一。二。三。四。', '三。', 1), '二。三。四。');
  assert.equal(excerpt('Nothing here. At all.', 'draw up'), 'Nothing here. At all.');

  const long = `${'很长的背景说明，'.repeat(40)}然后制定完善的开发计划，${'再补充一些要求，'.repeat(40)}`;
  const got = excerpt(long, '制定完善的开发计划');
  assert.ok(got.includes('制定完善的开发计划'));
  assert.ok(got.startsWith('…') && got.endsWith('…'));
  assert.ok(got.length <= 202);
});

test('a pattern is a sentence of both texts whose frame is its own words', () => {
  const items = [
    { source: ZH, english: ZH_EN },
    { source: ZH2, english: ZH2_EN },
  ];
  const reply = [
    "[1] PHRASE: 顺便 => while you're at it",
    '[2] PATTERN: 先别急着提交，等测试跑完再说 => Hold off on committing until the tests finish. => Hold off on ___ until ___',
    '[2] PATTERN: 先别急着提交 => Hold off on committing => Hold off on ___',
  ].join('\n');
  const [first, second] = parsePicks(reply, items);
  assert.deepEqual(
    first.map((f) => f.kind),
    ['phrase'],
  );
  assert.deepEqual(second, [{ kind: 'pattern', cue: ZH2, answer: ZH2_EN, pattern: 'Hold off on ___ until ___' }]);

  const bad = [
    '[1] PATTERN: 先别急着提交，等测试跑完再说 => Hold off on committing until the tests finish. => Wait to ___ until ___',
    '[1] PATTERN: 先别急着提交，等测试跑完再说 => Hold off on committing until the tests finish. => Hold off on committing',
    '[1] PATTERN: 等一下 => Hold off on committing until the tests finish. => Hold off on ___ until ___',
  ].join('\n');
  assert.deepEqual(parsePicks(bad, [{ source: ZH2, english: ZH2_EN }]), [[]]);
});

test('a card moves up a box when known, starts over when forgotten', () => {
  const known = schedule(card(), 'good', NOW);
  assert.deepEqual([known.box, known.due], [1, NOW + DAY_MS]);
  const better = schedule(known, 'good', NOW);
  assert.deepEqual([better.box, better.due], [2, NOW + 3 * DAY_MS]);
  const lost = schedule(better, 'again', NOW);
  assert.deepEqual([lost.box, lost.lapses], [0, 1]);
  assert.ok(lost.due - NOW < DAY_MS);
  assert.equal(schedule(better, 'hard', NOW).box, 2);
  assert.deepEqual(
    pick([card({ id: 'a', due: NOW + DAY_MS }), card({ id: 'b', due: NOW - 1 })], NOW).map((c) => c.id),
    ['b'],
  );
});

// --- the book ---------------------------------------------------------------------------

test('the book keeps one card per thing taught, and the same mistake again starts it over', () => {
  const book = createBook(null);
  const [first] = book.file(fromReview(fixReview), NOW);
  assert.equal(first.id, cardId('fix', 'add timeout', 'add a timeout'));
  assert.equal(first.seen, 1);
  book.grade(first.id, 'good', NOW);
  book.grade(first.id, 'good', NOW);
  assert.equal(book.get(first.id).box, 2);

  const [again] = book.file(fromReview(fixReview), NOW + 5);
  assert.equal(book.size(), 1);
  assert.deepEqual([again.seen, again.box, again.due], [2, 0, NOW + 5]);
  assert.match(listText(book.cards(), NOW + 5), /add timeout → add a timeout（article） ×2/);
  assert.match(listText(book.cards(), NOW + 5), /1 条到期/);

  assert.equal(book.drop(first.id), true);
  assert.equal(book.drop(first.id), false);
  assert.match(listText(book.cards(), NOW), /生词本还是空的/);
});

test('the book is written to its file and read back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-en-book-'));
  const file = join(dir, 'vocab.json');
  const book = createBook(file);
  book.file([{ kind: 'phrase', cue: '顺便', answer: "while you're at it" }], NOW);
  book.markDone(['k1']);
  book.flush();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.keys(saved.cards).length, 1);
  assert.deepEqual(saved.done, ['k1']);

  const again = createBook(file);
  assert.equal(again.size(), 1);
  assert.equal(again.isDone('k1'), true);
  assert.equal(again.isDone('k2'), false);
});

test('an unchanged book writes nothing at unload, so a newer file survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-en-book-'));
  const file = join(dir, 'vocab.json');
  const stale = createBook(file);
  const fresh = createBook(file);
  fresh.file(fromReview(fixReview), NOW);
  fresh.flush();
  stale.flush();
  assert.equal(createBook(file).size(), 1);
});

test('the book keeps at most its limit, the best known oldest leaving first', () => {
  const book = createBook(null);
  const found = Array.from({ length: MAX_CARDS }, (_, i) => ({ kind: 'phrase', cue: `词${i}`, answer: `phrase number ${i}` }));
  book.file(found, NOW);
  const known = cardId('phrase', '词0', 'phrase number 0');
  book.grade(known, 'good', NOW);
  book.file([{ kind: 'phrase', cue: '新词', answer: 'a new phrase' }], NOW + 1);
  assert.equal(book.size(), MAX_CARDS);
  assert.equal(book.get(known), undefined);
});

test('due cards are mentioned at most every twelve hours, and only when some are due', () => {
  const book = createBook(null);
  assert.equal(book.takeNudge(NOW), 0);
  book.file(fromReview(fixReview), NOW);
  assert.equal(book.takeNudge(NOW), 1);
  assert.equal(book.takeNudge(NOW + 60_000), 0);
  assert.equal(book.takeNudge(NOW + 13 * 3_600_000), 1);
});

// --- collecting and importing -----------------------------------------------------------

/** A model that answers picks with `reply`, counting its calls. */
function model(reply) {
  const calls = [];
  const ask = async (request) => {
    calls.push(request);
    return typeof reply === 'function' ? reply(request) : reply;
  };
  return { ask, calls };
}

test('a finished review is filed without a call; a translation costs one pick', async () => {
  const book = createBook(null);
  const m = model("PHRASE: 顺便 => while you're at it");
  await collect({ book, key: fixReview.key, item: fixReview, source: EN, weight: 40, ask: m.ask, now: NOW });
  assert.equal(m.calls.length, 0);
  assert.equal(book.size(), 1);

  const translation = { key: keyOf(ZH), status: 'done', kind: 'translate', text: ZH_EN };
  await collect({ book, key: translation.key, item: translation, source: ZH, weight: 40, ask: m.ask, now: NOW });
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0].system, /worth learning/);
  assert.match(m.calls[0].prompt, /<original>\n帮我把这个函数/);
  assert.match(listText(book.cards(), NOW), /顺便 → while you're at it/);

  // The same prompt again: filed already, no call.
  await collect({ book, key: translation.key, item: translation, source: ZH, weight: 40, ask: m.ask, now: NOW });
  assert.equal(m.calls.length, 1);
});

test('a short translation gives no pick; a failed pick leaves the prompt for an import', async () => {
  const book = createBook(null);
  const m = model(null);
  const short = { key: keyOf('跑一下'), status: 'done', kind: 'translate', text: 'Run it.' };
  await collect({ book, key: short.key, item: short, source: '跑一下', weight: 7, ask: m.ask, now: NOW });
  assert.equal(m.calls.length, 0);
  assert.equal(book.isDone(short.key), true);

  const long = { key: keyOf(ZH), status: 'done', kind: 'translate', text: ZH_EN };
  await collect({ book, key: long.key, item: long, source: ZH, weight: 40, ask: m.ask, now: NOW });
  assert.equal(m.calls.length, 1);
  assert.equal(book.isDone(long.key), false);
});

test('an import files the reviews as they stand and the translations eight to a call', async () => {
  const book = createBook(null);
  const answers = [
    { id: 's1:2', item: { key: keyOf(ZH), status: 'done', kind: 'translate', text: ZH_EN } },
    { id: 's1:9', item: { key: keyOf(ZH2), status: 'done', text: ZH2_EN } },
    { id: 's2:4', item: fixReview },
    { id: 's2:7', item: { key: keyOf('跑一下'), status: 'done', kind: 'translate', text: 'Run it.' } },
    { id: 's2:8', item: { key: 'gone', status: 'done', kind: 'translate', text: 'Lost.' } },
    { id: 's3:1', item: { key: keyOf(ZH), status: 'done', kind: 'translate', text: ZH_EN } },
  ];
  const prompts = { 's1:2': ZH, 's1:9': ZH2, 's2:7': '跑一下', 's3:1': ZH };
  const reads = [];
  const readPrompt = async (id) => {
    reads.push(id);
    if (id === 's2:8') throw new Error('session gone');
    return prompts[id] ?? '';
  };
  const m = model(
    "[1] PHRASE: 顺便 => while you're at it\n[2] PATTERN: 先别急着提交，等测试跑完再说 => Hold off on committing until the tests finish. => Hold off on ___ until ___",
  );
  const progress = [];
  const r = await importPast({
    book,
    answers,
    readPrompt,
    ask: m.ask,
    now: () => NOW,
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(m.calls.length, 1);
  assert.deepEqual(progress, [[2, 2]]);
  // The same prompt in a second session is read once.
  assert.deepEqual(reads, ['s1:2', 's1:9', 's2:7', 's2:8']);
  assert.deepEqual(r, { prompts: 3, cards: 3, byKind: { fix: 1, phrase: 1, pattern: 1 }, failed: 0 });
  assert.match(importedText(r), /看了 3 条以前的 prompt，新收 3 张（纠错 1 · 短语 1 · 句型 1）/);

  const listed = listText(book.cards(), NOW);
  assert.match(listed, /add timeout → add a timeout/);
  assert.match(listed, /Hold off on ___ until ___/);

  // Again: nothing new, and no call.
  const again = await importPast({ book, answers, readPrompt, ask: m.ask, now: () => NOW });
  assert.equal(m.calls.length, 1);
  assert.equal(importedText(again), '生词本：没有新的可以导入了。');
});

test('an import whose calls fail says so, and the next one tries again', async () => {
  const book = createBook(null);
  const answers = [{ id: 's1:2', item: { key: keyOf(ZH), status: 'done', kind: 'translate', text: ZH_EN } }];
  const readPrompt = async () => ZH;
  const failing = await importPast({ book, answers, readPrompt, ask: async () => null, now: () => NOW });
  assert.equal(failing.failed, 1);
  assert.match(importedText(failing), /1 条没拿到模型回复/);
  const m = model("PHRASE: 顺便 => while you're at it");
  const ok = await importPast({ book, answers, readPrompt, ask: m.ask, now: () => NOW });
  assert.equal(ok.cards, 1);
});
