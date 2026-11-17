# Archify 图解

[English](README.md) | 简体中文

**说一句要什么图，对话里就出现一张检查过、能交互的图解页面。**

把 tt-a1i 的 [Archify](https://github.com/tt-a1i/archify) 带进 DeepSeek Harness。架构图、流程图、时序图、
数据流图、状态图、ER 图、类图、树图、时间线、瀑布图，可以照描述画、照 Mermaid 画，也可以读工作区里的
代码画；还能把一个回答做成一页讲解。对话模型把图写成 Archify JSON，插件负责渲染和检查，画好的页面直接
显示在对话里，有浅色深色主题、动效，也能导出。

```
> 画一下这个仓库的运行时架构图
  ▸ 已完成，用时 39 秒
  [ 架构图，可交互 ]   ⛶ 全屏 · ↗ 浏览器 · ⤓ · 📁 · ⧉
  这个插件分成两半：……
```

## 安装

在 DeepSeek Harness 里添加本仓库的索引（**插件 → 发现 → 来源**）：

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

然后安装 **Archify 图解**。「发现」页属于实验功能 **自定义插件市场**，看不到的话先在
**插件 → 实验性插件** 里打开。

不用「发现」页的话，把 Git 地址粘贴到插件管理器：

```
git+https://github.com/kadaliao/dsh-plugins.git#main&path:/plugins/archify
```

装好后刷新一次页面。不需要任何配置：不用装 Node.js，不用填密钥，也不另调模型。Archify 直接用 Harness
自带的 JavaScript 运行时跑。

## 在对话里

插件往技能目录里加了一个 `archify` 技能。你说要画图或者要一页讲解（「画个时序图」「画一下这几张表的 ER
图」「用一页讲清楚……」）时，模型会加载它，读几份需要的 Archify 参考文档，写好图，再调用
`archify_render`。

- 干活的时候，本轮的过程折叠里有一张卡片，写着图的类型、标题和几道检查：校验、生成、严格检查、真实
  浏览器检查。检查没过会列出 Archify 的诊断，模型按诊断改完再渲染一次。
- 画好的页面作为对话里的一行，显示在模型回复的上面，折叠收起后也看得见。这里只显示图本身，跟随
  Harness 的浅色或深色主题，高度按图的比例来。双击图或者点 **全屏**，看到的是完整的 Archify 查看器：
  工具栏、主题和配色、动效、搜索、路径追踪，还能导出 PNG、SVG、WebM。
- 卡片上的按钮：**全屏**、**浏览器**（用默认浏览器打开这个 HTML 文件）、**下载**、**在文件夹中显示**、
  **复制路径**。

每个页面都是一个独立的 HTML 文件，离线也能打开，可以直接发给别人。

## Archify 面板

左侧栏的 **Archify** 列出所有会话里画过的页面，最新的在前，可以搜索。选中一个就能预览，可以全屏、在
浏览器打开、在文件夹中显示，或者回到画它的那个会话。**移除** 只是从列表里拿掉，文件还在。输入
`/archify` 也能打开面板。

## 默认就快

Archify 的检查很严，模型的时间大多花在修布局上。插件把这部分控制住：

- **架构图由插件排版。** 模型只写有哪些框、哪些箭头、哪些分组，位置由插件用
  [ELK](https://github.com/kieler/elkjs) 的分层布局算出来（同组的框排在一起，主链路从上往下），
  大约一秒内试四种排法、逐个过 Archify 的检查，留下通过检查里交叉和绕行最少的一种。位置写进
  `candidate.json`，之后照样能改：改了文字或结构会重新排，手动挪过的位置保持不动。
- **检查通过的页面就是答案。** 页面一生成，模型就直接回复，不会自己再去做视觉检查、截图或者再调一轮
  布局。Archify 建议整理连线时，回复最后会问一句要不要整理；你说「整理一下布局」就会做这一轮。
- **修复有预算。** 同一份图第三次渲染失败起，工具会让模型改用 Archify 的 `standard` 档，这一档不做
  展示级的精修检查（标签间距、走线通道和交叉、画布宽度），先把页面交出来；第八次起，让模型停下来，
  告诉你还剩什么问题。
- **渲染本身很快。** 校验不过大约一秒就返回，完整通过（含真实浏览器检查）大约三秒。

我们用 DeepSeek-V4.1-Flash 实测：一页讲解大约 20 秒，一张时序图大约 50 秒，照描述画架构图大约 20 秒，
读一个小仓库的代码画架构图大约 40 秒，都按 Archify 最严的 `showcase` 档交付。没有自动排版以前，最后这种
要一分半到四分钟，而且常常只能降到 `standard` 档。

## 文件放在哪

每次请求在会话的工作目录里建一个文件夹：

```
.archify/<类型>-<名字>-<YYYYMMDD-HHMMSS>/
  candidate.json            图的内容（讲解页是 candidate.archify.md）
  candidate.layout.json     插件写进去的排版记录（架构图）
  <名字>.html               页面
  <名字>.*.json             Archify 的生成和检查回执
```

修复会覆盖同一个页面，新的请求用新的文件夹。面板的列表存在 `~/.dsh/cache/archify/gallery.json`。

## 读什么、发什么

- 插件不调用任何模型。图由对话模型自己写：它从插件目录读 Archify 的参考文档；画你的代码时，照常读
  你的文件。
- 渲染在本机进行。Archify 的更新检查已关闭，这份副本跟着插件一起更新。Archify 只有在图里写了某个品牌
  logo 的网址时，才会联网去取那个 logo。
- 除了模型加载时的技能内容和工具结果，不往模型看到的内容里加任何东西。
- 页面在沙箱里、以独立的源提供给 Harness 页面：查看器的脚本照常运行，但页面上的任何内容都碰不到
  Harness 本身和它的接口。这些接口只提供工具生成过的页面。

## 工具

| 工具 | 作用 |
| --- | --- |
| `archify_render` | 渲染、检查并交付页面，相当于 Archify 的 `finalize`。参数 `type`；新页面传 `spec`（JSON，讲解页传 `markdown`），改过的图重新渲染传 `candidate`（路径）。可选 `name`、`quality`、`repoRoot`（图里引用了源码文件时，默认用工作目录所在的 Git 仓库根目录）、`output`。 |
| `archify_cli` | 用内置运行时跑 Archify 的其他命令（`guide`、`brands`、`compare`、`patch`、`validate`、`visual-check`、`doctor` 等）。会起常驻服务的 `preview` 不执行。 |

## 设置

在 profile 补丁（`cordis.patch.yml`）里本插件的那一行：

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 设为 `false` 时两个工具都不提供给模型。 |
| `skill` | `true` | 设为 `false` 时技能目录里没有 `archify` 技能。 |
| `timeoutMs` | `240000` | 一次 Archify 运行最长多久。 |

## 看起来不对时

- **模型在 shell 里跑 `node …/archify.mjs`，没用工具。** 有另一个 `archify` 技能优先了：个人和项目里的
  技能（`~/.dsh/skills/archify`、`~/.agents/skills/archify`，或项目里的 `.dsh/skills`、`.agents/skills`）排在插件自带的前面。把那一份改名或删掉
  就会用这一份。另外装了 `@tt-a1i/archify-dsh` 包的话，也会有两个 `archify` 技能，留一个就好。
- **浏览器检查显示跳过。** 这台机器没装 Chrome、Chromium 或 Edge。页面照样生成，只是这一道检查没跑。
  想用别的浏览器，把 `ARCHIFY_CHROME` 设成它的可执行文件路径。
- **架构图交叉很多。** 有些系统本身就缠在一起：主链路在一个大分组里进进出出，怎么排都会交叉。
  让模型整理一下布局，或者少分几组、把组分小。
- **复杂的图看起来很乱。** 多半是用完修复预算后按 `standard` 档交付的。让模型整理一下布局，或者画一张
  层次更高、节点更少的图。
- **面板里显示文件已不在。** 页面被移走或从工作目录里删掉了。

## 内置的 Archify

`archify/` 是 Archify 3.2.0，取自 `main` 分支，具体提交记在
[`archify/UPSTREAM.json`](archify/UPSTREAM.json)。内容没有改动，只去掉了测试、预渲染的示例页面、生成脚本和
lockfile。[`skill/SKILL.md`](skill/SKILL.md) 是它的 `SKILL.md` 为 Harness 改写的版本：shell 命令换成两个工具，
去掉更新检查和安装两节，第一次通过就交付。从 tt-a1i/archify 的本地仓库更新这份副本：

```bash
node scripts/sync-archify.mjs /path/to/archify
```

`vendor/elkjs/` 是 [elkjs](https://github.com/kieler/elkjs) 0.12.1 的 `lib/elk.bundled.js`（编译成
JavaScript 的 Eclipse Layout Kernel），没有改动。它只在排版进程里加载：插件每排一张架构图就单独起一个进程。

## 许可

插件本身是 MIT。`archify/` 是 tt-a1i 的作品，Apache-2.0 并保留历史上的 MIT 授权，见其中的 `LICENSE`、
`LICENSE-MIT`、`NOTICE`、`THIRD_PARTY_NOTICES.md`，以及本插件的 [NOTICE](NOTICE)。`vendor/elkjs/` 按
Eclipse Public License 2.0 使用（elkjs 以 EPL-2.0 或 GPL-3.0-or-later 授权），见 `vendor/elkjs/LICENSE.md`。
