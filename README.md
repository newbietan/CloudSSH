<div align="center">
  <img src="./logo.svg" alt="CloudSSH" width="480">
  <p>基于 Cloudflare Workers 的 Serverless Web SSH 终端。</p>
  <p>
    <a href="https://github.com/newbietan/CloudSSH/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/newbietan/CloudSSH?style=flat&logo=github"></a>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache%202.0-blue.svg"></a>
    <img alt="Cloudflare" src="https://img.shields.io/badge/Cloudflare-F38020?style=flat&logo=cloudflare&logoColor=white">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white">
  </p>
  <p>
    <a href="README.md">简体中文</a> |
    <a href="README_en.md">English</a>
  </p>
</div>

> [!IMPORTANT]
> 功能演示、架构、安全边界、主题系统与部署流程已统一整理到 **[CloudSSH 项目介绍页](https://newbietan.github.io/CloudSSH/?lang=zh-CN)**。README 仅保留使用和开发所需的信息。

## 快速入口

| 入口 | 地址 |
| --- | --- |
| 项目介绍 | [newbietan.github.io/CloudSSH](https://newbietan.github.io/CloudSSH/?lang=zh-CN) |
| 正式演示 | [ssh.newbietan.cn](https://ssh.newbietan.cn) |
| 测试演示 | [sshtest.newbietan.cn](https://sshtest.newbietan.cn) |
| 在线主题编辑器 | [Theme V2 Editor](https://cte.newbietan.cn/theme-editor/) |
| B 站演示视频 | [BV1UgMt6UEdF](https://www.bilibili.com/video/BV1UgMt6UEdF) |

## 项目简介

CloudSSH 在浏览器与目标服务器之间建立两段加密连接：浏览器通过 HTTPS/WSS 连接 Cloudflare，Worker 再通过原生 TCP Socket 建立完整 SSH-2.0 会话。每个活动会话由独立 Durable Object 管理，无需维护传统 VPS 中转服务。

核心能力包括：

- 纯 TypeScript SSH-2.0 协议栈，支持密码与 Ed25519、ECDSA、RSA 私钥认证。
- xterm.js 多标签终端、实时延迟、日志检索/导出和桌面/移动端适配。
- SFTP v3 图形化文件管理、批量操作、传输队列，以及 trzsz 文件传输。
- GitHub OAuth、已保存服务器、标签筛选、主机指纹 TOFU 校验与凭据加密存储。
- BYOK AI 运维助手、终端上下文、8 个工具和危险命令确认/拦截。
- Theme V2 内置主题、自定义 JSON 导入与登录账号同步。

更完整、图形化的介绍请查看[项目介绍页](https://newbietan.github.io/CloudSSH/?lang=zh-CN)，实现目录和维护约束见 [AGENTS.md](AGENTS.md)。

<a id="quick-start"></a>

## 快速部署

### Cloudflare Git 集成（推荐）

1. Fork 本仓库。
2. 在 Cloudflare Dashboard 的 Workers & Pages 中创建 Worker，并连接 Fork 后的仓库。
3. 将构建命令设置为 `pnpm run build:frontend`，生产分支设置为 `main`。
4. 部署完成后使用 `workers.dev` 域名，或在 Settings → Domains & Routes 中绑定自定义域名。

仓库内置的 Durable Object migration 会初始化 `SSHSessionDO` 与 `UserDBDO`。已有环境升级时不要删除 Worker；新增 Durable Object 类或迁移必须使用新的 migration tag。

### Wrangler CLI

需要 Node.js、pnpm 和 Cloudflare 账号：

```bash
git clone https://github.com/newbietan/CloudSSH.git
cd CloudSSH
corepack enable
pnpm install --frozen-lockfile
npx wrangler login
pnpm run deploy
```

测试环境使用独立 Worker 和 Durable Object 数据：

```bash
pnpm run deploy:test
```

### 可选配置

在 Cloudflare Dashboard → Worker → Settings → Variables and Secrets 中按需添加：

| 变量 | 用途 |
| --- | --- |
| `TURNSTILE_SECRET` / `TURNSTILE_SITEKEY` | 启用 Turnstile 人机验证 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 启用 GitHub OAuth 与服务器保存功能 |
| `BASE_URL` | OAuth 回调站点根地址，如 `https://ssh.example.com` |

GitHub OAuth App 的回调地址应设置为 `<BASE_URL>/api/auth/callback`。密钥建议全部使用 Secret 类型保存；未配置这些变量时，匿名 SSH 连接仍可使用。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

常用质量检查：

```bash
pnpm run typecheck
pnpm test
pnpm run test:e2e
pnpm run verify
```

前端生产构建会将 Vite 产物内联到 `src/worker/html.ts`。该文件由 `scripts/build-html.js` 自动生成，请勿直接编辑。

Pages 主页位于 `docs/index.html`，主题编辑器位于 `docs/theme-editor/`。修改 Theme V2 预设或主页社交预览图后运行：

```bash
pnpm run sync:theme-editor
pnpm run build:pages-og
```

## 安全与隐私提示

- 建议为公开部署启用 Turnstile，并限制 Cloudflare 账号和 GitHub OAuth App 的访问权限。
- 首次连接请人工核对服务器 SHA-256 Host Key 指纹；后续若指纹变化，请先排查再接受。
- 保存服务器时会通过第三方 IPinfo 推断目标主机区域，以优化 Durable Object 调度；失败时自动回退到 Cloudflare 默认位置。
- 部署者应自行审查代码、管理密钥，并遵守所在地区及目标服务器的安全要求。

## 参与项目

开发变更统一进入 `test` 分支，通过质量检查后再合入 `main`。提交信息使用 Conventional Commits，并以中文描述，例如 `fix: 修复移动端输入问题`。

- [更新日志](CHANGELOG.md)
- [贡献者](https://github.com/newbietan/CloudSSH/graphs/contributors)
- [Issue](https://github.com/newbietan/CloudSSH/issues)
- [Apache License 2.0](LICENSE)
