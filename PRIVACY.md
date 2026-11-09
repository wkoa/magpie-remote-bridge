# Privacy / 隐私说明

Magpie Remote Bridge does not operate a cloud service and does not add analytics, advertising, or telemetry endpoints.

The extension connects an SSH workspace to the Magpie gateway running on your local computer. Model requests, prompts, tool definitions, and tool results sent by a remote client pass through the SSH tunnel and the local proxy into Magpie. Magpie and the model providers you configure determine the subsequent processing and retention of that content. Review their policies separately.

## 本机保留的信息

- SSH Host 与 VS Code 远端工作区标识的映射按工作区分别保存在本机 VS Code 扩展状态中，兼容读取旧版映射。
- 模型选择、端口等偏好保存在本机 VS Code 设置中。
- 可选的 Magpie 网关密钥使用 VS Code SecretStorage 保存。
- 为保持模型选择一致，插件可以读取本机 Claude Code settings 中的固定白名单模型环境字段。

插件不导出 Magpie 的供应商配置或登录文件。SSH 密码通过安全输入框完成本次认证，不写入配置、文件或日志。

## 传输和会话

远端程序使用本次连接的临时令牌访问模型 API。临时令牌通过终端环境或 SSH 标准输入传递；用户执行“复制远端扩展接入信息”时，该令牌会进入本机剪贴板。远端管理员及同账户进程可能读取进程环境，因此应仅连接可信服务器。

本机代理只公开 README 中列出的模型 API，过滤管理路由及转发身份头。SSH 主机名和连接错误可能出现在本机输出面板中；插件不记录模型请求/响应正文或认证令牌；写入日志前会隐藏已知网关密钥、会话令牌和 Bearer 认证值。日志保存在 VS Code 的本机日志系统中。

取消连接会中止本次操作并释放已获取的资源。自动重连期间保留现有终端与令牌，重试耗尽后撤销会话。

断开桥接会关闭会话代理、插件创建的终端、SSH 隧道并清理生成的临时认证辅助文件。已保存的偏好、Host 映射与可选网关密钥可通过 VS Code 的扩展状态/设置和密钥命令管理。

## Codex 侧边栏

执行“连接 Codex 侧边栏（当前远端账户）”会通过官方 Codex 配置 RPC 更新远端 `CODEX_HOME/config.toml` 的 `model`、`model_provider` 和插件专用的 `model_providers.magpie_vscode_bridge`。默认 `CODEX_HOME` 为 `~/.codex`；这会影响同一远端账户的新 Codex 会话。插件不修改官方扩展文件或 `chatgpt.cliExecutable`，不读取 `auth.json`，不会保存原供应商的认证配置。

provider 配置只包含本次桥接地址、模型和凭据命令。该命令通过 SSH 转发的私有 Unix socket 取得临时令牌，令牌通过进程管道返回给 Codex，不写入配置、脚本、命令参数或恢复记录。两端 socket 位于权限为 0700 的私有目录，本机 socket 为 0600。该模式不开放无认证 TCP 服务；同账户进程与远端管理员仍属于可信边界。

远端 `CODEX_HOME/.magpie-remote-bridge.json` 以 0600 保存租约、socket 归属、原模型/provider 选择及插件生成的非敏感配置，用于中断后恢复。同一账户只允许一个窗口持有侧边栏桥接。执行“恢复 Codex 原配置”会通过版本检查，只还原仍与插件写入值相同的字段，保留用户后续修改，并清理恢复记录和 socket 目录。

手动断开及正常停用扩展时，插件关闭本机凭据服务，通过仍可用的 SSH 自动恢复当前租约的原配置，然后关闭 API 代理和隧道；恢复等待有超时上限，失败仍会撤销会话并提示。窗口重载会尽力等待恢复完成。

配置前会在远端启动独立的 Python 恢复守护进程，代码通过进程管道传递，不生成持久脚本或服务。守护进程只检查私有 socket 的无凭据健康接口，不请求令牌；凭据通道持续失联约 60 秒后自动恢复，仅处理原窗口持有的租约。恢复成功、恢复记录已删除或租约已更换时，守护进程退出；连续恢复失败达到重试上限后退出并保留恢复记录，供手动恢复。强制关闭窗口或 SSH 突然中断也可通过此路径恢复，不需要本机仍能连接服务器。

自动重连保留令牌，在转发恢复前暂停发放凭据；宽限时间内通道恢复则保持配置，无法恢复侧边栏通道时会单独提示。仍可显式执行“恢复 Codex 原配置”处理失败的恢复或旧版本遗留配置；窗口重载不会静默接管其他窗口的租约。

## 联系和问题

项目问题请使用 [GitHub Issues](https://github.com/wkoa/magpie-remote-bridge/issues)。请先删除日志中的主机、账号、路径、提示词和凭据，再提交问题。
