# Prompt EN

English | [简体中文](README.zh-CN.md)

**English under every prompt you send.**

Write to your AI in a language that isn't English and see what you meant in English. Write in
English and get your message checked: the mistakes fixed, or two more natural ways to say it.

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
- **Long writing in another language gets its gist** — at most four sentences, with every request
  and constraint kept, marked `· gist of 2.5k chars`.
- **Long English gets its main fixes** (up to five, `"add timeout" → "add a timeout"`) instead of a
  full rewrite.

Prompts shorter than three English words (`ok`, `commit it`), slash commands, and work done by a
delegated subagent are left alone.

## Turn it off

Type `/prompt-en` in the composer to flip it (`/prompt-en on`, `/prompt-en off`). The choice is
remembered across sessions.

## Settings

Set these on the plugin's row in your profile patch (`cordis.patch.yml`):

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the feature off without uninstalling. |
| `reviewEnglish` | `true` | `false` keeps translations and stops reviewing English prompts. |
| `provider` / `model` | your session's | Which model writes the line. Set both to use a cheaper model. |
| `reasoningEffort` | model default | Pin a reasoning effort, e.g. `low`. |

```yaml
- id: prompt-en
  config:
    enabled: true
    reviewEnglish: true
    # provider: magpie
    # model: auto/deepseek-flash
    # reasoningEffort: low
```

## Cost

One small model request per prompt that needs a line, billed like any other request. Each distinct
prompt text is read once and cached, so repeating `继续` or reopening a session costs nothing.

## If something looks wrong

- **`no translation (empty-reply)`** — the model returned no text. It is retried once
  automatically; if the line still fails, send the prompt again or write it slightly differently.
- **No line at all** — prompts sent before installation are not backfilled, and prompts under three
  English words are skipped on purpose. Also check the plugin is enabled in **Plugins → Installed**.
- **The line sits in the wrong place or is missing after an update** — refresh the page; the row is
  drawn by the Web Client half.
- **French or Spanish is reviewed as English** — the language is detected by script, not by a
  language model, so only non-Latin scripts are translated.

## How it works

The Host half sees each committed user message, folds pastes, and asks your model once to translate
or review it. The answer is cached on disk and served to the page; the Client half draws it under
the prompt. It never writes to the session log and never changes what the conversation model sees.

<details>
<summary>Development</summary>

Repository layout, tests, and the release checklist are in
[DEVELOPMENT.md](../../DEVELOPMENT.md). This plugin is a DeepSeek Harness port of the same author's
Claude Code mod [prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en) (MIT).

</details>
