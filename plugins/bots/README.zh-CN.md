# Bots

[English](README.md) | 简体中文

把 Grok bot 搬进 DeepSeek Harness：一支能互相协作的 bot 团队。每个 bot 有自己的**头像、人设、技能、能力、应用和定时任务**，
也有自己的会话；bot 之间**私信协作**，其中一个是**调度员**，负责拆解任务、分派、跟进、汇报。

它适合两种场景：

- **一人公司（OPC）**：一个人经营业务，需要一整个「员工团队」——研发、增长、客户、财务，再加一个每天早上给你简报的幕僚长。
- **需要分工协作的工作**：开发要有人写、有人测、有人审；内容要有人调研、有人写、有人做图；研究要有人挑刺。

![团队模板](docs/teams.png)

## 一键雇用一支团队

打开 Bots 面板（左侧栏或 `/bots`），挑一个团队模板，点「雇用这个团队」：

| 团队 | 成员 | 自带的定时任务 |
| --- | --- | --- |
| **一人公司** | Atlas 幕僚长（调度员）、Forge 工程师、Echo 增长、Harbor 客户、Ledger 财务 | 工作日 09:00 早间简报、周五 17:30 周复盘、周一市场脉搏、工作日收件箱巡检、周一财务数据 |
| **研发小队** | Lead 技术负责人、Builder 开发、Tester 测试、Review 审查 | — |
| **内容工作室** | Editor 主编、Scout 研究员、Quill 写手、Pixel 设计 | 周一选题会 |
| **研究台** | Desk 研究负责人、Analyst 分析师、Market 市场、Skeptic 怀疑者 | — |

雇用时会：

- 按界面语言创建双语人设的 bot（中文界面就是中文团队）；
- 给每个成员挂上**你这台 Harness 里已有的技能**（如 deep-research、last30days、xlsx、high-signal-review），没装的跳过并告诉你；
- 从 [anthropics/skills](https://github.com/anthropics/skills) 导入岗位需要的技能（如 webapp-testing、frontend-design、brand-guidelines），连同脚本一起下载；
- 加上岗位需要的应用（GitHub、Stripe、HubSpot 等），Key 之后在「应用」页补；
- 建好定时任务，让负责人成为调度员；
- 最后可以一键把「开场任务」发给负责人，团队就开始干活了。

![聊天](docs/chat.png)

## 一段示例（一人公司）

> **你 → Atlas 幕僚长**：下周要发布新版本，帮我安排一下。
>
> **Atlas → Forge 工程师**：发布前请把 3 个 P1 bug 修完并自审，周三前合并。
>
> **Atlas → Echo 增长**：起草发布公告和三条社媒短帖，用创始人的口吻，周四给我。
>
> **Atlas → Ledger 财务**：发布后一周每天看一下新订阅和退款，有异常立刻告诉我。
>
> **Forge → Atlas**：3 个 bug 已修，测试通过，PR 已合并。
>
> **Atlas → 你**：本周进展：bug 已清零；公告草稿明天给你审；需要你决定：新版本定价是否上调。

bot 默认用你说话的语言回答；中文提问就是中文协作。

## 充分利用 Harness 已有的能力

Bot 就是一个普通的 Harness 会话，所以 Harness 能做的它都能做，不需要重复造轮子：

- **能力**：联网搜索、读写文件、运行命令与代码、Office 文档、AI 作图、子代理与工作流、交付文件……在「资料」页按能力开关，
  比如让审查 bot 不能运行命令；
- **技能**：
  - **从 Harness 添加**：直接选你已经装好的技能（`~/.agents/skills`、`~/.dsh/skills` 等），引用而不复制，跟着更新；
  - **从 GitHub 导入**：一键浏览 Anthropic 官方技能，或粘贴任意 `owner/repo/path`，整个技能文件夹连脚本一起导入；
  - **让 Bot 自己写**：一句话描述需求，bot 用 skill-creator 写好并保存到自己身上；
  - 手写仍然可以，但它是最后的选项；
- **应用**：只补 Harness 本身没有的外部系统；
  - **从其他 Agent 导入**：自动发现你在 Codex、Claude Code、Claude Desktop、Cursor、Windsurf、Gemini CLI、opencode 里配好的 MCP 服务，勾选即用，Key 一并带上；
  - **应用库**：

| 分类 | 应用（🔑 = 需要 Key） |
| --- | --- |
| 销售与收款 | Stripe 收款 🔑、HubSpot 客户管理 🔑 |
| 团队与办公 | Telegram 🔑、Discord 🔑（聊天应用，见下文）、飞书 🔑、Notion 🔑、Slack 🔑、长期记忆 |
| 研发与交付 | GitHub 🔑、Git 仓库、Supabase 🔑、Sentry 🔑、Context7 文档 |
| 调研与内容 | Exa、Tavily 🔑、Brave 🔑、Firecrawl 🔑 |
| 电脑与浏览器 | Open Computer Use（操控 macOS 应用）、Playwright 浏览器 |
| 数据 | PostgreSQL 🔑、SQLite |
| 地图与本地 | 高德地图 🔑、百度地图 🔑 |
| 自定义 | 任意本地（stdio）或远程（Streamable HTTP）MCP 服务 |

- **定时任务**：就是 Harness 的定时任务，也出现在「自动化」页面；
- **AI 头像**：装了 [图片插件](../images) 就能按 bot 的人设生成头像。
- **图标**：应用库里每个应用都用它自己的官方 logo（有 App 的用 App Store 图标，没有的用官网或官方仓库里的 logo）。
  这些 logo 是各自所有者的商标，只用来标明是哪个服务。

## 在 Telegram 或 Discord 里给团队发消息

在某个 bot（一般是调度员）的**应用**页加上 **Telegram** 或 **Discord**，就能用手机派活：你发给聊天 Bot 的话，
会像在面板里输入一样交给团队；回复会回到聊天里，包括队友回复之后调度员的汇总汇报。

> **你（在 Telegram 里）**：把下周的发布安排一下。
>
> **Atlas**：收到：Forge 处理三个 P1 bug，Echo 起草发布文案。
>
> **Atlas**（稍后）：bug 已修好并合并；发布文案已备好，等你过目。

### Telegram

1. 在 Telegram 里打开 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，起一个名字和以 `bot` 结尾的用户名。
   请专门给这个团队新建一个 Bot。
2. 在 Bots 里打开调度员 → **应用** → **Telegram** → 粘贴 BotFather 给你的 Token → **添加**。
   它会立刻连接，显示**已连接：@你的bot**。
3. 配对你自己：面板上会显示一个一次性配对码（10 分钟内有效，只能用一次）。点**在 Telegram 中打开**再点
   **Start**，或者直接把配对码发给你的 Bot。Bot 回复「配对成功」。
4. 给 Bot 发消息即可。消息以 `@handle` 开头可以直接找其他 bot（例如 `@forge 修一下登录 bug`）。
   在群里，把 Bot 拉进群并 @ 它（或回复它）；群里的其他对话它一概不理。

### Discord

1. 在 [开发者后台](https://discord.com/developers/applications)：**New Application** → **Bot** → **Reset Token**，复制 Token。
   在同一页打开 **Message Content Intent**（不开就读不到消息，面板也会提示）。
2. 用这个 Token 给调度员添加 **Discord**。连上后点**把 Bot 邀请进你所在的服务器**（任何你在的服务器都行，私人服务器也可以）：
   Discord 只允许你私信和你同在一个服务器的 Bot。
3. 私信 Bot 发送配对码，之后直接私信它派活，或在频道里 @ 它。

### 其他须知

- **谁能和它说话**：只有你配对过的人。其他人一律忽略；在私聊里最多每天收到一句「这是私人 Bot」。
  配对只能在私聊里用当前配对码完成，猜错几次就会被锁定，直到生成新码。可以配对多个人（每人需要一个新码），
  也可以在面板里移除任何人；面板还会统计被忽略的消息数。
- **配对等同于你自己的登录**：配对的人能让 bot 做你能做的任何事，包括它们的能力和应用在这台 Mac 上允许的操作。
  只配对你自己或你信任的人；如果配对了别人，请在拥有该聊天应用的 bot 上关掉有风险的能力。
- **回复发到哪里**：发到你最近一次请求来自的那个聊天。在面板里发消息，对话就回到面板。
  Telegram 收到纯文本（去掉 Markdown 标记）；Discord 保留 Markdown。
- **定时汇报**：拥有聊天应用的 bot 的定时任务会把结果发给第一个配对的人（可在面板里关闭），
  于是「工作日早上九点 Atlas 给你做简报」会直接出现在你手机上。
- **一个 Token 只能在一处使用**：同一个聊天 Bot Token 同时只能连在一个 Harness 的一个 bot 上。
  如果有别的程序在用同一个 Telegram Token，面板会提示。
- Token 和其他应用的 Key 一样保存在 bot 里，面板里不会再显示出来，也不会出现在日志和错误信息里。
  Harness 运行时 Bot 才会回复；Telegram 最多替你保存 24 小时内的消息，重启后同一条消息不会被执行两次。

## 原理

- 每个 bot 对应一个普通 Harness 会话，位于 **Bots** 工作区（默认 `~/.dsh/bots/workspace`，可用 `workdir` 改）。
- 该会话运行时，bot 的人设和团队名单加入系统提示词；它自己的技能、能力限制和应用只作用于这个会话。
  修改即时生效；新增或修改应用在下次会话启动时连接。
- `bot_send_message` 把消息放进对方的收件箱并唤醒它；同一对 bot 10 分钟内最多互发 16 条，防止无限对话。
- 所有会话都能用 `bot_list`、`bot_create`、`bot_update`、`bot_delete`、`bot_send_message`、`bot_schedule` 管理 bot。
- 聊天应用不是 MCP 服务：Host 为每个 Telegram / Discord 应用保持一个连接（Telegram 用长轮询，Discord 用 Gateway），
  随你添加、修改、关闭或删除应用而启动和停止，并把配对者的消息作为用户提示交给 bot，开头标着 `[Telegram · 名字]`。

## Open Computer Use

[open-computer-use](https://github.com/kadaliao/open-computer-use) 让 bot 通过无障碍树操作 macOS 应用。在应用页点「一键安装」，
然后给 **DeepSeek Harness** 授予辅助功能权限并重启。

## 存储与外发

- `~/.dsh/cache/bots/`：`bots.json`（bot，含应用里填的 Key 和聊天 Bot Token）、`messages.jsonl`（时间线）、
  `channels.json`（每个聊天应用的配对者，以及每个聊天处理过的最后一条消息）、`avatars/`、`skills/`（从 GitHub 导入的技能）。
- 除了 bot 自身会话（你配置的模型）、你连接的应用、生成头像时的图片模型、导入技能时访问 GitHub，
  以及连接聊天应用后访问 Telegram / Discord 的 API（给配对者的回复、正在输入提示、给陌生人的那一句提示），不向外发送任何内容。

## 安装

在 DeepSeek Harness 里加入本仓库的索引（**Plugins → Discover → Sources**）：

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

然后安装 **Bots**。Discover 标签属于实验性的 **Custom plugin markets** 功能；看不到的话先在
**Plugins → Experimental plugins** 里打开。

不用 Discover 的话，把 Git 地址填进插件管理器：

```
git+https://github.com/kadaliao/dsh-plugins.git#main&path:/plugins/bots
```

安装后刷新一次页面。想要 AI 头像，再装上[图片插件](../images)。

## 限制

- 仅 Web 界面。
- 暂无 bot 群聊，bot 之间通过私信协作。
- 团队模板引用的 Harness 技能，你没装的会被跳过；可以之后再从 GitHub 导入或让 bot 自己写。
