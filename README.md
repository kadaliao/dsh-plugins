# DSH Plugins

English | [简体中文](README.zh-CN.md)

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the ones I use
daily, published as a small collection.

## Install

DeepSeek Harness reads **plugin market indexes**: any HTTPS URL serving a format-1 JSON index.
Enable the Discover tab once (**Plugins → Experimental plugins → Custom plugin markets**), then
add this repository's index under **Discover → Sources**:

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

and install any plugin from the list. Every entry is pinned to an exact commit in this repository,
so installing later cannot silently pick up different code; each plugin also declares its own
version.

Without the market, install a plugin directory directly with the plugin manager, or from a
commit-pinned Git spec:

```
git+https://github.com/kadaliao/dsh-plugins.git#<commit>&path:/plugins/prompt-en
```

## Plugins

| Plugin | What it does |
| --- | --- |
| [Prompt EN](plugins/prompt-en) | English under every prompt: a translation when you write in another language, a correction or other ways to say it when you write in English. |

## How a plugin is laid out

Every directory under `plugins/` is a complete DSH bundle:

```
plugins/<name>/
  package.json         # name, exports, dsh.bundle.patch, dsh.client
  cordis.patch.yml     # the Loader rows the bundle inserts
  index.js             # Host half
  client.js            # Web Client half (window.__ModuleLoader__)
  lib/                 # host-side modules
  locale/*.json        # display metadata and UI dictionaries
  icon.svg
  README.md            # behavior, settings, limits
  test/                # pure-logic and client-render tests
```

The Host half registers routes and event listeners on its plugin fiber; the Client half registers
Conversation rows or slots. Neither writes to the Session log, and nothing a plugin computes is
sent to the conversation's model unless its README says so.

## Development

Each plugin is plain JavaScript with no build step. Tests run with Node's test runner:

```bash
cd plugins/prompt-en
node --test test/*.test.mjs
```

To load a working copy, install its directory with the Harness plugin manager; a linked directory
updates on the next plugin reload.

## License

MIT. Prompt EN is a DeepSeek Harness port of [prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en),
the same author's Claude Code mod.
