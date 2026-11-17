/**
 * Run the bundled Archify CLI with the Harness's own JavaScript runtime, so
 * nothing needs Node.js on PATH: `process.execPath` is Node under the CLI and
 * Electron under the desktop app, which `ELECTRON_RUN_AS_NODE` turns into Node.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The bundled skill's root and its CLI. */
export const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'archify');
export const CLI = join(SKILL_ROOT, 'bin', 'archify.mjs');

/** Output kept from one stream, so a runaway command cannot fill the host's memory. */
const MAX_STREAM = 2 * 1024 * 1024;

/**
 * The environment Archify runs in: Node mode, and no update check, since the
 * plugin is what updates this copy (through the plugin market), not the skill.
 */
export function archifyEnv(base = process.env) {
  return { ...base, ELECTRON_RUN_AS_NODE: '1', ARCHIFY_UPDATE_CHECK_DISABLED: '1', NO_COLOR: '1' };
}

/**
 * Run `archify <args…>` in `cwd`.
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, ms: number, timedOut: boolean}>}
 */
export function runArchify(args, { cwd, signal, timeoutMs = 180_000, env, exec = process.execPath, cli = CLI } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(exec, [cli, ...args], { cwd, env: archifyEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout.on('data', (chunk) => {
      if (outBytes < MAX_STREAM) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      if (errBytes < MAX_STREAM) err.push(chunk);
      errBytes += chunk.length;
    });
    let timedOut = false;
    const kill = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(error);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({
        code,
        signal: sig,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: Date.now() - started,
        timedOut,
      });
    });
  });
}

/** The JSON object a `--json` run printed, or null. */
export function parseJsonOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    // Some commands print a line before the JSON; take the last object.
    const at = text.lastIndexOf('\n{');
    if (at >= 0) {
      try {
        return JSON.parse(text.slice(at + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * What a finalize receipt says, for the conversation card and the gallery.
 * `ok` is a delivered page: a pass, or a pass whose browser check was skipped
 * because no Chrome-family browser is installed.
 */
export function outcomeOf(receipt, run) {
  const gates = receipt && typeof receipt.gates === 'object' && receipt.gates ? receipt.gates : {};
  const diagnostics = Array.isArray(receipt?.diagnostics) ? receipt.diagnostics : [];
  const chromeMissing = receipt?.status === 'skipped' && diagnostics.some((d) => d?.code === 'viewer/chrome-unavailable');
  const delivered = gates.deliver === 'pass' && gates.check === 'pass';
  const ok = Boolean(receipt) && (receipt.ok === true || (chromeMissing && delivered));
  return {
    ok,
    status: receipt?.status ?? (run?.timedOut ? 'timeout' : 'error'),
    gates,
    failedStage: receipt?.failedStage ?? '',
    browserSkipped: chromeMissing,
    warnings: diagnostics.filter((d) => d?.severity === 'warning').length,
    errors: diagnostics.filter((d) => d?.severity === 'error').length,
  };
}

/** Cap a model-facing text; long receipts keep their head, which carries the gates and first diagnostics. */
export function clip(text, max = 14_000) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}\n… (${s.length - max} more characters cut; the full receipt is on disk)`;
}
