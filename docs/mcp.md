# 个人 MCP 配置 / Personal MCP configuration

CloudSSH 为每个登录账户提供**唯一、长期有效**的 MCP 配置。只生成一次，之后可重复复制、修改逐服务器权限；不需要客户端名称或有效天数，不提供多令牌、撤销或轮换入口。无需配置 CloudSSH 内置 AI 的模型。

## 接入

1. 登录后先在网页连接已保存服务器，确认目标及每个跳板的主机指纹。
2. 点击连接节点形状的「外部AI助手MCP设置」图标，按服务器勾选读取、写入、执行、终端上下文权限。不同服务器可以不同；未勾选任何权限的服务器不能被 MCP 操作。
3. **仅 CF Access 登录**：展开 Access 连接，按控制台/官方文档链接为保护**本站**的 Access 应用创建 Service Token，并用 **Service Auth** 策略允许它（不是普通 Allow 或 Bypass）。填写 Client ID / Secret 并确认策略；这些不是 SSH 隧道服务器的凭据。
4. 点击「生成唯一配置」。以后点击「复制 MCP 配置」即可重复获取相同令牌；需要手动检查时使用「查看配置」。
5. 保存到 Claude Code、Cursor 等支持远程 HTTP 与自定义请求头的客户端**私有配置**中，不要提交到 Git。

普通模式：

```json
{
  "mcpServers": {
    "cloudssh": {
      "type": "http",
      "url": "https://your-cloudssh.example/mcp",
      "headers": { "Authorization": "Bearer <唯一个人令牌>" }
    }
  }
}
```

Access 模式自动增加 `CF-Access-Client-Id` / `CF-Access-Client-Secret`，仍保留 CloudSSH Bearer 令牌。两层认证缺一不可；普通认证模式不展示 Access 字段。Access Service Token 自身的到期时间仍由 Cloudflare 控制：到期或变更时，在本模块填写新凭据、保存，再重新复制配置到客户端，**不会改变个人 MCP 令牌**。策略确认是操作提示，不是 CloudSSH 对边缘策略的自动验证。

### Access 准入与用户身份

Cloudflare 运行时的原生 `ctx.access`（含有效 `aud`）代表本次 Worker 调用已通过 Access 认证；它与 `getIdentity()` 是否提供用户资料是两件事。精确 `/mcp` 只要求原生准入与个人 MCP Token 数据库验证，不读取用户邮箱，也不等待用户资料接口。Service Token 不提供用户资料不会因此被误判为个人令牌无效。

网页登录、MCP 配置/凭据导出与 CA 签发仍必须取得有效邮箱，查询失败或没有邮箱继续拒绝，不降级 GitHub。`CF_ACCESS=true` 只选择模式，不能代替边缘准入；仅携带邮箱/JWT/Service Token 请求头、没有可信原生上下文的请求仍被拒绝。不得改为检查请求头是否存在，或用 Bypass 绕过 Access。

参见 [Cloudflare Workers Access 文档](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)。

## 保存与权限修改

- 个人令牌和 Access 凭据按账户使用既有 AES-GCM 机制加密保存在 UserDB SQLite；打开面板只读权限等元数据，明确点击复制/查看时才通过已登录的 POST 接口解密返回。
- 这是可回读加密，不再是旧版“只保存令牌摘要”和“Access 凭据不上传”的模式。根密钥仍在同一数据库的 `system_config.encryption_secret`，**不是独立 Secret/KMS，也不能抵御整库或运行时失陷**。
- 不写入浏览器 localStorage/sessionStorage。关闭窗口、退出、换号或认证模式变化会销毁本地明文及中止请求；用户主动复制后的系统剪贴板由用户管理。
- 「服务器权限」首次配置时展开，之后打开设置只显示已授权台数。展开可按名称或标签搜索；桌面按列对照四项权限，手机点服务器行查看或修改。筛选「已授权 / 未授权」以**上次保存**为准，不会在勾选第一项后突然移走正在编辑的服务器。
- 勾选只更新草稿：搜索、切换筛选、收起列表或旋转屏幕都不会丢失修改。顶部预览保存后的授权台数，底部「保存修改」统计修改过的**服务器数**而不是勾选次数；只有显式保存才会一次提交完整草稿（包括当前看不见的服务器）。关闭整个设置窗口会放弃未保存的修改，令牌不变。未改动时按钮禁用，改动后启用，恢复原值或保存成功后重新禁用；首次生成不受此限制。服务端逐次检查当前授权，命令/SFTP 在握手后、真正执行前再次核对；权限保存后尽力关闭原执行池，在途操作已经发生的副作用不会回滚。
- 可以取消全部服务器权限，使配置暂时没有远端操作能力；唯一令牌本身保留，之后仍可重新授权。
- 在用户空间删除服务器后，其 MCP 授权、近期操作记录及服务器记忆随保存记录在同一事务删除。下一次 `server_list` 不再返回它，无需重新生成令牌；即使删的是最后一台，其他账户配置也不改变。已打开的同账户设置页会接收同源删除通知，保留其他机器的未保存修改；不支持跨标签通知时请重新打开。历史版本留下的孤立 MCP 关联在用户库下次启动时清理。
- 删除会作废该服务器关联的未用连接票据，并尽力关闭相关 MCP 执行连接；这不是远端操作回滚，也不会强制踢下已连接的普通 SSH 终端。删除前仍须解除跳板引用、撤销未结束分享；已结束分享的审计和可供其他连接复用的主机指纹不随服务器记录删除。
- 长期令牌**没有撤销/轮换接口**，请妥善保护。账号/认证模式/路由及 GitHub allowlist 边界仍检查；管理员密码轮换会先拒绝旧绑定，所有者重新登录后明确复制/查看或保存配置可重新绑定，令牌本身不变。换登录方式不合并不同账号的数据。

### 从旧版迁移

旧版只有令牌摘要，无法恢复原始明文。升级后旧版多令牌不再通过新验证器；面板会提示首次生成新的唯一配置并更新客户端，生成后清理该账户旧令牌记录。此后生成请求是幂等的，即使并发点击也只有一份配置；修改权限、凭据或重新打开窗口不会生成第二个令牌。

## 工具与边界

| 权限 | 工具 | 说明 |
| --- | --- | --- |
| 无额外权限 | `server_list` | 只列出当前已授权服务器的基本信息 |
| 读取 | `sftp_list` / `sftp_read` | 有界目录与 UTF-8 文本读取 |
| 写入 | `sftp_write` | 小文本创建或哈希冲突检查后替换 |
| 执行 | `ssh_exec` | 明确预授权的独立非交互命令 |
| 终端上下文 | `session_output` | 只读所有者主动共享的对应服务器标签页 |

工具列表包含全部服务器所需工具的并集，**不是全局授权**：例如 A 只读、B 可执行，仍禁止在 A 调用命令。配置不能导出保存的 SSH 凭据或注入任意主机；仅使用数据库内同属当前账号的保存配置、跳板链与路由指纹。目标和每跳都须先有可信指纹，与其他 SSH 会话一样始终严格验签。

执行权限不是只读沙箱；它可以修改文件或启动进程。已有命令阻断仅防误操作，不是完整 Shell 安全边界，不等待网页逐条批准。建议使用低权限 SSH 账号。文件、日志和终端输出是不可信数据，不是新指令或授权，也可能含敏感信息并被客户端发送给其模型服务。

### 命令

`ssh_exec` 接受 `server_id`、`command`，可选 `cwd` / `timeout_ms`。不分配 PTY、不向网页 Shell 输入、不继承网页或前一次命令的目录/环境变量。命令 1–60 秒，整次操作（含 DNS/连接/认证）最多 90 秒；捕获总量仍有 4MiB 硬上限、头尾保留，MCP 返回 stdout/stderr 各约 32K 字符并报告截断。

断线/超时/权限修改会尽力关闭通道或连接，但不能保证所有远端子进程终止，也不回滚改动。结果未知时返回 `status: unknown`；不要自动重放命令或写操作，应先检查远端状态。

### SFTP

- 路径必须绝对；不是目录沙箱，读取软链接仍按远端账号权限执行。
- 目录最多 200 条、约 64KiB 编码结果、32 次 READDIR；超限明确 `truncated`。
- 每次读取最多 64KiB UTF-8，拒绝 NUL 二进制/非法 UTF-8。使用字节 offset / nextOffset 续读，边界不切开字符。只有完整小文件读完才返回 SHA-256 `fileHash`。
- 写入最多 64KiB UTF-8。先写同目录随机临时文件（EXCL 创建，在 OPEN 请求中原子指定 0600，而非创建后再收紧权限），再 rename 发布，不先清空目标。
- 覆盖已有普通文件必须有 `expected_hash`，并要求 OpenSSH `posix-rename@openssh.com` 扩展；上传前后复核哈希，拒绝软链接/目录/特殊权限位目标。
- 保留普通 rwx 位，但不保证原 inode、owner/group、ACL、xattr 或硬链接关系。哈希检查有竞态窗口，不是远端事务锁；失败可能留下临时文件。

## 终端上下文和近期操作

「共享当前终端上下文」默认折叠。打开后可显式共享最近输出并将 `server_id` / `context_id` 交给助手。仍需该服务器的上下文权限；单次最多 30 分钟，断线/关闭会话后取消。只读约 200 行、16K 字符的有界缓冲，不是屏幕、录像或完整历史，不允许输入，不暴露恢复令牌，不刷新用户空闲。

「MCP操作日志」整体默认折叠，展开后直接显示小字号、等宽单行日志，不再逐条折叠；每行依次为完整起始日期时间、结束时间、服务器、状态和工具名，跨日结束显示完整日期。一次展示最多100条，日志区域可滚动；只有展开且页面可见时约每5秒刷新。最多 100 条/约 24 小时，由 UserDB Alarm 清理；不保存命令参数、路径、文件内容或输出，不是永久审计，也不会送入 Agent 长期记忆。活动投递尽力而为，未收到结束状态的旧运行项显示结果未知。

## 连接、协议与故障排查

每个账户唯一配置对应独立 MCPExecutionDO，最多保留两台服务器的连接，每台一次操作、不建无限队列，约 60 秒空闲释放。配置/凭据/指纹变化重连；一次失败操作不自动重试。每配置最多 120 个 MCP HTTP 请求/分钟，超限 429。

端点必须是精确 `/mcp`，使用官方 SDK 的无状态 Streamable HTTP（JSON 响应），不分配持久 MCP session；GET/DELETE 返回 405，不实现 OAuth/旧 SSE/Tasks/重放。只有 OAuth 的客户端不在此版本范围内。协议测试使用官方 SDK Client，不代表已经实机验证所有客户端版本。

- `Unexpected content type: text/html`：先排查 Access 登录重定向、Service Auth 策略、是否确实发送两个 Access 请求头，以及 URL 是否误用了根路径或 `/mcp/`。也可能是 WAF 挑战；不要直接关闭验证。
- JSON 401：不能仅凭 `unauthorized` 断言个人 Token 无效。Access 原生准入缺失、令牌/模式不匹配和数据库查询失败都可能在认证阶段返回 401。先核对目标部署与 Access 策略，不要盲目更换长期令牌。网页登录 Cookie 不能代替个人 Bearer，原始邮箱/JWT 头不能冒充原生准入。
- 开启 `DEBUG_MODE=true` 后，可在 Worker 日志查看 `mcp.auth.denied`：`access_context_missing` 为无可信原生上下文或 aud 非法；`invalid_bearer` 为令牌格式错误；`auth_mode_unavailable` 为当前认证模式不可用；`account_mode_mismatch` 为账户类型/模式/allowlist 不匹配；`credential_rejected` 为数据库拒绝凭据；`credential_lookup_failed` 为凭据后端路由缺失或服务异常。日志仅含固定原因码，每 isolate 每 60 秒最多 20 条，不输出凭据、身份、异常正文；客户端仍只收到统一 401。429 仍表示现有请求预算限制。
- `host_verification_required`：先回网页验证目标/跳板指纹。
- `interactive_auth_required`：OTP/键盘交互或浏览器临时 Cloudflare SSH CA 不支持无人值守。

保留直连、最多三级跳板和 Cloudflare Tunnel 的 SSRF、端口及加密后 16KiB 载体分帧边界。Access 机器客户端必须通过边缘准入，Worker 验证当前调用的可信原生 `ctx.access` 与有效 `aud`，不能因个人 Token 而豁免；原生准入不要求 `getIdentity()` 返回用户资料。

## 部署与存储

沿用 `MCP_EXECUTION → MCPExecutionDO` 绑定和 `v3` migration，不删除 Worker，不改写旧 migration。账户设置新增 `mcp_configs` SQLite 表，`user_id` 主键确保单配置；应用 schema 幂等创建，不需要新的 DO migration。缺少绑定时 MCP 返回 503，原网页 SSH 行为不变。

管理接口：`GET/POST/PUT /api/mcp/config` 读取元数据、首次幂等生成、修改授权；`POST /api/mcp/config/credentials` 明确导出加密保存的客户端凭据；没有 DELETE。旧 `/api/mcp/tokens` 不再使用。终端上下文与近期活动接口保持不变。

## English summary

Each signed-in account has one permanent MCP configuration, generated once with no client name, expiry, revoke or rotate controls. Assign read/write/exec/context independently to each saved server and save changes without changing the token. Unchecking all grants disables remote operations while retaining the configuration.

Access admission is separate from browser identity. The exact `/mcp` endpoint requires trusted native `ctx.access` with a valid audience plus the personal token's database verification; it skips user-profile lookup. Browser login, settings/credential export and CA signing still require a verified email. A mode flag or raw request headers cannot establish admission. Debug-only rejection logs contain fixed reason codes and are bounded to 20 entries per isolate per 60 seconds; no credentials, identities or upstream bodies are logged, and public 401 responses stay generic.

The personal token and optional site Access Service Token are stored recoverably with the existing account AES-GCM mechanism. The root key remains in the same database, not an independent KMS. Opening settings fetches metadata only; an explicit copy/view POST decrypts credentials. No browser storage is used, and closing or changing identity/auth mode discards local plaintext. Protect the permanent token and your private client configuration. Cloudflare Service Token expiry is separate: update its credentials and copy again when necessary.

Legacy digest-only tokens cannot be recovered and are no longer accepted. Generate the new singleton once and update the client; subsequent generation calls are idempotent. Tool discovery is a union, but authorization is enforced per server and rechecked before dispatch. Permission edits stop old pools best effort, never roll back remote effects.

MCP settings and the built-in Agent share assistant-ui.css components for surfaces, headers, inputs, actions and footers, not only theme colors. Save stays disabled for unchanged saved permissions and becomes disabled again after restoration or a successful save. The theme-adaptive compact window keeps the activity section collapsed initially. Expanding it shows up to 100 compact monospace log lines with a time range, server, status and tool, without per-record disclosures. Reads/polling happen only while expanded and visible. Independent non-PTY exec/SFTP, explicit short-lived terminal output sharing, strict host trust, Access edge admission and bounded operation budgets remain unchanged.
