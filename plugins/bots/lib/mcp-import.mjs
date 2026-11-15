/**
 * MCP servers the user already configured for other agents on this machine:
 * Codex (`~/.codex/config.toml`), Claude Code (`~/.claude.json`, user and
 * project scopes), Claude Desktop, Cursor, Windsurf, Gemini CLI and opencode.
 * Each becomes a custom app a bot can take over as-is, keys included.
 *
 * @module @kadaliao/dsh-bots/lib/mcp-import
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A minimal TOML reader for `[mcp_servers.<name>]` tables: strings, arrays of strings, booleans, numbers, inline tables. */
export function parseCodexMcp(text) {
  const servers = {};
  let current = null;
  let sub = null;
  const value = (raw) => {
    const v = raw.trim();
    if (/^"(.*)"$/.test(v)) return JSON.parse(v.replace(/\\'/g, "'"));
    if (/^'(.*)'$/.test(v)) return v.slice(1, -1);
    if (/^\[.*\]$/.test(v)) {
      try {
        return JSON.parse(v.replace(/'([^']*)'/g, (_, x) => JSON.stringify(x)).replace(/,\s*]$/, ']'));
      } catch {
        return [];
      }
    }
    if (/^\{.*\}$/.test(v)) {
      const out = {};
      for (const m of v.slice(1, -1).matchAll(/([A-Za-z0-9_-]+|"[^"]+")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) out[m[1].replace(/"/g, '')] = value(m[2]);
      return out;
    }
    if (v === 'true' || v === 'false') return v === 'true';
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.replace(/\s+#.*$/, '').trim();
    if (t === '' || t.startsWith('#')) continue;
    const head = /^\[([^\]]+)\]$/.exec(t);
    if (head) {
      const parts = head[1].split('.').map((x) => x.replace(/^"|"$/g, ''));
      if (parts[0] === 'mcp_servers' && parts[1]) {
        current = (servers[parts[1]] ??= {});
        sub = parts[2] ?? null;
        if (sub === 'env' || sub === 'headers' || sub === 'http_headers') current[sub === 'http_headers' ? 'headers' : sub] ??= {};
      } else {
        current = null;
        sub = null;
      }
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z0-9_"-]+)\s*=\s*(.+)$/.exec(t);
    if (!kv) continue;
    const k = kv[1].replace(/"/g, '');
    if (sub === null) current[k === 'http_headers' ? 'headers' : k] = value(kv[2]);
    else if (sub === 'env' || sub === 'headers' || sub === 'http_headers') current[sub === 'http_headers' ? 'headers' : sub][k] = String(value(kv[2]));
  }
  return servers;
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};
const readText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** One external server as an importable custom app, or null when unusable. */
export function toApp(name, def, from) {
  if (!def || typeof def !== 'object' || def.enabled === false || def.disabled === true) return null;
  const serverName = String(name).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32) || 'server';
  const url = def.url ?? def.serverUrl ?? def.httpUrl;
  const type = String(def.type ?? def.transport ?? '');
  if (typeof url === 'string' && url !== '') {
    if (/sse/i.test(type)) return null; // mcp-client speaks stdio and Streamable HTTP only
    return { from, name: String(name), serverName, template: 'mcp-http', config: { url, headers: { ...(def.headers ?? {}) } } };
  }
  let command = def.command;
  let args = def.args;
  if (Array.isArray(command)) [command, ...args] = command; // opencode: command is an array
  if (typeof command !== 'string' || command === '') return null;
  return {
    from,
    name: String(name),
    serverName,
    template: 'mcp-stdio',
    config: { command, args: Array.isArray(args) ? args.map(String) : [], env: { ...(def.env ?? def.environment ?? {}) } },
  };
}

/** Every server found, de-duplicated by name + command/url. */
export function scanExternalMcp(home = homedir()) {
  const found = [];
  const add = (from, servers) => {
    for (const [name, def] of Object.entries(servers ?? {})) {
      const app = toApp(name, def, from);
      if (app) found.push(app);
    }
  };
  const codex = readText(join(home, '.codex', 'config.toml'));
  if (codex) add('Codex', parseCodexMcp(codex));
  const claude = readJson(join(home, '.claude.json'));
  if (claude) {
    add('Claude Code', claude.mcpServers);
    for (const [dir, project] of Object.entries(claude.projects ?? {})) add(`Claude Code · ${dir.split('/').pop()}`, project?.mcpServers);
  }
  add('Claude Desktop', readJson(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))?.mcpServers);
  add('Cursor', readJson(join(home, '.cursor', 'mcp.json'))?.mcpServers);
  add('Windsurf', readJson(join(home, '.codeium', 'windsurf', 'mcp_config.json'))?.mcpServers);
  add('Gemini CLI', readJson(join(home, '.gemini', 'settings.json'))?.mcpServers);
  add('opencode', readJson(join(home, '.config', 'opencode', 'opencode.json'))?.mcp);
  const seen = new Set();
  return found.filter((a) => {
    const key = `${a.name}|${a.config.url ?? `${a.config.command} ${(a.config.args ?? []).join(' ')}`}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What the page may see: env and header values masked. */
export function maskedApp(app) {
  const mask = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, String(v) === '' ? '' : `${String(v).slice(0, 3)}…`]));
  return { ...app, config: { ...app.config, ...(app.config.env ? { env: mask(app.config.env) } : {}), ...(app.config.headers ? { headers: mask(app.config.headers) } : {}) } };
}
