#!/usr/bin/env node
/**
 * Refresh the bundled Archify skill from a checkout of tt-a1i/archify.
 *
 *   node scripts/sync-archify.mjs /path/to/archify-checkout
 *
 * Copies the skill folder (`archify/` in that repository) as Git tracks it at the
 * checkout's HEAD, minus what a packaged skill never reads: its tests, the
 * pre-rendered example pages (~13 MB of HTML the skill only writes, never reads),
 * the generator scripts and the lockfile. License, notice and third-party files
 * are kept as they are. The commit is recorded in `archify/UPSTREAM.json`.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('usage: node scripts/sync-archify.mjs <archify checkout>');
  process.exit(2);
}
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'archify');

const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
const date = git('log', '-1', '--format=%cI');
const version = JSON.parse(execFileSync('git', ['-C', source, 'show', 'HEAD:archify/package.json'], { encoding: 'utf8' })).version;

const dropped = (path) =>
  path.startsWith('archify/test/') ||
  /^archify\/examples\/.*\.html$/.test(path) ||
  path === 'archify/package-lock.json' ||
  path.startsWith('archify/scripts/generate-') ||
  path.split('/').some((segment) => segment === '.DS_Store' || segment === 'node_modules');

const files = git('ls-files', '--', 'archify').split('\n').filter((p) => p && !dropped(p));
rmSync(target, { recursive: true, force: true });
for (const path of files) {
  const to = join(target, path.slice('archify/'.length));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(source, path), to);
}
writeFileSync(
  join(target, 'UPSTREAM.json'),
  `${JSON.stringify({ repository: 'https://github.com/tt-a1i/archify', path: 'archify', commit, date, version, files: files.length }, null, 2)}\n`,
);
console.log(`archify ${version} @ ${commit.slice(0, 7)} (${date}): ${files.length} files`);
