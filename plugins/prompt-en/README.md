# Prompt EN

English | [简体中文](README.zh-CN.md)

**English under every prompt you send.**

Write to your AI in a language that isn't English and see what you meant in English. Write in
English and get your message checked: the mistakes fixed, or two more natural ways to say it.
What it teaches goes into a vocabulary book you can review with `/vocab`.

```
> 帮我看看这个构建为什么失败
  EN  help me check why this build fails

> please help me check why the build is failed
  EN ✎  please help me check why the build failed · remove "is": "failed" is intransitive here

> Could you make this function async?
  EN ✓  also Make this function async. · Would you mind making this function async?
```

It is a caption for you, not part of the conversation: the model still receives your prompt
exactly as you typed it.

## Install

Add this repository's index in DeepSeek Harness (**Plugins → Discover → Sources**):

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

then install **Prompt EN**. The Discover tab is part of the experimental **Custom plugin markets**
feature; turn it on under **Plugins → Experimental plugins** if you don't see it.

Without Discover, paste the Git spec into the plugin manager:

```
git+https://github.com/kadaliao/dsh-plugins.git#main&path:/plugins/prompt-en
```

After installing, refresh the page once.

## What you see

| Mark | Meaning |
| --- | --- |
| `EN` | A translation of a prompt you wrote in another language. |
| `EN ✎` amber | Your English had a mistake; the fixed words are green, with the reason. |
| `EN ✎` blue | Correct English, but a native speaker would phrase it differently. |
| `EN ✓` | Reads well; two other ways to say it follow. |

Terse chat style — lowercase, no final period, "fixed it" — is not flagged as a mistake.

Click a long line (or **more**) to expand it.

## Long prompts

- **Paste freely.** Code blocks and logs are folded into one label such as
  `[TypeScript code, 60 lines]` before anything is sent, so a huge paste costs a few words.
- **Long writing in another language gets its gist** — about four sentences (a very long prompt can
  get twice that), with every request and constraint kept, marked `· gist of 2.5k chars`.
- **Long English gets its main fixes** (up to five, `"add timeout" → "add a timeout"`) instead of a
  full rewrite.

Prompts shorter than three English words (`ok`, `commit it`), slash commands, and work done by a
delegated subagent are left alone.

## Vocabulary book

What the English under your prompts teaches is kept in a vocabulary book:

- **A correction or polish of your English** gives a card of your words and the better ones:
  `add timeout → add a timeout (article)`. Making the same mistake again sends the card back to the
  start.
- **A translation** gives up to two expressions worth learning, picked by one more small request:
  `顺便 → while you're at it`, `兜底 → fall back to`, `过度设计 → over-engineered`; and at most one
  sentence whose frame you can reuse: `先别急着提交，等测试跑完再说 → Hold off on committing until the
  tests finish.`, its frame `Hold off on ___ until ___`. Everyday words, common frames
  (`Can you ___?`), technical terms and code are skipped, and a pick is kept only when its words are
  in your prompt and in the English, so nothing made up gets in. Its two sides say the same, no more
  and no less: `制定完善的开发计划 → draw up a solid development plan`, never `制定` alone.

Type `/vocab` to open the **Vocabulary** tab in the right sidebar (it is also in the sidebar's
guide). It shows the cards that are due, one at a time:

```
Vocabulary  1 / 3 · 18 in the book

You wrote   add timeout
Sentence    Make this function async and add timeout

[Show answer  f]
```

Under the words is the sentence of your prompt they come from, and with the answer the sentence of
the English that holds it, each with the words marked, so the two sides can be matched.

`f` shows the answer, then `1` forgot, `2` unsure, `3` knew it (Enter picks it), `x` drops the card;
the buttons do the same. A card you knew waits longer each time (1, 3, 7, 16, 35, then 90 days); one
you forgot comes back at the end of the sitting and starts over. A sitting holds up to 20 cards.
When cards are due, a toast says so when you open DeepSeek Harness, at most twice a day.

**List** in the tab (or `/vocab list`) shows the latest cards and how well you know each.
**Import earlier prompts** (or `/vocab import`) fills the book from the prompts answered before it:
the corrections as they stand, and the translations matched back to the prompts they came from,
eight to a model request. It runs in the background and a toast says what it filed; a prompt
already filed is never filed twice.

## Turn it off

Type `/prompt-en` in the composer to flip it (`/prompt-en on`, `/prompt-en off`). The choice is
remembered across sessions.

## Settings

Set these on the plugin's row in your profile patch (`cordis.patch.yml`):

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the feature off without uninstalling. |
| `reviewEnglish` | `true` | `false` keeps translations and stops reviewing English prompts. |
| `collectVocab` | `true` | `false` stops filling the vocabulary book, and its extra request per translation. |
| `provider` / `model` | your session's | Which model writes the line. Set both to use a cheaper model. |
| `reasoningEffort` | model default | Pin a reasoning effort, e.g. `low`. |

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

## Cost

One small model request per prompt that needs a line, billed like any other request. Each distinct
prompt text is read once and cached, so repeating `继续` or reopening a session costs nothing.

With the vocabulary book on, a translation costs one more small request to pick its phrases and
pattern (skipped for a prompt of a few characters); a review costs nothing more. An import costs
one request per eight earlier translations.

## If something looks wrong

- **`no translation (empty-reply)`** — the model returned no text. It is retried once
  automatically; if the line still fails, send the prompt again or write it slightly differently.
- **No line at all** — prompts sent before installation are not backfilled, and prompts under three
  English words are skipped on purpose. Also check the plugin is enabled in **Plugins → Installed**.
- **The line sits in the wrong place or is missing after an update** — refresh the page; the row is
  drawn by the Web Client half.
- **French or Spanish is reviewed as English** — the language is detected by script, not by a
  language model, so only non-Latin scripts are translated.
- **`/vocab` does nothing, or there is no Vocabulary tab** — the tab needs the right sidebar of
  DeepSeek Harness 0.2.x; refresh the page once after installing or updating. `/vocab list` and
  `/vocab import` work without it.
- **An import leaves prompts out** — it can only file prompts whose answer is still cached (the
  latest 800) and whose Session is still on disk.

## How it works

The Host half sees each committed user message, drops the `<system-reminder>` notes a host adds for
the model alone, folds pastes, and asks your model once to translate or review it. The answer is
cached on disk and served to the page; the Client half draws it under the prompt. It never writes to
the session log and never changes what the conversation model sees.

The vocabulary book is a file beside the answer cache (`~/.dsh/cache/prompt-en/vocab.json`, up to
1,000 cards; past that the best-known oldest leave). An import reads the text of each cached
prompt back from its Session through Harness's session query service; nothing leaves your machine
but the model requests above.

<details>
<summary>Development</summary>

Repository layout, tests, and the release checklist are in
[DEVELOPMENT.md](../../DEVELOPMENT.md). This plugin is a DeepSeek Harness port of the same author's
Claude Code mod [prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en) (MIT).

</details>
