# DSH Plugins

English | [简体中文](README.zh-CN.md)

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
| [Prompt EN](plugins/prompt-en) · 0.1.0 | English under every prompt: a translation when you write in another language, or a review with corrections and better alternatives when you write in English. |

More plugins are added here as they are ready. Each one installs and is versioned on its own, and
the index pins the exact commit it releases from, so new plugins never change an old install.

## What they have in common

- They run in the **Web UI** (the desktop app, or `dsh web`).
- They are display-only unless their README says otherwise: no writes to the Session log and
  nothing added to what the conversation model reads.
- Plain JavaScript, MIT, source in this repository.

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

MIT.
