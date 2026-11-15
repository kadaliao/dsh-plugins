/**
 * Link previews for the bots chat: one URL in, one card description out.
 *
 * - YouTube (watch, youtu.be, shorts, live, embed): the video id plus oEmbed's
 *   title and channel, so the client can show the thumbnail and play inline.
 * - X / Twitter posts: the post through the public fxtwitter API (text,
 *   author, photos, video, counts); profiles the same way.
 * - Anything else: the page's OpenGraph / Twitter-card meta, `<title>` and icon.
 *
 * Arbitrary pages are only fetched from public addresses (no loopback, LAN or
 * link-local targets, re-checked on every redirect), with a size and time cap.
 * Results are cached in memory.
 *
 * @module @kadaliao/dsh-bots/lib/unfurl
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 dsh-bots-preview';
const MAX_HTML = 768 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 8000;
const OK_TTL = 6 * 3600_000;
const FAIL_TTL = 10 * 60_000;
const CACHE_MAX = 500;

const clip = (v, n) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
/** Keep line breaks (post text), only trim and cap. */
const clipText = (v, n) => {
  const s = typeof v === 'string' ? v.replace(/\r/g, '').trim() : '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
/** X serves 48px `_normal` avatars by default; ask for 200px. */
const bigAvatar = (v) => (typeof v === 'string' ? v.replace(/_normal(\.\w+)$/, '_200x200$1') : '');
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : undefined);

// --- URL kinds -----------------------------------------------------------------------

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com']);
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const X_RESERVED = new Set(['home', 'explore', 'search', 'i', 'settings', 'notifications', 'messages', 'compose', 'intent', 'share', 'hashtag', 'login', 'signup', 'tos', 'privacy']);

/** `t=1m30s` / `t=90` / `start=90` → seconds. */
function startSeconds(v) {
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(v);
  if (!m || !m[0]) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** A YouTube video id and start time, or null. */
export function youtubeOf(u) {
  const host = u.hostname.toLowerCase();
  let id = '';
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? '';
  else if (YT_HOSTS.has(host)) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') id = u.searchParams.get('v') ?? '';
    else if (['shorts', 'live', 'embed', 'v'].includes(parts[0])) id = parts[1] ?? '';
  }
  if (!YT_ID.test(id)) return null;
  const start = startSeconds(u.searchParams.get('t') ?? u.searchParams.get('start') ?? '');
  return { id, start, short: u.pathname.startsWith('/shorts/') };
}

/** `{user, id}` for a post, `{user}` for a profile, or null. */
export function xOf(u) {
  if (!X_HOSTS.has(u.hostname.toLowerCase())) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length >= 3 && (parts[1] === 'status' || parts[1] === 'statuses') && /^\d{1,25}$/.test(parts[2])) return { user: parts[0], id: parts[2] };
  if (parts[0] === 'i' && parts[1] === 'web' && parts[2] === 'status' && /^\d{1,25}$/.test(parts[3] ?? '')) return { user: 'i', id: parts[3] };
  if (parts.length === 1 && /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) && !X_RESERVED.has(parts[0].toLowerCase())) return { user: parts[0] };
  return null;
}

// --- public-address guard -----------------------------------------------------------

function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
/**
 * True for loopback, private, link-local, CGNAT, multicast and unspecified addresses.
 * 198.18.0.0/15 stays allowed: fake-IP proxies (Clash, Surge) resolve every public name into it.
 */
export function isPrivateAddress(ip) {
  const v = isIP(ip);
  if (v === 4) return privateV4(ip);
  if (v !== 6) return true;
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return privateV4(mapped[1]);
  return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
}

async function assertPublic(u, lookup) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) links');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new Error('unusual port');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !isIP(host)) throw new Error('not a public host');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('not a public address');
}

// --- HTML meta ------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', copy: '©', reg: '®', trade: '™' };
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      } catch {
        return all;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

/** OpenGraph / Twitter / plain meta of one HTML document, resolved against `base`. */
export function parseMeta(html, base) {
  const head = html.slice(0, MAX_HTML);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  let icon = '';
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const rel = (a.rel ?? '').toLowerCase();
    if (a.href && /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel) && (!icon || rel.includes('apple-touch-icon'))) icon = a.href;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '';
  const abs = (v) => {
    if (!v) return '';
    try {
      const u = new URL(v, base);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
    } catch {
      return '';
    }
  };
  const image = abs(meta['og:image:secure_url'] ?? meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'] ?? meta['twitter:image:src'] ?? meta.image);
  const w = num(meta['og:image:width']);
  const hgt = num(meta['og:image:height']);
  return {
    title: clip(meta['og:title'] ?? meta['twitter:title'] ?? decodeEntities(titleTag), 200),
    description: clip(meta['og:description'] ?? meta['twitter:description'] ?? meta.description, 400),
    site: clip(meta['og:site_name'] ?? meta['application-name'] ?? '', 80),
    image,
    large: Boolean(image) && (meta['twitter:card'] === 'summary_large_image' || (w !== undefined && hgt !== undefined && w >= 400 && w / hgt >= 1.3)),
    icon: abs(icon) || abs('/favicon.ico'),
    video: abs(meta['og:video:secure_url'] ?? meta['og:video:url'] ?? meta['og:video']),
    author: clip(meta.author ?? meta['article:author'] ?? meta['twitter:creator'] ?? '', 80),
    published: clip(meta['article:published_time'] ?? '', 40),
  };
}

function charsetOf(type, bytes) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(type ?? '')?.[1];
  if (fromHeader) return fromHeader;
  const sniff = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1] ?? 'utf-8';
}

async function readCapped(res, cap) {
  if (!res.body?.getReader) return new Uint8Array(await res.arrayBuffer()).subarray(0, cap);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= cap) {
      try {
        await reader.cancel();
      } catch {
        // Already closed.
      }
      break;
    }
  }
  const out = new Uint8Array(Math.min(size, cap));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, out.length - at);
    out.set(part, at);
    at += part.length;
    if (at >= out.length) break;
  }
  return out;
}

// --- providers ------------------------------------------------------------------------

async function getJsonFrom(fetchImpl, url, signal) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'dsh-bots-preview/1.0' }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function youtubeCard(u, yt, fetchImpl, signal) {
  const card = {
    ok: true,
    kind: 'youtube',
    url: u.href,
    videoId: yt.id,
    start: yt.start,
    short: yt.short,
    site: 'YouTube',
    image: `https://i.ytimg.com/vi/${yt.id}/hqdefault.jpg`,
    title: '',
    author: '',
  };
  try {
    const o = await getJsonFrom(fetchImpl, `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt.id}`)}`, signal);
    card.title = clip(o?.title, 200);
    card.author = clip(o?.author_name, 80);
    card.authorUrl = typeof o?.author_url === 'string' ? o.author_url : undefined;
  } catch {
    // The id alone still plays.
  }
  return card;
}

function mediaOf(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, 4)
    .map((m) => {
      if (m?.type === 'photo') return { type: 'photo', url: m.url, width: num(m.width), height: num(m.height) };
      if (m?.type === 'video' || m?.type === 'gif') {
        const mp4 = (Array.isArray(m.variants) ? m.variants : []).filter((v) => v?.content_type === 'video/mp4').sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0));
        const pick = mp4.find((v) => (v.bitrate ?? 0) >= 800_000) ?? mp4[mp4.length - 1];
        return { type: m.type, url: pick?.url ?? m.url, thumb: m.thumbnail_url, width: num(m.width), height: num(m.height), duration: num(m.duration) };
      }
      return null;
    })
    .filter((m) => m && typeof m.url === 'string');
}

function postOf(t) {
  return {
    text: clipText(t?.text, 1200),
    author: { name: clip(t?.author?.name, 80), handle: clip(t?.author?.screen_name, 40), avatar: bigAvatar(t?.author?.avatar_url), verified: Boolean(t?.author?.verification?.verified) },
    createdAt: num(t?.created_timestamp) ? num(t.created_timestamp) * 1000 : undefined,
    media: mediaOf(t?.media?.all ?? [...(t?.media?.photos ?? []), ...(t?.media?.videos ?? [])]),
  };
}

async function xCard(u, x, fetchImpl, signal) {
  if (x.id) {
    const d = await getJsonFrom(fetchImpl, `https://api.fxtwitter.com/${encodeURIComponent(x.user)}/status/${x.id}`, signal);
    const t = d?.tweet;
    if (!t) throw new Error(d?.message || 'post not found');
    const post = postOf(t);
    return {
      ok: true,
      kind: 'x',
      url: typeof t.url === 'string' ? t.url : u.href,
      site: 'X',
      ...post,
      likes: num(t.likes),
      retweets: num(t.retweets),
      replies: num(t.replies),
      views: num(t.views),
      quote: t.quote ? { url: t.quote.url, ...postOf(t.quote) } : undefined,
    };
  }
  const d = await getJsonFrom(fetchImpl, `https://api.fxtwitter.com/${encodeURIComponent(x.user)}`, signal);
  const p = d?.user;
  if (!p) throw new Error(d?.message || 'profile not found');
  return {
    ok: true,
    kind: 'x-profile',
    url: typeof p.url === 'string' ? p.url : u.href,
    site: 'X',
    author: { name: clip(p.name, 80), handle: clip(p.screen_name, 40), avatar: bigAvatar(p.avatar_url), verified: Boolean(p.verification?.verified) },
    text: clipText(p.description, 400),
    banner: typeof p.banner_url === 'string' ? p.banner_url : '',
    followers: num(p.followers),
    following: num(p.following),
  };
}

async function pageCard(u, fetchImpl, lookup, signal) {
  let url = u;
  let res;
  for (let hop = 0; ; hop += 1) {
    await assertPublic(url, lookup);
    res = await fetchImpl(url.href, { redirect: 'manual', signal, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5', 'accept-language': 'en,zh;q=0.8' } });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) break;
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
    try {
      await res.body?.cancel?.();
    } catch {
      // Nothing to drain.
    }
    url = new URL(loc, url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (/^image\//i.test(type)) {
    try {
      await res.body?.cancel?.();
    } catch {
      // Nothing to drain.
    }
    return { ok: true, kind: 'image', url: u.href, image: url.href, site: url.hostname.replace(/^www\./, ''), title: decodeURIComponent(url.pathname.split('/').pop() || url.hostname) };
  }
  if (type && !/html|xml/i.test(type)) throw new Error(`not a page (${type.split(';')[0]})`);
  const bytes = await readCapped(res, MAX_HTML);
  let html;
  try {
    html = new TextDecoder(charsetOf(type, bytes)).decode(bytes);
  } catch {
    html = new TextDecoder('utf-8').decode(bytes);
  }
  const m = parseMeta(html, url.href);
  if (!m.title && !m.description && !m.image) throw new Error('no preview data');
  return { ok: true, kind: 'page', url: u.href, finalUrl: url.href !== u.href ? url.href : undefined, site: m.site || url.hostname.replace(/^www\./, ''), host: url.hostname.replace(/^www\./, ''), ...m };
}

// --- entry ------------------------------------------------------------------------------

/**
 * Describe one link for a preview card.
 * @param {string} raw
 * @param {{fetchImpl?: typeof fetch, lookup?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<object>} `{ok: true, kind, url, ...}` or `{ok: false, url, reason}`.
 */
export async function unfurl(raw, { fetchImpl = fetch, lookup = dnsLookup, timeoutMs = TIMEOUT_MS } = {}) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return { ok: false, url: String(raw ?? ''), reason: 'not a URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, url: u.href, reason: 'only http(s) links' };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const yt = youtubeOf(u);
    if (yt) return await youtubeCard(u, yt, fetchImpl, signal);
    const x = xOf(u);
    if (x) {
      try {
        return await xCard(u, x, fetchImpl, signal);
      } catch (error) {
        return { ok: false, kind: 'x', url: u.href, reason: error?.message ?? String(error) };
      }
    }
    return await pageCard(u, fetchImpl, lookup, signal);
  } catch (error) {
    return { ok: false, url: u.href, reason: error?.name === 'TimeoutError' ? 'timed out' : error?.message ?? String(error) };
  }
}

/** `unfurl` behind an in-memory cache that also merges concurrent requests for one URL. */
export function createUnfurler(opts = {}) {
  const cache = new Map();
  const now = opts.now ?? Date.now;
  return (raw) => {
    const key = String(raw ?? '').trim();
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value;
    const value = unfurl(key, opts).then((card) => {
      cache.set(key, { value: Promise.resolve(card), until: now() + (card.ok ? OK_TTL : FAIL_TTL) });
      return card;
    });
    cache.delete(key);
    cache.set(key, { value, until: now() + TIMEOUT_MS * 2 });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  };
}
