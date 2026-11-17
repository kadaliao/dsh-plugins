/**
 * Bot memory: what a bot keeps across conversations and topics.
 *
 * - **Notes**: short durable facts, one sentence each. Every bot has its own;
 *   the team shares one more list every bot reads. Notes are written by the
 *   bot itself (`memory_save`), by the user in the panel, after every task by
 *   a reflection pass, and rewritten once a day by consolidation ("dreaming").
 * - **Journal**: one line per finished task — what was asked and what came of
 *   it — so a bot knows what it did yesterday after its conversation moved on.
 * - **Digests**: once a day the team's journal is written up as a short
 *   digest every bot reads the latest of.
 *
 * Files under `<bots cache>/memory/`: `notes.json` ({bots: {botId: Note[]}, team: Note[]}),
 * `journal.jsonl`, `digests.json`, `dream.json`.
 *
 * The prompt builders and reply parsers here are pure; the model calls are the Host's.
 *
 * @module @kadaliao/dsh-bots/lib/memory
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const KINDS = ['fact', 'preference', 'person', 'project', 'procedure', 'lesson'];
export const MAX_NOTE = 400;
export const BOT_CAP = 150;
export const TEAM_CAP = 100;
/** What the prompt shows at most, in characters. */
export const PROMPT_BUDGET = { bot: 6000, team: 4000, journal: 6, digest: 1500 };
const KEEP_JOURNAL = 20_000;
const KEEP_DIGESTS = 90;

/** Text that looks like a credential is never stored. */
const SECRET = /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
export const looksSecret = (text) => SECRET.test(String(text ?? ''));

const clean = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NOTE);
/** Two notes say the same when their letters and digits match. */
const same = (a, b) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function normalizeNote(n, prefix) {
  const text = clean(n?.text);
  if (!text) return null;
  const at = Number(n?.at) || Date.now();
  return {
    id: typeof n?.id === 'string' && n.id ? n.id.slice(0, 40) : newId(prefix),
    text,
    kind: KINDS.includes(n?.kind) ? n.kind : 'fact',
    ...(n?.pinned === true ? { pinned: true } : {}),
    source: ['auto', 'tool', 'user', 'dream'].includes(n?.source) ? n.source : 'user',
    at,
    updated: Number(n?.updated) || at,
  };
}

/**
 * Model output → edits: `{op:'add', text, kind?}`, `{op:'update', id, text}`,
 * `{op:'remove', id}`, `{op:'merge', ids, text}`. Anything else is dropped.
 */
export function normalizeOps(list) {
  const out = [];
  for (const o of Array.isArray(list) ? list.slice(0, 60) : []) {
    if (!o || typeof o !== 'object') continue;
    const op = String(o.op ?? (o.id ? 'update' : 'add')).toLowerCase();
    const text = clean(o.text);
    if (op === 'add' && text) out.push({ op, text, ...(KINDS.includes(o.kind) ? { kind: o.kind } : {}) });
    else if (op === 'update' && typeof o.id === 'string' && text) out.push({ op, id: o.id, text, ...(KINDS.includes(o.kind) ? { kind: o.kind } : {}) });
    else if ((op === 'remove' || op === 'delete' || op === 'forget') && typeof o.id === 'string') out.push({ op: 'remove', id: o.id });
    else if (op === 'merge' && Array.isArray(o.ids) && o.ids.length > 0 && text) out.push({ op, ids: o.ids.map(String).slice(0, 20), text, ...(KINDS.includes(o.kind) ? { kind: o.kind } : {}) });
  }
  return out;
}

/**
 * Apply edits to a note list. Pinned notes are never removed or merged away by
 * `auto`/`dream` edits; a note that would repeat another refreshes it instead.
 * @returns {{notes: object[], added: number, updated: number, removed: number}}
 */
export function applyOps(notes, ops, { source = 'auto', prefix = 'n', cap = BOT_CAP, now = Date.now() } = {}) {
  let list = notes.slice();
  let added = 0;
  let updated = 0;
  let removed = 0;
  /** Ids of the notes an edit added, refreshed or changed, in order. */
  const touched = [];
  // Only the user changes a pinned note; the machine and the bot leave it alone.
  const protectedNote = (n) => n.pinned && source !== 'user';
  for (const o of ops) {
    if ((o.text && looksSecret(o.text)) || (o.op === 'add' && !o.text)) continue;
    if (o.op === 'add') {
      const dup = list.find((n) => same(n.text, o.text));
      if (dup) {
        dup.updated = now;
        touched.push(dup.id);
        continue;
      }
      const id = newId(prefix);
      list.push({ id, text: o.text, kind: o.kind ?? 'fact', source, at: now, updated: now });
      touched.push(id);
      added += 1;
    } else if (o.op === 'update') {
      const n = list.find((x) => x.id === o.id);
      if (!n) continue;
      if (protectedNote(n)) continue;
      n.text = o.text;
      if (o.kind) n.kind = o.kind;
      n.updated = now;
      touched.push(n.id);
      updated += 1;
    } else if (o.op === 'remove') {
      const n = list.find((x) => x.id === o.id);
      if (!n || protectedNote(n)) continue;
      list = list.filter((x) => x !== n);
      removed += 1;
    } else if (o.op === 'merge') {
      const parts = list.filter((x) => o.ids.includes(x.id) && !protectedNote(x));
      if (parts.length === 0) continue;
      const keep = parts[0];
      keep.text = o.text;
      if (o.kind) keep.kind = o.kind;
      keep.updated = now;
      keep.source = source === 'dream' ? 'dream' : keep.source;
      list = list.filter((x) => !parts.includes(x) || x === keep);
      touched.push(keep.id);
      removed += parts.length - 1;
      updated += 1;
    }
  }
  // Over the cap: the oldest unpinned notes the machine wrote go first, then the oldest unpinned.
  while (list.length > cap) {
    const pool = list.filter((n) => !n.pinned);
    if (pool.length === 0) break;
    const auto = pool.filter((n) => n.source === 'auto' || n.source === 'dream');
    const victim = (auto.length ? auto : pool).reduce((a, b) => (a.updated <= b.updated ? a : b));
    list = list.filter((n) => n !== victim);
    removed += 1;
  }
  return { notes: list, added, updated, removed, touched: touched.filter((id) => list.some((n) => n.id === id)) };
}

/** The first JSON object in a model's answer (code fences and prose around it allowed). */
export function parseJsonReply(text) {
  const s = String(text ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < body.length; i += 1) {
    const c = body[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const day = (ms, tz) => new Date(ms + tz * 60_000).toISOString().slice(0, 10);
const stamp = (ms, tz) => new Date(ms + tz * 60_000).toISOString().slice(5, 16).replace('T', ' ');
const listNotes = (notes, budget) => {
  const sorted = notes.slice().sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updated - a.updated);
  const lines = [];
  let used = 0;
  for (const n of sorted) {
    const line = `- [${n.id}] ${n.text}`;
    if (used + line.length > budget && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { lines, hidden: sorted.length - lines.length };
};

/**
 * The memory section of one bot's system prompt.
 * @param {{bot: object, notes: object[], team: object[], journal: object[], digest?: {date, text}|null, tz?: number}} m
 */
export function memoryText({ bot, notes, team, journal, digest, tz = 0 }) {
  const out = [
    '## Your memory',
    'You keep long-term memory across conversations: a new topic starts a fresh conversation, but these notes, your recent work and the team digest stay. After every task a summary of it is saved by itself.',
    '- `memory_save` (scope "self" or "team") when the user tells you to remember something, or you learn a lasting fact, preference, decision or lesson. Give `replace_id` when it corrects a note below. Use "team" only for what every bot should know (about the user, the business, shared conventions).',
    '- `memory_forget` removes a note that is wrong or no longer true. `memory_search` looks through your notes and the team journal when the user refers to earlier work you cannot see.',
    '- Never store secrets (keys, passwords, tokens).',
  ];
  const own = listNotes(notes, PROMPT_BUDGET.bot);
  out.push('', `### What you remember${own.hidden ? ` (newest ${own.lines.length} of ${notes.length}; memory_search finds the rest)` : ''}`);
  out.push(...(own.lines.length ? own.lines : ['(nothing yet)']));
  const shared = listNotes(team, PROMPT_BUDGET.team);
  if (shared.lines.length) out.push('', `### Team memory (shared by every bot)${shared.hidden ? ` (newest ${shared.lines.length} of ${team.length})` : ''}`, ...shared.lines);
  const recent = journal.slice(-PROMPT_BUDGET.journal);
  if (recent.length) {
    out.push('', '### Your recent work');
    for (const j of recent) out.push(`- ${stamp(j.at, tz)} · ${clean(j.summary || j.title).slice(0, 240)}`);
  }
  if (digest?.text) out.push('', `### Latest team digest (${digest.date})`, String(digest.text).trim().slice(0, PROMPT_BUDGET.digest));
  void bot;
  return out.join('\n');
}

// --- prompts for the model -----------------------------------------------------------------

const opsSpec = [
  'Edits are objects in a list:',
  '- {"op":"add","text":"…","kind":"fact|preference|person|project|procedure|lesson"}',
  '- {"op":"update","id":"<id>","text":"…"} — a note that changed or was wrong',
  '- {"op":"remove","id":"<id>"} — a note that is no longer true',
  '- {"op":"merge","ids":["<id>","<id>"],"text":"…"} — notes that say the same thing',
  'Each note is one self-contained sentence of at most 200 characters, written in the language the user uses with the bots (Chinese stays Chinese). Never store secrets (keys, passwords, tokens), one-off details or anything already in memory.',
].join('\n');

const notesBlock = (notes) => (notes.length ? notes.map((n) => `[${n.id}]${n.pinned ? ' (pinned)' : ''} ${n.text}`).join('\n') : '(none)');

/** Shorten a transcript to its head and tail. */
export function clip(text, max = 12_000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.3);
  return `${s.slice(0, head)}\n…(${s.length - max} characters left out)…\n${s.slice(s.length - (max - head))}`;
}

/** After a task: summarize it and update the bot's notes (and propose team notes). */
export function reflectionPrompt({ bot, notes, team, transcript, trigger }) {
  return {
    system: [
      `You keep the long-term memory of ${bot.name} (@${bot.handle}), one of the user's AI bots${bot.bio ? ` — ${bot.bio}` : ''}.`,
      'You are given a task the bot just finished and its current notes. Answer with one JSON object and nothing else:',
      '{"summary": "<one or two sentences: what was asked and what came of it, with names, numbers and links that matter>", "notes": [<edits to the bot\'s own notes>], "team": [<edits to the team notes>]}',
      '',
      opsSpec,
      'Save only what will still matter in a week: stable preferences and facts about the user, people, projects and decisions; procedures that worked; lessons from mistakes. Most tasks need no note at all — then answer with empty lists. Team notes are only for what every bot should know.',
    ].join('\n'),
    user: [`# The bot's notes\n${notesBlock(notes)}`, `# Team notes\n${notesBlock(team)}`, `# The task (${trigger})\n${clip(transcript)}`].join('\n\n'),
  };
}

/**
 * Tickets (tasks) whose title or one of whose reports contains every word of
 * `query` (case-insensitive, as `search` matches notes), most recently changed
 * first. A title hit wins over a report hit; a report hit carries the newest
 * matching report's status and a short snippet around the first word.
 * @param {string} query
 * @param {object[]} tickets - tickets in the shape of docs/PLAN-0.8.md §10
 * @param {{limit?: number}} [opts]
 * @returns {Array<{ticket: object, where: 'title'|'report', status?: string, snippet?: string}>}
 */
export function searchTickets(query, tickets, { limit = 10 } = {}) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hit = (text) => {
    const s = String(text ?? '').toLowerCase();
    return words.every((w) => s.includes(w));
  };
  const snippet = (text) => {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    const at = Math.max(0, s.toLowerCase().indexOf(words[0]) - 60);
    const cut = s.slice(at, at + 200);
    return `${at > 0 ? '…' : ''}${cut}${at + 200 < s.length ? '…' : ''}`;
  };
  const out = [];
  for (const t of [...(tickets ?? [])].sort((a, b) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0))) {
    if (!t?.id) continue;
    if (hit(t.title)) {
      out.push({ ticket: t, where: 'title' });
    } else {
      const report = [...(Array.isArray(t.reports) ? t.reports : [])].reverse().find((r) => hit(r?.text));
      if (report) out.push({ ticket: t, where: 'report', status: report.status, snippet: snippet(report.text) });
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** Once a day per bot: tidy the notes with the last days of its journal. */
export function dreamBotPrompt({ bot, notes, journal, tz = 0 }) {
  return {
    system: [
      `You consolidate the long-term memory of ${bot.name} (@${bot.handle}), one of the user's AI bots${bot.bio ? ` — ${bot.bio}` : ''}, as it sleeps.`,
      'Merge notes that repeat each other, fix ones the journal shows are outdated, drop one-off or trivial notes, and add durable lessons or facts the journal reveals that are missing. Keep pinned notes as they are. Keep the list short and useful (well under 80 notes).',
      'Answer with one JSON object and nothing else: {"notes": [<edits>]}',
      '',
      opsSpec,
    ].join('\n'),
    user: [`# Notes\n${notesBlock(notes)}`, `# Journal of recent tasks\n${clip(journal.map((j) => `${stamp(j.at, tz)} ${j.summary || j.title}`).join('\n'), 14_000) || '(none)'}`].join('\n\n'),
  };
}

/** Once a day for the team: a digest of what every bot did, and the shared notes tidied. */
export function dreamTeamPrompt({ bots, team, journal, date, tz = 0 }) {
  const name = (id) => {
    const b = bots.find((x) => x.id === id);
    return b ? `@${b.handle}` : 'a removed bot';
  };
  return {
    system: [
      "You keep the shared memory of the user's team of AI bots.",
      `Write the team's digest for ${date}: what was done (by whom), results worth remembering, what is still open or blocked, and what comes next — in Markdown, at most 1000 characters, in the language the user uses with the bots. Then tidy the shared team notes: merge repeats, drop outdated ones, add facts every bot should know that the journal shows.`,
      'Answer with one JSON object and nothing else: {"digest": "…", "team": [<edits>]}',
      '',
      opsSpec,
    ].join('\n'),
    user: [
      `# Team: ${bots.map((b) => `@${b.handle} (${b.name})`).join(', ')}`,
      `# Team notes\n${notesBlock(team)}`,
      `# Journal for ${date}\n${clip(journal.map((j) => `${stamp(j.at, tz)} ${name(j.bot)}: ${j.summary || j.title}`).join('\n'), 16_000) || '(nothing happened)'}`,
    ].join('\n\n'),
  };
}

// --- the store ----------------------------------------------------------------------------

/** The memory files under `dir`. */
export function createMemory(dir) {
  const notesFile = join(dir, 'notes.json');
  const journalFile = join(dir, 'journal.jsonl');
  const digestsFile = join(dir, 'digests.json');
  const dreamFile = join(dir, 'dream.json');
  let state = { bots: {}, team: [] };
  let seen = -2;
  let journal = null;
  let journalSeen = -2;
  const listeners = new Set();
  const mtime = (p) => {
    try {
      const s = statSync(p);
      return s.mtimeMs * 1e6 + s.size;
    } catch {
      return -1;
    }
  };
  const readJson = (p, d) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return d;
    }
  };
  const writeJson = (p, v) => {
    mkdirSync(dir, { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(v, null, 1), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, p);
  };
  function reload() {
    const now = mtime(notesFile);
    if (now === seen) return;
    seen = now;
    const raw = readJson(notesFile, {});
    const bots = {};
    for (const [id, list] of Object.entries(raw?.bots ?? {})) bots[id] = (Array.isArray(list) ? list : []).map((n) => normalizeNote(n, 'n')).filter(Boolean);
    state = { bots, team: (Array.isArray(raw?.team) ? raw.team : []).map((n) => normalizeNote(n, 't')).filter(Boolean) };
  }
  function save() {
    writeJson(notesFile, state);
    seen = mtime(notesFile);
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // A listener never breaks a write.
      }
    }
  }
  const listOf = (scope) => (scope === 'team' ? state.team : (state.bots[scope] ??= []));
  const setList = (scope, list) => {
    if (scope === 'team') state.team = list;
    else state.bots[scope] = list;
  };
  function readJournal() {
    const now = mtime(journalFile);
    if (journal && now === journalSeen) return journal;
    journalSeen = now;
    journal = [];
    try {
      for (const line of readFileSync(journalFile, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          journal.push(JSON.parse(line));
        } catch {
          // A torn line.
        }
      }
    } catch {
      // None yet.
    }
    return journal;
  }

  return {
    dir,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Notes of a bot (its id) or of the team ('team'). */
    notes(scope) {
      reload();
      return listOf(scope).map((n) => ({ ...n }));
    },
    /** Apply edits; returns {added, updated, removed}. */
    edit(scope, ops, options = {}) {
      reload();
      const r = applyOps(listOf(scope), normalizeOps(ops), { prefix: scope === 'team' ? 't' : 'n', cap: scope === 'team' ? TEAM_CAP : BOT_CAP, ...options });
      setList(scope, r.notes);
      if (r.added + r.updated + r.removed > 0 || ops.length) save();
      return { added: r.added, updated: r.updated, removed: r.removed, touched: r.touched };
    },
    /** One note as the user wrote it in the panel (add when no id), or its pin. */
    put(scope, note) {
      reload();
      const list = listOf(scope);
      const text = clean(note.text);
      if (looksSecret(text)) throw new Error('that looks like a secret; memory never stores keys, passwords or tokens');
      const existing = note.id ? list.find((n) => n.id === note.id) : null;
      if (note.id && !existing) throw new Error('no such note');
      if (existing) {
        if (text) existing.text = text;
        if (KINDS.includes(note.kind)) existing.kind = note.kind;
        if (typeof note.pinned === 'boolean') {
          if (note.pinned) existing.pinned = true;
          else delete existing.pinned;
        }
        existing.updated = Date.now();
        save();
        return { ...existing };
      }
      if (!text) throw new Error('write the note first');
      const n = normalizeNote({ text, kind: note.kind, pinned: note.pinned === true, source: note.source ?? 'user' }, scope === 'team' ? 't' : 'n');
      const dup = list.find((x) => same(x.text, n.text));
      if (dup) return { ...dup };
      list.push(n);
      if (list.length > (scope === 'team' ? TEAM_CAP : BOT_CAP)) setList(scope, applyOps(list, [], { cap: scope === 'team' ? TEAM_CAP : BOT_CAP }).notes);
      save();
      return { ...n };
    },
    remove(scope, id) {
      reload();
      const list = listOf(scope);
      const next = list.filter((n) => n.id !== id);
      if (next.length === list.length) return false;
      setList(scope, next);
      save();
      return true;
    },
    /** Forget everything a removed bot kept (its journal lines stay for the team digest). */
    dropBot(botId) {
      reload();
      if (!state.bots[botId]) return;
      delete state.bots[botId];
      save();
    },
    addJournal(entry) {
      const row = { id: newId('j'), at: Date.now(), ...entry, summary: clean(entry.summary).slice(0, 400), title: clean(entry.title).slice(0, 200) };
      const all = readJournal();
      all.push(row);
      try {
        mkdirSync(dir, { recursive: true });
        if (all.length > KEEP_JOURNAL * 1.2) {
          journal = all.slice(-KEEP_JOURNAL);
          writeFileSync(journalFile, journal.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
        } else appendFileSync(journalFile, JSON.stringify(row) + '\n', 'utf8');
        journalSeen = mtime(journalFile);
      } catch {
        // A lost line.
      }
      for (const fn of listeners) {
        try {
          fn();
        } catch {
          // Ignored.
        }
      }
      return row;
    },
    /** Journal lines, oldest first: of one bot (`bot`), since a time, at most `limit`. */
    journal({ bot = '', since = 0, until = Infinity, limit = 200 } = {}) {
      const rows = readJournal().filter((j) => (!bot || j.bot === bot) && j.at >= since && j.at < until);
      return rows.slice(-Math.max(1, limit));
    },
    digests() {
      const d = readJson(digestsFile, []);
      return Array.isArray(d) ? d : [];
    },
    addDigest(digest) {
      const all = this.digests().filter((d) => d.date !== digest.date);
      all.push({ date: digest.date, text: String(digest.text ?? '').trim().slice(0, 4000), at: Date.now() });
      all.sort((a, b) => a.date.localeCompare(b.date));
      writeJson(digestsFile, all.slice(-KEEP_DIGESTS));
      return all[all.length - 1];
    },
    dreamState() {
      return readJson(dreamFile, {});
    },
    setDreamState(v) {
      writeJson(dreamFile, v);
    },
    /** Notes and journal lines that contain every word of `query` (case-insensitive), newest first. */
    search(query, { bot = '', limit = 20 } = {}) {
      reload();
      const words = String(query ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const hit = (text) => {
        const s = String(text ?? '').toLowerCase();
        return words.length > 0 && words.every((w) => s.includes(w));
      };
      const notes = [...(bot ? (state.bots[bot] ?? []).map((n) => ({ scope: 'self', ...n })) : []), ...state.team.map((n) => ({ scope: 'team', ...n }))].filter((n) => hit(n.text));
      const lines = readJournal()
        .filter((j) => hit(`${j.title} ${j.summary}`))
        .slice(-limit)
        .reverse();
      const digests = this.digests()
        .filter((d) => hit(d.text))
        .slice(-5)
        .reverse();
      return { notes: notes.slice(0, limit), journal: lines, digests };
    },
    /** The prompt section of `bot`. */
    promptFor(bot, { tz = 0 } = {}) {
      reload();
      const digests = this.digests();
      return memoryText({ bot, notes: state.bots[bot.id] ?? [], team: state.team, journal: this.journal({ bot: bot.id, limit: PROMPT_BUDGET.journal }), digest: digests[digests.length - 1] ?? null, tz });
    },
    /** Local date (YYYY-MM-DD) in zone offset `tz` minutes. */
    dayOf: (ms, tz = 0) => day(ms, tz),
  };
}
