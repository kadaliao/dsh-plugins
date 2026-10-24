# DSH Plugins

English | [简体中文](README.zh-CN.md)

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Prompt EN

**English under every prompt you send.** Write in Chinese and get the English underneath. Write in
English and get a correction — or, if it already reads well, two other ways to say it.

```
> 帮我看看这个构建为什么失败
  EN  help me check why this build fails

> please help me check why the build is failed
  EN ✎  please help me check why the build failed · remove "is": "failed" is intransitive here

> Could you make this function async?
  EN ✓  also Make this function async. · Would you mind making this function async?
```

The line is for you only: the model still reads your prompt exactly as you typed it.

[Install Prompt EN →](plugins/prompt-en)

## Install a plugin

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

## Requirements

- DeepSeek Harness 0.2.x with the **Web UI** (the desktop app, or `dsh web`). These are chat and
  composer plugins; the headless profile has no transcript to draw in.
- A model configured in Harness. Plugins reuse your session's model unless their README says
  otherwise.

## Common questions

**The Discover tab is missing.** DeepSeek Harness ships custom markets as an experimental feature.
Enable **Custom plugin markets** under **Plugins → Experimental plugins** first.

**A plugin installed but does nothing.** Check it is enabled in **Plugins → Installed**. Client-side
plugins need one page refresh after installation; prompts sent before the install are not
backfilled.

**What gets sent where?** Each plugin's README states exactly what it reads and which model it
calls. Nothing a plugin computes is added to your conversation unless the README says so.

## Contributing

Issues and pull requests are welcome. Repository layout, how to add a plugin, tests, and the
release checklist live in [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT.
