# Windows 直连连接器

CloudSSH 的「打开桌面」优先用 WebRTC 将浏览器接到目标 Windows 上的连接器。Worker 授权、交换信令，不转发直连桌面的画面或输入；Windows RDP 的证书和 NLA 仍由浏览器端 FreeRDP 验证。直连前置协商失败时，已有备用线路的设备会静默使用 Worker 中继。两条线路不会同时登录 Windows。

## 第一次配置

1. **登录 CloudSSH → 添加服务器 → Windows Server**。目标 Windows 须开启远程桌面和 NLA，允许运行连接器的 Windows 本机访问 `127.0.0.1:3389`。默认「连接器」不用填写公网地址，但没有备用中继。选择公网直连或 Cloudflare Tunnel 也可启用 WebRTC；绑定后，所选线路保留为备用。
2. 保存 Windows 登录资料后，CloudSSH 自动打开「WebRTC直连配置」。点击 **「下载并绑定此设备」**，将一个专用 ZIP 传到目标 Windows。这个明确的下载动作就是绑定授权。每张卡片的 ZIP 不同，授权 15 分钟有效、只接受一个设备密钥，不含 Windows 密码；请勿转发。页面只显示当前操作，时效与校验说明在「安装须知」中。已有设备可从编辑中的「WebRTC直连配置」进入。公网和隧道设备的按钮在 IP 地址或域名输入框下方，无需删除旧设备和证书。
3. 在目标 Windows **完整解压 ZIP**（不要在压缩包窗口里直接双击），再运行 `cloudssh-rdp-connector-windows-amd64.exe`，按 Windows 提示批准安装服务。安装器自动读取 EXE 同目录下的授权，不用选文件、输码或确认配对。它不需要 Windows 登录密码或访客电脑上的本地 FreeRDP。可从云控制台、现有远程管理工具或 Windows 本机操作；**不要为了安装将 RDP 端口公开到全网**。
4. 服务第一次连到本站并证明本机密钥时自动绑定，页面出现「连接器在线」即可打开桌面。换浏览器、重启 Windows 或修改设备名称、登录凭据无需重新绑定。首个 RDP 会话仍需独立核对 **Windows 证书 DER SHA-256**；这不是再做一次设备授权。
5. 下次只点同一个 **「打开桌面」**。连接器在线时先尝试直连，兼容浏览器没有 WebRTC、设备离线、ICE 失败或本机 RDP TCP 未打开时，在尚未发送 RDP 字节前才可能回退。已经开始的桌面会话、证书变化、NLA/密码失败、账号或设备状态变化都不会自动改线重试。桌面右上角直接显示实际使用的「WebRTC」或「中继」延迟；不弹回退提示，不使用 TURN。

**Access 部署**：浏览器仍按站点策略登录。若站点以 Cloudflare Access 保护，Windows 安装器也需要允许访问**该站点**的独立 Service Auth 凭据，在安装器内录入。它不是 Windows 密码、Tunnel 安装令牌或目标隧道的 Service Token。不要为此配置 Bypass；如果策略要求桌面字节必须经过 Access/Tunnel，应只用中继并且不要绑定连接器。

**安装包来源**：正式站下载维护者通过官方 CI 发布的固定 ZIP，安装器不使用 Authenticode；Windows 可能提示未知发布者，受管机器可能按本机策略阻止安装。核对官方来源及 SHA-256，遵守系统策略，不要关闭防护。官方 `test` 可下载与当前提交对应的测试构建，仅用于受控测试。缺少正式发行包时提示暂不可下载，不以测试构建代替。两种部署都不需要额外 Worker 密钥。

## 运行、撤销与问题排查

- Windows 服务 **CloudSSH RDP Connector** 开机自动启动；关闭安装器窗口不影响它。它以 LocalService 运行，仅为已授权的会话连接本机 `127.0.0.1:3389`，不监听管理端口、不做网段代理、不安装驱动。站点身份、设备私钥和可选的站点 Access 凭据由机器范围 DPAPI + 目录 ACL 保存，仅服务 SID、Administrators 和 SYSTEM 可读；不是 TPM/硬件保险库，也不防操作系统被控制。
- 在 CloudSSH **编辑设备 → WebRTC直连配置 → 取消绑定**，会关闭旧连接器及其活动直连；普通中继（如有配置）不受影响。删除设备、换目标/线路/公网端口同样撤销绑定；单纯改名称或 Windows 登录凭据仍保留设备身份。需要换域名时在原账号取消绑定，再在正确域名重新安装/绑定。Windows 上再次运行安装器可看服务状态并卸载。解绑或卸载不强制注销 Windows 桌面。
- 连接器离线：先检查 Windows 服务、系统时间、目标 Windows 到实际站点域名的 HTTPS/WSS 连通性及边缘 Access。浏览器和连接器都使用 [Cloudflare STUN 官方端口](https://developers.cloudflare.com/realtime/realtimekit/platform/network-allowlist/) `stun.cloudflare.com:3478/UDP` 与 `53/UDP`；不使用 TURN，STUN 可达不代表对等 UDP 一定可达。STUN 与对端会看到建立连接需要的地址。受限网络有备用中继才可切换。
- 在线但使用中继：在 Edge 开发者工具 Console 启用「详细」（Verbose）并筛选 `CloudSSH WebRTC`。重新连接后，`source=deadline`、`phase=opening`、`ice=checking` 表示信令已完成，但约 14 秒预检内没有可用路径或未就绪；`afterAnswerMs` 是浏览器实际应用应答后的时长。对比关闭本机代理/TUN 前后、两端候选类型数量和 ICE 状态。没有 `srflx` 可能是 STUN 或策略问题，不足以否定可达的公网 `host` 候选。`source=answer` 表示浏览器拒绝应答；数据通道已 `open` 但未就绪时，再看 Windows「应用程序」事件日志 `CloudSSHRdpConnector`，例如 `local_rdp_unavailable`。诊断只在本地输出阶段、用时、状态、候选类别数量或固定原因，不输出地址、SDP、票据或凭据。
- 直连路径不用公网 3389，但连接器仍要求本机 RDP 监听 **3389**。卡片内的公网 TCP 端口或 Tunnel 配置只属于备用线路，不会传给连接器。第一次核对证书期间若直连被外部中断，需重新从卡片进入，不会改用中继重新登录。
- 直连传输以当前 SCTP 拥塞窗口加两片（32KiB）控制 Windows 连接器的发送积压，仍受 1MiB 已读确认窗口限制；靠缓冲低水位和浏览器读取进度继续发送。浏览器直连按 64KiB 已读增量或 8ms 确认，中继维持原节奏。不改变分辨率、不丢弃 RDP 数据、不影响选路。已有连接器仍可使用，完整的发送队列优化需要新版 Windows 安装器。
- 已绑定的常驻服务、RDP 设备、证书及中继配置升级后继续有效。旧的手动原型和待确认绑定文件不能自动升级成已绑定，请从卡片重新下载 ZIP；若已装过但未绑定，先卸载旧服务。新版不读取旧的 `RDP_P2P_SECRET`。若安装包过期、错发或尚未成功上线，可重新下载作废旧包；已经上线绑定的设备必须先取消绑定，不能覆盖。

## 维护者打包、发布与验证

- 常规 Worker 部署由版本化的发布资源提供下载，**不构建或打包 Go**。已登录同源 `POST /api/rdp/profiles/:id/connector-setup` 从固定发布源验证有界 ZIP，将授权加入同一归档，不解压、重压或修改原 EXE；最终用户不需要进入 GitHub。专用 ZIP 私有、禁止缓存，旧手动确认授权不转换，首个已签名的设备待机握手才持久绑定。`RdpAuthorityDO` 的 v4 迁移在两个环境均已绑定；部署无需额外 Secret。首次绑定时 DO 生成随机签名根密钥，重启/升级不会重建，不能手工从一个部署复制到另一个部署。签名根与账号数据库不是外部 KMS。
- 官方 CI **RDP Windows connector** 产出 `rdp-connector-release-<commit>`，内含 `cloudssh-rdp-connector-windows-amd64.zip` 和 `SHA256SUMS`；独立 Windows runner 验证 DPAPI、目录 ACL 与 LocalService 启停。维护者核对提交并等两个作业都通过后，下载这两份文件，发布到官方仓库的 **`rdp-connector-v3`** Release（文件名不变）。CI 不自动发布，正式包不要求 Authenticode 或时间戳。发布前后核对哈希与下载，不以 CI 产物临时直链替代。
- 本地可以运行 `bash scripts/build-rdp-peer.sh`（Go ≥1.24）构建，再执行 `bash scripts/package-rdp-connector.sh dist/rdp-connector dist/rdp-release`（Bash、zip）。打包校验候选 EXE 的 SHA-256，归档只包含 EXE、许可证和内层哈希；外层哈希校验整个正式 ZIP。授权文件只由站点按设备动态注入，不进 Release。
- 官方 `test` 部署复用打包器生成提交内的 ZIP，并显式用 `rdp-preview-entry.ts` 提供测试下载；正式入口 `rdp-entry.ts` 不嵌入该二进制。常规 Git 集成也不隐式构建连接器；不要把测试入口用于生产。
- `pnpm run build:frontend && node scripts/test-rdp-peer.mjs` 使用回环 HTTPS、真实 workerd 的签名 DO 及 UserDBDO、Pion 和 Chromium（需 zip/unzip）；加 `--webkit` 使用 WebKit，加 `--tunnel` 验证保留 Cloudflare Tunnel 线路与凭据的备用路径（默认验证公网 TCP）。验证专用 ZIP 完整可解压、EXE 字节不变、自动绑定、进程重启 + 新浏览器登录、首次证书确认信令、2 MiB 分片流控、续租与编辑关闭、ICE 不可用时预登录回退且只启动一次客户端。`--blocked-ice` 在回环保留实际信令和 SDP 应答，将两端测试候选指向不回复的回环 UDP 套接字，验证 ICE 在 `checking` 时被直连截止收口，并记录不含敏感数据的诊断。加 `--native` 验证随包 FreeRDP TCP 首个 X.224 包；不使用真实 Windows 凭据。仍需在 Windows 真机分别测试安装、服务重启、换浏览器直连、无公网 RDP 的「连接器」模式、禁 UDP 的备用路径及解绑，记录两条线路的首帧与操作延迟。