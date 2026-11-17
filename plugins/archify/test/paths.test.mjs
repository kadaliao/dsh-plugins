import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { TYPES, candidateName, planPaths, resolveFrom, slugify, stamp, titleOf } from '../lib/paths.mjs';

test('slugify keeps Latin words and drops the rest', () => {
  assert.equal(slugify('My Checkout Flow!'), 'my-checkout-flow');
  assert.equal(slugify('Café  Ordering'), 'cafe-ordering');
  assert.equal(slugify('订单系统'), '');
  assert.equal(slugify('x'.repeat(80)).length, 48);
});

test('stamp is local YYYYMMDD-HHMMSS', () => {
  assert.equal(stamp(new Date(2026, 10, 7, 9, 5, 3)), '20261107-090503');
});

test('paths resolve from the working directory, ~ and absolute', () => {
  assert.equal(resolveFrom('/w', 'a/b.json'), '/w/a/b.json');
  assert.equal(resolveFrom('/w', '/abs/c.json'), '/abs/c.json');
  assert.equal(resolveFrom('/w', '~/d.json'), join(homedir(), 'd.json'));
  assert.equal(resolveFrom('/w', ''), '');
});

test('a new request gets its own folder, named from `name`, then the title', () => {
  const now = new Date(2026, 10, 17, 18, 30, 0);
  const p = planPaths({ cwd: '/w', type: 'sequence', name: 'Checkout Flow', now });
  assert.equal(p.folder, '/w/.archify/sequence-checkout-flow-20261117-183000');
  assert.equal(p.candidate, `${p.folder}/candidate.json`);
  assert.equal(p.output, `${p.folder}/checkout-flow.html`);
  assert.equal(p.created, true);
  assert.equal(planPaths({ cwd: '/w', type: 'erd', title: 'Orders', now }).slug, 'orders');
  assert.equal(planPaths({ cwd: '/w', type: 'erd', title: '订单', now }).slug, 'diagram');
  const ex = planPaths({ cwd: '/w', type: 'explainer', name: 'tls', now });
  assert.equal(ex.candidate, `${ex.folder}/candidate.archify.md`);
  assert.equal(candidateName('explainer'), 'candidate.archify.md');
  assert.ok(TYPES.includes('waterfall') && TYPES.includes('explainer'));
});

test('a repair names the candidate and lands on the same page', () => {
  const folder = '/w/.archify/sequence-checkout-flow-20261117-183000';
  const p = planPaths({ cwd: '/w', type: 'sequence', candidate: '.archify/sequence-checkout-flow-20261117-183000/candidate.json' });
  assert.equal(p.folder, folder);
  assert.equal(p.output, `${folder}/checkout-flow.html`);
  assert.equal(p.created, false);
  // Any other candidate file: its own stem, beside it.
  assert.equal(planPaths({ cwd: '/w', type: 'erd', candidate: 'docs/orders.erd.json' }).output, '/w/docs/orders.erd.html');
  // An explicit output wins.
  assert.equal(planPaths({ cwd: '/w', type: 'erd', candidate: 'docs/orders.erd.json', output: 'out/o.html' }).output, '/w/out/o.html');
});

test('titles come from meta.title or the explainer heading', () => {
  assert.equal(titleOf('architecture', '{"meta":{"title":" Shop "}}'), 'Shop');
  assert.equal(titleOf('architecture', { meta: { title: 'Obj' } }), 'Obj');
  assert.equal(titleOf('architecture', 'not json'), '');
  assert.equal(titleOf('explainer', '# Why is TLS slow? {#tls}\n\nBecause.'), 'Why is TLS slow?');
});
