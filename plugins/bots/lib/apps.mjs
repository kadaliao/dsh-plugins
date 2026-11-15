/**
 * The app catalog: MCP servers a bot can connect, each described well enough
 * that the panel shows a form (keys, paths) instead of a command line.
 *
 * Every entry is checked against its registry (npm / PyPI) or vendor docs;
 * the command runs through `npx` / `uvx`, so nothing is installed up front.
 *
 * @module @kadaliao/dsh-bots/lib/apps
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {{key: string, label: {en: string, zh: string}, kind: 'secret'|'text'|'path', env?: string, header?: string, prefix?: string, arg?: boolean, required?: boolean, placeholder?: string, help?: {en: string, zh: string}, default?: string}} AppField
 * @typedef {{id: string, name: {en: string, zh: string}, description: {en: string, zh: string}, category: string, icon: string, color: string, transport: 'stdio'|'streamable-http', serverName: string, command?: string, args?: string[], url?: string, fields?: AppField[], runtime?: 'node'|'uv'|'binary', homepage: string, keyUrl?: string, region?: 'cn'|'global', featured?: boolean, tags?: string[]}} AppEntry
 */

export const CATEGORIES = [
  { id: 'business', en: 'Sales & payments', zh: '销售与收款' },
  { id: 'work', en: 'Team & office', zh: '团队与办公' },
  { id: 'dev', en: 'Build & ship', zh: '研发与交付' },
  { id: 'research', en: 'Research & content', zh: '调研与内容' },
  { id: 'computer', en: 'Computer & browser', zh: '电脑与浏览器' },
  { id: 'data', en: 'Data', zh: '数据' },
  { id: 'life', en: 'Maps & local', zh: '地图与本地' },
  { id: 'custom', en: 'Custom', zh: '自定义' },
]

const L = (en, zh) => ({ en, zh });
const key = (env, label, keyUrl, extra = {}) => ({ key: env, env, label, kind: 'secret', required: true, ...extra, ...(keyUrl ? {} : {}) });

/** @returns {AppEntry[]} */
export function catalog(ocuPath = '') {
  const home = homedir();
  return [
    {
      id: 'open-computer-use',
      name: L('Open Computer Use', 'Open Computer Use 电脑操控'),
      description: L(
        'See and operate macOS apps through the accessibility tree: observe windows, click, type, batch actions, screenshots.',
        '通过无障碍树查看并操作 macOS 应用：读取窗口、点击、输入、批量动作、截图。',
      ),
      category: 'computer',
      icon: 'OC',
      color: '#111827',
      transport: 'stdio',
      serverName: 'ocu',
      command: ocuPath || join(home, '.local', 'share', 'ocu', 'ocu'),
      args: ['mcp'],
      runtime: 'binary',
      homepage: 'https://github.com/kadaliao/open-computer-use',
      featured: true,
      fields: [
        { key: 'OCU_API_KEY', env: 'OCU_API_KEY', kind: 'secret', label: L('Planner API key (optional)', '规划模型 API Key（可选）'), help: L('Only for run_task / click_visual / read_visual.', '仅 run_task / click_visual / read_visual 需要。') },
        { key: 'OCU_BASE_URL', env: 'OCU_BASE_URL', kind: 'text', label: L('Planner base URL (optional)', '规划模型 Base URL（可选）'), placeholder: 'https://api.deepseek.com' },
      ],
    },
    {
      id: 'playwright',
      name: L('Playwright Browser', 'Playwright 浏览器'),
      description: L('Drive a real browser: open pages, click, fill forms, read the accessibility snapshot, take screenshots.', '驱动真实浏览器：打开网页、点击、填表、读取页面结构、截图。'),
      category: 'computer',
      icon: 'PW',
      color: '#2ead33',
      transport: 'stdio',
      serverName: 'playwright',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      runtime: 'node',
      homepage: 'https://github.com/microsoft/playwright-mcp',
    },
    {
      id: 'exa',
      name: L('Exa Search', 'Exa 搜索'),
      description: L('Neural web search, code search and page contents (hosted server; works without a key at a low rate).', '语义化网页搜索、代码搜索与正文提取（托管服务，无 Key 也可低频使用）。'),
      category: 'research',
      icon: 'EX',
      color: '#1f40ed',
      transport: 'streamable-http',
      serverName: 'exa',
      url: 'https://mcp.exa.ai/mcp',
      homepage: 'https://docs.exa.ai/reference/exa-mcp',
      keyUrl: 'https://dashboard.exa.ai/api-keys',
      fields: [{ key: 'exaApiKey', kind: 'secret', query: 'exaApiKey', label: L('API key (optional)', 'API Key（可选）') }],
    },
    {
      id: 'tavily',
      name: L('Tavily Search', 'Tavily 搜索'),
      description: L('Search, extract, crawl and map websites; built for agents.', '为 Agent 设计的搜索、正文提取、站点爬取与地图。'),
      category: 'research',
      icon: 'TV',
      color: '#7c3aed',
      transport: 'stdio',
      serverName: 'tavily',
      command: 'npx',
      args: ['-y', 'tavily-mcp@latest'],
      runtime: 'node',
      homepage: 'https://github.com/tavily-ai/tavily-mcp',
      keyUrl: 'https://app.tavily.com',
      fields: [key('TAVILY_API_KEY', L('API key', 'API Key'))],
    },
    {
      id: 'brave-search',
      name: L('Brave Search', 'Brave 搜索'),
      description: L('Web, news, image and local search through the Brave Search API.', '通过 Brave Search API 搜索网页、新闻、图片和本地信息。'),
      category: 'research',
      icon: 'BR',
      color: '#fb542b',
      transport: 'stdio',
      serverName: 'brave',
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server'],
      runtime: 'node',
      homepage: 'https://github.com/brave/brave-search-mcp-server',
      keyUrl: 'https://api-dashboard.search.brave.com',
      fields: [key('BRAVE_API_KEY', L('API key', 'API Key'))],
    },
    {
      id: 'firecrawl',
      name: L('Firecrawl', 'Firecrawl 网页爬取'),
      description: L('Scrape, crawl and extract structured data from websites, JavaScript pages included.', '抓取、爬取网站并提取结构化数据，支持 JS 渲染页面。'),
      category: 'research',
      icon: 'FC',
      color: '#f97316',
      transport: 'stdio',
      serverName: 'firecrawl',
      command: 'npx',
      args: ['-y', 'firecrawl-mcp'],
      runtime: 'node',
      homepage: 'https://github.com/mendableai/firecrawl-mcp-server',
      keyUrl: 'https://www.firecrawl.dev/app/api-keys',
      fields: [key('FIRECRAWL_API_KEY', L('API key', 'API Key'))],
    },
    {
      id: 'github',
      name: L('GitHub', 'GitHub'),
      description: L("GitHub's official remote server: repositories, issues, pull requests, Actions and code search.", 'GitHub 官方远程服务：仓库、Issue、PR、Actions 与代码搜索。'),
      category: 'dev',
      icon: 'GH',
      color: '#24292f',
      transport: 'streamable-http',
      serverName: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      homepage: 'https://github.com/github/github-mcp-server',
      keyUrl: 'https://github.com/settings/personal-access-tokens/new',
      featured: true,
      fields: [{ key: 'GITHUB_TOKEN', kind: 'secret', header: 'Authorization', prefix: 'Bearer ', required: true, label: L('Personal access token', '个人访问令牌（PAT）') }],
    },
    {
      id: 'git',
      name: L('Git', 'Git 仓库'),
      description: L('Read and change a local Git repository: status, diff, log, commit, branches.', '读写本地 Git 仓库：状态、差异、日志、提交、分支。'),
      category: 'dev',
      icon: 'GI',
      color: '#f05032',
      transport: 'stdio',
      serverName: 'git',
      command: 'uvx',
      args: ['mcp-server-git'],
      runtime: 'uv',
      homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
      fields: [{ key: 'repository', kind: 'path', arg: true, flag: '--repository', required: true, label: L('Repository path', '仓库路径'), placeholder: join(home, 'code', 'my-repo') }],
    },
    {
      id: 'context7',
      name: L('Context7 Docs', 'Context7 文档'),
      description: L('Up-to-date, version-specific documentation and code examples for libraries.', '各类库最新、按版本的文档与示例代码。'),
      category: 'dev',
      icon: 'C7',
      color: '#10b981',
      transport: 'stdio',
      serverName: 'context7',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      runtime: 'node',
      homepage: 'https://github.com/upstash/context7',
      fields: [{ key: 'CONTEXT7_API_KEY', env: 'CONTEXT7_API_KEY', kind: 'secret', label: L('API key (optional, higher limits)', 'API Key（可选，提高额度）') }],
    },
    {
      id: 'sentry',
      name: L('Sentry', 'Sentry 错误监控'),
      description: L('Look up issues, errors and releases in Sentry.', '查询 Sentry 中的问题、报错与发布。'),
      category: 'dev',
      icon: 'SE',
      color: '#362d59',
      transport: 'stdio',
      serverName: 'sentry',
      command: 'npx',
      args: ['-y', '@sentry/mcp-server@latest'],
      runtime: 'node',
      homepage: 'https://github.com/getsentry/sentry-mcp',
      keyUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
      fields: [key('SENTRY_ACCESS_TOKEN', L('Auth token', '访问令牌')), { key: 'SENTRY_HOST', env: 'SENTRY_HOST', kind: 'text', label: L('Host (self-hosted only)', '主机（仅自建）'), placeholder: 'sentry.example.com' }],
    },
    {
      id: 'notion',
      name: L('Notion', 'Notion'),
      description: L('Search, read and edit Notion pages and databases shared with your integration.', '搜索、读取、编辑已共享给集成的 Notion 页面和数据库。'),
      category: 'work',
      icon: 'N',
      color: '#000000',
      transport: 'stdio',
      serverName: 'notion',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      runtime: 'node',
      homepage: 'https://github.com/makenotion/notion-mcp-server',
      keyUrl: 'https://www.notion.so/profile/integrations',
      featured: true,
      fields: [key('NOTION_TOKEN', L('Integration token', '集成令牌'), null, { placeholder: 'ntn_…' })],
    },
    {
      id: 'memory',
      name: L('Memory', '长期记忆'),
      description: L('A local knowledge graph the bot keeps across conversations: people, projects, facts.', '本地知识图谱，让 Bot 跨会话记住人、项目与事实。'),
      category: 'work',
      icon: 'ME',
      color: '#db2777',
      transport: 'stdio',
      serverName: 'memory',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      runtime: 'node',
      homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
      featured: true,
      fields: [{ key: 'MEMORY_FILE_PATH', env: 'MEMORY_FILE_PATH', kind: 'path', label: L('Memory file', '记忆文件'), default: join(home, '.dsh', 'bots', 'memory', '{bot}.jsonl') }],
    },
    {
      id: 'sqlite',
      name: L('SQLite', 'SQLite 数据库'),
      description: L('Query and analyse a local SQLite database.', '查询和分析本地 SQLite 数据库。'),
      category: 'data',
      icon: 'SQ',
      color: '#003b57',
      transport: 'stdio',
      serverName: 'sqlite',
      command: 'uvx',
      args: ['--with', 'mcp<2', 'mcp-server-sqlite'],  // mcp-server-sqlite breaks on mcp 2.x
      runtime: 'uv',
      homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite',
      fields: [{ key: 'db', kind: 'path', arg: true, flag: '--db-path', required: true, label: L('Database file', '数据库文件'), placeholder: join(home, 'data.db') }],
    },
    {
      id: 'postgres',
      name: L('PostgreSQL', 'PostgreSQL 数据库'),
      description: L('Explore schemas, run queries and check health of a PostgreSQL database (read-only).', '浏览表结构、执行查询、检查 PostgreSQL 健康状况（只读）。'),
      category: 'data',
      icon: 'PG',
      color: '#336791',
      transport: 'stdio',
      serverName: 'postgres',
      command: 'uvx',
      args: ['--with', 'mcp<2', 'postgres-mcp'],  // postgres-mcp breaks on mcp 2.x
      runtime: 'uv',
      homepage: 'https://github.com/crystaldba/postgres-mcp',
      fields: [{ key: 'DATABASE_URI', kind: 'secret', arg: true, required: true, label: L('Connection URI', '连接串'), placeholder: 'postgresql://user:pass@localhost:5432/db' }],
    },
    {
      id: 'amap',
      name: L('Amap', '高德地图'),
      description: L('Geocoding, POI search, routes, travel times and weather in China (Amap).', '高德地图：地理编码、周边搜索、路线规划、出行时间与天气。'),
      category: 'life',
      icon: '高',
      color: '#2f6bff',
      transport: 'stdio',
      serverName: 'amap',
      command: 'npx',
      args: ['-y', '@amap/amap-maps-mcp-server'],
      runtime: 'node',
      region: 'cn',
      homepage: 'https://lbs.amap.com/api/mcp-server/summary',
      keyUrl: 'https://console.amap.com/dev/key/app',
      fields: [key('AMAP_MAPS_API_KEY', L('Web service key', 'Web 服务 Key'))],
    },
    {
      id: 'baidu-map',
      name: L('Baidu Maps', '百度地图'),
      description: L('Places, geocoding, routes, traffic and weather from Baidu Maps.', '百度地图：地点检索、地理编码、路线、路况与天气。'),
      category: 'life',
      icon: '百',
      color: '#3385ff',
      transport: 'stdio',
      serverName: 'baidumap',
      command: 'npx',
      args: ['-y', '@baidumap/mcp-server-baidu-map'],
      runtime: 'node',
      region: 'cn',
      homepage: 'https://lbsyun.baidu.com/faq/api?title=mcpserver/base',
      keyUrl: 'https://lbsyun.baidu.com/apiconsole/key',
      fields: [key('BAIDU_MAP_API_KEY', L('Server AK', '服务端 AK'))],
    },
    {
      id: 'slack',
      name: L('Slack', 'Slack'),
      description: L('Read channels and threads, post messages and reactions in a Slack workspace.', '读取 Slack 频道与讨论串，发消息、加表情。'),
      category: 'work',
      icon: 'SL',
      color: '#4a154b',
      transport: 'stdio',
      serverName: 'slack',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      runtime: 'node',
      homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack',
      keyUrl: 'https://api.slack.com/apps',
      fields: [key('SLACK_BOT_TOKEN', L('Bot token', 'Bot 令牌'), null, { placeholder: 'xoxb-…' }), { key: 'SLACK_TEAM_ID', env: 'SLACK_TEAM_ID', kind: 'text', required: true, label: L('Team ID', 'Team ID'), placeholder: 'T01234567' }],
    },
    {
      id: 'stripe',
      name: L('Stripe', 'Stripe 收款'),
      description: L('Customers, payment links, invoices, subscriptions, refunds and balance (official remote server).', '客户、收款链接、发票、订阅、退款与余额（官方远程服务）。'),
      category: 'business',
      icon: 'S',
      color: '#635bff',
      transport: 'streamable-http',
      serverName: 'stripe',
      url: 'https://mcp.stripe.com',
      homepage: 'https://docs.stripe.com/mcp',
      keyUrl: 'https://dashboard.stripe.com/apikeys',
      featured: true,
      fields: [{ key: 'STRIPE_KEY', kind: 'secret', header: 'Authorization', prefix: 'Bearer ', required: true, label: L('Secret or restricted key', 'Secret / 受限 Key'), placeholder: 'rk_live_… / sk_test_…', help: L('A restricted key with only the permissions the bot needs is safest.', '建议用只开必要权限的受限 Key（rk_）。') }],
    },
    {
      id: 'hubspot',
      name: L('HubSpot CRM', 'HubSpot 客户管理'),
      description: L('Contacts, companies, deals, tickets and notes in your HubSpot CRM.', 'HubSpot CRM 里的联系人、公司、商机、工单与备注。'),
      category: 'business',
      icon: 'HS',
      color: '#ff7a59',
      transport: 'stdio',
      serverName: 'hubspot',
      command: 'npx',
      args: ['-y', '@hubspot/mcp-server'],
      runtime: 'node',
      homepage: 'https://developers.hubspot.com/mcp',
      keyUrl: 'https://app.hubspot.com/private-apps',
      fields: [key('PRIVATE_APP_ACCESS_TOKEN', L('Private app token', '私有应用令牌'), null, { placeholder: 'pat-…' })],
    },
    {
      id: 'feishu',
      name: L('Feishu / Lark', '飞书'),
      description: L('Feishu docs, Bitable, messages, calendars and contacts through the official Open Platform server.', '官方开放平台服务：飞书文档、多维表格、消息、日历与通讯录。'),
      category: 'work',
      icon: '飞',
      color: '#3370ff',
      transport: 'stdio',
      serverName: 'feishu',
      command: 'npx',
      args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-l', 'zh'],
      runtime: 'node',
      region: 'cn',
      homepage: 'https://github.com/larksuite/lark-openapi-mcp',
      keyUrl: 'https://open.feishu.cn/app',
      featured: true,
      fields: [
        { key: 'appId', kind: 'text', arg: true, flag: '-a', required: true, label: L('App ID', 'App ID'), placeholder: 'cli_…' },
        { key: 'appSecret', kind: 'secret', arg: true, flag: '-s', required: true, label: L('App secret', 'App Secret') },
      ],
    },
    {
      id: 'supabase',
      name: L('Supabase', 'Supabase'),
      description: L('Your product backend: tables, SQL, migrations, logs, edge functions (read-only by default).', '产品后端：表、SQL、迁移、日志、Edge Functions（默认只读）。'),
      category: 'dev',
      icon: 'SB',
      color: '#3ecf8e',
      transport: 'stdio',
      serverName: 'supabase',
      command: 'npx',
      args: ['-y', '@supabase/mcp-server-supabase@latest', '--read-only'],
      runtime: 'node',
      homepage: 'https://supabase.com/docs/guides/getting-started/mcp',
      keyUrl: 'https://supabase.com/dashboard/account/tokens',
      fields: [key('SUPABASE_ACCESS_TOKEN', L('Personal access token', '个人访问令牌'), null, { placeholder: 'sbp_…' }), { key: 'projectRef', kind: 'text', arg: true, flag: '--project-ref', label: L('Project ref (optional)', '项目 ref（可选）') }],
    },
    {
      id: 'mcp-stdio',
      name: L('Custom local server', '自定义本地服务'),
      description: L('Any MCP server started as a local program.', '任意以本地程序启动的 MCP 服务。'),
      category: 'custom',
      icon: '{ }',
      color: '#475569',
      transport: 'stdio',
      serverName: 'tools',
      command: 'npx',
      args: ['-y', 'your-mcp-server'],
      homepage: 'https://modelcontextprotocol.io',
      custom: true,
    },
    {
      id: 'mcp-http',
      name: L('Custom remote server', '自定义远程服务'),
      description: L('Any MCP server reached over Streamable HTTP.', '任意通过 Streamable HTTP 访问的 MCP 服务。'),
      category: 'custom',
      icon: 'URL',
      color: '#475569',
      transport: 'streamable-http',
      serverName: 'remote',
      url: 'https://example.com/mcp',
      homepage: 'https://modelcontextprotocol.io',
      custom: true,
    },
  ];
}

/**
 * The mcp-client row of one app: the template's command, with the app's field
 * values placed as environment variables, headers, query params or arguments.
 * Custom apps (and old rows) use their own `config` as written.
 * @param {object} app - `{template, serverName, values?, config?}`
 * @param {AppEntry[]} entries
 * @param {{bot?: string}} [ctx]
 */
export function mcpConfigFor(app, entries, ctx = {}) {
  const t = entries.find((e) => e.id === app.template);
  const values = app.values && typeof app.values === 'object' ? app.values : {};
  const reconnect = { maxAttempts: 3 };
  const fill = (v) => String(v ?? '').replaceAll('{bot}', ctx.bot ?? 'bot');
  const valueOf = (f) => {
    const raw = values[f.key];
    return raw === undefined || raw === null || String(raw).trim() === '' ? (f.default ? fill(f.default) : '') : String(raw).trim();
  };
  if (!t || t.custom) {
    const c = app.config ?? {};
    if (app.template === 'mcp-http' || (t && t.transport === 'streamable-http')) return { serverName: app.serverName, transport: 'streamable-http', url: c.url, headers: c.headers ?? {}, reconnect };
    return { serverName: app.serverName, transport: 'stdio', command: c.command, args: c.args ?? [], env: c.env ?? {}, reconnect };
  }
  const missing = (t.fields ?? []).filter((f) => f.required && valueOf(f) === '').map((f) => f.label.en);
  if (missing.length > 0) {
    const error = new Error(`${t.name.en} needs: ${missing.join(', ')}`);
    error.code = 'APP_INCOMPLETE';
    throw error;
  }
  if (t.transport === 'streamable-http') {
    const url = new URL(t.url);
    const headers = {};
    for (const f of t.fields ?? []) {
      const v = valueOf(f);
      if (v === '') continue;
      if (f.header) headers[f.header] = `${f.prefix ?? ''}${v}`;
      if (f.query) url.searchParams.set(f.query, v);
    }
    return { serverName: app.serverName, transport: 'streamable-http', url: url.toString(), headers, reconnect };
  }
  const env = {};
  const args = [...(t.args ?? [])];
  for (const f of t.fields ?? []) {
    const v = valueOf(f);
    if (v === '') continue;
    if (f.env) env[f.env] = v;
    if (f.arg) {
      const parts = f.multi ? v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [v];
      for (const p of parts) {
        if (f.flag) args.push(f.flag, p);
        else args.push(p);
      }
    }
  }
  return {
    serverName: app.serverName,
    transport: 'stdio',
    command: app.template === 'open-computer-use' && app.config?.command ? app.config.command : t.command,
    args,
    env,
    reconnect,
    ...(app.template === 'open-computer-use' ? { toolCallTimeoutMs: 180_000 } : {}),
  };
}

/** The catalog as the page sees it: no host-only functions, labels in both languages. */
export function publicCatalog(entries) {
  return entries.map((e) => ({ ...e, fields: (e.fields ?? []).map((f) => ({ ...f })) }));
}
