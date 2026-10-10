# Command Code Provider for OpenCode V2

把 Command Code API 的 90+ 模型接入 OpenCode V2 的本地插件。

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

## 文件

| 文件 | 说明 |
| --- | --- |
| `commandcode.ts` | 插件源码（就是 OpenCode 加载的那个文件） |
| `install.ps1` | 把插件复制到全局插件目录 |
| `README.md` | 本文档 |

## 安装 / 更新

插件当前生效位置：

```
%USERPROFILE%\.config\opencode\plugins\commandcode.ts
```

从本目录同步过去（OpenCode 会监听该文件并自动热重载）：

```powershell
pwsh -File .\install.ps1
```

或手动：

```powershell
Copy-Item .\commandcode.ts "$env:USERPROFILE\.config\opencode\plugins\commandcode.ts" -Force
```

> 也可以不用全局目录，改为在某个 `opencode.json(c)` 里指向本文件：
> ```jsonc
> { "plugins": ["file:///C:/Users/hcy34/Desktop/opencode-command/commandcode.ts"] }
> ```

## 配置凭据（二选一）

```powershell
# 方式一：写入 OpenCode 服务的环境变量
opencode service set env COMMANDCODE_API_KEY 你的key
```

或 TUI 里 `/connect` → **Command Code** → **API Key** → 粘贴。

## 使用

```
/models      # 选择 Command Code 下的模型，例如 commandcode/claude-fable-5
```

命令行单次调用：

```powershell
opencode run --model commandcode/deepseek-v4-flash "hi"
```

## 可选环境变量

| 变量 | 作用 |
| --- | --- |
| `COMMANDCODE_CATALOG_URL` | 自定义模型目录地址；设为 `disabled` 关闭远程拉取 |

## 实现要点

- **Provider**：`Provider.Info` + `@opencode/ai/providers/openai-compatible`，
  `baseURL = https://api.commandcode.ai/provider/v1/`。
- **模型映射**：配置键取模型 ID 中 `/` 之后的部分并小写（如 `moonshotai/Kimi-K2.6`
  → `kimi-k2.6`），`modelID` 保留上游完整 ID；同一键冲突时后者覆盖（与原插件一致）。
- **重名消歧**：显示名相同的模型自动追加后缀（如 `… (Free)`）。
- **凭据**：`Provider.Info.integrationID` 指向 `commandcode` 集成；集成注册
  `env`（`COMMANDCODE_API_KEY`）与 `key` 两种方法，OpenCode 负责把凭据注入请求。

## 与原插件的差异

- 不做本地 `command-code` CLI 包提取（原 `COMMANDCODE_PACKAGE_PATH` / 本地包发现）。
- 不读取 `~/.config/opencode/opencode-commandcode.json`，仅支持环境变量覆盖目录地址。
- 目录缓存改用 OpenCode 插件 storage，而非 `~/.local/state/opencode/...` 文件。

## 已知限制

- 目录中个别免费模型（如 `minimax-m3-free` / `MiniMaxAI/MiniMax-M3-Free`）为
  Command Code 官方 CLI 专用，通过 API 会返回
  `... is only available in the Command Code CLI.`，属上游限制。

## 卸载

```powershell
Remove-Item "$env:USERPROFILE\.config\opencode\plugins\commandcode.ts"
opencode auth logout commandcode   # 如需删除已保存的凭据
```

## 致谢

- 原始实现：[herouu/opencode-commandcode](https://github.com/herouu/opencode-commandcode)（MIT）——本插件是其 OpenCode V2 移植版。
- 插件 API：[@opencode/plugin](https://www.npmjs.com/package/@opencode/plugin)。

## 许可证

[MIT](./LICENSE)。本仓库包含源自上述原始项目的部分逻辑，其版权声明一并保留在 LICENSE 中。
