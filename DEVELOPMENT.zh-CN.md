# 开发

[English](DEVELOPMENT.md) | 简体中文

这个合集的维护者笔记。只想用插件的话，看 [README](README.zh-CN.md) 就够了。

## 东西都在哪

本仓库是合集的索引，每个插件有自己的仓库：

| 插件 | 仓库 | npm 包 |
| --- | --- | --- |
| Archify 图解 | [kadaliao/dsh-archify](https://github.com/kadaliao/dsh-archify) | `@kadaliao/dsh-archify` |
| 足迹 | [kadaliao/dsh-atlas](https://github.com/kadaliao/dsh-atlas) | `@kadaliao/dsh-atlas` |
| Bots | [kadaliao/dsh-bots](https://github.com/kadaliao/dsh-bots) | `@kadaliao/dsh-bots` |
| 图片 | [kadaliao/dsh-images](https://github.com/kadaliao/dsh-images) | `@kadaliao/dsh-images` |
| Prompt EN | [kadaliao/dsh-prompt-en](https://github.com/kadaliao/dsh-prompt-en) | `@kadaliao/dsh-prompt-en` |

留在本仓库的：

- `marketplace.json`：用户在 Discover 里添加的市场索引，地址永远不变。
- `plugins/<name>/README.md`：指向插件新仓库的说明，让已发布的包和以前的帖子里的链接还能找到地方。
- 历史。拆分之前（commit `71d4c76`，2026-11-18）所有插件的源码都在本仓库 `plugins/<name>/` 下，
  索引里较早的版本钉的就是那段历史里的 commit。**永远不要改写或强推 `main`**，否则钉在这些 commit 上的
  安装就解析不到了。

插件仓库是带着历史拆出来的（`git filter-repo --subdirectory-filter`），在那边 `git log`、`git blame`
都能追到第一个 commit。

## 插件仓库

每个插件仓库的根目录就是一个完整、独立的 DeepSeek Harness bundle：

```
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

环境：Node.js 22+，只用于跑测试（无构建步骤、无依赖）；加载工作副本需要装有 Web profile 的
DeepSeek Harness 0.2.x。

### 跑测试

```bash
node --test test/*.test.mjs
```

客户端测试用很小的模块加载器和 React 替身加载 `client.js`，不依赖浏览器也能抓到注册错误和渲染回归。
每个仓库每次推送都会在 GitHub Actions 里跑一遍。

### 加载工作副本

用 Harness 插件管理器安装仓库目录（Plugins → 从文件夹安装，或 `plugin_manager` 工具）。以 link 方式
安装的目录在下次插件重载时生效；Client 半的改动还需要刷新页面，除非 Web 开发 watcher 正在运行。

想试改动又不碰自己的 profile，可以用桌面应用自带的 CLI 把插件 link 进一个临时的 Harness home，再启动它：

```bash
DSH=/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh
export DSH_HOME=$(mktemp -d)
"$DSH" plugin --profile web add "$PWD"
"$DSH" web --no-open --port 3917   # 打开它打印出的 URL
```

它没有模型凭据，只能检查不需要模型的界面。

### 更新提醒（共用代码）

每个插件的 `client.js` 里都有同一段代码，夹在 `// >>> kadaliao-dsh-updates` 和
`// <<< kadaliao-dsh-updates` 之间，由 `apply(ctx)` 调用一次。它用 Harness 的插件管理（`listVersions`、
`updateBundle`）检查所有已安装的 `@kadaliao/dsh-*` 插件，只出一张卡片，由其中一份负责画（`UPDATES_IMPL`
最大的那份，相同时取最先加载的）。其余几份待命，负责的那份被关掉或换掉时接手；插件更新自己时也是这样：
新版本的前端在原地加载，接着把卡片走完。

这段代码在本仓库维护：`shared/updates.js`，测试是 `shared/updates.test.mjs`。在这里改，再复制到本仓库旁边的
各个克隆（`../dsh-<name>`）：

```bash
node --test shared/updates.test.mjs
node scripts/sync-updates.mjs          # 写入每个克隆的 client.js 和 test/updates.test.mjs
node scripts/sync-updates.mjs --check  # 有克隆不一致时返回 1
```

卡片行为的改动如果旧版本会处理错，就把 `UPDATES_IMPL` 加一，让装着的最新那份来负责。
`window.__kadaliaoDshUpdates` 上的 hub 是各版本共用的，只能往上加字段，不能改已有的。想在不发布的情况下
试一次真实更新：在临时 profile 的 `.npmrc` 里写 `@kadaliao:registry=` 指向本地 registry（verdaccio），
装一个测试包，再发一个新版本，点「更新」。

## 新增插件

1. 在 GitHub 上建 `kadaliao/dsh-<name>`，复制一个现有插件仓库作为起点。
2. 改包名（`@kadaliao/dsh-<name>`）、`cordis.patch.yml` 里的 bundle 行，以及 `client.js` 里的
   `window.__ModuleLoader__.load({ id })`。Client 模块 id 必须等于包名。`package.json` 里的
   `repository`、`homepage`、`bugs` 指向新仓库。
3. 补上面向用户的 `README.md` 与 `README.zh-CN.md`、locale 的 `meta.title`/`meta.description`，以及
   原创或有授权可再分发的图标。
4. 不要把模型能看到的内容写进 Session 日志；在 README 里写清楚插件读什么、调用哪个模型。
5. 跑测试，装目录，在真实 UI 里验证后再发布。
6. 发布到 npm，在本仓库的 `marketplace.json` 加条目，两份 README 的表格各加一行。

## 市场索引

`marketplace.json` 是 Discover 读取的 format-1 索引。每个插件条目列出所有版本，每个版本有自己的来源，
所以发新版本不会改变旧版本的安装方式。新版本都发到 npm：

```json
{ "version": "0.2.0", "publishTimestamp": 1794700000, "source": { "type": "npm" } }
```

Discover 会按 `<name>@<version>` 安装，所以条目的 `name` 必须是 npm 上的包名。`publishTimestamp` 是
Unix **秒**。

较早的版本保留发布时的 Git 来源——本仓库里的一个 commit，加上插件当时所在的路径：

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

这些条目保持原样。推送前用 Harness 自带的解析器（`@deepseek-ai/dsh-plugin-market-index`）校验：它会拒绝
非规范 URL、缺 `en` 标题、错误 commit 以及带不支持字符的路径段。本仓库的 CI 会检查基本结构
（`node scripts/check-index.mjs`）。

## 发布清单

在插件仓库里：

1. 升 `package.json` 的 `version`（Bots 还要同步 `client.js` 里的 `BOTS_VERSION` 和它的测试）；行为有变
   就更新 README。
2. 跑测试。
3. 提交并推送。
4. `npm publish --access public`。registry 可能要几分钟才能拿到新版本。更新卡片只提供发布满 30 分钟的
   版本，所以有人点「更新」时 tarball 已经能下载了。

第 1 步之前，先在本仓库跑 `node scripts/sync-updates.mjs --check`，确认这个插件是最新的。

然后在本仓库：

5. 在 `marketplace.json` 对应插件的 `versions` 里加上这个版本，`"source": { "type": "npm" }`；更新
   `README.md` / `README.zh-CN.md` 里的版本号和介绍。
6. 提交并推送。
7. 在干净 profile 里从索引安装，确认插件出现且可用。
8. 不要改写已发布的 commit（本仓库和插件仓库都一样）；发新版本。

## 许可

MIT。Prompt EN 是同一作者的 Claude Code mod
[prompt-en](https://github.com/kadaliao/claude-mods/tree/main/prompt-en)（同样 MIT）的 DeepSeek
Harness 移植版。
