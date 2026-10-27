# Prompt EN

[English](README.md) | 简体中文

**每条 prompt 下面多一行英文。**

用中文（或其他语言）写，能看到自己想表达的英文是什么；用英文写，会得到一次检查：改掉错误，或者给出
两种更自然的说法。教过你的说法会收进生词本，用 `/vocab` 复习。

```
> 帮我看看这个构建为什么失败
  EN  help me check why this build fails

> please help me check why the build is failed
  EN ✎  please help me check why the build failed · remove "is": "failed" is intransitive here

> Could you make this function async?
  EN ✓  also Make this function async. · Would you mind making this function async?
```

这一行只是给你的说明，不属于对话：模型收到的仍然是你原样输入的 prompt。

## 安装

在 DeepSeek Harness 里加入本仓库的索引（**Plugins → Discover → Sources**）：

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

然后安装 **Prompt EN**。Discover 属于实验功能 **Custom plugin markets**，看不到的话先在
**Plugins → Experimental plugins** 里打开。

不用 Discover 的话，把 Git spec 贴进插件管理器：

```
git+https://github.com/kadaliao/dsh-plugins.git#main&path:/plugins/prompt-en
```

装完刷新一次页面。

## 会看到什么

| 标记 | 含义 |
| --- | --- |
| `EN` | 你用其他语言写的 prompt 的英文。 |
| `EN ✎` 黄色 | 英文有错；改动的词标绿，并说明原因。 |
| `EN ✎` 蓝色 | 语法没错，但母语者会换个说法。 |
| `EN ✓` | 表达自然；后面跟两种其他说法。 |

聊天式的简短写法——全小写、句尾不加句号、`fixed it`——不会被当成错误。

行太长时点它或点 **more** 展开。

## 长 prompt

- **大胆粘贴。** 代码块和日志在发送前会被折叠成一个标签，例如 `[TypeScript code, 60 lines]`，
  再长的粘贴也只花几个词。
- **长段非英文只给要点**——大约四句（很长的 prompt 可能多一倍），保留每个请求和约束，并标上
  `· gist of 2.5k chars`。
- **长英文只列主要修改**（最多五条，`"add timeout" → "add a timeout"`），不整篇重写。

少于三个英文单词的短句（`ok`、`commit it`）、斜杠命令、子代理的工作都不处理。

## 生词本

prompt 下方那行英文教过你的东西，会收进生词本：

- **英文被纠正或润色过**，收一张「你写的 → 更地道的」卡片：`add timeout → add a timeout（article）`。
  同样的错再犯一次，这张卡片退回从头复习。
- **中文 prompt 的译文**，多发一次小请求，挑出最多两个值得学的表达：`顺便 → while you're at it`、
  `兜底 → fall back to`、`过度设计 → over-engineered`；再挑最多一个可以套用的句型，整句背：
  `先别急着提交，等测试跑完再说 → Hold off on committing until the tests finish.`，句型
  `Hold off on ___ until ___`。日常词、人人都会的句型（`Can you ___?`）、技术术语、代码都跳过；挑出来的
  内容必须在你的原文和译文里都找得到才收，不会收进编造的内容；中英两边说的必须是同一件事，不多不少：
  `制定完善的开发计划 → draw up a solid development plan`，而不是只有 `制定`。

在输入框输入 `/vocab`，右侧栏会打开「生词本」标签页（侧栏的引导页里也有入口），一张一张复习到期的
卡片：

```
生词本  1 / 3 · 共 18 条

你写的  add timeout
原句    Make this function async and add timeout

[显示答案  f]
```

「原句」是这个词在你 prompt 里所在的那一句，「例句」是译文里含答案的那一句，词本身都会标出来，方便两边
对照。

按 `f` 显示答案，然后 `1` 忘了、`2` 模糊、`3` 记得（回车就是记得），`x` 删掉这张；点按钮也一样。记得的
卡片每次隔得更久（1、3、7、16、35 天，最后 90 天）；忘了的在这一轮最后再出一次，并从头开始。一轮最多
20 张。有到期卡片时，打开 DeepSeek Harness 会弹一条提示，一天最多两次。

标签页里的 **列表**（或 `/vocab list`）列出最近收的卡片和每张的熟练度。**导入以前的**（或
`/vocab import`）把生词本出现之前的 prompt 也导进来：存下的纠错直接收；翻译则找回它当初的原文再挑，
每 8 条问一次模型。导入在后台进行，完成后弹提示说收了多少；已经收过的 prompt 不会重复收。

## 关掉

在输入框输入 `/prompt-en` 切换（`/prompt-en on`、`/prompt-en off`），选择会记住。

## 设置

在 profile patch（`cordis.patch.yml`）里这个插件对应的行上设置：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 不卸载也能关掉功能。 |
| `reviewEnglish` | `true` | 设为 `false` 只翻译，不审阅英文。 |
| `collectVocab` | `true` | 设为 `false` 不再往生词本里收，也不再为每条译文多发那次请求。 |
| `provider` / `model` | 跟随会话 | 用哪个模型写这一行。两个都填就能换成更便宜的模型。 |
| `reasoningEffort` | 模型默认 | 固定推理档位，例如 `low`。 |

```yaml
- id: prompt-en
  config:
    enabled: true
    reviewEnglish: true
    collectVocab: true
    # provider: magpie
    # model: auto/deepseek-flash
    # reasoningEffort: low
```

## 费用

每条需要显示的 prompt 发一次小请求，按普通请求计费。相同的 prompt 文本只读一次并缓存，所以重复发
`继续`、重新打开会话都不会再花钱。

开着生词本时，每条译文多发一次小请求来挑短语和句型（很短的 prompt 跳过）；纠错不额外花钱。导入时每 8
条以前的译文发一次请求。

## 看起来不对时

- **`no translation (empty-reply)`**——模型这次没有返回文本。会自动重试一次；仍然失败的话，重发这条
  prompt 或稍微改一下措辞即可。
- **完全没有这一行**——安装之前发过的 prompt 不会补跑；少于三个英文单词的 prompt 是故意跳过的。也确认
  一下 **Plugins → Installed** 里插件是启用状态。
- **位置不对或更新后消失**——刷新页面；这一行由 Web Client 半渲染。
- **法语、西班牙语被当成英文审阅**——语言按文字判断，不经过语言模型，所以只有非拉丁文字才会被翻译。
- **`/vocab` 没反应，或者没有「生词本」标签页**——标签页需要 DeepSeek Harness 0.2.x 的右侧栏；安装或更新
  后刷新一次页面。`/vocab list` 和 `/vocab import` 不依赖右侧栏。
- **导入漏了一些 prompt**——只能导入答案还在缓存里（最近 800 条）、会话还在磁盘上的 prompt。

## 实现

Host 半看到每条提交的用户消息，去掉宿主只写给模型看的 `<system-reminder>` 块，折叠粘贴内容，调一次
你的模型去翻译或审阅。答案缓存在本地磁盘并提供给页面；Client 半把它画在 prompt 下面。它不写会话日志，
也不改变对话模型看到的内容。

生词本是答案缓存旁边的一个文件（`~/.dsh/cache/prompt-en/vocab.json`，最多 1000 张；超出后最熟的老卡片
先删）。导入时通过 Harness 的会话查询服务读回每条缓存 prompt 的原文；除了上面说的模型请求，没有任何
内容离开你的电脑。

<details>
<summary>开发</summary>

仓库结构、测试和发布清单见 [DEVELOPMENT.zh-CN.md](../../DEVELOPMENT.zh-CN.md)。本插件是同一作者的
Claude Code mod [prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en)（MIT）的
DeepSeek Harness 移植版。

</details>
