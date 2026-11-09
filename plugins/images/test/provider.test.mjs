import assert from 'node:assert/strict';
import test from 'node:test';

import { PNG_2x3 } from './fixtures.mjs';
import { costFromUsage, estimateCost, familyOf, totalsOf } from '../lib/pricing.mjs';
import { buildRequest, dimensionsOf, errorMessage, extensionOf, imagesEndpoint, parseReply, sniffMediaType } from '../lib/provider.mjs';

test('the images endpoint follows the base URL\'s API version', () => {
  assert.equal(imagesEndpoint('http://127.0.0.1:3425/v1'), 'http://127.0.0.1:3425/v1/images/generations');
  assert.equal(imagesEndpoint('http://127.0.0.1:3425/v1/'), 'http://127.0.0.1:3425/v1/images/generations');
  assert.equal(imagesEndpoint('https://api.openai.com'), 'https://api.openai.com/v1/images/generations');
  assert.equal(imagesEndpoint('https://ark.example.com/api/v3'), 'https://ark.example.com/api/v3/images/generations');
  assert.equal(imagesEndpoint(''), '');
});

test('the request leaves out what was not asked for', () => {
  assert.deepEqual(buildRequest({ model: 'm', prompt: 'p' }), { model: 'm', prompt: 'p' });
  assert.deepEqual(buildRequest({ model: 'm', prompt: 'p', n: 1, size: 'auto', quality: 'auto' }), { model: 'm', prompt: 'p' });
  assert.deepEqual(
    buildRequest({ model: 'm', prompt: 'p', n: 9, size: '1536x1024', quality: 'high' }),
    { model: 'm', prompt: 'p', n: 4, size: '1536x1024', quality: 'high' },
  );
});

test('a reply yields its images, inline or by URL, and an error its message', () => {
  assert.deepEqual(parseReply({ data: [{ b64_json: 'AAAA', revised_prompt: ' a red circle ' }] }), [{ b64: 'AAAA', revisedPrompt: 'a red circle' }]);
  assert.deepEqual(parseReply({ data: [{ url: 'https://x/y.png' }] }), [{ url: 'https://x/y.png' }]);
  assert.throws(() => parseReply({ data: [] }), /no image/);
  assert.throws(() => parseReply({ error: { message: 'No available channels for Model x' } }), /No available channels/);
  assert.equal(errorMessage({ error: 'quota' }), 'quota');
  assert.equal(errorMessage({ message: 'nope' }), 'nope');
  assert.equal(errorMessage(null), 'request failed');
});

test('bytes are sniffed and measured', () => {
  assert.equal(sniffMediaType(PNG_2x3), 'image/png');
  assert.deepEqual(dimensionsOf(PNG_2x3), { width: 2, height: 3 });
  assert.equal(extensionOf('image/png'), 'png');
  assert.equal(extensionOf('image/jpeg'), 'jpg');
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0000b080010002003012200ffd9', 'hex');
  assert.equal(sniffMediaType(jpeg), 'image/jpeg');
  assert.deepEqual(dimensionsOf(jpeg), { width: 32, height: 16 });
  assert.equal(sniffMediaType(Buffer.from('hello world!')), undefined);
  assert.deepEqual(dimensionsOf(Buffer.alloc(4)), { width: 0, height: 0 });
});

test('a picture is priced from token usage, the built-in list, or a typed price, in that order', () => {
  assert.equal(familyOf('sub2api/gpt-image-1.5'), 'gpt-image-1.5');
  assert.equal(familyOf('gpt-image-10'), '');
  // A bare usage (no breakdown) bills the input as text and the output as image.
  const bare = costFromUsage('gpt-image-1.5', { input_tokens: 85, output_tokens: 515, total_tokens: 600 });
  assert.ok(Math.abs(bare.amount - (85 * 5 + 515 * 32) / 1e6) < 1e-12);
  const detailed = costFromUsage('gpt-image-1.5', { input_tokens: 81, output_tokens: 4360, input_tokens_details: { text_tokens: 81, image_tokens: 0 }, output_tokens_details: { text_tokens: 200, image_tokens: 4160 } });
  assert.ok(Math.abs(detailed.amount - 0.135525) < 1e-9);
  assert.deepEqual(estimateCost({ model: 'gpt-image-1', size: '1024x1024', quality: 'low' }), { amount: 0.011, currency: 'USD', source: 'list', perImage: 0.011, family: 'gpt-image-1' });
  assert.deepEqual(estimateCost({ model: 'dall-e-3', size: '1792x1024', quality: 'hd' }).amount, 0.12);
  assert.equal(estimateCost({ model: 'doubao-seedream-4-0-250828' }).currency, 'CNY');
  assert.deepEqual(estimateCost({ model: 'x', providerRecord: { pricing: { image: '0.04' } }, n: 2 }), { amount: 0.08, currency: 'USD', source: 'provider', perImage: 0.04, family: '' });
  assert.equal(estimateCost({ model: 'x' }), undefined);
  assert.deepEqual(totalsOf([{ cost: { amount: 1, currency: 'USD' } }, { cost: { amount: 2, currency: 'USD' } }, { cost: { amount: 3, currency: 'CNY' } }, {}]), { USD: 3, CNY: 3 });
});
