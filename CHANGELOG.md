# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-09

### Added
- **TypeScript 自研 SSH 协议核心**：无需外部原生或 WASM 依赖，基于 Web Crypto API 与 Cloudflare TCP Socket API 实现，支持 Curve25519-SHA256、ECDH-NISTP256 密钥协商及 AES-128-GCM 加密传输。
- **并行 SFTP v3 文件管理器**：在 Durable Objects 状态机中管理文件树，支持拖拽上传/下载、并行任务管理、任务取消以及目录新建/重命名/删除。
- **AI Agent 智能运维助手**：集成兼容 OpenAI/Gemini/DeepSeek 接口端，支持流式渲染和 GFM Markdown 输出；内置 8 大核心运维工具，包含智能安全校验（Blocked Rules + User Confirmations 双层过滤）与自动看门狗保活防冬眠机制。
- **可视化主题编辑器**：实现自定义赛博朋克主题的编辑、云端保存、导入与导出功能。
- **trzsz & zmodem 传输**：支持拖拽上传与 tmux 兼容的大文件流式传输（替代传统 lrzsz）。
- **多标签页与双段延迟显示**：支持多标签页独立终端，状态栏实时显示 RTT 网络延迟与 Cloudflare Colo 节点标识。

### Fixed
- **API 异常与 400 校验**：修复了在消息历史递交、剪裁、取消时因工具消息不配对导致的 API 错误；增加了安全完整性校验过滤。
- **信道泄漏与冬眠卡死**：解决 `Channel removed before open` 及 `Channel open failed (reason=2)` 泄漏竞态，修复 Durable Object 在大模型等待及用户确认弹窗下的假性超时。
- **安全加固**：废弃 URL 凭据传递，改用本地安全加密存储连接记录；实现了主机指纹 TOFU 防篡改验证。
