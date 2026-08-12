# CloudSSH 测试套件

本目录包含 CloudSSH 的单元测试、协议集成测试、构建回归和浏览器 E2E。测试框架以 Vitest 和 Playwright 为主。

## 目录结构

```text
tests/
├── build/                         # 生产构建、可复现性和原生弹窗回归
├── e2e/                           # Chromium 浏览器交互与 axe 无障碍检查
├── ssh/                           # SSH 算法、认证、加密、KEX、Packet 与测试密钥夹具
├── worker/                        # Worker 路由、安全、DNS、UserDB 与标签测试
├── agent-code-actions.test.ts     # Agent 代码块复制/填入规则
├── agent-terminal-selection.test.ts # 终端选区附件和非授权安全边界
├── clipboard.test.ts              # Clipboard API 与旧版复制回退
├── frontend-ux.test.ts            # 前端关键交互源码回归
├── i18n.test.ts                   # 中英文词条和语言解析
├── sftp-selection.test.ts         # SFTP 单选、多选、连选和全选模型
├── terminal-status.test.ts        # SSH 状态事件翻译
├── terminal-text.test.ts          # 终端文本处理
├── theme.test.ts                  # 内置/自定义主题
├── types.test.ts                  # 共享类型和终端尺寸边界
└── README.md
```

`tests/ssh/fixtures/` 中的私钥只用于公开的协议测试，不得用于生产服务器或真实账号。

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

# 安装并运行 Chromium E2E 与 axe 无障碍检查
pnpm exec playwright install chromium
pnpm run test:e2e

# 类型检查、测试、可复现构建和 E2E 完整门禁
pnpm run verify
```

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
- UserDB 服务器标签迁移、规范化、序列化和更新

### 前端与构建

- 服务器搜索、标签筛选和每页 9 项分页
- SFTP 单选、Cmd/Ctrl 多选、Shift 连选和全选
- Agent 终端选区附件、问题组合和非授权安全边界
- 终端选区自动复制、指针取消和旧版复制回退
- i18n、主题、终端状态和文本处理
- 构建可复现性、xterm 生产构建兼容和原生弹窗禁用

### 浏览器 E2E

- 匿名连接表单 axe 检查
- 服务器弹窗的基本对话框语义、初始焦点和 Escape 关闭
- 服务器标签筛选与分页
- Agent 终端选区附件
- 终端选区复制与焦点恢复

## 当前限制

- Playwright 的完整界面与无障碍回归主要运行 Chromium；认证挑战、iOS 输入法和移动端后台连接恢复另在 WebKit 设备项目中执行。Firefox 尚未纳入当前质量门禁。
- 浏览器 E2E 主要通过 mock API 验证前端行为，尚未连接真实 OpenSSH/Dropbear 和 SFTP 服务。
- SSHSessionDO、SSH 会话状态机、SFTP 数据流和 AgentCore 等运行态模块的覆盖率仍偏低。
- 新增协议状态、WebSocket 消息或安全边界时，应优先补充运行时错误、取消、超时和畸形输入测试，而不仅验证成功路径。
