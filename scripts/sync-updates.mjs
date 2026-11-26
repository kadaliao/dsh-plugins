// Writes the shared update reminders (shared/updates.js) into every plugin's client.js and their test
// (shared/updates.test.mjs) into its test/updates.test.mjs. Plugins are the index's @kadaliao/dsh-* entries,
// cloned as dsh-<name> beside this repository (../dsh-<name>) or one folder further up (../../dsh-<name>);
// a folder counts only when its package.json names that plugin, and the nearer one wins.
//
//   node scripts/sync-updates.mjs            write every clone that differs
//   node scripts/sync-updates.mjs --check    only report; exits 1 when a clone differs
//   node scripts/sync-updates.mjs bots       only the dsh-bots clone
//
// A client.js without the block gets it once, right before the module's `return {` and with a call after
// the `ctx.locale.register(...)` line of `apply(ctx)`; check that diff by eye, then wrap the plugin's own
// view in `updates.opens(...)` where it is registered (the bar shows, and the check runs, only there).
// Later runs replace only what lies between the markers.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = '    // >>> kadaliao-dsh-updates';
const END = '    // <<< kadaliao-dsh-updates';
const args = process.argv.slice(2);
// Any other flag (--help, -n, a typo of --check) stops here rather than falling through to a write.
const unknown = args.filter((arg) => arg.startsWith('-') && arg !== '--check');
if (unknown.length > 0) {
  console.error(`unknown option ${unknown.join(' ')}; usage: node scripts/sync-updates.mjs [--check] [name ...]`);
  process.exit(2);
}
const checkOnly = args.includes('--check');
const only = args.filter((arg) => !arg.startsWith('-'));

function cloneOf(name, short) {
  for (const dir of [join(root, '..', `dsh-${short}`), join(root, '..', '..', `dsh-${short}`)]) {
    if (!existsSync(join(dir, 'client.js'))) continue;
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === name) return dir;
    } catch {
      // No readable package.json: not a clone of this plugin.
    }
  }
  return null;
}

const shared = readFileSync(join(root, 'shared', 'updates.js'), 'utf8');
const sharedTest = readFileSync(join(root, 'shared', 'updates.test.mjs'), 'utf8');
const start = shared.indexOf(BEGIN);
const end = shared.indexOf(END);
if (start < 0 || end < start) throw new Error('shared/updates.js lost its markers');
const block = shared.slice(start, end + END.length);

const index = JSON.parse(readFileSync(join(root, 'marketplace.json'), 'utf8'));
const names = index.plugins.map((plugin) => plugin.name).filter((name) => /^@kadaliao\/dsh-/.test(name));

function withBlock(client, name) {
  const at = client.indexOf(BEGIN);
  if (at >= 0) {
    const stop = client.indexOf(END, at);
    if (stop < 0) throw new Error(`${name}: client.js has the opening marker but not the closing one`);
    return client.slice(0, at) + block + client.slice(stop + END.length);
  }
  // First time: the block goes before the module's own `return {`, the call into apply(ctx).
  const exported = client.lastIndexOf('\n    return {\n      inject:');
  if (exported < 0) throw new Error(`${name}: no "    return {\\n      inject:" to put the block before`);
  let next = `${client.slice(0, exported + 1)}${block}\n\n${client.slice(exported + 1)}`;
  const register = /\n(\s+)ctx\.effect\(\(\) => ctx\.locale\.register\(NS, DICTIONARY\)[^\n]*\n/g;
  let match;
  let last = null;
  while ((match = register.exec(next)) !== null) last = match;
  if (last === null) throw new Error(`${name}: no ctx.locale.register(NS, DICTIONARY) line in apply(ctx) to call it after`);
  const indent = last[1];
  const call = `${indent}// This plugin's update reminder, checked when its own view opens (see the block above).\n${indent}const updates = kadaliaoUpdates(ctx, { React, name: '${name}' });\n`;
  const after = last.index + last[0].length;
  next = next.slice(0, after) + call + next.slice(after);
  return next;
}

let differs = 0;
for (const name of names) {
  const short = name.replace('@kadaliao/dsh-', '');
  if (only.length > 0 && !only.includes(short)) continue;
  const dir = cloneOf(name, short);
  if (dir === null) {
    console.log(`${short}: no clone of ${name} at ../dsh-${short} or ../../dsh-${short}, skipped`);
    continue;
  }
  const clientPath = join(dir, 'client.js');
  const testPath = join(dir, 'test', 'updates.test.mjs');
  const client = readFileSync(clientPath, 'utf8');
  const nextClient = withBlock(client, name);
  const test = existsSync(testPath) ? readFileSync(testPath, 'utf8') : null;
  const changed = [nextClient !== client ? 'client.js' : null, test !== sharedTest ? 'test/updates.test.mjs' : null].filter(Boolean);
  if (changed.length === 0) {
    console.log(`${short}: up to date`);
    continue;
  }
  differs += 1;
  if (checkOnly) {
    console.log(`${short}: differs (${changed.join(', ')})`);
    continue;
  }
  writeFileSync(clientPath, nextClient);
  writeFileSync(testPath, sharedTest);
  console.log(`${short}: wrote ${changed.join(', ')}`);
}
if (checkOnly && differs > 0) process.exit(1);
