import assert from 'node:assert/strict';
import test from 'node:test';

import { PNG_2x3 } from './fixtures.mjs';
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
