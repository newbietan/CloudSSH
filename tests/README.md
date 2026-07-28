# CloudSSH 测试套件

本目录包含 CloudSSH 项目的单元测试和集成测试。

## 目录结构

```
tests/
├── build/                  # 构建产物与可复现性回归
├── e2e/                    # 服务器分页、Agent 上下文及 axe 无障碍 E2E
├── worker/                 # Worker、UserDB、Agent 与安全边界测试
├── ssh/                    # SSH 协议相关测试
│   ├── auth.test.ts        # SSH 认证测试
│   ├── utils.test.ts       # SSH 工具函数测试
│   └── integration.test.ts # 集成测试
├── agent-terminal-selection.test.ts # Agent 终端选区上下文与安全边界
├── frontend-ux.test.ts     # 前端关键交互源码回归
├── sftp-selection.test.ts  # SFTP 多选状态模型
├── types.test.ts           # 类型定义测试
└── README.md               # 本文件
```

## 运行测试

### 运行所有测试

```bash
pnpm test
```

### 运行特定测试文件

```bash
pnpm test tests/ssh/auth.test.ts
```

### 运行浏览器 E2E 与无障碍测试

首次运行需安装 Chromium：

```bash
pnpm exec playwright install chromium
pnpm run test:e2e
```

### 运行完整质量门禁

```bash
pnpm run verify
```

### 监听模式

```bash
pnpm test --watch
```

## 测试覆盖范围

### SSH 认证 (`ssh/auth.test.ts`)

- ✅ 密码认证请求构建
- ✅ 认证响应处理（成功/失败）
- ✅ 错误处理

### SSH 工具函数 (`ssh/utils.test.ts`)

- ✅ 数组拼接 (`concat`)
- ✅ uint32 读写 (`readUint32`, `writeUint32`)
- ✅ 字符串编码 (`encodeString`)

### 类型定义 (`types.test.ts`)

- ✅ 终端尺寸验证
- ✅ 边界值测试
- ✅ 类型检查

### 集成测试 (`ssh/integration.test.ts`)

- ✅ OpenSSH 格式验证
- ✅ DER 编码
- ✅ 密钥类型检测
- ✅ 错误处理

### 核心业务与浏览器回归

- ✅ CI 门禁和构建可复现性
- ✅ UserDB 服务器标签迁移、序列化与更新
- ✅ 服务器搜索、标签筛选与分页
- ✅ SFTP 单选、Cmd/Ctrl 多选与 Shift 连选
- ✅ Agent 终端选区附件、用户问题组合与非授权安全边界
- ✅ 登录页、服务器弹窗及 Agent 附件区域的浏览器与无障碍回归
