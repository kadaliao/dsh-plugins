# Prompt EN — DeepSeek Harness 插件

[English](README.md) | 简体中文

在 Chat 对话里，每条 prompt 下面多一行英文。

- **你用其他语言写**，它给出英文译文。
- **你用英文写**，它给一句审阅：改错或润色，新词标绿并说明原因；如果写得很地道，就给两种其他说法。

它写出来的东西不会发给对话模型——模型读到的仍然是你原样输入的 prompt。这一行只是给你看的。

```
> 我想要创建一个插件，把我本轮的 prompt 翻译成英文
  EN  I want to build a plugin that translates my prompt for this turn into English.

> please help me check why the build is failed
  EN ✎  please help me check why the build failed · remove "is": "failed" is intransitive here

> Could you make this function async?
  EN ✓  also Make this function async. · Would you mind making this function async?
```

`✎` 黄色表示有错，`✎` 蓝色表示语法没错但母语者会换个说法，`✓` 表示表达自然。聊天式的简短写法
（全小写、句尾不加句号、“fixed it”）不会被挑错。

## 安装

在 **Plugins → Discover → Sources** 里加入本仓库的市场索引：

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

然后在列表里安装 **Prompt EN**。不用市场的话，也可以把本目录（`plugins/prompt-en`）交给 Harness
插件管理器安装，或使用索引里给出的、钉死 commit 的 Git spec。

这个插件是一个 bundle、两个半：`index.js` 跑在 Host，`client.js` 在 Web UI 里画那一行。它需要
Web profile（有输入框和对话记录），headless profile 用不了。

## 长 prompt

- **粘贴的内容先折叠再发送。** 围栏代码块、以及看起来像代码的成段无围栏文本，各自变成一个标签，
  例如 `[TypeScript code, 60 lines]`。五万字符的粘贴只会花几个词。
- **长段非英文只给要点**：最多 4 句，保留每个请求、问题和约束，后面跟一个暗色的
  `· gist of 2.5k chars`。
- **长英文只列主要修改**（最多 5 条，`"add timeout" → "add a timeout"`），不整篇重写。
- **最多显示 4 行**，点这一行或 **more** 展开。

少于 3 个英文单词的短句（`ok`、`commit it`）、斜杠命令、子代理的 prompt 都不处理。

## 开关

在输入框里输入 `/prompt-en` 即可切换（`/prompt-en on`、`/prompt-en off`）；选择记在
`$DSH_HOME/cache/prompt-en/enabled.json`，从下一条 prompt 开始生效。

## 设置

在 profile patch（`cordis.patch.yml`）里配置这一行：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 整个功能开关。 |
| `reviewEnglish` | `true` | 设为 `false` 时只翻译，不审阅英文。 |
| `provider` | 跟随会话 | 这次额外请求用的 provider。省略则用当前 Session 的模型。 |
| `model` | 跟随会话 | 这次请求的模型 id（想用更便宜的模型就在这里指定）。 |
| `reasoningEffort` | 不设置 | 固定推理档位，例如 `low`。 |

```yaml
- id: prompt-en
  config:
    enabled: true
    reviewEnglish: true
    # provider: magpie
    # model: auto/deepseek-flash
    # reasoningEffort: low
```

## 限制

- 每读一条 prompt 发一次模型请求，按普通请求计费。同样文本只读一次：答案缓存在
  `$DSH_HOME/cache/prompt-en/cache.json`（最近 800 条），重复的“继续”不花钱，恢复的 Session 也能
  重新显示。
- 你自己的话最多发送 6,000 字符，超出部分只覆盖开头。
- provider 以空文本结束流时会自动静默重试一次；其他失败只留一行暗色提示，例如
  `no translation (overloaded)`、`no review (…)`，不重试。再次提交同样文本会重试。
- 语言按文字判断：法语、西班牙语写的 prompt 会被当成英文审阅。
- 安装插件之前发过的 prompt 没有这一行（不会为历史补请求）。

## 实现

Host 半监听 `session/event` 的 `user/message`，折叠粘贴内容，然后用一句“翻译它、不要回答它”的
system prompt 调一次 `ctx.llm`。答案存在内存和 JSON 缓存里，通过两条本地路由提供：

- `GET /__dsh_prompt_en/state?session=<id>` — 某个 Session 的全部缓存行；
- `POST /__dsh_prompt_en/answer` — 对旧 prompt 的一次显式补算。

Client 半注册一个 Conversation 事件定义，匹配每条真人 `user/message`，构建一个 `prompt-en` Chat
行，锚点紧跟其后（`seq + 0.1`），再从 Host 路由取内容画出来。DSH 的用户气泡内部没有可插入的插槽，
所以这一行是紧挨着的独立行，而不是气泡里的 padding；对齐到 prompt 的右边缘，宽度上限与气泡一致。

移植自同一作者的 Claude Code mod
[kadaliao/claude-mods · prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en)（MIT）：
粘贴折叠、语言判定、要点/修改规则、审阅解析和词级 diff 与原版一致；位置和 Host/Client 拆分是 DSH 原生实现。
