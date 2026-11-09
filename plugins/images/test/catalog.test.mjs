import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { catalogNames, catalogPerImage, compactCatalog, createCatalog, lookupCatalog } from '../lib/catalog.mjs';
import { estimateCost } from '../lib/pricing.mjs';
import { LITELLM_SAMPLE } from './fixtures.mjs';

const catalog = compactCatalog(LITELLM_SAMPLE);

test('only priced image-generation rows are kept, one record per model and provider', () => {
  const names = catalogNames(catalog);
  assert.ok(names.includes('gpt-image-2.6-sunburst'));
  assert.ok(names.includes('grok-imagine-image'));
  assert.equal(names.includes('gpt-5.4'), false, 'chat models are left out');
  assert.equal(names.includes('flux-kontext-pro'), false, 'edit-only models are left out');
  assert.equal(names.includes('qwen-image-3.0'), false, 'a row without a price is left out');
  assert.equal(names.includes('gpt-image-2-2026-04-21'), false, 'dated snapshots stay out of the picker');
  assert.equal(names.includes('dev'), false, '`flux/dev` is not offered as `dev`');
  assert.ok(catalog.groups.every((g) => !g.name.endsWith('/edit')));
});

test('a model is found under its routing prefix, by vendor, or as a dated variant', () => {
  const sunburst = lookupCatalog(catalog, 'sub2api/gpt-image-2.6-sunburst');
  assert.equal(sunburst.name, 'gpt-image-2.6-sunburst');
  assert.equal(sunburst.provider, 'openai');
  assert.equal(sunburst.approximate, false);
  assert.deepEqual(sunburst.tokens, { textIn: 5, textCached: 1.25, imageIn: 8, imageCached: 2, imageOut: 30, textOut: 0 });

  // The vendor's own price wins over a reseller's, unless the reseller is asked for.
  assert.equal(lookupCatalog(catalog, 'gpt-image-2').provider, 'openai');
  assert.equal(lookupCatalog(catalog, 'openai/gpt-image-2').provider, 'openai');
  assert.equal(lookupCatalog(catalog, 'fal_ai/gpt-image-2').provider, 'fal_ai');
  assert.equal(lookupCatalog(catalog, 'flux-pro').provider, 'black_forest_labs');

  const dated = lookupCatalog(catalog, 'magpie/gpt-image-2-2026-12-01');
  assert.equal(dated.name, 'gpt-image-2');
  assert.equal(dated.approximate, true);
  // `gpt-image-2` is not a stand-in for a different version.
  assert.equal(lookupCatalog(catalog, 'gpt-image-2.7-sunburst'), undefined);
  assert.equal(lookupCatalog(catalog, 'dev'), undefined);
  assert.equal(lookupCatalog(catalog, ''), undefined);
  assert.equal(lookupCatalog(undefined, 'gpt-image-2'), undefined);
});

test('a flat price comes from the size and quality rows, a per-image price, or a per-pixel one', () => {
  const fal = lookupCatalog(catalog, 'fal_ai/gpt-image-2');
  assert.deepEqual(catalogPerImage(fal, '1024x1024', 'high'), { amount: 0.211, currency: 'USD' });
  assert.deepEqual(catalogPerImage(fal, '1024x1024', 'low'), { amount: 0.006, currency: 'USD' });
  // No exact size: the nearest of the same shape.
  assert.deepEqual(catalogPerImage(fal, '1536x1024', 'high'), { amount: 0.165, currency: 'USD' });
  assert.deepEqual(catalogPerImage(lookupCatalog(catalog, 'xai/grok-imagine-image'), 'auto', ''), { amount: 0.02, currency: 'USD' });
  // A row priced by tokens does not take its input-image price for an output price.
  assert.deepEqual(catalogPerImage(lookupCatalog(catalog, 'gemini-3-pro-image'), '1024x1024', ''), { amount: 0.134, currency: 'USD' });
  assert.equal(catalogPerImage(lookupCatalog(catalog, 'gpt-image-2.6-sunburst'), '1024x1024', ''), undefined);
  const dalle = lookupCatalog(catalog, 'azure/dall-e-3');
  assert.ok(Math.abs(catalogPerImage(dalle, '1024x1792', 'hd').amount - 7.19343e-8 * 1024 * 1792) < 1e-9);
});

test('the catalog prices what the built-in list cannot, after usage, provider and list', () => {
  const sunburst = lookupCatalog(catalog, 'sub2api/gpt-image-2.6-sunburst');
  const usage = { input_tokens: 397, output_tokens: 2744, total_tokens: 3141 };
  const byUsage = estimateCost({ model: 'sub2api/gpt-image-2.6-sunburst', usage, catalog: sunburst });
  assert.equal(byUsage.source, 'usage');
  assert.equal(byUsage.catalog, 'gpt-image-2.6-sunburst');
  assert.ok(Math.abs(byUsage.amount - (397 * 5 + 2744 * 30) / 1e6) < 1e-12, String(byUsage.amount));
  // Token prices alone cannot price a reply without usage: the typed price covers it.
  assert.equal(estimateCost({ model: 'sub2api/gpt-image-2.6-sunburst', catalog: sunburst }), undefined);
  assert.equal(estimateCost({ model: 'sub2api/gpt-image-2.6-sunburst', catalog: sunburst, manual: { amount: 0.1, currency: 'USD' } }).source, 'manual');

  const grok = lookupCatalog(catalog, 'grok-imagine-image');
  assert.deepEqual(estimateCost({ model: 'grok-imagine-image', n: 2, catalog: grok }), { amount: 0.04, currency: 'USD', source: 'catalog', perImage: 0.02, family: '', catalog: 'grok-imagine-image' });
  // The provider's own price comes first.
  assert.equal(estimateCost({ model: 'grok-imagine-image', catalog: grok, providerRecord: { pricing: { per_image: 0.03 } } }).source, 'provider');
  // A model the built-in list knows ignores the catalog.
  assert.equal(estimateCost({ model: 'gpt-image-1', size: '1024x1024', quality: 'low', catalog: grok }).source, 'list');
});

test('the catalog is downloaded once, cached on disk, and falls back to the mirror', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'images-catalog-'));
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    if (url.startsWith('https://primary')) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(LITELLM_SAMPLE) };
  };
  const first = createCatalog(dir, { sources: ['https://primary/x.json', 'https://mirror/x.json'], fetch });
  assert.equal(first.current(), null);
  const data = await first.ensure(1000);
  assert.ok(lookupCatalog(data, 'gpt-image-2.6-sunburst'));
  assert.deepEqual(asked, ['https://primary/x.json', 'https://mirror/x.json']);
  assert.ok(existsSync(join(dir, 'price-catalog.json')));
  assert.equal(first.status().error, '');
  assert.ok(first.status().count > 0);

  // A restart reads the file; a fresh file is not fetched again.
  const second = createCatalog(dir, { sources: ['https://mirror/x.json'], fetch });
  assert.ok(second.current());
  await second.ensure(1000);
  assert.equal(asked.length, 2);

  // A week later it is refreshed behind, the old copy answering meanwhile.
  const later = createCatalog(dir, { sources: ['https://mirror/x.json'], fetch, now: () => Date.now() + 8 * 24 * 3600_000 });
  assert.ok(await later.ensure(1000));
  await later.refresh();
  assert.equal(asked.length, 3);
});

test('an unreachable catalog leaves the price blank and is not retried on every picture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'images-catalog-'));
  let asked = 0;
  const fetch = async () => {
    asked += 1;
    throw new Error('getaddrinfo ENOTFOUND');
  };
  const cat = createCatalog(dir, { sources: ['https://nowhere/x.json'], fetch });
  assert.equal(await cat.ensure(1000), null);
  assert.match(cat.status().error, /ENOTFOUND/);
  assert.equal(await cat.ensure(1000), null);
  assert.equal(asked, 1, 'the retry waits');
  await cat.refresh(true);
  assert.equal(asked, 2, 'an explicit refresh tries again');
  const off = createCatalog(dir, { enabled: false, fetch });
  assert.equal(await off.ensure(1000), null);
  assert.equal(asked, 2, 'a disabled catalog never fetches');
});
