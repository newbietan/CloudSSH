# SSH 兼容范围与互操作验证

本说明对应源码中的兼容增强，不代表尚未部署该源码的实例已具备这些能力。
生产协议栈仍是 Cloudflare Worker/Durable Object 内的纯 TypeScript；Go 仅用于独立测试网关。

## 主机密钥与证书

- 裸主机密钥：Ed25519、RSA、ECDSA P-256/P-384/P-521。
- OpenSSH 主机证书：Ed25519、ECDSA 三种 NIST 曲线、RSA-SHA2-256/512。
  RSA 的协商名称为 `rsa-sha2-256-cert-v01@openssh.com` /
  `rsa-sha2-512-cert-v01@openssh.com`，实际证书载体是 `ssh-rsa-cert-v01@openssh.com`。
  不提供 SHA-1 的 RSA 证书协商名称，也不接受 SHA-1 CA 签名。
- 证书签名、主机类型、有效期和关键限制均检查；总大小不超过 64KiB，嵌套字段和条目有界。
- 这是**底层公钥 TOFU**，不是可信 CA 授权。证书内的 CA 公钥不自动获得信任，principals
  仅做结构检查，不作为已获 CA 授权的主机名。尚无 CA 信任库、KRL 或用户证书登录。
- 首次及重协商均绑定主机密钥/签名算法；同一底层公钥续签保持指纹稳定，真正换钥仍需明确确认。
  rekey 换钥直接终止，分享会话不能替换指纹。关闭严格校验不能绕过证书校验。

## 用户认证与 MFA

现有 password、publickey、none、keyboard-interactive 保持原语义。新增的组合为：

1. 用户选择私钥认证，服务器验证公钥；
2. 只有服务器明确返回 `partial_success=true` 并继续提供 password，才弹出第二因素密码框；
3. 用户明确输入后，发送 RFC 4252 password 请求，而不是 RFC 4256 的 INFO_RESPONSE。

第二因素沿用随机挑战 ID、当前会话绑定、显示 ACK、响应超时、取消和清理逻辑；
不代填原配置密码、不保存响应，也不在普通公钥拒绝后擅自回退为密码。
分享会话和禁止交互的中间跳板不弹该提示；本轮没有实现任意多因素组合或中间跳板的交互转发。
公钥加 OTP 继续使用原有 keyboard-interactive 流程。

## 带口令私钥导入

私钥口令仅用于浏览器内解密，不发送到 Worker，不保存到 localStorage、服务器配置或日志。
**解锁后的私钥仍会进入 Worker 用于 SSH 签名**，并非私钥永不离开浏览器。
JavaScript 字符串无法保证内存零化；临时字节缓冲会尽量清理，口令框在提交/取消时清空。

支持的加密封装：

| 封装 | 算法 |
| --- | --- |
| OpenSSH `OPENSSH PRIVATE KEY` | bcrypt PBKDF + AES-128/192/256-CTR |
| PKCS#8 `ENCRYPTED PRIVATE KEY` | PBES2 + PBKDF2（HMAC-SHA1/256/384/512）+ AES-128/192/256-CBC |

不支持传统 `Proc-Type: 4,ENCRYPTED` PEM、OpenSSH CBC/AEAD、scrypt PKCS#8 或 PuTTY PPK。
不支持的封装不会静默降低加密强度。浏览器预算：解码前最多 128KiB 文本、解码后最多 64KiB，
口令最多 1024 个 UTF-8 字节、bcrypt 1–64 轮、PBKDF2 1–1,000,000 次，盐为 8–64 字节，
DER 深度最多 12、节点最多 128。超限明确拒绝；bcrypt 在主线程有界运行，低性能设备可能短暂卡顿。

- 匿名连接：解锁材料只用于当前标签页连接/内存重连，自动关闭凭据记忆；历史仍可能保留主机和用户名。
- 保存服务器：另行明确同意后，才把解锁私钥按既有凭据方案加密保存；私钥口令始终不保存。
  既有加密根密钥与数据同存 UserDBDO，不是独立 KMS，不能抵御整库或 Worker 执行权限失陷。
  取消解锁或关闭/切换服务器编辑器后，迟到的解锁结果不会提交至其他服务器。
- 公共加密测试夹具的口令为 `cloudssh-fixture-passphrase`，仅供公开协议测试，绝不可用于真实账户。

解密使用的 `bcrypt-pbkdf` 许可与归属见 [许可证](./licenses/bcrypt-pbkdf.txt)。

## 真实互操作测试

在 macOS/Linux 安装 OpenSSH `sshd`/`ssh-keygen` 和 Go ≥1.24，然后执行：

```sh
pnpm install --frozen-lockfile
pnpm run test:interop
```

`CLOUDSSH_SSHD_BINARY` 可显式指定本机 sshd 路径。普通 `pnpm test` 不启动本机 SSH 服务，
互操作用例默认跳过；`test:interop` 显式启用后，依赖缺失或启动失败会报错，不能算作通过。

- OpenSSH：临时配置、临时授权文件和测试密钥，仅监听 `127.0.0.1` 随机端口。
  不修改系统 sshd、用户密码或 `~/.ssh/authorized_keys`。使用当前 OS 账户，仅执行固定 `printf`
  并读取临时目录的 SFTP 属性；覆盖七种裸钥/证书协商、PTY/Shell、真实 exec 和 internal-sftp。
  真实 Shell 可能读取该账号的启动配置，建议在隔离 CI/测试账号中运行，不要把这些公开测试密钥部署到真实服务。
- Go 网关：测试模块锁定独立 `golang.org/x/crypto/ssh` 实现，只监听 loopback。
  覆盖 none、password、OTP、公钥后 password、错误响应及 session/exec 通道；不执行宿主机命令。
  Go 工作区统一位于 `tests/interop/go.work` 与 `tests/interop/go.work.sum`，模块与依赖锁位于
  `tests/interop/gateway/`；编辑器需要时可单独打开 `tests/interop/` 工作区。
  测试在 `gateway/` 内构建，自动发现上级工作区，无需在项目根目录保留 Go 配置。
  Go 模块及其依赖不进入生产 Worker/浏览器包，目录与运行说明见 [互操作测试说明](../tests/interop/README.md)。
- `.github/workflows/ssh-interop.yml` 提供 Ubuntu/macOS 独立 CI；不使用生产 secrets，不自动部署。
  本地通过不等于该新 CI 已在远端运行。原部署门禁仍是 `pnpm run verify`。

这些测试仍不能代替 Cloudflare 真机的 TCP/WebSocket、CPU 预算和网络策略验证，亦不代表已经实测
Windows OpenSSH、Dropbear、全部第三方堡垒机或所有 MFA 组合。新增算法应以真实失败证据驱动，
不能只把名称加入提议列表，也不能用关闭主机校验或全局降级旧算法来换取连通。
