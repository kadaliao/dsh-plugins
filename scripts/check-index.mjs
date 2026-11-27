// Checks the basics of marketplace.json before it reaches users: it parses, every plugin has a
// name, an English title and versions, every version's source is npm or a pinned Git commit, and
// relative icons exist. Harness's own parser (@deepseek-ai/dsh-plugin-market-index) is stricter.
//
// Descriptions are Chinese by default: Discover shows `zh` in Chinese and falls back to `en` in every
// other language, so `en` carries the same Chinese text as `zh`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(readFileSync(join(root, 'marketplace.json'), 'utf8'));
const problems = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);

if (index.format !== 1) fail('index', 'format must be 1');
if (!index.title?.en) fail('index', 'missing title.en');
if (index.description && index.description.en !== index.description.zh) fail('index', 'description.en must be the Chinese description.zh');
const names = new Set();
for (const p of index.plugins ?? []) {
  const where = p.name ?? '(unnamed plugin)';
  if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(p.name ?? '')) fail(where, 'name must be a scoped npm package name');
  if (names.has(p.name)) fail(where, 'listed twice');
  names.add(p.name);
  if (!p.title?.en) fail(where, 'missing title.en');
  if (!p.description?.zh) fail(where, 'missing description.zh');
  else if (p.description.en !== p.description.zh) fail(where, 'description.en must be the Chinese description.zh (Chinese by default)');
  if (p.icon?.startsWith('./') && !existsSync(join(root, p.icon))) fail(where, `icon ${p.icon} does not exist`);
  if (!p.versions?.length) fail(where, 'no versions');
  const seen = new Set();
  for (const v of p.versions ?? []) {
    const at = `${where}@${v.version}`;
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v.version ?? '')) fail(at, 'version is not semver');
    if (seen.has(v.version)) fail(at, 'version listed twice');
    seen.add(v.version);
    if (!Number.isInteger(v.publishTimestamp) || v.publishTimestamp < 1.6e9 || v.publishTimestamp > 1e10) fail(at, 'publishTimestamp must be Unix seconds');
    const s = v.source ?? {};
    if (s.type === 'npm') continue;
    if (s.type !== 'git') fail(at, `unknown source type ${s.type}`);
    else {
      if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(s.url ?? '')) fail(at, 'git url must be https://github.com/<owner>/<repo>');
      if (!/^[0-9a-f]{40}$/.test(s.commit ?? '')) fail(at, 'git commit must be 40 hex characters');
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`marketplace.json: ${names.size} plugins, ${index.plugins.reduce((n, p) => n + p.versions.length, 0)} versions`);
