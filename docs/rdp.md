# Windows 远程桌面（RDP）

**默认优先 WebRTC**：添加 Windows 后在页面点「下载并绑定此设备」。在目标 Windows 解压并运行这个 ZIP 内的安装器，服务上线后自动绑定；之后只需「打开桌面」。有备用线路时，直连在 RDP 登录前失败会静默使用中继。详见 [连接器安装、绑定及真机验证](rdp-peer.md)。

## 配置设备

1. 通过 HTTPS 登录 CloudSSH。在「添加服务器」顶部切换到 **Windows Server**；不需要 SSH 设备或本地 Windows App。Windows 必须已开启远程桌面和 NLA，且账号有 RDP 权限。匿名用户和一次性 SSH 分享不可用。
2. **连接器**（默认）无需公网地址或入站端口。先保存设备，再按页面提示下载、安装和绑定；此模式没有备用中继。若希望配置备用 **公网直连** 线路，填写公网 IPv4、全球可路由 IPv6（可带方括号）或公网域名/DDNS。域名需要 DNS-only 的 A 和/或 AAAA 记录指向 Windows 的公网入口，不能使用解析到 Cloudflare 代理 IP 的普通橙云记录当作 RDP 直连；用隧道时请选择 Tunnel 模式。端口在独立字段填写，默认 `3389`（1–65535 的整数，沿用 SSH 直连的受限端口规则）；地址不能带端口、协议或路径。已有设备无需修改。标准 Workers 出站不提供实例独享固定公网 IP，也不能直接访问内网目标；不要为测试向全网开放 RDP，有入站白名单要求时优先使用 Tunnel。
3. **Cloudflare Tunnel** 只填写已发布应用的主机名。实际 Windows 端口在 `cloudflared` 服务地址设置（如 `rdp://127.0.0.1:3389` 或 `rdp://127.0.0.1:53389`），CloudSSH 不显示、也不提交端口。它不是 SSH 路由或 Access 浏览器桌面入口。推荐用独立的 Access **Service Auth** 保护该主机名，在设备配置中填该应用的 Client ID / Secret，而不是 Tunnel 安装令牌。
4. 填写 Windows 用户名（默认 Administrator）、密码和可选域（本地账号通常留空）。三种线路都可绑定 WebRTC；已有公网直连或 Cloudflare Tunnel 设备，在编辑时点击主机输入框下方的「WebRTC直连配置」。连接器在线时优先 WebRTC，建立失败且还未到 RDP 登录阶段时静默使用原线路。保存后点击卡片连接；旧设备缺凭据时先「补全配置」。只有身份、主机、线路和直连端口都不变时，密码留空才会保留原值。更改端口视为更换 Windows 目标：须重填密码、重新核对证书指纹，旧票据及租约失效，最近连接时间清空。刷新或打开书签不会自动取回已保存的登录信息。
5. 首次连接应从可信 Windows 管理控制台独立核对证书 **DER SHA-256** 指纹，再点「信任并连接」；Windows 常见的 SHA-1 `Thumbprint` 不能直接比较。指纹变化时会在发送 Windows 登录信息前暂停，显示本次收到的指纹和已保存的指纹，默认焦点为「取消」。确认是计划内换证且已独立核对新指纹，才点「更新指纹并连接」。无需删除设备，也不用重新绑定 WebRTC 连接器。无法核实请取消，切勿只凭弹窗中显示的值信任。

### 在可信 Windows 控制台核对监听证书

在目标机本地或独立的管理控制台执行以下只读 PowerShell。用监听器的 SHA-1 标识找到实际绑定的证书，再对证书 DER 计算 **SHA-256**。不要随意选择证书库中最新的一张，也不要从当前未受信的 RDP 连接取值作为验证依据。

```powershell
$listener = Get-CimInstance -Namespace root/cimv2/terminalservices -ClassName Win32_TSGeneralSetting -Filter "TerminalName='RDP-tcp'"
$cert = Get-ChildItem 'Cert:\LocalMachine\Remote Desktop','Cert:\LocalMachine\My' |
    Where-Object Thumbprint -eq $listener.SSLCertificateSHA1Hash | Select-Object -First 1
if (-not $cert) { throw '未找到监听器绑定的证书，请由管理员核实，不要替换指纹。' }
$sha = [System.Security.Cryptography.SHA256]::Create()
try { [BitConverter]::ToString($sha.ComputeHash($cert.RawData)).Replace('-', ':') } finally { $sha.Dispose() }
```

## 使用与安全限制

- 域名每次连接都向 Cloudflare DoH 查询 A 与 AAAA（DNS 递归解析器仍遵守记录 TTL）。解析失败、无可用结果，或任一地址为私网、保留或不支持的地址时拒绝；只向本次校验过的地址拨号，不再用域名做第二次解析。双栈优先尝试 IPv4；TCP 未建立时可在预算内换地址，一旦建立不因证书错误或登录失败重试另一台机器。
- 同一 DDNS 域名换 IP 不会改变保存的主机、凭据或指纹；只要仍是同一 Windows 证书，无需重填密码。指纹变化仍在登录前阻止；手动修改所保存的主机或直连端口仍视为更换目标。
- 中继首次信任或换证确认时，即使上游已断开，确认框也会在有界等待期内保持可用（浏览器确认窗口 85 秒；会话租约仍须有效）。只有成功保存指纹、且中继确认原上游在等待期间已断开时，工作区才会用新票据重连一次；若设备修订或指纹与刚刚确认的结果不符则拒绝，重连中再次换证也不会弹出第二次信任。会话失效、确认超时和连接中断分别提示，不会因普通握手或登录失败自动重试。
- Windows 与 SSH 设备共用服务器列表、标签、排序和分页，可用 Windows 用户名搜索。直连卡片显示掩码 IP 或域名及已保存的端口，复制仅包含完整主机（不含端口）；Tunnel 只显示和复制域名。收到首帧桌面画面才记录最近连接时间。
- 桌面在同一标签打开。「返回」会断开桌面连接，但不会注销 Windows。全屏默认「仅缩放」，不裁剪桌面，也不主动更改 Windows 分辨率。若 Windows 协商了动态分辨率（RDP Display Control），全屏工具栏也可选「适配全屏」、1280 × 720 或 1920 × 1080。自适应使用工具栏下方的 CSS 像素，不按 DPR 放大，最高 3840 × 2160；Windows 可拒绝调整。切回「仅缩放」时请求恢复入全屏前的大小；退出后恢复普通窗口的自适应，不保存全屏选项。弱网可先试 720p，画面像素更少，但流畅度仍取决于线路及画面变化。
- 桌面就绪或切换全屏后，可直接打字，不必先点击画面；若已主动选中「返回」或正在核对证书，会保留当前焦点。需要时点击画面即可继续输入。在 RDP 工具栏按 `Esc` 不会切换到底层 SSH 标签。
- 画面内右键交给 Windows，鼠标前进／后退侧键不触发浏览器导航。画面外仍可使用浏览器菜单和导航。「右 Shift + D」按普通组合键发送，不是断开快捷键；系统保留的快捷键（如 `Ctrl+Alt+Del`）不保证能从网页发送。
- 右上角直连优先显示选中 ICE 路径的 **WebRTC 线路 RTT**；浏览器未提供近期线路样本时明确标成 **WebRTC · 通道**。公网或隧道中继显示 **中继**（浏览器到 Worker），不记作 ICE 延迟。点击数值可看线路、通道的最新值与最近 30 秒峰值、Windows 上报的 **RDP** 平均 RTT，以及最近采样间隔内 FreeRDP 的浏览器待读取字节峰值。通道探针与桌面共用可靠有序通道，会计入排队等延迟；待读取不等同于未绘制，也不是连接器或网络全部积压。Windows 上报值不是中继到 Windows 的独立分段，不与其他读数相加。这些指标均不测键鼠到画面的延迟，缺失样本显示「—」。
- 对比卡顿时可保持同一设备和线路，分别静置、滚动日志或拖窗口，再用协商后的实际 720p 重复。若只有通道抖动而线路样本稳定，优先查数据排队与端点处理；若新鲜线路样本也升高，再查两端链路。ICE 样本较稀，不保证捕获每个短尖峰；不会根据一笔读数重连、换线路或自动降分辨率。
- 中继线路由处理 WebSocket 的 Worker 出站，不使用 SSH 服务器的地区设置。标准部署的 Worker 默认靠近 Cloudflare 收到请求的位置；Cloudflare [Placement](https://developers.cloudflare.com/workers/configuration/placement/) 是 Worker 级配置，不是逐设备路由。让 Worker 靠近 Windows 可能缩短出站一段，却拉长浏览器到 Worker 的一段，跨境线路也不一定改善。若要评估，建议用独立测试 Worker 对同一台 Windows、相同分辨率和相同画面操作做 A/B，记录首帧、两种 RTT、持续操作体验和断线次数；不要据此为共享的 SSH/RDP Worker 改默认位置。
- Windows 与浏览器建立 TLS/NLA；Worker 在中继路径只转发字节，在直连路径不接触 RDP 字节。Windows 登录和 Tunnel 凭据按账户加密，密钥与数据同库，并非独立 KMS。列表不返回密码、域或 Tunnel 密钥；普通详情和 WebSocket 不交付 Windows 登录。所有者主动连接时，同源 `connect` 在 HTTPS 上只返回禁止缓存的票据和加密登录封装，绑定当前浏览器临时密钥、设备修订和线路。最终选中的客户端只在内存解密后交给 FreeRDP；旧页面需刷新，不降级取明文。这个边界防止在 `connect` 响应或 HAR 里直接看到密码，不防已控制的页面或扩展；HAR 仍可能包含登录票据、保存配置等敏感信息，不应直接分享。
- RDP 设备独立于 SSH 跳板、分享、SFTP、Agent 和 MCP。不提供剪贴板、驱动器挂载、音频转发；不承诺 Kerberos-only、RD Gateway、多屏或完整移动端键盘支持。会话受 `IDLE_TIMEOUT` 及 2 小时上限约束。

若 Edge 显示「已阻止该站点」或「恐吓软件」，这是浏览器的 [Scareware blocker](https://support.microsoft.com/en-us/edge/prevent-online-scams-with-the-scareware-blocker-in-microsoft-edge)，不是 RDP 证书弹窗。先核实站点、部署、配置的 Windows 设备和证书；不可仅凭截图认定误报。确认正常后可向 Microsoft 提交不含凭据及桌面隐私的反馈，不建议关闭保护或绕过拦截。

## Server 2025 / Windows 11：两条线路都没有桌面首帧

WebRTC 和中继只改变 RDP 字节的运输方式。之后都是同一份 FreeRDP 3.33.1 WASM 完成 TLS、CredSSP/NLA、会话激活和图形解码；只有 SDL 真正绘制了非空更新区域才算首帧。旧版的「未收到桌面画面」也用于 30 秒超时，不代表 Windows 已接受凭据，更不能单凭它判定 WebRTC 或 H.264 有问题。

`ERRCONNECT_ACTIVATION_TIMEOUT` 与网页「无首帧」不同：[FreeRDP 的激活循环](https://github.com/FreeRDP/FreeRDP/blob/65bcca1913a28cbdd7eb913599f692bd2b707991/libfreerdp/core/connection.c#L240-L298) 在安全协商启动后，用 `TcpAckTimeout` 作为**进入 ACTIVE 的总期限**，并非每收到一包重新计时。旧配置默认只有 9 秒；CredSSP、通道加入、能力协商或激活收尾都可能耗尽它，错误码本身不能区分哪一步最慢。

- 两条线路现均传 `/timeout:45000`：该版本的原生参数同时设置激活所用的 `TcpAckTimeout` 和虚拟 TCP 的 `TcpConnectTimeout`，不改变 Worker 拨号或 WebRTC 预检的独立上限。浏览器在传输就绪后仍限 30 秒等 TLS 证书，人工确认另限 85 秒；已保存指纹匹配或确认写入成功后重新给首帧 **60 秒**，不因流量或重复回调续期。运行时退出或连接关闭时不必等满 60 秒；激活超时也不自动重试登录。
- 随包构建为 `WITH_RDPEUDP=OFF`。`-multitransport` 将 RDP UDP 能力标志置零，不再向 Windows 宣告无法使用的额外通道；FreeRDP 相应宣告重定向协议 v5 而非 v6。这不关闭 WebRTC 的 UDP、改变中继路线或降低图形能力。以上改动消除了短时限和能力声明这两个已知差异，不证明目标机一定因其中之一超时。

| 当前提示或证据 | 下一步（在同一次连接的时间点核对） |
| --- | --- |
| 尚未验证 Windows 证书、TLS/安全协商失败 | 确认两条线路确实指向预期的 RDP 监听器；查看 Windows **System → Schannel**。证书变化先按上文核对，不要用换信处理密码或图形错误。 |
| 证书已验证、无首帧，但没有原生激活超时 | 反馈提示末尾的**结束来源和「最后观测的 FreeRDP 状态」**。网页等待首帧到期、桌面客户端退出和传输通道关闭并非同一件事。`NLA / …` 表示最后观测到认证阶段；若为 `ACTIVE`，则客户端已进入活动状态，应转查显示更新到 SDL 首帧，而不是再查密码。`不可用` 表示没有可展示的状态，不能反推哪一端断开。 |
| 明确拒绝登录/阻止 NTLM | 查看 **Security** 的失败登录（启用审核时如 4625）与 **TerminalServices-RemoteConnectionManager/Operational**。证书核验早于 CredSSP；不能据此断言密码对错。随包构建未启用 Kerberos；若目标只允许 Kerberos，应使用符合策略的客户端，不要放宽域策略或关闭 NLA。 |
| `ERRCONNECT_ACTIVATION_TIMEOUT` | 反馈页面的 **「超时时的 FreeRDP 状态」** 即可。这个状态直接来自原生等待循环退出时的快照：`NLA / …` 表示正在进行 CredSSP；`MCS_…` 表示连接／通道建立；`LICENSING` 是 RDP 许可阶段；`CAPABILITIES_EXCHANGE_…` 和 `FINALIZATION_…` 是能力交换和进入活动状态前的收尾。它反映的是客户端停留的位置，不代表 Windows 拒绝了请求或某个包在网络上丢失。旧客户端或未知状态不显示。若只观测到原生循环的截止回调，呈现「FreeRDP 的激活等待已到期」而不虚构错误码。核验证书后有无新数据是独立的传输观察，不解释数据内容。 |
| 已协商显示控制（DISP）但无首帧、或明确的图形错误 | 查看 **TerminalServices-LocalSessionManager/Operational** 的会话/桌面启动记录，以及 **RemoteDesktopServices-RdpCoreTS/Operational** 的图形、连接或断开事件。随包构建的 H.264 使用浏览器 WebCodecs，不是 FFmpeg/OpenH264；能协商 DISP 不表示已绘制，也不能证明是编解码器故障。 |

如果已查同次 **RdpCoreTS/Operational**，`144` 仅表示 TCP 正常关闭；可以同时有信息级 `103`（`ReasonCode`），也可以没有。只有 `144`、没有 `103`、`1149` 或 `4625` 时，不能据此确认认证成功、失败或谁先关闭，更不能挪用稍后 `mstsc` 登录的事件来解释网页这次尝试。无需为此注销、重置证书或再次导出整份日志。原生状态只留在本次运行帧内，不打开 DEBUG、不记录原始 PDU、不上报。

对照时记录 `winver` 的完整内部版本（含累积更新）、浏览器及其版本，并在同一台主机、同一账号上用原生 `mstsc` 验证能否进入桌面。若原生也失败，先查 Windows 侧；若仅网页失败，对照另一个当前版本的浏览器以及同条件下的 2022 结果。原生客户端可能使用 Kerberos 或不同图形能力，它的成功也不能单独确定根因。早期 Server 2025 / Windows 11 24H2 有[登录画面冻结的 FreeRDP 上游报告](https://github.com/FreeRDP/FreeRDP/issues/10864)，部分主机应用累积更新后恢复；不要将历史问题等同于本机诊断。反馈仅需上述版本、页面的固定提示、相关事件 ID/状态码及原生客户端结果，不要发送密码、票据、HAR 或完整日志。

## 维护与真机验收

- `bash scripts/build-freerdp.sh` 用于显式重建随仓库分发的客户端。常规构建不运行 Docker 或下载 FreeRDP。更新时审核依赖、许可证与 JS/C++ 钩子，用 `tests/build/rdp-assets.test.ts` 验证模块、摘要和大小；不要手改压缩产物。
- `rdp-devices.spec.ts` 覆盖画布焦点、工具栏、鼠标侧键与首次证书确认（模拟中继和 FreeRDP，使用真实浏览器适配器）；`rdp-native-input.spec.ts` 在 Chromium 中加载随包的真实 WASM，验证 FreeRDP 从内存文件系统读取禁用本地快捷键的配置，以及实际启动参数可发出携带 NLA 的 X.224 协商请求；另用固定测试证书、仅内存的 TLS 对端（不回应 CredSSP），分别让原生激活等待到期、网页先停止等待、传输先关闭，检验三条路径均能保留 `NLA / NEGO_TOKEN`，但不把后两种冒充原生超时。使用合成凭据，不接触 Windows，不验证真实登录或首帧。`rdp-relay-rtt.test.ts` 覆盖证书等待期间读写中断的顺序、租约失效与超时。自动化不能代替真实 Windows 首帧和键鼠验收。
- 用授权的 Windows 主机和已部署的 Cloudflare 测试 Worker 验证，而不是用本地 mock 代替。分别以公网 IPv4、IPv6 字面量、仅 A 域名、仅 AAAA 域名及双栈域名确认 NLA 与桌面首帧，覆盖自定义端口及一条 TCP 路径不可达；DDNS 改址后验证同证书可用、不同证书在登录前被阻止。记录所用地区、线路、证书和首帧结果，不记录密码或未脱敏的地址。
- 另测 Tunnel（包括 Access Service Auth）的 NLA、证书信任与换证、错误密码、桌面首帧和键鼠，并回归断线、1080p 持续操作及弱网；分开记录连通、认证、首帧和延迟。在支持和不支持 DISP 的 Windows 上分别验证默认全屏、适配与固定分辨率（以 Windows 内部显示设置为准）、Esc 返回和画面四角的键鼠定位。

上游：[FreeRDP](https://github.com/FreeRDP/FreeRDP/releases)、[Cloudflare 出站 TCP](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)、[Tunnel 已发布应用协议](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)。
