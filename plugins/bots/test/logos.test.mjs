import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import { LOGOS, isLogoName, withLogo } from '../lib/logos.mjs';
import { catalog } from '../lib/apps.mjs';
import { serveLogo, templates } from '../index.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('every logo the catalog names ships as a PNG', () => {
  for (const name of new Set([...Object.values(LOGOS), 'anthropic'])) {
    const file = new URL(`../logos/${name}.png`, import.meta.url);
    assert.ok(existsSync(file), name);
    assert.deepEqual(readFileSync(file).subarray(0, 4), PNG, name);
  }
});

test('every logo key is a catalog app, and the entries carry it', () => {
  const ids = new Set(catalog().map((e) => e.id));
  for (const id of Object.keys(LOGOS)) assert.ok(ids.has(id), id);
  const byId = Object.fromEntries(templates().map((e) => [e.id, e]));
  assert.equal(byId['feishu-chat'].logo, 'feishu');
  assert.equal(byId.telegram.logo, 'telegram');
  assert.equal(byId['mcp-stdio'].logo, undefined);
  assert.equal(withLogo({ id: 'nope' }).logo, undefined);
});

function request(path, method = 'GET') {
  const res = new PassThrough();
  res.headers = {};
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => res.on('finish', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })));
  serveLogo({ url: path, method }, res);
  return done;
}

test('the logo route serves known logos only', async () => {
  const ok = await request('/__dsh_bots/logo/slack.png');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.deepEqual(ok.body.subarray(0, 4), PNG);
  for (const bad of ['/__dsh_bots/logo/..%2Findex.js', '/__dsh_bots/logo/nope.png', '/__dsh_bots/logo/slack.svg', '/__dsh_bots/logo/%2E%2E%2Fpackage.json']) {
    assert.equal((await request(bad)).status, 404, bad);
  }
  assert.equal(isLogoName('../x'), false);
});
