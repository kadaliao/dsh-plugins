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

装好后打开左侧栏的**图片**，点**设置**，填上生图模型（见[设置](#设置)）。安装后刷新一次页面。

## 在对话里

你要图时，模型会带着一段写得很细的提示词调用 `generate_image`。供应商出图期间，回合的过程折叠里
有一块闪动的占位图，下面是提示词。图回来后，它作为对话里独立的一行显示在模型回复上方，折叠收起
后依然可见。一次要几张（`n` 最多 4）就并排放。

鼠标移到图上出现控件：**下载**，以及 **⋯ 菜单**（下载、复制提示词）。点图放大；查看器里 `←` `→`
在这次调用的几张图之间切换，`Esc` 关闭。

图下面有一行小字：哪个模型画的、像素尺寸、花了多少钱（`gpt-image-1.5 · 1024×1024 · ≈ $0.017`）。
模型自己也会收到这张图（在支持图片输入的模型上），所以它能检查自己画得对不对，并描述画了什么。

## 「图片」面板

左侧栏的 **Images**（或输入 `/images`）打开图库：所有会话里生成过的图，最新的在前，瀑布流卡片。
每张卡片显示提示词、模型、像素尺寸、费用和生成时间；标题栏累计已花的钱。悬停出现**下载**和 **⋯ 菜单**（下载、复制提示词、
从图库移除）；点击放大，方向键在整个图库里翻页。面板打开时会自动刷新，往下滚动加载更早的。

从图库移除只删插件自己存的那份；它所在的会话里仍然能看到这张图（走 Harness 的附件存储）。

## 设置

「图片」面板右上角的**设置**打开一个抽屉，插件需要的都在里面；保存到
`~/.dsh/cache/images/settings.json`，下一张图就生效，不用重载。

- **连接** —— 走哪条供应商线路：*跟随会话*（聊天模型用的那个）、Harness 里配置过的任一供应商、或
  *自定义地址*。接口地址都可以另填。**API 密钥**只给这个插件用，存在本机的 Harness 凭据库里
  （`DSH_IMAGES_API_KEY`），不会再显示，优先于供应商自己的密钥；留空就继续用供应商的。
  **测试连接并拉取模型**会请求供应商的 `/models`，把其中的生图模型列出来供选。
- **模型** —— 按供应商叫法填的模型 id、默认尺寸、质量档。模型框下面会说明这个模型按什么计价。
- **计费** —— 每张单价和币种，只在模型既不返回用量、也不在内置价目表里时用。下面是已生成的张数
  和费用，按模型分列。

同样的值也可以写在 profile patch（`cordis.patch.yml`）里插件那一行；抽屉里的优先，抽屉里清空某项
就回落到 patch 的值。

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `model` | — | 要用的生图模型，按供应商的叫法：`gpt-image-1.5`、`gpt-image-1`、`doubao-seedream-4-0-250828`…… |
| `provider` | 会话用的那个 | 用哪个供应商（`llm-pi-ai` 里的 provider 名）的 `baseURL` 和 key；填 `custom` 表示只用 `baseURL`。 |
| `baseURL` / `apiKeyEnv` | 取自供应商 | 请求地址和签名用的凭据名，给 Harness 里没配置的供应商用。 |
| `size` | `1024x1024` | 模型没另外指定时的尺寸（`1536x1024`、`1024x1536`、`auto`）。 |
| `quality` | 模型默认 | 支持质量档的模型用（`low`、`medium`、`high`）。 |
| `pricePerImage` / `currency` | — / `USD` | 插件算不出价格的模型，按这个单价计。 |
| `enabled` | `true` | `false` 保留图库但不给模型提供工具；运行时用 `/images on`、`/images off` 切换。 |
| `timeoutMs` | `180000` | 一次请求最多等多久。 |

```yaml
- id: images
  config:
    model: gpt-image-1.5
    # provider: openai
    # size: 1536x1024
```

请求是 OpenAI 兼容的 `POST <baseURL>/images/generations`，带 `model`、`prompt`、`size`、`n`，
所以凡是提供这个接口的供应商或网关都能用，包括把多家厂商挂在一个地址后面的本地网关。返回里图片
内联（`b64_json`）或给 URL 都行。

## 费用

每次调用是向生图模型发一次请求，按供应商的生图计费。不会调别的。图也会放进对话给模型看，这部分
按聊天模型的图片输入 token 计；纯文本模型收到的是一行占位说明。

每张图都带一个费用估算，按下面的顺序取第一个能用的：

1. **供应商返回的用量。** OpenAI 的生图模型会返回 `usage`（输入、输出 token），插件按官方 token
   单价计算（gpt-image-1.5：文本输入 $5/M、图片输出 $32/M；gpt-image-1：$5/M 和 $40/M；
   gpt-image-1-mini：$2/M 和 $8/M）。这是精确值。
2. **供应商报价**：`/models` 列表里带的每张单价（OpenRouter 风格的 `pricing.image`），测试连接时
   学到。
3. **内置价目表**：按质量和形状的每张固定价（gpt-image-1.5、gpt-image-1、gpt-image-1-mini、
   DALL·E 3 和 2、豆包 Seedream），核对日期显示在设置抽屉里。
4. **你填的每张单价**（计费一节）。

都没有的模型不显示费用。估算用的是厂商价目的币种；网关若按订阅或加价计费，会与之不同。

## 看起来不对时

- **`No image model is configured`** —— 打开 图片 → 设置，填上模型。
- **`Provider "…" has no baseURL the images plugin can read`** —— 会话用的供应商不是插件能读到的
  `llm-pi-ai` provider；在设置里换一个，或选「自定义地址」。
- **测试连接列不出生图模型** —— 很多网关提供生图模型却不列出来；直接填 id 生成一张试试。
- **费用不对或没有** —— 设置抽屉里写着这个模型按什么计价；插件不认识的模型，填一个每张单价。
- **供应商返回 `4xx`/`5xx`** —— 消息是供应商原话：账号不能用这个模型、不支持这个 `size` 或
  `quality`、没额度。按它说的改。
- **模型不画图，用文字描述代替** —— 看 `/images` 是否显示工具已开启，以及 **Plugins → Installed**
  里插件已启用。插件加载时正在进行的回合，下个回合才能看到工具。
- **刷新页面后对话里没有图** —— 这一行由 Web Client 半边绘制；安装或更新后再刷新一次。
- **明明画过，图库却是空的** —— 图库在 `~/.dsh/cache/images/` 下，按 DSH home 分开；换了
  `DSH_HOME` 就是另一个图库。

## 原理

Host 半边把 `generate_image` 注册进 Harness 的工具注册表。被调用时，抽屉里的设置优先于 patch，
从实时 Harness 设置里读供应商的 `baseURL` 和凭据名，通过凭据服务拿到 key（抽屉里存的优先），
发出请求，给回复估价，然后把图存两份：一份进 Harness 附件存储，让
工具结果自带图片（`{ type: 'image' }`）、对话里能显示；一份在 `~/.dsh/cache/images/files/`，并记下
提示词、模型、尺寸和会话，面板通过 Harness web server 上的本机回环路由读的就是这份。

Client 半边绘制工具卡片、折叠外的结果行、侧栏入口和面板。除了工具调用和结果（Harness 对任何工具
都会记录），不往 Session log 写别的。

<details>
<summary>开发</summary>

仓库结构、测试和发布清单见 [DEVELOPMENT.zh-CN.md](../../DEVELOPMENT.zh-CN.md)。

</details>
