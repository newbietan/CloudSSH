# #201 实施交接：CloudSSH 站内 Windows 远程桌面

**状态：设计与验收合同，不是已实现的功能，也不是性能实测报告。** 基线：`test` 分支 `983adf8`（2.11.3）。[Issue #201](https://github.com/newbietan/CloudSSH/issues/201) 提出 Windows 图形桌面；下述双线路、站内使用、免额外网关等约束来自维护者后续确认。执行前先读根 `AGENTS.md`、检查最新 `test` 与工作区，不覆盖他人修改，不自行发版、部署或合并。

## 1. 用户最终得到什么

用户保存一台「远程桌面」设备，在 CloudSSH 的服务器列表点卡片，**进入同一站点的独立桌面页**，输入 Windows 用户名、可选域和密码，看到真正的 Windows 桌面。支持键盘、鼠标、滚轮、全屏、明确断开和手动重新连接。允许同一物理机器的 SSH 卡片与 RDP 卡片并存；新建 RDP 卡片不需要填写 SSH 用户、密码、密钥或开 SSH 服务。新浏览器标签页是站内页面，不是启动本地程序或跳转第三方桌面。

| 线路 | 数据路径 | 部署方必须具备的条件 |
| --- | --- | --- |
| 公网 | 浏览器 FreeRDP/WASM ⇄ 同源 WSS ⇄ 实例自己的 Worker ⇄ 公网 TCP ⇄ Windows | RDP 已启用，目标端口对这条出站路径可达。标准 Worker 没有本实例专属的固定公网出口；有固定源 IP 白名单要求时推荐 Tunnel，**不建议向全网开放 3389**。 |
| Cloudflare Tunnel | 同一个浏览器客户端 ⇄ 同一个 Worker ⇄ 出站 WSS 隧道载体 ⇄ 已有 cloudflared ⇄ Windows | 使用专门的公开隧道主机名，ingress 指向 `rdp://<Windows>:3389`（或管理员配置的 RDP 端口），需要时由 Worker 携带该主机名专用 Service Token。已指向 SSH 22 的路由不能当作 RDP 路由。这里**不是** Access 的浏览器渲染页面、App Launcher 或其登录重定向。 |

不另买 VPS、不部署 guacd、不使用公共 HK 节点、不装目标端配套程序或浏览器插件。公网不可达且没有隧道的内网机器不能凭空直连。Worker 只转发 Windows 协议的有序字节，不处理 Windows 登录、不渲染/截屏/转码。Windows TLS、证书验证、NLA/CredSSP、图形和键鼠由浏览器客户端负责。

**首版边界**：仅登录用户自己的已保存设备；建议 `ENABLE_RDP` 显式开启（默认关闭），与 `REQUIRE_GITHUB_AUTH` 独立。**无**匿名/分享、跳板链、SSH、Agent/AI、SFTP、命令片段、MCP、远端 OS 探测、会话录屏或 SSH 风格断线接续。默认禁用剪贴板同步、磁盘/文件/打印机/设备重定向、麦克风和音频；只开放首版需要的显示、输入、可选尺寸协商通道。移动端首要保证能打开、输入、退出；不承诺首版提供原生客户端全部手势或 4K/游戏体验。

## 2. 现有代码：哪些可借鉴，哪些不能照搬

| 现有位置 | 实施时的边界 |
| --- | --- |
| `src/worker/index.ts`、`src/worker/auth.ts` | 使用既有 `getAuthenticatedUser` / `userDbRouteKey`、认证模式与 allowlist；新增精确 `/rdp/…` 和 `/api/rdp/…` 路由，优先于首页 HTML fallback。保留原生 `ctx.access` 身份与 Worker 写请求 Origin 守卫。 |
| `src/worker/user-db.ts`、`src/types.ts` | 复用账户独立 UserDB 与既有加密能力；不要复用 SSH 连接令牌、SSH 凭据或 MCP grants。UserDB 只有一个 Alarm，若用它清理票据，必须与现有记忆及 MCP 排期取最早时间。 |
| `src/worker/durable-object.ts`、`src/worker/dns-check.ts`、`src/worker/tunnel-stream.ts` | 已有公网 `connect()`、隧道 WS 握手和 16 KiB 分帧；只抽取传输需要的部分，不能让 RDP 实例化 `SSHSession`。当前 `checkHostResolved` 仅返回 blocked，解析空结果不会拒绝；隧道读取也不是面向桌面洪流的有界队列，不可直接宣称已满足 RDP 安全与背压。 |
| `frontend/src/server-list.ts`、`frontend/src/main.ts`、`frontend/src/tab-manager.ts` | 复用列表/标签、分页、主题、语言和反馈组件；独立 RDP 页面不启动 `Terminal`、`TrzszFilter`、SSH 抽屉或 SSH 状态机，不能根据 OS 自动转换连接协议。 |
| `scripts/build-html.js`、`src/worker/html-cache.ts`、`wrangler.toml` | 主站仍须是恰好一个 JS 和一个 CSS 内联的 HTML；`src/worker/html.ts` 由构建生成，不能手改。新增 RDP **独立**入口与资源产物，不把 WASM 放进主站 HTML。 |

## 3. 第一道门：先贯通，不先画完整 UI（P0）

可先用 [仅本地的双线路连通性预检](../tests/interop/rdp-check/README.md) 检查配置。TCP 建连或外层 WebSocket 101 只是前置条件，不代表真机桌面、Windows TLS/NLA 或部署后的 Worker 出口验收通过。

1. **固定可审计的来源。** 从上游 FreeRDP 正式维护版本构建 SDL3/Emscripten 客户端；3.33.0 的构建脚本已描述浏览器支持，不能把该版本号当作永远安全的依赖。选定版本/tag **和 commit**，核对安全公告，固定 emsdk、LibreSSL、SDL 等依赖及 SHA-256，记录许可证、补丁、可复现命令、JS/WASM/pthread worker 等实际产物及大小。不要使用会读取凭据的第三方演示站、运行时 CDN 或未知预编译包。
2. **做最小站内测试页与受限连接。** 使用仅测试账户可访问、服务端固定目标的入口；禁止创建通用转发器。先验证原始二进制 WS ↔ 字节流与上游客户端兼容，再验证下文的有界传输适配。记录 Emscripten 创建 WS 的实际线程、URL/子协议选择、收发大小、证书回调、凭据注入/清理、尺寸协商与关闭 API。上游没有提供的钩子应明确列出必要的最小 glue/补丁，不能假设有现成 JS SDK。
3. **两条线必须连到真实 Windows。** 用经授权的同一台 Windows Server（优先 2022 或 2025）、同一分辨率，在 NLA 开启时分别跑公网和 RDP ingress。证明看到桌面、输入有响应、主动退出可回收。公网浏览器测试客户端可以通过 Worker 连到 TCP，不意味着防火墙必然放行；隧道 302/403、非 101 或拿到 HTML 都是失败，不能当成握手成功。
4. **核实证书与认证。** 确认可在向目标发送 Windows 账号认证材料之前验证目标 Windows 证书；证书不对时两个线路都必须拒绝。自签/私 CA 的处理见 §6。上游浏览器构建可关闭 Kerberos；至少实测本地账号的 NLA，域账号/NTLM 策略另列。不能把支持 NLA 写成支持 Kerberos-only、智能卡、Remote Credential Guard 或所有域环境。不开启旧 RDP Security/无 NLA 回退。
5. **核实可交付性。** 在实际构建/Worker 环境验证独立 WASM 的加载、隔离头、Access 身份和两个环境的部署大小（§4）。用 Chrome/Edge 和 Safari/WebKit 记录支持/失败点。输出一份不含凭据、地址和桌面内容的结果单（§9）。

**停止条件**：必须禁用 NLA、忽略证书、关闭同源/Access 检查才能连接；无法提供受控的流量上限；或当前发布方式带不动产物或破坏主站身份。标明具体阻塞，不以 Mock、xrdp、FreeRDP-to-FreeRDP 回环或能打开 Canvas 签为 Windows 成功。未过门槛不要将 PoC 开关默认打开，也不要自行改成 `.rdp` 下载、外部链接、另建网关或 WebRTC。

**真机验收地点（维护者决定）**：可通过 `test` 分支的 CI 部署到既有 `cloudssh-test`，在那里做首次浏览器双线登录、桌面操作及性能实测，不要求维护者使用本机或安装 Windows App 重测。首次真实桌面通过之前，不宣布 P0 完成。预览版默认关闭；只要求当前 CloudSSH 测试站的有效登录（支持单管理员密码，不设额外账号白名单），服务端从测试环境配置取固定目的地及证书指纹，客户端不能提供目标或转发头；不记录凭据。不得把 `tests/interop/rdp-check/` 中纯回环、未接入 CloudSSH 鉴权的工具当成公网 Worker 部署。先通过类型检查、自动化回归、资源和鉴权隔离检查，再推 `test` 触发现有 CI，不直接部署线上生产环境。

## 4. 浏览器与产物交付

- **前端结构建议**：独立 `frontend/rdp/` 页面/入口和 `frontend/src/rdp/` 控制器，不在 SSH 主入口静态导入客户端。主 UI 用普通同源链接打开 `/rdp/session/<profileId>`（可新标签页，`noopener`），不跨页传口令、票据或 `window.opener` 消息。直接打开/刷新该页也须重新鉴权，不能凭 ID 取凭据。未启用/未登录在加载 WASM **前**结束。首次连接才加载大资源；票据在资源和客户端就绪后再申领，避免慢下载耗尽 TTL。
- **首选同一次 Worker 部署**：保留主站内联构建；为 RDP 单独生成 self-hosted、内容寻址的 HTML/JS/worker/WASM 清单。由同一 Worker 以 Wrangler 的 **Data（二进制）/Text 模块**或等价的已验证打包方式，在受限前缀 `/rdp/assets/<digest>/…` 精确返回静态字节（WASM 用 `application/wasm`，不是服务器端 WebAssembly 实例；不能 base64 塞进首页）。不从用户输入拼文件/URL，不允许静态路由吞掉 API。只缓存不可变公开产物；桌面文档、认证、信任记录与票据 `no-store`。处理旧页面与新清单版本不匹配，提示手动刷新，不能混用 ABI。
- **不能为了方便就在主 Worker 上启用 `[assets]`**：[官方说明](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations)有静态资源路由时原生 `ctx.access` 不会传给用户 Worker，`run_worker_first` 不是身份传递保证。本项目 Access 网页、MCP 和 SSH CA 都依赖它。不得改信任外部请求头、降级认证或默默引入第二个服务。若 Data/单 Worker 产物方案超限，提交实际字节数与备选（如同源 Worker 读仅限不可变产物的 KV，列出额外绑定和发布步骤），**先获维护者同意**。不能让自托管者额外维护资产服务器。
- **页面隔离**：仅 `/rdp/session/…` 独立顶层页设置 `Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Embedder-Policy: require-corp`；其同源资源、线程脚本、OAuth/Access 过期时的行为必须实测。配置精确 MIME、CORP、`nosniff`、`Referrer-Policy: no-referrer`、`frame-ancestors 'none'` 及最小 CSP（WASM 编译/Worker 仅按真实需要开放）。不要给普通首页、分享、认证跳转、Turnstile 或 MCP 加全站隔离头。先检查 `crossOriginIsolated`、`SharedArrayBuffer` 等必需能力；WebCodecs/硬解等为探测后的可选优化。
- **供应链及可复现性**：单独提供维护者重建脚本与清单；普通 `pnpm install --frozen-lockfile` + 构建/部署不从互联网临时下载可执行组件、不执行未验证构建、不要求最终部署者安装 Rust/CMake/emsdk。可将审核过的固定 release 产物与许可证随源码提供；先量真实大小和仓库影响，不擅用 Git LFS。用生产与 `--env test` 的 Wrangler dry-run 比当前平台上限；不要仅量 `.wasm` 或写死历史压缩上限。验证原 Dashboard/Git/CLI 支持口径，若上传单文件无法携带模块要明确报告，不能冒称兼容。RDP 不应增加 SSH 用户的首页下载量，但要如实计入 Worker 上传和冷启动成本。

## 5. 模型、账户与接口合同（路由为建议命名）

**不要要求先保存一台假 SSH 服务器。** 优先在同一 UserDB 加独立的 `rdp_profiles` 表。RDP-only 卡片在前端列表层以带判别字段的视图模型合并（键如 `ssh:7` / `rdp:7`）；不要把 RDP 行混进 SSH 列表 API、跳板下拉框、分享或 MCP 授权选择器。两表不隐式按主机名关联，不同步密码/证书或级联删除另一种卡片。保留原搜索、标签、排序、分页和匿名 SSH。

- 档案字段：`id, user_id, name, tags, route_kind, direct_host, direct_port, tunnel_hostname, rdp_identity, profile_revision, created_at, updated_at`，外加可选隧道 Service Token 的服务端加密存储和目标证书指纹。`rdp_identity` 是校验 Windows 证书的预期 DNS/IP，不是内网路由参数；隧道外层 hostname 与它可以不同。直连默认端口 3389，首版只允许管理员批准的 RDP 端口（最小默认仅 3389），隧道只配置公开 HTTPS 主机名、实际 Windows 端口由 ingress 决定。地区与主机不能触发 IPinfo；无需 SSH OS 探测。规范化长度、数量、名称和标签，建议每账户 ≤100 台，读写均限定 `user_id`。
- 使用 SQLite 幂等建表/索引与仓库既有账户加密能力；不保存 Windows 密码或 Windows 会话票据，无自动保存用户名。GET 只返回脱敏元数据/是否已有 Access 凭据；更新区分省略、替换、清空，变更隧道域名或切换直连必须清除原 Service Token，不能把凭据发送到新地址。路由/身份变更清除旧证书信任；修改/删除使旧票据失效，删除清除该档案的票据、信任及连接资源。不要挪用 SSH host-key 表或 SSH session 的代际。

| 路由 | 谁可调用／服务端动作 |
| --- | --- |
| `GET/POST /api/rdp/profiles`；`GET/PUT/DELETE /api/rdp/profiles/:id` | 当前已登录所有者；校验字段与路由互斥。列表不含 Windows/Access 密钥、票据或解密后的配置。删除/更新按账户和修订检查；返回三语映射用的有限错误码。 |
| `PUT /api/rdp/profiles/:id/trust` | 仅在用户核对自签指纹后更新信任（含预期旧指纹/修订的 CAS；冲突重读），绝非“接受所有证书”。不许直接附在建连/重试请求中悄悄改信任。 |
| `POST /api/rdp/profiles/:id/connect` | 服务端派发短时票据（建议 30 秒、256 位随机、仅存摘要），绑定用途 `rdp`、完整账户路由、认证模式/代际、当前浏览器会话、profile ID/修订与有效期。HTTP `no-store`，不在 URL、日志或 localStorage 携带票据。限制发行速率和待用票据数量。 |
| `GET /api/rdp/session`（同源 WS upgrade） | 先验 WS、**必须存在且精确匹配的 Origin**、功能开关和当前登录，再收一个有大小/时间上限的认证首帧。服务端按当前账户路由原子消费票据并重查档案/修订/所有权/模式/有效登录，随后才允许拨号。消费失败/拨号失败不返还票据；不能接受前端传 host、port、headers、user_id、代理 URL 等。 |

所有 RDP 写请求也要求明确同源 Origin；不要改变项目其他 API 原有脚本兼容性。密码模式绑定哨兵 `-1` 及密码代际；GitHub 重查 allowlist；Access 使用可信 `ctx.access` 与完整邮箱派生路由（不能拿 `-2` 当账户），禁止仅用可由外部伪造的头部或机器准入推导网页登录。会话绑定要与既有认证模式相容：GitHub/密码用服务端可验证的会话摘要或等效绑定；原生 Access 模式若没有本地会话 ID，使用额外的短效同源 `Secure; HttpOnly; SameSite=Strict` 浏览器绑定（可采用 `__Host-` cookie），而不是只绑定邮箱。不得把 SSH/分享/MCP 凭据兑换成 RDP 票据。关闭特性时 API 在任何副作用前拒绝，客户端 `false`/缺失开关均不显示入口。

## 6. 协议、安全与故障处理

**信任分层**：浏览器↔本站 TLS、Worker↔隧道 HTTPS、FreeRDP↔Windows 的 RDP TLS 是不同层。Windows 证书应在 WASM 端通过受信链和 `rdp_identity`，或在强制 NLA 前提下按经人工独立核对的证书 SHA-256 指纹严格匹配。需证明实际 WASM TLS 栈的 CA 来源/主机名检查，不能假定会用浏览器系统证书库。首见未受信与意外更换都先终止、不发认证材料；显示预期身份、指纹、核对说明，取消保留旧信任；任何改变都要显式确认、CAS 持久化、领新票后重连。若当前 WASM 不能安全暂停确认，则先失败、做只读探测后重新连接，不可用 `/cert:ignore`、全局 TOFU 自动接受或禁用 NLA。不要把 Access Service Token 当 Windows 凭据。用户只在本站页面输入 Windows 凭据，优先通过专用内存回调传入，禁止 URL/日志/诊断/缓存/持久化和命令行式口令打印；关闭清字段、销毁 WASM/线程并尽力清内存，不承诺 JS 字符串可物理擦除。

**公网目的地**：从服务端不可变档案取值；严格解析标准域名/IP，拒绝私网、回环、链路本地、组播、保留/文档地址、IPv4-mapped IPv6 等非公网目标。域名必须有成功、有界的 A/AAAA 结果，校验全部地址、拒绝混合/空/失败结果，拨号**固定到已核验的公开 IP**，保留原名字给 Windows TLS，避免校验与拨号二次解析。设置 DNS、连接、写入 deadline；不要无界重试多个地址。隧道只连接经验证的公开域名、固定 HTTPS/根路径，拒绝 URL/path/自选头与重定向；仅向原凭据绑定域名发 Service Token。DoH 为安全检查，不把 HTTPS/WSS 换成 IP 导致丢失 SNI；非 101、不具 WS、拒绝或超时均失败关闭。任何从浏览器可见的数据都不能指示连接器访问任意内网地址。

**生命周期与预算**：新建独立的生产 RDP relay，首选普通 Worker per-WS + 现有 UserDB 负责票据和账户级有界租约，不占用 `SSHSessionDO`，不承诺断线恢复。若要新 DO，先说明必要性与活跃时长成本，两个环境同步绑定、追加未用 migration tag（当前至 `v3`），绝不能改写旧 tag 或删除 Worker。普通 Worker 也要真实运行测试长连接、断网/部署重启和配额，不保证永久可用。

- 建议初始保护值（集中到 `src/rdp-policy.ts`，非平台保证）：已登录、待验票的 WS 首帧 ≤4 KiB、5 秒；拨号 10 秒；每账户最多 2 个活动桌面、签发票据 10 次/分钟、待用票据 ≤8。UserDB 在同一临界区完成票据单用与占位；例如每 15 秒最多续租一次、45 秒未续租过期，并复查档案/可验证的会话撤销。旧的 close/renew 不能释放或复活替代租约。关标签、本客户端登出/换号、手动断开立即关；远端删除/注销按实际可验证边界回收，不宣称能绕过边缘 Access 会话时效实现全网即时撤销。
- **不做无界 WS 双向复制。** 采用同源受控浏览器 transport adapter：对 FreeRDP 暴露纯有序字节流，对 Worker 承担票据握手、代际和累计流量确认。可用二进制消息传 RDP 字节、仅有限类型的小文本消息传控制；Windows TCP 或隧道内绝不能收到控制帧。只有认证成功并收到 `ready` 后才能交付 RDP 数据。上游若声称只接受 websockify 二进制流，要在它实际的 socket 层/线程适配，**不可把 JSON/ACK 直接喂给 WASM**，也不要全局 monkey-patch 整站 WebSocket。仅部署 PoC 的 raw WS 基线不能直接上线。
- 初始建议：应用数据帧 ≤64 KiB、有界在途与入站各 ≤4 MiB/方向/会话（按实际内存副本合计，另限控制帧频率/数量）；TCP `reader` 遇到窗口满停止读，写端串行按 `writer.write()` 完成推进。下行 ACK 代表 **WASM/适配层实际从其有界接收队列消费的字节**，不是收到 JS `message` 或画面已绘制；上行 ACK 代表应用已从有界队列向出站传输提交，不宣称原生 WS 队列已排空或数据已到 Windows；不能将 `ws.send()` 返回当作 drain。公网和隧道都要实测慢端；隧道无可靠 drain 信号时另设入站速率/突发预算、写时限与硬关闭条件，如仍无法证明有界则不发布。仅在确有在途积压且 30 秒无有效进展时清理，正常静止桌面不应超时。显式限制隧道推送入站队列，达到预算不能暂停时终止，不用无界 `controller.enqueue`；向 cloudflared 的每条加密后载体消息 ≤16 KiB，保序保尾片，不把该上限套给公网 TCP，不去掉现有 SSH 的节奏。压测后有依据才调窗口。
- 只有当前桌面的真实键鼠等交互刷新用户空闲时间；收到加密字节、画面、ACK 或心跳本身不算。取既有 `IDLE_TIMEOUT` 策略（含 `0`），不解析加密数据来猜交互；网页活动通知绑定当前连接代际并限频，不续期证书信任或绕过会话撤销。预算/证书/协议异常 fail closed，丢连接不丢弃任意 RDP 字节后继续解码、不重放输入、不自动重发凭据。明确“断开桌面”≠“注销 Windows”。close/abort/EOF 都幂等，释放 TCP/WS、timer、reader/writer、租约、消息队列与浏览器线程。
- i18n 三套词条只显示分类错误（不可达、认证失败、证书变更、隧道拒绝、浏览器不支持、过载等），处理慢速/键盘布局、Esc/失焦释放按键、手动退出。诊断仅阶段、数值计数、持续时间和固定错误码；不要记录主机、账户、域、隧道头、票据、剪贴板、输入、原始帧或桌面截图。解密后的浏览器就是信任边界，不能声称能抵御本站脚本或部署者失陷。

## 7. 实施顺序与交付物

| 阶段 | 主要交付物 | 可以进入下一阶段的条件 |
| --- | --- | --- |
| P0 可行性原型 | §3 双线最小桌面、上游版本/补丁/许可证、Windows TLS/NLA 验证、字节/线程适配及资产模型 | 两线实机均成功、安全边界成立；不满足按阻塞报告。没有可授权的真机时可以编写不依赖真机的代码/测试，但不得宣布这一关通过。 |
| P1 构建与页面骨架 | 建议 `scripts/build-rdp*`、独立 RDP 入口、生成的内容清单，Worker 资源路由、开关和三语错误页 | 冻结安装可复现；两环境 dry-run；SSH 首页零 RDP 请求，COOP/COEP 作用域正确；Access 网页/MCP 不受影响。 |
| P2 账户与策略 | 建议 `src/rdp-schema.ts`、`src/rdp-policy.ts`、`src/worker/rdp-store.ts`，UserDB 路由、票据、信任、租约、加密凭据 CRUD | 并发单用、完整账户隔离、删除/变化/撤销处理和敏感字段测试通过。 |
| P3 双线路 relay | 建议 `src/worker/rdp-relay.ts`、`rdp-transport.ts`，独立于 SSH，接入 §6 有界适配器 | 相同 WASM 客户端走两条路径，二进制顺序/分片、短写/慢读、证书与拒绝路径均测试。 |
| P4 产品 UI | RDP-only 创建/编辑/删除/卡片；站内桌面页与信任对话框、连接/取消/手动重连；三语、键盘和无障碍 | 生产产物真实加载；不实例化 SSH 专用模块；同源身份、超时、旧帧、换号/关闭无串线。 |
| P5 验证与文档 | 构建/Worker/浏览器回归、真实 Windows 结果、README 中英配置/限制、`AGENTS.md` 与测试说明 | §8/9 有证据，原 SSH/SFTP/MCP 等门禁保持通过，否则明确未验证项。维护者决定是否开放开关及发版。 |

文件名为边界建议，允许结合最新代码调整；不借机大规模重构 SSH 或无关 UI。UI 标识优先用已有图标，新增本地字体连字要遵守裁剪字体与 Pages 同步规则。

## 8. 自动化验证（必需与手测分开）

- **单元/集成**：`tests/worker/rdp-*`、`tests/rdp-*`，固定可控字节流/计时器。覆盖各种登录模式、两个不同 Access 邮箱、跨账户相同 ID、密码换代、GitHub allowlist、匿名/分享/MCP/SSH token 拒绝；REST/WS 跨源及 WS 缺 Origin；并发重放、到期、旧档案修订、删改竞态、旧租约清理。对 DNS 失败、非公网拒绝、结果固定、Service Token 换域不继承/不跟随 3xx 做防御性测试，不接触实网目标。
- **数据完整性**：随机大小的正常二进制块往返、合并/拆分、末片和 EOF 排空；验证隧道载体上限与公网不误分帧，ACK 代际、越界、反压、慢消费者、超时、双关/取消资源释放。用确定性计数或哈希、窗口高水位验证，不以 CI 机器的毫秒数评性能。上下行都不可把凭据或协议数据记日志。
- **构建/浏览器**：`tests/build/` 验证清单、来源哈希、MIME/隔离头、产物大小/许可证、连续构建一致、未知资产 404 而非 SSH HTML。用真正的产物启动 WASM 和 pthread 至“准备连接”，不能全靠 mock canvas；主站无 RDP 资源请求。`tests/e2e/rdp-*.spec.ts` 走 `tests/e2e/fixtures.ts`，按方法显式 Mock；覆盖桌面 Chromium、WebKit，手机 smoke，登录过期、取消证书、错误/重试、全屏退出、表单无障碍/三语。保留原 E2E 同源和 Worker 生产 HTML 检查；不要用无保护临时 RDP 服务跑公共 CI。
- **基础门禁**：`pnpm run typecheck`、`pnpm test`、`pnpm run build:frontend`、`pnpm run test:e2e`（或现有 `pnpm run verify`）；补充 RDP 再现构建、生产/test 的 `pnpm exec wrangler deploy --dry-run` / `--env test --dry-run`。运行 dry-run 不是真实部署。脚本应自动检查上传内容、资产在包内、体积和冷启动风险；任何变更要同步 CI 的产物复用、无 Secrets 的 PR 门禁、Fork 策略。不要修改版本号、发布 PR 或部署测试环境来代替本地验证。

## 9. 真机验收、性能和上线决策

由维护者提供**经授权**的 Windows、RDP Tunnel、可测账号和可选测试实例；通过私密渠道提供，不写入仓库/issue/CI 日志。先测同一台 2022/2025 Windows 的公网与隧道，两边各测本地账号、正确/错误密码、受信/拒绝/换证、关闭再连；有域环境才报告域认证支持。用真实 cloudflared 验证 101 握手与 NLA，不用 SSH ingress 或 Cloudflare 托管网页 RDP 冒充站内测试。公网不可安全开放时用授权的短时受控环境或标记待测，不能要求用户放开安全组给全网。不要把已知目标换成任意公网主机。

建议的**首版办公目标，不是已经达到的指标**：以 1920×1080、固定缩放和工作负载，分别测桌面空闲、记事本输入、滚动、拖窗；两条线路各 ≥3 轮、每轮 ≥50 次输入，记录公网和隧道分别的结果。示例目标：路径 RTT ≤50 ms 的受控网络上，键入到远端字符可见 P95 ≤150 ms；WASM 已就绪、无人工输密等待时，发起认证到首个可交互桌面 P95 ≤5 s（首连样本不足时列原始分布/最大值）；首次资源传输、模块初始化、TCP、TLS/NLA、首屏分别计时。对同机原生 `mstsc` 做对照，原生 UDP 与网页 TCP 的区别注明，不许用 ping/本地回显或模拟帧率代替操作延迟。

再做 ≥30 min 的持续会话、弱网（示例 1% 丢包/抖动）、短暂断网、关闭页面和多会话测量；记录连接结果、输入 P50/P95、掉帧/长停顿、字节/队列高水位、内存趋势、浏览器 CPU、Worker 调用/CPU 及可能的 DO 时长。用隔离测试桌面的非敏感标记测输入到画面，不将生产按键/画面收作遥测。通过标准：无持续增长/长期落后画面，能恢复到实时或按预算明确终止；弱网不冒充无感重连。若某线路/浏览器不达标，列瓶颈与复测条件；不得以降低验证标准、隐藏错误或默认启用为替代。

结果单最少包含：commit、上游及编译器版本/摘要、Windows/cloudflared/浏览器版本、受测模式、网络条件、各线路通过/失败/未测、性能数据、构建/回归命令与结果、受影响部署方法、回滚方法。用户停用 `ENABLE_RDP` 后不得再新发票/拨号；后台有界终止当前连接。保留用户档案、不删除任何 Worker/旧 DO/SSH 数据。不要宣称关闭连接会注销 Windows 或清除远端工作。

## 10. 给 6.2 sol xhigh 的启动指令

> 请先读 `AGENTS.md` 和 `docs/rdp-implementation-plan.md`，在 `test` 分支按 P0–P5 实现 #201 的**站内** Windows 远程桌面。公网及 Cloudflare Tunnel 共用浏览器 FreeRDP/WASM、复用现有 Worker 做有界字节转发；不加 AI、SFTP、片段或公共网关。先做上游版本/安全/产物与双线实机的可行性门，不得用不校验证书、关闭 NLA、展示外部桌面/本机客户端或 mock 成功交差。每阶段记录修改、验证命令、结果与未验证项。缺授权 Windows、隧道或生产形态测试环境时列出需要维护者提供的条件，不自行获取凭据/部署；未通过不得标记完整实现。保留现有 SSH、Access、MCP、构建、三语和测试约束，不改版本、不发版。

### 一手参考

- [FreeRDP 3.33.0 浏览器支持](https://github.com/FreeRDP/FreeRDP/releases/tag/3.33.0)；[对应 Emscripten 构建脚本（线程、隔离头、WS 桥、Kerberos 等选项）](https://github.com/FreeRDP/FreeRDP/blob/3.33.0/scripts/emscripten.sh)。选定新版后重核，不把其他产品的 RDCleanPath 网关要求套到 FreeRDP。
- [Workers 出站 TCP 与目的地限制](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)；[Tunnel 发布协议（RDP over WebSocket）](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)。
- [Worker 部署限制及度量](https://developers.cloudflare.com/workers/platform/limits/)；[静态资源路由与原生 Access 上下文](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/#cloudflare-access-context)。
