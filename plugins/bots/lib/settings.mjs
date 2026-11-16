/**
 * Team-wide settings of the bots plugin, kept in `settings.json` beside the
 * roster: when a bot starts a new topic by itself, how memory is written and
 * consolidated, and the prices the usage view counts with.
 *
 * @module @kadaliao/dsh-bots/lib/settings
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = Object.freeze({
  topics: Object.freeze({
    /** A conversation quiet for this many hours starts a new topic before its next task; 0 = never. */
    idleHours: 6,
    /** A conversation whose prompt reached this many thousand tokens starts a new topic; 0 = never. */
    maxContextK: 128,
  }),
  memory: Object.freeze({
    /** Summarize every finished task into the bot's memory. */
    auto: true,
    /** The model memory work runs on; null = each bot's own model. */
    model: null,
    /** Consolidate memories once a day ("dreaming"). */
    dream: true,
    /** Local time of the daily consolidation, HH:MM. */
    dreamTime: '03:00',
  }),
  /** Prices per million tokens by model id (lowercase): {input, output, cacheRead?, cacheWrite?, currency}. */
  prices: Object.freeze({}),
  /** Keep a ChatGPT login borrowed from the Codex CLI in sync with ~/.codex/auth.json. */
  codex: Object.freeze({ sync: false, route: false }),
});

const num = (v, d, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const clock = (v, d) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : d;
};

/** One price row, or null when it names no usable price. */
export function normalizePrice(p) {
  if (!p || typeof p !== 'object') return null;
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? Number(x.toPrecision(10)) : undefined;
  };
  const input = n(p.input);
  const output = n(p.output);
  if (input === undefined || output === undefined) return null;
  const cacheRead = n(p.cacheRead);
  const cacheWrite = n(p.cacheWrite);
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    currency: p.currency === 'CNY' ? 'CNY' : 'USD',
  };
}

/** Every field present, values clamped. */
export function normalizeSettings(input) {
  const s = input && typeof input === 'object' ? input : {};
  const t = s.topics ?? {};
  const m = s.memory ?? {};
  const prices = {};
  if (s.prices && typeof s.prices === 'object') {
    for (const [k, v] of Object.entries(s.prices).slice(0, 300)) {
      const key = String(k).trim().toLowerCase().slice(0, 200);
      const p = normalizePrice(v);
      if (key && p) prices[key] = p;
    }
  }
  const model = m.model && typeof m.model === 'object' && typeof m.model.provider === 'string' && m.model.provider && typeof m.model.model === 'string' && m.model.model ? { provider: m.model.provider.slice(0, 200), model: m.model.model.slice(0, 200) } : null;
  return {
    topics: {
      idleHours: num(t.idleHours, DEFAULTS.topics.idleHours, 0, 24 * 30),
      maxContextK: Math.round(num(t.maxContextK, DEFAULTS.topics.maxContextK, 0, 4096)),
    },
    memory: {
      auto: typeof m.auto === 'boolean' ? m.auto : DEFAULTS.memory.auto,
      model,
      dream: typeof m.dream === 'boolean' ? m.dream : DEFAULTS.memory.dream,
      dreamTime: clock(m.dreamTime, DEFAULTS.memory.dreamTime),
    },
    prices,
    codex: { sync: s.codex?.sync === true, route: s.codex?.route === true },
  };
}

/** Deep-merge a patch into settings (objects merge, everything else replaces). */
function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = { ...(base && typeof base === 'object' ? base : {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = k === 'prices' ? v : merge(out[k], v);
  return out;
}

/** The settings file under `dir`, re-read when another process changed it. */
export function createSettings(dir) {
  const file = join(dir, 'settings.json');
  let seen = -2;
  let value = normalizeSettings({});
  const mtime = () => {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return -1;
    }
  };
  const reload = () => {
    const now = mtime();
    if (now === seen) return;
    seen = now;
    try {
      value = normalizeSettings(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      value = normalizeSettings({});
    }
  };
  return {
    get() {
      reload();
      return value;
    },
    /** Merge `patch` (prices replace as a whole) and save; returns the new settings. */
    save(patch) {
      reload();
      value = normalizeSettings(merge(value, patch));
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
      renameSync(tmp, file);
      seen = mtime();
      return value;
    },
  };
}
