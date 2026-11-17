# DSH Plugins

English | [简体中文](README.zh-CN.md)

[![test](https://github.com/kadaliao/dsh-plugins/actions/workflows/test.yml/badge.svg)](https://github.com/kadaliao/dsh-plugins/actions/workflows/test.yml)

A growing collection of plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
small, focused additions to the chat, the composer, and the workspace.

## Install

1. Turn on the marketplace once: **Plugins → Experimental plugins → Custom plugin markets**.
2. Open the new **Discover** tab, then **Sources**, and add:

   ```
   https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
   ```

3. Install the plugin you want from Discover.

Already know what you want? Paste the plugin's Git spec into the plugin manager instead:

```
git+https://github.com/kadaliao/dsh-plugins.git#main&path:/plugins/prompt-en
```

## Plugins

| Plugin | What it does |
| --- | --- |
| [Archify](plugins/archify) · 0.2.0 | Ask for a diagram and get a checked, interactive page right in the conversation: [Archify](https://github.com/tt-a1i/archify)'s architecture, workflow, sequence, data-flow, state, ER, class, tree, timeline and waterfall diagrams, from a description, Mermaid or your code, or a one-page explainer. Bundles the Archify skill and renders it with the Harness's own runtime (no Node.js install); pages open full screen, in the browser or as a download, and collect in an Archify panel. Fast by default: architecture diagrams are laid out by the plugin, so the model writes only boxes, arrows and groups; the first passing page is the answer, and a repair budget keeps fixes short. |
| [Bots](plugins/bots) · 0.10.0 | Grok-style bot teams for one-person companies and role-split work: hire a ready-made team (one-person company, software squad, content studio, research desk) in one click, each bot with its own persona, avatar, model, skills, abilities, apps and scheduled tasks — and its own memory, summarized after every task and consolidated nightly with the team's shared memory. Bots message each other and a dispatcher hands out the work: each piece of delegated work is a task in a conversation of its own, so one bot works on several at once, the dispatcher stays free to answer you, results return to the chat that asked, and a watchdog catches stuck tasks. The panel chat reads like a chat app, the bot on the left and you on the right: reply to any message and your reply quotes it, while the bot answers in a thread that sees the chat up to that message and nothing after; the bot doing the work answers in the chat or thread the request came from. Built on Harness: reuse your installed skills, import skills from GitHub or a local folder or let a bot write its own, and import MCP servers from Codex, Claude Code or Cursor. Run a bot on your own endpoint or the Codex CLI's ChatGPT login; conversations start a new topic before they grow too big; a usage view counts tokens and cost by bot, task and day. Message the team from Feishu / Lark, Telegram, Slack or Discord. Bilingual. |
| [Images](plugins/images) · 0.5.5 | Ask for a picture and get one: a `generate_image` tool for the model, backed by your provider's image model, with the picture shown in the conversation and an **Images** panel collecting everything drawn as a gallery to browse, enlarge and download. A settings drawer picks the provider, key and model (searchable as you type), and every picture shows what it cost, with the public LiteLLM price list covering models the provider does not price. Ask for a GIF and it draws a sprite sheet and assembles a looping animated GIF from it; pass reference images (attachments, files, earlier results) to edit or build on them. |
| [Prompt EN](plugins/prompt-en) · 0.2.0 | English under every prompt: a translation when you write in another language, or a review with corrections and better alternatives when you write in English. What it teaches goes into a vocabulary book you review with `/vocab`. |

More plugins are added here as they are ready. Each one installs and is versioned on its own, and
every version in the index pins its own source — an npm package version now, a Git commit for older
releases — so adding a plugin never changes an install you already have.

## What they have in common

- They run in the **Web UI** (the desktop app, or `dsh web`).
- They are display-only unless their README says otherwise: no writes to the Session log and
  nothing added to what the conversation model reads.
- Plain JavaScript, MIT, source in this repository. Archify also bundles a copy of the Apache-2.0
  Archify skill and the EPL-2.0 elkjs layout engine; its README says what is included.

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

Issues, plugin ideas and pull requests are welcome. Repository layout, how to add a plugin, tests,
and the release checklist live in [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT. `plugins/archify/archify/` is Apache-2.0 (Archify by tt-a1i); `plugins/archify/vendor/elkjs/` is used under EPL-2.0.
