# Command Code Provider for OpenCode V2

把 Command Code API 的 90+ 模型接入 OpenCode V2 的插件，全平台（Windows / macOS / Linux）。

这是 [@herouucn/opencode-commandcode](https://github.com/herouu/opencode-commandcode)
的 **V2 移植版**：原插件使用 V1 插件 API（`config` / `auth` 钩子），在 OpenCode 2
上无法加载（`PluginModule.LoadError: Plugin must export a default definition with an id
and an effect or setup function.`）。本插件用 V2 插件 API 重新实现其全部功能。

## 功能

| 功能 | 说明 |
| --- | --- |
| 零配置注入 | 启动时注册 `commandcode` provider，使用 OpenAI 兼容运行时 |
| 模型目录 | 每次启动拉取远程 `models.json`，含名称、价格、上下文/输出上限、图片/视频输入、推理档位 |
| 离线兜底 | 拉取失败时复用上次成功缓存的目录（存在插件 storage 中） |
| 凭据集成 | 注册 `commandcode` 集成，支持 API Key（`/connect`）与环境变量两种方式 |
| 推理档位 | 支持 `low/medium/high/xhigh/max`，如 `commandcode/claude-fable-5#high` |
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

或 TUI 里 `/connect` → **Command Code** → **API Key** → 粘贴。

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
| `COMMANDCODE_CATALOG_URL` | 自定义模型目录地址；设为 `disabled` 关闭远程拉取 |

```bash
# 全平台
opencode service set env COMMANDCODE_CATALOG_URL disabled
```

## 实现要点

- **Provider**：`Provider.Info` + `@opencode/ai/providers/openai-compatible`，
  `baseURL = https://api.commandcode.ai/provider/v1/`。
- **模型映射**：配置键取模型 ID 中 `/` 之后的部分并小写（如 `moonshotai/Kimi-K2.6`
  → `kimi-k2.6`），`modelID` 保留上游完整 ID；同一键冲突时后者覆盖（与原插件一致）。
- **重名消歧**：显示名相同的模型自动追加后缀（如 `… (Free)`）。
- **凭据**：`Provider.Info.integrationID` 指向 `commandcode` 集成；集成注册
  `env`（`COMMANDCODE_API_KEY`）与 `key` 两种方法，OpenCode 负责把凭据注入请求。
- **包入口**：OpenCode 的包插件加载器优先解析 `exports["./server"]`、回退 `exports["."]`，
  两者都指向 `commandcode.ts`。
- **Claude 路由**：Command Code 的 Claude 系只能走 Anthropic Messages 接口
  （`/provider/v1/messages`），因此这些模型在**模型级**使用 `anthropic-compatible`
  运行时（`x-api-key` 鉴权），其余模型用 `openai-compatible`（`/chat/completions`）。
- **内容兼容**：Command Code 只接受 **text 与 image**。插件在 `context` 钩子里把
  **文档附件**（含 tool result 里的文档）改写为指向工作区文件的 **markdown 文件引用**
  （内联附件按内容哈希落盘到 `.opencode/attachments/`，该目录自带 `.gitignore`，不会进版本库），
  模型可自行决定是否用工具读取；同时把对话中的 `system` 角色消息并入顶层 system 提示。

## 与原插件的差异

- 不做本地 `command-code` CLI 包提取（原 `COMMANDCODE_PACKAGE_PATH` / 本地包发现）。
- 不读取 `~/.config/opencode/opencode-commandcode.json`，仅支持环境变量覆盖目录地址。
- 目录缓存改用 OpenCode 插件 storage，而非 `~/.local/state/opencode/...` 文件。

## 已知限制

- Command Code 不接受 PDF / 文档块：附件会被改写为**文件引用**（见「实现要点」），
  模型需用自己的工具去读（如本机用 `python` + `pymupdf` 解析 PDF）。
- 目录中个别免费模型（如 `minimax-m3-free` / `MiniMaxAI/MiniMax-M3-Free`）为
  Command Code 官方 CLI 专用，通过 API 会返回
  `... is only available in the Command Code CLI.`，属上游限制。
- Claude 系对攻防/漏洞利用类内容会触发 Anthropic 的 **cyber safeguard** 拦截
  （`Provider blocked the response (cyber)`），属上游策略；CTF 建议以 GLM / DeepSeek 系为主力。
- 部分高阶 OpenAI 模型（如 `GPT-6.1 Sol`）不在 GOAT 套餐内，会返回
  `MODEL_NOT_IN_PLAN`，需要 Pro / Max 或按量付费。

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
