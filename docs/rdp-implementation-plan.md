# #201 CloudSSH 站内 Windows 远程桌面

[Issue #201](https://github.com/newbietan/CloudSSH/issues/201) 的双线路可行性已由维护者在同一台真实 Windows 上确认：浏览器内公网 TCP 和 Cloudflare Tunnel 均能登录、交互，主观延迟可接受。此前临时预览、测试目标变量和专用部署步骤不属于正式接入，已移除。此次接入改变了账户、票据和流控，须用正式入口重新做双线真机验收；不要把预览结果当作新中继、Access 策略或长期性能已经验收。

## 配置 Windows 设备

1. 生产和测试均内置 RDP，无需环境开关。须通过 HTTPS 登录 CloudSSH，匿名和一次性 SSH 分享不可使用。使用当前部署的 GitHub、单管理员密码或 Cloudflare Access 登录方式，不设额外账号名单。
2. 登录后点「添加服务器」，在弹窗顶部从默认的 Linux 切换到「Windows Server」，填写远程桌面配置。保存后设备会出现在同一个服务器列表中；无需创建 SSH 设备或安装 Windows App。Windows 必须已开启远程桌面、NLA，账号须有 RDP 权限。
3. **公网**模式填可达的公开 IPv4。首版只拨 TCP 3389，不允许任意端口、私网 IP 或未固定解析的直连域名。标准 Workers TCP 出站没有实例独享固定公网 IP；不要为了测试向全网开放 3389。有入站白名单要求时优先走 Tunnel。
4. **Tunnel** 模式选择已经配置的 Cloudflare Published Application 主机名。在 cloudflared 端把该主机名的服务设置为 `rdp://<Windows 地址>:3389`，例如同机 `rdp://127.0.0.1:3389`。这是字节流隧道，不是 Access 浏览器桌面入口，也不能用现有 `ssh://` 路由替代。建议给目标主机名单独加 Access **Service Auth**，在设备上填该应用的 Client ID/Secret；不是 Tunnel 安装令牌。修改目的地会清空旧凭据，省略同主机的凭据则保留。
5. Windows 设备可以添加标签，卡片显示配置的用户名和最近连接时间，并与 SSH 设备一起排序后分页。支持按 Windows 用户名搜索。主机行与 Linux 设备一致：直连显示掩码 IP 加 `:3389`，点击复制完整 IP（不含端口）；隧道只显示与复制配置的域名。首次显示桌面画面后才记录成功连接；升级前的历史无从还原，显示「暂无记录」。在设备设置直接填写用户名（默认 Administrator）、密码和可选的域（本地账号通常留空）。保存时按账户加密，点击卡片直接连接，桌面无二次表单或连接按钮；刷新或单独打开链接不是连接授权。旧的缺凭据设备请先选「补全配置」。编辑时只回显用户名和域，密码若留空仅在同一身份且线路/主机不变时保留；如需移除密码请删除设备。首次连接会显示实际收到的 Windows 证书 **DER SHA-256** 指纹，请通过可信 Windows 管理控制台独立核对后选择「信任并连接」，不必手填。Windows `Thumbprint` 通常是 SHA-1，不能直接比较。指纹已保存时不再询问；不一致时显示新旧指纹并停止连接，不能在警告弹窗里覆盖。若确认是计划内换证且目的地未变，可删除并重建设备后再次核对和信任。用户名、域和密码整体沿用账户 AES-GCM 加密，密钥与数据同库，不是独立 KMS；卡片列表只返回当前账户的展示用户名；域、密码、Access 凭据不进入列表或日志。普通详情 GET、WebSocket 不下发 Windows 登录明文。当前所有者点击连接后，匹配设备修订的同源 POST 才在 no-store 响应中把解密值交付浏览器，不能保护已被入侵的浏览器或 DO。

## 实现边界

- `rdp_profiles` 独立于 SSH 设备，不进入 SSH 跳板、分享、MCP、AI、SFTP、命令片段或 OS 探测。账户库行级隔离；Tunnel Service Token 使用账户现有 AES-GCM 能力加密，普通 GET 无明文。旧 SSH 表和 DO migration 不变。
- API `/api/rdp/profiles`、`/api/rdp/profiles/:id` 和 `POST /api/rdp/profiles/:id/connect`；编辑用 `POST /api/rdp/profiles/:id/login-identity` 仅返回用户名、域和匹配的设备修订，绝不返回密码；同源、双重校验的 `/api/rdp/session` WebSocket 只接受首帧单次连接票据（30 秒、仅存摘要、绑定浏览器与档案修订），不把目标地址或令牌放到 URL。`PUT /api/rdp/profiles/:id/trust` 在证书首次确认后按账户、设备修订及当前有效连接租约原子写入 SHA-256，仅未固定时可写（同指纹重试幂等）；保存失败则不进入 NLA。原有指纹保留；仅换主机或线路重置，普通编辑不重置。确认等待有限（约 85 秒）。更新/删除撤销相关票据与在线租约，在线会话定期复查，不能保证对已经退出的 Windows 会话执行注销。
- 公网和 Tunnel 只有传输层分流。Worker 不终止 Windows TLS、不渲染或转码，只搬运字节。浏览器与 Windows 做 NLA 及严格 Windows 证书指纹校验；隧道 HTTPS 外层的 TLS 不能替代 Windows 证书。连接路径不关闭 NLA。仅 Chromium / WebKit 实机体验另验；不承诺 Kerberos-only、RD Gateway、多屏或移动端键盘完整性。
- 延迟指标分开显示，单位为毫秒：中继 RTT 是浏览器到 CloudSSH Worker 的 WebSocket 往返，首帧后可见时每 5s 采样、最多一个在途探针；不向 Windows 注入流量，也不续用户空闲时间。RDP RTT 是 Windows 自身通过 Network Characteristics Result 上报的平均值；不支持/未上报或过期时显示「—」，不把中继 RTT 代作整链路 RTT。两者都不测键鼠输入到绘制的延迟。
- 桌面转发使用有界双向字节窗口与累计 ACK；浏览器下行确认发生在 WASM socket 消费字节时，而不是 JavaScript 收到消息时，也不等于渲染结束。超时、租约失效或持续积压关闭，不能继续交付丢失部分字节的 TLS 流。单次连接最多 2 小时以保留 Workers Free 的内部子请求预算；期间仍应用 `IDLE_TIMEOUT`。隧道每条出站消息最多 16 KiB，不把 RDP 包、TLS 记录和载体帧视为同一边界。Workers WebSocket 没有 drain 指标，Tunnel 向 Windows 的写入另限速并限制单会话累计 8 MiB；该限制不累计 Windows 到浏览器的画面流量。此路径仍需用真实弱网核查；不会自动重放输入或密码。剪贴板、挂载、音频转发不在首版范围。
- `src/worker/rdp-entry.ts` 同一次 Worker 部署，重导出原 DO 类，保持原生 `ctx.access`。RDP 按需加载；仅对带客户端资源的 HTTPS 部署中已验证登录的用户空间首页及 RDP 页面启用 COOP/COEP，运行帧另有严格 CSP；登录页不隔离，不以 Cookie 存在代替验证。WASM 使用已压缩的 vendor 模块，主站 HTML、登录与原 SSH 终端不加载它。`/rdp/:id` 载入同一 CloudSSH 应用与当前主题，通过同源隔离运行帧操作桌面，不启动 xterm/Trzsz。从已隔离用户空间进入及返回均复用原文档，不重新启动首页。返回立即断开并销毁运行帧，复核仍为同一身份后恢复原筛选/分页；身份变化或核验失败则重新进入首页。旧的非隔离主页切入仍需在当前标签重新载入；若有 SSH 标签会先提示，取消可保留会话。Worker 校验当前登录与设备归属后，顶层桌面壳直接消费短期、无凭据的打开意图，不再展示首页加载卡或重复拉取首页配置、身份和列表；各 API 与 WS 的独立校验保留。默认在标签页内显示，延迟数字与「全屏 / 返回」共用标题行，不再为已就绪提示/延迟占用画布高度；返回关闭 RDP 连接并回用户空间，不注销 Windows。父层工具栏全屏按钮、退出全屏按钮和系统 Esc 只改变本地展示；全屏期间锁定运行帧逻辑尺寸，把实际 Windows 画布的四边映射到工具栏下的可用区域，连同原本在帧内的页面留白一起去除。不会裁掉任务栏或改变远端分辨率；宽高比不同时，本地显示会相应拉伸。只变换父层 iframe 的显示，不触发 SDL 画布重建；Esc 后恢复原窗口布局。客户端运行帧不获全屏权限，点击画布仅用于操作桌面。初始与动态尺寸以 CSS 像素为单位（单屏上限 3840×2160），由 FreeRDP 的 MS-RDPEDISP 能力决定能否同步更新远端；不支持时等比显示，不重连或重放输入。

## Edge 风险提示

Edge 显示「已阻止该站点」和「恐吓软件」时，不是 Windows 的 TOFU 证书弹窗。Edge 的 [Scareware blocker](https://support.microsoft.com/en-us/edge/prevent-online-scams-with-the-scareware-blocker-in-microsoft-edge) 可根据全屏网页的画面判断技术支持诈骗。正常远桌也可能被误判，但截图不足以确认具体触发原因或排除网站被篡改。请先返回安全状态，核对站点部署、域名、目标设备与证书，排查非预期脚本和跳转；确认正常后通过 Edge「帮助和反馈 → 发送反馈」向微软提交版本、触发步骤与已脱敏的截图，不提交密码或桌面隐私。不建议关闭保护、忽略警告或换域绕过拦截。

## 维护和验收

- `bash scripts/build-freerdp.sh` 是维护者用的显式重建入口，固定 FreeRDP commit、emsdk 镜像、工具及依赖；普通构建、部署和 CI 不启动 Docker 或下载 FreeRDP。审核上游安全更新和构建/许可证，用 `tests/build/rdp-assets.test.ts` 校验模块、摘要、大小和胶水边界。不要手改压缩文件；更新依赖时重新审核 JS/C++ 钩子。
- 本地门禁：`pnpm run typecheck`、`pnpm test`、`pnpm run build:frontend`、`pnpm run test:e2e`，确认 test/main 打包均用正式 Worker 入口并保留原 DO 绑定。自动化浏览器用例采用模拟数据，不用真实凭据。
- 无改动的设备编辑不会保存或作废租约；实际修改仍会断开该设备的活动桌面。已知断开原因（如空闲超时、会话时长上限）在原状态栏说明，未知错误不展示上游原文。服务器列表按 SSH/Windows 分别保留同账户上次成功结果并支持手动重试；明确失去访问权限时清空列表。
- 真机门禁：在 `test` 启用正式设备配置，用同一 Windows 的公网与 Tunnel 路线分别完成登录、查看和操作。在保持 NLA 的前提下测试证书错误与更新、正确及错误密码、断线重试，另验证启用 Access Service Auth 的 Tunnel。对 1080p 办公操作记录输入到画面的延迟、持续半小时与弱网恢复是否越积越慢。测试结果应分开记录：连通、NLA、首帧、键鼠、延迟；模拟字节成功不等于真机通过。
- 升级后可清理旧 `ENABLE_RDP` 变量或 Secret；旧值为 `false` 也不会禁用桌面。部署后可删除旧 `CLOUDSSH_RDP_TEST_CONFIG` 仓库变量，现有工作流不再读取。此前测试用的公开隧道路由与 token 可在不再使用时撤销。

上游：[FreeRDP 3.33.1](https://github.com/FreeRDP/FreeRDP/releases/tag/3.33.1)、[Cloudflare 出站 TCP](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)、[Cloudflare Tunnel 已发布应用协议](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)。
