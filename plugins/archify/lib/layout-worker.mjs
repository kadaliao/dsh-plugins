/**
 * Layout worker, run as its own process by `archify_render`:
 *
 *   <runtime> layout-worker.mjs '{"candidate": "…", "quality": "showcase", "repoRoot": "…"}'
 *
 * Lays the candidate's topology out with each variant of the cascade and checks
 * each with Archify's validation at the requested quality. Writes the passing
 * placement with the fewest crossings and detours into the candidate (or, when
 * none passes, the one with the fewest errors), records it beside the
 * candidate, and prints a JSON summary.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CASCADE, ELK_BUNDLE, applyBoxes, elkGraph, placementKey, sidecarOf, topologyKey, topologyOf } from './autolayout.mjs';
import { CLI, SKILL_ROOT } from './run.mjs';

const started = Date.now();
const job = JSON.parse(process.argv[2] ?? '{}');
const ELK = createRequire(import.meta.url)(ELK_BUNDLE);
const { textUnits } = await import(pathToFileURL(join(SKILL_ROOT, 'renderers', 'shared', 'utils.mjs')).href);

/** Archify's validation of one placed candidate: its error count and codes, and its route tangles. */
function validate(file) {
  const args = [CLI, 'validate', 'architecture', file, '--quality', job.quality === 'standard' ? 'standard' : 'showcase', '--json'];
  if (job.repoRoot) args.push('--repo-root', job.repoRoot);
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: job.cwd || dirname(file), env: process.env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (_error, stdout) => {
      try {
        const receipt = JSON.parse(String(stdout));
        const errors = (receipt.diagnostics ?? []).filter((d) => d?.severity === 'error');
        const m = receipt.composition?.metrics ?? {};
        const tangles = (Number(m.resolvedCrossovers) || 0) + (Number(m.properCrossings) || 0) + (Number(m.routesOverSuggestedBends) || 0);
        resolve({ errors: receipt.ok === true ? 0 : Math.max(1, errors.length), codes: [...new Set(errors.map((d) => String(d.code)))], tangles });
      } catch {
        resolve({ errors: Number.POSITIVE_INFINITY, codes: ['no-receipt'], tangles: Number.POSITIVE_INFINITY });
      }
    });
  });
}

async function main() {
  const original = JSON.parse(readFileSync(job.candidate, 'utf8'));
  const topology = topologyOf(original);
  const scratch = join(dirname(job.candidate), `.layout-try-${process.pid}.json`);
  let best = null;
  let tries = 0;
  const failures = [];
  try {
    for (let i = 0; i < CASCADE.length; i += 1) {
      tries += 1;
      let result;
      try {
        result = applyBoxes(topology, await new ELK().layout(elkGraph(topology, CASCADE[i], textUnits)));
      } catch (error) {
        failures.push(`try ${i + 1}: ${String(error?.message ?? error).slice(0, 200)}`);
        continue;
      }
      writeFileSync(scratch, `${JSON.stringify(result.spec, null, 2)}\n`);
      const check = await validate(scratch);
      const better = !best || check.errors < best.errors || (check.errors === 0 && best.errors === 0 && check.tangles < best.tangles);
      if (better) best = { ...result, ...check, variant: i + 1 };
      if (check.errors === 0 && check.tangles === 0) break;
    }
  } finally {
    rmSync(scratch, { force: true });
  }
  if (!best) return { ok: false, error: failures.join('; ') || 'no layout', ms: Date.now() - started };
  writeFileSync(job.candidate, `${JSON.stringify(best.spec, null, 2)}\n`);
  writeFileSync(sidecarOf(job.candidate), `${JSON.stringify({ topology: topologyKey(best.spec), placement: placementKey(best.spec), variant: best.variant, width: best.width, height: best.height }, null, 2)}\n`);
  return {
    ok: true,
    passed: best.errors === 0,
    variant: best.variant,
    tries,
    width: best.width,
    height: best.height,
    tangles: best.tangles,
    ...(best.errors === 0 ? {} : { codes: best.codes }),
    ms: Date.now() - started,
  };
}

let summary;
try {
  summary = await main();
} catch (error) {
  summary = { ok: false, error: String(error?.message ?? error).slice(0, 400), ms: Date.now() - started };
}
process.stdout.write(`${JSON.stringify(summary)}\n`);
