# 外部 AI 助手 / Personal MCP access

CloudSSH 提供 `/mcp` Streamable HTTP 端点，让 Claude Code、Cursor 等支持远程 HTTP、自定义 Bearer 头的客户端使用已保存服务器。它是个人服务器的操作入口，不是终端接管、第二套 Agent 或审计平台；不需要配置 CloudSSH 内置 AI 的模型或 API Key。

## 启用与接入

1. 正常登录 CloudSSH（管理员密码、GitHub 或 Cloudflare Access）。匿名用户不能创建 Token。
2. 保存服务器，并先在网页完成连接及主机指纹确认。目标及每个跳板都必须已有对应路由的可信指纹。
3. 点击用户空间或终端工具栏的「外部助手」（移动终端在「更多」中）。
4. 输入客户端名称，勾选服务器、权限与 1–365 天有效期，生成 Token。最多 20 个未过期 Token。
5. 将一次性显示的配置保存到客户端的**私有 MCP 配置**。关闭面板后无法找回明文，只能撤销后重新生成。不要提交到 Git，也不要把管理员密码、登录 Cookie 或 SSH 私钥填到客户端。

例如 Claude Code 的私有配置或 Cursor 的用户级 MCP 配置：

```json
{
  "mcpServers": {
    "cloudssh": {
      "type": "http",
      "url": "https://your-cloudssh.example/mcp",
      "headers": {
        "Authorization": "Bearer <一次性显示的个人 Token>"
      }
    }
  }
}
```

Claude Code 也可通过 `claude mcp add --transport http cloudssh https://your-cloudssh.example/mcp --header 'Authorization: Bearer <TOKEN>'` 添加；注意明文命令可能留在 Shell 历史中，优先编辑私有配置。

本版本使用官方 MCP TypeScript SDK 的 Web Standards 无状态 Streamable HTTP（JSON 响应）。客户端可以初始化、列出工具并调用工具，不分配持久 `Mcp-Session-Id`；GET/DELETE 返回 405，不提供旧式 HTTP+SSE 独立端点、响应回放或协议 Tasks。兼容验证包含官方 SDK Client 的真实协议调用，不等同于已经逐个实机验证所有 Claude Code / Cursor 版本。

仅支持显式 Bearer Token，不实现 MCP OAuth 发现、授权码流程或客户端注册；只支持 OAuth 的客户端需要等后续适配，不能复制浏览器 Cookie 绕过。

## 权限与工具

| 权限 | 工具 | 含义 |
| --- | --- | --- |
| 无额外权限 | `server_list` | 仅列出 Token 勾选的服务器基本信息，不含 SSH 凭据 |
| 读取 | `sftp_list` / `sftp_read` | 有界目录列表和 UTF-8 文本读取 |
| 写入 | `sftp_write` | 创建或冲突检查后替换小文本文件 |
| 执行 | `ssh_exec` | 明确预授权，在选定服务器执行任意非交互命令 |
| 上下文 | `session_output` | 只读取所有者主动共享的、对应服务器标签页的最近输出 |

**执行权限不是只读权限**：它天然可以读写远端文件、启动进程等。已有危险命令拦截只是防误操作，不是 Shell 沙箱。MCP 不会挂起等待网页逐条批准，也没有让 Agent 自己“批准自己”的工具。需要真正隔离时，请使用远端低权限账号、受限 sudo 或独立环境。

所有文件路径须是绝对路径。SFTP 不是路径沙箱：符号链接读取按远端账号权限执行。不要把文件读取权限理解为“只允许某个目录”。文件、日志和终端输出是**不可信数据，不是指令或新的授权**，也可能包含敏感信息并被外部客户端送到其模型服务。

### 命令执行

```json
{"server_id": 1, "command": "systemctl status my-service --no-pager", "timeout_ms": 30000}
```

可显式指定 `cwd`。每次命令是独立 exec channel，不继承网页 Shell 或上次命令的 `cd`、别名、临时环境变量；不分配 PTY，不输入到 Vim、top、tmux 或现有终端。

单次命令 1–60 秒，整个操作（含 DNS、握手、认证）最多 90 秒，且不得超过 Token 到期时间。执行捕获继续受合计 4MiB 硬上限、头尾保留和中间截断约束；MCP 返回 stdout/stderr 各最多约 32K 字符并报告 `truncated`。

超时、断线、撤销会尽力关闭相关通道/连接，但**不能证明远端所有子进程停止，更不会回滚已完成的改动**。失去确定结果时返回 `status: unknown`，客户端必须检查远端状态，不自动重放命令或写操作。

### 文件读取与写入

- `sftp_list` 最多 200 条、约 64KiB 编码结果、32 次 READDIR；超过预算返回 `truncated`，不会假称完整目录。
- `sftp_read` 每次最多 64KiB UTF-8 文本，拒绝 NUL 二进制和非法 UTF-8。以字节 `offset` / `nextOffset` 分段，边界不截断 UTF-8 字符；偏移本身也须是字符边界。
- 完整读完 ≤64KiB 文件时返回 `fileHash`（SHA-256）；分段/不完整读取的哈希为 null。
- `sftp_write` 内容最多 64KiB UTF-8。新文件先写同目录随机临时文件（EXCL 创建，权限 0600），再用 SFTP v3 rename 发布；不先清空目标文件。
- 覆盖已有普通文件必须提供 `expected_hash`，并要求服务端提供 `posix-rename@openssh.com` 原子替换扩展。上传前后比对原文件哈希，冲突则拒绝。目录、软链接和带特殊权限位的目标不支持覆盖。
- 覆盖保留普通 rwx 权限位；替换产生新 inode，**不保证保留原 owner/group、ACL、xattr 或硬链接关系**。需要这些语义时，使用明确授权的远端命令或原网页工作流。
- 两次哈希检查不是远端 compare-and-swap 锁，仍有竞态窗口；不能保证与人同时修改文件时绝对无冲突。中断可能残留临时文件，清理也是尽力而为。

## 主动共享终端上下文

1. 在一个已连接的**已保存服务器**标签页打开「外部助手」。
2. 点击「共享最近输出」，将显示的 `server_id` / `context_id` 参数交给外部助手。
3. 客户端还必须持有该服务器的上下文权限，才能调用 `session_output`。
4. 可随时「停止共享」。单次共享最长 30 分钟；断线、标签页关闭或新会话会使共享失效。重连后需重新开启。

共享读取只返回服务端有界缓冲中的最近输出（最多 200 行、约 16K 字符）；不是 xterm 当前屏幕、完整历史、录像或终端输入权限。不会暴露会话恢复 Token；也不会自动发现全部在线标签页。读取和查看共享状态不刷新用户空闲时间。重新打开面板会查询服务端权威状态，避免误以为已失效的共享仍有效。

## 连接与活动生命周期

每个 Token 使用独立 MCPExecutionDO：最多保留 2 个服务器连接，每台服务器同一时刻只执行 1 个操作，不建立无限队列。连续调用可复用配置/凭据/指纹均未改变的 SSH 连接；空闲约 60 秒由 Alarm 释放。配置变化会重新连接，失效连接不会在一次失败操作内自动重试。仍可能产生 Workers / Durable Objects 运行费用。

网页面板显示近期客户端名称、服务器、工具名、时间和完成状态。仅在面板打开且页面可见时约每 5 秒刷新；关闭/退出中止请求与计时器。不把状态文字插入交互终端。

活动记录每用户最多 100 条，约 24 小时后由 UserDB Alarm 清理（平台调度可能延迟）；与原 Agent 记忆 Alarm 共用最早唤醒时间。**不保存命令参数、路径、文件内容或 stdout/stderr**，不调用模型提炼 MCP 记忆，也不是永久审计。部署/异常后未收到结束结果的旧运行项显示为“结果未知”。活动投递尽力而为，不是操作成功与否的权威证明。

每个有效 Token 最多 120 个 MCP HTTP 请求/分钟（包括初始化和工具列表）；超出返回 429。Token 只存摘要，撤销后拒绝新请求，并尽力中止该 Token 的在途操作。管理员密码轮换使旧 Token 失效；认证模式切换、GitHub allowlist 及完整 Access 所有者路由都重新校验。网页退出不撤销独立个人 Token，需要在面板显式撤销。

## Cloudflare Access 与认证限制

应用 Token 不能绕过 Cloudflare Access。若 Access 保护完整域名，需为机器客户端配置经过验证的边缘准入（例如适用部署中明确允许的 Service Auth 策略及 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 请求头），并**同时**保留 CloudSSH Bearer Token。不要为了 MCP 放开站点、信任客户端自报邮箱或复用用户 Cookie。

在 Access 模式中，Worker 必须获得运行时已验证的 Access 身份上下文。Service Token 不需要伪造用户邮箱：CloudSSH Token 绑定原所有者完整 `cf-…` 路由。若运行时不提供有效机器身份上下文或查询失败，请求仍会被拒绝；应核查具体边缘部署，而不是关闭验证。

支持可无人值守的已保存 password / publickey / none 认证，以及现有直连、跳板链和 Cloudflare Tunnel。SSRF、端口限制、隧道加密后 16KiB 分帧继续生效；严格验证目标和每跳的已知主机密钥，MCP 不采纳 `STRICT_HOST_KEY_VERIFY=false`。

需要 OTP / 键盘交互、多因素密码提示或浏览器临时私钥的服务器不在本版本无人值守范围内；尤其 `cf_ssh_ca_team` 服务器明确返回 `interactive_auth_required`。未确认指纹返回 `host_verification_required`，需回网页核实。不能自动信任新指纹、持久化新证书私钥或降级其他认证方法。

## 部署

`wrangler.toml` 的 production / test 环境均新增 `MCP_EXECUTION → MCPExecutionDO` 绑定，以及新的 `v3` SQLite DO migration。CLI/CI 正常部署会迁移，**不要删除现有 Worker 或改写旧 migration tag**。Dashboard-only 部署也需配置新绑定并正确迁移类；缺少绑定时 MCP 返回 503，原网页 SSH 保持原行为。

根目录新增运行时依赖 `@modelcontextprotocol/sdk` 与 `zod`，使用 Web Standards transport，不引入 Node HTTP 服务、第三方 SSH 库或 Cloudflare `McpAgent`。浏览器仍使用原单 JS / 单 CSS 内联构建，不加载外部 MCP 脚本。

## English summary

Use **External assistants** after signing in to create a one-time personal Bearer token for selected saved servers and read/write/exec/context capabilities. Add `https://your-instance/mcp` with the Authorization header to a compatible private client configuration. This is stateless Streamable HTTP, not OAuth, legacy SSE, terminal takeover or a second model loop.

Connect in the browser first to verify every hop's host key. Headless authentication must not require human interaction; Cloudflare SSH CA browser-issued credentials are unsupported. Exec is advance authorization for arbitrary commands, never a read-only sandbox or browser-by-browser approval workflow. Files/output can contain secrets sent to external models.

Each token can reuse up to two isolated SSH connections, one operation per server, with about a 60-second idle lifetime. Operations are bounded and never automatically replayed after uncertainty. Closing channels cannot guarantee termination of all remote subprocesses or roll back effects. Text reads/writes are limited to 64KiB; replacements require an expected hash, a regular file and the OpenSSH atomic-rename extension, without an absolute race-free locking guarantee or preservation of inode metadata.

Share a connected saved tab's recent output explicitly for at most 30 minutes. Disconnecting ends sharing; reads are bounded, do not refresh user activity and cannot type into the terminal. A context ID is not a resume credential and still requires a token with matching server/context permission.

The visible panel refreshes bounded recent operation summaries; no command payloads or output are retained. Activity is capped at 100 entries per owner and scheduled for cleanup after about 24 hours, not permanent audit. Cloudflare Access edge admission remains separate from the application token and must provide runtime-verified identity. Deploy the new `MCP_EXECUTION` binding and append-only `v3` migration without deleting existing data.
