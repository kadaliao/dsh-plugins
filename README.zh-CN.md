# DSH Plugins

[English](README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件集：我自己每天在用的几个，
整理成一个小仓库发布。

## 安装

DeepSeek Harness 通过 **插件市场索引**（plugin market index）分发插件：任何 HTTPS URL 上的
format-1 JSON 都可以作为索引。先启用 Discover 标签页（**Plugins → Experimental plugins →
Custom plugin markets**），然后在 **Discover → Sources** 里加入本仓库的索引：

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

之后就能在列表里直接安装。索引里的每个版本都钉死到本仓库的某个 commit，所以以后仓库继续更新，
老用户不会静默拿到不同的代码；每个插件也各自声明版本号。

不用市场的话，也可以把插件目录直接交给插件管理器安装，或用钉死 commit 的 Git spec：

```
git+https://github.com/kadaliao/dsh-plugins.git#<commit>&path:/plugins/prompt-en
```

## 插件

| 插件 | 作用 |
| --- | --- |
| [Prompt EN](plugins/prompt-en/README.zh-CN.md) | 在每条 prompt 下方写一行英文：用其他语言写的给出译文，用英文写的给出纠错或更地道的说法。 |

## 插件目录结构

`plugins/` 下的每个目录都是一个完整的 DSH bundle：

```
plugins/<name>/
  package.json         # 包名、exports、dsh.bundle.patch、dsh.client
  cordis.patch.yml     # bundle 插入的 Loader 行
  index.js             # Host 半
  client.js            # Web Client 半（window.__ModuleLoader__）
  lib/                 # Host 侧模块
  locale/*.json        # 展示元数据与 UI 词典
  icon.svg
  README.md            # 行为、设置、限制
  test/                # 纯逻辑与客户端渲染测试
```

Host 半在自己的插件 fiber 上注册路由和事件监听；Client 半注册 Conversation 行或插槽。两者都不写
Session 日志；除非插件 README 明确说明，插件算出来的内容不会发给对话模型。

## 开发

每个插件都是无构建步骤的纯 JavaScript，测试用 Node 自带 runner：

```bash
cd plugins/prompt-en
node --test test/*.test.mjs
```

要加载工作副本，用 Harness 插件管理器安装它的目录即可；以 link 方式安装的目录在下次插件重载时生效。

## 许可

MIT。Prompt EN 是同一个作者的 Claude Code mod
[prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en) 的 DeepSeek Harness 移植版。
