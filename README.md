<div align="center">
  <img src="./logo.svg" alt="CloudSSH" width="480">
  <p>一个基于 Cloudflare Workers 的 Serverless Web SSH 终端：通过浏览器直接连接和管理你的服务器。</p>
  <p><b>极致轻量 · 开箱即用 · 赛博朋克 UI</b></p>
  <p>
    <a href="https://github.com/newbietan/CloudSSH/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/newbietan/CloudSSH?style=flat&logo=github"></a>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache%202.0-blue.svg"></a>
    <img alt="Cloudflare" src="https://img.shields.io/badge/Cloudflare-F38020?style=flat&logo=cloudflare&logoColor=white">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white">
    <img alt="Vite" src="https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white">
  </p>
  <p>
    <a href="#highlights">核心优势</a> ·
    <a href="#features">功能特性</a> ·
    <a href="#quick-start">部署指南</a> ·
    <a href="#architecture">架构设计</a> ·
    <a href="#license">开源协议</a>
  </p>
  <p>
    <a href="README.md">简体中文</a> |
    <a href="README_en.md">English</a>
  </p>
</div>

> [!TIP]
> **CloudSSH** 利用 Cloudflare Workers 的 TCP Sockets 支持，在边缘节点实现 SSH 协议的解析与转发，提供低延迟的 Web 终端体验。

## 效果演示

> 想象一下，随时随地打开浏览器，就能以极具科技感的赛博朋克 UI 连接你的服务器，无需安装任何 SSH 客户端。

![Demo 1](./demo1.png)
![Demo 2](./demo2.png)
![Demo 3](./demo3.png)

## 目录

- [核心优势](#highlights)
- [核心特性](#features)
- [架构说明](#architecture)
- [快速部署](#quick-start)
  - [GitHub 绑定自动部署](#方式一通过-github-绑定自动部署推荐)
  - [本地命令行部署](#方式二本地命令行部署)
  - [配置 Turnstile](#可选配置-turnstile-人机验证)
  - [配置 GitHub OAuth](#可选配置-github-oauth-登录与服务器管理)
- [开发说明](#development)
  - [本地开发](#本地开发)
  - [技术栈](#技术栈)
- [开源协议](#license)

<a id="highlights"></a>
## 核心优势

### 极致 Serverless

- **零服务器成本**：纯前端部署 + Cloudflare Workers，无需自建后端服务器。
- **边缘加速**：得益于 Cloudflare 的全球边缘网络，随时随地享受低延迟的 SSH 连接。

### 开箱即用

- **一键部署**：通过 Wrangler 工具，一句命令即可完成项目构建与部署。
- **现代化前端技术栈**：TypeScript + Vite + Tailwind CSS，配合 xterm.js 提供丝滑的终端体验。

### 安全可靠

- **端到端加密**：完整的 SSH-2.0 协议实现，支持 Curve25519-SHA256（优先）和 ECDH-NISTP256 密钥交换，AES-256-GCM（优先）/ AES-128-GCM / AES-256-CTR 数据加密，以及 HMAC-SHA2-256/512 完整性校验。
- **多算法主机密钥验证**：支持 Ed25519、ECDSA P-256、RSA 签名验证，首次连接展示 SHA-256 指纹（TOFU 模式）。
- **安全加固体系**：内置针对 IPv6 与保留地址的 SSRF 防护、API 请求频率限制（防爆破），并在本地使用 AES-256-GCM 算法加密存储您的服务器凭证。
- **人机验证**：支持 Cloudflare Turnstile 验证，防止恶意机器人滥用。
- **隔离的会话状态**：借助 Cloudflare Durable Objects 和 Hibernation API，每个终端会话都在沙盒内安全、持久地运行。
- **凭据零暴露**：One-Time-Token 机制确保密码/私钥不经过前端，完全在 Worker 内部安全流转。

<a id="features"></a>
## 核心特性

- **纯 TypeScript SSH-2.0 实现**：完全自研的 SSH 协议栈，不依赖任何第三方 SSH 库，基于 Web Crypto API 实现全部加密操作。
- **多算法密钥交换**：支持 Curve25519-SHA256（优先）和 ECDH-NISTP256 两种 KEX 算法，适配各类 SSH 服务器（包括 Dropbear）。
- **IPv4/IPv6 双栈**：完整支持 IPv4 和 IPv6 地址连接，包括 IPv6 方括号格式自动处理。
- **多种认证方式**：支持标准 SSH 密码认证以及基于 Ed25519 的纯文本私钥认证。
- **防范中间人攻击 (TOFU)**：首次连接自动提取服务器 Host Key（SHA-256 指纹）并显示，支持 Ed25519/ECDSA/RSA 签名验证，并在本地及 API 持久化缓存已知主机指纹以防范二次连接的欺骗风险。
- **全功能极客终端**：基于 `@xterm/xterm` 与 `@xterm/addon-webgl` 硬件加速渲染引擎，保证海量日志输出顺滑不卡顿。
- **个性化 UI**：全站颜色基于 CSS 变量系统，提供 Cyberpunk、Glacier、Gruvbox 内置主题一键切换。支持导入自定义 JSON 主题文件（登录用户自动云端同步，跨浏览器生效），配套[可视化主题编辑器](https://newbietan.github.io/CloudSSH/)可在线调色并导出。支持移动端适配。
- **SFTP 图形化文件管理**：集成完整的 SFTP v3 文件传输协议，提供图形化文件浏览器界面。支持目录浏览、文件上传/下载、新建文件夹、文件重命名与删除等操作。基于 SSH 子系统实现，与终端会话并行运行，互不干扰，支持并发下载及上传取消。
- **原生文件传输**：集成 [trzsz.js](https://github.com/trzsz/trzsz.js)，支持 `trz`（上传）/ `tsz`（下载）命令进行文件传输，兼容 tmux 会话。还支持拖拽文件到终端窗口直接上传、目录传输及断点续传等高级功能。（需远程服务器安装 [trzsz](https://trzsz.github.io/)）
- **GitHub OAuth 集成**：支持 GitHub 登录，用户可保存和管理常用 SSH 服务器，实现一键连接。
- **单页面多标签会话管理**：支持在单个页面内开启与切换多个独立的 SSH 终端与 SFTP 文件管理器，各会话环境和状态完全隔离，并在个性化主题编辑器中进行了联动适配。
- **安全匿名历史记录**：本地存储最近 5 条匿名连接，且敏感凭证可选使用本地派生的密钥进行 AES-256-GCM 安全加密存储至 `localStorage`，提供一键回填与清除。
- **双段延迟与 Colo 展示**：状态栏即时且周期性地展示当前 RTT（客户端至 Cloudflare）、物理延迟（Cloudflare 至主机）以及 Cloudflare 当前服务的数据中心代码（如 `CF-LAX`）。
- **终端文本检索**：支持使用快捷键 `Ctrl+Shift+F` 呼出搜索框，实时检索终端历史日志。
- **终端日志一键导出**：支持通过顶栏的下载按钮，将当前活跃会话终端的完整屏幕历史 buffer 一键导出并下载为 `.txt` 文本文件，解决长日志在浏览器下鼠标选取容易卡顿的痛点。

<a id="architecture"></a>
## 架构说明

### 系统架构

```mermaid
flowchart TB
    subgraph "浏览器客户端"
        UI["前端 UI<br/>TypeScript + xterm.js"]
        SFTP["SFTP 文件管理器"]
        Trzsz["trzsz 文件传输"]
    end
    
    subgraph "Cloudflare Edge Network"
        Worker["Worker<br/>路由 + API"]
        SSH_DO["SSHSessionDO<br/>SSH 会话管理"]
        User_DO["UserDBDO<br/>用户数据管理"]
    end
    
    subgraph "目标服务器"
        SSH["SSH 服务器<br/>(OpenSSH/Dropbear)"]
    end

    UI <-->|"WebSocket<br/>终端 I/O"| Worker
    SFTP <-->|"WebSocket<br/>SFTP 数据"| Worker
    Trzsz <-->|"trzsz 协议"| UI
    Worker <-->|"WebSocket"| SSH_DO
    Worker <-->|"Internal API"| User_DO
    SSH_DO <-->|"TCP Socket<br/>@cloudflare/sockets"| SSH
```

### 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| **Worker 入口** | `src/worker/index.ts` | HTTP 路由、API 处理、WebSocket 升级 |
| **SSHSessionDO** | `src/worker/durable-object.ts` | SSH 会话生命周期管理、SSRF 防护 |
| **UserDBDO** | `src/worker/user-db.ts` | 用户数据、服务器配置、速率限制（SQLite） |
| **SSHSession** | `src/worker/ssh-session.ts` | SSH 协议状态机（连接→版本→密钥交换→认证→交互） |
| **SSH 协议栈** | `src/ssh/*.ts` | 纯 TypeScript SSH-2.0 实现（传输层、加密、认证、通道） |
| **SFTP 处理器** | `src/worker/sftp-handler.ts` | SFTP 协议操作、任务队列、并发下载、上传跟踪与取消支持 |
| **SFTP 协议实现** | `src/ssh/sftp.ts` / `sftp-types.ts` | SFTP v3 协议客户端、包解析与类型定义 |
| **前端终端** | `frontend/src/terminal.ts` | xterm.js 封装、实时双段延迟心跳、终端搜索及 WebSocket 交互 |
| **标签管理器** | `frontend/src/tab-manager.ts` | 单页面多会话标签页管理器，协调不同标签页内的终端与 SFTP 实例 |
| **SFTP 面板** | `frontend/src/sftp-panel.ts` | 图形化文件管理器 UI，支持上传/下载队列和取消操作 |

### SSH 协议实现

本项目实现了完整的 SSH-2.0 协议栈：

| 层级 | 实现 | 支持算法 |
|------|------|----------|
| **密钥交换** | `kex-curve25519.ts` / `kex-ecdh.ts` | curve25519-sha256, ecdh-sha2-nistp256 |
| **数据加密** | `crypto.ts` | aes256-gcm, aes128-gcm, aes256-ctr, aes192-ctr, aes128-ctr |
| **完整性校验** | `crypto.ts` | hmac-sha2-256, hmac-sha2-512, hmac-sha1 |
| **主机密钥** | `ssh-session.ts` | Ed25519, ECDSA P-256, RSA |
| **用户认证** | `auth.ts` | 密码认证, Ed25519 公钥认证 |
| **通道管理** | `channel.ts` | session channel, SFTP subsystem, PTY, shell, window-change |
| **SFTP 协议** | `sftp.ts` / `sftp-types.ts` | SFTP v3 文件传输协议（目录浏览、上传、下载、删除、重命名） |

### 数据流

1. 用户在前端输入主机 IP、账号和密码（或通过 GitHub OAuth 选择已保存的服务器）。
2. 前端与后端的 Durable Object 建立 WebSocket 连接。
3. SSHSessionDO 接收凭据，使用 `@cloudflare/sockets` 与目标 SSH 服务器建立 TCP 连接。
4. SSHSession 执行完整的 SSH 协议协商（版本交换→密钥交换→认证→打开通道→PTY→Shell）。
5. 加密的终端数据通过 WebSocket 在前端和 SSH 服务器之间双向转发。
6. SFTP 文件管理通过独立的 SSH 子系统通道运行，支持目录浏览、文件上传/下载等操作。

<a id="quick-start"></a>
## 快速部署

### 前置要求

- 一个 Cloudflare 账号。
- Node.js 环境 (v18+)。
- 启用 Cloudflare Workers 免费计划（TCP Sockets 和 Durable Objects 功能需要）。

### 部署步骤

#### 方式一：通过 GitHub 绑定自动部署（推荐）

1. **Fork 本仓库** 到你的 GitHub 账号。
2. **创建 Worker 应用**：登录 Cloudflare，进入 Workers & Pages，点击创建应用，绑定你的 GitHub 账号，选择 Fork 的仓库。
3. **填写构建命令**：在部署设置中，将"构建命令"（Build command）填写为 `pnpm run build:frontend`，点击保存并部署。
4. **访问应用**：部署成功后，可通过默认域名 `https://cloudssh.<你的子域>.workers.dev` 访问。
5. **绑定自定义域名**（可选）：进入 Worker 的 Settings → Domains & Routes → Add，输入你的域名并确认。

> **说明**：如需部署 test 环境，可 Fork 后在 `test` 分支上重复上述步骤，创建独立的 Worker（如 `cloudssh-test`）。两个环境的 Durable Objects 数据完全隔离，各自独立。

#### 方式二：本地命令行部署

1. **克隆仓库**
   ```bash
   git clone https://github.com/newbietan/CloudSSH.git
   cd CloudSSH
   ```

2. **安装依赖**
   ```bash
   npm install -g pnpm
   pnpm install
   cd frontend && pnpm install
   ```

3. **登录 Cloudflare**
   ```bash
   npx wrangler login
   ```

4. **部署生产环境**
   ```bash
   pnpm run deploy
   ```

5. **部署测试环境**（可选）
   ```bash
   pnpm run deploy:test
   ```

| 环境 | 命令 | 默认域名 | 说明 |
|------|------|---------|------|
| Production | `pnpm run deploy` | `cloudssh.<子域>.workers.dev` | main 分支代码 |
| Test | `pnpm run deploy:test` | `cloudssh-test.<子域>.workers.dev` | test 分支代码，与生产环境 DO 数据隔离 |

> **说明**：两个环境的 Durable Objects 虽然绑定相同的 class_name，但因 Worker 名称不同，数据完全隔离。部署完成后可在 Cloudflare Dashboard 中分别绑定不同的自定义域名（Settings → Domains & Routes）。

#### 可选：配置 Turnstile 人机验证

为防止恶意机器人滥用，建议启用 Cloudflare Turnstile 验证：

1. **创建 Turnstile Widget**：登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 Turnstile 页面创建一个新的 Widget。
2. **获取密钥**：创建后会获得一个 **Site Key**（公开）和一个 **Secret Key**（保密）。
3. **配置环境变量**：在 Cloudflare Dashboard 的 Workers 设置中，进入 "Settings" → "Variables and Secrets"，添加以下环境变量：
   - `TURNSTILE_SECRET` = 你的 Secret Key
   - `TURNSTILE_SITEKEY` = 你的 Site Key
4. **重新部署**：运行部署命令使配置生效。

> **环境变量类型建议**：建议将所有环境变量都设置为 **Secret** 类型。Secrets 存储在 Cloudflare 加密存储中，与代码部署分离，重新部署时不会被覆盖或丢失。在 Dashboard 添加变量时，选择 "Secret" 类型即可。

> **说明**：Turnstile 验证为会话级别，用户通过验证后当前会话内所有功能可用，关闭浏览器后需重新验证。

#### 可选：配置 GitHub OAuth 登录与服务器管理

启用 GitHub 登录后，用户可以通过 GitHub 账号登录，并在个人空间中保存和管理常用的 SSH 服务器，实现一键连接。不配置时，此功能自动隐藏，不影响匿名 SSH 连接的正常使用。

1. **创建 GitHub OAuth App**：
   - 登录 GitHub → Settings → Developer settings → OAuth Apps → [New OAuth App](https://github.com/settings/applications/new)
   - **Application name**：`CloudSSH`（自定义）
   - **Homepage URL**：`https://your-domain.com`（你的部署域名）
   - **Authorization callback URL**：`https://your-domain.com/api/auth/callback`
   - 创建后获得 **Client ID**，点击 **Generate a new client secret** 生成 **Client Secret**（仅显示一次，请立即保存）

2. **配置环境变量**：在 Cloudflare Dashboard 的 Workers 设置中，进入 "Settings" → "Variables and Secrets"，添加以下环境变量：
   - `GITHUB_CLIENT_ID` = 你的 Client ID
   - `BASE_URL` = `https://your-domain.com`（你的部署域名）
   - `GITHUB_CLIENT_SECRET` = 你的 Client Secret

3. **重新部署**：如果你是刚刚修改了环境变量，且是首次启用该功能，请务必删除旧版并全新部署以初始化数据库。

> **环境变量类型建议**：建议将所有环境变量都设置为 **Secret** 类型。Secrets 存储在 Cloudflare 加密存储中，与代码部署分离，重新部署时不会被覆盖或丢失。在 Dashboard 添加变量时，选择 "Secret" 类型即可。

> **说明**：服务器凭据（密码/私钥）在数据库中使用 AES-256-GCM 加密存储，加密密钥在首次使用时自动生成并安全地存储在数据库中。连接时凭据不经过前端，通过 one-time-token 机制安全传递。

> **注意**：首次启用此功能需要从零部署（删除旧 Worker 后重新部署），因为需要初始化新的 Durable Object。可通过 `npx wrangler delete cloudssh` 删除旧 Worker，然后运行 `pnpm run deploy` 重新部署。

<a id="development"></a>
## 开发说明

### 项目结构

本项目采用 pnpm monorepo 工作区结构：

```
CloudSSH/
├── src/                    # 后端源码 (Cloudflare Worker)
│   ├── ssh/                # SSH 协议纯实现层
│   └── worker/             # Worker 入口和 Durable Objects
├── frontend/               # 前端源码 (独立 workspace)
│   └── src/                # TypeScript + xterm.js + trzsz
├── docs/                   # GitHub Pages 静态资源
│   └── theme-editor/       # 可视化主题编辑器
├── scripts/                # 构建脚本
├── pnpm-workspace.yaml     # pnpm 工作区配置
└── wrangler.toml           # Cloudflare 部署配置
```

### 本地开发

#### 环境准备

1. **Fork 并克隆仓库**
   ```bash
   git clone https://github.com/<你的用户名>/CloudSSH.git
   cd CloudSSH
   ```

2. **安装依赖**（需分别安装根目录和前端依赖）
   ```bash
   pnpm install
   cd frontend && pnpm install
   ```

3. **登录 Cloudflare**（首次需要，后续会缓存凭据）
   ```bash
   npx wrangler login
   ```
   > **说明**：本地开发使用 Wrangler Dev 时，会连接到你的 Cloudflare 账号以使用 Durable Objects 和 TCP Sockets。SSH 连接的真实 TCP 流量会通过 Cloudflare 的基础设施转发。

4. **配置 GitHub Actions**（可选，如需自动部署）
   
   如果你希望通过 GitHub Actions 自动部署到自己的 Cloudflare 账号，需要修改 `.github/workflows/deploy.yml` 中的仓库所有者名称：
   ```yaml
   if: github.repository_owner == '你的GitHub用户名'
   ```
   同时在仓库的 Settings → Secrets and variables → Actions 中配置以下 Secrets：
   - `CLOUDFLARE_API_TOKEN`：Cloudflare API Token
   - `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账号 ID

#### 启动开发服务器

```bash
pnpm run dev
```

此命令将构建前端并启动 Wrangler 本地开发环境，支持：
- 前端代码变更自动重新构建
- Worker 代码变更自动重新加载
- 完整的 Durable Objects 和 TCP Sockets 功能

开发服务器启动后，访问终端输出的本地地址（通常为 `http://localhost:8787`）即可进行调试。

#### 常用开发命令

| 命令 | 说明 |
|------|------|
| `pnpm run dev` | 构建前端 + 启动 Wrangler 开发服务器 |
| `pnpm run build:frontend` | 仅构建前端（输出到 `frontend/dist/`） |
| `pnpm test` | 运行测试 |

#### 提交变更的流程

**禁止创建特性分支（feature branch）。** 所有变更必须直接提交到 `test` 分支，保持仓库分支结构整洁。

```
test 分支（开发/测试）  ──合并──>  main 分支（生产）
```

1. 切换到 `test` 分支：`git checkout test`
2. 拉取最新代码：`git pull origin test`
3. 进行开发并本地测试
4. 直接提交并推送：`git push origin test`
5. 测试通过后，维护者会将 `test` 分支合并到 `main` 分支

> **说明**：`main` 分支设置了保护规则，禁止直接推送。所有变更必须先提交到 `test` 分支进行测试。请勿创建 `feat/xxx`、`fix/xxx` 等特性分支，直接在 `test` 分支上提交即可。

### 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| **前端** | TypeScript + Vite + xterm.js | Web 终端模拟器，WebGL 硬件加速 |
| **UI 框架** | Tailwind CSS (CDN) + CSS 变量主题系统 | 可切换内置主题，支持自定义 JSON 主题导入与云端同步 |
| **文件传输** | trzsz.js | 支持 trz/tsz 命令、拖拽上传、断点续传 |
| **后端** | Cloudflare Workers | Serverless 边缘计算 |
| **会话管理** | Durable Objects | SSH 会话隔离、Hibernation API |
| **数据存储** | Durable Objects SQLite | 用户数据、服务器配置 |
| **包管理** | pnpm (workspace) | Monorepo 依赖管理 |

<a id="license"></a>
## 开源协议

本项目基于 [Apache License 2.0](LICENSE) 协议开源。

**特别声明**：本项目允许商业使用及二次修改，但必须明确注明原作者。

欢迎提交 Issue 和 Pull Request 共建社区。如果这个项目对你有帮助，恳求大家给本项目点个 ⭐ Star 支持一下，非常感谢！

## Star History

<a href="https://www.star-history.com/?type=date&repos=newbietan%2FCloudSSH">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=newbietan/CloudSSH&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=newbietan/CloudSSH&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=newbietan/CloudSSH&type=date&legend=top-left" />
 </picture>
</a>
