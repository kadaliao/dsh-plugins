# 图片

[English](README.md) | 简体中文

**要一张图，就给你一张图。**

给对话模型一个 `generate_image` 工具，用你供应商提供的生图模型出图。说一句"给发布会画张海报"，
图就出现在对话里、就在它生成的位置。画过的所有图都收在一个「图片」面板里：瀑布流浏览、放大、下载。

```
> 画一张海报：深蓝夜空下的灯塔，极简扁平风，标题写 "Night Shift"
  ▸ Completed in 24s
  [ 海报 ]
  海报画好了：深蓝夜空下的灯塔，扁平风格，标题 "Night Shift"。
```

## 安装

在 DeepSeek Harness 里加入本仓库的索引（**Plugins → Discover → Sources**）：

```
https://raw.githubusercontent.com/kadaliao/dsh-plugins/main/marketplace.json
```

然后安装 **Images**。Discover 标签属于实验性的 **Custom plugin markets** 功能；看不到的话先在
**Plugins → Experimental plugins** 里打开。

不用 Discover 也可以把 Git spec 直接粘进插件管理器：

```
git+https://github.com/kadaliao/dsh-plugins.git#main&path:/plugins/images
```

装好后**填上生图模型**（见[设置](#设置)），刷新一次页面。

## 在对话里

你要图时，模型会带着一段写得很细的提示词调用 `generate_image`。供应商出图期间，回合的过程折叠里
有一块闪动的占位图，下面是提示词。图回来后，它作为对话里独立的一行显示在模型回复上方，折叠收起
后依然可见。一次要几张（`n` 最多 4）就并排放。

鼠标移到图上出现控件：**下载**，以及 **⋯ 菜单**（下载、复制提示词）。点图放大；查看器里 `←` `→`
在这次调用的几张图之间切换，`Esc` 关闭。

模型自己也会收到这张图（在支持图片输入的模型上），所以它能检查自己画得对不对，并描述画了什么。

## 「图片」面板

左侧栏的 **Images**（或输入 `/images`）打开图库：所有会话里生成过的图，最新的在前，瀑布流卡片。
每张卡片显示提示词、模型、像素尺寸和生成时间。悬停出现**下载**和 **⋯ 菜单**（下载、复制提示词、
从图库移除）；点击放大，方向键在整个图库里翻页。面板打开时会自动刷新，往下滚动加载更早的。

从图库移除只删插件自己存的那份；它所在的会话里仍然能看到这张图（走 Harness 的附件存储）。

## 设置

在 profile 的 patch 文件（`cordis.patch.yml`）里，写在插件那一行的 `config` 下：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `model` | — | **必填。**要用的生图模型，按供应商的叫法：`gpt-image-1`、`gpt-image-1.5`、`doubao-seedream-4-0-250828`…… |
| `provider` | 会话用的那个 | 用哪个供应商（`llm-pi-ai` 里的 provider 名）的 `baseURL` 和 key。生图模型和聊天模型不在同一个供应商时设它。 |
| `baseURL` / `apiKeyEnv` | 取自供应商 | 直接指定请求地址和签名用的凭据名，给 Harness 里没配置的供应商用。 |
| `size` | `1024x1024` | 模型没另外指定时的尺寸（`1536x1024`、`1024x1536`……）。 |
| `quality` | 模型默认 | 支持质量档的模型用（`low`、`medium`、`high`）。 |
| `enabled` | `true` | `false` 保留图库但不给模型提供工具；运行时用 `/images on`、`/images off` 切换。 |
| `timeoutMs` | `180000` | 一次请求最多等多久。 |

```yaml
- id: images
  config:
    model: gpt-image-1
    # provider: openai
    # size: 1536x1024
```

请求是 OpenAI 兼容的 `POST <baseURL>/images/generations`，带 `model`、`prompt`、`size`、`n`，
所以凡是提供这个接口的供应商或网关都能用，包括把多家厂商挂在一个地址后面的本地网关。返回里图片
内联（`b64_json`）或给 URL 都行。

## 费用

每次调用是向生图模型发一次请求，按供应商的生图计费。不会调别的。图也会放进对话给模型看，这部分
按聊天模型的图片输入 token 计；纯文本模型收到的是一行占位说明。

## 看起来不对时

- **`No image model is configured`** —— 在插件那一行设置 `model`（见上），重新加载插件。
- **`Provider "…" has no baseURL the images plugin can read`** —— 会话用的供应商不是插件能读到的
  `llm-pi-ai` provider；把 `provider` 设成一个能读到的，或者直接设 `baseURL` 和 `apiKeyEnv`。
- **供应商返回 `4xx`/`5xx`** —— 消息是供应商原话：账号不能用这个模型、不支持这个 `size` 或
  `quality`、没额度。按它说的改。
- **模型不画图，用文字描述代替** —— 看 `/images` 是否显示工具已开启，以及 **Plugins → Installed**
  里插件已启用。插件加载时正在进行的回合，下个回合才能看到工具。
- **刷新页面后对话里没有图** —— 这一行由 Web Client 半边绘制；安装或更新后再刷新一次。
- **明明画过，图库却是空的** —— 图库在 `~/.dsh/cache/images/` 下，按 DSH home 分开；换了
  `DSH_HOME` 就是另一个图库。

## 原理

Host 半边把 `generate_image` 注册进 Harness 的工具注册表。被调用时，从实时设置里读供应商的
`baseURL` 和凭据名，通过凭据服务拿到 key，发出请求，然后把图存两份：一份进 Harness 附件存储，让
工具结果自带图片（`{ type: 'image' }`）、对话里能显示；一份在 `~/.dsh/cache/images/files/`，并记下
提示词、模型、尺寸和会话，面板通过 Harness web server 上的本机回环路由读的就是这份。

Client 半边绘制工具卡片、折叠外的结果行、侧栏入口和面板。除了工具调用和结果（Harness 对任何工具
都会记录），不往 Session log 写别的。

<details>
<summary>开发</summary>

仓库结构、测试和发布清单见 [DEVELOPMENT.zh-CN.md](../../DEVELOPMENT.zh-CN.md)。

</details>
