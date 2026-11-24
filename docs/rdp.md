# Windows 远程桌面（RDP）

## 配置设备

1. 通过 HTTPS 登录 CloudSSH。在「添加服务器」顶部切换到 **Windows Server**；不需要 SSH 设备或本地 Windows App。Windows 必须已开启远程桌面和 NLA，且账号有 RDP 权限。匿名用户和一次性 SSH 分享不可用。
2. **公网直连**填写公网 IPv4 和 Windows 对外提供 RDP 的 TCP 端口。端口默认 `3389`，已有设备无需修改；使用非标准端口（如 `53389`）时在独立端口框填写，不要拼到地址后面。仅接受 1–65535 的整数，沿用 SSH 直连的受限端口规则；不接受直连域名或私网地址。标准 Workers 出站不提供实例独享固定公网 IP；不要为测试向全网开放 3389。有入站白名单要求时优先使用 Tunnel。
3. **Cloudflare Tunnel** 只填写已发布应用的主机名。实际 Windows 端口在 `cloudflared` 服务地址设置（如 `rdp://127.0.0.1:3389` 或 `rdp://127.0.0.1:53389`），CloudSSH 不显示、也不提交端口。它不是 SSH 路由或 Access 浏览器桌面入口。推荐用独立的 Access **Service Auth** 保护该主机名，在设备配置中填该应用的 Client ID / Secret，而不是 Tunnel 安装令牌。
4. 填写 Windows 用户名（默认 Administrator）、密码和可选域（本地账号通常留空）。保存后点击卡片连接；旧设备缺凭据时先「补全配置」。只有身份、主机、线路和直连端口都不变时，密码留空才会保留原值。更改端口视为更换 Windows 目标：须重填密码、重新核对证书指纹，旧票据及租约失效，最近连接时间清空。刷新或打开书签不会自动取回已保存的登录信息。
5. 首次连接应从可信 Windows 管理控制台独立核对证书 **DER SHA-256** 指纹，再点「信任并连接」；Windows 常见的 SHA-1 `Thumbprint` 不能直接比较。指纹变化会停止连接，不能在警告中覆盖。若独立确认是计划内换证，同一主机可删除并重建设备，再核对新指纹。

## 使用与安全限制

- Windows 与 SSH 设备共用服务器列表、标签、排序和分页，可用 Windows 用户名搜索。直连卡片显示掩码 IP 与已保存的端口，复制时只复制完整 IP；Tunnel 只显示和复制域名。收到首帧桌面画面才记录最近连接时间。
- 桌面在同一标签打开。「返回」会断开中继，但不会注销 Windows；全屏只改变本地显示，不裁剪桌面，也不强制修改 Windows 分辨率。普通窗口仅在对端支持动态分辨率时同步尺寸。
- 桌面就绪或切换全屏后，可直接打字，不必先点击画面；若已主动选中「返回」或正在核对证书，会保留当前焦点。需要时点击画面即可继续输入。在 RDP 工具栏按 `Esc` 不会切换到底层 SSH 标签。
- 画面内右键交给 Windows，鼠标前进／后退侧键不触发浏览器导航。画面外仍可使用浏览器菜单和导航。「右 Shift + D」按普通组合键发送，不是断开快捷键；系统保留的快捷键（如 `Ctrl+Alt+Del`）不保证能从网页发送。
- **中继 RTT** 测量浏览器到 Worker；**RDP RTT** 使用 Windows 上报的平均值，缺失或过期显示「—」。两者都不是键鼠输入到画面更新的时间。
- Windows 与浏览器建立 TLS/NLA，Worker 只转发字节。Windows 登录和 Tunnel 凭据按账户加密，密钥与数据同库，并非独立 KMS。列表不返回密码、域或 Tunnel 密钥；普通详情和 WebSocket 不交付 Windows 登录，仅当前所有者主动连接的同源请求会将登录信息交给浏览器。
- RDP 设备独立于 SSH 跳板、分享、SFTP、Agent 和 MCP。不提供剪贴板、驱动器挂载、音频转发；不承诺 Kerberos-only、RD Gateway、多屏或完整移动端键盘支持。会话受 `IDLE_TIMEOUT` 及 2 小时上限约束。

若 Edge 显示「已阻止该站点」或「恐吓软件」，这是浏览器的 [Scareware blocker](https://support.microsoft.com/en-us/edge/prevent-online-scams-with-the-scareware-blocker-in-microsoft-edge)，不是 RDP 证书弹窗。先核实站点、部署、配置的 Windows 设备和证书；不可仅凭截图认定误报。确认正常后可向 Microsoft 提交不含凭据及桌面隐私的反馈，不建议关闭保护或绕过拦截。

## 维护与真机验收

- `bash scripts/build-freerdp.sh` 用于显式重建随仓库分发的客户端。常规构建不运行 Docker 或下载 FreeRDP。更新时审核依赖、许可证与 JS/C++ 钩子，用 `tests/build/rdp-assets.test.ts` 验证模块、摘要和大小；不要手改压缩产物。
- `rdp-devices.spec.ts` 覆盖画布焦点、工具栏和鼠标侧键；`rdp-native-input.spec.ts` 在 Chromium 中加载随包的真实 WASM，验证 FreeRDP 从内存文件系统读取禁用本地快捷键的配置，不需要 Windows 凭据。自动化不能代替真机输入验收。
- 用同一台 Windows 在公网与 Tunnel（包括 Access Service Auth）分别验证 NLA、证书信任与换证、不正确密码、桌面首帧和键鼠。另测断线重试、1080p 持续操作及弱网，分开记录连通、认证、首帧和延迟。

上游：[FreeRDP](https://github.com/FreeRDP/FreeRDP/releases)、[Cloudflare 出站 TCP](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)、[Tunnel 已发布应用协议](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)。
