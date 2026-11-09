/**
 * What one image costs: from the provider's token usage when it reports one,
 * else from a built-in price list of the common image models, else from a price
 * the person typed in. Every estimate says where it came from.
 *
 * @module @kadaliao/dsh-images/lib/pricing
 */

/** When the built-in list was last checked against the vendors' pages. */
export const PRICE_LIST_DATE = '2026-11-09';

/** USD per million tokens, by model family; text and image tokens are priced apart. */
const TOKEN_PRICES = {
  'gpt-image-1.5': { textIn: 5, textCached: 1.25, textOut: 10, imageIn: 8, imageCached: 2, imageOut: 32 },
  'gpt-image-1-mini': { textIn: 2, textCached: 0.2, textOut: 0, imageIn: 2.5, imageCached: 0.25, imageOut: 8 },
  'gpt-image-1': { textIn: 5, textCached: 1.25, textOut: 0, imageIn: 10, imageCached: 2.5, imageOut: 40 },
};

/**
 * Flat per-image prices, by family → quality → shape (`square` or `rect`, the
 * latter for 1536×1024 / 1024×1536 and other non-square sizes).
 */
const PER_IMAGE = {
  'gpt-image-1.5': { currency: 'USD', low: { square: 0.009, rect: 0.013 }, medium: { square: 0.034, rect: 0.05 }, high: { square: 0.133, rect: 0.2 } },
  'gpt-image-1-mini': { currency: 'USD', low: { square: 0.005, rect: 0.006 }, medium: { square: 0.011, rect: 0.015 }, high: { square: 0.036, rect: 0.052 } },
  'gpt-image-1': { currency: 'USD', low: { square: 0.011, rect: 0.016 }, medium: { square: 0.042, rect: 0.063 }, high: { square: 0.167, rect: 0.25 } },
  'dall-e-3': { currency: 'USD', standard: { square: 0.04, rect: 0.08 }, hd: { square: 0.08, rect: 0.12 } },
  'dall-e-2': { currency: 'USD', standard: { square: 0.02, rect: 0.02 } },
  'doubao-seedream': { currency: 'CNY', standard: { square: 0.2, rect: 0.2 } },
};

/** The quality a family bills when the call named none. */
const DEFAULT_QUALITY = { 'gpt-image-1.5': 'high', 'gpt-image-1-mini': 'high', 'gpt-image-1': 'high', 'dall-e-3': 'standard', 'dall-e-2': 'standard', 'doubao-seedream': 'standard' };

/**
 * The price-list family of a model id (`sub2api/gpt-image-1.5` → `gpt-image-1.5`),
 * or '' when the list does not know it.
 * @param {string} model
 */
export function familyOf(model) {
  const bare = String(model ?? '').toLowerCase().split('/').pop() ?? '';
  // Longest match first, so `gpt-image-1.5` is not taken for `gpt-image-1`.
  const families = Object.keys(PER_IMAGE).sort((a, b) => b.length - a.length);
  // `gpt-image-1-2025` and `gpt-image-1.5-preview` belong to their family; `gpt-image-10` would not.
  return families.find((f) => bare === f || (bare.startsWith(f) && !/^[\d.]/.test(bare.charAt(f.length)))) ?? '';
}

/** Whether a model id reads as an image model, for sorting a provider's list. */
export function looksLikeImageModel(id) {
  return /image|dall|flux|seedream|imagen|banana|stable-diffusion|\bsd[x0-9-]|kolors|wanx|cogview|hunyuan-image|midjourney|ideogram|recraft|playground|kandinsky|janus-pro/i.test(String(id ?? ''));
}

const num = (v) => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * The per-image price a provider's model record carries, if any (OpenRouter and
 * some gateways put it under `pricing.image` or similar), as `{amount, currency}`.
 * @param {unknown} record - the `/models` entry.
 */
export function providerPerImage(record) {
  const pricing = record && typeof record === 'object' ? record.pricing : undefined;
  if (!pricing || typeof pricing !== 'object') return undefined;
  const amount = num(pricing.per_image ?? pricing.output_image ?? pricing.image_output ?? pricing.image);
  if (amount === undefined || amount === 0) return undefined;
  const currency = typeof pricing.currency === 'string' && pricing.currency !== '' ? pricing.currency.toUpperCase() : 'USD';
  return { amount, currency };
}

/**
 * Cost from the provider's token usage, for a family with token prices.
 * @param {string} family
 * @param {unknown} usage - the reply's `usage` object.
 * @returns {{amount: number, currency: 'USD', tokens: object}|undefined}
 */
export function costFromUsage(family, usage) {
  const prices = TOKEN_PRICES[family];
  if (!prices || !usage || typeof usage !== 'object') return undefined;
  const inDetails = usage.input_tokens_details ?? {};
  const outDetails = usage.output_tokens_details ?? {};
  // Without a breakdown, the input is the prompt: text.
  const textIn = num(inDetails.text_tokens) ?? num(usage.input_tokens) ?? 0;
  const cachedIn = num(inDetails.cached_tokens) ?? 0;
  const imageIn = num(inDetails.image_tokens) ?? 0;
  const outputTokens = num(usage.output_tokens) ?? 0;
  const textOut = num(outDetails.text_tokens) ?? 0;
  const imageOut = num(outDetails.image_tokens) ?? Math.max(0, outputTokens - textOut);
  if (textIn + imageIn + imageOut + textOut === 0) return undefined;
  const amount =
    (Math.max(0, textIn - cachedIn) * prices.textIn + cachedIn * prices.textCached + imageIn * prices.imageIn + imageOut * prices.imageOut + textOut * prices.textOut) / 1e6;
  return { amount, currency: 'USD', tokens: { textIn, imageIn, imageOut, textOut } };
}

/**
 * Flat price for one image from the built-in list.
 * @param {string} family
 * @param {string} size - `WIDTHxHEIGHT` or 'auto'.
 * @param {string} quality - '' for the family's default.
 */
export function costFromList(family, size, quality) {
  const table = PER_IMAGE[family];
  if (!table) return undefined;
  const tier = table[String(quality ?? '').toLowerCase()] ?? table[DEFAULT_QUALITY[family]] ?? Object.values(table).find((v) => typeof v === 'object');
  if (!tier || typeof tier !== 'object') return undefined;
  const m = /^(\d+)x(\d+)$/i.exec(String(size ?? ''));
  const shape = m && m[1] !== m[2] ? 'rect' : 'square';
  const amount = tier[shape] ?? tier.square;
  return amount === undefined ? undefined : { amount, currency: table.currency };
}

/**
 * The cost of one call's images, with its source.
 * @param {{model: string, size?: string, quality?: string, n?: number, usage?: unknown, providerRecord?: unknown, manual?: {amount: number, currency: string}}} input
 * @returns {{amount: number, currency: string, source: 'usage'|'provider'|'list'|'manual', perImage: number, family: string, tokens?: object}|undefined}
 */
export function estimateCost(input) {
  const family = familyOf(input.model);
  const n = Math.max(1, Number(input.n) || 1);
  const fromUsage = costFromUsage(family, input.usage);
  if (fromUsage) return { ...fromUsage, source: 'usage', perImage: fromUsage.amount / n, family };
  const fromProvider = providerPerImage(input.providerRecord);
  if (fromProvider) return { amount: fromProvider.amount * n, currency: fromProvider.currency, source: 'provider', perImage: fromProvider.amount, family };
  const fromList = costFromList(family, input.size, input.quality);
  if (fromList) return { amount: fromList.amount * n, currency: fromList.currency, source: 'list', perImage: fromList.amount, family };
  const manual = input.manual;
  if (manual && Number.isFinite(manual.amount) && manual.amount > 0) {
    return { amount: manual.amount * n, currency: manual.currency || 'USD', source: 'manual', perImage: manual.amount, family };
  }
  return undefined;
}

/** Totals by currency over gallery items that carry a cost. */
export function totalsOf(items) {
  const out = {};
  for (const it of items) {
    const c = it?.cost;
    if (!c || !Number.isFinite(c.amount)) continue;
    out[c.currency] = (out[c.currency] ?? 0) + c.amount;
  }
  return out;
}
