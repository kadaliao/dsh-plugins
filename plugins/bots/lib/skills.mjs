/**
 * Where a bot's skills come from, besides writing one by hand:
 * - the skills already installed in DeepSeek Harness (~/.agents/skills, ~/.dsh/skills, bundled);
 * - a GitHub folder or repository that holds SKILL.md files (anthropics/skills and the like);
 * - a raw SKILL.md URL.
 * An import copies the whole skill folder under the bots cache, so scripts and
 * references the skill mentions keep working.
 *
 * @module @kadaliao/dsh-bots/lib/skills
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/** Skill collections worth browsing, shown as one-click sources. */
export const SKILL_SOURCES = [
  { id: 'anthropics', repo: 'anthropics/skills', path: 'skills', name: { en: 'Anthropic skills', zh: 'Anthropic 官方技能' }, description: { en: 'Documents, design, web apps, MCP building, brand and comms.', zh: '文档、设计、网页应用、MCP 开发、品牌与内部沟通。' } },
];

/** Split YAML-ish front matter: `name`, `description` (folded or quoted). */
export function parseSkillMd(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  const meta = {};
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
      if (!kv) continue;
      let value = kv[2].trim();
      if (/^[>|][+-]?$/.test(value)) {
        const parts = [];
        while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1])) parts.push(lines[(i += 1)].trim());
        value = parts.join(value.startsWith('>') ? ' ' : '\n').trim();
      } else value = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
      meta[kv[1].toLowerCase()] = value;
    }
  }
  return { name: meta.name ?? '', description: meta.description ?? '', body: m ? src.slice(m[0].length) : src };
}

/**
 * A GitHub location from what a user pastes:
 * `owner/repo`, `owner/repo/path`, `https://github.com/o/r`, `…/tree/<ref>/<path>`, `…/blob/<ref>/<path>/SKILL.md`.
 */
export function parseGithub(input) {
  const raw = String(input ?? '').trim().replace(/\.git$/, '');
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/.exec(raw);
  if (m) return { owner: m[1], repo: m[2], ref: m[3] ?? '', path: (m[4] ?? '').replace(/\/?SKILL\.md$/i, '').replace(/\/$/, '') };
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/.exec(raw);
  if (m && !raw.includes('://')) return { owner: m[1], repo: m[2], ref: '', path: (m[3] ?? '').replace(/\/?SKILL\.md$/i, '').replace(/\/$/, '') };
  return null;
}

const GH_HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-bots' };

async function json(fetchImpl, url, signal) {
  const res = await fetchImpl(url, { headers: GH_HEADERS, signal });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url.replace('https://api.github.com/', '')}`);
  return res.json();
}

/**
 * The skills inside a GitHub location: every folder below `path` that holds a SKILL.md.
 * @returns {Promise<{owner, repo, ref, skills: {name, description, path, files: number}[]}>}
 */
export async function listGithubSkills(location, { fetchImpl = fetch, signal } = {}) {
  const { owner, repo } = location;
  let ref = location.ref;
  if (!ref) ref = (await json(fetchImpl, `https://api.github.com/repos/${owner}/${repo}`, signal)).default_branch;
  const tree = await json(fetchImpl, `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, signal);
  const prefix = location.path ? `${location.path}/` : '';
  const blobs = (tree.tree ?? []).filter((n) => n.type === 'blob' && (prefix === '' || n.path.startsWith(prefix) || n.path === `${location.path}/SKILL.md`));
  const dirs = blobs.filter((n) => /(^|\/)SKILL\.md$/i.test(n.path)).map((n) => dirname(n.path) === '.' ? '' : dirname(n.path));
  const skills = await Promise.all(
    dirs.slice(0, 60).map(async (dir) => {
      const text = await raw(fetchImpl, owner, repo, ref, `${dir ? `${dir}/` : ''}SKILL.md`, signal).catch(() => '');
      const meta = parseSkillMd(text);
      return {
        name: meta.name || dir.split('/').pop() || repo,
        description: meta.description.slice(0, 600),
        path: dir,
        files: blobs.filter((b) => (dir ? b.path.startsWith(`${dir}/`) : true)).length,
      };
    }),
  );
  return { owner, repo, ref, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) };
}

async function raw(fetchImpl, owner, repo, ref, path, signal) {
  const res = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`, { signal });
  if (!res.ok) throw new Error(`could not download ${path} (${res.status})`);
  return res.text();
}

/** Files one imported skill may bring, and their total size. */
const MAX_FILES = 300;
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Copy one skill folder from GitHub into `destRoot/<id>/` and describe it.
 * @returns {Promise<{name, description, content, dir, origin}>}
 */
export async function importGithubSkill({ owner, repo, ref, path }, destRoot, id, { fetchImpl = fetch, signal } = {}) {
  if (!ref) ref = (await json(fetchImpl, `https://api.github.com/repos/${owner}/${repo}`, signal)).default_branch;
  const tree = await json(fetchImpl, `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, signal);
  const prefix = path ? `${path}/` : '';
  const files = (tree.tree ?? []).filter((n) => n.type === 'blob' && n.path.startsWith(prefix) && !n.path.slice(prefix.length).includes('/.'));
  if (!files.some((f) => f.path === `${prefix}SKILL.md`)) throw new Error(`no SKILL.md in ${owner}/${repo}/${path}`);
  if (files.length > MAX_FILES) throw new Error(`the skill has ${files.length} files; at most ${MAX_FILES} can be imported`);
  if (files.reduce((n, f) => n + (f.size ?? 0), 0) > MAX_BYTES) throw new Error('the skill is larger than 20 MB');
  const dir = join(destRoot, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let skillText = '';
  for (const f of files) {
    const rel = f.path.slice(prefix.length);
    const target = normalize(join(dir, rel));
    if (!target.startsWith(dir)) continue;
    const res = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${f.path.split('/').map(encodeURIComponent).join('/')}`, { signal });
    if (!res.ok) throw new Error(`could not download ${f.path} (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    if (rel === 'SKILL.md') skillText = bytes.toString('utf8');
  }
  const meta = parseSkillMd(skillText);
  return {
    name: meta.name || path.split('/').pop() || repo,
    description: meta.description,
    content: meta.body.trim(),
    dir,
    origin: `https://github.com/${owner}/${repo}/tree/${ref}/${path}`,
  };
}

/** A single SKILL.md (or any Markdown) at a URL, without companion files. */
export async function importUrlSkill(url, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`could not download ${url} (${res.status})`);
  const text = await res.text();
  if (text.length > 400_000) throw new Error('the file is larger than 400 KB');
  const meta = parseSkillMd(text);
  const fallback = url.split('/').filter(Boolean).slice(-2, -1)[0] ?? 'skill';
  return { name: meta.name || fallback, description: meta.description, content: meta.body.trim(), origin: url };
}
