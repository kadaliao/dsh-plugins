# Bots plugin — Host ⇄ Client contract

All routes live under `/__dsh_bots/`. GET returns JSON; state-changing calls are
`POST` with `content-type: application/json` and return `{ ok: true, ... }` or
`{ ok: false, reason }`.

## Data shapes

```ts
type Avatar =
  | { kind: 'emoji'; emoji: string; color: string }        // color: CSS colour, e.g. '#7c5cff'
  | { kind: 'image'; url: string; color: string };         // url = /__dsh_bots/avatar/<botId>?v=<n>

type Skill = { id: string; name: string; description: string; content: string; enabled: boolean };

type App = {
  id: string;
  template: 'open-computer-use' | 'mcp-stdio' | 'mcp-http';
  name: string;                 // display name
  serverName: string;           // [A-Za-z0-9_-]{1,32}, tools appear as mcp__<serverName>__*
  enabled: boolean;
  config: { command?: string; args?: string[]; env?: Record<string,string>; url?: string; headers?: Record<string,string> };
};

type Bot = {
  id: string;                   // 'bot-xxxx'
  name: string;                 // display name, any language
  handle: string;               // lowercase [a-z0-9-], unique; used as @handle in DMs
  role: 'primary' | 'bot';      // exactly one primary (the dispatcher)
  avatar: Avatar;
  bio: string;                  // one line shown on cards
  persona: string;              // system-prompt persona prose
  skills: Skill[];
  apps: App[];
  tools: { deny: string[] };    // DSH global tools this bot may NOT use
  model: { provider: string; model: string } | null;   // null = DSH default
  sessionId: string | null;     // the bot's home conversation (DSH session)
  createdAt: number; updatedAt: number;
  createdBy: 'user' | string;   // 'user' or creating bot id
  status?: 'idle' | 'running' | 'offline';   // live, from the agent registry
};

type Message = { id: string; from: string; to: string; text: string; at: number; kind: 'dm' | 'user' | 'system' };
  // from/to: bot id, or 'user'
```

## Routes

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `state` | – | `{ bots: Bot[], primaryId, sessionMap: {[sessionId]: botId}, messageCount, version, limits: { skills: 200, skillsOn: 50 } }` |
| GET | `catalog` | – | `{ templates: AppTemplate[], tools: {name, description}[], models: {provider, model, label}[], skills: {name, description}[], ocu: {installed: boolean, path} }` |
| POST | `save` | `{ bot: Partial<Bot> }` (no id = create) | `{ ok, bot }` |
| POST | `delete` | `{ id }` | `{ ok }` (primary cannot be deleted) |
| POST | `primary` | `{ id }` | `{ ok }` make this bot the dispatcher |
| POST | `open` | `{ id }` | `{ ok, sessionId }` ensure the bot's home session exists |
| POST | `send` | `{ to, text }` | `{ ok, sessionId }` the user DMs a bot (delivered as a user prompt to its session) |
| GET | `messages` | `?bot=<id>&limit=200` (bot optional = all) | `{ items: Message[] }` oldest first |
| POST | `avatar` | `{ id, dataUrl }` (PNG/JPEG/WebP/GIF ≤ 2 MB) | `{ ok, bot }` |
| GET | `avatar/<id>` | – | the image bytes |
| GET | `schedules` | `?bot=<id>` | `{ items: Task[] }` (Task = DSH schedule entry: id, title, prompt, kind, scheduledAt, status, lastDelivery, timing fields) |
| POST | `schedules/save` | `{ botId, id?, title, prompt, timing }` timing = DSH Schedule timing, e.g. `{kind:'daily', daily:{time:'09:00:00', time_zone:'Asia/Singapore'}}`, `{kind:'every', every_seconds:3600}`, `{kind:'weekly', weekly:{time, time_zone, weekdays:[1..7]}}`, `{kind:'cron', cron:{expression, time_zone}}`, `{kind:'at', at:'ISO'}` | `{ ok, task }` |
| POST | `schedules/delete` | `{ id }` | `{ ok }` |
| POST | `schedules/toggle` | `{ id, active }` | `{ ok }` |
| POST | `schedules/run` | `{ id }` | `{ ok }` |

`AppTemplate = { id, name, description, transport: 'stdio'|'streamable-http', defaults: App['config'], serverName }`.

## v0.2 changes

### Avatars
`Avatar = { kind: 'initials', text?: string /* ≤2 chars override */, color } | { kind: 'image', url, color, source?: 'ai' }`.
Emoji avatars are gone: old `{kind:'emoji'}` rows normalize to initials. With no `text`, the client
derives the letters from the name: first letters of the first two words ("Data Scout" → DS, "Atlas" → AT,
"DataBot" → DB), or pinyin initials of the first two Han characters ("研究员" → YJ, via
`Intl.Collator('zh-Hans-u-co-pinyin')` against the bounds `阿八嚓哒妸发旮哈丌咔垃妈拏噢妑七呥仨他屲夕丫帀` /
letters `ABCDEFGHJKLMNOPQRSTWXYZ`; the Host has the same `initialsOf` in lib/store.mjs).

| POST | `avatar/generate` | `{ id, style? }` | `{ ok, bot }` draws a picture with the Images plugin (`generate_image`); takes 10–90 s |
| POST | `avatar/clear` | `{ id }` | `{ ok, bot }` back to initials |

`catalog.imageGen: boolean` — whether `generate_image` is available.

### Apps
`App = { id, template, name, serverName, enabled, values: {[fieldKey]: string}, config: {command?, args?, env?, url?, headers?} }`.
Catalog apps keep their settings in `values` (keys from the template's `fields`); custom apps
(`mcp-stdio`, `mcp-http`) keep using `config`.

`catalog.templates: AppEntry[]`, `catalog.categories: {id, en, zh}[]`.
```ts
AppEntry = { id, name: {en, zh}, description: {en, zh}, category, icon /* 1–3 letters or a CJK char */, color,
  transport: 'stdio'|'streamable-http', serverName, command?, args?, url?, runtime?: 'node'|'uv'|'binary',
  homepage, keyUrl?, region?: 'cn', featured?: boolean, custom?: boolean, fields?: AppField[] }
AppField = { key, label: {en, zh}, kind: 'secret'|'text'|'path', required?, placeholder?, default?, multi? /* one per line */, help?: {en, zh} }
```
`state.bots[].appIssues: {[appId]: string}` — why an app cannot start (e.g. a required key is empty).

## v0.3 changes — built for one-person companies and bot teams

### Teams (start here)
| GET | `teams` | – | `TeamView[]` |
| POST | `teams/hire` | `{ id, lang: 'zh'|'en', primary?: boolean }` | `{ ok, team, bots: Bot[], leadId, kickoff: string, skipped: {bot, kind:'skill'|'app'|'schedule', name, reason?}[] }` (can take 10–30 s: imports skills from GitHub) |

```ts
TeamView = { id, name:{en,zh}, tagline:{en,zh}, description:{en,zh}, color, kickoff:{en,zh},
  bots: { key, handle, name:{en,zh}, color, bio:{en,zh}, role:'primary'|'bot',
          skills: {name, source:'dsh'|'import', repo?, available}[], apps: {id, available}[], tasks: {when, title:{en,zh}}[] }[] }
```
Teams: `opc` 一人公司, `dev` 研发小队, `content` 内容工作室, `research` 研究台. `bot.team` holds the team id.
After hiring, the client should offer to send `kickoff` to the lead (POST send {to: leadId, text: kickoff}).

### Skills
`Skill = { id, name, source: 'own'|'dsh'|'import', description, content, enabled, dir?, origin? }`
- `dsh`: an installed Harness skill referenced by name (content not stored; it stays up to date).
- `import`: copied from GitHub with its files; `origin` is the GitHub URL.
- `own`: written by hand or by the bot itself.

| GET | `skills/library` | – | `{ skills: {name, description, source}[] /* installed Harness skills, ~90 here */, sources: SKILL_SOURCES }` |
| POST | `skills/github` | `{ repo }` (owner/repo[/path] or github URL) | `{ ok, owner, repo, ref, skills: {name, description, path, files}[] }` |
| POST | `skills/import` | `{ botId, items: [{repo, ref?, path} | {url} | {local}] }` | `{ ok, bot, added: string[], updated: string[] /* same name, same origin: replaced in place */, off: string[] /* added switched off: `skillsOn` already on */, skipped: {name, reason: 'exists'\|'full' /* `skills` kept */}[], failed }` |
| GET | `skills/local` | – | `{ places: {path, label}[] /* skill folders of other agents found on this machine */ }` |
| POST | `skills/local` | `{ path }` (a skill folder or a folder of them; `~` allowed) | `{ ok, root, skills: {name, description, path, files}[], truncated }`; a `{local: path}` import links the folder (`linked: true`, `dir` = the folder), nothing is copied |
| POST | `skills/write` | `{ botId, text }` | `{ ok, sessionId }` — asks the bot to write the skill itself (via skill-creator) and save it |
Adding Harness skills: POST save with skills + `{name, source:'dsh', enabled:true}`.
`catalog.skillSources = [{id:'anthropics', repo:'anthropics/skills', path:'skills', name, description}]`.

### Abilities (DSH built-ins, replaces the raw tool checklist as the primary control)
`catalog.abilities = [{ id, name:{en,zh}, description:{en,zh}, tools: string[], available: string[], risky? }]`
ids: web, files, code, office, images, delegate, schedule, ask, deliver, plugins. An ability is OFF when
all its `available` tools are in `bot.tools.deny`. Toggling writes the deny list (keep unrelated denies).
Keep the raw tool list as an "Advanced" disclosure.

### Apps
Catalog reorganised by business use (`categories`: business 销售与收款, work 团队与办公, dev 研发与交付,
research 调研与内容, computer, data, life, custom). Removed what DSH already does (filesystem, fetch, time,
excel, sequential-thinking, chrome-devtools). New: stripe, hubspot, feishu (飞书), supabase.
| GET | `apps/external` | – | `{ items: {from, name, serverName, template, config /* values masked */}[] }` MCP servers found in Codex / Claude Code / Claude Desktop / Cursor / Windsurf / Gemini / opencode configs |
| POST | `apps/import` | `{ botId, names: ['<from>/<name>'] }` | `{ ok, bot, added }` |

## Chat channels (Telegram, Discord, Feishu / Lark, Slack)

People message the team from a chat app; replies go back to the chat. A channel is an ordinary app on a
bot whose catalog entry has `kind: 'channel'`; it is **not** an MCP server (`mcpConfigFor` returns `null`,
no MCP client starts for it, and editing it never restarts the bot's MCP clients).

```ts
AppEntry += { kind?: 'channel', channel?: 'telegram' | 'discord' | 'feishu' | 'slack', logo?: string }
  // channel entries have no transport/command; `logo` names logos/<logo>.png, served at GET /__dsh_bots/logo/<logo>.png
// Catalog (category 'work'):
//   telegram     #229ED9  fields: token (secret)
//   discord      #5865F2  fields: token (secret)
//   feishu-chat  #3370ff  channel 'feishu', fields: appId (text), appSecret (secret)   // Feishu or Lark, found by App ID
//   slack-chat   #4a154b  channel 'slack', fields: token (bot, xoxb-), appToken (app-level, xapp-; both secret)
App.values[secret field]   // in `state` and every route that returns a bot, a stored secret reads as '••••••••' (SECRET_MASK);
                           // POST save with the mask keeps the stored value, any other value replaces it.

state.bots[].channels: { [appId]: ChannelView }
ChannelView = {
  kind: 'telegram' | 'discord' | 'feishu' | 'slack',
  state: 'connecting' | 'connected' | 'error' | 'off' /* app disabled */ | 'missing' /* a required field is empty */,
  detail?: string,              // connector's words (never the token); with error/connecting
  hint?: string,                // the panel words these itself: token, intent, conflict, duplicate;
                                // Slack: app_token, app_scope, token_kind, scopes, socket_mode;
                                // Feishu: secret, appId, disabled, bot, scopes, connlimit
  fatal?: true,                 // will not retry until the token changes or `channels/reconnect`
  account: { username, name } | null,     // the chat bot it is connected as
  paired: { id, name, at, direct: boolean }[],   // paired[0] gets scheduled reports
  code: { code: string, expiresAt: number } | null,   // one-time pairing code, 10 minutes
  link: string | null,          // Telegram deep link t.me/<bot>?start=<code>; Slack: the app's DM; Feishu / Lark: a chat with the bot
  invite: string | null,        // Discord: OAuth2 invite URL for the bot
  scheduleReplies: boolean,     // scheduled runs report to paired[0] (default true)
  ignored: { count, lastName?, lastAt? },   // messages from unpaired people since the Host started
}

Message += { via?: 'telegram' | 'discord' | 'feishu' | 'slack', who?: string }
  // kind 'user' + via: typed in that chat app by `who` (text is the message without the source line);
  // kind 'reply' + via: this reply was also sent to that chat.
```

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `channels/code` | `{ botId, appId }` | `{ ok, code, expiresAt }` a new pairing code (the old one stops working) |
| POST | `channels/unpair` | `{ botId, appId, userId }` | `{ ok }` |
| POST | `channels/options` | `{ botId, appId, scheduleReplies: boolean }` | `{ ok, scheduleReplies }` |
| POST | `channels/reconnect` | `{ botId, appId }` | `{ ok }` drop and reconnect (after fixing a setting in the chat app's console) |

A connector is `lib/channels/<kind>.mjs` (transport only; `lib/channels.mjs` does pairing, routing and reply
targets). It exports `createConnector({ token, values, onMessage, onStatus, log })` returning
`{ start() → {id, username, name}, stop(), send(chatId, text, {replyTo}?), typing(chatId) }`, and may export
`TEXT_LIMIT`, `MARKDOWN` (the app renders Markdown replies), `THREADS` (every part of a reply goes to the
thread of `replyTo`) and `links({account, code, values})` → `{link?, invite?}`. Messages it reports:
`{chatId, userId, userName, text, isDirect, mentioned, messageId, order?, chatTitle?, source?}`, where `order`
is a decimal string rising within a chat (the replay guard) and `source` overrides the label in the
`[Feishu · Name]` line the bot reads (`Lark` for a Lark app).

Behaviour (lib/channels.mjs):
- A connector runs per enabled channel app with a token; it is started, restarted (token change) and stopped
  (disabled, removed, bot deleted, plugin disposed) from the roster. One token runs in one place; a second app
  with the same token shows `hint: 'duplicate'`.
- Only paired people are heard. Pairing: a private chat, the current code (`CODE` or Telegram `/start CODE`);
  5 wrong codes per person or 20 per code lock pairing until a new code. Strangers get at most one
  "this bot is private" line per private chat per day; groups stay silent. In groups the bot only hears
  messages that mention it or reply to it.
- A paired person's message becomes a user prompt (`source.kind: 'user'`) in the owning bot's conversation, or
  in `@handle`'s when it starts with a roster handle, as two text blocks: `[Telegram · Name]` (plus the group
  name in a group) and the text. A typing indicator runs while the bot works (every 5 s). Since 0.8 the header
  names the Thread and a follow-up may go to a task instead: see "Thread keys" under v0.8.
- Replies (0.7; since 0.8 they follow each turn's Threads, see "Thread keys" under v0.8): a conversation whose
  latest user message came from a chat sends its user-facing replies
  (`kind: 'reply'` in the timeline) to that chat — including the dispatcher's report after teammates answer
  by DM. A user message from anywhere else (the panel) brings replies back to the panel. A scheduled run of
  the owning bot reports to `paired[0]` privately when `scheduleReplies`. Telegram gets plain text
  (Markdown markers removed), Discord the Markdown; both are split at the app's limit (4096 / 2000).
- A message id at or below the highest one handled in that chat is ignored (kept in `channels.json`), so a
  chat app handing a message out again after a restart never runs a task twice.

Connector contract (`lib/channels/<kind>.mjs`, transport only — Feishu or Slack inbound would be more of these):
```js
export const kind = 'telegram';      // 'discord'
export const TEXT_LIMIT = 4096;      // discord: 2000
export function createConnector({ token, onMessage, onStatus?, fetchImpl?, WebSocketImpl?, apiBase?, log? }) → {
  start(): Promise<{ id, username, name }>,   // resolves once authenticated; rejects on a bad token
  stop(): Promise<void>,                      // idempotent; nothing reconnects afterwards
  send(chatId, text, { replyTo }?): Promise<void>,   // splits at TEXT_LIMIT
  typing(chatId): Promise<void>,
}
// onMessage({ chatId, messageId, userId, userName, text, isDirect, mentioned, chatTitle? })
// onStatus({ state: 'connecting'|'connected'|'error'|'stopped', detail?, fatal? }) — never the token
```
Telegram reads `BOTS_TELEGRAM_API` (default https://api.telegram.org) so a local stand-in of the Bot API can be
used for testing.

## v0.7 — models, topics, memory, usage

### Models
`Bot.model = { provider, model, reasoningEffort? } | null` — `reasoningEffort` is one of the model's efforts.
`catalog.models[] += { group /* provider display name */, name, source?: 'custom'|'login', efforts?: {id, name}[], defaultEffort?, context? /* tokens */ }`,
`catalog.defaultModel = { provider, model } | null` (the Harness default).

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `models/sources` | – | `{ custom: Endpoint[], logins: Login[], apis: string[], writable }` |
| POST | `models/custom/test` | `{ api, baseURL, key?, route? }` (no key + route = the stored key) | `{ ok, models: {id, name?}[] }` |
| POST | `models/custom/save` | `{ route?, name, api, baseURL, key?, models: (string \| {id, contextWindow?})[] }` | `{ ok, route }` |
| POST | `models/custom/delete` | `{ route }` | `{ ok }` (bots on it go back to `model: null`) |
| POST | `models/login/connect` | `{ id: 'codex' }` | `{ ok, route: 'openai-codex' }` |
| POST | `models/login/disconnect` | `{ id: 'codex' }` | `{ ok }` |

```ts
Endpoint = { route /* 'bots-<slug>' */, name, api: 'openai-completions'|'openai-responses'|'anthropic-messages'|'google-generative-ai', baseURL, models: {id, name?, contextWindow?}[], keyConfigured: boolean }
Login = { id: 'codex'|'claude-code'|'gemini-cli'|'copilot', name, product, found, supported, account?, plan?, connected?, sync?, reason?: 'terms'|'harness'|'signin' }
```
An endpoint is a route in Harness's `llm-pi-ai` settings (`providers.<route>`, `apiKeyEnv: BOTS_<SLUG>_API_KEY`),
its key set through the credential store. The Codex login is the grant record `llm-pi-ai/openai-codex`
(`{type:'oauth', access, refresh, expires, accountId}`) plus a `providers.openai-codex` route; while in use it is
compared with `~/.codex/auth.json` every 5 minutes and on every `credentials/record-updated`, and the side holding
the older refresh token takes the other's tokens.

### Topics
`state.bots[].topic = { startedAt, lastActiveAt, tasks, context /* prompt tokens of the last call */ } | null`.
Message `kind: 'topic'` (`from: 'system'`, `text`: `'manual'|'idle'|'context'`) marks a new topic in the timeline.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `topic/new` | `{ id }` | `{ ok, sessionId }` (refused while the bot runs) |

`send` with `/new`, `/clear`, `/reset`, `/新话题` or `/新对话` first starts a new topic; text after the command goes
there. The same commands work from chat apps. A new topic = a new session for the bot; its schedules are
retargeted (`schedule.edit` patch `target`) before the old session is archived.

### Memory
```ts
Note = { id /* 'n-…' bot, 't-…' team */, text, kind: 'fact'|'preference'|'person'|'project'|'procedure'|'lesson', pinned?, source: 'auto'|'tool'|'user'|'dream', at, updated }
Journal = { id, at, bot, task, trigger, title, summary }
Digest = { date /* YYYY-MM-DD local */, text /* Markdown */, at }
```
| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `memory` | `?bot=<id>` | `{ scope, notes, journal /* newest first */, topic, topics /* past, newest first */, model, settings, tz }` |
| GET | `memory` | `?bot=team` | `{ scope: 'team', notes, digests, journal, dream: {lastDate, lastAt, result}, settings, tz }` |
| POST | `memory/put` | `{ scope: botId \| 'team', note: {id?, text?, kind?, pinned?} }` | `{ ok, note }` (no id = add) |
| POST | `memory/delete` | `{ scope, id }` | `{ ok }` |
| POST | `memory/dream` | `{}` | `{ ok, result: {bots: {bot, added, updated, removed}[], digest, team?, errors} }` |

`state.bots[].memoryNotes`, `state.teamNotes`: counts. Tools: `memory_save {text, scope?, kind?, replace_id?}`,
`memory_forget {id, scope?}`, `memory_search {query}`.

### Usage
| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `usage` | `?range=today\|7d\|30d\|90d\|all&bot=<id>&tz=<minutes east of UTC>` | `Report` |
| GET | `prices` | – | `{ overrides, list: {name, count, fetchedAt, loading, error}, models: {model, provider, price}[] }` |
| POST | `prices` | `{ model, price: {input, output, cacheRead?, cacheWrite?, currency: 'USD'\|'CNY'} \| null }` | `{ ok, …prices }` |
| POST | `prices/refresh` | `{}` | `{ ok, …prices }` |

```ts
Cost = { [currency]: number }
Totals = { tokens, input, output, cacheRead, cacheWrite, calls, cost: Cost, unpriced /* tokens */ }
Report = { range: {name, from, to, bucket /* ms */}, totals: Totals & {tasks, cacheRate}, prev: Totals & {tasks},
  series: {t, tokens, byBot: {[botId]: tokens}, cost}[], bots: ({bot, tasks} & Totals)[], models: ({provider, model, priced, priceSource} & Totals)[],
  kinds: ({kind: 'chat'|'compaction'|'memory'|'dream'} & Totals)[], schedules: {id, title, bot, runs, tokens, cost}[],
  tasks: TaskView[] /* running first, then newest */, topTasks: TaskView[], priceList }
TaskView = { id, bot, trigger: 'user'|'chat'|'schedule'|'dm', via?, from?, sched?, title, start, end, status: 'running'|'done'|'error'|'stopped', tokens, calls, cost }
```
`state.bots[].usageToday`: tokens today.

### Settings
| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `settings` | – | `{ settings }` |
| POST | `settings` | `{ patch: {topics?: {idleHours, maxContextK}, memory?: {auto, model, dream, dreamTime}} }` | `{ ok, settings }` |

## v0.8 — tasks, the router, chat threads

A **task** is work one bot hands another, done in a Harness Session of its own (`ticket-<id>`). The code calls it a
*ticket*, and so do the route paths (`tickets/…`), the types below and the tool `bot_ticket`; the panel says task. A
**run** is what 0.7 called a task: everything one Session does from one request until it is idle again. The usage
files and `TaskView` keep the name `task` for runs.

### Settings
```ts
settings += {
  dispatcher: 'router' | 'hands-on',   // default 'router'; anything else reads as 'router'
  tickets: {
    maxWorking: number,                // 4; 1–32. Task Sessions working at once; a person's message to a started task may take one more
    stallMinutes: number,              // 20; 1–1440. Quiet minutes before the status check, and again before the stall
    archiveHours: number,              // 24; 0–720. Hours after a task ended before its Session is archived (0: next upkeep)
  },
  routerNotice: null | 'pending' | 'dismissed',  // set once on the first start of 0.8: 'pending' when bots existed before
}
```
`POST settings` takes `dispatcher` and `tickets` in `patch`; a patch with `dispatcher` also sets `routerNotice:
'dismissed'`. Router mode is in effect when `dispatcher === 'router'` and the roster has at least two bots.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `router-notice/dismiss` | `{}` | `{ ok: true, routerNoticePending: false }` |

### Bots and catalog
`Bot.tools = { deny: string[], routerAllow?: string[] }` — `routerAllow`: tools a router dispatcher keeps although
Router mode denies them. A save whose `tools` leaves `routerAllow` out keeps the stored list.

`catalog.routerDeny: string[]` — what Router mode denies the dispatcher's home by default: the `code` ability (`bash`,
`job_list`, `job_output`, `job_kill`, `load_workspace_dependencies`), `write`, `edit`, the `delegate` ability, the
`images` ability, the `office` ability, and `pwsh`, the terminals (`terminal_open`, `terminal_send`, `terminal_read`,
`terminal_signal`, `terminal_close`, `terminal_list`), `apply_patch` and `str_replace_editor`. A router home also gets a
`tools.guard` that refuses `bash` and `pwsh` running `sleep`, or in the foreground without a `timeoutMs` of at most
30 s (left out, it is Harness's 120 s; `run_in_background` passes), and `job_output` waits over 5 s (or without
`timeout_ms`). A task Session of the dispatcher is an ordinary worker: none of this applies there.

### State
```ts
state += {
  dispatcher: 'router' | 'hands-on',
  routerActive: boolean,               // router mode in effect now
  routerNoticePending: boolean,
  attention: TicketRow[],              // tasks that need a person (stage question, failed or stalled), newest change first, ≤ 50
  ticketMap: { [sessionId]: ticketId },// unarchived task Sessions
}
state.sessionMap                       // also maps each unarchived task Session to its bot
state.bots[].tickets = { working, question, stalled, queued }   // counts of unarchived tasks
```

### Task data
`tickets.json` under the cache, written whole through a temp file (mode 0600):
```ts
{ version: 1, tickets: Ticket[], threads: Thread[] }

Ticket = {
  id: string,                          // 't' + 8 lowercase letters and digits
  title: string,                       // ≤ 120 characters; from the first line of `text` when not given
  text: string,                        // what was asked, ≤ 50 000 characters
  botId: string,                       // the bot doing it
  sessionId: string | null,            // 'ticket-<id>' once started
  requester: { kind: 'session' | 'user', sessionId?, botId?, ticketId? },  // ticketId: asked from that task (a sub-task)
  parentId?: string,
  origin: { threadKey?, via?, who?, replyTo? },  // via: 'telegram' | 'discord' | 'feishu' | 'slack' | 'schedule'
                                       // replyTo: id of the group message that asked; the answer there quotes it
  threads: string[],                   // Thread keys it is subscribed to (its origin's, when it has one)
  reports: { at, status: 'progress' | 'done' | 'blocked' | 'question', text }[],  // newest 200, each ≤ 20 000 characters
  createdAt, updatedAt, startedAt?,
  lastEventAt?,                        // latest event in its Session
  lastHumanAt?, lastRequesterAt?,      // latest message from a person / from the requester
  nudgedAt?, stalledAt?, remindedAt?,  // watchdog
  retries: number,                     // "continue"s sent after temporary errors in a row
  parked?: { key, content, source, at, human? }[],  // messages for a started task waiting for a worker slot, oldest first
  error?: string,
  ended?: { at, by: 'worker' | 'requester' | 'user' | 'system', outcome: 'done' | 'stopped' | 'failed' },
  archivedAt?,
}

Thread = { key, kind, appKey, chatId, rootId?, label?, tickets: string[] /* subscribed task ids */, lastAt }
```
Only bots open tasks (`bot_send_message`), so `requester.kind` is `'session'`. The newest 500 archived tasks are kept;
Threads no task is subscribed to are dropped. A file that is not JSON in this shape is set aside as
`tickets.json.corrupt-<ms>` and tasks start empty; one that cannot be read (permissions, a directory in its place)
stops the plugin from starting, with a log line, so nothing writes over it.

A started task's Session gets a message only while the task holds a worker slot. A person's message (from the panel,
a chat follow-up, or a `bot_ticket` `retry` or `status` from a conversation of no bot) may take one slot over
`maxWorking`; any other (a bot's, the watchdog's) waits in `parked` while every slot is taken, and the task counts as
`queued` until the messages go in, oldest first, as a slot frees. Parked messages outlast a restart; the task ending
drops them.

Stage (`stageOf`, first match wins; "answered" means `lastHumanAt` or `lastRequesterAt` is later than that report):

| Stage | When | Panel |
|---|---|---|
| `failed` | `ended.outcome === 'failed'`, or open with an unanswered `blocked` report last | Failed |
| `question` | open with an unanswered `question` report last | Needs your answer |
| `stalled` | open and `stalledAt` set | Stuck |
| `queued` | open and never started (`startedAt` unset), or started with messages in `parked` | Queued |
| `working` | open otherwise | Working |
| `done` | `ended.outcome === 'done'` (a `done` report, or closed) | Done |
| `stopped` | `ended.outcome === 'stopped'` | Stopped |

```ts
TicketRow = { id, title, botId, stage, requester: { kind: 'bot', botId } | { kind: 'user' }, via?, createdAt, updatedAt,
  lastReport?: { status, preview /* ≤ 200 characters */ } }
TicketView = TicketRow & {
  text, parentId?, children: string[], requesterSessionId: string | null, origin: { threadKey?, via?, who?, replyTo? },
  startedAt?, ended?, error?, archivedAt?, nudgedAt?, stalledAt?, retries? /* when not 0 */,
  reports: { at, status, text }[],
  threads: { key, kind, label }[],
  runs: { id, trigger, title, start, end, status, tokens, calls, cost }[],   // oldest first
  usage: { tokens, calls, cost },      // all calls made for the task, its memory summary included
  sessionId: string | null,
  running: boolean,                    // its Session is in a turn now
}
```

### Routes
| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `tickets` | `?bot=<id>&stage=<stage>[,<stage>…]&archived=0\|1&limit=50&offset=0` (limit 1–200) | `{ items: TicketRow[], next_offset: number \| null }`, latest change first |
| GET | `tickets/<id>` | – | `TicketView` |
| POST | `tickets/<id>/stop` | `{}` | `{ ok, …TicketView }` ends it as stopped by the user and cancels its running turn |
| POST | `tickets/<id>/close` | `{}` | `{ ok, …TicketView }` ends it as done and cancels its running turn |
| POST | `tickets/<id>/retry` | `{}` | `{ ok, …TicketView }` opens it again and hands the assignment over afresh (also one the user stopped) |
| POST | `tickets/<id>/message` | `{ text }` | `{ ok, …TicketView }` the user's message into its Session; an ended task opens again; a queued one gets it added to its assignment |
| GET | `threads/<key>` | key URI-encoded | `{ key, label, kind, tickets: TicketRow[], recent: { at, from, to, who?, text }[] }` (the last 10 timeline messages of that Thread, text ≤ 300 characters) |

An unknown id answers `{ ok: false, reason: 'no such task' }`; an archived task cannot be retried or messaged. A
task's requester hears of a stop or close by the user through an injected note that does not wake it (on a Harness
without `inject`, it hears nothing). `delete` of a bot stops and archives its tasks, and stops every open task it asked
for (from its home or its tasks), which stays unarchived with `error: '@<handle>, who asked for it, was removed'`.

### Thread keys
`kind:appKey:chatId[:rootId]`, with `appKey` = `<botId>/<appId>` of the chat app; inside a part `%` and `:` are written
`%25` and `%3A`. A panel conversation is `panel:<sessionId>`. The root is the connector's `threadId`: Slack
`thread_ts` (a top-level channel message: its own `ts`), Discord the thread channel or the root of the reply chain,
Feishu the root message of the reply chain or topic, Telegram the forum topic (`message_thread_id`). Without one, a
Slack, Discord or Feishu group message is its own root (the bot answers under it); private chats and Telegram groups
without topics are the whole chat. Connectors report `threadId` on messages; `send` takes `{ threadId, replyTo }` and
`typing` takes `{ threadId }`.

A chat message reaches a bot as two text blocks, `[Telegram · Name] (thread <key>)` and the text; every block but the
last of a message the plugin delivers ends with a line break.

Inbound routing (`lib/threads.mjs` `routeInbound`):
1. A leading `@handle` of another bot goes to that bot's home; the channel owner's own handle goes to its home.
2. Tasks subscribed to the message's Thread that are not archived and not stopped take it, steered into each task
   Session as a person's message (an ended task opens again), and the owner's home gets a `[follow_up]` note injected
   without waking it. On a whole-chat Thread (no `rootId`) only a task whose latest report is an unanswered
   `question` takes it, and only when it is the one such task: with two or more, the message goes to the router (3).
3. Otherwise the owner's home (the router).

Plain replies (`createOrigins`): each turn of a home collects the Threads of its inputs (user messages, and the
origin Threads of the tasks a report, a `[Failed]` or `[Stalled]` note, or a `[Reminder]` is about). One chat Thread
and nothing else: the reply goes there. Only the panel, or nothing: it stays in the panel. Anything more, the panel
and one chat included: it stays in the panel (timeline entry `notSent: true`), and the bot sends each answer with
`bot_reply`. A task Session's text reaches no chat.

Deliveries the plugin makes with a key get the message id `bots:<key>`; one already pending, in the Session's stored
log or parked on its task is not delivered again. Router homes, task Sessions and relayed reports use `agent.steer`
(messages that arrive during a turn are taken together at its next step), notes that should not wake use
`agent.inject`, and other homes take user messages and 0.7 DMs with `followup` as before. A Harness without `steer`
gets `followup`; one without `inject` gets no such note (the `[follow_up]` note, a stop or close by the user): it is
dropped, never turned into a turn.

### Watchdog and restarts
The 5-minute upkeep (`lib/watchdog.mjs`):
- a `working` task whose Session is idle, with no shell jobs, sub-agents or working/queued sub-tasks, and no event,
  report or message for `stallMinutes`: one status check (`nudgedAt`); still nothing `stallMinutes` after it:
  `stalledAt`, a `[Stalled]` note to the requester, and its slot is freed;
- `agent/error` in a task Session: HTTP 408, 429 or 5xx, or a refused, reset or timed-out connection (not quota or
  billing errors), gets a "continue" after 15, 30 and 60 s (`retries`); then, or for any other error, the task ends as
  `failed` and the requester gets a `[Failed]` note. A completed turn resets `retries`;
- a requester Session that is idle, whose unarchived tasks have all settled (`done`, `failed`, `stopped`,
  `stalled`) and that said nothing since (a home: a timeline `reply` not marked `notSent`; a task Session: a report):
  one `[Reminder]` (`remindedAt`), at least a minute after the last one settled. A task Session whose task has ended
  gets none;
- tasks ended `archiveHours` ago: their Session is archived and `archivedAt` set.

At start, working tasks take their slots again. 3 s after the plugin starts, one whose Session had to be made anew
gets a `[Recovery]` note and its assignment; one whose stored log holds no message gets its assignment again; one whose
Session was mid-turn, or holds input it never took, gets the note. The note's id names the latest turn that did not end
cleanly, so a second restart before it is read sends nothing new, and a recovery turn cut off again gets a note of its
own. Then queued tasks start, and parked messages are handed over, while slots are free.

### Questions (`ask_user_question`)

Bots answers Harness's `user-questions/request` for a bot's home Session and for task Sessions, ahead of Harness's own
window: the request settles with whichever answers first, the panel or the conversation. With no window connected
(`NO_PROVIDER`) it waits for the panel. Questions with an `approval` or `plan-review` intent are recorded but only
answered in the conversation. A timed question that ran out stays answerable (`continued`) and is answered through
`userQuestions.answer`. Questions are kept in memory only.

- `GET /__dsh_bots/state` adds `asks: [{id, botId, sessionId, ticketId?, at, native?: true, continued?: true,
  questions: [{id, question, header?, detail?, options?: [{label, description?}], multiSelect?}]}]`, oldest first
  (`native` questions carry only `{id, question}`), and `bots[].asking`, the number waiting in that bot's home.
  `attention` also lists tasks whose Session waits on a question; task rows and views carry `asking: true` meanwhile.
- `POST /__dsh_bots/asks/:id/answer` with `{answers: [{id, selected: string[], custom?}]}` → `{ok: true}` or
  `{ok: false, reason}` (unknown or already answered, a `native` question, or an invalid answer: every question needs
  exactly one item, labels must be offered ones, a single choice takes one option or `custom`, and none may be empty).
- A panel answer is logged in the timeline as a user message, `"<question>\n→ <answer>"`, with `ticket` for a task.
- The watchdog skips a task that waits on a question. A chat the turn came from gets one notice per question.

### Timeline
```ts
Message += { thread?: string, ticket?: string, status?: 'done' | 'blocked' | 'question' | 'stalled' | 'failed',
  notSent?: true, choices?: string[] }
```
| kind | Fields | Entry |
|---|---|---|
| `dm` | `ticket` | a bot opened the task for `to`, or added a message to it (`from: 'user'`: the user, from the panel) |
| `dm` | `ticket`, `status: 'done' \| 'blocked' \| 'question'` | the task's report to its requester (`to`: the requesting bot); `progress` reports are not logged |
| `dm` | `ticket`, `status: 'stalled' \| 'failed'` | the watchdog marked the task stalled, or it failed after an error |
| `user` | `thread`, `via?`, `who?` | a message into a bot's home (`thread`: the chat Thread, or `panel:<sessionId>`) |
| `user` | `via`, `who`, `thread`, `ticket` | a chat follow-up that went straight to the task |
| `reply` | `thread`, `via?` | a bot's reply; `via` when it went to a chat (`bot_reply` too) |
| `reply` | `notSent: true`, `choices` | plain text of a turn with several chats: sent to none; `choices` are its chat Thread keys |

Entries written before 0.8 have none of these fields.

### Usage and memory
- `usage.jsonl` rows: `tk?` (the task; `t` stays the time). `tasks.jsonl` rows (runs): `t?` (the task).
- `TaskView += { ticket? }`.
- `Report += { tickets: ({ id, bot, title, runs } & Totals)[] }`: the window's calls by task, most tokens first, ≤ 60;
  `runs` counts the task's runs that ended in the window or are running.
- A task's runs are summarized into its bot's memory once, when the task ends: `Journal += { ticket? }`, with
  `trigger: 'ticket'`. A task Session is no topic: it never rotates, and its calls do not count toward the home's
  context.

### Tools
Every conversation gets `bot_reply`, `bot_recall` and `bot_ticket` besides the 0.7 tools. A Harness sub-agent or fork
(Session header `origin: 'subagent'` with a `parentSession`) uses the bot tools and the memory tools as the bot home or
task Session it descends from, with that one's limits; a helper of a conversation of no bot acts as no bot. One whose
line cannot be traced (a creator that is gone and was no bot's, or a loop) acts for no one: `bot_send_message`,
`bot_reply`, `bot_ticket`, `bot_create`, `bot_delete` and the memory tools refuse it (`bot_schedule` too, unless it
names `bot`), and `bot_recall` reads nothing.

`bot_send_message { to?, text, ticket?, status?, title?, thread? }`:

| Called from | Arguments | Does | Result |
|---|---|---|---|
| a task Session | no `to` (or the requesting bot, or `ticket` = its own id), `text`, `status` (required) | a report: `progress` is only recorded; `done`, `blocked`, `question` reach the requester at once; `done` ends the task. From a task that has ended, or a sub-task whose parent has ended, any report is only recorded (no relay, no timeline entry) | `{ ok, text, ticket: TicketRow, to, from }` |
| a task Session | `to`, `text`, `title?` | opens a sub-task (requester: this task) | `{ ok, text, ticket, stage, to, from }` |
| a bot's home, `dispatcher: 'router'` | `to`, `text`, `title?`, `thread?` | opens a task; starts at once when a slot is free, else queued | `{ ok, text, ticket, stage, to, from }` |
| the requester's Session, the requesting bot's current home, or the router home | `ticket`, `text`, `to?` (must be the task's bot) | adds a message to the task; an ended task opens again, except one the user stopped; with every slot taken it waits in `parked` | `{ ok, text, ticket, to, from }` |
| a bot's home in hands-on mode, or any other conversation | `to`, `text` | 0.7: into the other bot's home | `{ ok, text, to, from }` |

`title` defaults to the first line of `text`. `thread` names, when a turn has several chats, the Thread (one of the
turn's) a new task is for; left out then, the task belongs to none. A sub-task takes no Thread. `status` is refused
outside a report. New tasks and added messages count toward the 16 messages per pair of bots in 10 minutes. `to` and
`from` are bot faces (`{ id, name, handle, avatar, role }`).

`bot_reply { text, ticket?, thread? }` — one of `ticket` (the chat that task came from) or `thread` (a key, or
`thread/<key>`) is required. It resolves this turn's Threads first, then a stored Thread whose chat app is connected
and has someone paired. Only from a bot's home: refused in a task Session and in conversations of no bot. Result
`{ ok, text, thread, via? }`; a panel Thread only logs the reply.

`bot_recall { ref, offset? }`:

| ref | Result |
|---|---|
| `tickets` | `{ ref, items: Card[], total, next_offset? }`, open tasks first, then failed, then ended, archived last; newest first within each |
| `ticket/<id>` | `{ ref, card: Card, text /* ≤ 200 characters of the assignment */, chars?, more: string[] }` |
| `ticket/<id>/text`, `ticket/<id>/reports`, `ticket/<id>/transcript` | `{ ref, text, offset, chars, next_offset? }`: the assignment, every report (newest first), the task Session's conversation |
| `thread/<key>` | `{ ref, thread: { key, kind, label, last_at }, items: Card[], total, next_offset?, recent?: { at, who, text }[] }` |
| `bot/<handle>` | `{ ref, bot: { handle, name, bio, dispatcher? }, items: Card[], total, next_offset? }` |

`task/…`, `tasks`, a bare task id and `@handle` work too. Lists come 20 to a page, text 4000 characters to a page;
pass `next_offset` as `offset`. `Card = { id, title, bot, stage, requester, parent?, children?, origin?: { thread?,
label?, via?, who? }, threads?, last_report?: { status, at, preview }, error?, archived?, updated_at }` (list items
leave out `children`, `threads` and `error`). From a task Session only that task, its parent, its sub-tasks and its
Threads can be read. `recent` comes from the timeline, whose entries carry a Thread from 0.8 on.

`bot_ticket { id, action: 'stop' | 'close' | 'retry' | 'status' }` — on a task this conversation asked for (the router
home and conversations of no bot: any task; a task Session: only its sub-tasks). `stop` ends it as stopped and
`close` as done, both cancelling its running turn; `retry` opens it again with the assignment (a bot cannot retry one
the user stopped); `status` asks an idle working task for a report. Result `{ ok, text, ticket: TicketRow }`.

`memory_search { query }` also matches tasks: every word in the title, else in one of its reports (most recently
changed first, ≤ 10). From a task Session only its task, parent and sub-tasks, and only their journal lines; no
digests. Result `+= { tickets: string[] }`.
