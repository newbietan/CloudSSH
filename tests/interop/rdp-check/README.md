# #201：Windows 双线路预检与 test 网页桌面预览

本目录是 [实施计划](../../../docs/rdp-implementation-plan.md) P0 的试验工具。`wrangler.jsonc` 是仅本地的**连通性预检**，不收发 RDP 数据、不登录；`preview-worker.ts` 是可在 CloudSSH **test** 环境验收的独立网页桌面入口，复用站点登录。都不是正式多用户 RDP 功能。

## 在 cloudssh-test 中验收网页桌面

1. 维护者在 GitHub 仓库变量创建 `CLOUDSSH_RDP_TEST_CONFIG`，其值为 JSON：`expiresAt` 是不超过 24 小时后的 Unix 毫秒时间戳；`publicIp`、`publicPort`（字符串）、`tunnelHost`、`certificate`（64 位小写 SHA-256）是经授权的两个固定目标及同一 Windows 证书。**不要在此变量里放密码、令牌或 Service Token**；此预览只测无 Access 的目标隧道。预览沿用 CloudSSH 当前登录模式（包括单管理员密码），无独立白名单；旧配置里的 `owner` 字段会被忽略。
2. 对 `test` 推送后，CI 先运行 CloudSSH 门禁（浏览器档位见 [测试说明](../../README.md#e2e-ci-并发与报告)）。FreeRDP JS/WASM/许可证首次用固定上游提交及工具链构建；之后可命中只含这三类文件及摘要的精确缓存，核验后仍打包本次页面、运行 test Worker dry-run 并部署。未开启 RDP 预览时仍部署现有 test Worker；`main` 不打包预览。
3. 按站点配置的认证方式登录现有 CloudSSH 测试站，在**同一个站点**打开 `/__rdp-preview/`，分别点「公网 TCP」和「Cloudflare Tunnel」。在 CloudSSH 网页密码框输入测试 Windows 本地 Administrator 密码，再选择线路；无需填写 Domain。网页只把密码一次性交给当前浏览器中的 WASM，不发给 Worker 或保存在网页存储中。看到远端桌面后试记事本打字、拖窗和滚动。每次最多 3 分钟，每方向最多 16 MiB，只供小范围验收，不用作长会话性能结论。每条线路反馈登录/画面/键鼠结果，若失败仅附脱敏页面状态或错误；不要分享凭据、帧数据或桌面内容。
4. 若显示 404，检查是否在同一测试域名登录、测试 CI 是否成功、变量时间是否过期。连接进度区分 WASM 下载、浏览器运行时/线程启动和转发通道。测试 Worker 支持预压缩 WASM，浏览器启动只预热 4 个工作线程，其余按需创建；认证通过后浏览器可通过 ETag 重验证并复用客户端文件，HTML、配置仍不缓存。页面不主动聚焦画布，画布按可用宽度缩放。收到首个桌面绘制事件才显示「Windows 桌面已显示」；若中转已打开但 25 秒内无首帧，会提示重试而不是无限等待。画布变黑不等于 Windows 或隧道故障。不受保护的隧道路由只在授权测试窗口使用，测试后手动删除；移除仓库变量并重新部署 `test` 可彻底移除网页入口。时间到期后无需部署即可拒绝新会话。

## 本地连通性预检（可选）

本工具只打开固定 Windows 目标的 TCP 或 Cloudflare Tunnel WebSocket，随后立即关闭。公网 TCP 成功只表示端口可达；Tunnel 的 101 只表示载体握手成功，不能证明 cloudflared 后端已建立 RDP。两者都不能代替真实 Worker 出口、NLA、证书或桌面性能验收。

## 准备测试 Windows

1. 用同一台 Windows Server，开启远程桌面和网络级别身份验证（NLA）。为测试账号授予远程桌面权限，不必用日常管理员账号。保留防火墙：公网 RDP 初始只允许测试者的出口地址；不要为了 Cloudflare Workers 出口测试而向所有来源开放。标准 Worker 的出口与本机不同，如果没有可以安全放行的正式测试路径，将该项标为未测。
2. Cloudflare Tunnel 配置独立的 **Published application** 主机名，服务类型 **RDP**，指向 `rdp://127.0.0.1:3389`（cloudflared 与 Windows 同机时），或指向连接器能访问的 Windows 地址。这里不用 Access 的浏览器桌面链接，也不复用现有 SSH ingress。若用 Access 保护，使用绑定该应用的 **Service Auth** 策略和专属短期测试 Service Token，不改成 Bypass。
3. 从 Windows 独立核对实际用于 `RDP-Tcp` 侦听器的证书，记录其 DER 证书的 SHA-256 指纹供之后的浏览器信任检查。Windows 常见的 `Thumbprint` 属性是 SHA-1，它可用于在证书存储中定位证书，**不等于**本计划需要的 SHA-256。Windows 密码之后直接在桌面测试页手动输入，不放入 Wrangler 配置或命令行。

## 运行

在此目录创建仅本地可读的 `tests/interop/rdp-check/.dev.vars`（已忽略 Git，不要把值发到聊天、Issue 或日志）。只填测试机器：

```dotenv
RDP_CHECK_PUBLIC_IP=<测试服务器的公网 IPv4>
RDP_CHECK_PUBLIC_PORT=3389
RDP_CHECK_TUNNEL_HOST=<仅主机名，不含 https://、端口或路径>
# 若隧道使用 Access Service Auth，在本文件内同时填以下两项；否则两项都省略。
RDP_CHECK_ACCESS_ID=<专属本地测试 Service Token ID>
RDP_CHECK_ACCESS_SECRET=<专属本地测试 Service Token Secret>
```

从仓库根目录运行，仅绑定本机回环地址。**不要**对此配置运行 `wrangler deploy` 或 `wrangler dev --remote`：

```bash
pnpm exec wrangler dev --config tests/interop/rdp-check/wrangler.jsonc
```

另开终端执行（命令没有目标、凭据或会话信息）：

```bash
curl -sS --data '' -H 'Origin: http://127.0.0.1:8791' http://127.0.0.1:8791/check/public
curl -sS --data '' -H 'Origin: http://127.0.0.1:8791' http://127.0.0.1:8791/check/tunnel
```

只需反馈 `code`：

| 响应 | 含义 |
| --- | --- |
| `direct_tcp_open` | 本机运行时能建立 TCP。还未进行 RDP/TLS/NLA。 |
| `tunnel_ws_open` | 隧道域名返回有效的 101。还未证明后端 RDP 可用。 |
| `tunnel_access_denied` | 隧道返回 302/401/403；检查 Service Auth、Token 与目标应用，不关闭访问保护。 |
| `invalid_local_config` | 缺少对应本地配置，或地址、端口、Token 不符合要求。 |
| `timeout` / `unreachable` | 路径超时或失败；检查监听、防火墙、隧道状态、应用类型和域名。 |

结束后关闭本地 Wrangler、撤销用完的测试 Token，移除临时的公网防火墙许可。没有运行真实 Windows 桌面前，不把这些检查记为 P0 通过。

## 首轮真机记录（2026-11-23）

- Wrangler 本地探针经测试 Tunnel 获得有效的 WebSocket 101。
- 对同一台 Windows 的公网 TCP 和 Tunnel WSS 分别进行了标准 RDP 预认证握手：两条线路均选择 NLA `HYBRID_EX`，内层 TLS 返回的 Windows 证书 SHA-256 均与独立云控制台读数一致。未发送凭据，未验证 CredSSP 登录或桌面。
- FreeRDP 3.33.1（`65bcca1913a28cbdd7eb913599f692bd2b707991`）的上游浏览器构建生成了 11,078,777 字节 WASM。该产物经本地同源隔离页面在 Playwright Chromium 和 WebKit 均初始化成功。这只是客户端启动验证，不是 Worker 静态资源发布、双线路浏览器登录或性能测试。
- 待验收：浏览器严格校验证书后的 NLA 登录、同一页面的双线路桌面/键鼠、生产形态 Worker、弱网和延迟。此轮未验证 Access Service Auth。

## 本地回归

```bash
pnpm exec vitest run tests/interop/rdp-check/probe.test.ts
```

Vitest 不拨任何网络目的地；真实预检仅连接 `.dev.vars` 的固定目标。该目录不参与 CloudSSH 生产构建，也不改变当前 SSH、Access、SFTP 或 MCP 行为。
