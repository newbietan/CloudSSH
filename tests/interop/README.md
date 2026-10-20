# SSH 互操作测试

本目录集中管理真实 OpenSSH 测试、独立 Go SSH 测试网关及其工作区配置。
**生产 SSH/SFTP 协议栈仍是 TypeScript；这些 Go 文件不进入 Worker 或浏览器产物。**
常规开发、构建、部署以及默认的 `pnpm test` 不需要安装 Go。

## 目录与文件职责

```text
interop/
├── gateway/
│   ├── go.mod             # 独立测试模块及依赖版本
│   ├── go.sum             # 模块依赖完整性校验
│   └── main.go            # 使用 golang.org/x/crypto/ssh 的测试 SSH 服务端
├── gateway.test.ts        # 编译、启动网关并验证 TypeScript SSHSession
├── go.work                # 测试目录内的 Go 工作区，仅引用 ./gateway
├── go.work.sum            # 工作区层面的额外依赖完整性校验
├── layout.test.ts         # 目录布局与 CI 路径回归，无需启动 Go/OpenSSH
├── README.md
└── sshd.test.ts           # 使用临时配置运行本机 OpenSSH 的互操作测试
```

Go 网关提供与 TypeScript 客户端独立的 SSH 实现，避免只依靠 mock 或同一套协议实现自测。
它覆盖 none/password/OTP、公钥后 password、错误响应和 session/exec 通道。
OpenSSH 测试另行覆盖裸主机密钥、证书、PTY/Shell、exec 和 SFTP。

## 运行方式

仅显式运行进程级互操作测试时，需要 macOS/Linux、OpenSSH `sshd`/`ssh-keygen` 和 Go ≥1.24。
在项目根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run test:interop
```

该命令同时启用 OpenSSH 和 Go 网关测试；缺少依赖或服务启动失败应按失败处理。
默认 `pnpm test` 仍执行目录布局回归，但跳过启动这两个服务的用例；`pnpm run verify` 不启用进程级互操作测试。
仅验证目录布局可以执行：

```sh
pnpm exec vitest run tests/interop/layout.test.ts
```

Go 测试在 `gateway/` 目录执行只读依赖构建，自动发现上级 `tests/interop/go.work`，
二进制输出至系统临时目录并在测试结束后清理。无需在项目根目录放置 `go.work` 或设置全局 `GOWORK`。
编辑器如需独立索引 Go，可打开 `tests/interop/` 作为工作区；手工运行 Go 命令时也应进入本目录或 `gateway/`。
`go.mod` / `go.sum` 与 `go.work.sum` 是依赖元数据，不是可随意删除的编译产物。

## 安全与部署边界

- 两个测试服务仅监听 `127.0.0.1` 随机端口，公开测试密钥不得用于真实服务器。
- Go 网关只返回固定测试内容，不执行客户端提交的宿主机命令。
- OpenSSH 使用当前系统账号、临时配置与授权文件，不修改系统 SSH 配置、密码或 `~/.ssh/authorized_keys`。
  其真实 Shell 可能读取当前账号的启动配置，建议在隔离 CI 或测试账号中运行。
- 独立 CI 位于 `.github/workflows/ssh-interop.yml`，在 Ubuntu/macOS 上运行，不使用生产 secrets，也不部署 Worker。
- 项目级 Biome、TypeScript、Vitest、Playwright 和 Wrangler 配置仍保留在项目根目录供工具自动发现。

完整兼容范围与限制见 [SSH 兼容说明](../../docs/ssh-compatibility.md)。
