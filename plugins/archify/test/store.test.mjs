import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '../lib/store.mjs';

test('a page rewritten by a repair keeps its id and moves to the top', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archify-store-'));
  const page = join(dir, 'a.html');
  writeFileSync(page, '<html>');
  const store = createStore(dir);
  const a = store.put({ html: page, title: 'A', updatedAt: 1 });
  const b = store.put({ html: join(dir, 'b.html'), title: 'B', updatedAt: 2 });
  const again = store.put({ html: page, title: 'A2', updatedAt: 3 });
  assert.equal(again.id, a.id);
  assert.equal(again.createdAt, 1);
  assert.equal(store.size(), 2);
  const listed = store.list();
  assert.deepEqual(listed.items.map((i) => i.title), ['A2', 'B']);
  assert.equal(listed.items[0].missing, false);
  assert.equal(listed.items[1].missing, true);
  assert.equal(store.get(b.id).title, 'B');
  assert.equal(store.remove(b.id), true);
  assert.equal(store.remove('nope'), false);
  store.flush();
  const saved = JSON.parse(readFileSync(join(dir, 'gallery.json'), 'utf8'));
  assert.equal(saved.items.length, 1);
  assert.equal(createStore(dir).get(a.id).title, 'A2');
});

test('the list pages with `before`', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archify-store-'));
  const store = createStore(dir);
  for (let i = 0; i < 5; i += 1) store.put({ html: join(dir, `${i}.html`), title: String(i), updatedAt: i });
  const first = store.list({ limit: 2 });
  assert.deepEqual(first.items.map((i) => i.title), ['4', '3']);
  assert.equal(first.hasMore, true);
  const next = store.list({ limit: 2, before: first.items[1].id });
  assert.deepEqual(next.items.map((i) => i.title), ['2', '1']);
  assert.equal(store.list({ limit: 2, before: 'gone' }).items.length, 0);
});
