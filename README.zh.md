# dsh-cua-preview

[English](README.md) | 中文

一个 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 插件：驱动浏览器，每一次导航或动作调用都由 DSH
审批把关，并把**当前屏幕截图交给用户，在动作执行之前审阅**。

审批架构借鉴了 ZCode 的 `cua-permission-broker`（仅设计层面借鉴，未复制任何 ZCode 源码）。

## 它做什么

| 工具 | 需要审批 | 返回 |
|---|---|---|
| `browser_navigate` | 是 | 导航之后的页面 |
| `browser_act`（`click` / `fill` / `submit`） | 是 | 动作之后的页面 |
| `browser_snapshot` | 否 | 当前 URL、标题与可见文本 |
| `browser_screenshot` | 否 | 当前屏幕的图片 |

只读的两个工具永远不会触发审批，因为它们都无法改变页面。需要把关的两个会先询问——用界面自身语言写成的一行文字——并且除非回答是「允许一次」，否则什么都不做。

**在 DSH `0.2.0-rc.2` 上，这行文字固定为英文**：该版本移除了插件可以查询的 Host 侧语言读取通道；在 `0.1.5-rc.2`/`rc.3` 上仍会本地化。机制见 [docs/design.md](docs/design.md)，并且本仓库的真机检查会断言这一限制，而不是把它藏起来。

## 安装

依赖：**Node ≥ 22.12**（`puppeteer-core` 的要求）以及一个 Chrome 或 Chromium 可执行文件。安装时**不下载任何东西**——插件驱动你已经装好的 Chrome；找不到时会给出可操作的报错，而不是悄悄去下载一个。

开发与验证基于 DSH `0.2.0-rc.2`（`@deepseek-ai/dsh-tools` `0.2.0-rc.2`、`@deepseek-ai/cordis` `4.0.4`），同时仍向下支持到 `0.1.5-rc.2`。

DSH 插件通过 `dsh plugin` 安装进一个 **profile**，该命令会把参数转发给该 profile 目录下的包管理器：

```sh
# 按包名安装
dsh plugin --profile demo add dsh-cua-preview

# 从本地安装
dsh plugin --profile demo add ./dsh-cua-preview

dsh --profile demo --dump-config   # 会看到 "# == dsh-cua-preview" 这一层
dsh --profile demo                 # 启动
```

本包是一个 DSH **bundle**：它提供一层配置，真正启动它的是 profile。若想挂到已有的 profile 上而不重新安装，可以用 overlay 覆盖层——测试用的也是这个方式：

```yaml
- insert:
    - id: cua-preview
      name: 'dsh-cua-preview'
      config:
        artifactsDir: '/tmp/cua-artifacts'   # 可选
        headless: true                       # 可选，默认 true
        chromePath: '/usr/bin/google-chrome-stable'  # 可选，自动探测
```

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `artifactsDir` | `$DSH_HOME/cua-preview/artifacts` | 截图证据 PNG 的写入目录 |
| `headless` | `true` | 是否以无头模式运行 Chrome |
| `chromePath` | 自动探测 | 显式指定 Chrome/Chromium 可执行文件 |

Chrome 会依次通过 `$DSH_CUA_CHROME_PATH` 与常见的 Linux 安装路径查找
（`/usr/bin/google-chrome-stable`、`/usr/bin/google-chrome`、`/usr/bin/chromium`、
`/usr/bin/chromium-browser`、`/snap/bin/chromium`），并以容器环境下通用的一组合适参数启动。

## 浏览器库的选择：Puppeteer

任务允许在 Puppeteer 与 Playwright 之间选择。这里选了 Puppeteer，并且具体是 `puppeteer-core`：

- `puppeteer-core` **不下载任何东西**——安装时没有约 150 MB 的浏览器下载，也不需要猜测哪个 Chromium 该配哪个版本的库。
- 它驱动机器上**已有**的 Chrome，因此用户审阅的就是他自己也能打开的那个浏览器。
- 插件对它的全部依赖集中在一个模块 `src/browser.js`；换成别的库只需改这一个文件。

## 截图模型（一段话）

审批发生在动作**之前**，因此存在两帧画面，各自按其本来含义命名。**动作之后**的那一帧是模型收到的结果图片，因为模型若把动作前的画面当成「结果」，就会断定动作失败了。**审批当时**的那一帧——也就是请用户批准的那张画面——在同一次结果里排在前面返回，标注为 `before the action`，于是这次调用的行读起来就是一条时间线。两帧都随这次调用自己的 `tool/result` 内容下发，这正是它们可被读取的原因：Host 只在**某条已知事件的内容里**携带该引用时，才为图片读取授权；`presentationMeta.frames` 逐张标明角色。**插件自己的会话事件完全不能用**——那会让整个会话再也打不开，见 `docs/design.md`。用户拒绝时没有动作发生，唯一返回的那张图**就是**审批当时的画面，标注为 `at approval time (no action ran)`。真正空白的屏幕（未加载的空标签页）不会发出任何图片，而不是发一张无用的白图。

**你在做决定的时候，屏幕已经在屏幕上了。** 审批卡片出现的那一刻，这次调用的行就会画出**当前**屏幕，而且是一次**实时读取**：那一刻什么都还没落日志，所以这张图来自 Host 自己手里那份——就在提问前一刻截下的字节，经 Connection 为「浏览器原生响应」规定的 exact Fetch route 送出。调用一结束这条路由就不再应答，因为此时结果里已经带着同一张画面（标注为 `before the action`）。

机制细节、为什么插件不能自己写会话事件、以及为什么不占用审批卡片里那个已满的单占位槽位，见 [docs/design.md](docs/design.md)。

## 用户拒绝时，模型会看到什么

拒绝是一个**成功**的工具结果，而不是错误——错误读起来像「调用失败了，再试一次」，而当初正是**一个错误**导致模型去重试一个用户刚刚拒绝的动作。这段提示以官方 gating 路径自己的句子开头（中英两种语言逐字引用），再补上那句话没有说的两件事：这是**人的决定**而不是故障；以及下一步应当是停下来询问。

```text
browser_act 未执行：用户在审批中拒绝了这次操作。
the user rejected tool "browser_act" —— 这是人的决定，不是调用失败、页面问题，也不是本插件故障。
操作没有执行，页面保持原样。不要重试这个动作或等价动作；请停下来询问用户要改什么、或者下一步做什么。
```

三种「未获批准」的结果措辞各不相同，模型因此能区分「人说了不」与「根本没有审批通道」：`rejected` 与 `cancelled` 被描述为用户的决定，而 `unavailable` 明确说明这**不是**用户的决定。同一条规则也写进了两个受把关工具的 `description`，所以它在模型动手**之前**就已进入系统提示，而不只是事后才出现。

重复弹窗**不做**抑制：插件不去管模型的重复尝试，用户改变主意后仍然可以批准后一次。机械地抑制完全相同的重复请求固然能结束弹窗循环，但它也可能挡住一个已经改口说「继续」的用户，而且一次工具执行并不携带可用于把抑制限定在单个模型轮次内的轮次标识。

## 测试

从源码检出运行（测试入口仅用于开发，不在发布包内，因此 `npm install dsh-cua-preview` 之后并没有这些文件）：

```sh
npm install
npm test
```

三个入口，分别针对三个层次：

| 入口 | 层次 | 依赖 | 检查项 |
|---|---|---|---|
| `npm run test:client` | Client 那一半，独立验证 | 仅需 Node | 79 |
| `npm run test:acceptance` | Host 那一半，对接真实 DSH 服务 | Chrome | 107 |
| `npm run test:real-load` | 两半一起，跑在真实的 `dsh` 进程内 | PATH 上有 `dsh` + Chrome | 18 |

合计 **204 项检查，0 失败**——三个入口都需要先 `npm install`。最后一个入口会启动官方 `dsh` 二进制，把插件以 patch 方式挂进去，监听由操作系统分配的随机空闲端口（因此绝不会与你正在运行的任何 profile 冲突），并在该进程内运行一个探针插件，读取实时的各项注册表。如果 PATH 上没有 `dsh`，它会明确报告并以非零码退出。它会把该次启动的审批策略固定为 `ask`，这样默认预设为 `danger-full-access` 的 profile 就不会把这次运行变成对预设的判断，而不是对插件的判断。

CI 在每次 push 时运行 Client bundle 验证与打包检查，因为这两项无需浏览器即可复现。浏览器相关的套件不在该门禁内——它们需要 Chrome，最后一个还需要 `dsh` CLI——因此改为手动触发的任务。

### 本地测试页

`examples/test-page/` 是一个带输入框、按钮和表单的小页面，验收检查会用到它，也方便手动试用：

```sh
node examples/test-page/serve.mjs --port 3097 --host 127.0.0.1
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 它如何工作、为什么这样设计：两帧画面、图片的传递通道、隐藏的载体节点、插件刻意不去占用的槽位、语言与拒绝规则 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录 |

## 许可证

[MIT](LICENSE)。本项目是**非官方社区作品**，与 Z.AI Co., Ltd 及 DeepSeek 无隶属关系，未获其授权、赞助或背书。「ZCode」与「DeepSeek Harness」分别为其各自权利人的商标，此处仅用于说明某项设计的来源以及本插件运行于什么之上。
