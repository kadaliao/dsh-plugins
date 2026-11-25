# Development

English | [简体中文](DEVELOPMENT.zh-CN.md)

Maintainer notes for this collection. If you only want to use a plugin, the
[README](README.md) is the page you want.

## Where things live

This repository is the index of the collection. Each plugin has a repository of its own:

| Plugin | Repository | npm package |
| --- | --- | --- |
| Archify | [kadaliao/dsh-archify](https://github.com/kadaliao/dsh-archify) | `@kadaliao/dsh-archify` |
| Atlas | [kadaliao/dsh-atlas](https://github.com/kadaliao/dsh-atlas) | `@kadaliao/dsh-atlas` |
| Bots | [kadaliao/dsh-bots](https://github.com/kadaliao/dsh-bots) | `@kadaliao/dsh-bots` |
| Images | [kadaliao/dsh-images](https://github.com/kadaliao/dsh-images) | `@kadaliao/dsh-images` |
| Prompt EN | [kadaliao/dsh-prompt-en](https://github.com/kadaliao/dsh-prompt-en) | `@kadaliao/dsh-prompt-en` |

What stays here:

- `marketplace.json`, the market index users add in Discover. Its URL never changes.
- `plugins/<name>/README.md`, a pointer to the plugin's repository, so links in packages already
  published and in older posts still lead somewhere.
- The history. Until the move (commit `71d4c76`, 2026-11-18) every plugin's source lived under
  `plugins/<name>/` here, and older index versions pin commits from that time. **Never rewrite or
  force-push `main`**: an install pinned to one of those commits would stop resolving.

The plugin repositories were split out with their history (`git filter-repo --subdirectory-filter`),
so `git log` and `git blame` there go back to the first commit.

## A plugin repository

Every plugin repository is one complete, independent DeepSeek Harness bundle at its root:

```
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

Requirements: Node.js 22+ for the tests (no build step, no dependencies), and a DeepSeek Harness 0.2.x
installation with the Web profile to load a working copy.

### Run the tests

```bash
node --test test/*.test.mjs
```

The client tests load `client.js` with a small module-loader and React stand-in, so they catch
registration mistakes and rendering regressions without a browser. Each repository runs them in
GitHub Actions on every push.

### Load a working copy

Install the repository directory with the Harness plugin manager (Plugins → install from a folder,
or the `plugin_manager` tool). A linked directory is picked up on the next plugin reload; a
Client-half change also needs a page refresh unless the Web dev watcher is running.

To try a change without touching your own profile, link the plugin into a throwaway Harness home
with the desktop app's CLI, then boot it:

```bash
DSH=/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh
export DSH_HOME=$(mktemp -d)
"$DSH" plugin --profile web add "$PWD"
"$DSH" web --no-open --port 3917   # open the printed URL
```

It has no model credentials, so only UI that needs no model can be checked there.

### Update reminders (shared code)

Every plugin's `client.js` carries the same block between `// >>> kadaliao-dsh-updates` and
`// <<< kadaliao-dsh-updates`. `apply(ctx)` calls it once,
`const updates = kadaliaoUpdates(ctx, { React, name, reopen })`, and wraps the plugin's own view where it
registers it: `updates.opens(withT(Panel))` (Prompt EN wraps its vocabulary tab). Each plugin checks only
itself, and only when that view mounts: Harness's plugin manager (`listVersions`) is asked once, again
only after a minute, and nothing runs on a timer. A newer version shows as a bar across the top of the
view, and **Update** runs `updateBundle`.

Harness closes the view when it removes the running version, so an update in progress lives on
`window.__kadaliaoDshSelfUpdate`. The new client half finds it there, calls `reopen` (the plugin's own
`openPanel`) and says how the update ended. That object is shared across versions: add to its shape,
never change it. Versions before this block checked every installed plugin every six hours and drew
one shared card (`window.__kadaliaoDshUpdates`); those copies keep doing so until they are updated.

The block is maintained here, in `shared/updates.js`, with its tests in `shared/updates.test.mjs`.
Edit it here, then copy it into the clones beside this repository (`../dsh-<name>`):

```bash
node --test shared/updates.test.mjs
node scripts/sync-updates.mjs          # writes client.js and test/updates.test.mjs in each clone
node scripts/sync-updates.mjs --check  # exits 1 while a clone differs
```

To try a real update without publishing, publish the plugin to a local registry (verdaccio, with
`@kadaliao:registry=` in the throwaway profile's `.npmrc`) at two versions, install the older one, set
both versions' `time` in verdaccio's storage back past the ten minutes below, open the plugin and press
**Update**.

## Add a plugin

1. Create `kadaliao/dsh-<name>` on GitHub, starting from a copy of an existing plugin repository.
2. Rename the package (`@kadaliao/dsh-<name>`), the bundle row in `cordis.patch.yml`, and the
   `window.__ModuleLoader__.load({ id })` in `client.js`. The client module id must equal the
   package name. Point `repository`, `homepage` and `bugs` in `package.json` at the new repository.
3. Add user-facing `README.md` and `README.zh-CN.md`, locale `meta.title`/`meta.description`, and an
   original or licensed icon.
4. Keep everything the model could see out of the Session log, and say in the README exactly what
   the plugin reads and which model it calls.
5. Run the tests, then install the directory and exercise the real UI before publishing.
6. Publish it to npm and add an entry to `marketplace.json` and a row to both READMEs here.

## Market index

`marketplace.json` is the format-1 index the Discover tab reads. Each plugin entry lists every
version with its own source, so a release never changes how an earlier one installs. Releases go
to npm:

```json
{ "version": "0.2.0", "publishTimestamp": 1794700000, "source": { "type": "npm" } }
```

Discover installs that as `<name>@<version>`, so the entry's `name` must be the package name on the
registry. `publishTimestamp` is Unix **seconds**.

Older versions keep the Git source they were released with — a commit in this repository and the
plugin's path at that time:

```json
{
  "version": "0.1.0",
  "publishTimestamp": 1792855428,
  "source": {
    "type": "git",
    "url": "https://github.com/kadaliao/dsh-plugins",
    "commit": "e4f18e7f79204d02602ac9be8e988195e1f1d32f",
    "path": "plugins/prompt-en"
  }
}
```

Leave those entries as they are. Validate the document with Harness's own parser
(`@deepseek-ai/dsh-plugin-market-index`) before pushing — it rejects a non-canonical URL, a missing
`en` title, a bad commit, or a path segment with unsupported characters. CI here checks the basics
(`node scripts/check-index.mjs`).

## Release checklist

In the plugin's repository:

1. Bump `version` in `package.json` (Bots also keeps `BOTS_VERSION` in `client.js` and its test in
   step) and update the README if behavior changed.
2. Run the tests.
3. Commit and push.
4. `npm publish --access public`. The registry can take a few minutes to serve the new version.
   The update bar offers a version once it has been public for 10 minutes, so the tarball is served
   by the time anyone presses **Update** (a failed install puts the old version back).

Before step 1, `node scripts/sync-updates.mjs --check` here should report the plugin up to date.

Then in this repository:

5. Add the version to the plugin's `versions` in `marketplace.json` with `"source": { "type": "npm" }`,
   and update the version and description in `README.md` / `README.zh-CN.md`.
6. Commit and push.
7. Install from the index in a clean profile and confirm the plugin appears and works.
8. Never rewrite a published commit, here or in a plugin repository; publish a new version instead.

## License

MIT. Prompt EN is a DeepSeek Harness port of the same author's Claude Code mod
[prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en), also MIT.
