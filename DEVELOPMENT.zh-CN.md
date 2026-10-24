# 开发

[English](DEVELOPMENT.md) | 简体中文

这个仓库的维护者笔记。只想用插件的话，看 [README](README.zh-CN.md) 就够了。

## 仓库结构

`plugins/` 下的每个目录都是一个完整、独立的 DeepSeek Harness bundle：

```
plugins/<name>/
  package.json         # 包名、exports、dsh.bundle.patch、dsh.client
  cordis.patch.yml     # bundle 插入的 Loader 行
  index.js             # Host 半（跑在 Harness 进程里）
  client.js            # Web Client 半（window.__ModuleLoader__）
  lib/                 # Host 侧模块
  locale/*.json        # 展示元数据与 UI 词典
  icon.svg
  README.md            # 面向用户：行为、安装、设置、限制
  README.zh-CN.md
  test/                # 纯逻辑与客户端渲染测试
```

Host 半在自己的插件 fiber 上注册路由和监听；Client 半注册 Conversation 行或插槽。两者都不写 Session
日志；派生文本缓存在日志之外。

## 环境

- Node.js 22+，只用于跑测试（无构建步骤、无依赖）。
- 一份 DeepSeek Harness 0.2.x 的安装，用来加载工作副本。
- 带 Client 半的插件需要 Web profile；headless profile 没有对话界面。

## 跑测试

```bash
cd plugins/prompt-en
node --test test/*.test.mjs
```

客户端测试用很小的模块加载器和 React 替身加载 `client.js`，不依赖浏览器也能抓到注册错误和渲染回归。

## 加载工作副本

用 Harness 插件管理器安装插件目录（Plugins → 从文件夹安装，或 `plugin_manager` 工具）。以 link 方式
安装的目录在下次插件重载时生效；Client 半的改动还需要刷新页面，除非 Web 开发 watcher 正在运行。

发布前要按市场索引给出的、钉死 commit 的 Git spec 安装一遍——这也是用户唯一的安装路径。

## 新增插件

1. 复制一个现有插件目录作为起点。
2. 改包名（`@kadaliao/dsh-<name>`）、`cordis.patch.yml` 里的 bundle 行，以及 `client.js` 里的
   `window.__ModuleLoader__.load({ id })`。Client 模块 id 必须等于包名。
3. 补上面向用户的 `README.md` 与 `README.zh-CN.md`、locale 的 `meta.title`/`meta.description`，以及
   原创或有授权可再分发的图标。
4. 不要把模型能看到的内容写进 Session 日志；在 README 里写清楚插件读什么、调用哪个模型。
5. 跑测试，装目录，在真实 UI 里验证后再发布。

## 市场索引

`marketplace.json` 是 Discover 读取的 format-1 索引。每个版本钉死一个 commit：

```json
{
  "version": "0.1.0",
  "publishTimestamp": 1792855428,
  "source": {
    "type": "git",
    "url": "https://github.com/kadaliao/dsh-plugins",
    "commit": "<包含该插件的 40 位 commit>",
    "path": "plugins/prompt-en"
  }
}
```

`publishTimestamp` 是 Unix **秒**。推送前用 Harness 自带的解析器
（`@deepseek-ai/dsh-plugin-market-index`）校验：它会拒绝非规范 URL、缺 `en` 标题、错误 commit 以及带
不支持字符的路径段。

## 发布清单

1. 升插件 `version`；行为有变就更新 README。
2. 跑测试。
3. 提交并推送代码。
4. 把索引条目的 `source.commit` 指向该 commit，提交并推送索引。
5. 在干净 profile 里按索引的 Git spec 安装，确认插件出现且可用。
6. 不要改写已发布的 commit；发新版本。

## 许可

MIT。Prompt EN 是同一作者的 Claude Code mod
[prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en)（同样 MIT）的 DeepSeek
Harness 移植版。
