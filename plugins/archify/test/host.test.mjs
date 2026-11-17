import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_TOOL,
  PAGE_HEADERS,
  RENDER_TOOL,
  STOP_REPAIRING,
  SWITCH_TO_STANDARD,
  SKILL_FILE,
  SKILL_ROOT,
  aspectOf,
  buildCliTool,
  buildRenderTool,
  citesSources,
  gitRoot,
  parseSkill,
  render,
  renderResult,
  reviewDirFor,
  runCli,
  settingsOf,
  skillProvider,
  upstream,
} from '../index.js';
import { createStore } from '../lib/store.mjs';
import { outcomeOf, parseJsonOutput } from '../lib/run.mjs';

// Deterministic and fast everywhere: skip the real-browser gate.
process.env.ARCHIFY_CHROME = join(tmpdir(), 'no-such-chrome');

const example = (name) => JSON.parse(readFileSync(join(SKILL_ROOT, 'examples', name), 'utf8'));
const settings = settingsOf({});
const exec = (id = 's1') => ({ agent: { session: { id } } });

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'archify-ws-'));
  const ctx = { get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined) };
  const store = createStore(join(cwd, '.cache'));
  return { cwd, ctx, store };
}

test('the bundled skill is complete and pinned to an upstream commit', () => {
  for (const file of ['SKILL.md', 'LICENSE', 'NOTICE', 'bin/archify.mjs', 'assets/template.html', 'references/authoring-defaults.md', 'schemas/common.schema.json']) {
    assert.ok(existsSync(join(SKILL_ROOT, file)), file);
  }
  const up = upstream();
  assert.match(up.commit, /^[0-9a-f]{40}$/);
  assert.equal(up.repository, 'https://github.com/tt-a1i/archify');
});

test('the skill provider serves the DeepSeek Harness edition of the skill', async () => {
  const provider = skillProvider()({ invalidate() {} });
  assert.equal(provider.name, 'dsh-archify');
  const { candidates, complete } = await provider.list({});
  assert.equal(complete, true);
  assert.equal(candidates.length, 1);
  const [c] = candidates;
  assert.equal(c.name, 'archify');
  assert.equal(c.source, 'bundled');
  assert.deepEqual(c.resourceBase, { kind: 'directory', path: SKILL_ROOT.split('\\').join('/') });
  assert.match(c.description, /architecture/);
  const loaded = await provider.get(c, {});
  assert.equal(loaded.rank, undefined);
  assert.equal(loaded.locator, undefined);
  assert.match(loaded.content, /archify_render/);
  assert.match(loaded.content, /archify_cli/);
  assert.doesNotMatch(loaded.content, /^---/);
  // Every reference the edition links to is in the bundled copy.
  for (const [, rel] of loaded.content.matchAll(/\]\(((?:references|schemas|examples)\/[^)#]+)/g)) assert.ok(existsSync(join(SKILL_ROOT, rel)), rel);
  for (const [, rel] of loaded.content.matchAll(/`((?:schemas|examples)\/[\w./-]+\.json)`/g)) assert.ok(existsSync(join(SKILL_ROOT, rel)), rel);
  assert.throws(() => parseSkill('no frontmatter'), /frontmatter/);
  assert.ok(existsSync(SKILL_FILE));
});

test('archify_render delivers a page, records it, and a repair run reuses folder, page and id', async () => {
  const { cwd, ctx, store } = workspace();
  const spec = example('web-app.architecture.json');
  const v = await render(ctx, store, settings, { type: 'architecture', spec, name: 'web app' }, exec());
  assert.equal(v.ok, true, JSON.stringify(v.receipt?.diagnostics ?? v.stderr));
  assert.equal(v.gates.deliver, 'pass');
  assert.equal(v.browserSkipped, true);
  assert.match(v.output, /\.archify\/architecture-web-app-\d{8}-\d{6}\/web-app\.html$/);
  assert.ok(v.output.startsWith(cwd));
  assert.ok(existsSync(v.output) && existsSync(v.candidate));
  assert.ok(v.aspect > 0.3 && v.aspect < 1);
  assert.equal(store.get(v.id).title, 'Sample Web App');
  assert.equal(store.get(v.id).sessionId, 's1');

  const text = renderResult({}, v)[0].text;
  assert.match(text, /Delivered the architecture page "Sample Web App"/);
  assert.match(text, /browser-check skipped/);
  assert.match(text, /Reply now/);

  const again = await render(ctx, store, settings, { type: 'architecture', candidate: v.candidate }, exec());
  assert.equal(again.ok, true);
  assert.equal(again.output, v.output);
  assert.equal(again.id, v.id);
  assert.equal(store.size(), 1);

  const meta = buildRenderTool(ctx, store, settings).output.presentationMeta({}, again);
  assert.equal(meta.archify, true);
  assert.equal(meta.ok, true);
  assert.equal(meta.id, v.id);
  assert.equal(meta.type, 'architecture');
});

test('a failed render returns the receipt, keeps the budget and asks for standard, then to stop', async () => {
  const { ctx, store } = workspace();
  const spec = example('web-app.architecture.json');
  spec.connections[0].to = 'no-such-node';
  spec.unsupported = true;
  const first = await render(ctx, store, settings, { type: 'architecture', spec, name: 'broken' }, exec());
  assert.equal(first.ok, false);
  assert.equal(first.failedStage, 'validate');
  assert.equal(first.failures, 1);
  assert.ok(first.receipt.diagnostics.length > 0);
  let text = renderResult({}, first)[0].text;
  assert.match(text, /Archify stopped at validate/);
  assert.match(text, /candidate="/);
  assert.doesNotMatch(text, /quality "standard"/);
  assert.equal(store.size(), 0);
  const meta = buildRenderTool(ctx, store, settings).output.presentationMeta({}, first);
  assert.equal(meta.ok, false);
  assert.ok(meta.diagnostics.length > 0);

  let last = first;
  for (let n = 2; n <= STOP_REPAIRING; n += 1) last = await render(ctx, store, settings, { type: 'architecture', candidate: first.candidate }, exec());
  assert.equal(last.failures, STOP_REPAIRING);
  text = renderResult({}, last)[0].text;
  assert.match(text, /Repair budget spent/);
  const middle = renderResult({}, { ...first, failures: SWITCH_TO_STANDARD })[0].text;
  assert.match(middle, /quality "standard"/);
});

test('archify_render renders an explainer from Markdown', async () => {
  const { ctx, store } = workspace();
  const markdown = [
    '# Why does the first HTTPS visit take longer? {#tls-first}',
    '',
    'The browser and server agree on keys first: **one extra round trip** with TLS 1.3.',
    '',
    '- The browser sends its key share in the first message.',
    '- The server answers with its own key share and certificate.',
    '',
    '@answer scope="TLS 1.3 · first visit"',
    '@meta locale=en',
    '',
    '## What changes on a second visit? {#resume}',
    '',
    'A returning browser resumes the session and sends data at once.',
  ].join('\n');
  const v = await render(ctx, store, settings, { type: 'explainer', markdown, name: 'tls-first' }, exec());
  assert.equal(v.ok, true, JSON.stringify(v.receipt?.diagnostics ?? v.stderr));
  assert.match(v.candidate, /candidate\.archify\.md$/);
  assert.equal(v.title, 'Why does the first HTTPS visit take longer?');
  assert.equal(v.aspect, 0);
});

test('archify_render refuses calls it cannot act on', async () => {
  const { ctx, store } = workspace();
  await assert.rejects(render(ctx, store, settings, { type: 'pie' }, exec()), /type must be one of/);
  await assert.rejects(render(ctx, store, settings, { type: 'erd' }, exec()), /pass the candidate/);
  await assert.rejects(render(ctx, store, settings, { type: 'erd', candidate: 'missing.json' }, exec()), /candidate not found/);
  await assert.rejects(render(ctx, store, settings, { type: 'erd', spec: '{bad' }, exec()), /not valid JSON/);
});

test('archify_cli runs other commands with the bundled runtime and refuses preview', async () => {
  const { ctx } = workspace();
  const v = await runCli(ctx, settings, { args: ['doctor'] }, exec());
  assert.equal(v.exitCode, 0);
  assert.match(v.stdout, /Archify is ready/);
  await assert.rejects(runCli(ctx, settings, { args: ['preview', 'architecture', 'x.json'] }, exec()), /live server/);
  await assert.rejects(runCli(ctx, settings, { args: [] }, exec()), /args must list/);
  assert.equal(buildCliTool(ctx, settings).name, CLI_TOOL);
});

test('helpers: review folders, source detection, Git root, receipts, headers, settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archify-review-'));
  const out = join(dir, 'page.html');
  assert.equal(reviewDirFor(dir, out), undefined);
  writeFileSync(join(dir, 'page.browser-check.json'), '{}');
  assert.equal(reviewDirFor(dir, out), join(dir, 'review-2'));

  assert.equal(citesSources('architecture', '{"sources": ["a.js"]}'), true);
  assert.equal(citesSources('architecture', '{}'), false);
  assert.equal(citesSources('explainer', '@code a.js:1'), true);
  assert.equal(await gitRoot(dir), '');

  assert.deepEqual(parseJsonOutput('noise\n{"ok":true}'), { ok: true });
  assert.equal(parseJsonOutput(''), null);
  const skipped = outcomeOf({ ok: false, status: 'skipped', gates: { deliver: 'pass', check: 'pass' }, diagnostics: [{ code: 'viewer/chrome-unavailable', severity: 'warning' }] });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.browserSkipped, true);
  assert.equal(outcomeOf(null, { timedOut: true }).status, 'timeout');

  assert.match(PAGE_HEADERS['content-security-policy'], /^sandbox allow-scripts/);
  assert.doesNotMatch(PAGE_HEADERS['content-security-policy'], /allow-same-origin/);
  assert.deepEqual(settingsOf({ enabled: false, timeoutMs: 5 }), { enabled: false, skill: true, timeoutMs: 240_000 });
  assert.equal(aspectOf(join(dir, 'none.html')), 0);
  assert.equal(RENDER_TOOL, 'archify_render');
});
