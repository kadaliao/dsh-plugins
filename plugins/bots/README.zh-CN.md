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
| 团队与办公 | 飞书 🔑、Notion 🔑、Slack 🔑、长期记忆 |
| 研发与交付 | GitHub 🔑、Git 仓库、Supabase 🔑、Sentry 🔑、Context7 文档 |
| 调研与内容 | Exa、Tavily 🔑、Brave 🔑、Firecrawl 🔑 |
| 电脑与浏览器 | Open Computer Use（操控 macOS 应用）、Playwright 浏览器 |
| 数据 | PostgreSQL 🔑、SQLite |
| 地图与本地 | 高德地图 🔑、百度地图 🔑 |
| 自定义 | 任意本地（stdio）或远程（Streamable HTTP）MCP 服务 |

- **定时任务**：就是 Harness 的定时任务，也出现在「自动化」页面；
- **AI 头像**：装了 [图片插件](../images) 就能按 bot 的人设生成头像。

## 原理

- 每个 bot 对应一个普通 Harness 会话，位于 **Bots** 工作区（默认 `~/.dsh/bots/workspace`，可用 `workdir` 改）。
- 该会话运行时，bot 的人设和团队名单加入系统提示词；它自己的技能、能力限制和应用只作用于这个会话。
  修改即时生效；新增或修改应用在下次会话启动时连接。
- `bot_send_message` 把消息放进对方的收件箱并唤醒它；同一对 bot 10 分钟内最多互发 16 条，防止无限对话。
- 所有会话都能用 `bot_list`、`bot_create`、`bot_update`、`bot_delete`、`bot_send_message`、`bot_schedule` 管理 bot。

## Open Computer Use

[open-computer-use](https://github.com/kadaliao/open-computer-use) 让 bot 通过无障碍树操作 macOS 应用。在应用页点「一键安装」，
然后给 **DeepSeek Harness** 授予辅助功能权限并重启。

## 存储与外发

- `~/.dsh/cache/bots/`：`bots.json`（bot，含应用里填的 Key）、`messages.jsonl`（时间线）、`avatars/`、`skills/`（从 GitHub 导入的技能）。
- 除了 bot 自身会话（你配置的模型）、你连接的应用、生成头像时的图片模型、导入技能时访问 GitHub，不向外发送任何内容。

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
