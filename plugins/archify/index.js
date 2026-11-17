/**
 * Host half of the Archify bundle.
 *
 * - Ships the Archify skill (tt-a1i/archify, Apache-2.0) through a skill
 *   provider, in a DeepSeek Harness edition whose instructions call the tools
 *   below instead of a shell.
 * - `archify_render` runs Archify's `finalize` (validate, deliver, strict check,
 *   real-browser check) with the Harness's own runtime, so no Node.js install is
 *   needed, and records each delivered page in a gallery.
 * - `archify_cli` runs any other Archify command the same way.
 * - Loopback routes let the Client half show a page in the conversation and in
 *   the Archify panel, open it in the default browser, or show it in its folder.
 *
 * @module @kadaliao/dsh-archify
 */

import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

import { CLI, SKILL_ROOT, clip, outcomeOf, parseJsonOutput, runArchify } from './lib/run.mjs';
import { NATIVE_TYPES, TYPES, planPaths, resolveFrom, titleOf } from './lib/paths.mjs';
import { createStore, newId } from './lib/store.mjs';

// The registry wants the compiled definition `defineTool` makes. Outside a
// Harness (the tests) the raw definition stands in for it.
let defineTool = (definition) => definition;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch {
  // No Harness around: tests run on the raw definition.
}

/** The tool registry is required; skills and the web server ride deferred injects. */
export const inject = ['tools'];

export const RENDER_TOOL = 'archify_render';
export const CLI_TOOL = 'archify_cli';
export const SKILL_NAME = 'archify';
export const PROVIDER = 'dsh-archify';
/** Packaged skills' standard precedence (`BUNDLED_SKILL_RANK` in @deepseek-ai/dsh-skill). */
const BUNDLED_RANK = 600;

const LIST_ROUTE = '/__dsh_archify/list';
// A prefix route matches `<prefix>/<rest>`, so it is registered without the slash.
const FILE_ROUTE = '/__dsh_archify/file';
const DELETE_ROUTE = '/__dsh_archify/delete';
const OPEN_ROUTE = '/__dsh_archify/open';
const STATE_ROUTE = '/__dsh_archify/state';

/** The skill file this bundle serves, beside the vendored skill it points into. */
export const SKILL_FILE = join(SKILL_ROOT, '..', 'skill', 'SKILL.md');

/** Upstream identity of the vendored copy. */
export function upstream() {
  try {
    return JSON.parse(readFileSync(join(SKILL_ROOT, 'UPSTREAM.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Normalize the Loader row's config.
 * @param {unknown} config
 */
export function settingsOf(config) {
  const c = config && typeof config === 'object' ? config : {};
  const timeout = Number(c.timeoutMs);
  return {
    enabled: c.enabled !== false,
    skill: c.skill !== false,
    timeoutMs: Number.isFinite(timeout) && timeout >= 10_000 ? timeout : 240_000,
  };
}

/** The DSH home the gallery lives under. */
function homeDir() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
}

// --- the skill --------------------------------------------------------------------

/** `description` and body of a SKILL.md with a one-line JSON-quoted description. */
export function parseSkill(raw) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!fm) throw new Error('archify: SKILL.md has no frontmatter');
  const line = /^description:\s*(.+)$/m.exec(fm[1]);
  let description = line ? line[1].trim() : '';
  if (description.startsWith('"')) description = JSON.parse(description);
  if (description === '') throw new Error('archify: SKILL.md has no description');
  return { description, content: raw.slice(fm[0].length).trim() };
}

/** The provider Harness's skill registry asks for the catalog entry and, on load, the body. */
export function skillProvider(file = SKILL_FILE, root = SKILL_ROOT) {
  const read = () => parseSkill(readFileSync(file, 'utf8'));
  const summary = (description) => ({
    name: SKILL_NAME,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: root.split(sep).join('/') },
  });
  return () => ({
    name: PROVIDER,
    async list() {
      try {
        return { candidates: [{ ...summary(read().description), rank: BUNDLED_RANK, locator: file }], complete: true };
      } catch {
        return { candidates: [], complete: true };
      }
    },
    async get(candidate) {
      const { rank: _rank, locator: _locator, ...rest } = candidate;
      const skill = read();
      return { ...rest, ...summary(skill.description), content: skill.content };
    },
  });
}

// --- the tools ----------------------------------------------------------------------

/** The session's working directory. */
function cwdOf(ctx, exec) {
  try {
    const session = exec?.agent?.session;
    const dir = session ? ctx.get('workingDirectory')?.get?.(session) : undefined;
    if (typeof dir === 'string' && dir !== '') return dir;
  } catch {
    // The process's own below.
  }
  return process.cwd();
}

/**
 * A later run on a page whose browser check already left evidence gets its own
 * `review-<n>` folder, as the skill's delivery contract asks.
 */
export function reviewDirFor(folder, output) {
  const stem = basename(output).replace(/\.html?$/i, '');
  let reviewed = existsSync(join(dirname(output), `${stem}.browser-check.json`));
  let n = 1;
  try {
    for (const name of readdirSync(folder)) {
      const m = /^review-(\d+)$/.exec(name);
      if (m) {
        reviewed = true;
        n = Math.max(n, Number(m[1]));
      }
    }
  } catch {
    // A new folder has none.
  }
  return reviewed ? join(folder, `review-${n + 1}`) : undefined;
}

class ToolInputError extends Error {}

/** Failed renders per candidate since its last delivery: the repair budget. */
const attempts = new Map();
/** From this failed render on, the result says to deliver at `standard` now. */
export const SWITCH_TO_STANDARD = 3;
/** From this failed render on, the result says to stop and report. */
export const STOP_REPAIRING = 8;

/** One more failure of `candidate`, or a reset on delivery; returns the count. */
export function countAttempt(candidate, delivered) {
  if (delivered) {
    attempts.delete(candidate);
    return 0;
  }
  const n = (attempts.get(candidate) ?? 0) + 1;
  attempts.set(candidate, n);
  if (attempts.size > 500) attempts.delete(attempts.keys().next().value);
  return n;
}

/** Whether a candidate cites repository sources: `sources` in a diagram, `@code` in an explainer. */
export function citesSources(type, text) {
  return type === 'explainer' ? /^@code\b/m.test(String(text ?? '')) : /"sources"\s*:/.test(String(text ?? ''));
}

/**
 * The Git work tree `cwd` is in, or '' outside one: then Archify's own
 * diagnostic asks for the root, which says more than a failed Git call.
 */
export function gitRoot(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 5000, windowsHide: true }, (error, stdout) => {
      const root = String(stdout ?? '').trim();
      resolve(!error && root !== '' ? root : '');
    });
  });
}

/**
 * Height over width of a page's diagram, from its main SVG's viewBox, so the
 * conversation can size the preview to the drawing; 0 when there is none.
 */
export function aspectOf(htmlPath) {
  try {
    const html = readFileSync(htmlPath, 'utf8');
    const m = /<svg\b[^>]*\bviewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"[^>]*aria-labelledby="archify-diagram-title/.exec(html);
    if (!m) return 0;
    const w = Number(m[1]);
    const hgt = Number(m[2]);
    return w > 0 && hgt > 0 ? Math.round((hgt / w) * 10_000) / 10_000 : 0;
  } catch {
    return 0;
  }
}

/** Run one `archify_render` call. */
export async function render(ctx, store, settings, args, exec) {
  const a = args && typeof args === 'object' ? args : {};
  const type = String(a.type ?? '').trim();
  if (!TYPES.includes(type)) throw new ToolInputError(`type must be one of: ${TYPES.join(', ')}`);
  const cwd = cwdOf(ctx, exec);
  const quality = a.quality === 'standard' ? 'standard' : 'showcase';

  // The draft the model sent, as the text that goes into the candidate file.
  let draft = null;
  if (type === 'explainer') {
    if (typeof a.markdown === 'string' && a.markdown.trim() !== '') draft = a.markdown.endsWith('\n') ? a.markdown : `${a.markdown}\n`;
    else if (typeof a.spec === 'string' && a.spec.trim() !== '') draft = a.spec;
  } else if (a.spec !== undefined && a.spec !== null && a.spec !== '') {
    let spec = a.spec;
    if (typeof spec === 'string') {
      try {
        spec = JSON.parse(spec);
      } catch (error) {
        throw new ToolInputError(`spec is not valid JSON: ${error.message}`);
      }
    }
    if (typeof spec !== 'object' || Array.isArray(spec)) throw new ToolInputError('spec must be the candidate JSON object');
    draft = `${JSON.stringify(spec, null, 2)}\n`;
  }
  const hasCandidate = typeof a.candidate === 'string' && a.candidate.trim() !== '';
  if (draft === null && !hasCandidate) {
    throw new ToolInputError(type === 'explainer' ? 'pass the draft as `markdown`, or `candidate` with the path of a candidate.archify.md' : 'pass the candidate as `spec`, or `candidate` with the path of a candidate JSON file');
  }

  const plan = planPaths({ cwd, type, candidate: hasCandidate ? a.candidate : '', output: a.output, name: a.name, title: draft ? titleOf(type, draft) : '' });
  if (draft !== null) {
    mkdirSync(dirname(plan.candidate), { recursive: true });
    writeFileSync(plan.candidate, draft, 'utf8');
  } else if (!existsSync(plan.candidate)) {
    throw new ToolInputError(`candidate not found: ${plan.candidate}`);
  }
  const text = draft ?? readFileSync(plan.candidate, 'utf8');
  const title = titleOf(type, text) || plan.slug;

  const outDir = typeof a.outDir === 'string' && a.outDir.trim() !== '' ? resolveFrom(cwd, a.outDir) : reviewDirFor(plan.folder, plan.output);
  const cliArgs = ['finalize', type, plan.candidate, plan.output, '--json', '--quality', quality];
  // A draft that cites source files is checked against a repository; when the
  // model names none, the working directory's Git root is it.
  const repoRoot = typeof a.repoRoot === 'string' && a.repoRoot.trim() !== '' ? resolveFrom(cwd, a.repoRoot) : citesSources(type, text) ? await gitRoot(cwd) : '';
  if (repoRoot) cliArgs.push('--repo-root', repoRoot);
  if (outDir) cliArgs.push('--out-dir', outDir);

  const run = await runArchify(cliArgs, { cwd, signal: exec?.signal, timeoutMs: settings.timeoutMs });
  if (exec?.signal?.aborted) throw new Error('the render was cancelled');
  const receipt = parseJsonOutput(run.stdout);
  const outcome = outcomeOf(receipt, run);
  const failures = receipt ? countAttempt(plan.candidate, outcome.ok) : 0;
  let id = '';
  let version = '';
  let aspect = 0;
  if (outcome.ok) {
    let bytes = 0;
    try {
      bytes = statSync(plan.output).size;
    } catch {
      bytes = 0;
    }
    version = String(receipt?.artifact?.sha256 ?? Date.now()).slice(0, 16);
    aspect = type === 'explainer' ? 0 : aspectOf(plan.output);
    const item = store.put({
      id: newId(),
      type,
      title,
      html: plan.output,
      candidate: plan.candidate,
      cwd,
      sessionId: String(exec?.agent?.session?.id ?? ''),
      quality,
      gates: outcome.gates,
      browserSkipped: outcome.browserSkipped,
      bytes,
      version,
      aspect,
      updatedAt: Date.now(),
    });
    id = item.id;
  }
  return {
    ok: outcome.ok,
    type,
    title,
    candidate: plan.candidate,
    output: plan.output,
    folder: plan.folder,
    quality,
    status: outcome.status,
    gates: outcome.gates,
    failedStage: outcome.failedStage,
    browserSkipped: outcome.browserSkipped,
    ...(id ? { id, version, aspect } : {}),
    ...(failures > 0 ? { failures } : {}),
    ms: run.ms,
    receipt: receipt ?? null,
    ...(receipt ? {} : { stdout: clip(run.stdout, 6000), stderr: clip(run.stderr, 6000), exitCode: run.code ?? -1, timedOut: run.timedOut }),
  };
}

/** What the model reads back from one render. */
export function renderResult(_args, value) {
  const v = value && typeof value === 'object' ? value : {};
  const gates = Object.entries(v.gates ?? {})
    .map(([k, s]) => `${k} ${k === 'browser-check' && v.browserSkipped ? 'skipped (no Chrome-family browser installed)' : s}`)
    .join(', ');
  const lines = [];
  if (v.ok) {
    lines.push(`Delivered the ${v.type} page "${v.title}" at ${v.output} (candidate ${v.candidate}). Gates: ${gates}.`);
    lines.push('This page is the deliverable and the user already sees it in the conversation (interactive, with full screen, open in browser and download) and in the Archify panel. Reply now, as the skill\'s Output section says, without repeating the path. Do not run visual checks, captures or another layout round unless the user asks for one.');
    const r = v.receipt ?? {};
    const review = r.visualReviewRecommendation ?? r.layoutReviewRecommendation;
    if (review) lines.push(`The receipt suggests an optional layout review (${review.action ?? 'review'}). End the reply with one short clause offering to tidy the layout; keep the details for when the user asks: ${clip(JSON.stringify({ visualReviewRecommendation: r.visualReviewRecommendation, layoutReviewRecommendation: r.layoutReviewRecommendation }), 3000)}`);
    const warnings = (Array.isArray(r.diagnostics) ? r.diagnostics : []).filter((d) => d?.severity === 'warning' && d?.code !== 'viewer/chrome-unavailable');
    if (warnings.length > 0 || r.writing) lines.push(`Warnings to mention only if they change how the page reads: ${clip(JSON.stringify({ warnings, writing: r.writing }), 3000)}`);
  } else if (v.receipt) {
    lines.push(`Archify stopped at ${v.failedStage || v.status}${gates ? ` (gates: ${gates})` : ''}. Nothing was delivered.`);
    const n = Number(v.failures) || 1;
    if (n >= STOP_REPAIRING) {
      lines.push(`Repair budget spent (failed render ${n} of this candidate). Stop repairing now: tell the user in two or three lines which issue remains, from the diagnostics below, that the candidate is at ${v.candidate}, and offer to keep going. Do not render again unless the user asks.`);
    } else {
      lines.push(`Repair the candidate at ${v.candidate} in place with your file-editing tool: apply each diagnostic's supportedFixes (or the fix its message names), keep everything the diagnostics do not name, then call ${RENDER_TOOL} again with candidate="${v.candidate}". This was failed render ${n}; at ${STOP_REPAIRING} the budget is spent.`);
      if (n >= SWITCH_TO_STANDARD && v.quality === 'showcase') {
        lines.push('The user is waiting: in this repair also set meta.quality_profile to "standard" in the candidate and pass quality "standard". That profile leaves out the showcase-only composition checks (label clearance, corridor and crossing polish, canvas width), so the page can be delivered now; after delivery, offer a showcase polish in one clause.');
      }
    }
    lines.push(`Receipt: ${clip(JSON.stringify(v.receipt))}`);
  } else {
    lines.push(`Archify did not produce a receipt (exit ${v.exitCode}${v.timedOut ? ', timed out' : ''}). Candidate: ${v.candidate}.`);
    if (v.stderr) lines.push(`stderr:\n${v.stderr}`);
    if (v.stdout) lines.push(`stdout:\n${v.stdout}`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

export function buildRenderTool(ctx, store, settings) {
  return defineTool({
    name: RENDER_TOOL,
    description:
      'Render, check and deliver an Archify diagram or one-page explainer as a standalone interactive HTML page (the Archify skill\'s `finalize`). Load the `archify` skill first and follow it to author the candidate. ' +
      'New request: pass the complete candidate as `spec` (JSON object; for type explainer, the Markdown draft as `markdown`) and a short Latin `name`; the tool writes it to `.archify/<type>-<name>-<timestamp>/` under the working directory and delivers the page next to it. ' +
      'Repair: edit that candidate file in place, then call again with `candidate` set to its path. ' +
      'It runs validate, deliver, a strict check and a real-browser check, and returns the compact receipt: on failure its diagnostics say what to fix. A delivered page is shown to the user in the conversation and in the Archify panel.',
    parameters: {
      type: { type: 'string', required: true, enum: TYPES, description: `Diagram type: ${NATIVE_TYPES.join(', ')}; or explainer for a one-page answer.` },
      spec: { type: 'object', additionalProperties: true, description: 'The complete candidate JSON (schema_version, diagram_type, meta, …) for a native diagram. Leave out when passing `candidate`.' },
      markdown: { type: 'string', description: 'For type explainer: the complete candidate.archify.md draft. Leave out when passing `candidate`.' },
      candidate: { type: 'string', description: 'Path of an existing candidate file (relative to the working directory, absolute or ~/…): to re-render after editing it in place. With `spec`/`markdown` too, that file is overwritten first.' },
      name: { type: 'string', description: 'Short Latin kebab-case name for a new folder and page, e.g. checkout-flow. Leave out to derive it from the title.' },
      quality: { type: 'string', enum: ['showcase', 'standard'], description: 'Must match meta.quality_profile. Default showcase.' },
      repoRoot: { type: 'string', description: 'For a repository-backed diagram whose repository is not the working directory\'s Git root: the root its source evidence points into. Default: that Git root, when the candidate cites sources.' },
      output: { type: 'string', description: 'Page path, only when the user names one. Default: <name>.html beside the candidate.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: renderResult,
      presentationMeta: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        return {
          archify: true,
          ok: v.ok === true,
          type: String(v.type ?? ''),
          title: String(v.title ?? ''),
          status: String(v.status ?? ''),
          failedStage: String(v.failedStage ?? ''),
          gates: v.gates && typeof v.gates === 'object' ? v.gates : {},
          browserSkipped: v.browserSkipped === true,
          output: String(v.output ?? ''),
          candidate: String(v.candidate ?? ''),
          ms: Number(v.ms) || 0,
          ...(v.id ? { id: String(v.id), version: String(v.version ?? ''), aspect: Number(v.aspect) || 0 } : {}),
          ...(v.receipt && !v.ok && Array.isArray(v.receipt.diagnostics)
            ? {
                diagnostics: v.receipt.diagnostics.slice(0, 6).map((d) => ({ code: String(d?.code ?? ''), severity: String(d?.severity ?? ''), message: String(d?.message ?? '').slice(0, 400) })),
                diagnosticTotal: Number(v.receipt.diagnosticSummary?.total) || v.receipt.diagnostics.length,
              }
            : {}),
        };
      },
    },
    timeoutMs: settings.timeoutMs + 15_000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => render(ctx, store, settings, args, exec),
  });
}

/** Commands `archify_cli` does not run: a live preview server never exits on its own. */
const REFUSED = new Map([['preview', `\`preview\` starts a live server that does not exit; use ${RENDER_TOOL}, whose page the user already sees in the conversation.`]]);

export async function runCli(ctx, settings, args, exec) {
  const list = Array.isArray(args?.args) ? args.args.map((x) => String(x)) : [];
  if (list.length === 0) throw new ToolInputError('args must list the Archify command and its arguments, e.g. ["guide", "checkout flow", "--json"]');
  const refusal = REFUSED.get(list[0]);
  if (refusal) throw new ToolInputError(refusal);
  const cwd = cwdOf(ctx, exec);
  const run = await runArchify(list.filter((x) => x !== '--open'), { cwd, signal: exec?.signal, timeoutMs: settings.timeoutMs });
  if (exec?.signal?.aborted) throw new Error('the command was cancelled');
  return { exitCode: run.code ?? -1, stdout: clip(run.stdout, 20_000), stderr: clip(run.stderr, 6000), ms: run.ms, timedOut: run.timedOut };
}

export function buildCliTool(ctx, settings) {
  return defineTool({
    name: CLI_TOOL,
    description:
      'Run an Archify CLI command with the bundled runtime (no Node.js install needed), in the working directory: guide, brands, compare, patch, validate, inspect, check, browser-check, visual-check, migrate, examples, doctor, demo. ' +
      `Pass the arguments that follow \`archify\`, e.g. ["guide", "<scenario>", "--json"]. For rendering and delivery use ${RENDER_TOOL}, not finalize here.`,
    parameters: {
      args: { type: 'array', required: true, items: { type: 'string' }, description: 'The command and its arguments, as separate strings.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { exitCode: { type: 'integer', required: true } } },
      render: (_a, v) => [
        {
          type: 'text',
          text: [`exit ${v?.exitCode}${v?.timedOut ? ' (timed out)' : ''}`, v?.stdout ? String(v.stdout) : '', v?.stderr ? `stderr:\n${v.stderr}` : ''].filter(Boolean).join('\n'),
        },
      ],
    },
    timeoutMs: settings.timeoutMs + 15_000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => runCli(ctx, settings, args, exec),
  });
}

// --- the plugin ---------------------------------------------------------------------

/**
 * Register the skill, the tools, the gallery routes and the `/archify` command.
 * @param ctx - plugin context.
 * @param {unknown} config - the Loader row's config.
 */
export function apply(ctx, config) {
  const settings = settingsOf(config);
  const dir = join(homeDir(), 'cache', 'archify');
  const store = createStore(dir);

  if (settings.enabled && typeof ctx.tools?.register === 'function') {
    ctx.effect(() => ctx.tools.register(buildRenderTool(ctx, store, settings)));
    ctx.effect(() => ctx.tools.register(buildCliTool(ctx, settings)));
  }

  if (settings.skill && typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (scope) => {
      if (typeof scope.skills?.registerProvider !== 'function') return;
      scope.effect(() => scope.skills.registerProvider(skillProvider()));
    });
  }

  const commands = ctx.get?.('commands');
  if (commands !== undefined && typeof commands?.register === 'function') {
    ctx.effect(() =>
      commands.register({
        name: 'archify',
        description: 'Open the Archify panel: every diagram and explainer page drawn in your conversations',
        handler: () => {
          const n = store.size();
          return { kind: 'success', text: n === 0 ? 'No diagrams yet. Ask for one: "draw the architecture of this repo".' : `${n} page${n > 1 ? 's' : ''} in the Archify panel.` };
        },
      }),
    );
  }

  const mountRoutes = (scope) => {
    const webServer = scope.webServer;
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: (_req, res) => serveJson(res, () => ({ total: store.size(), tools: settings.enabled, upstream: upstream() })),
      }),
    );
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: LIST_ROUTE,
        handler: (req, res) =>
          serveJson(res, () => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
            const page = store.list({ limit, before: url.searchParams.get('before') ?? '' });
            return { ...page, items: page.items.map(publicItem) };
          }),
      }),
    );
    scope.effect(() => webServer.register({ kind: 'prefix', path: FILE_ROUTE, handler: (req, res) => servePage(store, req, res) }));
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: DELETE_ROUTE,
        handler: (req, res) => postJson(req, res, (body) => ({ ok: store.remove(String(body.id ?? '')) })),
      }),
    );
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: OPEN_ROUTE,
        handler: (req, res) =>
          postJson(req, res, async (body) => {
            const item = store.get(String(body.id ?? ''));
            if (!item || !existsSync(item.html)) return { ok: false, reason: 'missing' };
            await openWithSystem(item.html, body.action === 'reveal');
            return { ok: true };
          }),
      }),
    );
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountRoutes);
  else if (ctx.webServer) mountRoutes({ webServer: ctx.webServer, effect: (fn) => ctx.effect(fn) });

  ctx.effect(() => () => store.flush());
}

/** One gallery item as the page sees it. */
function publicItem(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    path: item.html,
    folder: dirname(item.html),
    sessionId: item.sessionId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    gates: item.gates,
    browserSkipped: item.browserSkipped === true,
    bytes: item.bytes,
    version: item.version,
    aspect: item.aspect ?? 0,
    missing: item.missing === true,
    url: `${FILE_ROUTE}/${item.id}`,
  };
}

/**
 * The response headers of one page. The page runs in a sandbox with an opaque
 * origin, embedded or opened on its own: its scripts (the Archify viewer) work,
 * and nothing on it can reach the Harness page or its routes.
 */
export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': 'sandbox allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** Stream one gallery page; `?download=1` saves it. */
function servePage(store, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = decodeURIComponent(url.pathname.slice(FILE_ROUTE.length + 1)).split('/')[0];
  const item = store.get(id);
  let size = 0;
  try {
    if (item?.html) size = statSync(item.html).size;
  } catch {
    size = 0;
  }
  if (!item || size === 0) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('This page is no longer on disk.');
    return;
  }
  res.statusCode = 200;
  for (const [k, v] of Object.entries(PAGE_HEADERS)) res.setHeader(k, v);
  res.setHeader('content-length', String(size));
  if (url.searchParams.get('download') === '1') {
    const name = basename(item.html).replace(/[^\w.\-]+/g, '_') || 'archify.html';
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
  }
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(item.html);
  stream.on('error', () => {
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
  stream.pipe(res);
}

/** Open a file with the default app, or show it in its folder. */
function openWithSystem(path, reveal) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === 'darwin') {
    cmd = 'open';
    args = reveal ? ['-R', path] : [path];
  } else if (platform === 'win32') {
    cmd = reveal ? 'explorer.exe' : 'cmd.exe';
    args = reveal ? [`/select,${path}`] : ['/c', 'start', '""', path];
  } else {
    cmd = 'xdg-open';
    args = [reveal ? dirname(path) : path];
  }
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, () => resolve());
  });
}

/**
 * Answer one state-changing request. Only a JSON POST is taken: a cross-site page
 * cannot send one without a CORS preflight, which these routes never grant.
 */
function postJson(req, res, produce) {
  const type = String(req.headers?.['content-type'] ?? '');
  if (req.method !== 'POST' || !/^application\/json\b/i.test(type)) {
    res.statusCode = req.method === 'POST' ? 415 : 405;
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    serveJson(res, () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return { ok: false, reason: 'bad-request' };
      }
      return produce(body && typeof body === 'object' ? body : {});
    });
  });
}

/** Answer one request as JSON; a thrown handler becomes a stable error body. */
function serveJson(res, produce) {
  Promise.resolve()
    .then(produce)
    .then((body) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    })
    .catch((error) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, reason: error?.message ?? String(error) }));
    });
}

export { CLI, SKILL_ROOT };
