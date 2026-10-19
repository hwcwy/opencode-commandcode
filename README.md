# Command Code Provider for OpenCode V2

把 Command Code API 的 80+ 模型接入 OpenCode V2 的插件，全平台（Windows / macOS / Linux）。

这是 [@herouucn/opencode-commandcode](https://github.com/herouu/opencode-commandcode)
的 **V2 移植版**：原插件使用 V1 插件 API（`config` / `auth` 钩子），在 OpenCode 2
上无法加载（`PluginModule.LoadError: Plugin must export a default definition with an id
and an effect or setup function.`）。本插件用 V2 插件 API 重新实现其全部功能。

**数据只来自 Command Code 官方**（官方模型接口 + 官方文档页），不使用任何第三方镜像目录。

## 功能

| 功能 | 说明 |
| --- | --- |
| 零配置注入 | 启动时注册 `commandcode` provider，使用 OpenAI 兼容运行时 |
| 模型目录（官方 API） | 拉取 `api.commandcode.ai/provider/v1/models`，决定**有哪些模型**、上下文长度与可用端点（Claude 走 Messages，其余走 chat/completions） |
| 能力/价格（官方文档） | 解析官方文档页内嵌的整份目录 JSON：`vision` / `reasoning`、上下文、官方价格（含长上下文分档）、发布时间、**最低套餐** |
| 思考等级 | 官方 CLI 目录的 `reasoningEfforts` → OpenCode `variants`：Claude 走 `effort`（`output_config.effort`），其余走 `reasoningEffort`（`reasoning_effort`）；启动时自动拉最新（24h 缓存） |
| 订阅过滤 | 连接 API Key 时表单里有「Subscription plan」选择器（或 `COMMANDCODE_PLAN`），按官方 `minPlanName` 隐藏高于你套餐的模型 |
| 离线兜底 | 拉取失败复用上次成功缓存（插件 storage，1 小时 TTL） |
| 凭据集成 | 注册 `commandcode` 集成，支持 API Key（`/connect`）与环境变量两种方式 |
| 全平台 | 插件源码只用 `fetch` / `process.env` / 插件 storage，无平台特有 API |

## 文件

| 文件 | 说明 |
| --- | --- |
| `commandcode.ts` | 插件源码（OpenCode 加载的入口，跨平台） |
| `package.json` | 插件包清单，`exports["./server"]` 指向插件入口 |
| `install.ps1` | 方式二：Windows 本地安装脚本 |
| `install.sh` | 方式二：macOS / Linux 本地安装脚本 |
| `README.md` | 本文档 |

## 平台

- 插件运行于 **Windows / macOS / Linux**，源码不含任何平台特有逻辑。
- 只有「方式二」的本地安装脚本分平台：`install.ps1`（Windows）/ `install.sh`（macOS、Linux）。
- OpenCode 全局配置目录：`$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`（macOS/Linux）、`%USERPROFILE%\.config\opencode`（Windows）。

## 安装

### 方式一：OpenCode 内置命令（推荐，全平台）

```bash
opencode plugin add github:hwcwy/opencode-commandcode
```

它会把 `github:hwcwy/opencode-commandcode` 写入全局 `opencode.json(c)` 的 `plugins` 并缓存安装包。更新 / 查看：

```bash
opencode plugin update opencode-commandcode
opencode plugin list
```

### 方式二：本地插件文件

把 `commandcode.ts` 复制到全局插件目录（OpenCode 会监听并自动热重载）：

macOS / Linux：

```bash
bash ./install.sh
```

Windows（PowerShell）：

```powershell
pwsh -File .\install.ps1
```

手动复制：

```bash
# macOS / Linux
cp ./commandcode.ts "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/commandcode.ts"
```

```powershell
# Windows
Copy-Item .\commandcode.ts "$env:USERPROFILE\.config\opencode\plugins\commandcode.ts" -Force
```

> 也可以在项目 `opencode.json(c)` 里用绝对路径指向本文件：
> ```jsonc
> { "plugins": ["file:///home/me/opencode-commandcode/commandcode.ts"] }
> ```

> 两种方式**只选其一**，同时使用会重复注册 provider。

## 配置凭据（二选一）

```bash
# 方式一：写入 OpenCode 服务的环境变量（全平台）
opencode service set env COMMANDCODE_API_KEY 你的key
```

或 TUI 里 `/connect` → **Command Code** → **API Key** → 粘贴 key，并在
**Subscription plan** 选择你的套餐（Show all / Go / GOAT / Pro / Max）。
选择后模型列表只显示该套餐可用的模型。

> 已连接过的账号想在 `/connect` 里改套餐：重新连接一次即可（会生成一条新凭据，
> 旧的可在连接界面删除），或者改用下面的 `COMMANDCODE_PLAN`。

## 使用

```bash
# TUI
/models      # 选择 Command Code 下的模型，例如 commandcode/claude-fable-5

# 命令行单次调用
opencode run --model commandcode/deepseek-v4-flash "hi"
```

## 可选环境变量

| 变量 | 作用 |
| --- | --- |
| `COMMANDCODE_PLAN` | `go` / `goat` / `pro` / `max`（或 `all` 不过滤）。设置后优先于连接表单里的选择 |
| `COMMANDCODE_DOCS_URL` | 覆盖官方文档目录页；设为 `disabled` 则不拉取文档目录（只剩 API 列表，无能力/价格/套餐数据） |
| `COMMANDCODE_OFFLINE` | 设为 `1` 时完全不联网，只用插件缓存 |

```bash
# 全平台
opencode service set env COMMANDCODE_PLAN goat
```

## 实现要点

- **Provider**：`Provider.Info` + `@opencode/ai/providers/openai-compatible`，
  `baseURL = https://api.commandcode.ai/provider/v1/`。
- **数据来源（全部官方，共两条）**：
  1. `https://api.commandcode.ai/provider/v1/models`：模型**存在性**（幽灵模型不会出现）、
     `context_length`、`supported_endpoints`。
  2. 官方文档页（`/docs/plans/go`、`/goat`、`/pro` 任一页都内嵌**整份目录 JSON**，含全部模型的
     `vision` / `reasoning` / `caps`、`contextWindow`、官方价格（`inputCost` / `outputCost` /
     `cacheReadCost` / `cacheWriteCost`，含 `> 100K` 长上下文档）、`minPlanName`、`launchedAt`）。
- **文档与 API 的匹配**：文档 `id`/`slug` 与 API `id` 归一化后匹配（转小写、去厂商前缀、
  `.`/`_` → `-`、去 `-YYYYMMDD` 日期后缀、去 `:free` 等后缀），当前 **88/88 全匹配**。
- **套餐过滤**：官方套餐层级为 `Go < GOAT < Pro < Max`，隐藏 `minPlanName` 高于所选套餐的模型。
  参考数量：Go 54 / GOAT 64 / Pro 78 / Max 88（以官方当日数据为准）。
- **模型映射**：配置键取模型 ID 中 `/` 之后的部分并小写（如 `moonshotai/Kimi-K2.6`
  → `kimi-k2.6`），`modelID` 保留上游完整 ID；同一键冲突时后者覆盖（与原插件一致）。
- **重名消歧**：显示名相同的模型自动追加后缀（如 `… Free`）。
- **凭据**：`Provider.Info.integrationID` 指向 `commandcode` 集成；集成注册
  `env`（`COMMANDCODE_API_KEY`）与 `key` 两种方法，OpenCode 负责把凭据注入请求。
  `key` 方法带一个表单字段 `plan`，答案会存进凭据的 `configuration`，插件启动时读取。
- **套餐热更新**：插件订阅 `credential.*` / `integration.updated` 事件，重连或切换凭据后
  无需重启服务即可刷新模型列表。
- **包入口**：OpenCode 的包插件加载器优先解析 `exports["./server"]`、回退 `exports["."]`，
  两者都指向 `commandcode.ts`。
- **Claude 路由**：Command Code 的 Claude 系只能走 Anthropic Messages 接口
  （`/provider/v1/messages`），因此这些模型在**模型级**使用 `anthropic-compatible`
  运行时（`x-api-key` 鉴权），其余模型用 `openai-compatible`（`/chat/completions`）。
- **内容兼容**：Command Code 只接受 **text 与 image**。插件在 `context` 钩子里把
  **文档附件**（含 tool result 里的文档）改写为指向工作区文件的 **markdown 文件引用**
  （内联附件按内容哈希落盘到 `.opencode/attachments/`，该目录自带 `.gitignore`，不会进版本库），
  模型可自行决定是否用工具读取；同时把对话中的 `system` 角色消息并入顶层 system 提示。
- **Thinking 块**：Claude 的 thinking 块签名绑定会话前缀，system 提示一变（OpenCode 会随
  tools/MCP 变化重写它）上游就报 `Invalid signature in thinking block`。官方解法
  （`thinking.block_binding=drop_block` + `anthropic-beta` 头）经测试**不被 Command Code 透传**，
  因此插件在发送前**丢弃回放的 thinking 块**（仅 Claude 模型）。

## 与原插件的差异

- **目录只来自官方**：不使用原插件的第三方 `models.json` 镜像。
- **思考等级来自官方 CLI 目录**（而非第三方镜像）：运行时从官方 `command-code` 包读取 `reasoningEfforts`。
- 不做本地 `command-code` CLI 包提取（原 `COMMANDCODE_PACKAGE_PATH` / 本地包发现）。
- 不读取 `~/.config/opencode/opencode-commandcode.json`，仅支持环境变量覆盖。
- 目录缓存改用 OpenCode 插件 storage，而非 `~/.local/state/opencode/...` 文件。

## 已知限制

- **思考等级**：只有 reasoning 模型才生成 `variants`（OpenCode 非思考模型无档位）；官方目录未收录但为 reasoning 的模型统一给 `low/medium/high`，若某上游实际忽略该参数，选择档位不会报错但可能无效果。
- Command Code 不接受 PDF / 文档块：附件会被改写为**文件引用**（见「实现要点」），
  模型需用自己的工具去读（如本机用 `python` + `pymupdf` 解析 PDF）。
- Claude 系对攻防/漏洞利用类内容会触发 Anthropic 的 **cyber safeguard** 拦截
  （`Provider blocked the response (cyber)`），属上游策略；CTF 建议以 GLM / DeepSeek 系为主力。
- 套餐过滤基于你声明的套餐；若声明高于实际，高出部分仍会返回 `MODEL_NOT_IN_PLAN`。
- 连接表单只在 `/connect`（或 `opencode auth login`）时出现，不能事后改。

## 卸载

内置命令安装的：

```bash
opencode plugin remove opencode-commandcode
```

本地文件安装的：

```bash
# macOS / Linux
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/commandcode.ts"
```

```powershell
# Windows
Remove-Item "$env:USERPROFILE\.config\opencode\plugins\commandcode.ts"
```

如需删除已保存的凭据：

```bash
opencode auth logout commandcode
```

## 致谢

- 原始实现：[herouu/opencode-commandcode](https://github.com/herouu/opencode-commandcode)（MIT）——本插件是其 OpenCode V2 移植版。
- 插件 API：[@opencode/plugin](https://www.npmjs.com/package/@opencode/plugin)。

## 许可证

[MIT](./LICENSE)。本仓库包含源自上述原始项目的部分逻辑，其版权声明一并保留在 LICENSE 中。
