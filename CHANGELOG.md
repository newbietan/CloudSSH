# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.9] - 2026-07-17

### Fixed
- 修复 SSRF 防护 DNS rebinding 绕过漏洞（VULN-01/02）：新增 `dns-check.ts` 模块，通过 Cloudflare DoH 解析域名后校验真实 IP，防止域名解析到内网地址绕过 `isBlockedHost`/`validateBaseUrl` 字符串校验；SSH 连接和 AI API 调用入口均增加 DNS 解析二次校验。
- 修复 Agent `service_manage`/`docker_manage` action 参数未校验 enum（VULN-05）：添加 action 白名单校验，非标准操作需用户确认。
- 修复 `isBlockedCommand` shell 替换绕过（VULN-06）：增加 shell 替换检测，拦截 `rm -rf` 中的 `$()`/`${}`/`` ` `` 模式。
- 修复 UserDB DO 返回原始错误消息（LOW-04）：异常不再返回原始错误消息，改为通用错误响应，原始错误仅写入 Workers 日志。
- 修复无端口范围校验（LOW-05）：创建/更新服务器时校验端口 1-65535，非法值返回 400。
- 修复 RSA/ECDSA 公钥认证协议不合规问题。

### Changed
- 移除未使用的 `?config=` URL 参数预填功能（LOW-01）：该功能未被使用且存在凭据泄露风险。
- 优化 DNS 缓存机制：添加最大条目限制（1000）防止内存泄漏，新增 `evictCacheIfNeeded` 函数清理过期和超额缓存。
- 修正 IPv6 link-local/unique-local 正则表达式精确度：使用更精确的正则匹配 fe80::/10 和 fc00::/7 范围。
- 添加 DoH 响应 Status 字段校验：只处理 `Status === 0`（NOERROR）的 DNS 响应。

### Added
- `tests/worker/dns-check.test.ts` 新增 25 个 DNS rebinding 防护测试。

## [1.0.8] - 2026-07-15

### Changed
- 废弃 AI Agent 严格白名单策略，改用黑名单策略以提升使用体验：原策略仅 22 个只读命令免确认、其余一律确认，使用极为繁琐；现改为黑名单兜底 + AI 大脑自主判断，AI 可主动调用 `ask_user_confirmation` 工具评估风险，大幅减少无谓打断。安全分层保持不变：`isBlockedCommand` 直接拒绝灾难性命令（fork bomb、`rm -rf /`、`mkfs`、`dd of=/dev/sd*`），`needsConfirmation` 在 AI 漏判时兜底强制确认。
- 优化内存限流机制：Worker 实例级 `Map<ip,{count,resetAt}>` 增加惰性清理（每 256 次检查触发）和 10000 条上限 FIFO 淘汰，避免 isolate 内无限增长；定位为「削峰」而非鉴权，真正的连接鉴权仍由 Turnstile 与一次性 token 负责。
- 统一 SSH 序列号回绕处理：提取纯函数 `nextSequenceNumber(value)` 使用 `(value + 1) >>> 0` 无符号 32 位回绕，修复旧 `this.seqNum++` 在 `2^32-1` 时溢出为 `Number(2^32)` 破坏 SSH 解密的潜在缺陷，符合 RFC 4253 §6.4 / RFC 4344。
- 收紧匿名身份信任边界：区分 Worker 内部可信 `x-ssh-config` HTTP 头（保留 userId）与匿名 URL query param（强制剥离 userId），并在 `/api/ssh` 入口 `headers.delete('x-ssh-config')` 防止匿名连接通过 HTTP 头注入伪造配置，杜绝提权路径。
- 根据精简修复清单进行全面重构：统一 SFTP 句柄生命周期与 2000 条目截断保护，简化 `user-db.ts` 查询路径，精简 `sftp-handler` 下载队列，前端 `tab-manager` 多会话协调增强，整体 -588 行冗余代码。
- Agent 工具执行器确认流程由 `askConfirmation` 改为 `askConfirmationWithAbort` 与 `Promise.race` 竞争 abort 信号，避免 Agent 被停止时确认流程永久挂起。

### Fixed
- 修复 `rm -fr /` 漏拦（只触发确认而非直接拒绝）：旧正则 `-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*` 要求 `r` 必须在 `f` 之前，flag 反序的 `rm -fr /` 匹配失败。改为解析 rm 短选项字段集合判断「含 r 且含 f」，顺序无关，覆盖 `rm -fr /`、`rm -r -f /`、`rm -rfv /` 等全部变体直接拦截。
- 补齐 AI Agent 黑名单高危模式兜底：新增 6 条高破坏低误报模式（`iptables -X` 清空链表、`kill -9 -1/0/1` 杀全部进程、`curl|sh` / `wget|bash` 远程脚本执行、`find -delete` 与 `find -exec rm` 递归删除），弥补白名单转黑名单后的兜底覆盖缺口；`apt-get install`、`pkill`、`sudo 写操作` 等运维常用路径仍交由 AI 大脑自主判断。
- 修复 AI base_url 末尾带 `/chat/completions` 时自动获取模型列表失败：智能容错自动剥离该后缀，并兼容 `Array` / `data` / `models` 三种模型列表响应形态，适配 OpenAI/Anthropic/各兼容服务商。
- 修复 Cloudflare Workers `fetch` 不支持 `redirect: 'error'` 导致跑通失败：改为 `redirect: 'manual'` 并显式拦截 3xx 响应以保持 SSRF 防护语义，兼容 Workers 运行时。
- 修复已登录用户无法使用 AI 助手：头注入路径与匿名连接的 userId 剥离逻辑混淆，现严格区分两条路径——`x-ssh-config` 可信头保留 `userId`，URL `config` 参数强制 `delete userId`。
- 修复 AI Agent 读取配置时内部路由查询失败误报「未配置」：`fetchAgentAIConfig` 改为按 `githubId` 路由到对应 `UserDBDO` 实例，新增 `SSHConnectionConfig.githubId` 字段贯穿 DO 构造链路，避免会话级配置与存储实例错位。
- 前端透传模型列表获取失败的具体原因：当 AI 提供商 URL 被网络拦截或触发重定向时，前端显示明确错误而非笼统失败，便于用户排查网络环境。

### Added
- `tests/worker/agent/safety.test.ts` 新增 3 个用例覆盖 `rm -fr` 漏拦修复与黑名单补漏，附相近安全形态（普通 `curl`/`wget`/`find`、`kill -9 <PID>`、`pkill`）的误伤防护回归测试。
- `tests/worker/security.test.ts` 新增 178 行回归测试覆盖限流机制、匿名身份剥离、可信头注入防御的安全边界。

### Note
- 本次安全策略调整方向：**AI 大脑仍是主决策者**，底层 `isBlockedCommand` / `needsConfirmation` 仅在 AI 漏判时兜底。system prompt 中风险判断引导与 `ask_user_confirmation` 工具未变动，AI 主动判断空间完整保留。

## [1.0.7] - 2026-07-13

### Fixed
- 修复 `bigIntMod` 大数取模卡死：RSA 私钥认证时逐字节减法循环复杂度为 O(a/m)，大密钥下无限循环。改用原生 `BigInt` 取模，O(1) 完成。
- 修复 ECDH 共享密钥未做全零校验：不符合 RFC 5656 §4 要求，现拒绝全零共享密钥。
- 修复 KEX_INIT 解析缺少边界检查：畸形包可导致 buffer 越界读取，现对 `length` 字段和 `offset` 做前置校验。
- 修复 SSH 包 padding 长度未校验：缺少 `paddingLength < 4`（RFC 4253 §6 最小填充）和 `>= packetLength` 越界检查，两条解析路径均已补齐。
- 修复 NEWKEYS 后序列号未重置：不符合 RFC 4253 §7.3 规范，现发送 NEWKEYS 后立即将 `seqNumSend` 和 `packetParser.seqNum` 归零。
- 修复 Agent 确认等待无法被中止：`askConfirmation` 在 Agent 被停止时永久挂起，新增 `askConfirmationWithAbort` 通过 `Promise.race` 响应 abort 信号。
- 修复终端 resize 事件监听器内存泄漏：匿名箭头函数无法 `removeEventListener`，现存储引用并在 `dispose()` 中正确移除。
- 修复会话就绪状态依赖硬编码中文匹配：`sendStatus` 新增结构化 `event` 字段（`auth_success`/`shell_ready`），前端优先匹配事件名，向后兼容旧消息文本。
- 修复 `user_id` 参数缺少 `isNaN` 校验：5 处内部 API 的 `parseInt` 结果未校验，可被注入非数字字符串。
- 修复 500 错误响应泄露内部错误信息：`handleServersRoute` 的 catch 块直接返回原始 `e.message`，现统一返回 `"Internal Server Error"`。
- 修复 `ip-geo.ts` 区域推断返回无效 `apac-ne`：非合法 Cloudflare DO locationHint，现统一为 `apac`。
- 修复 SSH 连接配置通过 URL query param 传递的安全隐患：私钥等敏感信息会出现在 URL 日志和浏览器历史中，改用 `x-ssh-config` HTTP header 传递，同时避免 URL 长度超限。
- 修复 LLM 输出未脱敏：Agent 工具执行结果在送入 LLM 前未过滤敏感信息，现正则脱敏 PEM 私钥、JWT、GitHub Token、AWS Key ID 四类密钥。

### Added
- 新增 WebSocket 错误日志：`webSocketError` 回调补充 `console.error` 便于排查连接异常。
- 新增 `derivedKeyCache` 加密密钥缓存：PBKDF2 10 万次迭代开销大，缓存 `CryptoKey` 避免重复推导。

## [1.0.6] - 2026-07-12

### Added
- 新增 DO locationHint 智能区域调度：保存服务器时自动通过 ipinfo.io 查询目标 IP 地理位置，推断最优 Cloudflare DO 部署区域并持久化到数据库，连接时直接读取，零运行时外部 API 调用。
- 新增 `src/worker/ip-geo.ts`：IP 地理位置推断模块，支持 11 个 Cloudflare DO 区域（wnam/enam/sam/weur/eeur/apac/oc/afr/me 等），US/CA 按经度细分东西海岸。
- 新增 `frontend/src/regions.ts`：共享区域选项组件，供服务器管理弹窗和匿名连接表单共用。
- 服务器管理弹窗新增区域下拉选择器（默认"自动"），编辑时显示系统推断值。
- 匿名连接表单新增区域高级选项（仅手动覆盖，不自动推断）。
- DEBUG_MODE 模式下保存服务器时显示推断过程调试弹窗。

### Changed
- `servers` 表新增 `region`（用户手动覆盖）和 `inferred_hint`（系统推断持久化）两列，使用幂等 `PRAGMA table_info` 守卫安全迁移。
- `handleAddServer` 保存时触发一次性 IP 地理推断并写入 `inferred_hint` 列。
- `handleUpdateServer` host 变更时自动重新推断。
- `handleConnectServer` 连接时直接读 DB 注入 `locationHint`，零运行时外部调用。
- `handleSSHConnection` 匿名路径仅读取 URL `?region=` 参数作为手动覆盖。
- `handleTokenSSHConnection` 从 config.locationHint 读取，经白名单校验后传入 DO `get()`。
- 终端输入不再触发无意义的 `JSON parse failed` 噪音日志（仅对 `{` 开头的消息尝试解析）。
- IP 地理推断 API 从 ipapi.co 切换到 ipinfo.io（免费 50k 次/月，避免 Workers 共享 IP 下的 429 限流）。

### Note
- **locationHint 是 Cloudflare 的 best-effort 特性**：Cloudflare 会尽力在指定区域实例化 DO，但不保证一定成功。当目标区域 DO 容量不足时，会 fallback 到最近的可用区域。免费计划下亚太区域 DO 容量有限，可能无法总是分配到最近节点。

## [1.0.5] - 2026-07-12

### Fixed
- 修复 SSRF 防护 IPv6 绕过漏洞：`validateBaseUrl` 未剥离 `[::1]` 方括号，导致用户可将 AI base_url 指向本机 IPv6 回环地址，绕过内网拦截。
- 修复 Agent 安全确认 `apk` 子命令漏覆盖：`needsConfirmation` 正则缺失 Alpine 系 `apk add/del`，可静默安装/卸载系统包而无需用户确认。
- 修复 `crypto.ts` 异常路径二次崩溃：catch 块中读取 `ciphertext.length` 在 null 输入时自身 throw，导致 graceful degradation 失效。

### Added
- 完成 SSH 协议层阶段 1+2 测试覆盖，共 9 个测试文件、347 个用例，覆盖 `safety`、`ssrf`、`algorithms`、`kex`、`crypto`（100%）、`packet`（96%）、`utils`（100%）核心模块。
- 新增 worker 接缝安全测试套件（`tests/worker/security.test.ts`，12 用例），通过路由入口验证 CSRF、IDOR 越权、SSRF 接缝、签名伪造、CSWSH 五类安全边界。

### Changed
- 将 `coverage/` 目录加入 `.gitignore`。

## [1.0.4] - 2026-07-11

### Added
- 新增 RSA 私钥认证支持：支持 `rsa-sha2-256` 签名算法，兼容 RSA 2048/4096 位密钥。
- 新增 ECDSA 私钥认证支持：支持 `ecdsa-sha2-nistp256`、`ecdsa-sha2-nistp384`、`ecdsa-sha2-nistp521` 曲线。
- 前端新增密钥文件上传功能：支持 `.pem`、`.key`、`.txt`、`.pub` 格式的私钥文件直接上传。
- 新增完整的单元测试套件：基于 Vitest 框架，包含 36 个测试用例，覆盖 SSH 认证、工具函数、类型定义等核心模块。

### Changed
- 移除测试命令中的 `--passWithNoTests` 选项，确保测试文件存在时必须通过。

### Fixed
- 修复 RSA 私钥 PKCS#8 结构中 CRT 参数（exponent1、exponent2）使用占位符的问题，现正确计算 `d mod (p-1)` 和 `d mod (q-1)`。
- 修复 ECDSA 私钥 PKCS#8 结构，使其符合 RFC 5915 和 RFC 5208 标准。

## [1.0.3] - 2026-07-10

### Improved
- 优化 AI Agent 超时机制，大幅提升复杂部署任务的执行能力：
  - 看门狗超时从 60 秒增加到 300 秒（5 分钟），命令执行超时从 60 秒增加到 180 秒（3 分钟）。
  - 基础迭代次数从 30 次增加到 50 次，扩展机会从 3 次增加到 5 次，最大总迭代次数从 90 次增加到 175 次。
  - 循环检测窗口从 5 增加到 7，重复率阈值从 60% 放宽到 70%，命令多样性阈值从 30% 放宽到 20%。
  - 消息裁剪阈值从 40 条增加到 60 条，保留更多对话上下文。
  - 长时间命令（>60 秒）自动每 60 秒重置看门狗计时器，防止执行期间意外超时。
  - 前端新增进度扩展提示，自动延期时显示当前进度和延期原因。

## [1.0.2] - 2026-07-10

### Fixed
- 修复多分辨率下前端页面内容被裁切与溢出的系统性问题，全面优化了响应式布局：
  - 修复了小视口（如小屏或横屏）下登录表单被裁切且无法滚动的问题。
  - 修复了在窄屏下，终端页面中 AI Agent 面板和 SFTP 面板使用固定宽度导致的溢出或极度挤压终端区域的 Bug。
  - 优化了 SFTP 右键菜单的边界检测逻辑，防止在屏幕边缘展开时被视口遮挡。
  - 为终端工具栏、底部状态栏、用户空间顶部导航等区域增补了 flex-wrap 及截断策略，彻底解决了各元素重叠或溢出的情况。

## [1.0.1] - 2026-07-09

### Fixed
- 修复 Agent 在执行复杂多步任务时容易达到 `maxIterations` 上限而被强制终止的问题，引入动态进度追踪（Progress Tracker）与智能延期机制。
- 修复长对话触发上下文截断时，因分组逻辑缺陷导致部分 `tool` 结果孤立丢失，进而引起 LLM 重复执行已完成步骤的 Bug。
- 精简 Agent 环境探测命令，并为摘要生成添加防抖，显著降低隐性 LLM 调用与 SSH 开销。

## [1.0.0] - 2026-07-09

这是 CloudSSH 的首个正式版本（v1.0.0），标志着整个基于 Cloudflare Workers + Durable Objects 边缘 Serverless 架构的 Web SSH 及 SFTP 客户端已达到生产环境交付标准。

### Added
#### 1. 核心 SSH 连接与自研协议栈
- **自研纯 TS SSH-2.0 协议栈**：不依赖第三方 Native/WASM 库，利用 Web Crypto API 实现了完整的传输层和加密规范，包体轻量。
- **高兼容性算法支持**：
  - **密钥交换**：curve25519-sha256、ecdh-sha2-nistp256。
  - **数据加密**：aes256-gcm、aes128-gcm、aes256-ctr 等。
  - **完整性校验**：hmac-sha2-256、hmac-sha2-512。
  - **认证机制**：支持密码认证及 Ed25519 纯文本私钥认证。
- **主机指纹防篡改 (TOFU)**：支持 Ed25519/ECDSA/RSA 主机密钥自动提取与 SHA-256 指纹展示；在本地及 API 持久化缓存已知主机指纹以防范二次连接的中间人伪造攻击。
- **双栈兼容**：原生支持 IPv4 和 IPv6（包含方括号格式的自动规整与连接支持）。

#### 2. 图形化 SFTP 文件传输系统
- **并行 SFTP v3 实现**：基于独立 WebSocket 通道与 SSH 文件子系统通道并行交互，终端与文件传输并行不卡顿。
- **完善的交互功能**：支持图形化目录浏览、文件上传/下载、新建文件夹、文件重命名、删除及批量上传下载队列管理（支持上传和下载的任务取消）。
- **拖拽式与原生文件传输**：集成 trzsz.js（支持 trz/tsz 拖拽传输、断点续传、目录传输，完美兼容 tmux 会话）。

#### 3. 具有两层安全机制的 AI Agent 智能运维助手
- **AI Agent 侧边栏**：BYOK（自带 API Key）一键连接兼容 OpenAI/Gemini/DeepSeek 的云端大模型，支持流式逐字加载。
- **8 大运维专用工具链**：支持执行命令、读取屏幕交互缓冲、环境探测、进程监控（内存排序）、systemd 服务管理、Docker 容器管理、交互式确认与 Markdown 结构化报告输出。
- **两层安全防线**：
  - **主观/客观拦截（Blocked Patterns）**：硬编码直接拒绝高危指令（如 rm -rf /、fork 炸弹等）。
  - **确认提醒机制（Confirmation Patterns）**：对高风险操作（包管理器 apt/yum 安装卸载、服务启停、sudo 权限等）强制触发前端交互弹窗确认，用户授权后方可执行。
- **防冬眠与看门狗重置**：
  - 在大模型调用及工具执行成功时自动重置 60 秒的看门狗超时定时器，在安全确认等待期间自动挂起超时计数。
  - 核心执行循环（runLoop）添加 5 秒/次的活跃心跳检测，防止 Durable Object 因闲置而被 CF 平台强行 Hibernate（冬眠）断开连接。
- **折叠式思考过程容器**：多步骤工具链任务执行时，实时预览最近 1-2 条执行的命令和步骤数，完成后自动折叠，支持展开回溯完整命令历史。

#### 4. 极客前端 UI 与可视化主题编辑器
- **模块化前端体验**：基于 Vite + TypeScript + Tailwind CSS 及 @xterm/xterm 硬件加速渲染，支持长屏幕日志一键导出下载 .txt 文本，以及终端文本实时检索（Ctrl+Shift+F）。
- **单页面多标签会话**：支持在单个网页内并发管理多个独立的 SSH 会话与 SFTP 面板，环境彼此隔离，支持单独关闭和快速切换。
- **双段延迟与 Colo 数据中心展示**：状态栏实时且周期性心跳刷新当前 RTT（客户端至 Cloudflare 节点）及实际物理延迟（Cloudflare 至主机），并展示当前所在的 Cloudflare 边缘数据中心代码（如 CF-LAX）。
- **可视化主题编辑器**：提供 Glacier、Gruvbox、Cyberpunk 三款内置主题。用户可在线修改终端调色板并一键同步跨设备云端存储，同时生成并导出/导入自定义主题 JSON 配置。

#### 5. 安全与边缘沙盒隔离
- **SQLite 存储隔离**：借助 Cloudflare Durable Objects 和 SQLite 存储，将每个用户的会话隔离在安全沙盒中。
- **凭据零暴露**：基于 One-Time-Token 一次性连接令牌流转机制，密码与私钥从不进入前端，完全在边缘节点 Workers 内部流转。
- **SSRF 过滤防护**：Workers 层面针对 IPv6 与本地保留地址进行 SSRF 检测防御拦截。
- **本地连接记录加密**：可选择使用由本地加密证书派生的密钥，通过 AES-256-GCM 算法加密存储最近 5 条匿名连接记录至 localStorage，提供一键回填与敏感字段清理。
