/**
 * What a bot is doing right now, for the panel's live status: per Session (a
 * bot's home, a task's), from its `session/event`s. The tool being run with a
 * short summary of its arguments (a command's first line, a file's name, a
 * search's words, the bot work goes to), "thinking" between steps, the step
 * count, and when the turn and the current step began. Tool results are never
 * read; summaries are clipped and scrubbed of anything that looks like a secret.
 *
 * @module @kadaliao/dsh-bots/lib/activity
 */

import { redact } from './channels.mjs';

/** The longest summary of a tool's arguments. */
export const DETAIL_MAX = 80;

/** A call's arguments as an object: Harness's raw JSON string, or an object already. */
export function argsOf(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(String(raw ?? ''));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Text bound for the page with secrets taken out: the channel tokens it knows (`secrets`), the
 * shapes of common keys and tokens, and the value of anything named like a key, token, secret or
 * password (`API_KEY=…`, `--token …`, `Authorization: Bearer …`).
 */
export function scrub(text, secrets = []) {
  return redact(String(text ?? ''), secrets)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 <redacted>')
    // `NAME=value`, `name: value`, or a flag and its value (`--token abc`); a plain word before a space is no name.
    .replace(/(^|[\s"'`;&|(,{])(-{0,2}[A-Za-z0-9_.-]*?(?:key|token|secret|passw(?:or)?d|pwd|credentials?|auth(?:orization)?)["']?)(\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|[^\s"'`;&|),}]+)/gi, (all, pre, name, sep, value) =>
      value === '<redacted>' || (!/[=:]/.test(sep) && !name.startsWith('-')) ? all : `${pre}${name}${sep}<redacted>`,
    )
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '<redacted>')
    .replace(/\b(?:gh[pousr]|github_pat|glpat|xox[abprs])[_-][A-Za-z0-9_-]{10,}/g, '<redacted>')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, '<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1<redacted>@');
}

/** `text` on one line, at most `max` characters (an ellipsis marks a cut). */
export function clipLine(text, max = DETAIL_MAX) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return [...s].length > max ? `${[...s].slice(0, max - 1).join('').trimEnd()}…` : s;
}

const first = (args, keys) => {
  for (const k of keys) {
    const v = args?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};
const baseName = (path) => String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(path);
const firstLine = (text) => (String(text).split('\n').find((l) => l.trim() !== '') ?? '').trim();
function hostPath(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return String(url);
  }
}

/** Tool names (or their last `__` part, for an MCP tool) by what the panel says they do. */
const SHELL = new Set(['bash', 'pwsh', 'shell', 'sh', 'terminal', 'exec', 'run_command', 'execute_command']);
const READ = new Set(['read', 'read_file', 'read_image', 'view', 'open_file', 'cat']);
const EDIT = new Set(['edit', 'str_replace', 'str_replace_editor', 'str_replace_based_edit_tool', 'multi_edit', 'multiedit', 'apply_patch', 'patch', 'notebook_edit']);
const WRITE = new Set(['write', 'write_file', 'create_file']);
const FIND = new Set(['grep', 'glob', 'ls', 'find', 'search_files', 'list_files', 'list_directory', 'ripgrep']);
const SEARCH = new Set(['web_search', 'search', 'websearch', 'tavily_search', 'exa_search', 'brave_search', 'google_search']);
const FETCH = new Set(['web_fetch', 'fetch', 'webfetch', 'browse', 'open_url']);

/**
 * A tool call as the panel shows it: `{tool, detail}`, `tool` the call's name (clipped) and
 * `detail` a short summary of what it works on, when the tool is one the panel knows and the
 * summary tells something: a command's first line, a file's name, a search's words, a page's host
 * and path, the bot work is handed to, a skill's name. Other tools get no detail (their arguments
 * may hold anything). `handleOf(ref)` turns a `to` into the bot's @handle when it can.
 * @param {string} name
 * @param {object|string} rawArgs
 * @param {{secrets?: string[], handleOf?: (ref: string) => string}} [opts]
 * @returns {{tool: string, detail?: string}}
 */
export function summarizeCall(name, rawArgs, opts = {}) {
  const tool = clipLine(String(name ?? 'tool'), 60) || 'tool';
  const args = argsOf(rawArgs);
  const short = tool.toLowerCase().split('__').pop();
  let detail = '';
  if (SHELL.has(short)) detail = firstLine(first(args, ['command', 'cmd', 'script', 'commands']));
  else if (READ.has(short) || EDIT.has(short) || WRITE.has(short)) detail = baseName(first(args, ['path', 'file_path', 'filePath', 'file', 'filename', 'notebook_path', 'target']));
  else if (FIND.has(short)) detail = first(args, ['pattern', 'query', 'glob', 'path', 'dir', 'directory']);
  else if (SEARCH.has(short)) detail = first(args, ['query', 'q', 'search', 'keywords']) || (Array.isArray(args.queries) ? args.queries.filter((q) => typeof q === 'string').join(' · ') : '');
  else if (FETCH.has(short)) detail = hostPath(first(args, ['url', 'uri', 'href']));
  else if (short === 'bot_send_message') {
    const to = first(args, ['to']);
    if (to) detail = opts.handleOf?.(to) || (to.startsWith('@') ? to : `@${to}`);
    else if (first(args, ['ticket'])) detail = `#${first(args, ['ticket']).replace(/^(?:ticket|task)\//, '')}`;
  } else if (short === 'skill' || short === 'load_skill') detail = first(args, ['name', 'skill']);
  else if (short === 'memory_search') detail = first(args, ['query', 'q']);
  else if (short === 'bot_recall') detail = first(args, ['ref']);
  else if (short === 'subagent' || short === 'task' || short === 'agent') detail = first(args, ['description', 'title', 'name']);
  detail = clipLine(scrub(detail, opts.secrets ?? []));
  return detail ? { tool, detail } : { tool };
}

/**
 * Activity per Session, fed with its `session/event`s (`note`) and an idle Agent (`clear`).
 * `get(sessionId)` is `{kind: 'thinking'|'tool'|'writing', tool?, detail?, startedAt, stepAt, steps}`
 * while a turn runs, else undefined: `startedAt` the turn's start, `stepAt` the current activity's,
 * `steps` the model calls so far in the turn.
 * @param {{now?: () => number, secrets?: () => string[], handleOf?: (ref: string) => string}} [opts]
 */
export function createActivity(opts = {}) {
  const now = opts.now ?? Date.now;
  /** sessionId → {kind, tool?, detail?, startedAt, stepAt, steps, sawStep, calls: Map(callId → {tool, detail, at})} */
  const live = new Map();
  const summarize = (name, args) => summarizeCall(name, args, { secrets: opts.secrets?.() ?? [], handleOf: opts.handleOf });
  const fresh = (at) => ({ kind: 'thinking', startedAt: at, stepAt: at, steps: 0, sawStep: false, calls: new Map() });
  /** The Session's record, begun now when a turn was already under way before this process heard of it. */
  const ensure = (sessionId, at) => live.get(sessionId) ?? live.set(sessionId, fresh(at)).get(sessionId);
  /** Back to thinking, or to the latest call still running. */
  const settle = (rec, at) => {
    const calls = [...rec.calls.values()];
    const last = calls.at(-1);
    if (last) Object.assign(rec, { kind: 'tool', tool: last.tool, detail: last.detail, stepAt: last.at });
    else {
      Object.assign(rec, { kind: 'thinking', stepAt: at });
      delete rec.tool;
      delete rec.detail;
    }
  };
  const call = (rec, id, name, args, at) => {
    const s = summarize(name, args);
    const key = id || `${name}:${rec.calls.size}:${at}`;
    if (rec.calls.has(key)) return;
    rec.calls.set(key, { tool: s.tool, detail: s.detail, at });
    Object.assign(rec, { kind: 'tool', tool: s.tool, stepAt: at });
    if (s.detail) rec.detail = s.detail;
    else delete rec.detail;
  };
  return {
    /** One event of `sessionId`; returns whether the activity changed. */
    note(sessionId, event) {
      if (!sessionId || !event?.type) return false;
      const at = now();
      const d = event.data ?? {};
      switch (event.type) {
        case 'turn/start':
          live.set(sessionId, fresh(at));
          return true;
        case 'turn/end':
          return live.delete(sessionId);
        case 'step/start': {
          const rec = ensure(sessionId, at);
          rec.sawStep = true;
          rec.steps += 1;
          rec.calls.clear();
          settle(rec, at);
          return true;
        }
        case 'tool/call': {
          const rec = ensure(sessionId, at);
          call(rec, d.callId, d.name, d.arguments, at);
          return true;
        }
        case 'tool/result': {
          const rec = live.get(sessionId);
          if (!rec) return false;
          const id = d.message?.toolCallId ?? d.toolCallId ?? d.callId;
          if (id && rec.calls.has(id)) rec.calls.delete(id);
          else rec.calls.delete([...rec.calls.keys()][0]);
          settle(rec, at);
          return true;
        }
        case 'assistant/message': {
          const rec = ensure(sessionId, at);
          if (!rec.sawStep) rec.steps += 1;
          const blocks = Array.isArray(d.message?.content) ? d.message.content : [];
          const calls = blocks.filter((b) => b?.type === 'tool-call');
          // Harness reports each call as a `tool/call` too; the message alone (an older Harness) is enough.
          for (const b of calls) call(rec, b.id ?? b.toolCallId ?? b.callId, b.name ?? b.toolName, b.argsRaw ?? b.arguments ?? b.args ?? b.input, at);
          if (calls.length === 0 && blocks.some((b) => b?.type === 'text' && String(b.text ?? '').trim())) {
            Object.assign(rec, { kind: 'writing', stepAt: at });
            delete rec.tool;
            delete rec.detail;
          }
          return true;
        }
        case 'user/message': {
          // Input that starts a turn (or joins one): the bot is about to think.
          const rec = ensure(sessionId, at);
          if (rec.calls.size === 0 && rec.kind !== 'thinking') settle(rec, at);
          return true;
        }
        default:
          return false;
      }
    },
    /** The Agent went idle (or the Session is gone): nothing runs there. */
    clear(sessionId) {
      return live.delete(sessionId);
    },
    /** What `sessionId` does now, for the page; undefined when nothing runs. */
    get(sessionId) {
      const rec = sessionId ? live.get(sessionId) : undefined;
      if (!rec) return undefined;
      return { kind: rec.kind, ...(rec.tool ? { tool: rec.tool } : {}), ...(rec.detail ? { detail: rec.detail } : {}), startedAt: rec.startedAt, stepAt: rec.stepAt, steps: Math.max(1, rec.steps) };
    },
    /** Sessions with something running. */
    sessions() {
      return [...live.keys()];
    },
  };
}
