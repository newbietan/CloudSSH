# Windows 直连连接器

CloudSSH 的「打开桌面」优先用 WebRTC 将浏览器接到目标 Windows 上的连接器。Worker 授权、交换信令，不转发直连桌面的画面或输入；Windows RDP 的证书和 NLA 仍由浏览器端 FreeRDP 验证。直连前置协商失败时，已有备用线路的设备会静默使用 Worker 中继。两条线路不会同时登录 Windows。

## 第一次配置

1. **登录 CloudSSH → 添加服务器 → Windows Server**。目标 Windows 须开启远程桌面和 NLA，允许运行连接器的 Windows 本机访问 `127.0.0.1:3389`。默认「仅连接器」不用填写公网地址，但没有备用中继；有公网 TCP 或 Cloudflare Tunnel 线路的，可以选相应线路作为备用。
2. 保存 Windows 登录资料后，CloudSSH 自动打开「设置 Windows 直连」。在页面下载 **Windows x64 连接器 ZIP** 和 **此设备的绑定文件**，传到目标 Windows。已有设备可以从编辑中进入「设置 Windows 直连」，无需删除旧设备和指纹。不要分享 15 分钟有效的绑定文件。
3. 在目标 Windows 解压 ZIP，运行 `cloudssh-rdp-connector-windows-amd64.exe`。按 Windows 提示批准安装服务，选择原样下载的 `*.cloudssh-rdp.json` 文件，核对安装器显示的站点地址与你实际登录的 HTTPS 域名一致。安装器不需要 Windows 登录密码，也不需要在访客电脑上安装 FreeRDP。可从云控制台、现有远程管理工具或 Windows 本机操作；**不要为了安装将 RDP 端口公开到全网**。
4. 安装器显示此机器为 CloudSSH 生成的 **设备密钥 SHA-256 指纹**。在仍打开的 CloudSSH 页面核对完整指纹，再点「确认绑定并连接」。之后服务会自行上线；换浏览器、重新启动 Windows 或修改设备名称、凭据不需要重新绑定。首个 RDP 会话还要独立核对 **Windows 本身的 RDP 证书 DER SHA-256**，这和安装时的设备密钥指纹不是一回事。
5. 下次只点同一个 **「打开桌面」**。连接器在线时先尝试直连，兼容浏览器没有 WebRTC、设备离线、ICE 失败或本机 RDP TCP 未打开时，在尚未发送 RDP 字节前才可能回退。已经开始的桌面会话、证书变化、NLA/密码失败、账号或设备状态变化都不会自动改线重试。鼠标悬停在桌面工具栏 RTT 可以看到实际路径；不弹回退提示，不使用 TURN。

**Access 部署**：浏览器仍按站点策略登录。若站点以 Cloudflare Access 保护，Windows 安装器也需要允许访问**该站点**的独立 Service Auth 凭据，在安装器内录入。它不是 Windows 密码、Tunnel 安装令牌或目标隧道的 Service Token。不要为此配置 Bypass；如果策略要求桌面字节必须经过 Access/Tunnel，应只用中继并且不要绑定连接器。

**测试站与正式站**：官方 `test` 部署可在页面下载当前提交的**未签名测试构建**；仅用于受控机器，请比对包内 SHA-256，不要关闭系统保护。正常部署只提供维护者发布的签名 ZIP；若该发行包尚未发布，页面明确提示暂不可下载，不替换为未签名构建。使用本机官方测试程序不需要新的 Worker 密钥或额外 Cloudflare API 权限。

## 运行、撤销与问题排查

- Windows 服务 **CloudSSH RDP Connector** 开机自动启动；关闭安装器窗口不影响它。它以 LocalService 运行，仅为已授权的会话连接本机 `127.0.0.1:3389`，不监听管理端口、不做网段代理、不安装驱动。站点身份、设备私钥和可选的站点 Access 凭据由机器范围 DPAPI + 目录 ACL 保存，仅服务 SID、Administrators 和 SYSTEM 可读；不是 TPM/硬件保险库，也不防操作系统被控制。
- 在 CloudSSH **编辑设备 → 设置 Windows 直连 → 取消绑定**，会关闭旧连接器及其活动直连；普通中继（如有配置）不受影响。删除设备、换目标/线路/公网端口同样撤销绑定；单纯改名称或 Windows 登录凭据仍保留设备身份。需要换域名时在原账号取消绑定，再在正确域名重新安装/绑定。Windows 上再次运行安装器可看服务状态并卸载。解绑或卸载不强制注销 Windows 桌面。
- 连接器离线：先检查 Windows 服务、系统时间、目标 Windows 到实际站点域名的 HTTPS/WSS 连通性及边缘 Access，Windows 事件查看器中该服务只记录简短状态。如果 TLS 成功但无直连，检查是否允许出站 UDP、NAT 是否支持打洞和本机 RDP 服务。Cloudflare STUN 与对端会看到建立连接需要的网络地址；不使用 TURN，网络不支持时有备用中继才可切换。
- 直连路径不用公网 3389，但连接器仍要求本机 RDP 监听 **3389**。卡片内的公网 TCP 端口或 Tunnel 配置只属于备用线路，不会传给连接器。第一次核对证书期间若直连被外部中断，需重新从卡片进入，不会改用中继重新登录。
- 旧的手输配对码原型和下载程序已停用；旧测试 Worker 配过的 `RDP_P2P_SECRET` **新版不读取**，部署新版后可删除。已有 RDP 设备、证书和中继配置保留，旧连接器不会自动成为常驻服务。

## 维护者打包、发布与验证

- 常规 Worker 部署由版本化的发布资源提供下载，**不构建或打包 Go**。固定入口 `/rdp/download/windows-x64` 由 Worker 向官方发布源取文件并有界传输，最终用户不需要进入 GitHub；同一来源包可供不同部署的连接器使用。`RdpAuthorityDO` 的 v4 迁移在两个环境均已绑定；部署无需额外 Secret。首次绑定时 DO 生成随机签名根密钥，重启/升级不会重建，不能手工从一个部署复制到另一个部署。签名根与账号数据库不是外部 KMS。
- `bash scripts/build-rdp-peer.sh`（Go ≥1.24、Bash）生成 `dist/rdp-connector/` 下 Windows x64 EXE、许可证及校验文件。官方 CI `.github/workflows/rdp-connector.yml` 生成同样的**未签名候选**并在 Windows runner 验证 DPAPI、目录 ACL 与 LocalService 重启；它不自动创建 Release。维护者需验证候选来源、用可信 Authenticode 签名器对 EXE 签名并加时间戳，再在 Windows 运行：

  ```powershell
  .\scripts\package-rdp-connector.ps1 -InputDirectory .\dist\rdp-connector -OutputDirectory .\dist\rdp-release
  ```

  把输出 ZIP（固定名 `cloudssh-rdp-connector-windows-amd64.zip`）和校验文件放在官方仓库的 **`rdp-connector-v2`** Release。此步骤是维护者的一次发行操作，不是自部署用户的安装步骤。未签名、签名不受信任或没时间戳的包不会通过打包脚本。生产开放前应从已部署页面实际下载并校验；不要以临时 CI 产物直链替代。
- 官方 `test` 部署构建 `scripts/build-rdp-preview.sh` 的 ZIP，并显式用 `rdp-preview-entry.ts` 部署，正式入口 `rdp-entry.ts` 不包含该二进制。普通 Git 集成入口也不会隐式构建未签名包。避免把测试入口用于生产。
- `pnpm run build:frontend && node scripts/test-rdp-peer.mjs` 使用回环 HTTPS、真实 workerd 的签名 DO 及 UserDBDO、Pion 和 Chromium；加 `--webkit` 使用 WebKit。验证一次注册/确认、进程重启 + 新浏览器登录、首次证书确认信令、2 MiB 分片流控、续租与编辑关闭、ICE 不可用时预登录回退且只启动一次客户端。加 `--native` 验证随包 FreeRDP TCP 首个 X.224 包；不使用真实 Windows 凭据。仍需在 Windows 真机分别测试安装、服务重启、换浏览器直连、无公网 RDP 的仅连接器模式、禁 UDP 的备用路径及解绑，记录两条线路的首帧与操作延迟。