# DSH Plugins

[English](README.md) | 简体中文

[![index](https://github.com/kadaliao/dsh-plugins/actions/workflows/test.yml/badge.svg)](https://github.com/kadaliao/dsh-plugins/actions/workflows/test.yml)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件合集——每个插件都很小，只增强
对话、输入框或工作区里的一个点。本仓库是索引，每个插件有自己的仓库。

## 安装

1. 先启用一次市场：**Plugins → Experimental plugins → Custom plugin markets**。
2. 打开新出现的 **Discover** 标签页，在 **Sources** 里加入：

   ```
   https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
   ```

3. 在 Discover 里安装想要的插件。

已经知道要装什么，也可以直接把插件的包名贴进插件管理器：

```
@kadaliao/dsh-prompt-en
```

## 插件

| 插件 | 作用 |
| --- | --- |
| [Archify 图解](https://github.com/kadaliao/dsh-archify/blob/main/README.zh-CN.md) · 0.3.2 | 说一句要什么图，对话里就出现一张检查过、能交互的页面：[Archify](https://github.com/tt-a1i/archify) 的架构图、流程图、时序图、数据流图、状态图、ER 图、类图、树图、时间线、瀑布图，照描述、Mermaid 或代码来画，也能把回答做成一页讲解。也可以不写提示词：在 Archify 面板里选图的类型（每种都配着示意图和可交互的示例），想从代码画就再选个项目文件夹，点「生成」，插件扫描仓库、开会话并跟进进度。在图库里，「改图」交给画这张图的会话去改；「点评」让模型读代码评审架构，每条结论都附文件和行号，并经插件逐条核对。默认就快：架构图由插件排版，格式小错和仓库证据在检查前就修好，一次调用的仓库扫描带代码地图，模型不用四处翻代码。内置 Archify 技能，用 Harness 自带的运行时，不用装 Node.js。中英双语。 |
| [足迹](https://github.com/kadaliao/dsh-atlas/blob/main/README.zh-CN.md) · 0.1.1 | 把“照片”图库放到一颗能放大到街道的夜色地球上：拍过照的地方发光，缩略图从去过的地方冒出来，放大后有 3D 地形和建筑、你照片里认出的店铺景点、附近的维基百科条目。旅行可以用故事模式回放，这些年按章节一段段回放，每天翻出往年今天的照片和你去过的地方附近的历史上的今天。到哪里都先看精选的好照片；像说话一样搜索（中文连着写也行），模型能搜你的照片、移动地图。底图可选夜景 OpenStreetMap、高德（国内最详细）、卫星或离线。只读 macOS“照片”图库，中英双语。 |
| [Bots](https://github.com/kadaliao/dsh-bots/blob/main/README.zh-CN.md) · 0.16.2 | 给一人公司和分工协作场景的 Grok 式 bot 团队：一键雇用现成团队（一人公司、研发小队、内容工作室、研究台），每个 bot 有自己的人设、头像、模型、技能、能力、应用和定时任务，还有自己的记忆：每个任务后自动总结，每晚和团队的共享笔记、每个项目自己的记忆一起整理（有日期的笔记过了日期就忘掉）；bot 之间私信协作，雇几个团队都由同一个调度员分派，交给各团队的负责人，自己建的 bot 也能放进任意已雇的团队：每件分派出去的工作都是一个任务，在自己的会话里进行，一个 bot 可以同时做几件事，调度员随时能回你的话，结果回到发起它的那个聊天，卡住的任务会被看门狗发现。任务之上还有看板：你交给团队的每件事是一张卡片，调度员用一句话写清楚，标出做到了哪一步、哪些在等你；卡片按项目归档（项目有自己的文件夹和简介），带 OPC-12 这样的编号，消息里提编号就能找到它，卡片可以等别的卡做完再开始，打了标签的 GitHub issue（github.com 或 GitHub Enterprise）也会变成卡片。面板聊天像聊天软件一样 bot 在左、你在右：回复任何一条消息就引用它，bot 在这条消息的讨论串里回答，只看得到这条消息和它之前的内容，看不到后来的；干活的 bot 直接在请求来的对话或讨论串里回复。充分复用 Harness：直接用你已装的技能、从 GitHub 或本地文件夹导入、或让 bot 自己写技能，从 Codex、Claude Code、Cursor 导入 MCP 服务。bot 可以用自定义端点或 Codex CLI 的 ChatGPT 登录；对话太长前自动开新话题；用量页按 bot、任务、日期统计 tokens 和费用。在飞书、Telegram、Slack 或 Discord 里就能给团队派活。中英双语。 |
| [图片](https://github.com/kadaliao/dsh-images/blob/main/README.zh-CN.md) · 0.5.6 | 要一张图就给一张图：给模型一个 `generate_image` 工具，用你供应商的生图模型出图，图直接显示在对话里；「图片」面板把画过的都收成图库，可浏览、放大、下载。设置抽屉里选供应商、密钥和模型（输入即可模糊搜索），每张图都标出费用；供应商不给价的模型用公开的 LiteLLM 价目表兜底。要动图时让模型画一张精灵图，自动拼成循环播放的 GIF；也能带参考图（对话附件、文件、之前生成的图）改图或接着画。 |
| [Prompt EN](https://github.com/kadaliao/dsh-prompt-en/blob/main/README.zh-CN.md) · 0.2.1 | 在每条 prompt 下方写一行英文：用其他语言写的给出译文，用英文写的给出纠错和更地道的替代说法。教过你的说法收进生词本，用 `/vocab` 复习。 |

之后做好的插件会陆续加进来。每个插件有自己的仓库，独立安装、独立版本；索引为每个版本钉死来源（新的
版本走 npm 包，早期版本走本仓库的 Git 提交），所以新增插件、把插件搬到自己的仓库，都不会改变已有的安装。

## 共同点

- 都在 **Web UI** 里工作（桌面 App 或 `dsh web`）。
- 除非插件 README 另有说明，都只做展示：不写 Session 日志，也不往对话模型读到的内容里加东西。
- 纯 JavaScript，MIT，源码在各插件自己的仓库。Archify 图解另外内置了一份 Apache-2.0 的 Archify 技能和 EPL-2.0 的
  elkjs 排版引擎，具体见它的 README。

## 环境要求

- DeepSeek Harness 0.2.x，并使用 Web UI。
- Harness 里已配置模型。除非插件 README 另有说明，插件默认复用当前会话的模型。

## 常见问题

**找不到 Discover 标签页。** 自定义市场在 DeepSeek Harness 里是实验功能，先在
**Plugins → Experimental plugins** 里打开 **Custom plugin markets**。

**插件装了却没反应。** 到 **Plugins → Installed** 确认它是启用状态。Client 侧插件安装后需要刷新一次
页面；安装之前已经发过的 prompt 不会补跑。

**会把这些内容发到哪里？** 每个插件的 README 都会写清楚它读什么、调用哪个模型。除非 README 明确说明，
插件算出来的东西不会进入你的对话。

## 参与开发

某个插件的 issue 和 PR 请提到它自己的仓库；插件想法和索引相关的事提到这里。东西都在哪、如何新增插件、
测试和发布清单都在 [DEVELOPMENT.zh-CN.md](DEVELOPMENT.zh-CN.md)。

## 许可

MIT。
