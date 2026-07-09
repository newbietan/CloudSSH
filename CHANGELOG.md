# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
