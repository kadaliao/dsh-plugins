# Archify

English | [简体中文](README.zh-CN.md)

**Ask for a diagram and get a checked, interactive page right in the conversation.**

Brings [Archify](https://github.com/tt-a1i/archify) by tt-a1i to DeepSeek Harness. Ask for an
architecture, workflow, sequence, data-flow, lifecycle/state, ER, class, tree, timeline or
waterfall diagram (from a description, from Mermaid, or from the code in your workspace), or
for a one-page explainer that answers a question. The conversation model writes the diagram as
Archify JSON, the plugin renders and checks it, and the page appears in the conversation with
light and dark themes, motion and export.

```
> 画一下这个仓库的运行时架构图
  ▸ Completed in 39s
  [ the architecture diagram, live ]   ⛶ Full screen · ↗ Browser · ⤓ · 📁 · ⧉
  The plugin has two halves: …
```

## Install

Add this repository's index in DeepSeek Harness (**Plugins → Discover → Sources**):

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

then install **Archify**. The Discover tab is part of the experimental **Custom plugin markets**
feature; turn it on under **Plugins → Experimental plugins** if you don't see it.

Without Discover, paste the Git spec into the plugin manager:

```
git+https://github.com/kadaliao/dsh-plugins.git#main&path:/plugins/archify
```

Refresh the page once after installing. There is nothing to configure: no Node.js install, no
key, no model of its own. Archify runs with the Harness's own JavaScript runtime.

## In the conversation

The plugin adds an `archify` skill to the skill catalog, so the model loads it when you ask for a
diagram or a page ("画个时序图", "draw the ERD of these tables", "用一页讲清楚……"). It then reads
the few Archify references it needs, writes the diagram, and calls `archify_render`.

- While it works, a card in the turn's process fold shows the diagram type, its title and the
  checks: validate, deliver, a strict artifact check, and a check in a real browser. A failed
  check lists Archify's diagnostics, and the model repairs the draft and renders it again.
- The delivered page appears as a row of the conversation, above the model's reply, so it stays
  visible after the fold closes. It shows just the drawing, in the Harness's light or dark theme,
  sized to the diagram. Double-click it, or press **Full screen**, for the whole Archify viewer:
  its toolbar, themes and presets, live motion, search, route tracing and export to PNG, SVG or
  WebM.
- The card's buttons: **Full screen**, **Browser** (opens the HTML file in your default browser),
  **Download**, **Show in folder** and **Copy path**.

Each page is a standalone HTML file that works offline, so you can send it to someone as is.

## The Archify panel

**Archify** in the left sidebar lists every page drawn in your conversations, newest first, with a
search box. Pick one to preview it; from there open it full screen, in the browser, in its folder,
or go back to the conversation it was drawn in. **Remove** only takes it off the list; the file
stays. `/archify` opens the panel.

## Fast by default

Archify's checks are strict, and repairing a layout is where a model spends its time. The plugin
keeps that bounded:

- **Architecture diagrams are laid out for the model.** The model writes only the boxes, the
  arrows and the groups; the plugin places them with [ELK](https://github.com/kieler/elkjs)'s
  layered layout (each group kept together, the main path top to bottom), tries four layouts
  against Archify's own checks in about a second, and keeps the passing one with the fewest
  crossings and detours. The positions go into `candidate.json`, so later edits still work: after
  a change to the text or the topology the diagram is laid out again, while positions you move by
  hand stay where you put them.
- **A passing page is the answer.** The model replies as soon as a page is delivered. It does not
  start visual reviews, screenshots or another layout round on its own. When Archify suggests
  tidying routes, the reply ends with an offer instead: say "整理一下布局" or "tidy the layout" to
  get that pass.
- **A repair budget.** From the third failed render of the same draft, the tool asks the model to
  switch it to Archify's `standard` profile, which leaves out the showcase-only polish checks
  (label clearance, corridor and crossing rules, canvas width), and deliver. From the eighth, it
  asks the model to stop and tell you what is left.
- **Rendering is quick.** A failed validation answers in about a second; a full pass, including
  the real-browser check, takes about three.

In our tests with DeepSeek-V4.1-Flash, an explainer page took about 20 seconds, a sequence diagram
about 50, an architecture diagram from a description about 20, and one traced from a small
repository about 40, at Archify's strict `showcase` profile. Before automatic layout, that last
one took between a minute and a half and four minutes and often ended at `standard`.

## Where the files go

Each request gets a folder in the conversation's working directory:

```
.archify/<type>-<name>-<YYYYMMDD-HHMMSS>/
  candidate.json            the diagram (candidate.archify.md for an explainer)
  candidate.layout.json     the layout the plugin wrote into it (architecture)
  <name>.html               the page
  <name>.*.json             Archify's delivery and check receipts
```

A repair rewrites the same page; a new request gets a new folder. The panel's list lives in
`~/.dsh/cache/archify/gallery.json`.

## What it reads and sends

- The plugin calls no model. The conversation's own model writes the diagram, reading Archify's
  references from the plugin folder and, for a diagram of your code, your files as it normally
  would.
- Rendering runs locally. Archify's update check is turned off: this copy is updated with the
  plugin. Archify goes online only to fetch a brand logo from a URL a diagram names.
- Nothing is added to what the model reads except the skill (when it loads it) and the tool
  results.
- Pages are served to the Harness page in a sandbox with their own origin: the viewer's scripts
  run, but nothing on a page can reach the Harness or its routes. The routes serve only pages the
  tool delivered.

## Tools

| Tool | What it does |
| --- | --- |
| `archify_render` | Renders, checks and delivers a page: Archify's `finalize`. Takes `type`, and either `spec` (the JSON, or `markdown` for an explainer) for a new page, or `candidate` (a path) to render an edited draft again. Optional `name`, `quality`, `repoRoot` (defaults to the working directory's Git root when the draft cites source files) and `output`. |
| `archify_cli` | Runs any other Archify command (`guide`, `brands`, `compare`, `patch`, `validate`, `visual-check`, `doctor`, …) with the bundled runtime. `preview`, which starts a live server, is refused. |

## Settings

On the plugin's row in your profile patch (`cordis.patch.yml`):

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | `false` offers neither tool to the model. |
| `skill` | `true` | `false` leaves the `archify` skill out of the catalog. |
| `timeoutMs` | `240000` | How long one Archify run may take. |

## If something looks wrong

- **The model runs `node …/archify.mjs` in a shell instead of the tool.** Another `archify` skill
  is winning: personal and project skills (`~/.dsh/skills/archify`,
  `~/.agents/skills/archify`, or `.dsh/skills` / `.agents/skills` in the project) outrank a plugin's. Rename or remove that copy to use this one.
  Installing the separate `@tt-a1i/archify-dsh` package next to this plugin also gives two
  `archify` skills; keep one.
- **The browser check says skipped.** No Chrome, Chromium or Edge is installed. The page is still
  delivered; only that gate did not run. Set `ARCHIFY_CHROME` to a browser's executable to use
  another one.
- **An architecture diagram has many crossings.** Some systems are tangled: a main path that runs
  in and out of a large group crosses itself whatever the layout. Ask for a tidy-up, or for fewer
  or smaller groups.
- **A dense diagram looks busy.** It was probably delivered at the `standard` profile after the
  repair budget. Ask for a tidy-up, or for a higher-level diagram with fewer nodes.
- **The panel says a file is gone.** The page was moved or deleted from the working directory.

## Bundled Archify

`archify/` is Archify 3.2.0 from `main` at the commit recorded in
[`archify/UPSTREAM.json`](archify/UPSTREAM.json), unmodified, minus its tests, pre-rendered example
pages, generator scripts and lockfile. [`skill/SKILL.md`](skill/SKILL.md) is its `SKILL.md` adapted
for Harness: the shell commands become the two tools, the update check and setup sections are
removed, and delivery stops at the first passing page. To refresh the copy from a checkout of
tt-a1i/archify:

```bash
node scripts/sync-archify.mjs /path/to/archify
```

`vendor/elkjs/` is `lib/elk.bundled.js` from [elkjs](https://github.com/kieler/elkjs) 0.12.1, the
Eclipse Layout Kernel compiled to JavaScript, unmodified. It loads only in the layout worker, a
separate process the plugin starts for each architecture layout.

## License

The plugin is MIT. `archify/` is Apache-2.0 with historical MIT grants, by tt-a1i: see its
`LICENSE`, `LICENSE-MIT`, `NOTICE` and `THIRD_PARTY_NOTICES.md`, and this plugin's
[NOTICE](NOTICE). `vendor/elkjs/` is used under the Eclipse Public License 2.0 (elkjs is offered
under EPL-2.0 or GPL-3.0-or-later): see `vendor/elkjs/LICENSE.md`.
