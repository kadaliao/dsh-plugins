# DSH Plugins

[English](README.md) | 简体中文

[![test](https://github.com/kadaliao/dsh-plugins/actions/workflows/test.yml/badge.svg)](https://github.com/kadaliao/dsh-plugins/actions/workflows/test.yml)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件合集——每个插件都很小，只增强
对话、输入框或工作区里的一个点。

## 安装

1. 先启用一次市场：**Plugins → Experimental plugins → Custom plugin markets**。
2. 打开新出现的 **Discover** 标签页，在 **Sources** 里加入：

   ```
   https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
   ```

3. 在 Discover 里安装想要的插件。

已经知道要装什么，也可以直接把插件的 Git spec 贴进插件管理器：

```
git+https://github.com/kadaliao/dsh-plugins.git#main&path:/plugins/prompt-en
```

## 插件

| 插件 | 作用 |
| --- | --- |
| [Prompt EN](plugins/prompt-en/README.zh-CN.md) · 0.2.0 | 在每条 prompt 下方写一行英文：用其他语言写的给出译文，用英文写的给出纠错和更地道的替代说法。教过你的说法收进生词本，用 `/vocab` 复习。 |

之后做好的插件会陆续加进来。每个插件独立安装、独立版本；索引钉死发布所用的 commit，新增插件不会改变
已有插件的安装。

## 共同点

- 都在 **Web UI** 里工作（桌面 App 或 `dsh web`）。
- 除非插件 README 另有说明，都只做展示：不写 Session 日志，也不往对话模型读到的内容里加东西。
- 纯 JavaScript，MIT，源码就在本仓库。

## 环境要求

- DeepSeek Harness 0.2.x，并使用 Web UI。
- Harness 里已配置模型。除非插件 README 另有说明，插件默认复用当前会话的模型。

## 常见问题

**找不到 Discover 标签页。** 自定义市场在 DeepSeek Harness 里是实验功能，先在
**Plugins → Experimental plugins** 里打开 **Custom plugin markets**。

**插件装了却没反应。** 到 **Plugins → Installed** 确认它是启用状态。Client 侧插件安装后需要刷新一次
页面；安装之前已经发过的 prompt 不会补跑。

**会把这些内容发到哪里？** 每个插件的 README 都会写清楚它读什么、调用哪个模型。除非 README 明确说明，
插件算出来的东西不会进入你的对话。

## 参与开发

欢迎提 issue、插件想法和 PR。仓库结构、如何新增插件、测试和发布清单都在
[DEVELOPMENT.zh-CN.md](DEVELOPMENT.zh-CN.md)。

## 许可

MIT。
