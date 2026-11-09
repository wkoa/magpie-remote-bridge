# Magpie Remote Bridge

维护者自动发布配置见 [发布说明](docs/PUBLISHING.md)：主分支六组 CI 全部通过后，可通过 GitHub OIDC 将新版本发布到 VS Code Marketplace。

Use your local Magpie AI gateway from a VS Code Remote-SSH workspace. Keep provider accounts and upstream keys on your computer while coding agents work with remote files and terminals. Supports authenticated HTTP/SSE forwarding and OpenAI-compatible / Anthropic model APIs.

让 VS Code Remote-SSH 中的编程 agent 直接使用你本机的 Magpie 网关。模型供应商、订阅登录和上游密钥继续由本机 Magpie 管理，远端无需再安装或配置一份 Magpie。

在本机 VS Code 扩展面板搜索 `@id:wkoa.magpie-remote-bridge`，或打开 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=wkoa.magpie-remote-bridge) 安装。也可从 [GitHub Releases](https://github.com/wkoa/magpie-remote-bridge/releases/latest) 下载 VSIX 安装包。本项目为独立社区插件，与 Magpie、Microsoft、Anthropic 或 OpenAI 无官方隶属关系。

默认连接本机 `http://127.0.0.1:3425`，在远端提供 `http://127.0.0.1:13425`。

## v0.2 使用体验

- 点击状态栏 **Magpie** 打开统一菜单，连接、启动终端、选择模型、诊断和设置都在这里。
- 连接时显示阶段和取消按钮。取消会停止检查、关闭密码输入框并释放本次连接资源。
- 自动重连期间，终端命令等待当前重连，保留已有终端和临时令牌；重试耗尽后才撤销会话。
- 出错时提供“重试”“打开设置”“更改 SSH Host”“显示日志”等操作，日志带时间和级别并隐藏已知密钥。
- 支持简体中文和英文界面，自动跟随 VS Code 语言；可通过 **Magpie: 使用入门** 查看引导。

**English quick start:** Start Magpie locally, install this extension on the local side, open a remote folder with Remote-SSH, then run **Magpie: Connect Local Gateway to Remote**. Select the same SSH server and user as your workspace. Use the status bar menu to launch your remote agent. The UI follows VS Code's language; Simplified Chinese and English are included.

从旧的 `local-tools.magpie-remote-bridge` VSIX 迁移时，请先断开桥接并禁用或卸载旧插件，再安装发布者为 `wkoa` 的版本。新版本的扩展 ID 为 `wkoa.magpie-remote-bridge`，原来的 Host 映射和 SecretStorage 不会跨扩展 ID 自动迁移。插件会检测旧发布者扩展并提醒处理，但不会自动卸载或修改其他扩展。

```text
远端 agent（CLI / 支持自定义地址的扩展）
  → 远端 127.0.0.1:13425
  → SSH 反向转发
  → 本机带临时令牌鉴权的 API 代理
  → 本机 Magpie 127.0.0.1:3425
  → Magpie 已配置的模型和账号
```

## 安装和使用

1. 本机启动 Magpie，确保网关运行在 `127.0.0.1:3425`。
2. 在本机 VS Code 搜索 `@id:wkoa.magpie-remote-bridge` 并安装；也可选择 **Install from VSIX… / 从 VSIX 安装…**，安装下载的 `magpie-remote-bridge-<版本>.vsix`。扩展应安装在本机；它通过 `extensionKind: ["ui"]` 明确运行在本机。
3. 使用 VS Code **Remote-SSH** 打开远端项目文件夹。
4. 命令面板执行 **Magpie: 连接本机网关到远端**。首次选择与当前工作区对应的 SSH Host，首项会从当前工作区解析，保留用户名及显式 SSH 端口。每个远端 authority 的选择会在本机记住。
5. 执行 **Magpie: 在远端启动 Claude Code** 或 **Magpie: 在远端启动 Codex CLI**。终端工作目录就是远端项目，文件操作和命令执行发生在远端。

Claude Code 会读取本机 `~/.claude/settings.json` 中指向当前 Magpie 网关的模型环境项，仅同步白名单中的模型字段。也可以执行 **Magpie: 选择远端 agent 的模型** 显式指定，或在选择器中选择“使用本机 Magpie 的默认模型配置”清除覆盖设置。Codex 首次启动需选择一个模型，使用 `-c` 临时指定独立 provider，不修改远端 `~/.codex/config.toml`。

启动前，插件复用当前私有 SSH 认证连接检查远端 `claude` / `codex`，覆盖普通 PATH、`~/.local/bin`、`~/bin`、`~/.npm-global/bin`，以及交互登录/非登录 shell 初始化后的 PATH（例如 nvm）。找到后使用可执行文件的绝对路径，并仅为本次启动将其目录加入 PATH；无需先修改全局 PATH 或远端 shell 配置。检查可取消，15 秒超时，输出大小有上限。

未找到 CLI 时，插件提示“需要在远端安装”，提供 **打开远端终端**、**官方安装说明** 和 **重试**，不会向终端发送注定失败的启动命令。检查失败时还可查看日志。取消或缺失 CLI 不会断开已工作的网关；预配置终端仍携带桥接地址和临时令牌，安装完成后重新执行插件启动命令即可。

- [Codex 官方安装说明](https://github.com/openai/codex)：支持 Linux ARM64 原生二进制，无需 Node.js/npm。请按远端系统和架构选择官方发布包；本机安装 Codex 不等于远端已安装。
- [Claude Code 官方安装说明](https://code.claude.com/docs/en/setup)：按官方说明在远端安装。

插件不自动下载或安装 CLI，不执行远程下载脚本。选择模型只影响之后启动的会话，不切换已运行会话，也不修改本机 Magpie 的模型选择。

**Remote CLI prerequisites (English):** The launcher checks the CLI through the session's private SSH connection before opening an agent terminal. It checks PATH, user bin directories, and interactive login/non-login shell initialization (including nvm), then launches the resolved absolute path with its directory added to PATH for that process. The check is cancellable, has a 15-second timeout, and bounds its output. If the CLI is missing or inspection fails, the bridge stays connected and offers a configured remote terminal, the official installation guide, and retry. Install the CLI on the remote machine and launch again. [Codex](https://github.com/openai/codex) provides a native Linux ARM64 binary without Node.js/npm; [Claude Code](https://code.claude.com/docs/en/setup) has its own official installation instructions. The extension does not download installers or change remote shell configuration.

## Codex 官方 VS Code 侧边栏（v0.3）

在 SSH 主机安装官方 `openai.chatgpt` 扩展后，执行 **Magpie: 连接 Codex 侧边栏（当前远端账户）**，选择模型并新建 Codex 对话。该入口配置侧边栏内置 app-server 使用 Magpie，无需从预配置终端启动。终端中的环境变量不会自动注入侧边栏。

- 本机支持 macOS/Linux，远端支持 Linux x64/ARM64，需 Python 3、curl、支持 Unix socket 反向转发的 OpenSSH/sshd，以及支持 `model_providers.<id>.auth.command` 的官方 Codex 内置版本。启用时会执行严格兼容检查；本机 Windows 暂不支持侧边栏凭据通道，CLI 功能继续可用。
- 使用官方配置 RPC，只修改远端 `CODEX_HOME/config.toml` 中的模型、默认 provider 和专用的 `magpie_vscode_bridge`。默认 `CODEX_HOME` 为 `~/.codex`；远端 extension host 与 SSH 登录环境必须使用同一目录。不修改第三方扩展文件或 `chatgpt.cliExecutable`；已有自定义 CLI 覆盖时会拒绝启用。
- **作用域为同一远端账户的 Codex 配置。** 新建 Codex CLI/IDE 会话都可能使用该 provider；已有对话保留原 provider。每个账户只允许一个窗口启用侧边栏桥接，即使 TCP 端口不同也不会覆盖另一个窗口的配置。
- provider 只保存地址与凭据命令。Codex 通过权限受限的 Unix socket 获取本次临时令牌，socket 经 SSH 转发到本机；令牌不写入配置、脚本、恢复记录或命令参数，不开放无认证 TCP 代理。
- 手动断开时先自动恢复侧边栏接入前的 Codex 配置，再关闭 SSH 和代理。更换 Host、更新网关密钥、应用连接设置及正常停用扩展也使用此流程；窗口重载会尽力等待恢复完成。
- 远端在配置前启动独立恢复守护进程。窗口被强制关闭、网络中断或重连耗尽时，凭据通道持续失联约 60 秒后自动恢复；短暂断线后重连成功则继续使用桥接。守护进程只检查私有 socket 的无凭据健康接口，不读取或保存令牌，不会接管新窗口的租约。
- 恢复失败会保留恢复记录；守护进程继续有限重试。必要时仍可执行 **Magpie: 恢复 Codex 原配置（当前远端账户）** 手动恢复。旧版本已遗留的配置也需使用此命令恢复一次。
- 恢复通过配置版本检查，只还原仍与插件写入值相同的字段，保留用户后续修改。非敏感恢复记录保存在远端 `CODEX_HOME/.magpie-remote-bridge.json`（0600）；网络中断后仍可恢复。恢复后新建 Codex 对话使用原 provider。

**验证边界：** 已在本机官方内置 app-server 验证配置 RPC、凭据命令认证、新对话 provider 选择及本机模拟 SSE 往返；远端真实侧边栏界面与真实模型请求仍待验收。CLI 的既有验收不能替代侧边栏验收，详见 [验证记录](docs/VALIDATION.md)。

**Codex sidebar (English):** Install the official `openai.chatgpt` extension on the SSH host, run **Magpie: Connect Codex Sidebar (Remote Account)**, and start a new chat. This updates the remote account's Codex provider through its official config RPC. A command obtains the session capability through a private SSH-forwarded Unix socket; credentials are never written to config or command arguments. The remote host needs Python 3, curl and a bundled Codex version with command-based provider auth. macOS/Linux clients and Linux x64/ARM64 servers are supported. One window may own the sidebar provider per remote account. Disconnect automatically restores the previous configuration before closing SSH. A detached remote watchdog restores it after about 60 seconds of continuous credential-channel loss, including a forced window close; a brief outage can reconnect within that grace period. Restoration preserves later user edits. If recovery fails or an older version left configuration behind, use **Magpie: Restore Codex Configuration (Remote Account)**. Remote sidebar UI and live model acceptance remain pending.

## 其他终端和远端扩展

**Magpie: 打开预配置的远端终端** 创建一个新的远端终端，注入：

- `OPENAI_BASE_URL=http://127.0.0.1:13425/v1`、`OPENAI_API_KEY`。
- `ANTHROPIC_BASE_URL=http://127.0.0.1:13425`、`ANTHROPIC_AUTH_TOKEN`。
- `MAGPIE_BRIDGE_URL`、`MAGPIE_BRIDGE_TOKEN`。
- Claude 模型环境项（本机使用 Magpie 时），或你在插件中选择的模型。

只有支持这些环境变量的程序会自动使用它们。普通 OpenAI-compatible 程序可在这个终端中直接启动。Codex 需要使用插件专用的启动命令，因为单独设置 `OPENAI_BASE_URL` 不保证覆盖已有 provider 和登录配置。

已有的其他远端 VS Code agent 扩展，可以执行 **Magpie: 复制远端扩展接入信息**，将地址和临时 API key 填入它自己的自定义 provider 设置。这些扩展需要支持对应协议和自定义 endpoint。其他扩展仍需自行配置；上面的 Codex 专用入口通过其官方配置 API 接入。插件不会影响已经打开的普通终端；终端环境不会注入远端 extension host。

## 命令

| 命令 | 用途 |
| --- | --- |
| Magpie: 连接本机网关到远端 | 检查本机网关，建立隧道，再从远端发起 HTTP 验证 |
| Magpie: 断开远端桥接 | 自动恢复 Codex 原配置，再结束隧道、关闭代理、销毁插件创建的终端 |
| Magpie: 更改当前工作区的 SSH Host | 清除当前工作区的映射并重新选择 |
| Magpie: 打开预配置的远端终端 | 新终端自动携带网关地址和临时令牌 |
| Magpie: 在远端启动 Claude Code | 使用本机模型环境或显式选择的模型 |
| Magpie: 在远端启动 Codex CLI | 临时 provider + Responses API + HTTP/SSE |
| Magpie: 连接 Codex 侧边栏（当前远端账户） | 官方配置 RPC + 私有 Unix socket 凭据命令，供新对话使用 |
| Magpie: 恢复 Codex 原配置（当前远端账户） | 恢复插件管理字段并保留用户后续修改 |
| Magpie: 选择远端 agent 的模型 | 从本机 Magpie 实时模型目录选择 |
| Magpie: 检查网关与隧道 | 只读检查本机目录及远端到本机的 HTTP 链路 |
| Magpie: 复制远端扩展接入信息 | 地址及本次会话临时令牌复制到剪贴板 |
| Magpie: 设置本机网关密钥 | 密钥保存在本机 VS Code SecretStorage |
| Magpie: 显示连接日志 | 查看带时间和级别的连接日志，不记录提示词、响应正文或令牌 |
| Magpie: 显示桥接操作 | 打开状态栏操作菜单 |
| Magpie: 打开桥接设置 | 定位本机桥接配置 |
| Magpie: 使用入门 | 打开安装与连接引导 |

## 配置

所有配置使用本机 application scope，远端仓库的 `.vscode/settings.json` 无法设置本机 SSH 可执行程序。

```json
{
  "magpieBridge.gatewayPort": 3425,
  "magpieBridge.remotePort": 13425,
  "magpieBridge.sshHost": "my-server",
  "magpieBridge.sshPath": "ssh",
  "magpieBridge.sshConfigFile": "",
  "magpieBridge.model": "",
  "magpieBridge.autoConnect": false,
  "magpieBridge.autoReconnect": true
}
```

`sshHost` 是首次选择时的候选值；已保存的工作区映射优先。选错 Host 时执行 **Magpie: 更改当前工作区的 SSH Host**。SSH 配置中的 Include / Match / ProxyJump 仍由 OpenSSH 解析；列表只枚举主文件的普通 Host，其他别名手动输入即可。

支持普通 Host 别名和 Remote-SSH 编码后的连接地址（包括 `user@host`、大小写主机名及显式端口）。v0.1.3 会自动修复旧版误存为 `7b22…` 的当前工作区映射。手动输入 IP 时请包含正确的远端用户名，例如 `user@host`；省略用户名会使用 SSH config 或本机用户名。手动输入支持 `user@host:2222`、`user@[2001:db8::1]:2222` 以及无端口的 IPv6；也可以在 SSH config 中配置 `Port` 并选择别名。端口不会被当成主机名传给 OpenSSH。Host 映射按工作区分别保存，旧版共享映射会在读取时迁移。

修改端口、SSH 路径或 SSH config 后，插件会提示重新连接，当前会话在用户选择重连之前继续沿用原配置。SSH config 路径支持 `~/`；Remote-SSH 若使用自定义 config 文件，应将桥接设置指向同一文件。多窗口连接同一个服务器时给各窗口选择不同的远端端口；当前版本端口配置为本机全局值，修改后仅影响新连接。

自动连接默认关闭。开启后，仅对已经明确选择并保存 Host 的可信 SSH 工作区生效。意外断线最多退避重连三次，保持当前代理和令牌；稳定一分钟后恢复重试次数。手动断开或重载窗口会撤销本次令牌，关闭插件创建的终端，下一次连接产生新令牌。

## 支持范围和前提

- 桌面版 VS Code 1.90+，本机 OpenSSH 8.7+，Remote-SSH；远端为 POSIX shell，有 `cat`、`printf` 和 `curl`。
- 本机能够 SSH 登录同一个远端用户。先通过 Remote-SSH 完成主机指纹确认；插件严格验证已知主机。macOS/Linux 支持安全输入框中的 SSH 密码、key passphrase 或 keyboard-interactive challenge；密码不落盘。Windows 暂时仅支持 key / ssh-agent 非交互登录；若系统内置 OpenSSH 低于 8.7，请安装满足要求的版本并设置 `magpieBridge.sshPath`。
- 使用独立 SSH 连接，继承 OpenSSH config（包括 ProxyJump、IdentityFile、Port 等），不依赖 Remote-SSH 私有 API。在 macOS/Linux 的私有临时目录创建本次连接专用的 control socket，连通性检测复用同一条认证会话，不复用其他软件的 SSH master。
- 服务器必须允许 remote TCP forwarding，且远端端口空闲。服务器 `GatewayPorts` 应为 `no`（默认）或 `clientspecified`；管理员强制 `yes` 可能扩大监听地址。
- API 白名单：`GET /v1/models`、`GET /v1/codex/models`，以及 `POST /v1/chat/completions`、`/v1/responses`、`/v1/responses/compact`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1/embeddings`。
- 支持 HTTP 请求和 SSE 流式响应；不支持 WebSocket、Gemini 原生协议、文件上传和 Magpie 管理/登录接口。Codex 强制禁用 WebSocket。
- 本机模型与账号经网关共享；完整 agent 进程、会话、skills、MCP 和本机文件系统不会被迁移到远端。若需要“本机运行 agent，远端只执行工具”，那是另一层工具桥，不属于这一版。
- 远端已有 agent 配置、shell 启动脚本或组织策略可能覆盖继承的环境变量；这种情况下先排除对应冲突。

## 凭据处理

上游 API key / OAuth 登录始终留在本机 Magpie。插件不扫描 Magpie 的 providers、logins 或本机 agent 的认证文件。本机 Claude settings 只提取固定白名单模型字段。

远端得到一个随机 256 位的会话 capability，它只能通过插件代理访问上述模型 API。代理向本机 Magpie 发出的认证值默认是 `magpie`（Magpie 默认 loopback 模式）；如你的网关需要专用 key，可用可选密钥命令设置，key 仅保存在本机 SecretStorage 并由代理替换注入。

临时 capability 经 VS Code terminal env 或 SSH 标准输入传递，不出现在 SSH / Codex 命令参数或连接日志中。用户主动复制接入信息时它会进入本机剪贴板。该令牌仍允许消耗模型额度；远端管理员及同账户进程能读取终端进程环境，应只连接可信服务器。

SSH 密码通过 OpenSSH ASKPASS 与本机随机令牌保护的回环 IPC 传递；输入框收到的密码直接返回 SSH，不缓存、不保存。临时目录权限为 0700，只包含启动脚本与 SSH control socket，断开后清理。重连若需要认证会重新提示。

## 故障排查

- **Could not resolve hostname 7b22…**：旧版误把 Remote-SSH 编码地址当成了主机名，升级到 v0.1.3 后重新连接。若安装的是旧发布者 `local-tools`，按上方迁移步骤替换，避免两个版本同时注册命令。
- **本机网关不可用**：确认 Magpie 已打开、网关端口正确；执行诊断命令。
- **Permission denied / Host key verification failed**：先通过 Remote-SSH 确认目标用户与主机指纹；macOS/Linux 在插件的安全输入框完成认证。硬件触摸或特殊企业 MFA 流程仍可能需要额外配置。
- **remote port forwarding failed**：检查远端 13425 是否占用，以及 sshd 的 `AllowTcpForwarding` / `PermitListen`。
- **远端检测失败**：确认 Host 与当前 VS Code 工作区相同、远端存在 curl，且 shell 不会在非交互命令前后输出额外内容。
- **远端 CLI 未安装或未找到**：从提示打开预配置终端和官方安装说明，在远端安装对应 CLI 后重试。Linux ARM64 的 Codex 可直接使用官方原生二进制，无需 npm。若检查失败，查看日志，排查 shell 初始化是否报错、等待输入或输出过多。
- **扩展仍要求登录**：确认使用了插件的专用启动命令；第三方扩展需要自己支持自定义网关。
- **无模型或模型不支持**：检查本机 Magpie 的模型目录与路由。目录检查不发起模型生成；实际模型可用性需运行一次 agent 会话验证。

## 开发、打包和验收

无 npm 运行时依赖。开发和打包使用 Node.js 22+、npm 与官方 `@vscode/vsce`：

```bash
npm ci
npm run check
npm test
npm run package
```

贡献说明和模块职责见 [CONTRIBUTING.md](CONTRIBUTING.md)。`npm run check` 检查全部源文件语法、翻译完整性和版本一致性；`npm run test:coverage` 输出实际代码覆盖率。GitHub Actions 已配置 Node.js 22/24 与 macOS/Linux/Windows 检查矩阵，工作流实际运行结果以仓库 CI 为准。

F5 使用 `.vscode/launch.json` 启动本机 Extension Development Host，再通过 Remote-SSH 打开测试项目。测试覆盖代理鉴权、路由限制、SSE 流式、SSH readiness / 错误分支、凭据传递及 CLI 参数转义。网络测试只访问本机模拟服务，不消费模型额度。

真实远端验收：安装 VSIX → Remote-SSH 打开项目 → 连接桥接并观察远端 HTTP 200 → 选择模型 → 启动 agent → 要求 agent 读取远端项目内一个已知文件并运行 `pwd` → 断开桥接确认终端关闭、旧令牌失效。需要在你自己的服务器完成此项，自动化模拟测试不能代替真实远端验收。

公开的验证范围见 [验证记录](docs/VALIDATION.md)。原始机器报告、服务器地址和账号信息保留在本地，不随仓库或安装包发布。

数据流与凭据处理见 [隐私说明](PRIVACY.md)。

参考：[VS Code Remote 扩展架构](https://code.visualstudio.com/api/advanced-topics/remote-extensions)、[OpenSSH](https://man.openbsd.org/ssh)、[Magpie 网关](https://usemagpie.ai/docs/start)、[Magpie 参考](https://github.com/yetone/magpie/blob/main/docs/reference.md)、[Codex 配置](https://learn.chatgpt.com/docs/config-file/config-reference)。
