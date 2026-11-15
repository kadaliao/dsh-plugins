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
| GET | `state` | – | `{ bots: Bot[], primaryId, sessionMap: {[sessionId]: botId}, messageCount, version }` |
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
| POST | `skills/import` | `{ botId, items: [{repo, path} | {url}] }` | `{ ok, bot, added: string[], failed }` |
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
