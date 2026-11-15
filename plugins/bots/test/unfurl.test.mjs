import assert from 'node:assert/strict';
import test from 'node:test';
import { unfurl, youtubeOf, xOf, isPrivateAddress, parseMeta, createUnfurler } from '../lib/unfurl.mjs';

const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body });
const html = (body, headers = {}) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html; charset=utf-8', ...headers }), arrayBuffer: async () => new TextEncoder().encode(body).buffer });
const publicDns = async () => [{ address: '93.184.216.34' }];

test('YouTube and X URLs are recognised', () => {
  assert.deepEqual(youtubeOf(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s')), { id: 'dQw4w9WgXcQ', start: 65, short: false });
  assert.equal(youtubeOf(new URL('https://youtu.be/dQw4w9WgXcQ')).id, 'dQw4w9WgXcQ');
  assert.equal(youtubeOf(new URL('https://youtube.com/shorts/aqz-KE-bpKQ')).short, true);
  assert.equal(youtubeOf(new URL('https://www.youtube.com/@channel')), null);
  assert.deepEqual(xOf(new URL('https://x.com/jack/status/20?s=20')), { user: 'jack', id: '20' });
  assert.deepEqual(xOf(new URL('https://twitter.com/jack')), { user: 'jack' });
  assert.equal(xOf(new URL('https://x.com/home')), null);
  assert.equal(xOf(new URL('https://example.com/jack/status/20')), null);
});

test('private addresses are refused; fake-IP proxy space is not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '198.18.0.4', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('a page card comes from OpenGraph meta, resolved against the page', async () => {
  const page = `<html><head><title>Fallback &amp; title</title>
    <meta property="og:title" content="Hello &quot;world&quot;"><meta name="description" content="A page.">
    <meta property="og:image" content="/img/card.png"><meta name="twitter:card" content="summary_large_image">
    <link rel="icon" href="/fav.svg"></head><body></body></html>`;
  const card = await unfurl('https://example.com/post', { fetchImpl: async () => html(page), lookup: publicDns });
  assert.equal(card.ok, true);
  assert.equal(card.kind, 'page');
  assert.equal(card.title, 'Hello "world"');
  assert.equal(card.description, 'A page.');
  assert.equal(card.image, 'https://example.com/img/card.png');
  assert.equal(card.large, true);
  assert.equal(card.icon, 'https://example.com/fav.svg');
  assert.equal(parseMeta('<title>Only &#x4e2d;</title>', 'https://a.b/').title, 'Only 中');
});

test('pages on private hosts are never fetched, redirects included', async () => {
  let calls = 0;
  const fetchImpl = async () => (calls++, html('<title>x</title>'));
  assert.equal((await unfurl('http://localhost/', { fetchImpl, lookup: publicDns })).ok, false);
  assert.equal((await unfurl('https://intranet.example/', { fetchImpl, lookup: async () => [{ address: '10.0.0.5' }] })).ok, false);
  assert.equal(calls, 0);
  const redirect = async () => ({ ok: false, status: 302, headers: new Headers({ location: 'http://169.254.169.254/latest' }), body: null });
  const r = await unfurl('https://example.com/go', { fetchImpl: redirect, lookup: async (host) => [{ address: host === '169.254.169.254' ? host : '93.184.216.34' }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /public/);
});

test('YouTube cards carry the id and oEmbed title; X posts carry text, author and media', async () => {
  const yt = await unfurl('https://youtu.be/dQw4w9WgXcQ', { fetchImpl: async (u) => (assert.match(u, /youtube\.com\/oembed/), json({ title: 'Never Gonna', author_name: 'Rick' })) });
  assert.deepEqual([yt.kind, yt.videoId, yt.title, yt.author], ['youtube', 'dQw4w9WgXcQ', 'Never Gonna', 'Rick']);
  assert.match(yt.image, /i\.ytimg\.com\/vi\/dQw4w9WgXcQ/);
  const tweet = {
    url: 'https://x.com/jack/status/20', text: 'just setting up my twttr', likes: 5, retweets: 2, replies: 1, created_timestamp: 1142974214,
    author: { name: 'jack', screen_name: 'jack', avatar_url: 'https://pbs.twimg.com/a_normal.jpg', verification: { verified: true } },
    media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/p.jpg', width: 10, height: 10 }, { type: 'video', thumbnail_url: 'https://t.jpg', variants: [{ content_type: 'video/mp4', bitrate: 256000, url: 'lo.mp4' }, { content_type: 'video/mp4', bitrate: 832000, url: 'mid.mp4' }] }] },
  };
  const x = await unfurl('https://twitter.com/jack/status/20', { fetchImpl: async (u) => (assert.match(u, /api\.fxtwitter\.com\/jack\/status\/20/), json({ tweet })) });
  assert.equal(x.kind, 'x');
  assert.equal(x.text, 'just setting up my twttr');
  assert.equal(x.author.avatar, 'https://pbs.twimg.com/a_200x200.jpg');
  assert.deepEqual(x.media.map((m) => [m.type, m.url]), [['photo', 'https://pbs.twimg.com/p.jpg'], ['video', 'mid.mp4']]);
  const gone = await unfurl('https://x.com/a/status/1', { fetchImpl: async () => json({ code: 404 }, 404) });
  assert.deepEqual([gone.ok, gone.kind], [false, 'x']);
});

test('the unfurler caches and merges requests', async () => {
  let calls = 0;
  const get = createUnfurler({ fetchImpl: async () => (calls++, json({ title: 'T' })) });
  const [a, b] = await Promise.all([get('https://youtu.be/dQw4w9WgXcQ'), get('https://youtu.be/dQw4w9WgXcQ')]);
  await get('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(calls, 1);
  assert.equal(a, b);
});
