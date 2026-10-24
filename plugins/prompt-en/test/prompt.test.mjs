import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReview,
  buildTranslate,
  classify,
  clean,
  keyOf,
  markChanges,
  modeOf,
  parseReview,
  prepare,
} from '../lib/prompt.mjs';

test('pasted code is folded before anything is sent', () => {
  const code = Array.from({ length: 120 }, (_, i) => `  const x${i} = ${i};`).join('\n');
  const p = prepare(`帮我看看这段代码为什么报错\n\n\`\`\`ts\n${code}\n\`\`\`\n\n谢谢`);
  assert.deepEqual(p.materials, [{ lines: 120, head: 'const x0 = 0;', lang: 'ts' }]);
  assert.equal(p.prose, '帮我看看这段代码为什么报错\n\n[[M1]]\n\n谢谢');

  // An unfenced paste: a tall block with no foreign letters.
  const log = Array.from({ length: 30 }, (_, i) => `ERROR build step ${i} failed at src/a.ts:${i}`).join('\n');
  const q = prepare(`构建失败了：\n\n${log}`);
  assert.equal(q.materials.length, 1);

  // Chinese inside the code alone does not make a prompt foreign.
  assert.equal(modeOf(`Why does this fail?\n\n\`\`\`\nconsole.log("你好")\n\`\`\``), 'review');
  assert.equal(modeOf('fix 这个 bug'), 'translate');
  assert.equal(modeOf('ok'), null);
});

test('a long prompt asks for its gist, a short one for a translation', () => {
  const long = buildTranslate(prepare('我'.repeat(800)));
  assert.equal(long.isCondensed, true);
  assert.match(long.prompt, /gist/);
  assert.equal(long.maxTokens, 600);

  const short = buildTranslate(prepare('帮我加个超时'));
  assert.equal(short.isCondensed, false);
  assert.match(short.prompt, /faithfully/);
});

test('a translation restores paste labels', () => {
  const p = prepare('看看这个\n\n```ts\nconst a = 1;\n```');
  assert.equal(clean('Look at this [pasted, 1 lines]', p.materials), 'Look at this [pasted, 1 lines]');
});

test('parseReview reads a fix, and strips a paste at either end', () => {
  const p = prepare('Make this function async and add timeout.');
  const review = parseReview(
    ['VERDICT: fix', 'TEXT: Make this function async and add a timeout.', 'NOTE: article: "add timeout" → "add a timeout"'].join(
      '\n',
    ),
    p,
  );
  assert.equal(review.verdict, 'fix');
  assert.equal(review.text, 'Make this function async and add a timeout.');
  assert.match(review.note, /article/);
});

test('parseReview reads alternatives for a prompt that reads well', () => {
  const review = parseReview(
    ['VERDICT: ok', 'ALT: Can you make this async?', 'ALT: Please convert this function to async.'].join('\n'),
    prepare('Could you make this function async?'),
  );
  assert.equal(review.verdict, 'ok');
  assert.deepEqual(review.alts, ['Can you make this async?', 'Please convert this function to async.']);
});

test('a review that says it needs changing but gives no change is unreadable', () => {
  assert.equal(parseReview('VERDICT: fix\nTEXT: N/A', prepare('Make it fast.')), null);
  assert.equal(parseReview('sorry, I cannot help', prepare('Make it fast.')), null);
});

test('markChanges marks only the new words', () => {
  const runs = markChanges('add timeout', 'add a timeout');
  const marked = runs.filter((r) => r.isNew).map((r) => r.text).join('');
  assert.match(marked, /a /);
  assert.equal(runs.map((r) => r.text).join(''), 'add a timeout');
});

test('keys ignore spacing differences', () => {
  assert.equal(keyOf('你好  世界\n'), keyOf('你好 世界'));
  assert.notEqual(keyOf('你好'), keyOf('您好'));
});

test('a long English prompt lists fixes instead of rewriting', () => {
  const long = 'word '.repeat(400).trim();
  const review = buildReview(prepare(long));
  assert.equal(review.isCondensed, true);
  assert.match(review.prompt, /list the changes/);
});

test('classify returns the mode and a stable key', () => {
  const c = classify('帮我把这个函数改成异步的');
  assert.equal(c.mode, 'translate');
  assert.equal(c.key, keyOf('帮我把这个函数改成异步的'));
  assert.equal(classify('ok'), null);
});
