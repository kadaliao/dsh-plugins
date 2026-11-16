/**
 * Where a bot's model can come from, beyond the providers Harness already has:
 *
 * - **Custom endpoints** the user adds in the Bots panel (an OpenAI-, Anthropic-
 *   or Gemini-compatible base URL, a key and model ids). Each becomes a Harness
 *   provider route `bots-<name>` in the `llm-pi-ai` settings, its key stored in
 *   the Harness credential store as `BOTS_<NAME>_API_KEY` — so it serves bots
 *   (and any other conversation) through Harness's own adapter.
 * - **Logins of other agents on this machine.** The Codex CLI's ChatGPT login
 *   (`~/.codex/auth.json`) becomes Harness's `openai-codex` route. OpenAI rotates
 *   the refresh token on every refresh, so the two copies are kept in sync both
 *   ways: whichever side refreshed, the other gets the new tokens.
 *   Claude Code's login is detected but not offered: Anthropic only allows a
 *   Claude subscription in Claude Code and claude.ai.
 *
 * Nothing here returns a key or token to the page.
 *
 * @module @kadaliao/dsh-bots/lib/models
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const API_KINDS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
export const ROUTE_PREFIX = 'bots-';
export const CODEX_ROUTE = 'openai-codex';
export const PI_SCOPE = 'llm-pi-ai';

/** The Harness route of a custom endpoint named `name`. */
export function routeFor(name) {
  const text = String(name ?? '').trim();
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  // A name with no Latin letters ("本地模型") gets a short stable suffix, so two of them differ.
  if (slug && !/[^\x00-\x7f]/.test(text)) return `${ROUTE_PREFIX}${slug}`;
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `${ROUTE_PREFIX}${slug ? `${slug.slice(0, 25)}-` : 'custom-'}${h.toString(36).slice(0, 6)}`;
}

/** The credential reference holding a custom route's key. */
export const keyRefFor = (route) => `BOTS_${route.slice(ROUTE_PREFIX.length).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

const cleanUrl = (u) => {
  const s = String(u ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(s)) throw new Error('the base URL must start with http:// or https://');
  return s;
};

/**
 * The `llm-pi-ai` provider profile of a custom endpoint.
 * @param {{name: string, api: string, baseURL: string, models: (string|{id, name?, contextWindow?})[], route?: string}} e
 */
export function profileFor(e) {
  const route = e.route || routeFor(e.name);
  if (!route.startsWith(ROUTE_PREFIX)) throw new Error('not a Bots endpoint');
  const api = API_KINDS.includes(e.api) ? e.api : 'openai-completions';
  const models = [];
  for (const m of Array.isArray(e.models) ? e.models : []) {
    const id = String(typeof m === 'string' ? m : m?.id ?? '').trim();
    if (!id || models.some((x) => x.id === id)) continue;
    const cw = Number(typeof m === 'object' ? m.contextWindow : undefined);
    models.push({ id, ...(typeof m === 'object' && m.name ? { name: String(m.name).slice(0, 120) } : {}), ...(Number.isFinite(cw) && cw >= 1024 ? { contextWindow: Math.round(cw) } : {}) });
  }
  if (models.length === 0) throw new Error('add at least one model id');
  return {
    route,
    profile: {
      displayName: String(e.name ?? '').trim().slice(0, 60) || route,
      api,
      baseURL: cleanUrl(e.baseURL),
      apiKeyEnv: keyRefFor(route),
      models: models.slice(0, 100),
    },
  };
}

/** A custom route's profile as the page sees it. */
export function endpointView(route, profile, keyConfigured) {
  return {
    route,
    name: profile?.displayName ?? route,
    api: profile?.api ?? 'openai-completions',
    baseURL: profile?.baseURL ?? '',
    models: (profile?.models ?? []).map((m) => (typeof m === 'string' ? { id: m } : { id: m.id, ...(m.name ? { name: m.name } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) })),
    keyConfigured: Boolean(keyConfigured),
  };
}

/** Ask an endpoint which models it serves (OpenAI- and Anthropic-style `/models`). */
export async function discoverModels({ api, baseURL, key, fetchImpl = fetch, signal }) {
  const base = cleanUrl(baseURL);
  let url;
  const headers = { accept: 'application/json' };
  if (api === 'anthropic-messages') {
    url = /\/v1$/.test(base) ? `${base}/models?limit=1000` : `${base}/v1/models?limit=1000`;
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (api === 'google-generative-ai') {
    url = `${/\/v1(beta)?$/.test(base) ? base : `${base}/v1beta`}/models?pageSize=1000`;
    headers['x-goog-api-key'] = key;
  } else {
    url = `${base}/models`;
    if (key) headers.authorization = `Bearer ${key}`;
  }
  const res = await fetchImpl(url, { headers, signal: signal ?? AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || ''} from ${url}`.trim());
  const body = await res.json();
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
  return rows
    .map((m) => {
      const id = String(m?.id ?? m?.name ?? '').replace(/^models\//, '');
      return id ? { id, ...(m?.display_name || m?.displayName ? { name: String(m.display_name ?? m.displayName) } : {}) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

// --- logins of other agents ----------------------------------------------------------------

function jwtClaims(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export const codexAuthFile = (home = homedir()) => join(process.env.CODEX_HOME || join(home, '.codex'), 'auth.json');

/**
 * The Codex CLI's login: `{ok, email, plan, accountId, access, refresh, expires}`,
 * or `{ok: false, reason}` ('missing' | 'api-key' | 'unreadable').
 */
export function readCodexAuth(file = codexAuthFile()) {
  if (!existsSync(file)) return { ok: false, reason: 'missing' };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const t = raw?.tokens;
  if (!t?.access_token || !t?.refresh_token) return { ok: false, reason: raw?.OPENAI_API_KEY ? 'api-key' : 'unreadable' };
  const claims = jwtClaims(t.access_token) ?? {};
  const id = jwtClaims(t.id_token) ?? {};
  const auth = claims['https://api.openai.com/auth'] ?? id['https://api.openai.com/auth'] ?? {};
  return {
    ok: true,
    email: typeof id.email === 'string' ? id.email : (claims['https://api.openai.com/profile']?.email ?? ''),
    plan: String(auth.chatgpt_plan_type ?? ''),
    accountId: String(t.account_id || auth.chatgpt_account_id || ''),
    access: t.access_token,
    refresh: t.refresh_token,
    expires: Number(claims.exp) > 0 ? Number(claims.exp) * 1000 : Date.now() + 3600_000,
  };
}

/** The pi-ai credential (the Harness grant record's payload) of a Codex login. */
export const codexCredential = (a) => ({ type: 'oauth', access: a.access, refresh: a.refresh, expires: a.expires, accountId: a.accountId });

/** Write refreshed tokens back into the Codex CLI's auth.json, keeping everything else it holds. */
export function writeCodexTokens(file, cred) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.tokens = { ...(raw.tokens ?? {}), access_token: cred.access, refresh_token: cred.refresh, ...(cred.accountId ? { account_id: cred.accountId } : {}) };
  raw.last_refresh = new Date().toISOString();
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // Default.
  }
  const tmp = join(dirname(file), `.auth.json.dsh-bots-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(raw, null, 2), { encoding: 'utf8', mode });
  renameSync(tmp, file);
}

/**
 * Keeps the Codex CLI's login and Harness's copy of it the same.
 * @param {{file?: string, readRecord: () => Promise<object|undefined>, writeRecord: (cred: object) => Promise<void>, log?: (line: string) => void}} io
 */
export function createCodexSync(io) {
  const file = io.file ?? codexAuthFile();
  let last = '';
  return {
    /** One comparison: 'same' | 'to-harness' | 'to-codex' | 'missing' | 'conflict'. */
    async syncOnce() {
      const a = readCodexAuth(file);
      if (!a.ok) return 'missing';
      const rec = await io.readRecord();
      const fromCodex = async () => {
        await io.writeRecord(codexCredential(a));
        last = a.refresh;
        return 'to-harness';
      };
      if (!rec || rec.type !== 'oauth' || !rec.refresh) return fromCodex();
      // Two different ChatGPT accounts: neither side's tokens may replace the other's.
      if (rec.accountId && a.accountId && rec.accountId !== a.accountId) {
        io.log?.('codex login: Harness and the Codex CLI are signed in to different ChatGPT accounts; not syncing');
        return 'conflict';
      }
      if (rec.refresh === a.refresh) {
        last = a.refresh;
        if (rec.access !== a.access && a.expires > (rec.expires ?? 0)) {
          await io.writeRecord({ ...rec, access: a.access, expires: a.expires });
          return 'to-harness';
        }
        return 'same';
      }
      // One side refreshed since the last look: the side that still holds the old token is behind.
      const harnessMoved = last !== '' && a.refresh === last;
      const codexMoved = last !== '' && rec.refresh === last;
      if (codexMoved || (!harnessMoved && a.expires >= (rec.expires ?? 0))) return fromCodex();
      writeCodexTokens(file, rec);
      last = rec.refresh;
      io.log?.('codex login: wrote the tokens Harness refreshed back to the Codex CLI');
      return 'to-codex';
    },
  };
}

/** Other agents' logins found on this machine (no secrets): what the panel offers. */
export function detectLogins(home = homedir()) {
  const codex = readCodexAuth(codexAuthFile(home));
  const out = [
    {
      id: 'codex',
      name: 'Codex CLI',
      product: 'ChatGPT',
      found: codex.ok,
      ...(codex.ok ? { account: codex.email, plan: codex.plan } : {}),
      ...(!codex.ok && codex.reason !== 'missing' ? { note: codex.reason } : {}),
      supported: true,
      route: CODEX_ROUTE,
    },
  ];
  const claude = existsSync(join(home, '.claude', '.credentials.json')) || existsSync(join(home, '.claude.json'));
  out.push({ id: 'claude-code', name: 'Claude Code', product: 'Claude', found: claude, supported: false, reason: 'terms' });
  const gemini = existsSync(join(home, '.gemini', 'oauth_creds.json'));
  if (gemini) out.push({ id: 'gemini-cli', name: 'Gemini CLI', product: 'Gemini', found: true, supported: false, reason: 'harness' });
  const copilot = ['apps.json', 'hosts.json'].some((f) => existsSync(join(home, '.config', 'github-copilot', f)));
  if (copilot) out.push({ id: 'copilot', name: 'GitHub Copilot', product: 'Copilot', found: true, supported: false, reason: 'signin' });
  return out;
}
