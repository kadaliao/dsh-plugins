# Prompt EN

[English](README.md) | 简体中文

**每条 prompt 下面多一行英文。**

用中文（或其他语言）写，能看到自己想表达的英文是什么；用英文写，会得到一次检查：改掉错误，或者给出
两种更自然的说法。

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
- **长段非英文只给要点**——最多四句，保留每个请求和约束，并标上 `· gist of 2.5k chars`。
- **长英文只列主要修改**（最多五条，`"add timeout" → "add a timeout"`），不整篇重写。

少于三个英文单词的短句（`ok`、`commit it`）、斜杠命令、子代理的工作都不处理。

## 关掉

在输入框输入 `/prompt-en` 切换（`/prompt-en on`、`/prompt-en off`），选择会记住。

## 设置

在 profile patch（`cordis.patch.yml`）里这个插件对应的行上设置：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 不卸载也能关掉功能。 |
| `reviewEnglish` | `true` | 设为 `false` 只翻译，不审阅英文。 |
| `provider` / `model` | 跟随会话 | 用哪个模型写这一行。两个都填就能换成更便宜的模型。 |
| `reasoningEffort` | 模型默认 | 固定推理档位，例如 `low`。 |

```yaml
- id: prompt-en
  config:
    enabled: true
    reviewEnglish: true
    # provider: magpie
    # model: auto/deepseek-flash
    # reasoningEffort: low
```

## 费用

每条需要显示的 prompt 发一次小请求，按普通请求计费。相同的 prompt 文本只读一次并缓存，所以重复发
`继续`、重新打开会话都不会再花钱。

## 看起来不对时

- **`no translation (empty-reply)`**——模型这次没有返回文本。会自动重试一次；仍然失败的话，重发这条
  prompt 或稍微改一下措辞即可。
- **完全没有这一行**——安装之前发过的 prompt 不会补跑；少于三个英文单词的 prompt 是故意跳过的。也确认
  一下 **Plugins → Installed** 里插件是启用状态。
- **位置不对或更新后消失**——刷新页面；这一行由 Web Client 半渲染。
- **法语、西班牙语被当成英文审阅**——语言按文字判断，不经过语言模型，所以只有非拉丁文字才会被翻译。

## 实现

Host 半看到每条提交的用户消息，折叠粘贴内容，调一次你的模型去翻译或审阅。答案缓存在本地磁盘并提供给
页面；Client 半把它画在 prompt 下面。它不写会话日志，也不改变对话模型看到的内容。

<details>
<summary>开发</summary>

仓库结构、测试和发布清单见 [DEVELOPMENT.zh-CN.md](../../DEVELOPMENT.zh-CN.md)。本插件是同一作者的
Claude Code mod [prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en)（MIT）的
DeepSeek Harness 移植版。

</details>
