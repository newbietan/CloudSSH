# AGENTS.md
<!-- 
  维护提醒：当以下文件变更时请同步更新此文档：
  - wrangler.toml (Durable Objects、环境变量、路由)
  - src/worker/index.ts (API 路由、入口逻辑)
  - scripts/build-html.js (构建流程)
  - package.json (依赖、脚本命令)
  - src/types.ts (Env 接口、类型定义)
  - biome.json (代码格式与 lint 约定)
-->

## Project Overview

CloudSSH is a serverless Web SSH terminal built on Cloudflare Workers. Users connect to SSH servers through a browser-based terminal UI with integrated SFTP file management and AI Agent assistant.

## Architecture

- **Frontend** (`frontend/`): TypeScript + Vite + xterm.js + Tailwind CSS（通过 PostCSS 本地构建）
- **Backend** (`src/`): Cloudflare Workers + Durable Objects
- **SSH Protocol**: Pure TypeScript implementation in `src/ssh/` (no external SSH library)
- **SFTP Protocol**: SFTP v3 subsystem implementation in `src/ssh/sftp.ts` for file management
- **Build Process**: `scripts/build-html.js` builds frontend and inlines it into `src/worker/html.ts`

## Key Directories

```
src/
├── worker/           # Cloudflare Worker entry and Durable Objects
│   ├── index.ts      # Main worker entry (request routing, bounded in-memory SSH rate limiting)
│   ├── durable-object.ts  # SSHSessionDO - manages SSH sessions
│   ├── share-do.ts    # SSHShareDO - one-time capability lifecycle and share-only audit log
│   ├── ssh-session.ts     # SSH session logic, multi-channel routing, SFTP handling
│   ├── direct-tcpip-stream.ts # RFC 4254 direct-tcpip 背压字节流，用于嵌套 SSH 跳板链
│   ├── sftp-handler.ts    # SFTP protocol ops, task queue, concurrent download, upload tracking
│   ├── user-db.ts    # UserDBDO - user/server/命令片段存储（含标签、OS、跳板关系与片段持久化）
│   ├── server-tags.ts # 服务器标签规范化与 SQLite JSON 序列化
│   ├── os-detect.ts  # 远端操作系统输出解析、规范 key 与持久化白名单
│   ├── auth.ts       # GitHub OAuth handling
│   ├── dns-check.ts  # DNS-over-HTTPS 解析 + 统一 IP 块检查（DNS rebinding 防重绑定 SSRF 防护）
│   ├── ip-geo.ts     # 保存直连服务器时 IPinfo 区域推断，映射为 DO locationHint
│   ├── agent/        # AI Agent system
│   │   ├── core.ts       # Agent control loop (LLM calls, tool execution)
│   │   ├── tools.ts      # 7 tool definitions (execute_command, detect_environment, list_processes, service_manage, docker_manage, etc.)
│   │   ├── tool-executor.ts  # Tool dispatch, execution, and blocked command rejection
│   │   ├── prompt.ts     # System prompt for the agent
│   │   ├── safety.ts     # Two-layer security: blocked patterns + confirmation patterns
│   │   ├── ssrf.ts       # SSRF protection for AI base_url
│   │   ├── terminal-context.ts  # Terminal output ring buffer
│   │   ├── exec-channel.ts  # SSH exec channel lifecycle
│   │   └── types.ts      # Agent type definitions
│   └── html.ts       # Auto-generated - DO NOT EDIT
├── ssh/              # SSH protocol implementation
│   ├── transport.ts  # SSH transport layer
│   ├── packet.ts     # SSH packet parser and builder
│   ├── kex.ts        # Key exchange init and negotiation
│   ├── kex-curve25519.ts  # Curve25519-SHA256 key exchange
│   ├── kex-ecdh.ts   # ECDH-NISTP256 key exchange
│   ├── algorithms.ts # Supported algorithm definitions
│   ├── auth.ts       # Authentication methods (password, RFC 4256 keyboard-interactive, Ed25519/ECDSA/RSA private keys)
│   ├── channel.ts    # SSH channels (session + direct-tcpip + SFTP subsystem + exec)
│   ├── crypto.ts     # AES-GCM/CTR cipher, HMAC implementations
│   ├── keys.ts       # Key derivation per RFC 4253
│   ├── utils.ts      # Binary utilities
│   ├── sftp.ts       # SFTP v3 client implementation
│   └── sftp-types.ts # SFTP protocol constants and types
├── theme-schema.ts   # Theme V2 shared validation, allowlists, enums, and size limits
├── snippet-schema.ts # Command snippet shared validation, limits, and normalization (UserDBDO + localStorage)
└── types.ts          # Shared TypeScript type definitions

frontend/
├── src/
│   ├── main.ts            # Frontend entry point (路由、theme、i18n、事件处理、Esc 快速返回终端)
│   ├── terminal.ts        # xterm.js terminal setup (search, dynamic RTT latency, log export, 选区->Agent)
│   ├── terminal-layout.ts # 响应式终端字体与视口尺寸（桌面/平板/移动）
│   ├── terminal-status.ts # SSH 状态事件 → i18n 文案翻译与状态栏渲染
│   ├── terminal-text.ts   # 终端等宽文本宽度计算（CJK 全角/Emoji 占 2 列）
│   ├── network-quality.ts # 双段延迟阈值与网络质量分级（good/fair/poor）
│   ├── clipboard.ts       # Clipboard API 写入与旧版 execCommand 回退
│   ├── ui-feedback.ts     # 轻量通知/toast 反馈组件
│   ├── host-display.ts    # IPv4/IPv6 字面量校验与隐私掩码文本
│   ├── os-icons.ts        # 操作系统品牌图标（内嵌 simple-icons SVG）
│   ├── port.ts            # 端口解析与 1-65535 校验
│   ├── regions.ts         # DO locationHint 区域选项共享数据（Auto + 白名单）
│   ├── theme.ts           # Theme V2 内置主题、UI CSS 变量与外观预设
│   ├── auth-challenge-dialog.ts # RFC 4256 multi-round authentication prompt UI
│   ├── mobile-terminal.ts # Mobile viewport, shortcut toolbar, clipboard and landscape controller
│   ├── mobile-input.ts    # Pure iOS IME diff and one-shot modifier helpers
│   ├── known-hosts.ts     # 已验证主机指纹消息校验、本地/云端 TOFU 持久化
│   ├── tab-manager.ts     # Tab manager (multi-session terminal/SFTP/Agent coordinator, 返回终端按钮联动)
│   ├── sftp-panel.ts      # SFTP file manager UI (multi-select, batch actions, queue, cancel)
│   ├── sftp-selection.ts  # Pure multi-selection state model
│   ├── auth-form.ts       # Auth form & encrypted anonymous credentials storage/autofill
│   ├── server-list.ts     # Server UI (tags, search, responsive 9/6/3-card pagination, CRUD/connect)
│   ├── share-manager.ts   # Owner UI for creating, revoking, and auditing one-time shares
│   ├── share-session.ts   # Public one-time share landing and claim flow
│   ├── agent/
│   │   ├── agent-panel.ts # AI assistant sidebar (context attachments, streaming, Markdown, confirmations)
│   │   ├── code-actions.ts # Agent 代码块语言归一化与 Shell 单行命令可填性判定
│   │   └── terminal-selection-context.ts # Selection snapshots and untrusted-data prompt boundary
│   ├── snippet-manager.ts # 命令片段库面板（云端/本地双后端、填入/填入并执行、编辑/删除）
│   ├── snippet-store.ts   # 片段存储层（RemoteSnippetStore + LocalSnippetStore + 错误映射）
│   ├── ai-config.ts       # AI model configuration modal
│   ├── i18n/
│   │   ├── index.ts        # 语言解析、词条查询（t）与 locale 变更通知
│   │   └── locales/        # zh-CN.ts / en-US.ts 词条字典
│   ├── style.css           # Global styles (CSS variable theme system)
│   └── turnstile.d.ts      # Turnstile type declarations
└── vite.config.ts          # Dev proxy to localhost:8787（+ esbuild minifySyntax 关闭以规避 xterm 6 DECRQM bug）
```

tests/

```
├── README.md            # 测试套件说明（目录结构、运行命令）
├── build/               # 生产构建、可复现性与无原生弹窗回归
├── e2e/                 # Chromium Playwright 交互与 axe 无障碍检查
├── ssh/                 # SSH 算法、认证、KEX、加密、通道与测试密钥夹具
├── worker/              # Worker 路由、安全、DNS 防重绑定、UserDB/标签/片段/跳板/分享策略测试
└── *.test.ts            # 前端源码级回归（i18n、剪贴板、SFTP 选择、主题、终端状态/文本等）
```

## Development Commands

```bash
# Start development (builds frontend + starts wrangler dev)
pnpm run dev

# Deploy production (builds frontend + deploys worker)
pnpm run deploy

# Deploy test environment (builds frontend + deploys to cloudssh-test)
pnpm run deploy:test

# Build frontend only (required before deploy)
pnpm run build:frontend

# Synchronize GitHub Pages theme presets from frontend/src/theme.ts
pnpm run sync:theme-editor

# Run tests
pnpm test

# Generate coverage report (output to coverage/)
pnpm run test:coverage

# Watch mode for tests
pnpm run test:watch

# Run worker + frontend type checks
pnpm run typecheck

# Type-check worker or frontend separately
pnpm run typecheck:worker / pnpm run typecheck:frontend

# Run browser E2E and accessibility tests
pnpm run test:e2e

# Run the complete local quality gate
pnpm run verify

# Install frontend dependencies (separate from root)
cd frontend && pnpm install
```

## Critical Build Process

The frontend is **NOT** served separately in production. The build process:

1. Builds frontend with Vite (`frontend/dist/`)
2. Inlines all CSS/JS into a single HTML string
3. Writes to `src/worker/html.ts` as a template literal
4. Worker serves this inlined HTML for all requests

**Important**: `src/worker/html.ts` is auto-generated. Never edit it directly - changes will be overwritten.

## Durable Objects

Three Durable Objects handle state:

1. **SSHSessionDO** (`src/worker/durable-object.ts`)
   - Manages WebSocket ↔ TCP socket connections
   - Handles SSH session lifecycle
   - Accepts browser WebSockets through the Hibernation API, but active outbound SSH TCP sockets keep the DO awake and prevent hibernation during a live session

2. **UserDBDO** (`src/worker/user-db.ts`)
   - SQLite-based user and server storage
   - GitHub OAuth user management

3. **SSHShareDO** (`src/worker/share-do.ts`)
   - Owns one random capability's one-time claim, short-lived connection ticket, expiry, and revocation state
   - Stores the append-only lifecycle, SFTP, and terminal-output audit log for that share session

## Environment Variables

Required for optional features (configured in `wrangler.toml` or Cloudflare Dashboard):

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` - GitHub OAuth
- `GITHUB_ALLOWED_USER_IDS` - Optional comma-separated numeric GitHub user ID allowlist; omitted means unrestricted GitHub login
- `REQUIRE_GITHUB_AUTH` - Optional; `true` disables anonymous SSH and requires a valid GitHub session
- `ENABLE_SSH_SHARING` - Optional; `true` enables one-time audited SSH sharing for signed-in owners (disabled by default)
- `TURNSTILE_SECRET` / `TURNSTILE_SITEKEY` - Bot verification
- `BASE_URL` - OAuth callback URL
- `STRICT_HOST_KEY_VERIFY` - Optional; `false` skips host-key signature verification failures (default true, fails closed)
- `DEBUG_MODE` - Optional; `true` appends debug info to API responses（wrangler.toml `[vars]` 已声明 `DEBUG_MODE`）

> 注意：`Env` 中声明的 `MAX_CONNECTIONS` / `IDLE_TIMEOUT` 属预留变量，当前代码未读取，切勿依赖。

## API Routes

| Route | Method | Auth | Description |
| ------- | -------- | ------ | ------------- |
| `/api/auth/github` | GET | No | GitHub OAuth redirect |
| `/api/auth/callback` | GET | No | OAuth callback, creates user + session |
| `/api/auth/logout` | POST | No | Logout, clears session |
| `/api/auth/me` | GET | Yes | Returns current user info |
| `/api/servers` | GET/POST | Yes | List or create saved servers（含 `tags` 与可选 `jump_server_id`） |
| `/api/servers/:id` | PUT/DELETE | Yes | Update or delete a server（含标签和跳板关系校验） |
| `/api/servers/:id/connect` | POST | Yes | Generate one-time-token, return WebSocket URL |
| `/api/servers/:id/shares` | GET/POST | Yes | List or create one-time SSH shares for a saved server |
| `/api/shares/:id` | DELETE | Yes | Revoke a share owned by the current user |
| `/api/shares/:id/audit` | GET | Yes | Read the paginated audit log for an owned share |
| `/api/share/claim` | POST | No | Atomically claim a capability token and return a short-lived WebSocket ticket |
| `/api/user/theme` | GET/PUT | Yes | Get or replace the signed-in user's single custom theme |
| `/api/known-hosts` | GET/POST/DELETE | Yes | Known host fingerprint CRUD (TOFU) |
| `/api/snippets` | GET/POST | Yes | List or create command snippets (per-user, max 100) |
| `/api/snippets/:id` | PUT/DELETE | Yes | Update or delete a command snippet (ownership scoped by user_id) |
| `/api/ai/config` | GET/PUT | Yes | Get or save AI LLM config |
| `/api/ai/models` | POST | Yes | Proxy model list from user's LLM provider |
| `/api/verify` | POST | No | Turnstile bot verification |
| `/api/ssh` | WebSocket | Conditional | SSH terminal WebSocket connection |
| `/api/ssh/sftp` | WebSocket | Token | SFTP data WebSocket (attaches to existing session) |
| `/api/health` | GET | No | Health check |
| `/api/config` | GET | No | Feature flags (turnstile, GitHub auth enabled) |

## Testing

Tests use Vitest for unit/integration and Playwright + axe for browser E2E:

```bash
pnpm test            # Vitest 单元与集成测试
pnpm run test:coverage  # 覆盖率（输出到 coverage/）
pnpm run test:e2e    # Playwright 浏览器 E2E 与 axe 无障碍检查
pnpm run verify      # typecheck + test + build:frontend + test:e2e 完整门禁
```

- 测试文件位于 `tests/` 目录，`.test.ts` 后缀（详见 Key Directories 中的 `tests/` 结构）。
- `tests/ssh/fixtures/` 中的私钥只用于公开协议测试，绝不可用于真实服务器。
- E2E 首次运行需安装浏览器：`pnpm exec playwright install chromium`。
- 新增前端文案必须同时提供 zh-CN/en-US 词条，`i18n.test.ts` 会校验两端词条对齐。

## Git 工作流规范

**禁止创建特性分支（feature branch）。** 所有变更必须直接提交到 `test` 分支，保持仓库分支结构整洁。

```
test 分支（开发/测试）  ──合并──>  main 分支（生产）
```

### 提交流程

1. 切换到 `test` 分支：`git checkout test`
2. 拉取最新代码：`git pull origin test`
3. 进行开发并本地测试
4. 直接提交到 `test` 分支并推送：`git push origin test`
5. 测试通过后，维护者将 `test` 合并到 `main`

### 提交信息规范

遵循 Conventional Commits 格式，描述使用中文：

```
<type>: <中文描述>

feat: 添加新功能
fix: 修复某个问题
refactor: 重构某模块
perf: 性能优化
docs: 文档更新
chore: 构建/配置变更
ci: CI/CD 变更
release: 发布 vX.Y.Z <主题>版本（如 `release: 发布 v1.10.2 工作流和文档更新版本`）
```

### 分支用途

| 分支 | 用途 | 可直接推送 |
| ------ | ------ | ----------- |
| `test` | 所有开发、测试、PR 合入 | ✅ |
| `main` | 生产环境，仅通过 test 合入 | ❌（保护分支） |

## Common Pitfalls

1. **Don't edit `src/worker/html.ts`** - It's auto-generated by `scripts/build-html.js`
2. **Frontend has separate dependencies** - Run `pnpm install` in `frontend/` directory
3. **Durable Object migrations** - New DO classes require migration tags in `wrangler.toml`
4. **Local dev proxy** - Frontend dev server proxies `/api` to `localhost:8787` (wrangler)
5. **TypeScript config** - Root `tsconfig.json` excludes `frontend/` (has its own config)
6. **AI Agent runs in DO** - The agent control loop (`agent/core.ts`) executes inside the Durable Object, not the Worker itself, to access the SSH session directly
7. **Agent tool confirmations** - Dangerous commands (rm -rf, shutdown, etc.) require user confirmation via `agent_confirm` WebSocket message before execution. Blocked commands (rm -rf /, fork bomb, etc.) are rejected outright without prompting. Preserve detection across shell control boundaries (`;`, `&&`, `||`, pipes, parentheses, and newlines), including combinations without surrounding spaces.
8. **Agent loop timeouts & Watchdog** - The agent run loop has a step-based timeout of 60 seconds (managed by a watchdog timer in `agent/core.ts` that resets after each LLM response or tool execution). When waiting for user confirmation via `agent_confirm`, the watchdog timer is paused to prevent timeouts due to user delays.
9. **SSH rate limiting** - `/api/ssh` uses a bounded, Worker-isolate in-memory limiter for traffic shedding. It skips requests without `CF-Connecting-IP`; Turnstile and one-time tokens remain the connection authorization controls.
10. **Tailwind is built locally** - `frontend/postcss.config.cjs` and `frontend/tailwind.config.cjs` generate Tailwind CSS during Vite builds. Do not reintroduce `cdn.tailwindcss.com`; keep content scan paths and theme variable mappings synchronized when adding frontend source locations or theme tokens.
11. **Builds never install dependencies** - run `pnpm install --frozen-lockfile` before build/deploy. `scripts/build-html.js` requires exactly one JS and one CSS bundle so every production asset is inlined deterministically.
12. **Server list organization** - server tags are stored as normalized JSON in SQLite, filtered client-side, and rendered with responsive pagination（桌面端每页 9 张、平板 6 张、移动端 3 张，三档常量见 `frontend/src/server-list.ts`）。Search/tag changes must reset pagination to page 1.
13. **SFTP selection model** - file selection supports single, Cmd/Ctrl toggle, Shift range and select-all. Batch download reuses the sequential download queue; batch delete waits for all delete/rmdir results before refreshing.
14. **Agent terminal selection context** - “Ask AI assistant” attaches one immutable selection snapshot per tab and never sends it by itself. New selections replace the pending snapshot; successful sends and session teardown clear it. Preserve the untrusted-data/non-authorization boundary in `terminal-selection-context.ts`.
15. **Region inference privacy** - Saving or changing a Cloudflare-direct server host calls the third-party IPinfo service and persists the inferred locationHint. Servers with `jump_server_id` are downstream nodes: never query their hosts, ignore and clear their own region hints, and infer once if they later become direct Auto entries. Keep the provider name and disclosure synchronized across README/code comments; failures must continue to fall back to Cloudflare's default placement.
16. **Theme editor ownership** - The full visual editor and JSON export live in `docs/theme-editor/index.html` for GitHub Pages and never authenticate against CloudSSH. `scripts/sync-theme-editor.js` keeps its built-in colors and resolved appearance presets aligned with `frontend/src/theme.ts`; the application and Worker share Theme V2 validation through `src/theme-schema.ts`. The application only imports JSON themes and synchronizes the single custom-theme slot through `/api/user/theme` for signed-in users; later imports replace the previous theme, while anonymous themes remain local.
17. **Mobile terminal input and recovery** - Mobile shortcuts and the iOS keyCode 229 fallback must continue through `TrzszFilter.processTerminalInput`; never send them directly to the WebSocket, and do not permit any terminal input until `shell_ready`. For iOS IME fallback, capture the textarea baseline on `keydown=229` but flush on the corresponding `keyup` regardless of its key code, since Safari commonly reports 32 for Space and 0 for punctuation; xterm `onData` remains authoritative to prevent duplicate input. Keep the explicit mobile selection mode isolated from desktop mouse auto-copy, map touch drags through xterm's public selection API instead of native long-press selection, and debounce visual viewport refits. Enable background-return visibility recovery only when the device has touch points and a coarse primary pointer, so desktop tab changes do not emit recovery logs or probes. A mobile background return must validate the WebSocket with a bounded ID-matched heartbeat instead of trusting `readyState`; anonymous reconnects may reuse only the current in-memory config, while saved-server reconnects must request a fresh one-time token from `/api/servers/:id/connect`. Never report a connection as online before the replacement Shell is ready.
18. **Saved-server OS detection** - Run OS detection only for signed-in saved servers without a persisted result, through a separate non-blocking SSH exec channel after Shell readiness. Never persist `unknown`; host or port changes must clear the stored OS, and background metadata updates must not change `updated_at` or server ordering. Keep backend canonical keys synchronized with frontend labels/icon fallbacks.
19. **Keyboard-interactive authentication** - Begin user authentication with the RFC 4252 `none` probe and choose only methods advertised by the server, while retaining the bounded compatibility fallback for servers that omit the list. RFC 4256 challenges are event-driven during the SSH auth state. Keep method-specific message type 60 disambiguated by the active auth method, use `partial_success` to advance bounded multi-factor stages, and only fall back without partial success when the server no longer offers the configured primary method. Bind browser responses and `auth_challenge_ack` display acknowledgements to one random challenge ID and originating WebSocket, distinguish an undisplayed challenge from an acknowledged but unanswered challenge, never log responses, clear pending challenges on timeout/reconnect/close, require explicit user action before substituting a stored password, and close authentication timeouts normally so older frontends cannot reconnect repeatedly. Treat ordinary server-side credential rejection as an expected close rather than WebSocket error 1011.
20. **WebSocket origin boundary** - `/api/ssh` (anonymous and one-time-token paths) and `/api/ssh/sftp` are browser-only, same-origin endpoints. Reject WebSocket upgrades when `Origin` is missing or differs from the request URL origin, and keep regression coverage synchronized across all three paths.
21. **GitHub access policy** - `GITHUB_ALLOWED_USER_IDS` contains stable numeric GitHub IDs and is rechecked during OAuth callback and every session verification; omitted means unrestricted, while an empty or malformed configured value fails closed. `REQUIRE_GITHUB_AUTH=true` disables anonymous SSH and requires a valid session for direct and one-time-token SSH upgrades, but does not terminate already established WebSockets. Never expose the allowlist through `/api/config`.
22. **SSH jump chains** - Jump hosts are available only to signed-in users through saved-server `jump_server_id` relations. Resolve one immutable outer-to-target chain in UserDBDO, reject cross-user references, cycles, deletion of referenced hops, and more than 3 jump hosts. Apply public-address SSRF checks only to the outermost Cloudflare TCP destination; anonymous clients must never inject `jumpHosts`. Every intermediate SSHSession authenticates without opening a Shell and exposes only RFC 4254 `direct-tcpip`; terminal, SFTP, Agent exec, and OS detection belong to the final session. Preserve nested channel backpressure, close the full chain on any-hop failure, and scope known-host identities by the complete route so equal private addresses behind different bastions do not collide.
23. **SSH host-key TOFU** - Never publish or persist a first-seen/replacement fingerprint before its KEX host-key signature succeeds. A changed fingerprint must close normally without automatic retry, display the old/new values for explicit user confirmation, and replace only the exact route-scoped identity. Saved-server confirmation must update the cloud record before requesting a fresh one-time token; anonymous confirmation may update only the current in-memory config and local record. Cancellation or persistence failure must leave the previous trust record intact.
24. **Command snippets** - 按 `user_id` 行级隔离存于 UserDBDO（名称≤50、命令≤2000、每用户≤100 条），所有 CRUD 均 `WHERE user_id = ?`；匿名用户降级 `localStorage`（`cloudssh_snippets`）。插入默认不自动回车（`insertSnippet` 单行走 `fillInput`、多行走 `xterm paste`），一次性分享会话中隐藏入口。

25. **One-time SSH sharing** - Sharing is disabled unless `ENABLE_SSH_SHARING=true`. A link contains only a 256-bit capability, persists only its hash, can be claimed once, and exchanges for a one-minute connection ticket. Creation requires route-scoped verified host fingerprints for the target and every jump hop. Share policy is issued only by SSHShareDO/UserDBDO and must disable Agent, OS detection, host-key mutation, metadata mutation, keyboard-interactive auth, and reconnect while permitting only Terminal and optional SFTP. Record lifecycle, structured SFTP requests/results, and terminal output (not raw keystrokes); stop the session if audit storage fails or reaches 5 MiB/5000 events. Revocation and expiry must close the live SSHSessionDO. Preserve completed audit metadata if its saved-server record is later deleted.

26. **DNS rebinding SSRF defense** - Address-string checks (`isBlockedHost` / `validateBaseUrl`) alone can be bypassed by domains resolving to private/reserved IPs. `src/worker/dns-check.ts` resolves hostnames via DNS-over-HTTPS (1.1.1.1) and checks every resolved IP against a unified block list covering IPv6 edge cases; it gates both SSH outbound targets (`durable-object.ts`) and AI `base_url` (`agent/ssrf.ts`). When adding address families or reserved ranges, keep the DoH block list and the string-level checks synchronized.

27. **Biome formatting convention** - `biome.json`（single 引号、`lineWidth: 100`）自 v1.10.0 起是代码格式基准，相关 lint 规则（`noUnusedVariables`/`useConst` 等）应保持通过；CI 质量门禁不执行 Biome，以 `typecheck` + `test` + 可复现构建 + E2E 为准。

28. **Frontend i18n** - 所有面向用户的文案走 `frontend/src/i18n` 的 `t()` / `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` 管线并同步 `locales/zh-CN.ts` 与 `en-US.ts`；语言解析支持 URL 参数、localStorage（`cloudssh_locale`）与浏览器语言回退。新增文案时保持两端词条对齐，勿硬编码中文到模板字符串。

29. **CI paths-ignore 作用域** - `deploy.yml` 的 `paths-ignore` 使用标准 glob：`*` 不匹配 `/`，因此 `*.md` 只覆盖仓库根目录的 Markdown，`tests/` 等子目录下的文档变更（如 `tests/README.md`）会照常触发部署流水线。忽略目录内文件必须用 `**/*.md` / `**/*.png` 等跨目录模式；修改 `deploy.yml` 本身会触发一次校验运行（属于预期行为，且能验证新过滤规则）。

30. **Agent exec 输出有界性（弱网 OOM 防线）** - `AgentExecChannel` 对 exec 通道 stdout/stderr 执行有界捕获：合计 4MB 硬上限（`MAX_EXEC_CAPTURE_BYTES`，超限不再续 SSH window 并由会话层关闭通道击杀远端命令，如无界输出的 `docker logs`），保留头 128KB + 尾 256KB 环形视图并附加截断说明，`onData/onExtendedData` 的布尔返回值控制 window 续期，改动时勿恢复无界累积。守卫不只此一层：`docker_manage(logs)` 强制 `--tail 200` 且拒绝 `-f/--follow`；工具结果序列化进 LLM 前经 64K 字符中间截断；socket 写带 15s deadline（超时关底层 socket 解挂）；独立于写路径的被动 idle 看门狗（60s 无入站数据即关闭）与终端输入队列 4MB 上限共同保证弱网下会话必然收敛，勿移除任一防线。

## Deployment Notes

### 双环境部署

项目支持 production 和 test 两个独立环境同时运行在 Cloudflare 上：

| 环境 | Worker 名称 | 分支 | 域名 |
| ------ | ------------ | ------ | ------ |
| Production | `cloudssh` | `main` | `<name>.workers.dev` + 自定义域名 |
| Test | `cloudssh-test` | `test` | `<name>-test.workers.dev` + 自定义域名 |

两个环境的 Durable Objects（SSHSessionDO、UserDBDO、SSHShareDO）数据完全隔离。

### 部署方式

**方式一：Cloudflare Dashboard（推荐）**

1. 构建前端：`pnpm run build:frontend`
2. 进入 Cloudflare Dashboard → Workers
3. 创建/选择 worker（production 用 `cloudssh`，test 用 `cloudssh-test`）
4. 上传构建产物或通过 Git 集成自动部署
5. 在 Settings → Variables 中配置环境变量和 DO 绑定
6. 如需自定义域名，在 Settings → Domains & Routes 中绑定

**方式二：Wrangler CLI**

```bash
pnpm run deploy          # 部署 production
pnpm run deploy:test     # 部署 test 环境
```

**方式三：GitHub Actions（CI/CD）**

- `test` 分支 push → 自动部署到 `cloudssh-test`
- `main` 分支 push → 自动部署到 `cloudssh`
- `docs/**` 变更 → 发布 GitHub Pages 主题编辑器（`github-pages.yml`）
- Fork 定时同步上游 `main`（`sync-upstream.yml`，默认关闭，由 `AUTO_SYNC_UPSTREAM` 仓库变量开启）

> 部署门禁（`deploy.yml`）依次执行：冻结锁文件安装 → Playwright 浏览器安装 → `typecheck` → `test` → `build:frontend` → `test:e2e` → 按分支部署；任一环节失败即阻断部署。

### 自定义域名

`wrangler.toml` 中不硬编码自定义域名（开源项目，每人域名不同）。默认使用 Cloudflare 提供的 `workers.dev` 域名。如需绑定自定义域名：

- 在 Cloudflare Dashboard → Workers → 你的 Worker → Settings → Domains & Routes 中添加
- 或在 `wrangler.toml` 中添加 `[[routes]]` 配置（仅本地使用，勿提交到仓库）

### Secrets 配置

通过 Cloudflare Dashboard 或 wrangler CLI 设置：

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` - GitHub OAuth
- `GITHUB_ALLOWED_USER_IDS` - 可选，逗号分隔的 GitHub 数字用户 ID 白名单
- `REQUIRE_GITHUB_AUTH` - 可选，设为 `true` 时禁用匿名 SSH 并要求有效 GitHub session
- `ENABLE_SSH_SHARING` - 可选，设为 `true` 时允许登录用户创建一次性、受审计的 SSH 分享（默认关闭）
- `TURNSTILE_SECRET` / `TURNSTILE_SITEKEY` - Bot 验证
- `BASE_URL` - OAuth 回调地址（需与实际域名一致）

Dashboard: Workers → 你的 Worker → Settings → Variables → Environment Variables
CLI: `npx wrangler secret set <SECRET_NAME>`

### 首次部署与迁移注意

- 新 Durable Object 类必须通过 `wrangler.toml` 中新的、不可复用的 migration tag 部署；已有环境不得通过删除 Worker 作为常规初始化或迁移方式
- 只有确认环境中没有需要保留的数据、且明确要重建整个环境时，才可删除 Worker
- Test 环境 DO 绑定与 production 相同的 class_name，但因 Worker 名称不同，数据完全隔离

## AI 版本发布与文档维护规范

在辅助人类进行版本升级和发布时，AI 助手必须严格遵守以下规范：

1. **版本信息流转（由人类主导，AI 辅助更新）**：
   - 严禁 AI 助手自主决定或递增版本号。
   - 当需要发布新版本时，根据人类指定的版本号，AI 应在本地修改：
     - `package.json` 中的 `"version": "X.Y.Z"`。
     - `frontend/package.json` 中的 `"version": "X.Y.Z"`（与根目录保持一致）。
     - `CHANGELOG.md` 头部追加最新的更新日志（格式需为 `## [X.Y.Z] - YYYY-MM-DD`）。
   - 必须遵循 [Keep a Changelog](https://keepachangelog.com/) 规范组织内容。
2. **README 导航链接维护**：
   - `README.md` 中的 `更新日志` 链接与 `README_en.md` 中的 `Changelog` 跳转超链接必须保持正常。
3. **发布流程（从版本指定到上线，按顺序执行）**：
   1. 用户明确指定发布版本号（如 v1.10.1）后，AI 按第 1 条更新版本文件与 CHANGELOG，并提交推送：
      - 提交信息遵循 `release: 发布 vX.Y.Z <主题>版本` 格式（主题概括本次版本的核心改动，如 `release: 发布 v1.10.2 工作流和文档更新版本`），正文注明本次版本更新要点与验证结果（typecheck / test / verify）。
      - 提交前确认工作区干净或只暂存版本与 CHANGELOG 相关文件，避免混入无关改动（如格式化漂移）。
      - 推送 `test` 分支：`git push origin test`（触发测试环境自动部署）。
   2. 创建 PR 合并 `test` 到 `main`：
      - 标题遵循 `release: 发布 vX.Y.Z <主题>版本` 格式（与提交信息主题一致）。
      - 正文必须说明本次版本的更新内容：包含提交列表、关联 Issue/PR、验证结果。
   3. **PR 的审核与合并由用户手动完成**：AI 创建 PR 后应等待用户审核并合并，不得自行合并或使用管理员旁路合并。
   4. 用户合并 PR 到 `main` 后（生产环境自动部署），AI 执行以下命令同步本地分支：

      ```bash
      git fetch origin && git reset --hard origin/main && git push origin test --force
      ```

      - 该操作使本地 `test` 分支与已发布的 `main` 完全一致。
      - 若此前还有未发布的 `test` 提交，会被强制覆盖，请确认已合并完成后再执行。
