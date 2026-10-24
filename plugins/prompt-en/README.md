# Prompt EN — DeepSeek Harness plugin

English under every prompt in the Chat transcript.

- **Written in another language**, the prompt gets its English under it.
- **Written in English**, it gets a review: corrected or polished with the changed words in
  green and why, or — when it reads well — two other ways to say it.

Nothing it writes is sent to the conversation's model: that model still reads your prompt
exactly as you typed it. The English is a display-only line for you.

```
> 我想要创建一个插件，把我本轮的 prompt 翻译成英文
  EN  I want to build a plugin that translates my prompt for this turn into English.

> please help me check why the build is failed
  EN ✎  please help me check why the build failed · remove "is": "failed" is intransitive here

> Could you make this function async?
  EN ✓  also Make this function async. · Would you mind making this function async?
```

`✎` in amber marks an error, `✎` in blue a correct prompt a native speaker would phrase
differently, `✓` one that reads well. Terse chat style (lowercase, no final period, "fixed it")
is not flagged.

## Install

Add this repository's market index once in **Plugins → Discover → Sources**:

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

and install **Prompt EN** from the list. Without the market, install this directory
(`plugins/prompt-en`) with the Harness plugin manager, or use the commit-pinned Git spec the
index lists.

The plugin is one bundle with two halves: `index.js` runs in the Host, `client.js` draws the row
in the Web UI. It needs the Web profile (the Composer and Chat transcript), not the headless one.

## Long prompts

- **Pasted material is folded before anything is sent.** Fenced code blocks and tall unfenced
  blocks that read as code each become one label such as `[TypeScript code, 60 lines]`. A
  50,000-character paste costs a few words.
- **Long writing in another language gets its gist**: at most 4 sentences, every request,
  question and constraint kept, with a dim `· gist of 2.5k chars` after it.
- **Long English gets its main fixes** (up to 5, `"add timeout" → "add a timeout"`) instead of a
  full rewrite.
- **At most 4 rows** shown; click the line or **more** to expand.

Prompts of fewer than 3 English words (`ok`, `commit it`), slash commands, and delegated
subagent work are left alone.

## On/off

Type `/prompt-en` in the composer to flip it (`/prompt-en on`, `/prompt-en off`); the choice is
remembered in `$DSH_HOME/cache/prompt-en/enabled.json` and takes effect on the next prompt.

## Settings

Row config in the profile patch (`cordis.patch.yml`):

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the whole feature on or off. |
| `reviewEnglish` | `true` | `false` keeps translations and drops reviews of English. |
| `provider` | session's | Provider route for the one extra request. Omitted, the Session's current model is used. |
| `model` | session's | Model id for that request (for a cheaper model, name one here). |
| `reasoningEffort` | unset | Pin a reasoning effort for the request, e.g. `low`. |

```yaml
- id: prompt-en
  config:
    enabled: true
    reviewEnglish: true
    # provider: magpie
    # model: auto/deepseek-flash
    # reasoningEffort: low
```

## Limits

- One model request per prompt it reads, billed like any other. The same prompt text is read
  once: the answer is cached in `$DSH_HOME/cache/prompt-en/cache.json` (newest 800), so a
  repeated `继续` costs nothing and a resumed Session shows the line again.
- Your own words are sent up to 6,000 characters; past that the answer covers the start.
- A failed request leaves one dim line, `no translation (overloaded)` or `no review (…)`, with
  no retry. Submitting the same text again retries it.
- The language is told by script: a prompt in French or Spanish is reviewed as English.
- Prompts sent before the plugin was installed have no line (no request is spent on history).

## How it works

The Host half watches `session/event` for `user/message`, folds pastes, and asks `ctx.llm` once
with a system prompt that says “translate this, never answer it”. It stores the answer in memory
and in a JSON cache and serves it on two loopback routes:

- `GET /__dsh_prompt_en/state?session=<id>` — every cached line for one Session;
- `POST /__dsh_prompt_en/answer` — one explicit ask for an older prompt.

The Client half registers a Conversation event definition that matches each human
`user/message` and builds a `prompt-en` Chat row anchored fractionally just after it
(`seq + 0.1`), then draws the row from the Host route. DSH has no slot inside the user bubble,
so the line is the adjacent row rather than padding inside the bubble; the row is aligned to
the prompt's right edge with the prompt's max width.

Ported from [kadaliao/claude-mods · prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en)
(MIT), the same author's Claude Code mod: the paste folding, language detection, gist/fixes
rules, review parser and word diff are the same; the placement and the Host/Client split are
DSH-native.

## 中文

在 DeepSeek Harness 的对话里，每条 prompt 下方多一行英文：

- 你用中文（或其他非拉丁文字）写，它给出英文译文；
- 你用英文写，它给出一句审阅：改错（新词标绿并说明原因），或者给两种更地道的说法。

这一行只给你看，不会发给对话模型——模型看到的仍是你的原文。粘贴的大段代码、日志会被折叠成
`[TypeScript code, 60 lines]` 这样的标签；长中文只给要点，长英文只列主要修改；超过 4 行可点
“展开”。少于 3 个英文单词的短句、斜杠命令、子代理的 prompt 都不处理。

答案会缓存在 `$DSH_HOME/cache/prompt-en/cache.json`，重复的 prompt 与恢复的会话不再花钱。
安装插件之前已经发过的 prompt 不会补翻译。
