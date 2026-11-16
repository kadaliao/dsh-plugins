import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyOps, createMemory, looksSecret, memoryText, normalizeOps, parseJsonReply, reflectionPrompt, dreamTeamPrompt, clip } from '../lib/memory.mjs';
import { createSettings, normalizeSettings } from '../lib/settings.mjs';
import { compactPrices, costOf, priceOf } from '../lib/prices.mjs';
import { rangeOf, report, todayByBot, usageRow, promptTokens } from '../lib/usage.mjs';
import { createTopics, rotationReason } from '../lib/topics.mjs';
import { codexCredential, createCodexSync, detectLogins, discoverModels, keyRefFor, profileFor, readCodexAuth, routeFor } from '../lib/models.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'bots-mem-'));

// --- memory ------------------------------------------------------------------------------------

test('model edits are normalized and odd ones dropped', () => {
  const ops = normalizeOps([{ op: 'add', text: '  likes   tea ', kind: 'preference' }, { op: 'update', id: 'n-1', text: 'x' }, { op: 'delete', id: 'n-2' }, { op: 'merge', ids: ['a', 'b'], text: 'ab' }, { op: 'add', text: '' }, 'junk', { op: 'nope' }]);
  assert.deepEqual(ops, [{ op: 'add', text: 'likes tea', kind: 'preference' }, { op: 'update', id: 'n-1', text: 'x' }, { op: 'remove', id: 'n-2' }, { op: 'merge', ids: ['a', 'b'], text: 'ab' }]);
});

test('applyOps adds, dedupes, updates, merges, and protects pinned notes from machine edits', () => {
  const base = [
    { id: 'n-1', text: 'The user is Kada.', kind: 'person', source: 'user', at: 1, updated: 1, pinned: true },
    { id: 'n-2', text: 'Reports go out on Mondays.', kind: 'fact', source: 'auto', at: 2, updated: 2 },
    { id: 'n-3', text: 'Weekly reports: Monday', kind: 'fact', source: 'auto', at: 3, updated: 3 },
  ];
  const r = applyOps(base, normalizeOps([{ op: 'add', text: 'the user is kada' }, { op: 'remove', id: 'n-1' }, { op: 'merge', ids: ['n-2', 'n-3'], text: 'Weekly reports go out on Mondays.' }, { op: 'add', text: 'Prefers 中文 replies.', kind: 'preference' }]), { source: 'auto', now: 10 });
  assert.equal(r.notes.length, 3);
  assert.ok(r.notes.some((n) => n.id === 'n-1'), 'pinned note survives an auto remove');
  assert.equal(r.notes.find((n) => n.id === 'n-2').text, 'Weekly reports go out on Mondays.');
  assert.ok(!r.notes.some((n) => n.id === 'n-3'));
  assert.equal(r.added, 1);
  assert.equal(r.touched[0], 'n-1', 'the duplicate refreshed the existing note');
  // Only the user changes a pinned note; the bot's own tool leaves it alone.
  const byBot = applyOps(r.notes, [{ op: 'update', id: 'n-1', text: 'The user is someone else.' }], { source: 'tool' });
  assert.equal(byBot.notes.find((n) => n.id === 'n-1').text, 'The user is Kada.');
  const u = applyOps(r.notes, [{ op: 'update', id: 'n-1', text: 'The user is Kada Liao.' }], { source: 'user' });
  assert.equal(u.notes.find((n) => n.id === 'n-1').text, 'The user is Kada Liao.');
});

test('secrets never become notes, and the cap drops the oldest machine notes first', () => {
  assert.ok(looksSecret('key sk-abcdefghijklmnopqrstuvwx'));
  assert.ok(!looksSecret('The API lives at api.example.com'));
  const r = applyOps([], [{ op: 'add', text: 'token ghp_abcdefghijklmnopqrstuvwxyz123456' }]);
  assert.equal(r.notes.length, 0);
  const many = Array.from({ length: 5 }, (_, i) => ({ id: `n-${i}`, text: `note ${i}`, kind: 'fact', source: i === 0 ? 'user' : 'auto', at: i, updated: i }));
  const capped = applyOps(many, [{ op: 'add', text: 'newest' }], { cap: 4, now: 100 });
  assert.equal(capped.notes.length, 4);
  assert.ok(capped.notes.some((n) => n.id === 'n-0'), 'the user note outlives older machine notes');
  assert.ok(!capped.notes.some((n) => n.id === 'n-1'));
});

test('JSON replies are found inside fences and prose', () => {
  assert.deepEqual(parseJsonReply('Sure:\n```json\n{"summary":"ok","notes":[]}\n```'), { summary: 'ok', notes: [] });
  assert.deepEqual(parseJsonReply('{"a":"brace } in string","b":1} trailing'), { a: 'brace } in string', b: 1 });
  assert.equal(parseJsonReply('no json here'), null);
});

test('the memory store keeps bot and team notes, a journal, digests and finds them', () => {
  const dir = tmp();
  const m = createMemory(dir);
  m.edit('bot-a', [{ op: 'add', text: 'Kada prefers short answers.', kind: 'preference' }], { source: 'auto' });
  m.edit('team', [{ op: 'add', text: 'The company is called Acme.' }]);
  const pinned = m.put('bot-a', { text: 'Never email customers on weekends.', pinned: true });
  assert.equal(pinned.pinned, true);
  assert.throws(() => m.put('team', { text: 'password is sk-ant-abcdefghijklmnop' }), /secret/);
  m.addJournal({ bot: 'bot-a', task: 't1', title: 'Write the launch post', summary: 'Wrote the Acme launch post (800 words), saved to posts/launch.md.' });
  m.addDigest({ date: '2026-11-16', text: 'Shipped the launch post.' });
  const again = createMemory(dir);
  assert.equal(again.notes('bot-a').length, 2);
  assert.equal(again.notes('team').length, 1);
  const found = again.search('acme', { bot: 'bot-a' });
  assert.equal(found.notes.length, 1);
  assert.equal(found.journal.length, 1);
  const text = again.promptFor({ id: 'bot-a', name: 'A', handle: 'a' });
  assert.match(text, /### What you remember/);
  assert.match(text, /\[n-[a-z0-9]+\] Never email customers on weekends\./);
  assert.match(text, /### Team memory/);
  assert.match(text, /Wrote the Acme launch post/);
  assert.match(text, /Latest team digest \(2026-11-16\)/);
  assert.ok(again.remove('bot-a', pinned.id));
  again.dropBot('bot-a');
  assert.equal(again.notes('bot-a').length, 0);
});

test('memory text stays within budget and says how many notes are hidden', () => {
  const notes = Array.from({ length: 200 }, (_, i) => ({ id: `n-${i}`, text: `note number ${i} `.repeat(4), updated: i }));
  const text = memoryText({ bot: {}, notes, team: [], journal: [], digest: null });
  assert.match(text, /newest \d+ of 200/);
  assert.ok(text.length < 9000);
});

test('prompts carry the notes, the transcript and the expected JSON shape', () => {
  const p = reflectionPrompt({ bot: { name: 'Ada', handle: 'ada', bio: 'writer' }, notes: [{ id: 'n-1', text: 'x' }], team: [], transcript: '[user] hi', trigger: 'a message from the user' });
  assert.match(p.system, /"summary"/);
  assert.match(p.user, /\[n-1\] x/);
  assert.match(p.user, /\[user\] hi/);
  const d = dreamTeamPrompt({ bots: [{ id: 'b1', handle: 'ada', name: 'Ada' }], team: [], journal: [{ at: 0, bot: 'b1', summary: 'did a thing' }], date: '2026-11-16' });
  assert.match(d.user, /@ada: did a thing/);
  assert.equal(clip('x'.repeat(100), 50).length < 120, true);
});

// --- settings ---------------------------------------------------------------------------------

test('settings default, clamp and save', () => {
  const s = normalizeSettings({ topics: { idleHours: -3, maxContextK: 'x' }, memory: { dreamTime: '25:00', auto: false }, prices: { 'GPT-X': { input: 1, output: 2 }, bad: { input: 'a' } } });
  assert.equal(s.topics.idleHours, 0);
  assert.equal(s.topics.maxContextK, 128);
  assert.equal(s.memory.dreamTime, '03:00');
  assert.equal(s.memory.auto, false);
  assert.deepEqual(Object.keys(s.prices), ['gpt-x']);
  const dir = tmp();
  const store = createSettings(dir);
  store.save({ topics: { idleHours: 2 } });
  store.save({ memory: { dreamTime: '4:30' } });
  const again = createSettings(dir).get();
  assert.equal(again.topics.idleHours, 2);
  assert.equal(again.topics.maxContextK, 128);
  assert.equal(again.memory.dreamTime, '04:30');
});

// --- prices and usage ---------------------------------------------------------------------------

test('LiteLLM rows compact to text prices, and lookups try suffixes, overrides and prefixes', () => {
  const cat = compactPrices({
    'gpt-4o': { mode: 'chat', input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1.25e-6, litellm_provider: 'openai' },
    'deepseek/deepseek-chat': { mode: 'chat', input_cost_per_token: 2.7e-7, output_cost_per_token: 1.1e-6, litellm_provider: 'deepseek' },
    'openrouter/deepseek/deepseek-chat': { mode: 'chat', input_cost_per_token: 9e-7, output_cost_per_token: 9e-7, litellm_provider: 'openrouter' },
    'dall-e-3': { mode: 'image_generation', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
  });
  assert.deepEqual(cat.prices['gpt-4o'], { input: 2.5, output: 10, cacheRead: 1.25, currency: 'USD' });
  assert.equal(cat.prices['deepseek-chat'].input, 0.27, "the vendor's own row wins the bare name");
  assert.ok(!cat.prices['dall-e-3']);
  assert.equal(priceOf('auto/deepseek-chat', {}, cat).input, 0.27);
  assert.equal(priceOf('gpt-4o-2026-01-01', {}, cat).approximate, true);
  assert.equal(priceOf('deepseek-flash', { 'deepseek-flash': { input: 1, output: 2, currency: 'CNY' } }, cat).source, 'user');
  assert.equal(priceOf('mystery', {}, cat), null);
  const c = costOf({ input: 2, output: 8, cacheRead: 0.5 }, { i: 1_000_000, o: 500_000, cr: 2_000_000, cw: 0 });
  assert.equal(c.amount, 2 + 4 + 1);
});

test('usage report: totals, buckets in the viewer zone, per bot/model/kind, tasks and schedules', () => {
  const now = Date.UTC(2026, 10, 16, 12, 0); // 20:00 in UTC+8
  const tz = 480;
  const at = (h) => now - h * 3600_000;
  const calls = [
    usageRow({ at: at(1), botId: 'a', sessionId: 's1', taskId: 't1', provider: 'p', model: 'm1', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 } }),
    usageRow({ at: at(2), botId: 'b', sessionId: 's2', taskId: 't2', provider: 'p', model: 'm2', usage: { inputTokens: 10, outputTokens: 10 } }),
    usageRow({ at: at(2), botId: 'a', sessionId: 's1', taskId: 't1', kind: 'memory', provider: 'p', model: 'm1', usage: { inputTokens: 40, outputTokens: 10 } }),
    usageRow({ at: at(30), botId: 'a', sessionId: 's1', provider: 'p', model: 'm1', usage: { inputTokens: 5, outputTokens: 5 } }),
    usageRow({ at: at(24 * 9), botId: 'a', sessionId: 's1', provider: 'p', model: 'm1', usage: { inputTokens: 7, outputTokens: 0 } }),
  ];
  const tasks = [
    { id: 't1', b: 'a', s: 's1', trigger: 'schedule', sched: 'sch-1', title: 'Morning brief', start: at(1.5), end: at(0.9), status: 'done' },
    { id: 't2', b: 'b', s: 's2', trigger: 'user', title: 'hello', start: at(2.1), end: at(1.9), status: 'done' },
  ];
  const price = (m) => (m === 'm1' ? { input: 1, output: 2, cacheRead: 0.1, currency: 'USD', source: 'user' } : null);
  const r = report({ calls, tasks, running: [] }, { range: '7d', tz, now, price, schedules: new Map([['sch-1', 'Morning brief']]) });
  assert.equal(r.series.length, 7);
  assert.equal(r.totals.calls, 4);
  assert.equal(r.totals.tokens, 1050 + 20 + 50 + 10);
  assert.equal(r.totals.tasks, 2);
  assert.equal(r.totals.unpriced, 20);
  assert.ok(r.totals.cost.USD > 0);
  assert.equal(r.prev.calls, 1, 'the call nine days back is in the previous week');
  assert.equal(r.bots[0].bot, 'a');
  assert.deepEqual(r.kinds.map((k) => k.kind).sort(), ['chat', 'memory']);
  assert.equal(r.models.find((m) => m.model === 'm2').priced, false);
  assert.equal(r.tasks[0].id, 't1');
  assert.equal(r.tasks[0].tokens, 1050 + 50);
  assert.deepEqual(r.schedules.map((s) => [s.title, s.runs]), [['Morning brief', 1]]);
  // The last bucket is today in UTC+8, starting at local midnight.
  assert.equal(r.series[6].t, Date.UTC(2026, 10, 15, 16, 0));
  const day = report({ calls, tasks }, { range: 'today', tz, now, price });
  assert.equal(day.series.length, 24);
  assert.equal(day.totals.calls, 3);
  const bot = report({ calls, tasks }, { range: '7d', bot: 'b', tz, now, price });
  assert.equal(bot.totals.calls, 1);
  assert.deepEqual(todayByBot(calls, tz, now), { a: 1050 + 50, b: 20 });
  assert.equal(promptTokens({ inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 }), 6);
  assert.equal(rangeOf('30d', tz, now).to - rangeOf('30d', tz, now).from, 30 * 86_400_000);
});

// --- topics ---------------------------------------------------------------------------------------

test('a topic ends after a long quiet, or when big — never for size on a teammate message', () => {
  const rules = { idleHours: 6, maxContextK: 100 };
  const now = 1e12;
  assert.equal(rotationReason({ tasks: 0, lastActiveAt: 0, lastPrompt: 1e9 }, rules, { now }), '');
  assert.equal(rotationReason({ tasks: 3, lastActiveAt: now - 7 * 3600_000, lastPrompt: 0 }, rules, { now }), 'idle');
  const big = { tasks: 3, lastActiveAt: now - 60_000, lastPrompt: 150_000 };
  assert.equal(rotationReason(big, rules, { now, trigger: 'user' }), 'context');
  assert.equal(rotationReason(big, rules, { now, trigger: 'dm' }), '');
  assert.equal(rotationReason(big, rules, { now, trigger: 'sweep' }), '', 'too fresh for the sweep');
  assert.equal(rotationReason({ ...big, lastActiveAt: now - 3600_000 }, rules, { now, trigger: 'sweep' }), 'context');
  assert.equal(rotationReason(big, { idleHours: 0, maxContextK: 0 }, { now, trigger: 'user' }), '');
});

test('the topics file tracks the current topic and its history', () => {
  const dir = tmp();
  const t = createTopics(dir);
  t.current('bot-a', 's1');
  t.noteCall('bot-a', 's1', 5000);
  t.noteTask('bot-a', 's1', 'First task');
  t.rotate('bot-a', 's2', 'manual');
  const again = createTopics(dir);
  assert.equal(again.peek('bot-a').sessionId, 's2');
  assert.equal(again.history('bot-a')[0].sessionId, 's1');
  assert.equal(again.history('bot-a')[0].tasks, 1);
  assert.deepEqual(again.history('bot-a')[0].titles, ['First task']);
  assert.equal(again.history('bot-a')[0].reason, 'manual');
});

// --- model sources ------------------------------------------------------------------------------

test('a custom endpoint becomes a bots- route with a key reference', () => {
  assert.equal(routeFor('My Gateway!'), 'bots-my-gateway');
  assert.match(routeFor('本地模型'), /^bots-custom-[a-z0-9]+$/);
  assert.notEqual(routeFor('本地模型'), routeFor('公司网关'));
  assert.equal(routeFor('本地模型'), routeFor('本地模型'));
  assert.match(routeFor('Qwen 本地'), /^bots-qwen-[a-z0-9]+$/);
  assert.equal(keyRefFor('bots-my-gateway'), 'BOTS_MY_GATEWAY_API_KEY');
  const { route, profile } = profileFor({ name: 'My Gateway', api: 'anthropic-messages', baseURL: 'https://gw.example.com/v1/', models: ['m-1', { id: 'm-2', contextWindow: 200000 }, 'm-1'] });
  assert.equal(route, 'bots-my-gateway');
  assert.deepEqual(profile, { displayName: 'My Gateway', api: 'anthropic-messages', baseURL: 'https://gw.example.com/v1', apiKeyEnv: 'BOTS_MY_GATEWAY_API_KEY', models: [{ id: 'm-1' }, { id: 'm-2', contextWindow: 200000 }] });
  assert.throws(() => profileFor({ name: 'x', baseURL: 'ftp://x', models: ['a'] }), /http/);
  assert.throws(() => profileFor({ name: 'x', baseURL: 'https://x', models: [] }), /model/);
});

test('model discovery reads OpenAI- and Anthropic-style lists', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return { ok: true, json: async () => (url.includes('anthropic') ? { data: [{ id: 'claude-x', display_name: 'Claude X' }] } : { data: [{ id: 'b' }, { id: 'a' }] }) };
  };
  assert.deepEqual(await discoverModels({ api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', key: 'k', fetchImpl }), [{ id: 'a' }, { id: 'b' }]);
  assert.equal(seen[0].url, 'http://127.0.0.1:9/v1/models');
  assert.equal(seen[0].headers.authorization, 'Bearer k');
  assert.deepEqual(await discoverModels({ api: 'anthropic-messages', baseURL: 'https://anthropic.example', key: 'k', fetchImpl }), [{ id: 'claude-x', name: 'Claude X' }]);
  assert.equal(seen[1].url, 'https://anthropic.example/v1/models?limit=1000');
  assert.equal(seen[1].headers['x-api-key'], 'k');
});

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
function codexHome(refresh = 'r1', access = jwt({ exp: 2_000_000_000, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc', chatgpt_plan_type: 'pro' } })) {
  const home = tmp();
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: 'x', tokens: { id_token: jwt({ email: 'k@example.com' }), access_token: access, refresh_token: refresh, account_id: 'acc' } }));
  return home;
}

test('a Codex CLI login is read without exposing tokens to the page, and Claude Code is not offered', () => {
  const home = codexHome();
  const a = readCodexAuth(join(home, '.codex', 'auth.json'));
  assert.equal(a.ok, true);
  assert.equal(a.email, 'k@example.com');
  assert.equal(a.plan, 'pro');
  assert.equal(a.expires, 2_000_000_000_000);
  assert.deepEqual(codexCredential(a), { type: 'oauth', access: a.access, refresh: 'r1', expires: a.expires, accountId: 'acc' });
  writeFileSync(join(home, '.claude.json'), '{}');
  const logins = detectLogins(home);
  const codex = logins.find((l) => l.id === 'codex');
  assert.equal(codex.found, true);
  assert.equal(codex.account, 'k@example.com');
  assert.ok(!JSON.stringify(logins).includes('r1'));
  const claude = logins.find((l) => l.id === 'claude-code');
  assert.equal(claude.found, true);
  assert.equal(claude.supported, false);
  assert.equal(readCodexAuth(join(tmp(), 'none.json')).reason, 'missing');
});

test('the Codex login stays in sync both ways', async () => {
  const home = codexHome('r1');
  const file = join(home, '.codex', 'auth.json');
  let record;
  const sync = createCodexSync({ file, readRecord: async () => record, writeRecord: async (c) => (record = c) });
  assert.equal(await sync.syncOnce(), 'to-harness');
  assert.equal(record.refresh, 'r1');
  assert.equal(await sync.syncOnce(), 'same');
  // Harness refreshed: the new tokens go back to the Codex CLI, everything else in its file kept.
  record = { ...record, access: jwt({ exp: 2_100_000_000 }), refresh: 'r2', expires: 2_100_000_000_000 };
  assert.equal(await sync.syncOnce(), 'to-codex');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.tokens.refresh_token, 'r2');
  assert.equal(raw.auth_mode, 'chatgpt');
  assert.ok(raw.tokens.id_token);
  // The Codex CLI refreshed: Harness takes its tokens.
  raw.tokens.refresh_token = 'r3';
  raw.tokens.access_token = jwt({ exp: 2_200_000_000 });
  writeFileSync(file, JSON.stringify(raw));
  assert.equal(await sync.syncOnce(), 'to-harness');
  assert.equal(record.refresh, 'r3');
  // Signed in to another ChatGPT account on one side: nothing is overwritten.
  record = { ...record, refresh: 'other', accountId: 'acc-other' };
  assert.equal(await sync.syncOnce(), 'conflict');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).tokens.refresh_token, 'r3');
  assert.equal(record.refresh, 'other');
});
