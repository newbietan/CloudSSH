# WebRTC 直连原型：同一台 Windows 做 A/B 测试

**目标**：用现有浏览器、FreeRDP、Windows 账号和分辨率，单独比较「Worker 转发」和「浏览器直连 Windows 连接器」的手感。不承诺打洞成功或直连一定更快。本原型只支持单台机器本地的 `127.0.0.1:3389`，不做无人值守、网段代理、视频转码或会话迁移。

## 测试前准备

1. 在 **CloudSSH 测试实例**保存 Windows 设备，用原来的「打开桌面」连接一次，通过可信渠道独立核对并保存该 Windows 的 **DER SHA-256 证书指纹**。两个入口必须是同一台 Windows；未保存指纹的设备不会显示测试按钮。不为了测试公开 3389，可以用已授权的 Tunnel 完成首次核对。外部端口映射可以不同，但连接器所在机器的 RDP 服务必须真的监听本机 3389，NLA 保持开启。
2. 在测试 Worker 设置一个名为 **`RDP_P2P_SECRET`** 的 Secret：32 个随机字节编码为 **64 个小写十六进制字符**。它只用于 Worker 签名，不给连接器，不进仓库。维护者可对已部署的测试实例执行下面的命令（不要漏 `--env test`）；使用 Dashboard 的人可自行生成随机值，选择 `cloudssh-test` 的 Secret 类型。未设置或格式错误时，已有 RDP 不变，原型不开启。

   ```sh
   openssl rand -hex 32 | pnpm exec wrangler secret put RDP_P2P_SECRET --env test
   ```

3. 获取 **Windows x64** 连接器。官方仓库 `test` 分支的 [RDP peer prototype connector](https://github.com/newbietan/CloudSSH/actions/workflows/rdp-peer-prototype.yml) 工作流为连接器代码变更提供 Actions 产物（保留 7 天，不是 Release 或已签名的安装包）。下载与测试代码对应的 `cloudssh-rdp-peer-windows-amd64-<SHA>`，解压后用 `Get-FileHash .\cloudssh-rdp-peer-windows-amd64.exe -Algorithm SHA256` 比对同包 `SHA256SUMS`。仅使用自己信任的构建，不关闭安全软件。也可从仓库源码，在装有 Bash 和 Go ≥1.24 的开发机交叉构建（输出 `dist/rdp-peer/`，含校验和与许可证）；不需在目标 Windows 上安装 Go：

   ```sh
   bash scripts/build-rdp-peer.sh
   ```

## 连接一次

1. 用已登录账号刷新测试站。在 Windows 卡片点击 **WebRTC 测试**（不是「打开桌面」），页面显示 5 分钟有效的一次性配对码。
2. 在**目标 Windows 本机**的 PowerShell，通过已有可信控制台运行：

   ```powershell
   .\cloudssh-rdp-peer-windows-amd64.exe -site https://你的测试站域名
   ```

   只在程序提示后粘贴配对码、按 Enter。交互终端不回显；不要将码写进命令行、聊天或日志，复制后可清空剪贴板。`-site` 必须是签发配对码的同一个 HTTPS 源，不能用别名，不跟随重定向。不要关闭这个 PowerShell 窗口。
3. 看到 **`Paired`** 后，在浏览器点 **开始 WebRTC 测试**。桌面显示后，工具栏的 **WebRTC … ms** 是浏览器在**桌面数据通道**上到连接器的实际往返；鼠标悬停可看已选的 ICE 类型（浏览器 / 连接器），不会展示 IP。**RDP … ms** 仍是 Windows 上报的协议指标，不是输入到画面的延迟。
4. 「返回」或在连接器按 Ctrl+C 结束本次试验，重新测试需新码。直接修改/删除设备也会关闭本次会话。点原来的 **打开桌面** 就是 Worker 路线，对照时不必清除设备或证书。

**本站在 Cloudflare Access 后面？** 浏览器仍必须是已验证邮箱的所有者。机器端要有被**本站**边缘策略允许的独立 Service Auth 凭据，通过连接器进程的 `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` 环境变量提供；不使用 Windows 密码、浏览器 Cookie、Tunnel 安装 token 或设备的 Tunnel 凭据代替。Worker 同时要求可信的原生 Access 准入和有效的一次性码。不要为此配置 Bypass。若组织策略要求所有桌面数据都经 Access/Tunnel，这条替代数据路径不适用，请勿开启。

## 延迟怎么比

同一浏览器、同一网络、同一台 Windows，两条路径都使用**相同的远端分辨率**（支持动态分辨率时可在全屏均选 720p）。每组交替做三次，避免只比较第一次加载或单个瞬时 RTT。

| 路线 | 是否出现首帧 | 工具栏 RTT / Windows RTT | 空闲时单击菜单到展开 | 快速滚动后多久停住 |
| --- | --- | --- | --- | --- |
| 打开桌面（Worker） | | | | |
| WebRTC 测试（直连） | | | | |

可用手机慢动作粗测点击到画面的时间，**不要把两个 RTT 相减或相加**。在家宽、办公网、手机热点分开记；未能打洞也是有效结果，不把失败样本排除后再报告成功率。反馈只需网络类型、上述表格及 ICE 类型，不要提交地址、凭据或 SDP。

## 如果不通

| 现象 | 先检查 |
| --- | --- |
| 看不到测试按钮 | 分支/部署及正确环境的 Secret、刷新页面、设备已保存登录信息和已核验指纹。 |
| 连接器未显示 Paired | 同一站点、未过期/未消费的新码、Access 策略。确认 Windows 系统时钟已同步；不要把站点密钥贴到连接器。 |
| Paired 但超时 | UDP、防火墙与 NAT 可能阻止直连。只在组织允许时授权该应用的 UDP 流量；无需打开公网 RDP 或关闭防火墙。可分别换一个网络重测。**没有 TURN，也不会暗中改走 Worker。** |
| 已建立直连但没有桌面 | 先确认连接器能访问本机 RDP、实际 Windows 证书仍匹配、NLA 登录正常。指纹变化必须重新独立核对，不跳过校验。 |
| 切后台或断网后会话结束 | 浏览器约每 12 秒通过原账号 HTTPS 续租。控制通道丢失或约 35 秒收不到有效授权，连接器自行关闭。后台定时器受浏览器限制。这是前台测试原型，不保证恢复，也不等于注销 Windows。 |

## 数据边界与本地验证

- Worker/UserDBDO 只交换一次性票据、短期授权和有界 SDP；信令 WebSocket 不接受桌面二进制帧。两个控制 WebSocket 在会话期间保持在线，但**所有键鼠、画面及其 ACK/探针**走同一个可靠、有序的 DataChannel。TLS/NLA 仍在浏览器和 Windows 之间完成；配对不能修改原 Windows 指纹。
- `stun:stun.cloudflare.com:3478` 用于发现地址，STUN 不转发桌面。Cloudflare STUN 和对端会看到建立连接所需的网络地址；信令期间 Worker 可见 SDP，但不持久化、不写日志。只保存短期配对证明的摘要；不允许指定任意 TCP 主机/端口或转入 TURN。
- 每次配对绑定当前账户、浏览器、设备及修订，单次消费；会话沿用账户并发、`IDLE_TIMEOUT` 和两小时上限。断开授权通道会结束数据通道，不承诺从已断开的桌面切换到中继。要停用原型，删除测试环境的 Secret 并刷新；原有中继不受影响，活动直连不再续租。
- 普通 Worker 构建不用 Go。开发机可运行 `pnpm run build:frontend` 后执行 `node scripts/test-rdp-peer.mjs` 或加 `--webkit`（需项目依赖、Playwright 对应浏览器、Go、OpenSSL）。它用临时回环 HTTPS、真实 workerd/SQLite DO、生产信令与浏览器适配器、真实 Pion 和临时 TCP 回显，验证跨流控窗口的 2 MiB 往返、已选候选、数据不经信令、续租与撤销。加 `--native` 则不用回显驱动替代桌面客户端，验证随包 FreeRDP WASM 发出的首个 X.224 协商包确实到达 TCP 后立即结束。无公网 STUN、无 Windows 凭据；不替代 Windows 真机或实际线路验收。
