# Web SSH · 类 Windows 桌面

一个网页端 SSH 工具：浏览器里以**类 Windows 桌面**（窗口 / 任务栏 / 开始菜单）管理多台 VPS，连接终端、传输文件，全部跑在 **Cloudflare Workers**（纯 serverless，无常驻服务器）。

> **本项目基于 [CloudSSH](https://github.com/newbietan/CloudSSH)（Apache-2.0）二次开发。**
> 后端 SSH-2.0 / SFTP 协议引擎、Durable Objects 会话、GitHub OAuth、凭据加密存储**沿用 CloudSSH**；
> 本项目的改动是**将前端从标签页式界面重做为 GMSSH 式类 Windows 桌面外壳**（窗口管理器、桌面、任务栏、开始菜单）。
> 原项目版权归其作者所有，`LICENSE`（Apache-2.0）已随仓库保留。

## 功能

- **账号登录**：GitHub OAuth；登录后记住多台 VPS（IP / 端口 / 账号 / 密码或密钥，AES-256-GCM 加密存储）。
- **类 Windows 桌面**：壁纸、桌面图标、任务栏、开始菜单、时钟；每个功能是一个可**拖拽 / 缩放 / 最小化 / 最大化 / 置顶 / 关闭**的窗口。
- **多终端**：同时打开多台主机的终端窗口，基于 xterm.js。
- **文件传输**：终端窗口内切换 SFTP 面板，上传 / 下载 / 重命名 / 删除。
- **匿名连接**：不登录也可直接填 IP/密码临时连接。

> 当前进度：SP1（桌面外壳 + 窗口系统 + 复用 CloudSSH 终端/SFTP）。类 Windows 资源管理器（左树右列表、右键菜单、拖拽上传）为后续 SP2。

## 架构

```
浏览器 (Cloudflare Pages/Worker 托管的前端)
  └─ 类 Windows 桌面前端 (TS + Vite + Tailwind + xterm.js)
        │  WebSocket (one-time-token)
        ▼
Cloudflare Worker (src/worker) ── cloudflare:sockets ──▶ 目标 VPS:22
  ├─ 纯 TS 实现的 SSH-2.0 / SFTP (src/ssh)
  └─ Durable Objects: SSH_SESSION（会话）/ USER_DB（用户与服务器）
```

Worker 单体部署，同时托管前端静态资源（经 `scripts/build-html.js` 内联到 `src/worker/html.ts`）。

## 部署

**前置条件**：Cloudflare 账号；一个 GitHub OAuth App；本机装 Node 18+ 与 pnpm。

1. 安装依赖：
   ```bash
   pnpm install
   ```
2. 在 Cloudflare Dashboard 为该 Worker 配置环境变量（见 `wrangler.toml` 注释）：
   - `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（OAuth 回调填 `<BASE_URL>/api/auth/github/callback`）
   - `BASE_URL`（部署域名，与回调一致）
   - 可选：`TURNSTILE_SECRET` / `TURNSTILE_SITEKEY`（人机验证）
3. 登录并部署（首次部署会按 `wrangler.toml` 的 migration `v1` 创建两个 Durable Object）：
   ```bash
   wrangler login      # 或设置 CLOUDFLARE_API_TOKEN
   pnpm deploy         # = node scripts/build-html.js && wrangler deploy
   ```

### 从已部署的 CloudSSH 增量更新

如果你已经部署过 CloudSSH，**推荐增量更新而非全新部署**：本项目只改了前端，`wrangler.toml` 的 Worker 名、Durable Object 类名（`SSHSessionDO` / `UserDBDO`）与 migration 标签（`v1`）都与 CloudSSH 一致，所以：

- 保持 `wrangler.toml` 里 `name` 与你现有 Worker 相同，直接 `pnpm deploy` 即可**原地替换代码**；
- **Durable Objects 数据（已保存的服务器、用户）会保留**，不会丢；
- Dashboard 里已配置的环境变量跨部署保留，无需重配；
- **不要改** DO 类名或 migration 标签，否则可能与既有数据脱钩。

全新部署（换 Worker 名）会得到一套空的 Durable Objects，旧的已存服务器不会迁移——所以除非你想要干净重来，否则用增量更新。

## 本地开发

```bash
pnpm dev        # node scripts/build-html.js && wrangler dev（本地起 Worker + DO）
pnpm test       # vitest：SSH 协议与窗口逻辑单测
```

前端类型检查：`pnpm --filter cloudssh-frontend exec tsc --noEmit`。

## 免费额度

Worker + SQLite 版 Durable Objects 在 Cloudflare 免费计划即可运行。个人自用通常在免费额度内；长时间、多会话的 SSH 连接会消耗 Workers/DO 的调用与时长额度，重度使用需留意官方额度与计费。

## 开源协议

Apache License 2.0，见 [`LICENSE`](./LICENSE)。基于 [newbietan/CloudSSH](https://github.com/newbietan/CloudSSH) 二次开发。
