# AGENTS.md
<!-- 
  维护提醒：当以下文件变更时请同步更新此文档：
  - wrangler.toml (Durable Objects、环境变量、路由)
  - src/worker/index.ts (API 路由、入口逻辑)
  - scripts/build-html.js (构建流程)
  - package.json (依赖、脚本命令)
  - src/types.ts (Env 接口、类型定义)
-->

## Project Overview

CloudSSH is a serverless Web SSH terminal built on Cloudflare Workers. Users connect to SSH servers through a browser-based terminal UI with integrated SFTP file management and AI Agent assistant.

## Architecture

- **Frontend** (`frontend/`): TypeScript + Vite + xterm.js + Tailwind CSS
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
│   ├── ssh-session.ts     # SSH session logic, multi-channel routing, SFTP handling
│   ├── sftp-handler.ts    # SFTP protocol ops, task queue, concurrent download, upload tracking
│   ├── user-db.ts    # UserDBDO - user/server storage
│   ├── auth.ts       # GitHub OAuth handling
│   ├── agent/        # AI Agent system
│   │   ├── core.ts       # Agent control loop (LLM calls, tool execution)
│   │   ├── tools.ts      # 8 tool definitions (execute_command, detect_environment, list_processes, service_manage, docker_manage, etc.)
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
│   ├── auth.ts       # Authentication methods (password, Ed25519 public key)
│   ├── channel.ts    # SSH channels (session + SFTP subsystem + exec)
│   ├── crypto.ts     # AES-GCM/CTR cipher, HMAC implementations
│   ├── keys.ts       # Key derivation per RFC 4253
│   ├── utils.ts      # Binary utilities
│   ├── sftp.ts       # SFTP v3 client implementation
│   └── sftp-types.ts # SFTP protocol constants and types
└── types.ts          # Shared TypeScript type definitions

frontend/
├── src/
│   ├── main.ts       # Frontend entry point (routing, theme, event handlers)
│   ├── terminal.ts   # xterm.js terminal setup (search, dynamic RTT latency, log export)
│   ├── tab-manager.ts # Tab manager (multi-session terminal/SFTP/Agent coordinator)
│   ├── sftp-panel.ts # SFTP file manager UI (queue, cancel support)
│   ├── auth-form.ts  # Auth form & encrypted anonymous credentials storage/autofill
│   ├── server-list.ts # Server management UI (card grid, add/edit/delete/connect)
│   ├── agent/
│   │   └── agent-panel.ts  # AI assistant sidebar (streaming output, Markdown rendering, thinking process, confirm dialogs)
│   ├── ai-config.ts  # AI model configuration modal
│   ├── style.css     # Global styles (CSS variable theme system)
│   └── turnstile.d.ts # Turnstile type declarations
└── vite.config.ts    # Dev proxy to localhost:8787
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

# Run tests
pnpm test

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

Two Durable Objects handle state:

1. **SSHSessionDO** (`src/worker/durable-object.ts`)
   - Manages WebSocket ↔ TCP socket connections
   - Handles SSH session lifecycle
   - Uses Hibernation API for long-lived connections

2. **UserDBDO** (`src/worker/user-db.ts`)
   - SQLite-based user and server storage
   - GitHub OAuth user management

## Environment Variables

Required for optional features (configured in `wrangler.toml` or Cloudflare Dashboard):

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` - GitHub OAuth
- `TURNSTILE_SECRET` / `TURNSTILE_SITEKEY` - Bot verification
- `BASE_URL` - OAuth callback URL

## API Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/auth/github` | GET | No | GitHub OAuth redirect |
| `/api/auth/callback` | GET | No | OAuth callback, creates user + session |
| `/api/auth/logout` | POST | No | Logout, clears session |
| `/api/auth/me` | GET | Yes | Returns current user info |
| `/api/servers` | GET/POST | Yes | List or create saved servers |
| `/api/servers/:id` | PUT/DELETE | Yes | Update or delete a server |
| `/api/servers/:id/connect` | POST | Yes | Generate one-time-token, return WebSocket URL |
| `/api/user/theme` | GET/PUT | Yes | Get or save user custom theme |
| `/api/known-hosts` | GET/POST/DELETE | Yes | Known host fingerprint CRUD (TOFU) |
| `/api/ai/config` | GET/PUT | Yes | Get or save AI LLM config |
| `/api/ai/models` | POST | Yes | Proxy model list from user's LLM provider |
| `/api/verify` | POST | No | Turnstile bot verification |
| `/api/ssh` | WebSocket | Conditional | SSH terminal WebSocket connection |
| `/api/ssh/sftp` | WebSocket | Token | SFTP data WebSocket (attaches to existing session) |
| `/api/health` | GET | No | Health check |
| `/api/config` | GET | No | Feature flags (turnstile, GitHub auth enabled) |

## Testing

Tests use Vitest. Run with:
```bash
pnpm test
```

Test files should be in `tests/` directory with `.test.ts` extension.

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
```

### 分支用途

| 分支 | 用途 | 可直接推送 |
|------|------|-----------|
| `test` | 所有开发、测试、PR 合入 | ✅ |
| `main` | 生产环境，仅通过 test 合入 | ❌（保护分支） |

## Common Pitfalls

1. **Don't edit `src/worker/html.ts`** - It's auto-generated by `scripts/build-html.js`
2. **Frontend has separate dependencies** - Run `pnpm install` in `frontend/` directory
3. **Durable Object migrations** - New DO classes require migration tags in `wrangler.toml`
4. **Local dev proxy** - Frontend dev server proxies `/api` to `localhost:8787` (wrangler)
5. **TypeScript config** - Root `tsconfig.json` excludes `frontend/` (has its own config)
6. **AI Agent runs in DO** - The agent control loop (`agent/core.ts`) executes inside the Durable Object, not the Worker itself, to access the SSH session directly
7. **Agent tool confirmations** - Dangerous commands (rm -rf, shutdown, etc.) require user confirmation via `agent_confirm` WebSocket message before execution. Blocked commands (rm -rf /, fork bomb, etc.) are rejected outright without prompting.
8. **Agent loop timeouts & Watchdog** - The agent run loop has a step-based timeout of 60 seconds (managed by a watchdog timer in `agent/core.ts` that resets after each LLM response or tool execution). When waiting for user confirmation via `agent_confirm`, the watchdog timer is paused to prevent timeouts due to user delays.
9. **SSH rate limiting** - `/api/ssh` uses a bounded, Worker-isolate in-memory limiter for traffic shedding. It skips requests without `CF-Connecting-IP`; Turnstile and one-time tokens remain the connection authorization controls.

## Deployment Notes

### 双环境部署

项目支持 production 和 test 两个独立环境同时运行在 Cloudflare 上：

| 环境 | Worker 名称 | 分支 | 域名 |
|------|------------|------|------|
| Production | `cloudssh` | `main` | `<name>.workers.dev` + 自定义域名 |
| Test | `cloudssh-test` | `test` | `<name>-test.workers.dev` + 自定义域名 |

两个环境的 Durable Objects（SSHSessionDO、UserDBDO）数据完全隔离。

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

### 自定义域名

`wrangler.toml` 中不硬编码自定义域名（开源项目，每人域名不同）。默认使用 Cloudflare 提供的 `workers.dev` 域名。如需绑定自定义域名：
- 在 Cloudflare Dashboard → Workers → 你的 Worker → Settings → Domains & Routes 中添加
- 或在 `wrangler.toml` 中添加 `[[routes]]` 配置（仅本地使用，勿提交到仓库）

### Secrets 配置

通过 Cloudflare Dashboard 或 wrangler CLI 设置：
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` - GitHub OAuth
- `TURNSTILE_SECRET` / `TURNSTILE_SITEKEY` - Bot 验证
- `BASE_URL` - OAuth 回调地址（需与实际域名一致）

Dashboard: Workers → 你的 Worker → Settings → Variables → Environment Variables
CLI: `npx wrangler secret set <SECRET_NAME>`

### 首次部署注意

- 新 Durable Objects 首次部署：先删除旧 worker 再重新部署（`npx wrangler delete <worker-name>`）
- Test 环境 DO 绑定与 production 相同的 class_name，但因 Worker 名称不同，数据完全隔离

## AI 版本发布与文档维护规范

在辅助人类进行版本升级和发布时，AI 助手必须严格遵守以下规范：

1. **版本信息流转（由人类主导，AI 辅助更新）**：
   - 严禁 AI 助手自主决定或递增版本号。
   - 当需要发布新版本时，根据人类指定的版本号，AI 应在本地修改：
     - `package.json` 中的 `"version": "X.Y.Z"`。
     - `CHANGELOG.md` 头部追加最新的更新日志（格式需为 `## [X.Y.Z] - YYYY-MM-DD`）。
   - 必须遵循 [Keep a Changelog](https://keepachangelog.com/) 规范组织内容。
2. **README 导航链接维护**：
   - `README.md` 中的 `更新日志` 链接与 `README_en.md` 中的 `Changelog` 跳转超链接必须保持正常。
