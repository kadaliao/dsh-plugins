# DSH Plugins

English | [简体中文](README.zh-CN.md)

[![index](https://github.com/kadaliao/dsh-plugins/actions/workflows/test.yml/badge.svg)](https://github.com/kadaliao/dsh-plugins/actions/workflows/test.yml)

A growing collection of plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
small, focused additions to the chat, the composer, and the workspace. This repository is the index;
each plugin lives in a repository of its own.

## Install

1. Turn on the marketplace once: **Plugins → Experimental plugins → Custom plugin markets**.
2. Open the new **Discover** tab, then **Sources**, and add:

   ```
   https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
   ```

3. Install the plugin you want from Discover.

Already know what you want? Paste the plugin's package name into the plugin manager instead:

```
@kadaliao/dsh-prompt-en
```

## Plugins

| Plugin | What it does |
| --- | --- |
| [Bots](https://github.com/kadaliao/dsh-bots) · 0.10.2 | Grok-style bot teams for one-person companies and role-split work: hire a ready-made team (one-person company, software squad, content studio, research desk) in one click, each bot with its own persona, avatar, model, skills, abilities, apps and scheduled tasks — and its own memory, summarized after every task and consolidated nightly with the team's shared memory. Bots message each other and a dispatcher hands out the work: each piece of delegated work is a task in a conversation of its own, so one bot works on several at once, the dispatcher stays free to answer you, results return to the chat that asked, and a watchdog catches stuck tasks. The panel chat reads like a chat app, the bot on the left and you on the right: reply to any message and your reply quotes it, while the bot answers in a thread that sees the chat up to that message and nothing after; the bot doing the work answers in the chat or thread the request came from. Built on Harness: reuse your installed skills, import skills from GitHub or a local folder or let a bot write its own, and import MCP servers from Codex, Claude Code or Cursor. Run a bot on your own endpoint or the Codex CLI's ChatGPT login; conversations start a new topic before they grow too big; a usage view counts tokens and cost by bot, task and day. Message the team from Feishu / Lark, Telegram, Slack or Discord. Bilingual. |
| [Images](https://github.com/kadaliao/dsh-images) · 0.5.5 | Ask for a picture and get one: a `generate_image` tool for the model, backed by your provider's image model, with the picture shown in the conversation and an **Images** panel collecting everything drawn as a gallery to browse, enlarge and download. A settings drawer picks the provider, key and model (searchable as you type), and every picture shows what it cost, with the public LiteLLM price list covering models the provider does not price. Ask for a GIF and it draws a sprite sheet and assembles a looping animated GIF from it; pass reference images (attachments, files, earlier results) to edit or build on them. |
| [Prompt EN](https://github.com/kadaliao/dsh-prompt-en) · 0.2.0 | English under every prompt: a translation when you write in another language, or a review with corrections and better alternatives when you write in English. What it teaches goes into a vocabulary book you review with `/vocab`. |

More plugins are added here as they are ready. Each one has its own repository, installs and is
versioned on its own, and every version in the index pins its own source — an npm package version
now, a Git commit in this repository for older releases — so adding a plugin, or moving one to its own
repository, never changes an install you already have.

## What they have in common

- They run in the **Web UI** (the desktop app, or `dsh web`).
- They are display-only unless their README says otherwise: no writes to the Session log and
  nothing added to what the conversation model reads.
- Plain JavaScript, MIT, source in each plugin's repository.

## Requirements

- DeepSeek Harness 0.2.x with the Web UI.
- A model configured in Harness. Plugins reuse your session's model unless their README says
  otherwise.

## Common questions

**The Discover tab is missing.** Custom markets are an experimental feature in DeepSeek Harness.
Enable **Custom plugin markets** under **Plugins → Experimental plugins** first.

**A plugin installed but does nothing.** Check it is enabled in **Plugins → Installed**. Client-side
plugins need one page refresh after installation; prompts sent before the install are not
backfilled.

**What gets sent where?** Each plugin's README states exactly what it reads and which model it
calls. Nothing a plugin computes is added to your conversation unless the README says so.

## Contributing

Issues and pull requests about a plugin go to its repository; plugin ideas and anything about the
index, here. Where things live, how to add a plugin, tests, and the release checklist are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT.
