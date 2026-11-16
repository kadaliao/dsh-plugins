/**
 * The bot roster and the message log, as JSON files under the DSH home.
 *
 * `bots.json` holds every bot and the session map; `messages.jsonl` is an
 * append-only timeline of what was said to, by and between bots. Both are
 * re-read when another process changed them.
 *
 * @module @kadaliao/dsh-bots/lib/store
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** Messages kept in the log; past this the file is compacted to the newest. */
export const KEEP_MESSAGES = 5000;
/** Longest text one logged message keeps. */
export const MAX_TEXT = 8000;

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const SERVER_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const SKILL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PALETTE = ['#7c5cff', '#2f80ed', '#00a3a3', '#27ae60', '#f2994a', '#eb5757', '#d6409f', '#9b51e0', '#56ccf2', '#828282'];

/** A short, sortable, unique id. */
export function newId(prefix, now = Date.now()) {
  return `${prefix}-${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** A handle from a display name: lowercase ascii, dashes, or `bot` + digits. */
export function slugify(text, fallback = 'bot') {
  const s = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return s || fallback;
}

const str = (v, max = 100_000) => (typeof v === 'string' ? v.slice(0, max) : '');
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

const PINYIN_BOUNDS = '阿八嚓哒妸发旮哈丌咔垃妈拏噢妑七呥仨他屲夕丫帀';
const PINYIN_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';
let pinyinCollator = null;
/** The pinyin initial of one Han character, by collation against the first character of each letter. */
export function pinyinInitial(ch) {
  try {
    pinyinCollator ??= new Intl.Collator('zh-Hans-u-co-pinyin');
  } catch {
    return '';
  }
  let letter = '';
  for (let i = 0; i < PINYIN_BOUNDS.length; i += 1) {
    if (pinyinCollator.compare(ch, PINYIN_BOUNDS[i]) >= 0) letter = PINYIN_LETTERS[i];
    else break;
  }
  return letter;
}

/**
 * Up to two letters for an avatar: first letters of the first two words
 * ("Data Scout" → DS, "Atlas" → AT), or pinyin initials of a Chinese name
 * ("研究员" → YJ). Other scripts keep their first character.
 */
export function initialsOf(name) {
  const text = String(name ?? '').trim();
  if (text === '') return '?';
  const chars = [...text];
  if (/[\u4e00-\u9fff]/.test(chars[0])) {
    const han = chars.filter((c) => /[\u4e00-\u9fff]/.test(c)).slice(0, 2);
    const letters = han.map((c) => pinyinInitial(c)).join('');
    return letters.length === han.length && letters !== '' ? letters : han.join('');
  }
  const words = text.split(/[\s_\-·.]+/).filter(Boolean);
  const first = (c) => (/[\u4e00-\u9fff]/.test(c) ? pinyinInitial(c) || c : c.toUpperCase());
  if (words.length >= 2) return first([...words[0]][0]) + first([...words[1]][0]);
  const w = [...words[0]];
  if (/^[A-Za-z]/.test(w[0])) {
    // camelCase gives its capitals ("DataBot" → DB); else the first two letters.
    const caps = w.filter((c, i) => i > 0 && /[A-Z]/.test(c));
    return (w[0] + (caps[0] ?? w[1] ?? '')).toUpperCase();
  }
  return w[0];
}

/**
 * An avatar: an uploaded or generated picture, or initials on a colour. Emoji
 * avatars from earlier versions become initials.
 */
function normalizeAvatar(a, seed = 0) {
  const color = typeof a?.color === 'string' && /^#[0-9a-f]{3,8}$|^(rgb|hsl)a?\(/i.test(a.color.trim()) ? a.color.trim().slice(0, 40) : PALETTE[seed % PALETTE.length];
  if (a?.kind === 'image' && typeof a.url === 'string' && a.url.startsWith('/__dsh_bots/avatar/')) return { kind: 'image', url: a.url, color, ...(a.source === 'ai' ? { source: 'ai' } : {}) };
  const text = typeof a?.text === 'string' && a.text.trim() !== '' ? [...a.text.trim()].slice(0, 2).join('').toUpperCase() : '';
  return { kind: 'initials', ...(text ? { text } : {}), color };
}

/**
 * One skill of a bot:
 * - `own`: written for this bot (content kept here);
 * - `dsh`: an installed Harness skill, by name (content read live from DSH);
 * - `import`: copied from GitHub or a URL (`dir` holds the copy), or `linked` to a local
 *   folder (`dir` is that folder, read live).
 */
function normalizeSkill(s) {
  const name = str(s?.name, 80).trim();
  if (name === '') return null;
  const source = ['own', 'dsh', 'import'].includes(s?.source) ? s.source : 'own';
  return {
    id: str(s?.id, 40) || newId('skill'),
    name,
    source,
    description: str(s?.description, 1000).trim(),
    content: source === 'dsh' ? '' : str(s?.content, 200_000),
    enabled: bool(s?.enabled, true),
    ...(source === 'import' && typeof s?.dir === 'string' ? { dir: s.dir } : {}),
    ...(source === 'import' && typeof s?.dir === 'string' && s?.linked === true ? { linked: true } : {}),
    ...(typeof s?.origin === 'string' && s.origin ? { origin: str(s.origin, 500) } : {}),
  };
}

/**
 * Drop the repeats of a skill that is there twice for certain: a Harness skill linked
 * twice by name, or the same import (name and origin) made twice. The first one stays.
 * Same-named skills that differ are kept; the import route and the editor refuse those.
 */
function dedupeSkills(list) {
  const seen = new Set();
  return list.filter((s) => {
    if (s.source === 'own' || (s.source === 'import' && !s.origin)) return true;
    const key = `${s.source}\n${s.name.toLowerCase()}\n${s.source === 'import' ? s.origin : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const kv = (o) => {
  const out = {};
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) if (typeof k === 'string' && k.trim() !== '' && v !== undefined && v !== null) out[k.trim()] = String(v);
  }
  return out;
};

function normalizeApp(a) {
  const template = typeof a?.template === 'string' && /^[a-z0-9-]{1,40}$/.test(a.template) ? a.template : 'mcp-stdio';
  const serverName = str(a?.serverName, 32).trim();
  if (!SERVER_RE.test(serverName)) return null;
  const c = a?.config && typeof a.config === 'object' ? a.config : {};
  const config = {};
  if (typeof c.url === 'string') config.url = str(c.url, 2000).trim();
  if (c.headers) config.headers = kv(c.headers);
  if (typeof c.command === 'string') config.command = str(c.command, 2000).trim();
  if (Array.isArray(c.args)) config.args = c.args.map((x) => String(x)).slice(0, 64);
  if (c.env) config.env = kv(c.env);
  return {
    id: str(a?.id, 40) || newId('app'),
    template,
    name: str(a?.name, 80).trim() || serverName,
    serverName,
    enabled: bool(a?.enabled, true),
    values: kv(a?.values),
    config,
  };
}

/**
 * One bot, normalized: every field present, unknown ones dropped. `prev` is the
 * stored bot an update applies to.
 */
export function normalizeBot(input, prev, seed = 0) {
  const b = { ...(prev ?? {}), ...(input ?? {}) };
  const now = Date.now();
  const name = str(b.name, 60).trim() || prev?.name || 'New bot';
  const skills = dedupeSkills((Array.isArray(b.skills) ? b.skills : []).map(normalizeSkill).filter(Boolean)).slice(0, 50);
  const apps = (Array.isArray(b.apps) ? b.apps : []).map(normalizeApp).filter(Boolean).slice(0, 20);
  const deny = Array.isArray(b.tools?.deny) ? [...new Set(b.tools.deny.map(String).filter(Boolean))].slice(0, 200) : [];
  const model = b.model && typeof b.model === 'object' && str(b.model.provider) && str(b.model.model) ? { provider: str(b.model.provider, 200), model: str(b.model.model, 200) } : null;
  return {
    id: prev?.id ?? (str(b.id, 40) || newId('bot', now)),
    name,
    handle: str(b.handle, 32).trim().toLowerCase(),
    role: b.role === 'primary' ? 'primary' : 'bot',
    avatar: normalizeAvatar(b.avatar, seed),
    bio: str(b.bio, 300).trim(),
    persona: str(b.persona, 20_000),
    skills,
    apps,
    tools: { deny },
    model,
    sessionId: typeof b.sessionId === 'string' && b.sessionId !== '' ? b.sessionId : null,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    createdBy: prev?.createdBy ?? (str(b.createdBy, 60) || 'user'),
    ...(typeof b.team === 'string' && /^[a-z0-9-]{1,40}$/.test(b.team) ? { team: b.team } : {}),
  };
}

/**
 * The store under `dir`.
 * @param {string} dir
 */
export function createStore(dir) {
  const file = join(dir, 'bots.json');
  const log = join(dir, 'messages.jsonl');
  let state = { version: 0, bots: [] };
  let seen = -1;
  let messages = null;
  let logSeen = -1;
  const listeners = new Set();

  const mtime = (p) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return -1;
    }
  };
  function reload() {
    const now = mtime(file);
    if (now === seen) return;
    seen = now;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && Array.isArray(parsed.bots)) state = { version: Number(parsed.version) || 0, bots: parsed.bots.map((b, i) => normalizeBot(b, b, i)).map((b, i) => ({ ...b, updatedAt: parsed.bots[i].updatedAt ?? b.updatedAt })) };
    } catch {
      // First run.
    }
  }
  function write() {
    mkdirSync(dir, { recursive: true });
    state.version += 1;
    const tmp = `${file}.tmp`;
    // Bots carry app keys and chat bot tokens: readable by this user only.
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    seen = mtime(file);
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // A listener must not break a write.
      }
    }
  }
  function readLog() {
    const now = mtime(log);
    if (messages !== null && now === logSeen) return messages;
    logSeen = now;
    messages = [];
    try {
      for (const line of readFileSync(log, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m && typeof m.id === 'string') messages.push(m);
        } catch {
          // Skip a torn line.
        }
      }
    } catch {
      // No log yet.
    }
    return messages;
  }
  reload();

  return {
    dir,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    version() {
      reload();
      return state.version;
    },
    list() {
      reload();
      return state.bots.slice();
    },
    get(id) {
      reload();
      return state.bots.find((b) => b.id === id);
    },
    /** By id, `@handle`, handle or (case-insensitive) display name. */
    find(ref) {
      reload();
      const r = String(ref ?? '').trim().replace(/^@/, '');
      if (r === '') return undefined;
      const lower = r.toLowerCase();
      return state.bots.find((b) => b.id === r) ?? state.bots.find((b) => b.handle === lower) ?? state.bots.find((b) => b.name.toLowerCase() === lower);
    },
    bySession(sessionId) {
      reload();
      return sessionId ? state.bots.find((b) => b.sessionId === sessionId) : undefined;
    },
    primary() {
      reload();
      return state.bots.find((b) => b.role === 'primary');
    },
    /** Create or update; returns the stored bot. Throws a readable error on a bad value. */
    save(input, { createdBy } = {}) {
      reload();
      const prev = input?.id ? state.bots.find((b) => b.id === input.id) : undefined;
      if (input?.id && !prev) throw new Error(`no bot with id ${input.id}`);
      const bot = normalizeBot({ ...input, ...(prev ? {} : { createdBy: createdBy ?? input?.createdBy }) }, prev, state.bots.length);
      if (bot.handle === '') bot.handle = slugify(bot.name);
      if (!HANDLE_RE.test(bot.handle)) throw new Error(`handle "${bot.handle}" must be lowercase letters, digits and dashes`);
      if (!prev && state.bots.some((b) => b.handle === bot.handle)) {
        // A fresh bot whose name collides gets a numbered handle when the caller left it out.
        if (input?.handle) throw new Error(`handle @${bot.handle} is taken`);
        let n = 2;
        while (state.bots.some((b) => b.handle === `${bot.handle}-${n}`)) n += 1;
        bot.handle = `${bot.handle}-${n}`;
      } else if (state.bots.some((b) => b.handle === bot.handle && b.id !== bot.id)) {
        throw new Error(`handle @${bot.handle} is taken`);
      }
      const names = new Set();
      for (const app of bot.apps) {
        if (names.has(app.serverName)) throw new Error(`two apps share the server name "${app.serverName}"`);
        names.add(app.serverName);
      }
      if (bot.role === 'primary') for (const b of state.bots) if (b.id !== bot.id && b.role === 'primary') b.role = 'bot';
      if (prev) state.bots[state.bots.indexOf(prev)] = bot;
      else state.bots.push(bot);
      if (!state.bots.some((b) => b.role === 'primary')) state.bots[0].role = 'primary';
      write();
      return bot;
    },
    /** Set fields without normalizing the rest (session ids, avatar urls). */
    patch(id, fields) {
      reload();
      const bot = state.bots.find((b) => b.id === id);
      if (!bot) return undefined;
      Object.assign(bot, fields, { updatedAt: Date.now() });
      write();
      return bot;
    },
    setPrimary(id) {
      reload();
      if (!state.bots.some((b) => b.id === id)) return false;
      for (const b of state.bots) b.role = b.id === id ? 'primary' : 'bot';
      write();
      return true;
    },
    remove(id) {
      reload();
      const at = state.bots.findIndex((b) => b.id === id);
      if (at === -1) return undefined;
      const [gone] = state.bots.splice(at, 1);
      if (gone.role === 'primary' && state.bots.length > 0) state.bots[0].role = 'primary';
      write();
      return gone;
    },
    /** Append one message to the timeline. */
    log(message) {
      const m = {
        id: newId('msg'),
        at: Date.now(),
        kind: 'dm',
        ...message,
        text: String(message.text ?? '').slice(0, MAX_TEXT),
      };
      const all = readLog();
      all.push(m);
      try {
        mkdirSync(dir, { recursive: true });
        if (all.length > KEEP_MESSAGES * 1.2) {
          messages = all.slice(-KEEP_MESSAGES);
          writeFileSync(log, messages.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
        } else {
          appendFileSync(log, JSON.stringify(m) + '\n', 'utf8');
        }
        logSeen = mtime(log);
      } catch {
        // The timeline is a convenience.
      }
      return m;
    },
    /** Oldest first; `bot` limits to messages from or to that bot. */
    messages({ bot = '', limit = 200 } = {}) {
      const all = readLog();
      const rows = bot ? all.filter((m) => m.from === bot || m.to === bot) : all;
      return rows.slice(-Math.max(1, Math.min(2000, limit)));
    },
    messageCount() {
      return readLog().length;
    },
  };
}
