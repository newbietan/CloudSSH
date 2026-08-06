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
    <a href="README.md">简体中文</a> |
    <a href="README_en.md">English</a>
  </p>
</div>

> [!IMPORTANT]
> 功能演示、架构、安全边界、主题系统与部署流程已统一整理到 **[CloudSSH 项目介绍页](https://newbietan.github.io/CloudSSH/?lang=zh-CN)**。README 仅保留部分信息。

## 快速入口

| 入口         | 地址                                                                             |
| ------------ | -------------------------------------------------------------------------------- |
| 项目介绍主页 | [newbietan.github.io/CloudSSH](https://newbietan.github.io/CloudSSH/?lang=zh-CN) |
| 正式版本演示 | [ssh.newbietan.cn](https://ssh.newbietan.cn)                                     |
| 测试版本演示 | [sshtest.newbietan.cn](https://sshtest.newbietan.cn)                             |
| 在线主题编辑 | [Theme V2 Editor](https://cte.newbietan.cn/theme-editor/)                        |
| B 站演示视频 | [BV1UgMt6UEdF](https://www.bilibili.com/video/BV1UgMt6UEdF)                      |

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

<a id="architecture"></a>

## 架构说明

### 系统架构

```mermaid
flowchart TB
    subgraph "浏览器客户端"
        UI["前端 UI<br/>TypeScript + xterm.js"]
        SFTP["SFTP 文件管理器"]
        Agent["AI 智能助手"]
        Trzsz["trzsz 文件传输"]
    end

    subgraph "Cloudflare Edge Network"
        Worker["Worker<br/>路由 + API"]
        SSH_DO["SSHSessionDO<br/>SSH 会话管理"]
        User_DO["UserDBDO<br/>用户数据管理"]
        AgentCore["AgentCore<br/>AI 控制循环"]
    end

    subgraph "目标服务器"
        SSH["SSH 服务器<br/>(OpenSSH/Dropbear)"]
    end

    UI <-->|"WebSocket<br/>终端 I/O"| Worker
    SFTP <-->|"WebSocket<br/>SFTP 数据"| Worker
    Agent <-->|"WebSocket<br/>Agent 消息"| Worker
    Trzsz <-->|"trzsz 协议"| UI
    Worker <-->|"WebSocket"| SSH_DO
    Worker <-->|"Internal API"| User_DO
    SSH_DO <-->|"TCP Socket<br/>@cloudflare/sockets"| SSH
    SSH_DO <-->|"Exec Channel"| AgentCore
    AgentCore <-->|"LLM API"| External["外部 LLM 服务"]
```

## 安全与隐私提示

- 建议为公开部署启用 Turnstile。
- 首次连接请人工核对服务器 SHA-256 Host Key 指纹；后续若指纹变化，请先排查再接受。
- 保存服务器时会通过第三方 IPinfo 推断目标主机区域，以优化 Durable Object 调度；失败时自动回退到 Cloudflare 默认位置。
- 部署者应自行审查代码、管理密钥，并遵守所在地区及目标服务器的安全要求。

## 参与项目

开发变更统一进入 `test` 分支，通过质量检查后再合入 `main`。

- [更新日志](CHANGELOG.md)
- [贡献者](https://github.com/newbietan/CloudSSH/graphs/contributors)
- [Issue](https://github.com/newbietan/CloudSSH/issues)
- [Apache License 2.0](LICENSE)
