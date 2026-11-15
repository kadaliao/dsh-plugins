# Bots

English | [简体中文](README.zh-CN.md)

Grok-style bots inside DeepSeek Harness: a team of bots that work together. Each bot has its own **avatar,
persona, skills, abilities, apps and scheduled tasks**, and its own conversation. Bots **message each
other**, and one of them, the **dispatcher**, splits the work, hands it out, follows up and reports back.

It is built for two situations:

- **A one-person company (OPC)**: you run a business alone and need a whole staff — engineering, growth,
  customers, finance — plus a chief of staff who briefs you every morning.
- **Work that is naturally split between roles**: code needs a builder, a tester and a reviewer; content
  needs a researcher, a writer and a designer; research needs a skeptic.

![Team templates](docs/en-teams.png)

## Hire a whole team in one click

Open the Bots panel (sidebar, or `/bots`), pick a team template and click **Hire this team**:

| Team | Members | Scheduled tasks it comes with |
| --- | --- | --- |
| **One-person company** | Atlas (chief of staff, dispatcher), Forge (engineer), Echo (growth), Harbor (customers), Ledger (finance) | Weekday 09:00 morning brief, Friday 17:30 weekly review, Monday market pulse, weekday inbox sweep, Monday numbers |
| **Software squad** | Lead, Builder, Tester, Review | — |
| **Content studio** | Editor, Scout (research), Quill (writer), Pixel (design) | Monday topic planning |
| **Research desk** | Desk (lead), Analyst, Market, Skeptic | — |

Hiring:

- creates the bots with bilingual personas, in your UI language;
- gives each member **the skills already installed in your Harness** that fit its role (deep-research,
  last30days, xlsx, high-signal-review, …), skipping and reporting any you don't have;
- imports role skills from [anthropics/skills](https://github.com/anthropics/skills) (webapp-testing,
  frontend-design, brand-guidelines, …) with their scripts;
- adds the apps the role needs (GitHub, Stripe, HubSpot, …), whose keys you fill in later;
- schedules the team's recurring tasks and makes its lead the dispatcher;
- offers to send the lead a kickoff message, so the team starts working right away.

![Chat](docs/en-chat.png)

## An example (one-person company)

> **You → Atlas**: We release the new version next week. Organise it.
>
> **Atlas → Forge**: Fix the three P1 bugs before release, review your own diff, merge by Wednesday.
>
> **Atlas → Echo**: Draft the launch post and three social posts in the founder's voice, by Thursday.
>
> **Atlas → Ledger**: For a week after release, check new subscriptions and refunds daily; flag anything odd.
>
> **Forge → Atlas**: The three bugs are fixed, tests pass, PR merged.
>
> **Atlas → You**: This week: bugs cleared; launch draft for your review tomorrow. Decision needed: do we raise the price?

Bots answer in the language you write in, so the same team works in Chinese and English
([中文示例](README.zh-CN.md#一段示例一人公司)).

## Built on what Harness already does

A bot is an ordinary Harness conversation, so everything Harness can do, a bot can do:

- **Abilities**: web search, files, running commands and code, Office documents, image generation,
  sub-agents and workflows, handing over files… switched per bot on its Profile tab (a reviewer bot
  that cannot run commands, for instance).
- **Skills**:
  - **Add from Harness**: pick from the skills you already installed (`~/.agents/skills`,
    `~/.dsh/skills`, …); referenced, not copied, so they stay up to date;
  - **Import from GitHub**: browse Anthropic's skills in one click, or paste any `owner/repo/path`; the
    whole skill folder comes along, scripts included;
  - **Let the bot write it**: describe what you need in a sentence; the bot writes it with skill-creator
    and saves it to itself;
  - writing one by hand is still possible, as the last resort.
- **Apps** add only the outside systems Harness doesn't reach on its own:
  - **Import from your other agents**: MCP servers you already configured in Codex, Claude Code,
    Claude Desktop, Cursor, Windsurf, Gemini CLI or opencode are found automatically; tick them,
    keys included;
  - **the gallery**:

| Category | Apps (🔑 = needs a key) |
| --- | --- |
| Sales & payments | Stripe 🔑, HubSpot CRM 🔑 |
| Team & office | Feishu / Lark 🔑, Notion 🔑, Slack 🔑, Memory |
| Build & ship | GitHub 🔑, Git, Supabase 🔑, Sentry 🔑, Context7 Docs |
| Research & content | Exa, Tavily 🔑, Brave 🔑, Firecrawl 🔑 |
| Computer & browser | Open Computer Use (operate macOS apps), Playwright |
| Data | PostgreSQL 🔑, SQLite |
| Maps & local | Amap 🔑, Baidu Maps 🔑 |
| Custom | Any local (stdio) or remote (Streamable HTTP) MCP server |

- **Schedules** are ordinary Harness scheduled tasks, also on the Automation page.
- **AI avatars**: with the [Images plugin](../images), draw a bot's avatar from its persona.

## How it works

- Each bot owns one ordinary Harness conversation, in the **Bots** workspace (`~/.dsh/bots/workspace`
  unless `workdir` is set).
- When it runs, the bot's persona and the team roster join its system prompt; its own skills, ability
  limits and apps apply to that conversation only. Edits apply at once; a new or changed app connects
  the next time the conversation starts.
- `bot_send_message` puts the text into the other bot's inbox and wakes it. Two bots may exchange at
  most 16 messages in 10 minutes, so conversations end.
- Every conversation gets `bot_list`, `bot_create`, `bot_update`, `bot_delete`, `bot_send_message`
  and `bot_schedule` to manage bots.

## Open Computer Use

[open-computer-use](https://github.com/kadaliao/open-computer-use) lets a bot operate macOS apps through
the accessibility tree. Click **Install now** on its card, then grant **DeepSeek Harness** Accessibility
permission and restart it.

## What it stores and sends

- `~/.dsh/cache/bots/`: `bots.json` (bots, including keys entered for apps), `messages.jsonl`
  (timeline), `avatars/`, `skills/` (skills imported from GitHub).
- Nothing leaves your machine except through the bots' own conversations (your configured model), the
  apps you connect, the image model when you generate an avatar, and GitHub when you import skills.

## Install

Add this repository's index in DeepSeek Harness (**Plugins → Discover → Sources**):

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

then install **Bots**. The Discover tab is part of the experimental **Custom plugin markets**
feature; turn it on under **Plugins → Experimental plugins** if you don't see it.

Without Discover, paste the Git spec into the plugin manager:

```
git+https://github.com/kadaliao/dsh-plugins.git#main&path:/plugins/bots
```

Refresh the page once after installing. For AI avatars, install [Images](../images) too.

## Limits

- Web UI only.
- Group chats between bots are not there yet; bots collaborate through direct messages.
- Harness skills a team template names that you don't have are skipped; import them from GitHub or have
  the bot write them later.
