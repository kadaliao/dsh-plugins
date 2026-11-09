/**
 * A fallback price list for image models that neither the provider nor the
 * built-in list can price. The data comes from LiteLLM's public
 * `model_prices_and_context_window.json`, which many gateways also bill by.
 * Only its image-generation rows are kept, compacted to one record per model,
 * and cached under the DSH home.
 *
 * @module @kadaliao/dsh-images/lib/catalog
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the catalog is fetched from, in order; the second is a CDN mirror of the first. */
export const CATALOG_SOURCES = [
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
];
export const CATALOG_NAME = 'LiteLLM';

/** A cached catalog older than this is refreshed in the background. */
const MAX_AGE_MS = 7 * 24 * 3600_000;
/** After a failed download, wait this long before trying again. */
const RETRY_MS = 10 * 60_000;

const QUALITY_SEGMENTS = new Set(['low', 'medium', 'high', 'standard', 'hd', 'auto']);
/** When a model is listed under several providers, the vendor's own price wins over a reseller's. */
const VENDOR_ORDER = ['openai', 'gemini', 'vertex_ai-language-models', 'vertex_ai', 'xai', 'black_forest_labs', 'dashscope', 'stability', 'recraft', 'bedrock', 'tencent', 'runwayml', 'meta'];
/** A dated snapshot (`-2026-04-21`, `-20260403`) of a model the list also has undated. */
const DATED = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

const positive = (v) => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
/** Round away float noise (`2.999997e-5` stays, `3.0000000000000004` does not). */
const tidy = (n) => (n === undefined ? undefined : Number(n.toPrecision(10)));
/** USD per token → USD per million tokens. */
const perMillion = (v) => tidy(positive(v) === undefined ? undefined : positive(v) * 1e6);

/** The prices one catalog row carries, in the shape the pricing module reads. */
function pricesOf(row) {
  const imageOut = perMillion(row.output_cost_per_image_token);
  const textIn = perMillion(row.input_cost_per_token);
  const imageIn = perMillion(row.input_cost_per_image_token) ?? textIn;
  const tokens =
    imageOut === undefined
      ? undefined
      : {
          textIn: textIn ?? 0,
          textCached: perMillion(row.cache_read_input_token_cost) ?? textIn ?? 0,
          imageIn: imageIn ?? 0,
          imageCached: perMillion(row.cache_read_input_image_token_cost) ?? imageIn ?? 0,
          imageOut,
          textOut: perMillion(row.output_cost_per_token) ?? 0,
        };
  // LiteLLM files some flat per-image prices under `input_cost_per_image`; on a
  // row priced by tokens that field is the price of an input image instead.
  const perImage = positive(row.output_cost_per_image) ?? (tokens ? undefined : positive(row.input_cost_per_image));
  const perPixel = positive(row.output_cost_per_pixel) ?? positive(row.input_cost_per_pixel);
  return { tokens, perImage, perPixel };
}

/**
 * Keep the image-generation rows of a LiteLLM price file, grouped by model and
 * provider, with an index from every name a model may be asked by.
 * @param {unknown} raw - the parsed JSON file.
 * @returns {{groups: object[], index: Record<string, number>}}
 */
export function compactCatalog(raw) {
  const groups = [];
  const byKey = new Map();
  if (!raw || typeof raw !== 'object') return { groups, index: {} };
  for (const [key, row] of Object.entries(raw)) {
    if (!row || typeof row !== 'object' || row.mode !== 'image_generation') continue;
    const provider = String(row.litellm_provider ?? '').toLowerCase();
    const segs = key.toLowerCase().split('/').filter(Boolean);
    if (segs.length === 0 || segs[segs.length - 1] === 'edit') continue;
    // `[provider/][quality/][W-x-H/]model`
    const sizeAt = segs.findIndex((s) => /^\d+-x-\d+$/.test(s));
    let name;
    let size = '';
    let quality = '';
    let prefix = '';
    if (sizeAt >= 0) {
      size = segs[sizeAt].replace('-x-', 'x');
      const hasQuality = sizeAt > 0 && QUALITY_SEGMENTS.has(segs[sizeAt - 1]);
      quality = hasQuality ? segs[sizeAt - 1] : '';
      prefix = segs.slice(0, sizeAt - (hasQuality ? 1 : 0)).join('/');
      name = segs.slice(sizeAt + 1).join('/');
    } else {
      const prefixed = segs.length > 1 && provider !== '' && provider.startsWith(segs[0]);
      prefix = prefixed ? segs[0] : '';
      name = (prefixed ? segs.slice(1) : segs).join('/');
    }
    if (!name) continue;
    const groupKey = `${provider}\n${name}`;
    let group = byKey.get(groupKey);
    if (!group) {
      group = { name, provider, canonical: prefix === '' };
      byKey.set(groupKey, group);
      groups.push(group);
    }
    if (prefix === '') group.canonical = true;
    const { tokens, perImage, perPixel } = pricesOf(row);
    if (size !== '') {
      const [w, h] = size.split('x').map(Number);
      const amount = perImage ?? (perPixel ? tidy(perPixel * w * h) : undefined);
      if (amount !== undefined) ((group.sized ??= {})[quality] ??= {})[size] = amount;
    } else {
      if (tokens) group.tokens = tokens;
      if (perImage !== undefined) group.perImage = perImage;
      if (perPixel !== undefined) group.perPixel = perPixel;
    }
  }
  const priced = groups.filter((g) => g.tokens || g.perImage !== undefined || g.perPixel !== undefined || g.sized);
  const rank = (g) => {
    const at = VENDOR_ORDER.indexOf(g.provider);
    return (at < 0 ? VENDOR_ORDER.length : at) * 2 + (g.canonical ? 0 : 1);
  };
  priced.sort((a, b) => rank(a) - rank(b) || a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  // Every name a model answers to; the best-ranked group claims a name first.
  const index = {};
  priced.forEach((g, i) => {
    const parts = g.name.split('/');
    const last = parts[parts.length - 1];
    const names = [g.name, `${g.provider}/${last}`];
    // `openai/gpt-image-2` is also `gpt-image-2`; `flux/dev` is not `dev`, nor `flux-pro/v1.1` `v1.1`.
    if (parts.length === 2 && /^[a-z][a-z0-9.]*-[a-z0-9]/.test(last) && !/^v\d/.test(last)) names.push(last);
    for (const n of names) if (!(n in index)) index[n] = i;
    delete g.canonical;
  });
  return { groups: priced, index };
}

/**
 * The catalog's record for a model id, or undefined. Tries the id as given, then
 * without its routing prefixes (`sub2api/gpt-image-2.6-sunburst` →
 * `gpt-image-2.6-sunburst`), then a listed model the id extends with a tag or
 * date (`gpt-image-2-2026-12-01` → `gpt-image-2`), which is marked `approximate`.
 * @param {{groups: object[], index: Record<string, number>}|undefined} catalog
 * @param {string} model
 */
export function lookupCatalog(catalog, model) {
  if (!catalog?.index || !Array.isArray(catalog.groups)) return undefined;
  const id = String(model ?? '').trim().toLowerCase();
  if (id === '') return undefined;
  const segs = id.split('/');
  for (let i = 0; i < segs.length; i += 1) {
    const at = catalog.index[segs.slice(i).join('/')];
    if (at !== undefined) return { ...catalog.groups[at], approximate: false };
  }
  const bare = segs[segs.length - 1];
  const names = Object.keys(catalog.index)
    .filter((n) => !n.includes('/') && bare.startsWith(`${n}-`))
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return undefined;
  return { ...catalog.groups[catalog.index[names[0]]], approximate: true };
}

/**
 * The flat price of one image from a catalog record, if it has one: the row for
 * this quality and size, else the nearest size, else a per-image or per-pixel price.
 * @param {object} match - `lookupCatalog`'s result.
 * @param {string} size - `WIDTHxHEIGHT` or 'auto'.
 * @param {string} quality
 * @returns {{amount: number, currency: 'USD'}|undefined}
 */
export function catalogPerImage(match, size, quality) {
  if (!match) return undefined;
  const m = /^(\d+)x(\d+)$/i.exec(String(size ?? ''));
  const [w, h] = m ? [Number(m[1]), Number(m[2])] : [1024, 1024];
  if (match.sized) {
    const tiers = Object.keys(match.sized);
    const q = String(quality ?? '').toLowerCase();
    const tier = [q, '', 'standard', 'medium', 'high', ...tiers].find((t) => match.sized[t]);
    const rows = Object.entries(match.sized[tier] ?? {});
    const exact = rows.find(([s]) => s === `${w}x${h}`);
    const shape = (s) => Math.sign(Number(s.split('x')[0]) - Number(s.split('x')[1]));
    const near = rows
      .map(([s, amount]) => ({ s, amount, off: (shape(s) === Math.sign(w - h) ? 0 : 1e12) + Math.abs(s.split('x').reduce((a, b) => a * Number(b), 1) - w * h) }))
      .sort((a, b) => a.off - b.off)[0];
    const amount = exact ? exact[1] : near?.amount;
    if (amount !== undefined) return { amount, currency: 'USD' };
  }
  if (match.perImage !== undefined) return { amount: match.perImage, currency: 'USD' };
  if (match.perPixel !== undefined) return { amount: tidy(match.perPixel * w * h), currency: 'USD' };
  return undefined;
}

/** The catalog's image models by their plain names, for a model picker. */
export function catalogNames(catalog) {
  if (!catalog?.index) return [];
  return Object.keys(catalog.index)
    .filter((n) => !n.includes('/') && !DATED.test(n))
    .sort();
}

/**
 * The catalog as this plugin keeps it: read from `price-catalog.json` under
 * `dir`, downloaded when missing, refreshed in the background once it is a week old.
 * @param {string} dir - the plugin's cache directory.
 * @param {{sources?: string[], enabled?: boolean, fetch?: typeof fetch, now?: () => number}} [options]
 */
export function createCatalog(dir, options = {}) {
  const file = join(dir, 'price-catalog.json');
  const sources = options.sources?.length ? options.sources : CATALOG_SOURCES;
  const enabled = options.enabled !== false;
  const now = options.now ?? Date.now;
  let data = null;
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (cached && Array.isArray(cached.groups) && cached.index) data = cached;
  } catch {
    data = null;
  }
  let pending = null;
  let lastError = '';
  let lastFailure = 0;

  async function download() {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    let reason = 'no source';
    for (const url of sources) {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const compact = compactCatalog(JSON.parse(await res.text()));
        if (compact.groups.length === 0) throw new Error('no image models in it');
        data = { source: url, fetchedAt: now(), ...compact };
        lastError = '';
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, JSON.stringify(data), 'utf8');
        } catch {
          // Kept in memory for this process.
        }
        return data;
      } catch (error) {
        reason = `${url}: ${error?.message ?? error}`;
      }
    }
    lastError = reason;
    lastFailure = now();
    return data;
  }

  /** Start a download unless one is running; `force` ignores the retry pause. */
  function refresh(force = false) {
    if (!enabled) return Promise.resolve(data);
    if (pending) return pending;
    if (!force && lastFailure !== 0 && now() - lastFailure < RETRY_MS) return Promise.resolve(data);
    pending = download().finally(() => {
      pending = null;
    });
    return pending;
  }

  return {
    /** The catalog in hand now, without waiting. */
    current: () => data,
    refresh,
    /**
     * The catalog, downloading it first (up to `waitMs`) when there is none; a
     * stale one is returned at once and refreshed behind.
     */
    async ensure(waitMs = 8000) {
      if (data && now() - data.fetchedAt < MAX_AGE_MS) return data;
      const job = refresh();
      if (data) return data;
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      });
      await Promise.race([job, timeout]);
      clearTimeout(timer);
      return data;
    },
    /** What the settings drawer shows about it. */
    status: () => ({
      name: CATALOG_NAME,
      enabled,
      count: data ? catalogNames(data).length : 0,
      fetchedAt: data?.fetchedAt ?? 0,
      loading: pending !== null,
      error: lastError,
    }),
  };
}
