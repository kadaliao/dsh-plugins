/**
 * The usage ledger: one row per model call a bot made (its conversation turns,
 * the Harness compacting its conversation, and the plugin's own memory work),
 * and one row per finished task. A task is everything a bot does from one
 * request (a message from the user or a chat app, a scheduled run, a DM from
 * another bot) until it is idle again.
 *
 * Files under the bots cache:
 * - `usage.jsonl`: `{t, b, s, k?, r, p, m, i, o, cr, cw}` — time, bot, session,
 *   task, kind ('chat' | 'compaction' | 'memory' | 'dream'), provider, model,
 *   uncached input, output, cache-read and cache-write tokens.
 * - `tasks.jsonl`: `{id, b, s, trigger, via?, from?, sched?, title, start, end, status, topic?}`.
 *
 * Rows older than {@link KEEP_DAYS} are dropped when the file is compacted.
 *
 * @module @kadaliao/dsh-bots/lib/usage
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { costOf } from './prices.mjs';

export const KEEP_DAYS = 400;
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Compact once the file holds this many more rows than the kept window. */
const COMPACT_SLACK = 5000;

const int = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

/** A ledger row from a Harness TokenUsage. */
export function usageRow({ at, botId, sessionId, taskId, kind = 'chat', provider, model, usage }) {
  return {
    t: Number(at) || Date.now(),
    b: botId,
    s: sessionId ?? '',
    ...(taskId ? { k: taskId } : {}),
    r: kind,
    p: String(provider ?? ''),
    m: String(model ?? ''),
    i: int(usage?.inputTokens),
    o: int(usage?.outputTokens),
    cr: int(usage?.cacheReadTokens),
    cw: int(usage?.cacheWriteTokens),
  };
}

/** Prompt size of one call: everything the model read. */
export const promptTokens = (u) => int(u?.inputTokens) + int(u?.cacheReadTokens) + int(u?.cacheWriteTokens);
const rowTokens = (r) => r.i + r.o + r.cr + r.cw;

function readJsonl(file) {
  const out = [];
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn line.
      }
    }
  } catch {
    // No file yet.
  }
  return out;
}

/** One append-only JSONL file with an in-memory copy, re-read when another process wrote it. */
function jsonlFile(file, keep) {
  let rows = null;
  let seen = -1;
  const stamp = () => {
    try {
      const s = statSync(file);
      return s.mtimeMs * 1e6 + s.size;
    } catch {
      return -1;
    }
  };
  return {
    all() {
      const now = stamp();
      if (rows === null || now !== seen) {
        rows = readJsonl(file);
        seen = now;
      }
      return rows;
    },
    append(row) {
      const all = this.all();
      all.push(row);
      try {
        mkdirSync(join(file, '..'), { recursive: true });
        const cutoff = Date.now() - KEEP_DAYS * DAY;
        const old = all.findIndex((r) => (r.t ?? r.end ?? 0) >= cutoff);
        if (old > COMPACT_SLACK || (keep && all.length > keep + COMPACT_SLACK)) {
          rows = all.slice(Math.max(old, keep ? all.length - keep : 0));
          writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        } else appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
        seen = stamp();
      } catch {
        // Usage is a convenience; a write failure loses one row.
      }
    },
  };
}

/** The ledger under `dir`. */
export function createLedger(dir) {
  const calls = jsonlFile(join(dir, 'usage.jsonl'));
  const tasks = jsonlFile(join(dir, 'tasks.jsonl'), 50_000);
  return {
    record(row) {
      calls.append(row);
      return row;
    },
    finishTask(task) {
      tasks.append(task);
      return task;
    },
    calls: () => calls.all(),
    tasks: () => tasks.all(),
  };
}

/** The [from, to) window and bucket of a named range, in the viewer's zone (`tz` = minutes east of UTC). */
export function rangeOf(range, tz = 0, now = Date.now()) {
  const off = tz * 60_000;
  const dayStart = Math.floor((now + off) / DAY) * DAY - off;
  switch (range) {
    case 'today':
      return { from: dayStart, to: dayStart + DAY, bucket: HOUR };
    case '30d':
      return { from: dayStart - 29 * DAY, to: dayStart + DAY, bucket: DAY };
    case '90d':
      return { from: dayStart - 89 * DAY, to: dayStart + DAY, bucket: DAY };
    case 'all':
      return { from: 0, to: dayStart + DAY, bucket: DAY };
    case '7d':
    default:
      return { from: dayStart - 6 * DAY, to: dayStart + DAY, bucket: DAY };
  }
}

const addCost = (acc, c) => {
  if (c) acc[c.currency] = (acc[c.currency] ?? 0) + c.amount;
};
const blank = () => ({ tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: {}, unpriced: 0 });
function add(acc, r, cost) {
  acc.tokens += rowTokens(r);
  acc.input += r.i;
  acc.output += r.o;
  acc.cacheRead += r.cr;
  acc.cacheWrite += r.cw;
  acc.calls += 1;
  if (cost) addCost(acc.cost, cost);
  else acc.unpriced += rowTokens(r);
  return acc;
}
const round = (cost) => Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, Number(v.toFixed(6))]));

/**
 * A usage report for the page.
 * @param {{calls: object[], tasks: object[], running?: object[]}} data
 * @param {{range?: string, bot?: string, tz?: number, now?: number, price: (model: string) => object|null, schedules?: Map<string,string>}} opts
 */
export function report(data, opts) {
  const now = opts.now ?? Date.now();
  const bot = opts.bot || '';
  const { from, to, bucket: named } = rangeOf(opts.range ?? '7d', opts.tz ?? 0, now);
  // 'all' starts at the first row and turns weekly past half a year.
  const earliest = from === 0 ? data.calls.reduce((m, r) => ((!bot || r.b === bot) && r.t < m ? r.t : m), to - named) : from;
  const bucket = from === 0 && to - earliest > 180 * DAY ? 7 * DAY : named;
  /** Buckets are aligned to the end of the range, which is the viewer's midnight. */
  const keyOf = (t) => to - Math.ceil((to - t) / bucket) * bucket;
  const priceCache = new Map();
  const price = (m) => {
    if (!priceCache.has(m)) priceCache.set(m, opts.price(m));
    return priceCache.get(m);
  };
  const inBot = (r) => !bot || r.b === bot;
  const calls = data.calls.filter((r) => inBot(r));
  const span = to - from;
  const totals = blank();
  const prev = blank();
  const byBot = new Map();
  const byModel = new Map();
  const byKind = new Map();
  const byTask = new Map();
  const series = new Map();
  for (const r of calls) {
    if (r.t >= from - span && r.t < from) add(prev, r, costOf(price(r.m), r));
    if (r.t < from || r.t >= to) continue;
    const cost = costOf(price(r.m), r);
    add(totals, r, cost);
    add(byBot.get(r.b) ?? byBot.set(r.b, blank()).get(r.b), r, cost);
    const mk = `${r.p}\n${r.m}`;
    add(byModel.get(mk) ?? byModel.set(mk, { ...blank(), provider: r.p, model: r.m }).get(mk), r, cost);
    add(byKind.get(r.r) ?? byKind.set(r.r, blank()).get(r.r), r, cost);
    if (r.k) add(byTask.get(r.k) ?? byTask.set(r.k, blank()).get(r.k), r, cost);
    const b = keyOf(r.t);
    const s = series.get(b) ?? series.set(b, { t: b, tokens: 0, byBot: {}, cost: {} }).get(b);
    s.tokens += rowTokens(r);
    s.byBot[r.b] = (s.byBot[r.b] ?? 0) + rowTokens(r);
    addCost(s.cost, cost);
  }
  const start = keyOf(Math.max(from, earliest));
  const points = [];
  for (let b = start; b < to; b += bucket) {
    const s = series.get(b);
    points.push(s ? { ...s, cost: round(s.cost) } : { t: b, tokens: 0, byBot: {}, cost: {} });
  }
  const tasks = data.tasks.filter((t) => inBot(t) && (t.end ?? t.start) >= from && (t.end ?? t.start) < to);
  const running = (data.running ?? []).filter(inBot);
  const taskView = (t) => {
    const u = byTask.get(t.id) ?? blank();
    return {
      id: t.id,
      bot: t.b,
      trigger: t.trigger,
      ...(t.via ? { via: t.via } : {}),
      ...(t.from ? { from: t.from } : {}),
      ...(t.sched ? { sched: t.sched } : {}),
      title: t.title,
      start: t.start,
      end: t.end ?? null,
      status: t.status ?? (t.end ? 'done' : 'running'),
      tokens: u.tokens,
      calls: u.calls,
      cost: round(u.cost),
    };
  };
  const finished = tasks.map(taskView);
  const live = running.map(taskView);
  const taskCount = new Map();
  for (const t of tasks) taskCount.set(t.b, (taskCount.get(t.b) ?? 0) + 1);
  const sched = new Map();
  for (const t of finished.filter((x) => x.sched)) {
    const s = sched.get(t.sched) ?? sched.set(t.sched, { id: t.sched, title: opts.schedules?.get(t.sched) ?? t.title, bot: t.bot, runs: 0, tokens: 0, cost: {} }).get(t.sched);
    s.runs += 1;
    s.tokens += t.tokens;
    for (const [c, v] of Object.entries(t.cost)) s.cost[c] = (s.cost[c] ?? 0) + v;
  }
  const fin = (o) => ({ ...o, cost: round(o.cost) });
  const sortTokens = (a, b) => b.tokens - a.tokens;
  return {
    range: { name: opts.range ?? '7d', from: start, to, bucket },
    totals: { ...fin(totals), tasks: tasks.length, cacheRate: totals.input + totals.cacheRead > 0 ? totals.cacheRead / (totals.input + totals.cacheRead + totals.cacheWrite) : 0 },
    prev: { ...fin(prev), tasks: data.tasks.filter((t) => inBot(t) && (t.end ?? t.start) >= from - span && (t.end ?? t.start) < from).length },
    series: points,
    bots: [...byBot].map(([id, v]) => ({ bot: id, ...fin(v), tasks: taskCount.get(id) ?? 0 })).sort(sortTokens),
    models: [...byModel.values()].map((v) => ({ ...fin(v), priced: Boolean(price(v.model)), priceSource: price(v.model)?.source ?? null })).sort(sortTokens),
    kinds: [...byKind].map(([kind, v]) => ({ kind, ...fin(v) })).sort(sortTokens),
    schedules: [...sched.values()].map((s) => ({ ...s, cost: round(s.cost) })).sort(sortTokens),
    tasks: [...live, ...finished.slice().sort((a, b) => (b.end ?? b.start) - (a.end ?? a.start))].slice(0, 60),
    topTasks: finished.slice().sort(sortTokens).slice(0, 10),
  };
}

/** Today's tokens per bot, for the roster. */
export function todayByBot(calls, tz = 0, now = Date.now()) {
  const { from, to } = rangeOf('today', tz, now);
  const out = {};
  for (const r of calls) if (r.t >= from && r.t < to) out[r.b] = (out[r.b] ?? 0) + rowTokens(r);
  return out;
}
