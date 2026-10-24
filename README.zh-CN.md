# DSH Plugins

[English](README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件。

## Prompt EN

**每条 prompt 下面多一行英文。** 用中文写，它给出英文；用英文写，它给出纠错——如果本来就写得好，
就给你两种更地道的说法。

```
> 帮我看看这个构建为什么失败
  EN  help me check why this build fails

> please help me check why the build is failed
  EN ✎  please help me check why the build failed · remove "is": "failed" is intransitive here

> Could you make this function async?
  EN ✓  also Make this function async. · Would you mind making this function async?
```

这一行只给你看：模型读到的仍然是你的原文。

[安装 Prompt EN →](plugins/prompt-en/README.zh-CN.md)

## 安装插件

1. 先启用一次市场：**Plugins → Experimental plugins → Custom plugin markets**。
2. 打开新出现的 **Discover** 标签页，在 **Sources** 里加入：

   ```
   https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
   ```

3. 在 Discover 里安装想要的插件。

已经知道要装什么，也可以直接把 Git spec 贴进插件管理器：

```
git+https://github.com/kadaliao/dsh-plugins.git#main&path:/plugins/prompt-en
```

## 环境要求

- DeepSeek Harness 0.2.x，并且使用 **Web UI**（桌面 App 或 `dsh web`）。这些插件画在对话和输入框里，
  headless profile 没有可以显示的位置。
- Harness 里已配置模型。除非插件 README 另有说明，插件默认复用当前会话的模型。

## 常见问题

**找不到 Discover 标签页。** 自定义市场在 DeepSeek Harness 里是实验功能，先在
**Plugins → Experimental plugins** 里打开 **Custom plugin markets**。

**插件装了却没反应。** 到 **Plugins → Installed** 确认它是启用状态。Client 侧插件安装后需要刷新一次
页面；安装之前已经发过的 prompt 不会补跑。

**会把这些内容发到哪里？** 每个插件的 README 都会写清楚它读什么、调用哪个模型。除非 README 明确说明，
插件算出来的东西不会进入你的对话。

## 参与开发

欢迎提 issue 和 PR。仓库结构、如何新增插件、测试和发布清单都在
[DEVELOPMENT.md](DEVELOPMENT.zh-CN.md)。

## 许可

MIT。
