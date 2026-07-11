# CloudSSH 测试套件

本目录包含 CloudSSH 项目的单元测试和集成测试。

## 目录结构

```
tests/
├── ssh/                    # SSH 协议相关测试
│   ├── auth.test.ts        # SSH 认证测试
│   ├── utils.test.ts       # SSH 工具函数测试
│   └── integration.test.ts # 集成测试
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
