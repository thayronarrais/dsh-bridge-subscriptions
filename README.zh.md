# dsh-bridge-subscriptions

[English](README.md) · **简体中文**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，把你**已经在付订阅费**的那些编程 CLI 变成普通的 provider 路由。于是 harness 的智能体跑在这些订阅上，而不是按量计费的 API 调用。

一个插件、profile 里一行、一个设置段 —— 而**每个 CLI 是里面的一座桥**，可以各自独立开关：

| 桥 | 路由 | 后端 | 状态 |
|---|---|---|---|
| Claude Code | `claude-cli` | 本地已安装、已登录的 `claude` | **已发布** |
| Codex | `codex-cli` | 通过 Codex CLI 使用 ChatGPT 订阅 | [计划中](#路线图) |

每座桥都实现 `@deepseek-ai/dsh-llm` 的 `LlmAdapter`：流式文本、流式工具调用、token 用量、取消，以及订阅额度的错误分类。

## 环境要求

| | |
|---|---|
| Node | `^22.19.0 \|\| >=24` |
| `claude` | 已安装、在 `PATH` 中、并且已登录 —— 先交互式跑一次 `claude` 完成登录 |
| DeepSeek Harness | `@deepseek-ai/dsh` `0.1.0-rc.7` 或更高 |
| pnpm | `dsh plugin` 通过它管理 profile 目录，必须可用 |

**装插件之前**先确认 CLI 在无头模式下可用。下面这条命令若打印 NDJSON，桥就能工作；若打印登录提示，其他一切都无从谈起：

```bash
claude -p "ping" --output-format stream-json --verbose
```

## 安装

```bash
dsh plugin --profile web add dsh-bridge-subscriptions
```

然后在 harness 的 Web UI 里打开 **Settings → Models**，在 **Claude Code (subscription)** 下面选一个模型。这里没有 API key 输入框 —— 会话由 CLI 自己持有。

把 `web` 换成别的 profile（`tui`、`headless` …）即可装到那个 profile。

**推荐用这种方式。** 发布的 tarball 自带预构建的 `lib/`，整个安装过程不执行任何 build 脚本，也就不需要额外给 pnpm 授权。

### 从 GitHub 安装

可行，但要多一步，而且值得先弄清原因。

```bash
dsh plugin --profile web add github:thayronarrais/dsh-bridge-subscriptions
```

第一次一定会失败：

```
ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
The git-hosted package "dsh-bridge-subscriptions@0.1.0" needs to execute build
scripts but is not in the "allowBuilds" allowlist.
```

git 托管的包拿到的是源码，必须由它的 `prepare` 脚本编译，而 pnpm 在你明确许可之前拒绝执行。报错里会打印出**确切的 key** —— 它带 commit 号，光写包名不管用。把它原样抄进 `$DSH_HOME/profiles/<name>/pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-bridge-subscriptions@github:thayronarrais/dsh-bridge-subscriptions#<commit-sha>: true
```

然后重新执行同一条 `add` 命令。

由于这个 key 锁定了 commit，每次从 GitHub 更新都得换一次。这正是推荐用 npm 方式的原因。

### 开发循环

不安装，直接用工作目录打补丁：

```bash
npx dsh web --patch ./cordis.patch.yml
```

### 它为什么会被挂载

`dsh plugin add` 只负责把包装上。真正让它**挂载**的是 `package.json` 里的 `dsh.bundle.patch` 字段，指向 [`cordis.patch.yml`](cordis.patch.yml)：CLI 读到这个字段后，会把该包加进 profile 的 `dsh.profile.bundles` 列表，并把 patch 作为一个 profile 层应用上去。没有这个字段，你会看到"以普通依赖安装"的警告 —— 插件永远不会加载。

harness 自己的 `@deepseek-ai/dsh-*` 包在这里一律声明为 **peerDependencies**，绝不是 dependencies。这是刻意的：如果 profile 里再装一份 `@deepseek-ai/dsh-llm`，就会遮蔽正在运行的 harness 实例，桥会注册到一个没人使用的 runtime 上。

## 开关某一座桥

每座桥都有自己的 `enabled` 开关，因此你可以停用其中一座，而不必卸载插件，也不影响其他桥：

```yaml
# $DSH_HOME/settings.yaml
bridge-subscriptions:
  claude:
    enabled: false
```

被禁用的桥会**撤下它的路由** —— harness 不再提供它的模型，发往它的请求会被拒绝 —— 但它仍然作为可配置 provider 保留声明，所以在 **Settings → Models** 里那一行还在，随时可以重新打开。不需要重装任何东西；改动在下一次请求即生效。

这个区分正是插件把"声明 provider"和"注册路由"分开的原因：声明关乎它**存在**，注册关乎它当前**是否服务**。

## 配置

所有配置都在各自的桥的段落下。所有字段都是可选的，而且 bundle patch 刻意一个都不设：patch 会**整体替换**目标行的 `config` 而不是合并，写死默认值会遮蔽 `$DSH_HOME/settings.yaml` 里由 Models 页面写入的 `bridge-subscriptions:` 段。

### `claude`

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 这座桥是否服务请求。 |
| `transport` | `sdk` | `sdk`（Agent SDK）或 `spawn`（`claude -p`）。只有 `sdk` 支持工具调用。 |
| `binaryPath` | 从 `PATH` 解析 | 覆盖 `claude` 可执行文件路径。 |
| `cwd` | harness 进程的 cwd | provider 进程的工作目录。 |
| `discoverModels` | `true` | 向 CLI 查询它能访问哪些模型。 |
| `models` | *（空）* | 固定模型清单。非空则完全取代自动发现。 |
| `modelCacheTtlMs` | `600000` | 发现结果的有效期。 |
| `defaultContextWindow` | `200000` | 所选模型没有确切值时使用。 |
| `defaultEffort` | *（未设置）* | 调用方未选择时使用的推理强度。 |
| `maxTurns` | `2` | Claude Code **自身**轮次的上限。 |
| `streamIdleTimeoutMs` | `300000` | 一次读取过程中允许的最长静默。 |
| `maxPromptBytes` | `2000000` | 对话预算；超出时最旧的轮次先被丢弃。 |
| `retryPolicy` | harness 默认 | 由 `llm-retry` 消费的 provider 自有重试策略。 |

配置改动在下一次请求即生效，无需重启服务。改动 `binaryPath`、`cwd`、`models` 或 `discoverModels` 还会丢弃已缓存的模型清单，避免选择器继续显示上一个 CLI 读到的模型。

### 模型与推理强度

模型清单是**从 CLI 发现的**，不是写死的。查询是免费的：发现走的是一次从不发送 prompt 的 query 上的 control request，不消耗任何订阅额度。

写死清单会在两件事上出错：

- **版本。** harness 的模型选择器基本只显示名称，所以解析后的 wire id 会一并写进名称 —— 显示成 `Opus (1M context) · claude-opus-5[1m]` 而不是光秃秃的 `opus`。id 里的 `[1m]` 后缀还会把上下文窗口设成 100 万，而不是默认的 20 万。
- **推理强度。** 强度支持是**逐模型**的，只有 CLI 说了算。在当前 CLI 上，除 Haiku 外每个模型都接受全部五档，而 Haiku 一档都不接受 —— 所以 Haiku 正确地完全没有强度选择器，而不是给一个设了也不生效的。

所选模型不提供的 `defaultEffort` 会被丢弃而不是发出去。如果发现失败（CLI 缺失、未登录、离线），路由仍然可用，退回到一份很小的别名清单，下一次查询会重试。

## 工作原理

### harness 不是模型

这一点常让人意外，值得直说：**DeepSeek Harness 本身没有任何智能。** 它是模型*外围*的机器 —— 工具注册表、沙箱与权限策略、会话状态与压缩、prompt 组装，以及那个循环。所有决策都来自模型。过去是 DeepSeek，装上这个插件之后是跑在你订阅上的 Claude。

所以当你让 harness 做一个网页，看着它创建文件、执行命令时，并没有什么东西被夹带进来。是 Claude 做的决定，harness 执行的。

### 那个循环

```
┌─ harness 组装一次请求 ────────────────────────────────┐
│  system prompt + 工具 schema + 对话历史               │
└───────────────────────┬───────────────────────────────┘
                        │  本插件 → claude -p
                        ▼
                  ┌───────────┐
                  │  Claude   │   输出文本，还是发起工具调用？
                  └─────┬─────┘
                        │  工具调用：write_file("index.html", …)
┌───────────────────────▼───────────────────────────────┐
│  由 HARNESS 执行工具 —— 磁盘、shell、权限确认         │
│  都归它管；结果被追加进历史                           │
└───────────────────────┬───────────────────────────────┘
                        │
                        └──▶ 回到顶部，直到 Claude 不再请求工具
```

Claude 从不碰你的文件。它返回的是**数据**，说明它想以某些参数调用 `write_file`；真正执行的是 harness —— 在它自己的沙箱里、按它自己的权限策略、记录进它自己的会话日志。维持这个边界正是下文 MCP 桥接与主动中止的全部意义。

### 一个循环，不是两个

Claude Code 本身就是一个智能体 harness。把它嵌进另一个里面，两者就会打架：Claude Code 会去改文件、跑命令，而这些 harness 的会话日志一无所知，同时 harness 又在对同一个任务跑自己的循环。

因此每次调用都会剥掉 Claude Code 的自主性 —— 禁用全部内置工具、不加载它自己的 MCP server、不读 `CLAUDE.md` 和用户设置（`settingSources: []`）、并设死轮次上限。prompt 由 harness 组装；Claude Code 只负责回答，仅此而已。

### 代价是什么

**token 用量不会翻倍。** 两个 harness 不等于两个模型：只有一个智能体循环，每一步只有一次模型调用。

但确实存在固定开销。在本项目实测（system prompt 已被替换、且未发布任何工具）：

| | tokens |
|---|---|
| Claude Code 自身上下文，首次调用 | 28,098（写入缓存） |
| 同一份上下文，下一次调用 | 28,021（读取缓存） |
| 我们自己的新增输入 | 2 |

这块开销无法去掉。它由服务端做 prompt 缓存，并且跨进程有效 —— 上面两次测量来自两次独立的 `claude` 调用，第二次已经是缓存读取。

实际影响在于**循环的每一步都是一次全新调用**：一个包含 8 次工具调用的任务，就是 8 次 `claude` 调用，每次都带着那一块（通常命中缓存，但从不免费），外加一次进程启动。

每一步都重发完整对话**不算**这里的额外开销 —— 所有智能体循环都是这么做的，Claude Code 自己也一样。

### 你真正得到的

**你付的是固定订阅费，而不是按 token 计费的 API。** 这就是全部收益：你想用的 harness，连同它的 UI、插件、工具和会话模型，由 Claude 驱动，而不产生按量计费。

另一面也要一样说清楚。**若论纯粹的效率，直接用 Claude Code 更划算。** 它维持一个热会话、上下文经过优化、没有每步的固定开销、也不需要把结构化的消息数组压平成一份文本文档。如果目标是每个任务少花 token，这座桥就是错的工具。

这座桥的价值在于：当 DeepSeek Harness 正是你想用的 harness —— 因为模型外围的那一整套 —— 而订阅是你想采用的付费方式时。

### 工具调用只作为数据回传，绝不执行

Claude Code 不接受把任意工具 schema 当参数传入。唯一能接纳外部工具的接口是 MCP，所以 `GenerateOptions.tools` 通过一个**进程内 MCP server** 发布出去，从而拿到原生的 `tool_use` 块和增量的 `input_json_delta` —— 不需要对 markdown 做正则抓取。

这个 server 建在底层协议 server 上，而不是 SDK 的 `tool()` 辅助函数，因为后者要求 Zod raw shape，而 harness 给我们的是 JSON Schema；JSON Schema → Zod → JSON Schema 这一圈转换会悄悄丢掉转换器无法建模的东西。现在 schema 是逐字节原样送出的。

两个关键细节：

- 每个工具都带 `_meta['anthropic/alwaysLoad']`。没有它，工具会被推迟到 Claude Code 自己的 `ToolSearch` 后面，模型会把仅有的一轮花在搜索工具上，而不是调用它。
- 工具调用一旦组装完成，传输层会立刻**中止** provider。真正阻止执行的是这一步；MCP 的调用处理器只是兜底。

之后由 harness 执行工具，并带着结果再次调用模型，和任何其他 provider 完全一样。

### 订阅额度

Claude Code 用自然语言报告额度限制，而不是 HTTP 状态码。5 小时或每周窗口的限制被归类为 `RATE_LIMIT`，在对方告知重置时间时附上 `providerRetryAfterMs` —— 刻意与 `QUOTA`（余额耗尽）区分开，因为两者处理方式相反：一个等一等就好，另一个等多久都没用。重试本身交给 `llm-retry` 插件；本桥只声明策略。

## 已知限制

这些是设计取舍的结果，不是未完成的工作。

- **没有 attribution headers。** `LlmAdapter` 要求每个 provider HTTP 请求都带上 `attributionHeaders()`。本桥自己不发任何 HTTP —— 与 Anthropic 通信的是官方 CLI，它发送自己的 `User-Agent` 且不提供覆盖。要满足这个约定就得直接代理订阅凭证，而那恰恰是本插件拒绝做的事。
- **仅支持文本。** CLI 接收的是文本 prompt，因此 `listModels`/`resolveModel` 声明 `inputModalities: ['text']`。图片会被明确拒绝，而不是悄悄丢掉。
- **不支持 stop sequences。** CLI 没有对应选项。忽略 `stop` 会在调用方不知情的情况下改变模型允许产出的内容，所以请求直接以 `UNSUPPORTED_OPTION` 被拒绝。
- **`temperature` 和 `maxTokens` 被忽略**，每个适配器实例只警告一次。CLI 根本没有对应旋钮，而为了两个建议性的调节参数让每个请求都失败，只会让这个 provider 无法使用。
- **固定开销。** Claude Code 每次调用注入约 28k tokens 的自身上下文 —— 在替换了 system prompt 且未发布工具的纯文本请求上实测。它有 prompt 缓存，首次调用之后表现为 `cacheReadTokens` 而非新增输入，但无法去掉。
- **`spawn` 传输仅支持文本。** MCP 桥接是一个进程内的 server 对象，跨不过进程边界，而且已安装的 CLI 没有 `--max-turns`。带工具的调用会被拒绝，而不是降级成散文。

## 路线图

### Codex / ChatGPT 订阅 —— 计划中

对 **Codex CLI** 做同样的事，让 ChatGPT Plus/Pro 订阅也能驱动 harness。它会作为同一个插件里 `claude` 旁边的一个 `codex` 段落落地 —— 是第二座桥，不是第二个包，通过它自己的 `enabled` 开关独立控制。

可以原样复用的：

- `StreamChunk` 协议翻译器及其不变式
- 那个"收编"思路 —— 把一个智能体 CLI 降级为补全端点，只保留一个循环
- 捕获并中止的工具拦截方式
- 错误分类体系、模型清单缓存、以及推理强度的接线

必须重做的：wire 事件映射（Codex 有自己的流格式，不是 Anthropic 的）、模型发现，以及那个 CLI 所暴露的收编开关。

同样的原则依旧适用 —— 驱动**官方 CLI**，绝不从它的凭证库里把订阅 token 抠出来。

## 服务条款

本插件的工作方式是**调用各厂商的官方 CLI**，它们都是使用自己会话的第一方客户端。

它刻意**不**去读 `~/.claude/.credentials.json` 里的 OAuth token，也不把订阅凭证代理到 `api.anthropic.com`。Anthropic 的条款把 Claude Pro/Max 限制在自家界面内，并禁止代理或转售访问权。社区里有些插件走的是抠 token 那条路；本插件不走，上面那些限制就是这个选择的代价。

你需要自行确保符合各厂商的条款。

## 开发

```bash
npm run typecheck && npm test && npm run build
```

测试分为几层：

| 文件 | 它锁定的东西 |
|---|---|
| `tests/events.spec.ts` | `StreamChunk` 协议不变式，基于真实调用录制的 NDJSON。 |
| `tests/errors.spec.ts` | 失败分类，包括"套餐限流"与"余额耗尽"的区分。 |
| `tests/request.spec.ts` | 对话压平、转义，以及按字节预算的截断。 |
| `tests/catalog.spec.ts` | 发现结果缓存、并发探测合并，以及 CLI 无法应答时的兜底。 |
| `tests/effort.spec.ts` | 逐模型的强度声明，以及所选强度一路传到传输层请求的路径。 |
| `tests/plugin.spec.ts` | 真实组合：把 `LlmRuntime` 和本插件挂到 Cordis context 上，断言路由注册、模型解析与开关行为。 |

live 测试会调用真实 CLI 并消耗订阅额度，因此默认跳过，需显式开启。它们是唯一能发现"本插件的收编选项"与"已安装 CLI"之间漂移的测试 —— 尤其是 harness 的工具是否仍然直达模型，而没有被推到 `ToolSearch` 后面：

```bash
DSH_CLAUDE_LIVE=1 npx vitest run
```

在 PowerShell 下：

```bash
$env:DSH_CLAUDE_LIVE='1'; npx vitest run
```

`tests/plugin.spec.ts` 里的 live 用例通过 `ctx.llm.stream()` 驱动一次生成并送进 `BlockAssembler` —— 走的正是智能体循环所走的路径，而不是直接调用适配器。

### 新增一座桥

一座新桥 = `Config` 里的一个段落 + provider 声明里的一条 + 一个 `LlmAdapter`。协议翻译器、错误分类体系、模型清单缓存和推理强度接线都是与 provider 无关的，本就是为复用而写的。

## 许可证

MIT
