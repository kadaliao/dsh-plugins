---
name: archify
description: "Create validated architecture, workflow, sequence, data-flow, lifecycle/state, ERD, class, tree, timeline, and waterfall diagrams as explorable standalone HTML with dark/light themes, motion and image/SVG/WebM export. Accept requirements or Mermaid; inspect repository evidence for code-backed diagrams. Use when visualizing systems, API calls, pipelines, schemas, histories, timings, or everyday steps, parts, relationships and states (画架构图、流程图、时序图、数据流图、状态图、ER 图、类图、树图、时间线、瀑布图). Also turn an answer into a one-page explainer, with the conclusion first, structured panels, native diagrams and charts, when the user asks for a page, an explainer or an answer to share (做成一页, 用页面讲), or proactively when the user's rules opt in with an [archify explainer: ...] line. Not for dashboards."
license: Apache-2.0
metadata:
  version: "3.2"
  author: tt-a1i
  edition: "DeepSeek Harness, adapted by @kadaliao/dsh-archify"
---

# Archify

Create checked standalone HTML as a native diagram or a one-page explainer that answers a question.

## In DeepSeek Harness

This copy of Archify runs through two tools. Use them instead of `node bin/archify.mjs` in a shell: Node.js may not be installed, and the tools already know where Archify lives.

- `archify_render` is the `finalize` command. Wherever a reference shows `node …/archify.mjs finalize <type> <candidate> <output> …` (or a standalone `deliver`), call `archify_render` instead. It picks the folder and output path, runs every gate (validate, deliver, strict check, and the real-browser check when Chrome, Chromium or Edge is installed), keeps review evidence in its own `review-<n>` folder on repeat runs, and returns the compact receipt. A delivered page is shown to the user in the conversation, with a full-screen view, a new-tab view and download, and in the Archify panel.
- `archify_cli` runs any other Archify command with the bundled runtime. Pass the arguments that follow `archify`: `["guide", "<scenario>", "--json"]`, `["brands", "<name>", "--json"]`, `["compare", "architecture", "<base.json>", "<head.json>", "<delta.html>", "--json"]`, `["patch", "explainer", …]`, `["visual-check", "<page.html>", "--summary", "--out-dir", "<folder>/visual-check"]`.

Relative paths in this skill and its references (`references/…`, `schemas/…`, `examples/…`) resolve against the skill's base directory. Read them with your file-reading tool, several in one batch. Paths given to the tools resolve against the working directory.

- **New request**: pass the complete candidate to `archify_render` as `spec` (the JSON object; for an explainer, the Markdown draft as `markdown`) with a short Latin `name`. The tool writes it to `.archify/<type>-<name>-<YYYYMMDD-HHMMSS>/candidate.json` (or `candidate.archify.md`) under the working directory and delivers `<name>.html` next to it. Each new request gets a new folder.
- **Repair**: edit that candidate file in place with your file-editing tool, keeping everything the diagnostics do not name, then call `archify_render` with `candidate` set to its path. Same folder, same page.
- **Existing candidate** the user supplies: call `archify_render` with `candidate` set to it.

## Choose the artifact

- When the user asks to draw or visualize a system, flow, schema or history, use a native diagram and the Type router.
- Use `explainer` when the user asks for the answer as a page: a page, one page, an explainer, something to share (“做成一页”, “用页面讲”, “answer with a page”). Without such a request, answer in text or draw the requested diagram.
- A rules line in context changes this. `[archify explainer: proactive]`: also make a page, unasked, for an explanation, comparison, trade-off, decision, diagnosis, review or plan that needs a table, steps or several sections. `[archify explainer: always-on]`: every reply that reaches a conclusion also gets a compact page of at most four panels, its link closing the reply. `[archify explainer: on-demand]`: only when asked.
- In every mode a page needs a conclusion with some structure behind it: chat, one-line answers, raw command output and text-only requests get none.
- For `explainer`, read [Explainer authoring](references/explainer-authoring.md) for its conclusion, reasons, scope, board layout and optional native diagrams. Write the complete draft, then deliver it with `archify_render` (type `explainer`). For a local content revision of one panel, use panel patch through `archify_cli`.

## Native diagram authoring

Use this path for ordinary generation. Read branch references only when their stated trigger applies.

For a native diagram of a real codebase, read [Repository authoring](references/repository-authoring.md) while tracing the requested behavior. `archify_render` checks cited sources against the working directory's Git root; pass `repoRoot` when the repository is elsewhere (a subfolder, or the working directory is not a Git repository).

1. Choose `architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle`, `erd`, `class`, `tree`, `timeline`, or `waterfall` from the question.
2. Use the exact schema and example paths in the Type router without listing their directories. Read [Authoring defaults](references/authoring-defaults.md) and the mode's example in one batch, separate from project documents and complete schemas so neither is truncated; recover any missing section before writing. For Architecture, use the matching showcase example. For every mode except Architecture, also read the mode and common schemas (`schemas/common.schema.json`). Read the relevant schema definition before choosing any new field, enum, or constrained text, especially boundary kinds. Examples teach shape, not facts. Use fresh IDs, wording, and layout. Go directly to the candidate without preliminary help, doctor, starter validation, temporary diagrams, or output-path listing. Query brands only for an explicitly requested mark; read [Brand marks](references/brand-marks.md) for an unknown mark with a user-provided URL.
3. Once the requested scope and, for a real codebase, [source evidence](references/repository-authoring.md) are covered, write the complete candidate directly without planning coordinates in prose. Choose Architecture abstraction and connected placement using Authoring defaults before coordinates: show the main user journey and necessary branches, preserve control roles and behavior-changing conditions, and leave enough room for actual relationship labels. No node, relationship, source, view, card, or boundary count is a target or ceiling. Use automatic routes first; add explicit routing only for necessary branch, return, supplied geometry, or measured repair. Set `meta.quality_profile` to `"showcase"` unless the user requests dense `standard`. For ERD, use a table-first layout: show every physical column in `entities[].attributes`, keep its SQL type and source comment, state every key role a column carries (`key` takes a role or a list, so a junction column is `["pk", "fk"]`, and every `fk` column also needs `references` like `"orders.id"`), and never move columns into cards as a substitute for the table. Classify tables into functional domains before placement, give each domain a concise `tag`, and place its members in one solid rectangle of grid cells — a single row, a single column, or a filled rectangular block, not an L or diagonal. A tagged table always needs `row`/`col`, because absolute coordinates have no grid cells and a domain whose tables do not fill one rectangle cannot be drawn as a band: the renderer reports `erd/domain-not-drawn` instead of publishing a diagram that cannot name the domain. A multi-domain schema reads best as one domain per column — each `tag` a vertical run — because the reader scales a wide canvas up to the reader width and shrinks a tall one until the page fits. A schema-first ERD over roughly 8 tables or 50 fields is itself a dense map: author its first complete-field pass at `standard` and upgrade only once the layout still reads.
4. Once the complete first candidate is written, call `archify_render` with `type`, `spec`, `name` and the `quality` that matches `meta.quality_profile` (default `showcase`). Its first gate is showcase validation; successful first drafts need no separate pre-validation. A passing receipt proves the included validate, deliver, strict check, and real-browser browser-check gates passed (the browser check is reported as skipped when no Chrome-family browser is installed; the page is still delivered).
5. A failed result is never success. Read the receipt's diagnostics and `nextAction`, then [repair the failed gate](references/delivery-contract.md#failed-finalize-and-candidate-repair), including its repair limit. Preserve requested meaning and source evidence. For several tangled Architecture routes, read [Architecture layout repair](references/architecture-layout-repair.md); for measured field or geometry failures, read [Authoring contract](references/authoring-contract.md). Edit the connected neighborhood in the candidate file and call `archify_render` again with `candidate`. Coordinates carry order: in a Sequence, Timeline or Waterfall, when a diagnostic asks to spread values, move that element and every later one by the same amount (with the segment and activation bounds around them), so no reply ever moves above its request. The tool keeps the repair budget: from the third failed render of a candidate it asks you to switch it to `standard` and deliver, and from the eighth to stop and report what remains. Follow what its result says.

Before the first candidate, use the authoring references and relevant repository source, not Archify implementation or tests. Inspect Archify implementation (under the base directory) only if diagnostics remain unactionable after focused repairs.

## Type router

| Type | Use for | Schema | Example |
|---|---|---|---|
| `architecture` | Components, services, cloud/security boundaries, infrastructure; what something everyday is made of | `schemas/architecture.schema.json` | System descriptions, services, libraries, and CLI repos: `examples/web-app.architecture.json`; deployment repos: `examples/production-deployment.architecture.json` |
| `workflow` | Processes, approval gates, tool calls, runbooks, CI/CD; plans and step-by-step life processes | `schemas/workflow.schema.json` | `examples/agent-tool-call.workflow.json` |
| `sequence` | API call chains, request lifecycles, async traces, returns; back-and-forth between people | `schemas/sequence.schema.json` | `examples/cache-miss-request.sequence.json` |
| `dataflow` | Pipelines, ETL/ELT, lineage, governance, consumers; where money or documents go | `schemas/dataflow.schema.json` | `examples/product-analytics.dataflow.json` |
| `lifecycle` | State/status transitions, retries, waiting and terminal states; where an application or order stands | `schemas/lifecycle.schema.json` | `examples/deployment-release.lifecycle.json` |
| `erd` | Tables/entities, attributes, primary/foreign/unique keys, cardinality between them | `schemas/erd.schema.json` | `examples/orders.erd.json` |
| `tree` | Single-parent containment: repository/module trees, capability or feature breakdowns, org-style decomposition | `schemas/tree.schema.json` | `examples/payment-platform.tree.json` |
| `class` | Classes, interfaces, selected members, and dependency/association/inheritance/realization/composition between types | `schemas/class.schema.json` | `examples/payments.class.json` |
| `timeline` | When things happened: incident reviews, release histories, timestamped events on a proportional clock with source lanes | `schemas/timeline.schema.json` | `examples/payment-incident.timeline.json` |
| `waterfall` | Where the time went: span durations, overlap, and nesting of one request or agent run on a common time axis | `schemas/waterfall.schema.json` | `examples/checkout-request.waterfall.json` |

When choosing among native diagram types is ambiguous, run `archify_cli` with `["guide", "<scenario>", "--json"]`. Scenario proof examples are structural references, not facts to copy.

For an everyday subject, keep the same diagram modes and semantic types, then name them for the reader: use everyday `icon` values and `meta.legend` labels as in [Node icons](references/authoring-contract.md#node-icons). Ask for missing personal facts instead of inventing dates, amounts, or rules.

Write labels in the user's language. Set `meta.locale` (for example `zh-CN`) when the diagram's text is not English, so the viewer's own controls match.

## Mermaid input

Read Mermaid for topology and meaning, then author fresh Archify JSON; do not mechanically render Mermaid styling.

- `flowchart` / `graph` → `workflow`, or `architecture` for a component map.
- `sequenceDiagram` → `sequence`; participants become semantic participants and arrows become messages.
- `stateDiagram` → `lifecycle`; states and transitions retain meaning, not Mermaid style.
- `erDiagram` → `erd`; entity and relationship names, keys, and cardinality retain meaning, not Mermaid style.
- `classDiagram` → `class`; type kinds, selected members, and relationship kinds retain meaning, not Mermaid style.

## Delivery

Use `archify_render` for the first candidate and after a repair. It stops at the first non-passing gate, and a failed validation returns in about a second, so use it rather than a separate `validate` while repairing.

**A passing render is the deliverable: reply right away.** The user is waiting and already sees the page. Do not start visual checks, captures, image reads or another layout round on your own. When the receipt carried a review recommendation, end the reply with one short clause offering to tidy the layout.

A layout polish pass runs only when the user asks for one (“整理一下布局”, “tidy the layout”, “review it visually”):

- When a passing Architecture receipt reports `visualReviewRecommendation.signals.resolvedCrossovers`, copy the candidate aside and apply the hints in one edit that changes only node positions and sizes: every node, relationship (including its `from` and `to`), label, and source stays as it was. Call `archify_render` once more on the candidate. If that run fails, reports more crossings, or reports the same crossings with more `signals.routesOverSuggestedBends`, restore the copy and render it again. Do not start a second placement round.
- When `layoutReviewRecommendation.action` is `inspect-sequence-width`, follow [Sequence width review](references/delivery-contract.md#sequence-width-review).
- For perceptual review, use [Optional capture evidence](references/delivery-contract.md#optional-capture-evidence) through `archify_cli`.

Qualify any check claim as automated when perceptual review has not occurred.

For workflow viewport overflow, read [Workflow viewport repair](references/authoring-contract.md#workflow-viewport-repair) before the next layout edit.

Live motion is enabled by default for every rendered diagram; omit `meta.animation`. Read `references/viewer-runtime.md` only when the user explicitly asks for Share Cards, Route/Reach cards, motion, deep links, presentation, search/focus, or another Viewer Runtime feature.

## Output

Reply in the user's language, as briefly as the result allows. The diagram carries the content and the user already sees it in the conversation, so a single diagram usually needs one line, without the file path.

- When the user wants to understand a system or codebase rather than draw a described subject, add one or two sentences with the key takeaway. Skip sentences that only restate what the diagram obviously shows.
- State anything that changes how the diagram should be read: the abstraction level or deliberately omitted parts when a reader might expect them, illustrative rather than measured values, missing source evidence, or requested content dropped or merged during repair.
- Give the page's path only when the user asks where it is, or for several diagrams in one reply (then one compact line each).

Do not recap tool calls, repair rounds, hashes, quality profiles, or check lists; they stay in the receipts. If asked whether the diagram was verified, answer in one line, such as “Automated checks passed; not visually reviewed.” Claim visual inspection only when performed.

For an explainer, reply in two or three lines: the conclusion, then one line pointing at the page. Mention gates only when one failed or writing warnings remain; do not paste the draft.
