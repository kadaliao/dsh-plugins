/**
 * Where one rendering lives: the Skill's own convention, a folder per request
 * under the working directory, `.archify/<type>-<slug>-<YYYYMMDD-HHMMSS>/`,
 * holding the candidate and `<slug>.html`. A repair names the same candidate
 * and lands on the same page.
 */

import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const NATIVE_TYPES = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle', 'erd', 'tree', 'class', 'timeline', 'waterfall'];
export const TYPES = [...NATIVE_TYPES, 'explainer'];

/** `My Checkout Flow!` → `my-checkout-flow`; '' when nothing Latin is left. */
export function slugify(text, max = 48) {
  const s = String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/, '');
}

/** Local time as `YYYYMMDD-HHMMSS`. */
export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** A path the model gave: `~/…`, absolute, or relative to the working directory. */
export function resolveFrom(cwd, path) {
  const p = String(path ?? '').trim();
  if (p === '') return '';
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** The file name a candidate of this type gets. */
export function candidateName(type) {
  return type === 'explainer' ? 'candidate.archify.md' : 'candidate.json';
}

const FOLDER_RE = /^([a-z]+)-(.+)-(\d{8}-\d{6})$/;

/**
 * The candidate and page paths of one call.
 * @param {object} o
 * @param {string} o.cwd - the session's working directory.
 * @param {string} o.type - diagram type.
 * @param {string} [o.candidate] - the candidate the model named, if any.
 * @param {string} [o.output] - the page path the model named, if any.
 * @param {string} [o.name] - a short name for a new folder.
 * @param {string} [o.title] - the diagram's title, the name's fallback.
 * @param {Date} [o.now]
 */
export function planPaths({ cwd, type, candidate, output, name, title, now = new Date() }) {
  const named = resolveFrom(cwd, candidate);
  if (named !== '') {
    const folder = dirname(named);
    const stem = basename(named).replace(/\.(archify\.md|json|md)$/i, '');
    // `<folder>/candidate.json` → the folder's slug; `x/orders.erd.json` → `orders.erd.html`.
    const m = FOLDER_RE.exec(basename(folder));
    const slug = m ? m[2] : /^candidate$/i.test(stem) ? slugify(basename(folder)) || type : stem;
    const page = resolveFrom(cwd, output) || join(folder, `${slug}.html`);
    return { folder, candidate: named, output: page, slug, created: false };
  }
  const slug = slugify(name) || slugify(title) || 'diagram';
  const folder = join(cwd, '.archify', `${type}-${slug}-${stamp(now)}`);
  return {
    folder,
    candidate: join(folder, candidateName(type)),
    output: resolveFrom(cwd, output) || join(folder, `${slug}.html`),
    slug,
    created: true,
  };
}

/** The title a candidate carries: `meta.title` for JSON, the first `# ` heading for an explainer. */
export function titleOf(type, text) {
  if (type === 'explainer') {
    const m = /^#\s+(.+?)\s*(\{#[^}]*\})?\s*$/m.exec(String(text ?? ''));
    return m ? m[1].trim() : '';
  }
  try {
    const spec = typeof text === 'string' ? JSON.parse(text) : text;
    const t = spec?.meta?.title;
    return typeof t === 'string' ? t.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Whether `meta.output` is a plain relative `.html` path Archify accepts: no
 * absolute or drive path, backslash, `.`/`..` step or empty step.
 */
export function portableOutput(value) {
  if (typeof value !== 'string' || !/\.html?$/i.test(value)) return false;
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((step) => step !== '' && step !== '.' && step !== '..');
}

/**
 * A native diagram's spec with `meta.output` set to `name` when the model left
 * it out or wrote one Archify rejects: the tool decides where the page goes,
 * so the field only has to pass the schema. Returns the same object otherwise.
 */
export function withOutput(spec, name) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const meta = spec.meta && typeof spec.meta === 'object' && !Array.isArray(spec.meta) ? spec.meta : null;
  if (!meta || portableOutput(meta.output)) return spec;
  return { ...spec, meta: { ...meta, output: name } };
}
