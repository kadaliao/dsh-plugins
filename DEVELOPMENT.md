# Development

English | [简体中文](DEVELOPMENT.zh-CN.md)

Maintainer notes for this collection. If you only want to use a plugin, the
[README](README.md) is the page you want.

## Repository layout

Every directory under `plugins/` is a complete, independent DeepSeek Harness bundle:

```
plugins/<name>/
  package.json         # name, exports, dsh.bundle.patch, dsh.client
  cordis.patch.yml     # Loader rows the bundle inserts
  index.js             # Host half (runs in the Harness process)
  client.js            # Web Client half (window.__ModuleLoader__)
  lib/                 # Host-side modules
  locale/*.json        # display metadata and UI dictionaries
  icon.svg
  README.md            # user-facing: behavior, install, settings, limits
  README.zh-CN.md
  test/                # pure-logic and client-render tests
```

The Host half registers routes and listeners on its plugin fiber. The Client half registers
Conversation rows or slots. Neither writes to the Session log; derived text is cached outside it.

## Requirements

- Node.js 22+ for the tests (no build step, no dependencies).
- A DeepSeek Harness 0.2.x checkout or installation to load a working copy.
- The Web profile for anything with a Client half; the headless profile has no transcript.

## Run the tests

```bash
cd plugins/prompt-en
node --test test/*.test.mjs
```

The client tests load `client.js` with a small module-loader and React stand-in, so they catch
registration mistakes and rendering regressions without a browser.

## Load a working copy

Install the plugin directory with the Harness plugin manager (Plugins → install from a folder, or
the `plugin_manager` tool). A linked directory is picked up on the next plugin reload; a Client-half
change also needs a page refresh unless the Web dev watcher is running.

For a release, install the commit-pinned Git spec exactly as the market index lists it — that is
also the only path users take, so test it before publishing a version.

## Add a plugin

1. Copy an existing plugin directory as a starting point.
2. Rename the package (`@kadaliao/dsh-<name>`), the bundle row in `cordis.patch.yml`, and the
   `window.__ModuleLoader__.load({ id })` in `client.js`. The client module id must equal the
   package name.
3. Add user-facing `README.md` and `README.zh-CN.md`, locale `meta.title`/`meta.description`, and an
   original or licensed icon.
4. Keep everything the model could see out of the Session log, and say in the README exactly what
   the plugin reads and which model it calls.
5. Run the tests, then install the directory and exercise the real UI before publishing.

## Market index

`marketplace.json` is the format-1 index the Discover tab reads. Each version pins an exact commit:

```json
{
  "version": "0.1.0",
  "publishTimestamp": 1792855428,
  "source": {
    "type": "git",
    "url": "https://github.com/kadaliao/dsh-plugins",
    "commit": "<40-hex commit that contains the plugin>",
    "path": "plugins/prompt-en"
  }
}
```

`publishTimestamp` is Unix **seconds**. Validate the document with Harness's own parser
(`@deepseek-ai/dsh-plugin-market-index`) before pushing — it rejects a non-canonical URL, a missing
`en` title, a bad commit, or a path segment with unsupported characters.

## Release checklist

1. Bump the plugin's `version` and update its README if behavior changed.
2. Run the tests.
3. Commit and push the code.
4. Set the index entry's `source.commit` to that commit, commit and push the index.
5. Install from the index's Git spec in a clean profile and confirm the plugin appears and works.
6. Never rewrite a published commit; publish a new version instead.

## License

MIT. Prompt EN is a DeepSeek Harness port of the same author's Claude Code mod
[prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en), also MIT.
