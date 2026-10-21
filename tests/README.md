# CloudSSH 测试套件

本目录包含 CloudSSH 的单元测试、协议集成测试、构建回归和浏览器 E2E。测试框架以 Vitest 和 Playwright 为主。

## 目录结构

```text
tests/
├── build/                         # 生产构建、可复现性和原生弹窗回归
├── e2e/                           # Chromium 浏览器交互与 axe 无障碍检查
├── interop/                       # 真实 SSH 互操作（OpenSSH + 独立 Go 网关，含 Go 工作区与依赖锁）
├── ssh/                           # SSH 算法、认证、加密、KEX、Packet 与测试密钥夹具
├── worker/                        # Worker 路由、安全、DNS、UserDB、标签与 Cloudflare 隧道测试
├── agent-code-actions.test.ts # Agent 代码块语言归一化与单行 Shell 命令识别
├── agent-response-policy.test.ts # 三语安全诊断白名单与模型 Token 预算边界
├── agent-terminal-selection.test.ts # 终端选区附件和非授权安全边界
├── api-errors.test.ts          # API 错误信息边界与状态码
├── auth-challenge-dialog.test.ts # RFC 4256 认证挑战对话框交互
├── clipboard.test.ts              # Clipboard API 与旧版复制回退
├── editor-content.test.ts         # 在线编辑内容解码、BOM/换行符与嗅探
├── frontend-ux.test.ts            # 前端纯函数逻辑回归（OS 图标/列表排序过滤/字号/端口/网络质量）
├── host-display.test.ts           # IPv4/IPv6 掩码与完整地址复制
├── i18n.test.ts                   # 多语言词条和语言解析（zh-CN / zh-TW / en-US）
├── known-hosts.test.ts            # 已知主机指纹 TOFU 信任与变更流程
├── mobile-input.test.ts           # iOS IME diff 与一次性修饰键帮助函数
├── server-memory-schema.test.ts   # 统一服务器记忆（工作历程/知识实体）校验与持久化格式
├── sftp-dialogs.test.ts           # SFTP 新建/重命名/删除弹窗与名称校验
├── sftp-helpers.test.ts           # SFTP 面包屑解析、多维排序与格式化
├── sftp-panel.test.ts             # SFTP 面包屑与路径状态回归
├── sftp-selection.test.ts         # SFTP 单选、多选、连选和全选模型
├── sftp-transfer.test.ts          # SFTP 传输控制器与异步原语
├── share-session.test.ts          # 分享会话确认/领取幂等与页面状态
├── snippet-local-store.test.ts    # 匿名命令片段 localStorage 存储与限额
├── snippet-manager.test.ts        # 命令片段搜索过滤与一键复制交互
├── snippet-schema.test.ts         # 片段名称/命令/数量校验与规范化
├── snippet-variables.test.ts      # 命令片段 {{var}} 参数占位符提取与替换
├── terminal-shortcuts.test.ts     # 终端快捷键（Cmd+F 搜索、Cmd+K 清屏）
├── terminal-size.test.ts          # 终端尺寸归一化与范围越界校验
├── terminal-status.test.ts        # SSH 状态事件翻译
├── terminal-text.test.ts          # 终端文本处理
├── theme.test.ts                  # 内置/自定义主题
└── README.md
```

`tests/ssh/fixtures/` 中的私钥只用于公开的协议测试，不得用于生产服务器或真实账号。
Go 工作区（`go.work` / `go.work.sum`）与网关模块统一位于 `tests/interop/`，用途与运行方式见 [互操作测试说明](./interop/README.md)。

## 运行命令

```bash
# 运行全部 Vitest 单元与集成测试
pnpm test

# 运行指定测试文件
pnpm test tests/ssh/auth.test.ts

# 生成覆盖率报告（输出到 coverage/）
pnpm run test:coverage

# 监听模式
pnpm test --watch

# 安装并运行 Chromium / WebKit E2E 与 axe 无障碍检查
pnpm exec playwright install chromium webkit
pnpm run test:e2e

# 显式运行真实 SSH 互操作（需 macOS/Linux、OpenSSH 和 Go ≥1.24）
pnpm run test:interop

# 类型检查、测试、可复现构建和 E2E 完整门禁（不启用进程级互操作测试）
pnpm run verify
```

> **测试类型检查**：`pnpm run typecheck` 的 worker 阶段会依次执行
> `tsc --noEmit`（src）、`tsc -p tests/tsconfig.worker.json`（tests/worker|ssh|build|interop，
> workers-types 环境）与 `tsc -p tests/tsconfig.frontend.json`（tests 根目录 *.test.ts + e2e，
> DOM 环境）。两个测试配置分开的原因：`@cloudflare/workers-types` 声明的基础 DOM 接口
> （如 Element.append）与 DOM lib 合并冲突，不能在同一项目里同时加载。

## E2E 网络隔离约定

- 所有 `tests/e2e/*.spec.ts` 必须从 `./fixtures` 导入 `test` / `expect`，不得直接使用原始 Playwright `test`。`tests/e2e-fixtures.test.ts` 会扫描新旧 spec，防止漏接自动守卫。
- 自动 fixture 在每个浏览器 context 上安装基础 GET Mock：`/api/config`、`/api/auth/me`（默认匿名）、`/api/user/theme`（空主题库）和 `/api/user/mobile-shortcuts`。不再依赖手动调用 helper；popup/同 context 新页面同样受保护，Service Worker 禁用以免绕过路由。
- 业务接口与所有 PUT/POST/DELETE 必须在触发交互前显式 Mock，并核对请求方法、路径/参数、载荷和结果。页面级 `page.route()` 优先于 context 默认值；不处理的方法应 `route.fallback()`，不能统一返回成功。
- 未声明的 API 会被中止并记录。即使应用 `catch` 后继续运行，fixture 清理阶段仍令测试失败，报告中附 `unmocked-api-requests`，只记录方法和路径，不记录查询值/正文/凭据。手工创建独立 context 时应调用 `installApiMocks()` 并在关闭后检查其守卫。
- Playwright 始终启动全新 `--mode e2e --strictPort` Vite，不复用普通开发服务器；4173 被占用时明确失败，不漂移端口。E2E 不运行 8787 后端；漏到服务器的 `/api` 请求返回带标记的 **501 JSON**，而不是 SPA 的 **200 HTML**，页面 `route.continue()` 的绕过也会被守卫识别。普通开发仍保留 Worker 代理。
- E2E 验证不能只查控制台是否有 `ECONNREFUSED`：须确认测试退出码、守卫检查和完整 stdout/stderr。比较耗时时保持机器、浏览器项目、worker 数和重试设置一致。

## 当前覆盖范围

### SSH 协议

- 算法协商列表与兼容性
- 密码认证
- Ed25519、ECDSA P-256/P-384/P-521、RSA-SHA2 私钥认证
- OpenSSH 私钥解析、DER/SSH 签名转换
- AES-GCM/CTR、HMAC、Packet、KEX 辅助和二进制工具

### Worker 与安全边界

- Turnstile 验证 token 的结构、过期时间和 HMAC
- Origin 检查、端口范围、连接令牌和错误信息边界
- IPv4/IPv6 保留地址、DoH 解析与 DNS rebinding 防护
- Agent 危险命令拦截、确认规则和 SSRF URL 校验
- 主机密钥信任：首见指纹确认、更换指纹阻断与路由作用域隔离
- `ssh/host-key.test.ts`：Ed25519/RSA-SHA2/ECDSA 主机证书（含真实 ssh-keygen 公共夹具）、Ed25519/RSA-SHA2/ECDSA CA 签名、裸主机密钥签名、算法绑定、证书续签稳定指纹、生命周期及有界畸形报文；证书 CA 签名完整性不等于信任该 CA。
- `worker/host-certificate-session.test.ts`：证书 KEX → NEWKEYS → none 认证、完整证书交换哈希、错误签名失败关闭、首见/已知/变更指纹、分享禁止替换、重协商续签/换钥及异步关闭边界；`e2e/none-auth.spec.ts` 验证算法/主机密钥错误不触发自动重连。
- `worker/password-factor.test.ts`：公钥后 password 的 partial_success、空响应、挑战/会话绑定、超时/取消/关闭清理和分享/中间跳板门控。
- `private-key-unlock.test.ts` 与 `e2e/private-key-import.spec.ts`：真实 ssh-keygen/openssl 加密私钥解锁、签名、错误口令及 KDF/DER 预算；匿名不持久化、保存需独立同意、关闭编辑器后的迟到解锁结果不提交。公共加密夹具口令为 `cloudssh-fixture-passphrase`，不能用于真实账户。
- 键盘交互认证、OS 检测、跳板链、SFTP 上传冲突、分享会话策略
- UserDB 服务器标签/片段迁移、规范化、序列化、更新与隔离
- AI 模型代理安全：同 Base URL 强绑定免密拉取、跨地址凭据外带拦截（Credential Exfiltration）、CSRF Origin 防护与敏感 Token 脱敏
- Responses 原生无状态 Agent：HTTP/SSE 跨 chunk 与 CRLF、强制无状态（store: false）、原生输出项与 reasoning 节点回传、call_id 配对、执行事实日志（ExecutionJournal）、严格本地参数校验、停止/抢占/重置/编辑分支、原子预算检查点、任务相关性服务器记忆与 usage。
- `worker/agent/responses-compat.test.ts`：标准 encrypted_content/phase 多轮续接、缺失 ID 不伪造、完成态 JSON 容错、明确 unsupported 才降级、重试次数/幂等键/Retry-After、错误体有界/脱敏与主任务/辅助请求预算；JSON Schema 回退仍须本地知识校验，原生压缩不走 JSON 摘要生成。
- `worker/agent/checkpoint.test.ts` / `worker/agent-checkpoint-recovery.test.ts`：独立 `/responses/compact` 的专用参数、完整规范窗口回传、86 步事实保留、HTTP 失败不降级、取消/超时与预算原子性，不重放历史工具调用。
- `worker/agent/memory-validation.test.ts` / `worker/agent/memory-provider.test.ts`：知识提炼与确定性工作记录解耦、共享 25s 与两次生成上限、显式 revision 冲突重算、去重/用户保护、10s 存储超时与 HTTP 错误传播。
- `worker/server-memory-store.test.ts`：使用 Node 内置 `node:sqlite` 做真实 SQLite 迁移与事务测试，覆盖证据/30 天过期、敏感值加密封装、幂等任务日志、epoch 与加密后 revision 复查及清理；不新增生产依赖。
- `worker/ai-capability-route.test.ts` / `worker/agent/capability-probe.test.ts`：显式付费验证路由鉴权、同源 Origin CSRF 校验、地址变更密钥外带防护、费用知情勾选约束、单用户 60 秒冷却限流，以及合成两阶段原生压缩与续接契约模拟。
- `worker/agent/capability-live.test.ts`（显式运行）：开发者针对真实服务商的独立联调入口，使用纯合成 Token 验证真实 `/responses/compact` 与上下文续接。必须通过 `CLOUDSSH_LIVE_AI_TEST=1` 搭配 `CLOUDSSH_LIVE_AI_KEY` 显式开启；默认单元与门禁测试自动跳过，绝不产生非预期的外部费用。
- `worker/agent/ai-config-budgets.test.ts`：旧库两列幂等升级、预算保存/省略保留/null 重置/模型变更、密钥保留与地址绑定；`e2e/agent-responses.spec.ts` 验证简短错误展示、原生压缩/不支持提示、记忆冲突/忙碌/日志失败不打断正文及预算设置交互，详细诊断仅走 DEBUG_MODE 终端。协议用例使用贴近真实形状的模拟数据，不代替付费服务商实测。
- 流中断/incomplete 不执行残缺工具、不泄露 reasoning；新任务先等旧 exec 清理，不自动重放已执行命令

### 前端与构建

- 服务器搜索、标签筛选、配置一键克隆（Duplicate Server）和响应式分页（桌面 6 / 平板 6 / 移动 3）
- 终端多标签：双击内联重命名（空值还原）、右键上下文菜单（重命名/克隆会话/关闭其他/关闭）与 document click 防泄漏
- 终端快捷键适配：macOS `Cmd+F` 搜索、`Cmd+K` / `Ctrl+Shift+K` 清屏且不干扰 Shell 原生 `Ctrl+K`
- 命令片段库：实时模糊搜索、一键复制到剪贴板与 `{{var}}` 动态参数占位符弹窗录入
- SFTP 生产力：路径面包屑分级导航、表头多维排序（文件名/大小/时间）、新建 0 字节文件与 CodeMirror 在线编辑联动
- SFTP 单选、Cmd/Ctrl 多选、Shift 连选和全选
- Agent 终端选区附件、问题组合、快捷诊断 Prompt 气泡（Chips）和非授权安全边界
- 终端选区自动复制、指针取消和旧版复制回退
- i18n、Theme V4 主题（Liquid Glass 液态玻璃外观预设、背景/效果/版式、对比度与 schema）、终端状态/文本、已知主机与片段本地存储
- 终端与用户空间液态分段切换器（Liquid Segmented Controls）：双边异步物理弹簧引擎、液态透镜滑块拉伸与泊位、桌面专属分段条与移动端菜单平行入口互斥联动
- AI 配置与模型选择：自定义 Combobox 下拉组件（全量展开、即时过滤、一键清空、多主题自适应）、免密拉取联动与敏感凭证即时清理
- 构建可复现性、xterm 生产构建兼容和原生弹窗禁用

### 真实 SSH 互操作（显式运行）

`pnpm run test:interop` 在 macOS/Linux 上启动 loopback-only OpenSSH 和独立 Go SSH 网关，
需要本机 `sshd`/`ssh-keygen` 和 Go ≥1.24；不会修改系统 SSH 配置、用户密码或授权文件。
OpenSSH 覆盖七种裸钥/证书协商、PTY/Shell、exec 与 SFTP；Go 网关覆盖 none/password/OTP/
公钥后 password 及错误响应。默认 `pnpm test` 跳过这些进程级用例，独立运行失败必须按失败处理。
`ssh-interop.yml` 提供 Ubuntu/macOS CI，尚不代表已在远端运行通过。
详细边界见 [SSH 兼容说明](../docs/ssh-compatibility.md)。

### 浏览器 E2E

- API 隔离守卫（`api-isolation.spec.ts`，Chromium + WebKit）：自动基础 JSON Mock、同 context 多页面、用例覆盖、未知 API/未声明写操作失败、查询值脱敏、`route.continue()` 绕过时的 501 JSON 与守卫失败。
- 主题云端同步（`theme-sync.spec.ts` / `theme-styles.spec.ts`）：GET 多主题库与 activeId 恢复、PUT 载荷和云端状态、带 id 的 DELETE 与本地回退；GET 503/网络错误保留本地选择、PUT/DELETE 失败返回 false，不将本地成功等同于云端成功。
- 匿名连接表单 axe 检查
- 服务器弹窗的基本对话框语义、初始焦点和 Escape 关闭
- 服务器标签筛选、分页与配置快速克隆
- 多标签操作：双击内联重命名、空值与失焦恢复、右键菜单项与外部点击关闭
- Agent 终端选区附件与快捷诊断 Prompt 气泡点击填入
- Responses 前端任务生命周期：正文结束继续运行、run_end 才结束、requestId 隔离过期帧、中文/繁中/英文错误与留存提示
- 终端选区复制与焦点恢复
- 认证挑战对话框、iOS 输入法、移动端后台连接恢复与分享会话领取
- SFTP 覆盖确认、路径面包屑、表头排序、新建文件、主题样式与 UI 回归
- 终端抽屉分段切换器：桌面端胶囊轮廓与可辨识边缘、双边异步物理弹簧滑块位移、PC 隐藏移动端更多操作按钮、三大抽屉宽度统一、匿名模式隐藏 AI Agent（display: none）与登录同步解锁
- 移动端终端交互与用户空间：紧凑顶栏与菜单入口、视口与软键盘动态适配、单指滑动历史、字号响应式断点、移动端抽屉平行入口与 AI 设置弹窗无横向溢出
- tmux 触摸滚轮（`terminal-touch-scroll.spec.ts`，Chromium + WebKit）：VT200/drag/any 与 SGR/旧式二进制/像素编码、双向滚动、原始面板坐标、Ctrl 状态保留、Shell/连接门控、选区优先、取消/模式切换/断连清理与报文数量上限
- 终端焦点报告（`terminal-focus-report.spec.ts`，Chromium + WebKit）：真实 Ctrl/Alt 按钮与焦点切换、DECSET 1004、Ctrl+B/方向键、bracketed paste、Shell/连接门控及 iOS IME 回退/去重
- UI 与样式回归：Liquid Glass 下 AI 模型下拉面板与设置面板滚动能力（overflow 简写防回归）、窄视口弹窗横向溢出消除、主题化滚动条兜底与 .no-scrollbar 样式
- AI 模型下拉选择（Combobox 展开、选项切换、清空、免密拉取与浅色/暗色主题自适应切换）

## 当前限制

- Playwright 的完整界面与无障碍回归主要运行 Chromium；API 隔离守卫、认证挑战、iOS 输入法、移动端后台连接恢复、SFTP 面板操作、终端触摸滚轮和焦点报告另在 WebKit 设备项目中执行。Firefox 尚未纳入当前质量门禁。
- 浏览器 E2E 仍以 mock API 验证前端行为；真实 OpenSSH/SFTP 和 Go 网关由显式 `test:interop` 单独覆盖。尚未实测 Dropbear、Windows OpenSSH 和 Cloudflare 真机链路。
- SSHSessionDO、SSH 会话状态机、SFTP 数据流和 AgentCore 等运行态模块的覆盖率仍偏低。
- 新增协议状态、WebSocket 消息或安全边界时，应优先补充运行时错误、取消、超时和畸形输入测试，而不仅验证成功路径。
