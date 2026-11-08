# Images

English | [简体中文](README.zh-CN.md)

**Ask for a picture and get one.**

Gives the conversation model a `generate_image` tool backed by the image model your provider serves.
Say "draw me a poster for the launch" and the picture appears in the conversation, right where it
was made. Everything ever drawn is collected in an **Images** panel: a gallery to browse, enlarge
and download.

```
> 画一张海报：深蓝夜空下的灯塔，极简扁平风，标题写 "Night Shift"
  ▸ Completed in 24s
  [ the poster ]
  Here is the poster: a lighthouse under a deep-blue night sky, flat style, titled "Night Shift".
```

## Install

Add this repository's index in DeepSeek Harness (**Plugins → Discover → Sources**):

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

then install **Images**. The Discover tab is part of the experimental **Custom plugin markets**
feature; turn it on under **Plugins → Experimental plugins** if you don't see it.

Without Discover, paste the Git spec into the plugin manager:

```
git+https://github.com/kadaliao/dsh-plugins.git#main&path:/plugins/images
```

Then **name the image model** (see [Settings](#settings)) and refresh the page once.

## In the conversation

When you ask for an image, the model calls `generate_image` with a detailed prompt. While the
provider draws, a shimmering placeholder sits in the turn's process fold with the prompt under it.
When the picture arrives it is shown as a row of the conversation, above the model's reply, so it
stays visible after the fold closes. Several images (`n` up to 4) sit side by side.

Hover an image for its controls: **download** and a **⋯ menu** (download, copy the prompt). Click
it to enlarge; in the viewer, `←` `→` step between the images of that call and `Esc` closes.

The model also receives the picture (on a model that takes image input), so it can check its own
work and describe what it drew.

## The Images panel

**Images** in the left sidebar (or `/images`) opens a gallery of every picture generated in any
conversation, newest first, as a masonry grid of cards. Each card shows the prompt, the model, the
pixel size and when it was made. Hover a card for **download** and the **⋯ menu** (download, copy
prompt, remove from gallery); click it to enlarge and step through the gallery with the arrow keys.
The panel keeps itself up to date while open, and loads older images as you scroll.

Removing a picture from the gallery deletes the plugin's copy of it; the conversation it came from
still shows it, through the Harness attachment store.

## Settings

Set these on the plugin's row in your profile patch (`cordis.patch.yml`):

| Key | Default | What it does |
| --- | --- | --- |
| `model` | — | **Required.** The image model to ask for, as your provider names it: `gpt-image-1`, `gpt-image-1.5`, `doubao-seedream-4-0-250828`, … |
| `provider` | your session's | The provider route (an `llm-pi-ai` provider name) whose `baseURL` and key are used. Set it when the image model lives on another provider than the chat model. |
| `baseURL` / `apiKeyEnv` | from the provider | Override where the request goes and which credential signs it, for a provider that is not configured in Harness at all. |
| `size` | `1024x1024` | The size when the model does not ask for another (`1536x1024`, `1024x1536`, …). |
| `quality` | model default | A quality tier (`low`, `medium`, `high`) for models that take one. |
| `enabled` | `true` | `false` keeps the gallery but offers no tool to the model; `/images on` and `/images off` flip it at runtime. |
| `timeoutMs` | `180000` | How long one request may take. |

```yaml
- id: images
  config:
    model: gpt-image-1
    # provider: openai
    # size: 1536x1024
```

The request is an OpenAI-compatible `POST <baseURL>/images/generations` with `model`, `prompt`,
`size` and `n`, so any provider or gateway that serves that endpoint works, including local
gateways that route many vendors behind one base URL. The reply may carry the image inline
(`b64_json`) or as a URL; both are taken.

## Cost

Each call is one request to the image model, billed by your provider like any image generation.
Nothing else is called. The picture is also placed in the conversation for the model to see, which
costs the image-input tokens of your chat model; a text-only model gets a one-line placeholder
instead.

## If something looks wrong

- **`No image model is configured`** — set `model` on the plugin's row (see above) and reload the
  plugin.
- **`Provider "…" has no baseURL the images plugin can read`** — the session's provider is not an
  `llm-pi-ai` provider the plugin can see; set `provider` to one that is, or set `baseURL` and
  `apiKeyEnv` directly.
- **The provider answers `4xx`/`5xx`** — the message is the provider's own: a model the account
  cannot use, an unsupported `size` or `quality`, no quota. Change the setting it names.
- **The model does not draw and describes the image in words instead** — check `/images` says the
  tool is on, and that the plugin is enabled in **Plugins → Installed**. A model that was mid-turn
  when the plugin loaded sees the tool on its next turn.
- **The picture is not in the conversation after a page refresh** — the row is drawn by the Web
  Client half; refresh once more after installing or updating.
- **The Images panel is empty though pictures were made** — the gallery lives under
  `~/.dsh/cache/images/`; it is per DSH home, so a different `DSH_HOME` has a different gallery.

## How it works

The Host half registers `generate_image` in the Harness tool registry. On a call it reads the
provider's `baseURL` and credential reference from the live settings, resolves the key through the
credentials service, posts the request, and saves the bytes twice: in the Harness attachment store,
so the tool result carries the image itself (`{ type: 'image' }`) and the conversation shows it; and
under `~/.dsh/cache/images/files/`, with an index of prompt, model, size and session, which is what
the panel reads through loopback routes on the Harness web server.

The Client half draws the tool's card, the result row outside the turn fold, the sidebar entry and
the panel. Nothing is written to the Session log beyond the tool call and its result, which the
Harness records as for any tool.

<details>
<summary>Development</summary>

Repository layout, tests, and the release checklist are in
[DEVELOPMENT.md](../../DEVELOPMENT.md).

</details>
