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
| [Archify](https://github.com/kadaliao/dsh-archify) · 0.4.1 | Ask for a diagram and get a checked, interactive page right in the conversation: [Archify](https://github.com/tt-a1i/archify)'s architecture, workflow, sequence, data-flow, state, ER, class, tree, timeline and waterfall diagrams, from a description, Mermaid or your code, or a one-page explainer. Or skip the prompt: in the Archify panel, pick a type (each card shows what it looks like, with a live example), optionally a project folder to draw from its code, and press Generate; the plugin scans the repository, starts the conversation and follows it. In the gallery, Edit changes a diagram through the conversation that drew it, and Review has the model review an architecture from its code: every point cites files and lines, and the plugin checks each citation. Fast by default: architecture diagrams are laid out by the plugin, schema slips and repository evidence are fixed before checking, and a one-call repository scan with a code map spares the model its exploring. Bundles the Archify skill and runs on the Harness's own runtime (no Node.js install). Bilingual. |
| [Atlas](https://github.com/kadaliao/dsh-atlas) · 0.1.5 | Your Photos library on a night globe that zooms to street level: glowing footprints, thumbnails where you were, 3D terrain and buildings, the venues and landmarks from your own photos, and Wikipedia nearby. Trips you can replay as a story, a replay of your years chapter by chapter, and on this day in your photos and in world history near places you have been. The best photos come first wherever you look; search like you talk (Chinese words can run together), and the model can search your photos and move the map. Night OpenStreetMap, Amap (China in full detail), satellite or offline. macOS Photos, read-only. Bilingual. |
| [Bots](https://github.com/kadaliao/dsh-bots) · 0.17.5 | Grok-style bot teams for one-person companies and role-split work: hire a ready-made team (one-person company, software squad, content studio, research desk) in one click, each bot with its own persona, avatar, model, skills, abilities, apps and scheduled tasks — and its own memory, summarized after every task and consolidated nightly with the team's shared notes and each project's own memory (notes about something with a date are forgotten after it). Bots message each other and one dispatcher hands out the work of every team you hire, through the team's lead; a bot you make yourself joins any team you hired, or a team of your own with your name, description and colour: each piece of delegated work is a task in a conversation of its own, so one bot works on several at once, the dispatcher stays free to answer you, results return to the chat that asked, and a watchdog catches stuck tasks. A board, one level above the tasks, shows everything you asked the team for as a card, restated in a line by the dispatcher, with how far it got and what waits for you; cards are filed under projects with their own folder and brief and numbered like OPC-12, so a message can name one, a card can wait for others, and labelled GitHub issues become cards, on github.com or GitHub Enterprise. The panel chat reads like a chat app, the bot on the left and you on the right, and takes images you paste or drop, which the bot sees and hands on with the work: reply to any message and your reply quotes it, while the bot answers in a thread that sees the chat up to that message and nothing after; the bot doing the work answers in the chat or thread the request came from. Built on Harness: reuse your installed skills, import skills from GitHub a local folder or Magpie's library, or let a bot write its own, and import MCP servers from Codex, Claude Code or Cursor. Run a bot on your own endpoint or the Codex CLI's ChatGPT login; conversations start a new topic before they grow too big; a usage view counts tokens and cost by bot, task and day. Message the team from Feishu / Lark, Telegram, Slack or Discord. Bilingual. |
| [Images](https://github.com/kadaliao/dsh-images) · 0.5.7 | Ask for a picture and get one: a `generate_image` tool for the model, backed by your provider's image model, with the picture shown in the conversation and an **Images** panel collecting everything drawn as a gallery to browse, enlarge and download. A settings drawer picks the provider, key and model (searchable as you type), and every picture shows what it cost, with the public LiteLLM price list covering models the provider does not price. Ask for a GIF and it draws a sprite sheet and assembles a looping animated GIF from it; pass reference images (attachments, files, earlier results) to edit or build on them. |
| [Prompt EN](https://github.com/kadaliao/dsh-prompt-en) · 0.2.2 | English under every prompt: a translation when you write in another language, or a review with corrections and better alternatives when you write in English. What it teaches goes into a vocabulary book you review with `/vocab`. |

More plugins are added here as they are ready. Each one has its own repository, installs and is
versioned on its own, and every version in the index pins its own source — an npm package version
now, a Git commit in this repository for older releases — so adding a plugin, or moving one to its own
repository, never changes an install you already have.

## What they have in common

- They run in the **Web UI** (the desktop app, or `dsh web`).
- They are display-only unless their README says otherwise: no writes to the Session log and
  nothing added to what the conversation model reads.
- They tell you when a new version is out: a card in the bottom-right corner, one for all of them,
  whose **Update** has Harness install the new version (and put the old one back if that fails).
- Plain JavaScript, MIT, source in each plugin's repository. Archify also bundles a copy of the
  Apache-2.0 Archify skill and the EPL-2.0 elkjs layout engine; its README says what is included.

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
