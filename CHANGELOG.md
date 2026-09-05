# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-09-05

### Added

- **命令片段库抽屉式面板重构（对齐 SFTP 规范）**：
  - 彻底摒弃原有的小弹窗（Dialog）设计，对齐 SFTP 与 Agent 规范，重构为右侧滑出抽屉（Slide-over Drawer Panel），宽度自适应 `min(clamp(440px, 45vw, 680px), 100vw)`，移动端自适应全屏。
  - 抽屉展开时左侧终端保持可见，用户可在同一屏幕内完成片段浏览、填入终端或执行验证。
  - 表单重构为内联折叠模式（Collapsible Form），默认收起，点击“+ 新建”或“编辑”平滑展开，大幅释放可视空间，单屏可展示 10+ 条片段卡片。
- **命令片段分类管理体系（Category）**：
  - 顶部增加横向分类筛选胶囊栏（Category Chips）：`[全部 (N)] [分类A (x)] ... [未分类 (z)]`，动态去重聚合各分类片段数量。
  - 表单内新增分类输入项，搭配 `<datalist>` 分类建议自动联想，支持直接录入新分类或快速复用已有分类。
  - 联动检索：分类筛选胶囊与搜索框关键词（支持匹配名称、命令、分类）执行交集过滤，支持精准检索。
- **后端架构与存储层无缝迁移**：
  - `src/snippet-schema.ts`：扩展 `SNIPPET_CATEGORY_MAX_LENGTH = 30` 与分类字段规范化校验。
  - `src/worker/user-db.ts`：SQLite `command_snippets` 表动态追加 `category TEXT NOT NULL DEFAULT ''` 列，启动时通过 `PRAGMA table_info` 自动幂等迁移，旧数据自动归入“未分类”，零停机零风险。
  - `frontend/src/snippet-store.ts`：云端（`RemoteSnippetStore`）与本地（`LocalSnippetStore`）存储层同步扩展 `category` 字段。
- **UI 交互与终端原生质感优化**：
  - 优化 Header“云端同步 / 本地存储”为状态圆点指示器，卡片分类重构为 `#tag` 格式、动态参数重构为 `{ }` 元数据格式，彻底消除与操作按钮的视觉混淆。
  - 修复搜索输入框内放大镜图标因简写 padding 导致的字形裁剪与重叠问题，规范居中布局与一键清空按钮。
  - 移除前端文案中的 emoji（将 `💡` 替换为终端原生风格的 `[!]` 符号）。

## [2.0.0] - 2026-09-04

### Added

- **代号 Gem-Alpha 版本发布**：围绕核心交互优化、SFTP 深度体验、命令片段库增强、多标签页上下文操作、AI Agent 体验升级及架构单体解耦瘦身展开的重大版本里程碑。
- **架构深度解耦瘦身**：
  - 抽离 `ShareAuditWriter`（`src/worker/share-audit-writer.ts`），解耦分享审计记录持久化管道，封装防抖刷新与互斥写锁。
  - 抽离 `KeyboardInteractiveAuthHandler`（`src/worker/ssh-interactive-auth.ts`），解耦 RFC 4256 交互式键盘认证状态机，独立管理多轮挑战 ID、超时看门狗及组包响应。
  - 抽离 `DetachedSessionBuffer`（`src/worker/ssh-detached-buffer.ts`），解耦弱网断线保持 128KB 有界环形缓冲队列与重连补偿逻辑。
  - 抽离 `detectAndPersistRemoteOS`（`src/worker/os-detect.ts`），解耦远端操作系统探测执行器，独立管理命令探测与 UserDB 持久化。
  - 解耦 SFTP 在线编辑与交互体系：抽离 `SFTPEditorCoordinator`（`frontend/src/sftp-editor-session.ts`，编辑挂载与冲突比对）、`sftp-dialogs.ts`（文件/目录创建/重命名弹窗与合法性校验）、`sftp-helpers.ts`（面包屑与三向排序辅助）与 `sftp-transfer.ts`（传输状态模型）。
- **SFTP 路径面包屑与多维排列表头**：引入可点击导航的面包屑路径组件，保留输入框快速跳转与失焦自动恢复；表头支持按名称、大小、修改时间三向排序，目录智能置顶。
- **SFTP 工具栏新建文件**：点击工具栏「新建文件」按钮呼出命名弹窗，通过 0 字节探测上传后无缝调起在线编辑器。
- **命令片段模糊搜索与一键复制**：片段库新增实时搜索过滤，支持名称与命令模糊匹配；列表项增加一键复制到剪贴板按钮。
- **命令片段动态参数占位符**：支持 `{{variable}}` 语法，插入或执行前自动提取变量并弹出输入弹窗，支持默认值与输入记忆。
- **服务器一键克隆**：服务器卡片增加复制操作，快速复用主机、端口、用户名、跳板机关系与标签，自动附加 `(Copy)` 后缀并安全剔除敏感凭据。
- **多标签页双击重命名与上下文菜单**：双击标签页标题直接进行内联编辑（`Enter` 保存，`Esc` 取消，空值自动恢复原名）；右键标签弹出操作菜单（重命名、克隆会话、关闭其他、关闭当前）。
- **终端快捷键增强**：macOS 新增 `Cmd+F` 调出搜索栏，`Cmd+K` / `Ctrl+Shift+K` 清除终端屏幕缓冲区（`terminal.clear()`），并完好保留 Linux/Bash 默认的 `Ctrl+K` 剪切行尾逻辑。
- **AI Agent 助手体验全面升级**：
  - **动态 Clamp 响应式窗口**：参考 SFTP 采用 `min(clamp(420px, 40vw, 600px), 100%)` 弹性宽度策略，顶栏对齐 `h-12` 规范并内联 `smart_toy` 助手图标。
  - **桌面端上下垂直范围严格限制于终端窗口内**：分栏高度严格限制在 `#terminal-area` 内部，绝不遮挡顶部状态栏右上方的双端延迟展示（`#term-info`）与连接状态。
  - **移动端全屏覆盖与软键盘联动**：移动端保持全屏覆盖（`position: fixed; top: 48px;`）保证小屏下充裕的对话阅读空间；打开 Agent 时联动隐藏底部软键盘终端快捷工具栏，彻底解决输入框和发送按钮被遮挡问题；退出返回终端后自动恢复工具栏。
  - **诊断 Prompt 预设与触控热区强化**：提供 4 组一键场景诊断 Prompt 胶囊（分析报错、系统负载、端口网络、Docker 状态），移动端全面优化 Prompt 胶囊（`32px`）、发送按钮（`40px`）、代码块操作（`30px`）和高危命令确认弹窗按钮触控热区；支持按 `Esc` 快速退出 Agent 返回终端。

### Fixed

- **多标签页空值重命名卡死**：修复标签页重命名提交空字符串或纯空白时卡死输入框状态的问题，空值自动恢复原标签名。
- **右键上下文菜单监听器泄漏**：修复连续右键或外部点击关闭右键菜单时，全局事件监听器残留的隐患。
- **移动端 AI Agent 底部输入框被工具栏遮挡**：修复移动端打开 Agent 时底部软键盘终端快捷键工具栏覆盖输入框与发送按钮的层级冲突。

### Changed

- **代码健康规范治理**：全局显式声明 `parseInt` 10 进制基数，消解无用构造函数、多处冗余导入、收敛严格类型断言与类型系统静态警告。

## [1.14.4] - 2026-09-02

### Fixed

- **SFTP 在线编辑错误横幅绕过消息边界校验**：`handleSFTPError` 的 edit 分支在无待决请求时此前用原始 `msg.message` 直接展示面板错误横幅，绕过边界校验；统一改用校验后的 `message` 变量，与 `rejectEditRead` 同源。保留 hadPending 以 waiter 为准的判定并补充注释：超时回调置空 waiter 后 finally 在同一微任务级联中复位 `editReadActive`，迟到错误帧不可能于读取在途时被处理，横幅兜底不构成双重报错。

## [1.14.3] - 2026-09-02

### Changed

- **SFTP 双击智能“打开”**：文件管理器双击文件不再一律下载——目录仍为导航，文本文件直接打开在线编辑器；文件明确不可在线编辑时（超过 2MB、空字节嗅探判定的二进制、内容无法解码）自动转为下载，不打断操作流。回退下载统一走既有串行下载队列，避免与在途下载并发占用二进制流；`sftp_error` 增加结构化 `code`（`binary`/`too_large`），消息边界白名单校验后才进入回退判定，超时/权限等瞬时错误保持提示、不触发静默下载；编辑读取增加互斥保护，防止并发请求覆盖分块归属。显式「编辑」按钮行为不变。
- **回归测试**：新增双击智能打开单元测试（回退判定语义）与 4 条 e2e（文本→编辑器、二进制→转下载、超大→直接下载且不发起编辑读取、目录→导航），既有 SFTP 在线编辑相关 e2e 保持全量通过。

## [1.14.2] - 2026-08-30

### Fixed

- **匿名连接页删除最近记录误触发建立连接**：最近连接列表的删除按钮未声明 `type`，位于 `connection-form` 内默认按 `type="submit"` 处理，点击「x」在删除记录的同时会误提交表单并触发 `handleConnect()` 建立新连接；`stopPropagation` 无法阻止按钮的默认表单提交动作，删除按钮显式补上 `type="button"` 根治误触连接。
- **连接成功后清空敏感凭据字段**：连接成功后清空密码/私钥输入框，避免关闭 SSH 会话返回匿名连接页时密码仍残留于输入框（此前密码残留会放大删除按钮误触连接问题——密码非空时点「x」直接建立连接，清空后才只能看到删除效果）。
- **回归测试**：新增源码级断言，守护删除按钮必须显式 `type="button"`、敏感字段清空语句必须位于 `terminal.connect` 之后，防止该问题回归。

## [1.14.1] - 2026-08-30

### Added

- **SFTP 编辑器自动换行**（#113）：编辑器页脚新增「自动换行」开关，基于 CodeMirror 6 `EditorView.lineWrapping` 经 `Compartment` 动态切换（不重建编辑器、不丢状态，切换后焦点回到编辑区）；触屏/窄屏（`pointer: coarse` 或 ≤520px）默认开启、桌面端默认关闭由用户手动开启，检测口径与编辑器 16px 字号媒体查询一致；偏好持久化于 `localStorage`（`cloudssh_editor_wrap`），隐私模式等存储不可用时静默回退设备默认值；移动端页脚三按钮空间优化（min-width 96→84px，320px 窄屏不溢出）；i18n 双语词条；新增桌面/移动双视口 e2e 守护默认值、切换与持久化。

## [1.14.0] - 2026-08-29

### Added

- **SFTP 在线编辑文件**（#111）：在 SFTP 文件管理器中直接编辑远端文本文件。后端新增 `sftp_edit_read` 消息：仅限 ≤2MB 文本（前后端常量一致），空字节嗅探（前 8KB，与 Git 同策略）拒绝二进制后才下发，`sftp_edit_start`（mtime/size 元数据）→ 128KB 二进制分帧 → `sftp_edit_done` 流式复用既有传输管道；前端基于 CodeMirror 6（单 bundle 内联构建）提供模态编辑器，支持 shell/YAML/JSON/Python/Markdown/HTML/CSS/Dockerfile/systemd 等语法高亮，配色全部映射主题变量跟随亮/暗/自定义主题；保存前以 mtime+size 快照比对做冲突检测，远端已被修改时要求显式确认覆盖，保存复用既有上传覆盖通道并在成功后刷新冲突基线；保留原文件换行符（LF/CRLF）与 BOM（字节级往返测试）；UTF-8 严格解码可编辑，GBK/GB18030 自动识别并以只读模式打开；关闭前未保存修改二次确认；编辑读取/保存随分享会话 `allowSftp` 门控并纳入 `edit` 审计操作。
- **编辑器移动端适配**：≤520px 窄屏下编辑器近全屏（含左右安全区），软键盘弹出时跟随可视视口收缩；关闭按钮 44px 触摸目标、保存按钮加大；触屏/窄屏下 CodeMirror 编辑区与搜索面板输入框字号提升至 16px，规避 iOS 对 contenteditable 聚焦时的强制页面缩放；新增 390×844 窄视口 e2e。
- **SFTP 面板桌面宽度有界弹性**：固定 420px 改为 `clamp(420px, 40vw, 600px)`，1280 主流笔记本下面板 512px、文件名列 +92px，1500px 起 600px 封顶保持终端可见；移动/平板全屏行为不变。

### Fixed

- **SFTP 操作栏按钮文字竖排**：新增编辑按钮后 6 个按钮总宽超出固定面板宽度，WebKit 对嵌套 flex 的内在尺寸计算把 CJK 标签压成单字竖排（Chromium 则表现为压缩换行）；防换行规则提升为全局无条件生效（标签 `white-space: nowrap` + 按钮 `flex: 0 0 auto` + 空间不足时整栏横向滚动），移动端媒体查询仅保留 40px 触摸目标；新增双视口 e2e 并纳入 webkit-mobile（iPhone 13）项目守护。

### Changed

- wrangler 升级至 4.125.0：修复 CI 部署时报 "Unable to fetch bindings, routes, or services metadata from the dashboard"（Cloudflare API 侧错误）；4.127.1 因发布不足 7 天被 `minimumReleaseAge` 供应链策略拦截，版本成熟后再跟进。

## [1.13.1] - 2026-08-28

### Added

- 支持直接粘贴 PKCS#1/PKCS#8/SEC1 封装的 PEM 私钥（RSA/EC/Ed25519）：新增最小 DER/ASN.1 读取器（`src/ssh/der.ts`）与 PKCS 解析器（`src/ssh/pkcs.ts`），`auth.ts` 按 PEM 封装统一分发，RSA/EC/Ed25519 各路径复用共享构建器产出一致公钥 blob；兼容 macOS `ssh-keygen -m PEM` 的 SpecifiedECDomain 显式曲线参数与 Ed25519 PKCS#8 嵌套 OCTET STRING 结构（RFC 8410）；公钥/X.509 证书/PuTTY PPK/口令加密 PEM 误贴给出指向性提示，新增 5 个同密钥多编码夹具与 16 个回归测试（跨编码 blob 一致性、端到端验签、误贴提示矩阵）。

### Fixed

- 修复 v1.11.0 起跳板机连接必现失败的问题：会话秒级恢复重构误删了跳板循环中的 `await hopSession.waitUntilAuthenticated()`，导致 `openDirectTcpip` 在跳板会话认证完成（`tunnel-ready`）前被调用，所有跳板连接必现 "SSH jump host is not ready for TCP forwarding"（#108，修复 PR #109 作者 @xuthuslei）；补充跳板会话就绪时序回归测试，锁定 SSHSession 与 DO 跳板循环之间的时序契约，防止同类回归漏过 CI；更新贡献者名单。

## [1.13.0] - 2026-08-27

### Added

- **Theme V3 背景层**：新增 `background` 顶层模块（schemaVersion 3），支持 solid / linear / radial / mesh 四类背景，最多 5 个停靠点（均过白名单颜色校验）、线性角度（0–360）、读性遮罩（scrim，渐变背景强制暗色 ≥0.25 / 浅色 ≥0.35 的下限）与缓慢漂移（drift）动画；背景由 `body::before` 固定全屏层承载，纯 CSS 变量驱动、零 DOM 改动。
- **Theme V3 效果注册表**：新增 `effects` 模块（scanline / flicker / glow / noise），强度钳制在 0–1；扫描线与闪烁门控从「cyberpunk 风格硬编码」泛化为 `data-fx-*` 属性驱动（Cyberpunk 内置主题迁移为参数化配置，默认视觉不变）；噪点使用内联 feTurbulence SVG 纹理，无外部请求。
- **Theme V3 版式与表面**：新增 `typography` 模块（字号缩放 0.85–1.25、圆角缩放 0.5–2，均叠加在密度/形状档位之上）与独立的 `appearance.blur` 表面模糊档位（none / subtle / strong）；动效门控（`data-ui-motion`）与 `prefers-reduced-motion` 双重视角约束背景漂移与闪烁。
- **两套旗舰内置主题**：内置主题从 5 款扩至 7 款，新增 **CRT Amber**（琥珀磷光深色主题：径向暗角背景 + 扫描线/闪烁/辉光/噪点全开 + 方形 mono 造型）与 **Glass**（蓝紫浅色玻璃态主题：mesh 粉彩漂移背景 + 强表面模糊 + 1.4× 圆角 + 分段控件）；两者明暗对比、质感与动效差异显著。
- **Apple 浅色主题**：内置主题 Glacier 替换为 Apple（macOS 风格浅色），占用 soft 风格预设占位并保持四种 UI 风格全覆盖；终端 ANSI 16 色采用 Apple 系统色无障碍变体，UI 变量取材 Apple 设计语言（#f5f5f7 背景、#0066da 链接蓝、#5856d6 systemIndigo Agent 色），文本/强调/错误色全部通过 4.5:1 对比度并纳入测试断言。
- **在线主题编辑器支持 V3**：新增背景层（类型/角度/遮罩/动画/停靠点）、效果（四项强度滑杆）与版式缩放（字号/圆角）三组面板及 blur 档位；导出升级为 schemaVersion 3 并携带新模块，导入按与后端同源的钳制/白名单规则消毒；同步脚本提取 `BUILT_IN_BACKGROUND` / `BUILT_IN_EFFECTS` / `BUILT_IN_TYPOGRAPHY` 注入预设。

### Changed

- `THEME_SCHEMA_VERSION` 升至 3；V2 主题数据自动升级（新模块缺省即旧行为），存量 `baseTheme: 'glacier'` 主题导入时优雅降级（字段丢弃、按明暗模式回退基底），旧版 glacier 选择在 localStorage 中一次性迁移到 Standard Dark。
- 表面模糊由 shadow 预设派生值改为独立 blur 档位完全接管（后置规则同优先级胜出），geometry 变量（圆角/字号）改为 calc 乘法组合缩放。

### Fixed

- 补充既有 lint 清洁（forEach 回调返回值、未使用导入）。

## [1.12.2] - 2026-08-27

### Changed

- 分享审计详情由列表底部区块改为面板内独立视图：点击「查看审计」立即切换至占满面板的详情视图并展示加载占位，消除长列表下审计在底部展开需手动滚动才能看到而导致的“点击无响应”错觉（详情视图自带返回按钮，返回后恢复列表滚动位置；重新打开弹窗重置为列表视图）。
- 审计内容独占面板高度：结构化事件列表与终端记录展示高度分别提升至 `max-h-64` / `max-h-[50vh]`；查看审计按钮点击后进入禁用加载态，防止重复点击。

### Added

- 新增 `common.back` 中英词条（返回 / Back）。

## [1.12.1] - 2026-08-26

### Added

- 新增 `share.auditCleanupStatus` 中英词条（`{status}（审计 {time}）` / `{status} (audit {time})`）。

### Changed

- 审计清理记录折叠区每行扩展展示审计生成时间：「清理时间 + 状态（审计时间）· 方式」；审计时间取首次审计事件时间（`claimed_at`，认领时写入 `share.claimed`），`created_at` 兜底。

## [1.12.0] - 2026-08-26

### Added

- 分享审计记录保留与清理能力：分享者在终态后可整体清空全部审计明细（写入墓碑事件保留追责线索，`audit_bytes` 同步重置）或导出完整 JSON 归档（含生命周期与终端输出原文）。
- 审计保留期可自定义（7–365 天，默认 90 天）：创建分享时指定；终态进入保留期，到期由 alarm 自动清除明细并写入自动清理墓碑。
- 审计清理留痕集中展示：清理时间与方式（手动/自动）同步至用户库（`audit_purged_at`/`audit_purge_type`）并以折叠面板展示；已清理的分享等同删除效果，不再提供查看审计入口。
- 新增审计清理回归测试（8 用例）：墓碑隔离、归属/终态校验、同步失败容错、排期回滚、留痕接缝与迁移幂等。

### Changed

- 审计保留期服务端校验统一为 7–365 天（ShareDO 与 Worker 创建入口白名单一致）。
- 手动清空审计后同步取消已排期的自动清理闹钟，避免到期后的无效唤起。
- 清理墓碑事件（`share.audit_purged`/`share.audit_auto_purged`）从常规审计事件流分离：`ownerView` 单独以 `removals` 返回，前端不再把清洗记录当作普通事件渲染。
- UserDBDO SQL 查询改为类型化封装（`query<T>`/`one<T>`），消除 22 处 `as unknown as` 断言及对应说明注释；COUNT 查询统一走 `one<T>`。
- 分享会话名随机数改由 `crypto.randomUUID()` 生成；OAuth 回调与 base URL 解析增加防御性兜底。
- 测试类型检查纳入门禁：`tests/` 拆分 `tsconfig.worker` / `tsconfig.frontend` 两个项目（workers-types 与 DOM lib 的 `Element` 接口冲突，无法在单一配置共存），并修复暴露的 3 处测试代码类型缺陷。
- 供应链与权限收紧：pnpm 启用 `blockExoticSubdeps`/`minimumReleaseAge`（7 天）/`no-downgrade`；CI 部署权限收敛为 `contents: read`；新增 `.gitleaks.toml` 误报豁免配置。

### Fixed

- 审计保留期闹钟设置失败静默：失败时回滚排期状态并同步内存，杜绝“有排期但无闹钟”的幽灵状态（自动清理永不触发）。
- `updateStatus` 调用点统一 `await`，消除异步化改造后的未处理 rejection 风险。
- 部署窗口期 UserDBDO 不支持审计留痕路由时清理仍可完成（尽力同步，失败仅记录日志）。
- pi-lens 行内抑制失效：误报豁免注释与目标行之间被说明注释隔断，已补为紧邻放置。

### Docs

- AGENTS.md 第 25 条同步清理触发条件、墓碑/removals 域与留痕同步失败边界；新增第 31 条 pi-lens 项目策略口径（XSS 类规则刻意不做项目级禁用，仅行内逐处豁免）。
- AGENTS.md 开发命令补充供应链策略约束说明；`tests/README.md` 说明测试类型检查拆分原因。

## [1.11.0] - 2026-08-25

### Added

- Durable Object 会话保持：异常断线进入 60 秒保持期，断线期间终端输出有界缓冲（128KB）+ 背压暂停，恢复后一次性补发并续借 Window 额度；主动退出立即销毁。
- 分享会话秒级恢复与设备绑定：认领时绑定非可导出 ECDSA P-256 设备公钥，断线重连需对规范挑战串完成签名验签（nonce 验签前单次消费防重放）。
- 恢复凭据轮换：每次成功恢复轮换 resume token，旧 token 降级为“上一代”容忍一次，覆盖弱网下轮换帧丢失导致的永久锁死。
- 到期前 1 分钟双语预警事件，挂机用户可提前感知分享会话即将结束；服务端终结信号识别后立即进入终态，不再空转重试。
- 恢复链路 DEBUG 诊断面包屑（`[resume-debug]`：保持/销毁决策与各拒绝分支原因）。
- 新增分享会话恢复安全测试矩阵（设备验签、nonce 重放、撤销/过期、token 代际、未绑定拒绝等 9 用例）。

### Changed

- 分享会话恢复统一要求设备绑定（严格口径）：未绑定设备身份的会话不发放恢复凭据，服务端一律拒绝（`not_bound` 审计），杜绝无设备约束的凭据恢复；断线即提示原因并即时终结。
- 分享恢复重试改为指数退避铺满整个断线保持窗口（58s），末次尝试明确提示；移除此前的线性短间隔重试。
- 恢复后重发双段延迟基线（rtt 帧），修复秒级恢复后状态栏 CF 段缺失；客户端↔CF 段由心跳首拍即时补齐。
- 认领时设备绑定失败的落地页提示移除（方案 B）：无痕模式等瞬态存储在认领时不可检测，绑定失败改为断线时终端提示。
- 落地页与管理端渲染模板改用 DOM API 构建，消除 innerHTML 拼接站点。

### Fixed

- 撤销/过期覆盖断线保持期（detached）会话：修复撤销后宽限期内仍可凭旧凭据恢复的盲区。
- 无缝恢复后 SFTP attach URL 断链：恢复响应回传 attach URL，SFTP 数据通道可重建。
- resume 升级路径补齐 `REQUIRE_GITHUB_AUTH` 门禁，与 direct / one-time-token 路径对齐。
- 跳板连接状态消息 `index/total` 参数回归。
- 分享错误映射层泄漏词条键名导致 E2E 失败；分享恢复测试时间戳二次取值导致的验签偶发失败。
- 补全分享链路中英文本地化缺口：审计事件标签（`session.detached/resumed` 等）、服务端英文错误映射、英文界面向中文反向显示。

### Docs

- AGENTS.md 第 25 条同步设备绑定、上一代 token 容忍、严格恢复口径与断线保持语义。

## [1.10.5] - 2026-08-22

### Removed

- 彻底移除 `respond_to_user` 虚拟工具，消除长文本 Markdown 序列化为 JSON 字符串引起的转义崩溃、截断语法错误以及无响应白等。

### Changed

- AI Agent 控制循环回归标准 ReAct 范式，大模型在完成信息收集后直接以原生 Markdown 形式进行实时逐字流式打字输出。
- 优化 System Prompt 引导规范，精简前端执行状态渲染，移除“正在生成回复”冗余虚拟步骤。

### Docs

- 同步更新 `AGENTS.md` 中的 Agent 工具定义数量（8 ➔ 7）。

## [1.10.4] - 2026-08-22

### Fixed

- 修复 AI Agent 在模型直接以自然语言总结（无 `tool_calls`）时后端控制循环漏发响应帧、导致任务执行一半静默终止且无任何输出的问题。
- 修复流式解析中将空数组 `delta.tool_calls: []` 误判为工具调用导致文本流式被拦截的问题。
- 修复推理模型（如 DeepSeek-R1 / Qwen）仅输出 `reasoning_content` 时的回复兼容性，并在模型极端返回空内容时提供多语言安全兜底（“任务已执行完成。” / "Task completed."）。

### Changed

- 优化 System Prompt 工作流程约束，允许模型在任务完成时直接以 Markdown 形式输出总结报告，对齐主流大模型调用范式。

### Added

- 新增 AgentCore 响应交付与异常终止场景的自动化测试套件（`tests/worker/agent-core-response.test.ts`）。

## [1.10.3] - 2026-08-21

### Fixed

- 修复弱网环境下 AI Agent 执行 `docker logs` 等大输出命令时会话挂死/崩溃的问题（exec 通道 stdout 无界累积打爆 DO isolate 内存，表现为 Agent 无输出即停止、模糊重连提示 Failed to fetch、站点整站不可达）：
  - Agent exec 输出捕获有界化：4MB 硬上限，超限不再续 SSH window 并由会话层关闭通道击杀远端命令；保留头 128KB / 尾 256KB 环形视图并附截断说明，跨块 UTF-8 流式解码不乱码。
  - `docker_manage(logs)` 强制 `--tail 200`，拒绝 `-f/--follow` 无限流式输出。
  - 工具结果进 LLM 前按 64K 字符中间截断（token budget），`trimMessages` 阈值 60→40。
  - Socket 写增加 15s deadline，超时关闭底层连接以解挂 `sendMutex`。
  - 新增独立于写路径的被动 idle 看门狗：60s 无入站数据即断开会话。
  - 终端输入队列 4MB 上限，浏览器卡死时主动收敛会话。
- 消除 exec 输出整块拷贝的内存开销（改为 subarray 视图零拷贝），并清理 EXTENDED_DATA 未使用变量告警。

### Added

- 新增 `idle_timeout` / `input_backlog_closed` 两个 SSH 错误事件的 i18n 词条（zh-CN/en-US 对齐）。
- 新增 12 个回归测试：exec 输出截断/硬上限/UTF-8 跨块解码、`docker logs` `--tail` 强制与 `-f` 拒绝、工具结果截断（`tests/worker/agent-exec-channel.test.ts`、`tests/worker/agent-tool-executor.test.ts`）。

### Docs

- `AGENTS.md` 新增第 30 条维护约定：Agent exec 输出有界性（弱网 OOM 防线）。

## [1.10.2] - 2026-08-20

### Changed

- 精简 README 结构：核心优势要点化（重点、全面不啰嗦）；架构说明仅保留系统架构图，移除核心组件 / SSH 协议实现 / 数据流三个小节；快速部署移除本地命令行部署方式，中英文档同步调整。
- 快速部署新增「可配置环境变量」汇总表，涵盖 GitHub OAuth、登录白名单、强制登录、一次性分享、Turnstile、主机密钥验证与调试模式等全部可配置变量。
- 更新文档配套内容：演示视频时长（8:27 → 19:48）；`AGENTS.md` 目录树补齐前端/后端新模块、环境变量、tests/ 结构与 5 条新坑位（DNS 防重绑定、Biome 约定、i18n、CI 作用域等）；`tests/README.md` 补充 7 个新测试文件与覆盖范围。

### Fixed

- 修复 GitHub Actions 部署工作流 `paths-ignore` 作用域：标准 glob 的 `*` 不匹配 `/`，原 `*.md` 只忽略仓库根目录文档，导致 `tests/README.md` 等子目录文档变更误触发完整部署流水线；改为 `**/*.md`、`**/*.png` 等跨目录模式。
- 将 GitHub Actions 引用按 SHA 锁定（`actions/checkout`、`actions/setup-node`、`pnpm/action-setup`、`actions/configure-pages`、`actions/upload-pages-artifact`、`actions/deploy-pages`），杜绝 tag 可变引用带来的供应链投毒风险；新增 `.yamllint` 放宽行宽限制以承载 40 位哈希引用。

### Docs

- 完善发布流程规范：`release` 提交信息与 PR 标题支持主题化描述（`release: 发布 vX.Y.Z <主题>版本`，如 `release: 发布 v1.10.2 工作流和文档更新版本`）。

## [1.10.1] - 2026-08-20

### Added

- 新增“返回终端”能力：标签栏右侧“+”进入服务器列表或匿名连接页后，可通过工具栏/表单顶部按钮一键返回已建立的 SSH 会话，终端界面隐藏时亦可直接按 `Esc` 快速返回；按钮按标签数量联动显隐，窄屏（≤767px）下仅保留图标，避免 320px 视口工具栏溢出。

### Changed

- 重构标签栏与状态栏渲染：以 `replaceChildren()` 与 `createElement` 取代 10 处 `innerHTML`，消除插值字符串的 XSS 隐患与相关 lint 误报。
- 为 `TabManager` 新增 `setTabsChangedHandler` 回调，取代对实例方法的手工包装，标签数量变化统一驱动返回按钮显隐。
- 同步更新状态栏渲染回归测试断言（`tests/frontend-ux.test.ts`）。

## [1.10.0] - 2026-08-20

### Added

- 新增自定义命令片段库（#90）：支持按名称保存常用命令，登录用户按 `user_id` 行级隔离存储于 `UserDBDO`，匿名用户降级至本地 `localStorage`；名称≤50、命令≤2000、每用户≤100 条。
- 片段库提供填入终端、填入并执行、编辑与删除操作，桌面端与移动端均可通过工具栏入口访问，一次性分享会话中自动隐藏。
- 新增 `src/snippet-schema.ts` 共享校验模块，实现云端与本地一致的限额与输入规范化。
- 新增 `tests/snippet-schema.test.ts`、`tests/worker/user-db-snippets.test.ts` 与 `tests/snippet-local-store.test.ts`，覆盖校验、隔离、上限与匿名降级。

### Changed

- 彻底统一代码格式：新增 `biome.json`（`single` 引号、`lineWidth: 100`），全量格式化 123 个文件，后续变更不再出现引号风格抖动。
- 同步更新 `AGENTS.md` 的关键目录、API 路由表与常见坑位说明。

### Fixed

- 将 `UserDBDO` 与 `index.ts` 中裸 `new URL(request.url)` 统一封装为带 `try/catch` 的 `parseRequestUrl`，非法 URL 统一 400 拒绝。
- 将 `terminal.ts` 中 `innerHTML` 状态栏与搜索框重构为纯 DOM 构造，消除 XSS 误报并通过 `insertSnippet` 复用 `fillInput` / `paste` 管线。

## [1.9.1] - 2026-08-18

### Fixed

- 修复服务端将 `SSH_MSG_NEWKEYS` 与首个加密包放在同一 TCP 数据块返回时，SSH 会话沿用旧分包参数并报出超大 `packet_length` 的问题。
- 密钥切换后逐包重新读取 AES-GCM 或 AES-CTR/HMAC 的块大小、认证标签和 MAC 长度，避免错误解析已加密数据。

### Changed

- 新增覆盖 AES-GCM、AES-CTR/HMAC 状态切换及真实同批加密数据的回归测试。
- 更新中英文兼容性说明，并补充本次修复的贡献者信息。

## [1.9.0] - 2026-08-16

### Added

- 新增可选的一次性 SSH 授权分享：登录用户可为已保存服务器创建仅含 256 位随机能力凭证的临时链接，凭证仅保存哈希、只能领取一次，并分别限制领取窗口和最长会话时间。
- 新增分享管理与接收者确认界面；所有者可查看待领取、活动、结束、撤销和过期状态，实时撤销活动连接，接收者明确同意审计后才能进入终端。
- 新增独立 `SSHShareDO`，负责原子领取、短期连接票据、过期/撤销状态以及分享会话专用审计；审计覆盖会话生命周期、SFTP 请求与结果、终端 PTY 输出和对应时间。

### Changed

- 分享会话仅开放终端和 SFTP，禁用 AI Agent、自动重连、操作系统检测、元数据更新、主机指纹替换以及目标机和全部跳板节点的 `keyboard-interactive` 认证。
- 前端内联构建直接调用已安装的 TypeScript 与 Vite 二进制，不再由构建命令隐式触发依赖安装。
- 更新中英文部署及使用文档，说明 `ENABLE_SSH_SHARING` 默认关闭、能力链接的权限边界和 PTY 输出审计的适用范围。

### Security

- 分享链强制使用已经验证的路径级主机指纹，并始终启用严格主机密钥签名验证；指纹变化、审计写入失败、达到 5 MiB/5000 事件上限或授权到期时立即终止连接。
- 原始分享凭证不会发送到 SSH Durable Object 或持久层；领取后只签发 60 秒有效的一次性 WebSocket 连接票据，浏览器会在展示确认页前将凭证从地址栏移除。

关联 Issue：#84（本次发布不自动关闭该 Issue）。

## [1.8.2] - 2026-08-14

### Changed

- SSH 跳板链仅由 Cloudflare 直接连接的最外层入口执行 IPinfo 区域推断，下游内网服务器不再保存或查询自身区域，避免无效请求和内网主机信息外发。
- 服务器管理界面在选择跳板服务器后停用区域选项，并以“由跳板入口决定”“随跳板”明确展示实际调度规则；切回直连时恢复自动或手动区域配置。

### Fixed

- 修复新增或修改跳板链下游服务器时仍会触发区域推断，以及直连与跳板模式切换后可能残留无效区域信息的问题。
- 修复内网目标区域推断失败时显示误导性警告的问题，改为提示连接区域由跳板链入口统一决定。

## [1.8.1] - 2026-08-13

### Changed

- SSH 主机指纹发生变化时展示目标主机、已知指纹和新指纹，只有用户明确确认后才替换对应记录并重新连接；取消确认继续保留原信任记录。
- 已保存服务器在信任新指纹后重新申请一次性连接令牌，匿名连接则更新当前内存配置；多级跳板连接继续使用完整路由身份隔离相同私网地址。

### Fixed

- 修复服务端在完成主机密钥签名验证前就通知浏览器保存指纹，可能污染匿名连接本地信任记录的问题。
- 修复已保存服务器首次连接未可靠持久化主机指纹，以及服务器重装或轮换主机密钥后缺少规范重新信任入口、导致连接持续失败的问题。

### Security

- 首次或变更后的主机指纹只有在 SSH 密钥交换签名验证成功后才允许持久化；签名未验证的指纹不会写入信任记录，也不能通过确认流程替换旧指纹。

## [1.8.0] - 2026-08-13

### Added

- 新增面向登录用户已保存服务器的 SSH 跳板机支持，通过标准 RFC 4254 `direct-tcpip` 通道逐层建立嵌套 SSH，最多允许 3 台跳板服务器。
- 最终目标服务器的终端、SFTP、AI Agent exec 和操作系统识别统一复用完整跳板链；中间节点仅负责 SSH 认证和 TCP 转发，不打开 PTY 或业务通道。
- 服务器配置支持选择跳板服务器并展示多级连接路径，后端生成不可变的外层入口到最终目标连接链，每一跳独立完成认证和主机指纹验证。

### Changed

- Durable Object 区域调度和公网地址检查改为以 Cloudflare 直接连接的最外层跳板为准；内网目标仅允许出现在服务端解析的已保存跳板链中。
- 移动端后台恢复监听仅在设备具备触点且主指针为粗粒度时启用，Android、iPhone 和 iPad 仍会在回到前台后执行带随机 ID 的有界心跳验证。

### Fixed

- 修复普通 PC 切换浏览器标签页时误输出“页面已回到前台，正在检查 SSH 连接”并发送不必要恢复探测的问题。

### Security

- 跳板关系限制在同一 GitHub 用户空间，拒绝匿名注入、跨用户引用、自引用、循环和超深链路；路径级 known-host 身份避免不同内网中相同地址的主机指纹发生冲突。

## [1.7.3] - 2026-08-12

### Changed

- 移动端页面从后台返回后主动执行带随机 ID 的有界 WebSocket 心跳验证，不再仅凭 `readyState` 判断 SSH 会话可用性；失活连接会进入统一的指数退避重连流程。
- 匿名会话使用当前内存连接配置重新建立 SSH；登录用户的已保存服务器会重新申请一次性连接令牌，并仅在收到 `shell_ready` 后恢复在线状态和终端输入。
- iOS 输入法兼容回归改为模拟 Safari 的真实事件时序，并在 Chromium 与 iPhone WebKit 中覆盖空格、英文/中文标点、连续空格替换和重复发送防护。

### Fixed

- 修复手机浏览器切换到后台十几秒后返回时，界面显示已经重连但终端仍无法操作、必须关闭网页重新连接的问题。
- 修复已保存服务器断线后复用失效的一次性令牌，导致自动重连无法恢复的问题。
- 修复 iOS Safari 使用中文输入法时，空格、`.`、`、` 等非组合字符因 `keydown` 与 `keyup` 键码不一致而被丢弃的问题。

## [1.7.2] - 2026-08-12

### Changed

- SSH 用户认证改为先发送 RFC 4252 `none` 探测，根据服务端实际声明的方法选择普通密码、公钥或 `keyboard-interactive`；对未返回方法列表的非标准服务端保留有界兼容回退。
- 交互式认证挑战增加浏览器展示确认：服务端先等待 10 秒确认弹窗已显示，再开始计算 2 分钟用户响应时间；认证超时使用正常关闭，避免旧版前端反复重连并触发服务商侧封禁。
- 认证回归测试扩展到 Chromium 与移动 WebKit，并在部署质量门禁中安装和执行对应浏览器测试。

### Fixed

- 修复 Serv00 等仅通过 `keyboard-interactive` 提供密码验证的服务器可能先消耗一次普通密码认证、随后仍无法正确进入交互式认证的问题。
- 修复浏览器处理认证控制消息异常时被误当作终端文本输出，以及无效挑战未可靠取消、仍可能自动重连的问题。
- 修复交互式认证弹窗尚未展示与用户已看到但尚未作答共用同一超时，导致慢速设备或浏览器兼容问题难以准确诊断的问题。

## [1.7.1] - 2026-08-11

### Changed

- 移动端终端改为统一使用 `VisualViewport` 的高度与顶部偏移定位可视区域，并在软键盘动画稳定后再调整终端行列数，减少远端 PTY 连续 resize 引起的闪烁和内容跳动。
- 软键盘打开时隐藏非必要的终端状态栏并避免重复叠加底部安全区，为终端内容和快捷工具栏保留更多可用空间。

### Fixed

- 修复 Android Chrome、Edge 等移动浏览器打开软键盘后部分终端内容被遮挡、提示符位置不稳定的问题。
- 修复移动端无法在终端内容区域单指滑动查看历史记录的问题；滑动与文本选择、备用屏幕及远端鼠标协议保持隔离。
- 修复终端尺寸变化后可能丢失当前阅读位置的问题：位于底部时继续跟随提示符，查看历史时保留相对滚动位置。

## [1.7.0] - 2026-08-11

### Added

- 新增可选的 `GITHUB_ALLOWED_USER_IDS` 配置，支持使用稳定的 GitHub 数字用户 ID 限制可登录账号；未配置时保持原有的不限账号行为。
- 新增可选的 `REQUIRE_GITHUB_AUTH` 配置，启用后禁止匿名 SSH，并在未登录页面展示明确的 GitHub 登录要求；与账号白名单组合后可将实例设为仅限指定 GitHub 用户使用。

### Changed

- 完善中英文部署文档，说明四种访问策略组合、GitHub 数字用户 ID 的获取方式、环境变量类型以及策略变更对现有会话和连接的影响。
- 收紧前端构建产物校验：缺失或重复的 JavaScript、CSS 资源会直接导致构建失败，避免生成不完整的 Worker 内嵌页面。
- 完善本地开发、Cloudflare 上传和编辑器临时文件的忽略规则，并收紧服务器保存响应的前端类型处理。

### Security

- GitHub 白名单在 OAuth 回调、既有 session 和一次性连接令牌路径持续校验；强制登录模式同时验证令牌所属账号，配置为空或格式非法时采用 fail-closed。
- 将前端 HTML 清理依赖 DOMPurify 升级至 3.4.13，纳入上游安全修复。

## [1.6.4] - 2026-08-09

### Security

- 完善 Agent 危险命令边界识别，确保命令位于 `;`、`&&`、`||`、管道、括号或换行之后且没有额外空格时，仍会执行既有的强制拦截或用户确认策略。
- 收紧 SSH 与 SFTP WebSocket 升级的同源校验：匿名连接、一次性令牌连接和 SFTP attach 均拒绝缺失或不匹配的 `Origin`，正常同源浏览器连接保持不变。

## [1.6.3] - 2026-08-09

### Added

- 新增 RFC 4256 `keyboard-interactive` 交互式认证支持，可安全处理单轮、多轮、零提示和多提示挑战，并支持基于 `partial_success` 的有界多因素认证流程。
- 新增独立交互式认证弹窗，将服务端提示与终端输入隔离；响应绑定随机 challenge ID 和来源 WebSocket，支持超时、取消及用户明确选择后使用已保存密码。

### Changed

- 收紧认证方法自动切换策略：仅当服务端不再提供用户选择的主认证方式，或上一认证因子已部分成功时，才进入 `keyboard-interactive`，不增加额外重试机制。
- 普通服务端凭据拒绝改为预期连接结束，不再使用表示内部异常的 WebSocket `1011` 关闭码。

### Fixed

- 修复服务端同时声明普通认证与 `keyboard-interactive` 时，普通凭据被拒绝后被错误解释成交互式认证请求，最终导致 Alpine 等服务器显示误导性错误并关闭连接的问题。
- 修复交互式认证最终失败时错误归因不清的问题，同时保留格式异常、状态错乱和超限场景的失败关闭保护。

## [1.6.2] - 2026-08-05

### Changed

- 精简中文 README 中重复或过细的介绍，并同步调整英文 README，保持部署、功能与维护说明一致。

### Fixed

- 修复移动端终端触摸选区与浏览器手势冲突导致无法可靠复制的问题：复制按钮可先进入明确的选择模式，拖动生成选区后再次点击完成复制，并在成功后退出选择模式。
- 完善旧版剪贴板回退路径的选区、异常清理和焦点恢复，提升受限浏览器中的复制兼容性。
- 修复 Windows Chromium 下赛博朋克主题原生下拉列表仍使用白色背景的问题，使选项背景和文字颜色跟随当前主题。

## [1.6.1] - 2026-08-04

### Changed

- 将浏览器到 Cloudflare 节点的 RTT 采样间隔由 30 秒缩短至 5 秒，使网络延迟变化能够更及时地反馈到终端状态栏。
- 上一次 RTT 探测尚未返回时跳过新探测，避免弱网环境下重复采样覆盖计时并产生不准确结果。

## [1.6.0] - 2026-08-03

### Added

- 登录用户连接尚未识别的已保存服务器后，通过独立且非阻塞的 SSH exec 通道自动检测远端操作系统，并在服务器卡片即时显示对应的系统品牌图标。
- UserDBDO 服务器记录新增可幂等迁移的 OS 标识字段，并通过受用户归属校验的内部接口持久化规范系统 key。
- 新增操作系统解析、会话检测与持久化、前端图标回退及浏览器展示回归测试。

### Changed

- 未识别的 `unknown` 结果不再持久化或通知前端，留待用户下次连接时自然重新探测，不引入额外主动重试机制。
- 修改服务器主机地址或端口时自动清除旧 OS 结果；后台写入 OS 不再修改 `updated_at`，避免意外改变服务器列表排序。
- 完善 Windows cmd 输出识别，并为没有独立品牌图标的已识别系统提供紧凑通用图标回退。
- 更新中英文功能、架构、审计行为说明及贡献者记录。

## [1.5.2] - 2026-08-03

### Fixed

- 统一 AI 助手返回终端按钮的可见文案、工具提示与无障碍语义，避免移动端仍提示“关闭 Agent 面板”。
- 对齐 CSS 与前端逻辑的移动端断点，使 768px 精细指针设备统一使用桌面布局和分页，同时保留触屏平板布局。

## [1.5.1] - 2026-08-03

### Changed

- 服务器列表根据设备类型调整每页数量：手机展示 3 张、触屏平板展示 6 张、桌面端展示 9 张，并在视口跨越断点后安全重算分页。
- 完善移动端用户空间、服务器卡片、页脚、终端快捷工具栏以及服务器和 AI 配置弹窗的窄屏与安全区布局。
- 终端字号根据手机、触屏平板和桌面端自动使用 12、13、14px，并在视口或屏幕方向变化后重新适配行列数。

### Fixed

- 修复移动浏览器自动放大 xterm 文本，导致终端字符过大、列数过少和输出严重换行的问题。
- 修复移动端 AI 助手标题栏被应用顶栏遮挡、用户无法通过面板按钮返回终端的问题。
- 修复长服务器名称、主机名或用户名，以及 Google 图标字体加载失败时可能撑破移动端布局的问题。

## [1.5.0] - 2026-08-02

### Added

- 新增移动端终端快捷工具栏，支持一次性 Ctrl/Alt、Esc、Tab、方向键、Home/End、PgUp/PgDn、常用符号及显式复制、粘贴和隐藏软键盘操作。
- 新增用户主动触发的全屏横屏入口，并为不支持屏幕方向锁定的浏览器提供手动旋转提示。
- 新增移动端终端输入、快捷键序列、剪贴板及页面布局的单元和 Chromium 浏览器回归测试。

### Changed

- 优化手机和平板上的动态视口、软键盘、安全区、触摸选区、终端尺寸重算以及 Agent/SFTP 全屏面板布局，同时保持桌面端布局和鼠标剪贴板交互不变。
- 更新中英文使用说明，明确移动端适配主要面向临时操作与应急访问；长期、高频或复杂终端任务仍建议使用桌面端。

### Fixed

- 修复 iOS 中文输入法在 xterm.js 隐藏输入框中可能漏发延迟写入字符，以及一次删除多个字符时退格数量不足的问题。
- 修复移动端软键盘弹出、屏幕旋转或进入全屏后终端高度和列数可能未及时适配的问题。

## [1.4.3] - 2026-08-02

### Changed

- 上游同步工作流解析 GitHub Fork 同步接口的返回结果，明确区分无需同步、fast-forward、merge 及异常状态，不再直接展示含义不清的原始 JSON。
- 同步日志新增简洁中文提示和 GitHub Actions 执行摘要；冲突或权限异常会输出诊断建议并保持任务失败，同时减少不必要的 Emoji 图标。

## [1.4.2] - 2026-08-01

### Added

- 新增默认关闭的 Fork 上游自动同步工作流，用户可通过仓库变量选择开启每日定时同步，也可随时手动执行。
- 同步过程使用 GitHub Fork 同步接口更新 `main` 分支，无需 PAT；发生合并冲突时保留用户现有代码并停止任务，避免强制覆盖。

### Changed

- 完善中英文部署文档，补充自动同步的开启步骤、Cloudflare Git 集成自动部署条件、手动同步方式及冲突处理建议。

## [1.4.1] - 2026-08-01

### Added

- 服务器列表与终端连接状态栏新增 IPv4/IPv6 隐私掩码展示，并支持通过鼠标点击或键盘操作复制完整地址，以及复制成功和失败反馈。
- 新增共享的主机地址校验与掩码模块，覆盖 IPv4、完整/压缩/带作用域 IPv6 和 IPv4 映射 IPv6，并补充单元及 Chromium 浏览器回归测试。

### Changed

- 终端右键粘贴改为复用 xterm.js 原生输入管线，统一换行格式，并仅在远端应用显式启用 bracketed paste 模式时发送对应控制序列；粘贴数据继续经过 trzsz 输入处理。
- IP 掩码交互改用原生按钮语义，增加键盘操作与清晰的焦点样式；完整地址不再写入 HTML 数据属性，而是从当前连接配置复制。
- 更新中英文 README 的终端剪贴板、IP 隐私展示、架构组件和贡献者说明。

### Fixed

- 修复在 Vim 中通过右键粘贴多行内容时可能触发自动缩进、注释续行或产生异常空行的问题。
- 修复未启用 bracketed paste 的普通 Shell 仍收到粘贴控制序列，可能导致输入内容被污染的问题。
- 修复旧 IP 掩码规则接受越界 IPv4、无法识别压缩 IPv6，并使用不准确 `/64` 展示的问题。

## [1.4.0] - 2026-07-30

### Added

- 新增 Theme V2 界面风格系统，在保持页面结构稳定的前提下，将颜色、形状、密度、字体、阴影、动效以及按钮、输入框、卡片和标签页组件样式纳入主题配置。
- 用户空间与终端页面均可切换内置主题或导入单个自定义主题；登录用户的自定义主题会同步到账号，并可在新浏览器中自动恢复。
- GitHub Pages 在线主题编辑器支持全部 Theme V2 外观维度、内置预设、实时多区域预览以及版本化 JSON 导入和导出。
- 新增应用与 Worker 共用的主题校验模块，并补充主题接口、账号恢复、在线编辑器安全输入和首屏性能的单元及浏览器回归测试。

### Changed

- 在线主题编辑器的内置颜色和外观预设在前端构建时自动与应用主题数据同步，减少两套主题定义之间的偏差。
- 云端主题改为在用户空间显示后异步恢复，避免账号主题请求阻塞登录首屏；加载期间用户主动切换或导入主题时，不再被较旧的云端响应覆盖。
- 应用端只保留自定义主题导入和单槽账号同步，主题 JSON 导出统一由 GitHub Pages 在线编辑器提供。
- 自定义主题在应用导入、Pages 编辑和 Worker 落库前统一执行属性白名单、外观枚举、安全颜色和 64 KiB 容量校验。
- 收窄在线编辑器和应用中的宽泛 CSS 动画属性，避免无关布局属性参与过渡。

### Fixed

- 修复终端内容区域四周留白过宽的问题，并根据主题形状保留适当圆角安全间距。
- 修复服务器卡片带标签后高度增加，导致同排卡片的连接、编辑和删除按钮无法底部对齐的问题。
- 修复在线主题编辑器手动输入危险或无效颜色时仍写入预览、可能导出与应用校验结果不一致的主题 JSON 问题。
- 修复主题接口接受并保存无有效 Theme V2 字段的数据，以及非法 JSON 请求返回不明确错误的问题。

## [1.3.4] - 2026-07-29

### Added

- SFTP 上传同名文件时新增覆盖确认，后端通过目标不存在前置条件阻止未经确认的覆盖，并补充单元与浏览器回归测试。
- 新增应用明暗模式订阅能力，供 Turnstile 等第三方组件与当前主题保持一致。
- 新增 `NOTICE` 原作者与项目来源声明，明确二次修改和再发布时需要保留的归属信息。

### Changed

- 完善 SFTP 中文和英文界面文案，统一文件操作、批量任务、错误反馈及覆盖确认信息。
- 保存服务器时仅在主机变化且需要自动推断区域时查询 IPinfo，并为第三方请求增加超时回退。
- 更新 README、AGENTS 和测试文档，使架构、部署迁移、安全边界、运行环境及原作者署名说明与当前实现一致。

### Fixed

- 修复切换服务器认证方式后沿用旧凭据，导致认证方式与密码或私钥不一致的问题。
- 修复私钥输入框按 Enter 意外提交连接，以及端口未严格限制为 1-65535 整数的问题。
- 修复 SFTP 上传同名文件时静默覆盖远端内容的问题。
- 修复 AI 配置窗口首次点击创建后仍保持隐藏、需要再次点击才能显示的问题。
- 修复 Standard Light 主题下 Turnstile 固定使用深色组件，以及未验证时切换主题无法同步配色的问题。

## [1.3.3] - 2026-07-29

### Added

- 终端支持在鼠标正常结束文本选区时自动复制到系统剪贴板，并提供中英文操作反馈。
- 中英文 README 新增贡献者名单、主要贡献说明及完整 GitHub Contributors 记录入口。
- 新增剪贴板写入单元测试和 Chromium 浏览器回归，覆盖自动复制、指针取消、旧版回退及焦点恢复。

### Changed

- 终端选区与 Agent 代码块复制统一使用公共剪贴板模块；Clipboard API 不可用或被拒绝时自动回退到 `document.execCommand('copy')`。

### Fixed

- 修复旧版复制回退抢占终端焦点、复制失败仍显示成功提示，以及 `pointercancel` 意外触发复制的问题。
- 修复 WebCrypto 原始 ECDSA 签名以 `0x30` 开头时被误判为 DER 格式，导致 SSH 公钥认证随机失败的问题。

## [1.3.2] - 2026-07-28

### Added

- 服务器配置支持最多 10 个规范化标签，服务器列表新增标签筛选，并以每页 9 张卡片进行分页展示。
- SFTP 文件列表支持 `Cmd/Ctrl` 切换选择、`Shift` 连选、全选、批量文件下载与批量删除。
- CI 部署前新增 Worker/前端类型检查、单元与集成测试、可复现构建、Playwright 浏览器 E2E 和 axe 无障碍门禁。
- “询问 AI 助手”支持将完整终端选区作为当前标签独立的上下文附件，提供来源与大小信息、展开预览、替换和移除操作。

### Changed

- 终端选区不再点击后直接发送给 Agent；用户必须先补充问题，发送时选区会被明确标记为非可信分析数据，而不是操作授权。
- 前端生产构建改为严格使用已安装依赖并校验唯一 JS/CSS 入口，避免构建阶段隐式安装依赖，确保内联产物可复现。

## [1.3.1] - 2026-07-27

### Changed

- 将生产环境 Tailwind CSS 从运行时 CDN 编译迁移为 Vite + PostCSS 本地构建，保留 forms 与 container-queries 插件，并通过产物级回归测试确保主题、响应式及表单样式完整生成。

### Fixed

- 修复 `cf_verified` 安全回归测试可能未真正篡改签名而偶发失败的问题；同时收紧验证 token 的结构、时间戳和 HMAC 签名格式校验，使畸形 token 稳定回退到 Turnstile 验证。

## [1.3.0] - 2026-07-27

### Added

- 新增 Standard Dark 与 Standard Light 两款常用主题，并将内置主题、终端配色及自定义主题同步逻辑收敛到统一主题模块。
- 服务器列表新增前端即时搜索，可按服务器名称、主机地址和用户名进行不区分大小写的过滤。
- 终端状态栏新增网络质量三色提示，根据 CF 物理延迟与 WebSocket RTT 分别显示绿、黄、红色状态点，不增加额外质量文字。
- 终端选区末端新增“询问 AI 助手”浮动入口；用户点击后直接将完整选区发送给当前会话的 Agent，取消选区时入口自动消失。
- Agent 回复中的所有代码块支持一键复制；明确标注为 Shell 的安全单行命令可填入当前活动终端，填入后不会自动执行。

### Changed

- 完善 Agent 危险操作确认交互：使用无障碍警告对话框语义、默认聚焦拒绝按钮、限制焦点范围，并支持 `Escape` 拒绝；关闭面板、销毁会话或切换标签时会自动拒绝待确认操作。
- 在线主题编辑器同步当前项目的服务器搜索、区域、网络质量、终端选区入口和 Agent 代码块操作 UI，并补齐 Standard Dark/Light 预览。
- 在线主题编辑器的预设主题改用下拉框选择，避免主题较多时横向裁切和部分选项无法操作。

### Fixed

- 修复在线主题编辑器预设主题展示不完整、部分主题无法选择的问题。

## [1.2.1] - 2026-07-24

### Added

- 在线主题编辑器新增简体中文与英文切换，复用主项目语言偏好，并支持 URL 参数和浏览器语言自动解析。

### Changed

- 在线主题编辑器同步主项目最新 UI，补全登录页、服务器列表、终端、SFTP 与 AI Agent 的实时主题预览。
- 主题编辑器使用统一的非阻塞 Toast 操作反馈，并同步最新主题变量和操作标签风格。

### Fixed

- 修复 SFTP 右键菜单在中文模式下仍显示 `Open`、`Download`、`Rename`、`Delete` 英文文案的问题。
- 语言变化时主动关闭已打开的 SFTP 右键菜单，避免菜单继续显示切换前的语言。

## [1.2.0] - 2026-07-22

### Added

- 新增简体中文与英文界面切换，支持语言偏好持久化和 URL 参数覆盖。
- 为匿名连接、服务器管理、终端、SFTP、AI 设置、Agent、弹窗及操作反馈补充完整的双语文案。
- Agent 请求携带当前界面语言偏好，并根据所选语言生成对应语言的回复。

### Changed

- 将语言切换入口优化为带图标的目标语言按钮；匿名模式下调整至终端图标左侧，终端会话页隐藏入口以保持会话语言稳定。
- 精简并统一 SFTP 英文工具栏文案，使用 `UPLOAD`、`MKDIR` 等紧凑的大写操作标签。
- SSH 状态消息改用结构化事件码和参数化翻译，同时保留对旧服务端原始消息的兼容回退。

### Fixed

- 修复中文终端连接横幅因 CJK 字符双列宽导致边框无法闭合的问题。
- 修复英文模式下认证、主机密钥、通道及会话状态仍显示中文的问题。

## [1.1.0] - 2026-07-20

### Added

- 新增统一前端反馈系统：普通提示使用非阻塞 Toast，危险操作使用项目主题确认框，需要输入时使用带校验的输入框；支持反馈队列、主题配色、移动端布局、减少动画、ARIA 语义、焦点恢复以及 `Escape`/`Enter` 键盘操作。
- 新增生产构建回归测试，检查 xterm.js `requestMode` 局部变量声明未被构建工具错误删除；新增原生弹窗扫描测试，防止前端重新引入阻塞式 `alert`/`confirm`/`prompt`。

### Changed

- 将连接表单、服务器管理、主题导入和 SFTP 文件操作中的浏览器原生弹窗全部替换为统一反馈组件；删除操作默认聚焦安全选项，并明确提示不可撤销。
- 完善 SFTP 重命名与新建目录输入校验，拒绝空名称、`.`、`..`、路径分隔符和空字符。

### Fixed

- 修复 Vite 生产构建对 xterm.js 6.0.0 预压缩 ESM 再次执行 esbuild 语法压缩时，错误删除 `InputHandler.requestMode` 局部变量声明，导致 Vim/Vi 发送终端模式查询后输入链中断、无法进入或退出插入模式的问题。
- 禁用会触发上述错误转换的 esbuild `minifySyntax` 阶段，同时保留其他压缩能力，确保 Worker 内联生产产物可以正确处理 Vim 及其他 TUI 的 DECRQM 查询。

## [1.0.9] - 2026-07-17

### Fixed

- 修复 SSRF 防护 DNS rebinding 绕过漏洞（VULN-01/02）：新增 `dns-check.ts` 模块，通过 Cloudflare DoH 解析域名后校验真实 IP，防止域名解析到内网地址绕过 `isBlockedHost`/`validateBaseUrl` 字符串校验；SSH 连接和 AI API 调用入口均增加 DNS 解析二次校验。
- 修复 Agent `service_manage`/`docker_manage` action 参数未校验 enum（VULN-05）：添加 action 白名单校验，非标准操作需用户确认。
- 修复 `isBlockedCommand` shell 替换绕过（VULN-06）：增加 shell 替换检测，拦截 `rm -rf` 中的 `$()`/`${}`/`` ` `` 模式。
- 修复 UserDB DO 返回原始错误消息（LOW-04）：异常不再返回原始错误消息，改为通用错误响应，原始错误仅写入 Workers 日志。
- 修复无端口范围校验（LOW-05）：创建/更新服务器时校验端口 1-65535，非法值返回 400。
- 修复 RSA/ECDSA 公钥认证协议不合规问题。

### Changed

- 移除未使用的 `?config=` URL 参数预填功能（LOW-01）：该功能未被使用且存在凭据泄露风险。
- 优化 DNS 缓存机制：添加最大条目限制（1000）防止内存泄漏，新增 `evictCacheIfNeeded` 函数清理过期和超额缓存。
- 修正 IPv6 link-local/unique-local 正则表达式精确度：使用更精确的正则匹配 fe80::/10 和 fc00::/7 范围。
- 添加 DoH 响应 Status 字段校验：只处理 `Status === 0`（NOERROR）的 DNS 响应。

### Added

- `tests/worker/dns-check.test.ts` 新增 25 个 DNS rebinding 防护测试。

## [1.0.8] - 2026-07-15

### Changed

- 废弃 AI Agent 严格白名单策略，改用黑名单策略以提升使用体验：原策略仅 22 个只读命令免确认、其余一律确认，使用极为繁琐；现改为黑名单兜底 + AI 大脑自主判断，AI 可主动调用 `ask_user_confirmation` 工具评估风险，大幅减少无谓打断。安全分层保持不变：`isBlockedCommand` 直接拒绝灾难性命令（fork bomb、`rm -rf /`、`mkfs`、`dd of=/dev/sd*`），`needsConfirmation` 在 AI 漏判时兜底强制确认。
- 优化内存限流机制：Worker 实例级 `Map<ip,{count,resetAt}>` 增加惰性清理（每 256 次检查触发）和 10000 条上限 FIFO 淘汰，避免 isolate 内无限增长；定位为「削峰」而非鉴权，真正的连接鉴权仍由 Turnstile 与一次性 token 负责。
- 统一 SSH 序列号回绕处理：提取纯函数 `nextSequenceNumber(value)` 使用 `(value + 1) >>> 0` 无符号 32 位回绕，修复旧 `this.seqNum++` 在 `2^32-1` 时溢出为 `Number(2^32)` 破坏 SSH 解密的潜在缺陷，符合 RFC 4253 §6.4 / RFC 4344。
- 收紧匿名身份信任边界：区分 Worker 内部可信 `x-ssh-config` HTTP 头（保留 userId）与匿名 URL query param（强制剥离 userId），并在 `/api/ssh` 入口 `headers.delete('x-ssh-config')` 防止匿名连接通过 HTTP 头注入伪造配置，杜绝提权路径。
- 根据精简修复清单进行全面重构：统一 SFTP 句柄生命周期与 2000 条目截断保护，简化 `user-db.ts` 查询路径，精简 `sftp-handler` 下载队列，前端 `tab-manager` 多会话协调增强，整体 -588 行冗余代码。
- Agent 工具执行器确认流程由 `askConfirmation` 改为 `askConfirmationWithAbort` 与 `Promise.race` 竞争 abort 信号，避免 Agent 被停止时确认流程永久挂起。

### Fixed

- 修复 `rm -fr /` 漏拦（只触发确认而非直接拒绝）：旧正则 `-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*` 要求 `r` 必须在 `f` 之前，flag 反序的 `rm -fr /` 匹配失败。改为解析 rm 短选项字段集合判断「含 r 且含 f」，顺序无关，覆盖 `rm -fr /`、`rm -r -f /`、`rm -rfv /` 等全部变体直接拦截。
- 补齐 AI Agent 黑名单高危模式兜底：新增 6 条高破坏低误报模式（`iptables -X` 清空链表、`kill -9 -1/0/1` 杀全部进程、`curl|sh` / `wget|bash` 远程脚本执行、`find -delete` 与 `find -exec rm` 递归删除），弥补白名单转黑名单后的兜底覆盖缺口；`apt-get install`、`pkill`、`sudo 写操作` 等运维常用路径仍交由 AI 大脑自主判断。
- 修复 AI base_url 末尾带 `/chat/completions` 时自动获取模型列表失败：智能容错自动剥离该后缀，并兼容 `Array` / `data` / `models` 三种模型列表响应形态，适配 OpenAI/Anthropic/各兼容服务商。
- 修复 Cloudflare Workers `fetch` 不支持 `redirect: 'error'` 导致跑通失败：改为 `redirect: 'manual'` 并显式拦截 3xx 响应以保持 SSRF 防护语义，兼容 Workers 运行时。
- 修复已登录用户无法使用 AI 助手：头注入路径与匿名连接的 userId 剥离逻辑混淆，现严格区分两条路径——`x-ssh-config` 可信头保留 `userId`，URL `config` 参数强制 `delete userId`。
- 修复 AI Agent 读取配置时内部路由查询失败误报「未配置」：`fetchAgentAIConfig` 改为按 `githubId` 路由到对应 `UserDBDO` 实例，新增 `SSHConnectionConfig.githubId` 字段贯穿 DO 构造链路，避免会话级配置与存储实例错位。
- 前端透传模型列表获取失败的具体原因：当 AI 提供商 URL 被网络拦截或触发重定向时，前端显示明确错误而非笼统失败，便于用户排查网络环境。

### Added

- `tests/worker/agent/safety.test.ts` 新增 3 个用例覆盖 `rm -fr` 漏拦修复与黑名单补漏，附相近安全形态（普通 `curl`/`wget`/`find`、`kill -9 <PID>`、`pkill`）的误伤防护回归测试。
- `tests/worker/security.test.ts` 新增 178 行回归测试覆盖限流机制、匿名身份剥离、可信头注入防御的安全边界。

### Note

- 本次安全策略调整方向：**AI 大脑仍是主决策者**，底层 `isBlockedCommand` / `needsConfirmation` 仅在 AI 漏判时兜底。system prompt 中风险判断引导与 `ask_user_confirmation` 工具未变动，AI 主动判断空间完整保留。

## [1.0.7] - 2026-07-13

### Fixed

- 修复 `bigIntMod` 大数取模卡死：RSA 私钥认证时逐字节减法循环复杂度为 O(a/m)，大密钥下无限循环。改用原生 `BigInt` 取模，O(1) 完成。
- 修复 ECDH 共享密钥未做全零校验：不符合 RFC 5656 §4 要求，现拒绝全零共享密钥。
- 修复 KEX_INIT 解析缺少边界检查：畸形包可导致 buffer 越界读取，现对 `length` 字段和 `offset` 做前置校验。
- 修复 SSH 包 padding 长度未校验：缺少 `paddingLength < 4`（RFC 4253 §6 最小填充）和 `>= packetLength` 越界检查，两条解析路径均已补齐。
- 修复 NEWKEYS 后序列号未重置：不符合 RFC 4253 §7.3 规范，现发送 NEWKEYS 后立即将 `seqNumSend` 和 `packetParser.seqNum` 归零。
- 修复 Agent 确认等待无法被中止：`askConfirmation` 在 Agent 被停止时永久挂起，新增 `askConfirmationWithAbort` 通过 `Promise.race` 响应 abort 信号。
- 修复终端 resize 事件监听器内存泄漏：匿名箭头函数无法 `removeEventListener`，现存储引用并在 `dispose()` 中正确移除。
- 修复会话就绪状态依赖硬编码中文匹配：`sendStatus` 新增结构化 `event` 字段（`auth_success`/`shell_ready`），前端优先匹配事件名，向后兼容旧消息文本。
- 修复 `user_id` 参数缺少 `isNaN` 校验：5 处内部 API 的 `parseInt` 结果未校验，可被注入非数字字符串。
- 修复 500 错误响应泄露内部错误信息：`handleServersRoute` 的 catch 块直接返回原始 `e.message`，现统一返回 `"Internal Server Error"`。
- 修复 `ip-geo.ts` 区域推断返回无效 `apac-ne`：非合法 Cloudflare DO locationHint，现统一为 `apac`。
- 修复 SSH 连接配置通过 URL query param 传递的安全隐患：私钥等敏感信息会出现在 URL 日志和浏览器历史中，改用 `x-ssh-config` HTTP header 传递，同时避免 URL 长度超限。
- 修复 LLM 输出未脱敏：Agent 工具执行结果在送入 LLM 前未过滤敏感信息，现正则脱敏 PEM 私钥、JWT、GitHub Token、AWS Key ID 四类密钥。

### Added

- 新增 WebSocket 错误日志：`webSocketError` 回调补充 `console.error` 便于排查连接异常。
- 新增 `derivedKeyCache` 加密密钥缓存：PBKDF2 10 万次迭代开销大，缓存 `CryptoKey` 避免重复推导。

## [1.0.6] - 2026-07-12

### Added

- 新增 DO locationHint 智能区域调度：保存服务器时自动通过 ipinfo.io 查询目标 IP 地理位置，推断最优 Cloudflare DO 部署区域并持久化到数据库，连接时直接读取，零运行时外部 API 调用。
- 新增 `src/worker/ip-geo.ts`：IP 地理位置推断模块，支持 11 个 Cloudflare DO 区域（wnam/enam/sam/weur/eeur/apac/oc/afr/me 等），US/CA 按经度细分东西海岸。
- 新增 `frontend/src/regions.ts`：共享区域选项组件，供服务器管理弹窗和匿名连接表单共用。
- 服务器管理弹窗新增区域下拉选择器（默认"自动"），编辑时显示系统推断值。
- 匿名连接表单新增区域高级选项（仅手动覆盖，不自动推断）。
- DEBUG_MODE 模式下保存服务器时显示推断过程调试弹窗。

### Changed

- `servers` 表新增 `region`（用户手动覆盖）和 `inferred_hint`（系统推断持久化）两列，使用幂等 `PRAGMA table_info` 守卫安全迁移。
- `handleAddServer` 保存时触发一次性 IP 地理推断并写入 `inferred_hint` 列。
- `handleUpdateServer` host 变更时自动重新推断。
- `handleConnectServer` 连接时直接读 DB 注入 `locationHint`，零运行时外部调用。
- `handleSSHConnection` 匿名路径仅读取 URL `?region=` 参数作为手动覆盖。
- `handleTokenSSHConnection` 从 config.locationHint 读取，经白名单校验后传入 DO `get()`。
- 终端输入不再触发无意义的 `JSON parse failed` 噪音日志（仅对 `{` 开头的消息尝试解析）。
- IP 地理推断 API 从 ipapi.co 切换到 ipinfo.io（免费 50k 次/月，避免 Workers 共享 IP 下的 429 限流）。

### Note

- **locationHint 是 Cloudflare 的 best-effort 特性**：Cloudflare 会尽力在指定区域实例化 DO，但不保证一定成功。当目标区域 DO 容量不足时，会 fallback 到最近的可用区域。免费计划下亚太区域 DO 容量有限，可能无法总是分配到最近节点。

## [1.0.5] - 2026-07-12

### Fixed

- 修复 SSRF 防护 IPv6 绕过漏洞：`validateBaseUrl` 未剥离 `[::1]` 方括号，导致用户可将 AI base_url 指向本机 IPv6 回环地址，绕过内网拦截。
- 修复 Agent 安全确认 `apk` 子命令漏覆盖：`needsConfirmation` 正则缺失 Alpine 系 `apk add/del`，可静默安装/卸载系统包而无需用户确认。
- 修复 `crypto.ts` 异常路径二次崩溃：catch 块中读取 `ciphertext.length` 在 null 输入时自身 throw，导致 graceful degradation 失效。

### Added

- 完成 SSH 协议层阶段 1+2 测试覆盖，共 9 个测试文件、347 个用例，覆盖 `safety`、`ssrf`、`algorithms`、`kex`、`crypto`（100%）、`packet`（96%）、`utils`（100%）核心模块。
- 新增 worker 接缝安全测试套件（`tests/worker/security.test.ts`，12 用例），通过路由入口验证 CSRF、IDOR 越权、SSRF 接缝、签名伪造、CSWSH 五类安全边界。

### Changed

- 将 `coverage/` 目录加入 `.gitignore`。

## [1.0.4] - 2026-07-11

### Added

- 新增 RSA 私钥认证支持：支持 `rsa-sha2-256` 签名算法，兼容 RSA 2048/4096 位密钥。
- 新增 ECDSA 私钥认证支持：支持 `ecdsa-sha2-nistp256`、`ecdsa-sha2-nistp384`、`ecdsa-sha2-nistp521` 曲线。
- 前端新增密钥文件上传功能：支持 `.pem`、`.key`、`.txt`、`.pub` 格式的私钥文件直接上传。
- 新增完整的单元测试套件：基于 Vitest 框架，包含 36 个测试用例，覆盖 SSH 认证、工具函数、类型定义等核心模块。

### Changed

- 移除测试命令中的 `--passWithNoTests` 选项，确保测试文件存在时必须通过。

### Fixed

- 修复 RSA 私钥 PKCS#8 结构中 CRT 参数（exponent1、exponent2）使用占位符的问题，现正确计算 `d mod (p-1)` 和 `d mod (q-1)`。
- 修复 ECDSA 私钥 PKCS#8 结构，使其符合 RFC 5915 和 RFC 5208 标准。

## [1.0.3] - 2026-07-10

### Improved

- 优化 AI Agent 超时机制，大幅提升复杂部署任务的执行能力：
  - 看门狗超时从 60 秒增加到 300 秒（5 分钟），命令执行超时从 60 秒增加到 180 秒（3 分钟）。
  - 基础迭代次数从 30 次增加到 50 次，扩展机会从 3 次增加到 5 次，最大总迭代次数从 90 次增加到 175 次。
  - 循环检测窗口从 5 增加到 7，重复率阈值从 60% 放宽到 70%，命令多样性阈值从 30% 放宽到 20%。
  - 消息裁剪阈值从 40 条增加到 60 条，保留更多对话上下文。
  - 长时间命令（>60 秒）自动每 60 秒重置看门狗计时器，防止执行期间意外超时。
  - 前端新增进度扩展提示，自动延期时显示当前进度和延期原因。

## [1.0.2] - 2026-07-10

### Fixed

- 修复多分辨率下前端页面内容被裁切与溢出的系统性问题，全面优化了响应式布局：
  - 修复了小视口（如小屏或横屏）下登录表单被裁切且无法滚动的问题。
  - 修复了在窄屏下，终端页面中 AI Agent 面板和 SFTP 面板使用固定宽度导致的溢出或极度挤压终端区域的 Bug。
  - 优化了 SFTP 右键菜单的边界检测逻辑，防止在屏幕边缘展开时被视口遮挡。
  - 为终端工具栏、底部状态栏、用户空间顶部导航等区域增补了 flex-wrap 及截断策略，彻底解决了各元素重叠或溢出的情况。

## [1.0.1] - 2026-07-09

### Fixed

- 修复 Agent 在执行复杂多步任务时容易达到 `maxIterations` 上限而被强制终止的问题，引入动态进度追踪（Progress Tracker）与智能延期机制。
- 修复长对话触发上下文截断时，因分组逻辑缺陷导致部分 `tool` 结果孤立丢失，进而引起 LLM 重复执行已完成步骤的 Bug。
- 精简 Agent 环境探测命令，并为摘要生成添加防抖，显著降低隐性 LLM 调用与 SSH 开销。

## [1.0.0] - 2026-07-09

这是 CloudSSH 的首个正式版本（v1.0.0），标志着整个基于 Cloudflare Workers + Durable Objects 边缘 Serverless 架构的 Web SSH 及 SFTP 客户端已达到生产环境交付标准。

### Added

#### 1. 核心 SSH 连接与自研协议栈

- **自研纯 TS SSH-2.0 协议栈**：不依赖第三方 Native/WASM 库，利用 Web Crypto API 实现了完整的传输层和加密规范，包体轻量。
- **高兼容性算法支持**：
  - **密钥交换**：curve25519-sha256、ecdh-sha2-nistp256。
  - **数据加密**：aes256-gcm、aes128-gcm、aes256-ctr 等。
  - **完整性校验**：hmac-sha2-256、hmac-sha2-512。
  - **认证机制**：支持密码认证及 Ed25519 纯文本私钥认证。
- **主机指纹防篡改 (TOFU)**：支持 Ed25519/ECDSA/RSA 主机密钥自动提取与 SHA-256 指纹展示；在本地及 API 持久化缓存已知主机指纹以防范二次连接的中间人伪造攻击。
- **双栈兼容**：原生支持 IPv4 和 IPv6（包含方括号格式的自动规整与连接支持）。

#### 2. 图形化 SFTP 文件传输系统

- **并行 SFTP v3 实现**：基于独立 WebSocket 通道与 SSH 文件子系统通道并行交互，终端与文件传输并行不卡顿。
- **完善的交互功能**：支持图形化目录浏览、文件上传/下载、新建文件夹、文件重命名、删除及批量上传下载队列管理（支持上传和下载的任务取消）。
- **拖拽式与原生文件传输**：集成 trzsz.js（支持 trz/tsz 拖拽传输、断点续传、目录传输，完美兼容 tmux 会话）。

#### 3. 具有两层安全机制的 AI Agent 智能运维助手

- **AI Agent 侧边栏**：BYOK（自带 API Key）一键连接兼容 OpenAI/Gemini/DeepSeek 的云端大模型，支持流式逐字加载。
- **8 大运维专用工具链**：支持执行命令、读取屏幕交互缓冲、环境探测、进程监控（内存排序）、systemd 服务管理、Docker 容器管理、交互式确认与 Markdown 结构化报告输出。
- **两层安全防线**：
  - **主观/客观拦截（Blocked Patterns）**：硬编码直接拒绝高危指令（如 rm -rf /、fork 炸弹等）。
  - **确认提醒机制（Confirmation Patterns）**：对高风险操作（包管理器 apt/yum 安装卸载、服务启停、sudo 权限等）强制触发前端交互弹窗确认，用户授权后方可执行。
- **防冬眠与看门狗重置**：
  - 在大模型调用及工具执行成功时自动重置 60 秒的看门狗超时定时器，在安全确认等待期间自动挂起超时计数。
  - 核心执行循环（runLoop）添加 5 秒/次的活跃心跳检测，防止 Durable Object 因闲置而被 CF 平台强行 Hibernate（冬眠）断开连接。
- **折叠式思考过程容器**：多步骤工具链任务执行时，实时预览最近 1-2 条执行的命令和步骤数，完成后自动折叠，支持展开回溯完整命令历史。

#### 4. 极客前端 UI 与可视化主题编辑器

- **模块化前端体验**：基于 Vite + TypeScript + Tailwind CSS 及 @xterm/xterm 硬件加速渲染，支持长屏幕日志一键导出下载 .txt 文本，以及终端文本实时检索（Ctrl+Shift+F）。
- **单页面多标签会话**：支持在单个网页内并发管理多个独立的 SSH 会话与 SFTP 面板，环境彼此隔离，支持单独关闭和快速切换。
- **双段延迟与 Colo 数据中心展示**：状态栏实时且周期性心跳刷新当前 RTT（客户端至 Cloudflare 节点）及实际物理延迟（Cloudflare 至主机），并展示当前所在的 Cloudflare 边缘数据中心代码（如 CF-LAX）。
- **可视化主题编辑器**：提供 Glacier、Gruvbox、Cyberpunk 三款内置主题。用户可在线修改终端调色板并一键同步跨设备云端存储，同时生成并导出/导入自定义主题 JSON 配置。

#### 5. 安全与边缘沙盒隔离

- **SQLite 存储隔离**：借助 Cloudflare Durable Objects 和 SQLite 存储，将每个用户的会话隔离在安全沙盒中。
- **凭据零暴露**：基于 One-Time-Token 一次性连接令牌流转机制，密码与私钥从不进入前端，完全在边缘节点 Workers 内部流转。
- **SSRF 过滤防护**：Workers 层面针对 IPv6 与本地保留地址进行 SSRF 检测防御拦截。
- **本地连接记录加密**：可选择使用由本地加密证书派生的密钥，通过 AES-256-GCM 算法加密存储最近 5 条匿名连接记录至 localStorage，提供一键回填与敏感字段清理。
