/**
 * What a model call cost: tokens × a price per million tokens. Prices come from
 * the user's own table first (settings `prices`), then LiteLLM's public
 * `model_prices_and_context_window.json` (chat rows only, compacted and cached
 * under the bots cache). Costs are worked out when a report is read, never
 * stored, so a corrected price applies to past usage too.
 *
 * @module @kadaliao/dsh-bots/lib/prices
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRICE_SOURCES = [
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
];
const MAX_AGE_MS = 7 * 24 * 3600_000;
const RETRY_MS = 10 * 60_000;
const TEXT_MODES = new Set(['chat', 'completion', 'responses']);
/** A model sold by several resellers: its own vendor's row wins. */
const VENDORS = ['openai', 'anthropic', 'deepseek', 'gemini', 'xai', 'mistral', 'moonshot', 'dashscope', 'zai', 'minimax', 'vertex_ai-language-models'];

const perMillion = (v) => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) && n >= 0 ? Number((n * 1e6).toPrecision(10)) : undefined;
};

/**
 * The text-model rows of a LiteLLM price file: `{prices: {name: price}}`, where
 * name is the row key lowercased, plus each row's bare model name (after the
 * last `/`) when no vendor row claims it first.
 */
export function compactPrices(raw) {
  const prices = {};
  const bare = {};
  if (!raw || typeof raw !== 'object') return { prices };
  for (const [key, row] of Object.entries(raw)) {
    if (!row || typeof row !== 'object' || key === 'sample_spec') continue;
    if (row.mode && !TEXT_MODES.has(row.mode)) continue;
    const input = perMillion(row.input_cost_per_token);
    const output = perMillion(row.output_cost_per_token);
    if (input === undefined || output === undefined || input + output === 0) continue;
    const cacheRead = perMillion(row.cache_read_input_token_cost);
    const cacheWrite = perMillion(row.cache_creation_input_token_cost);
    const price = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}), currency: 'USD' };
    const name = key.toLowerCase();
    prices[name] = price;
    const short = name.split('/').pop();
    if (short !== name) {
      const rank = VENDORS.indexOf(String(row.litellm_provider ?? ''));
      const prev = bare[short];
      if (!prev || (rank !== -1 && (prev.rank === -1 || rank < prev.rank))) bare[short] = { rank, price };
    }
  }
  for (const [short, { price }] of Object.entries(bare)) if (!prices[short]) prices[short] = price;
  return { prices };
}

/**
 * The price of `model`: the user's table, then the catalog, by the full id,
 * every `/`-suffix of it, and finally the longest catalog name the bare id
 * starts with (`deepseek-chat-0324` → `deepseek-chat`, marked approximate).
 * @returns {{input, output, cacheRead?, cacheWrite?, currency, source: 'user'|'catalog', approximate?: true}|null}
 */
export function priceOf(model, overrides = {}, catalog = null) {
  const id = String(model ?? '').trim().toLowerCase();
  if (!id) return null;
  const segs = id.split('/');
  const candidates = segs.map((_, i) => segs.slice(i).join('/'));
  for (const c of candidates) if (overrides[c]) return { ...overrides[c], source: 'user' };
  const table = catalog?.prices;
  if (!table) return null;
  for (const c of candidates) if (table[c]) return { ...table[c], source: 'catalog' };
  const last = segs[segs.length - 1];
  const hit = Object.keys(table)
    .filter((n) => !n.includes('/') && last.startsWith(`${n}-`))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? { ...table[hit], source: 'catalog', approximate: true } : null;
}

/** Cost of one usage row under `price`: {amount, currency} or null. */
export function costOf(price, u) {
  if (!price) return null;
  const amount = ((u.i ?? 0) * price.input + (u.cr ?? 0) * (price.cacheRead ?? price.input) + (u.cw ?? 0) * (price.cacheWrite ?? price.input) + (u.o ?? 0) * price.output) / 1e6;
  return { amount, currency: price.currency ?? 'USD' };
}

/** The LiteLLM price list as kept under `dir`: cached, refreshed weekly in the background. */
export function createPriceCatalog(dir, options = {}) {
  const file = join(dir, 'price-catalog.json');
  const sources = options.sources?.length ? options.sources : PRICE_SOURCES;
  const now = options.now ?? Date.now;
  let data = null;
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (cached && cached.prices) data = cached;
  } catch {
    data = null;
  }
  let pending = null;
  let lastFailure = 0;
  let lastError = '';
  async function download() {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    let reason = 'no source';
    for (const url of sources) {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const compact = compactPrices(JSON.parse(await res.text()));
        if (Object.keys(compact.prices).length === 0) throw new Error('no text models in it');
        data = { source: url, fetchedAt: now(), ...compact };
        lastError = '';
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, JSON.stringify(data), 'utf8');
        } catch {
          // Kept in memory.
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
  function refresh(force = false) {
    if (options.enabled === false) return Promise.resolve(data);
    if (pending) return pending;
    if (!force && lastFailure && now() - lastFailure < RETRY_MS) return Promise.resolve(data);
    pending = download().finally(() => {
      pending = null;
    });
    return pending;
  }
  return {
    current: () => data,
    refresh,
    /** The list now; a missing or stale one starts a download in the background. */
    peek() {
      if (!data || now() - data.fetchedAt > MAX_AGE_MS) void refresh();
      return data;
    },
    status: () => ({ name: 'LiteLLM', count: data ? Object.keys(data.prices).length : 0, fetchedAt: data?.fetchedAt ?? 0, loading: pending !== null, error: lastError }),
  };
}
