# 移动端交互说明

本次优化不改变 SSH 协议、认证协议、分享权限或 SFTP 数据通道，不引入后台传输或第二份终端文本缓存。

## 终端选择与字号

- 点击工具栏「选择」或「更多 → 选择文本」，收起软键盘并进入选择模式；拖动文字建立选区，松手后可继续拖动起止手柄调整。
- 手柄点击区为 44px，靠近屏幕边缘时保持可触及；短选区的命中区重叠时按可见圆点距离判断端点。拖动保持抓取偏移，不会因为手指未落在字符中心而立即跳选。
- 接近终端上下边缘时，最多约 18 行/秒滚动普通缓冲区历史；松手、取消、尺寸变化、离开选择模式和连接切换都会停止。此路径只滚动本地历史，绝不发送方向键或 tmux 鼠标报告。
- 通过「复制」「取消」结束；有权限的已登录用户可把选区附加给 AI，仍需用户另行发送问题。复制失败保留选区，原桌面鼠标选中自动复制不变。
- 仅选择模式阻断终端内原生长按菜单，普通状态及手动粘贴框仍可使用系统粘贴。
- 「更多 → 终端字号」可设置 12–18px，或恢复自动模式。自动模式仍按视口使用 12/13/14px；偏好只存本机 `cloudssh_terminal_font_size`，不随账户/服务器同步。存储被禁用时当前页面仍可调整。
- 软键盘仅改变终端行数时，坐标仍有效的选区会恢复。字号/列数重排则结束选择并提示重新选择，避免手柄指向错误内容；不会暂停远端输出。

软键盘视口变化到来时立即取消旧的适配计时器，再等待画面更新与 120ms 稳定期；启动时先保存初始高度，避免首帧延迟把已弹出的键盘误当成初始状态。旋转仍重新建立高度基线。认证挑战优先聚焦首个输入（零提示时为「继续」），迟到的聚焦回调不抢走用户已选择的验证码字段或取消按钮。

## SFTP

- 单击仍为选中；选择一项后点击固定在操作栏前部的「打开」。目录进入、文件沿用现有编辑/不可编辑下载策略，软链接仍按需解析。
- 「打开／多选」固定在左侧，上传、新建等工具只在右侧独立区域横向滚动并裁剪；不会从固定操作后方或左侧留白透出文字，玻璃主题无需叠加不透明遮罩。
- 「多选」开启勾选模式，行点击切换选中状态；可全选、清空，复用现有批量下载/删除。多选模式不响应双击打开，也不以原生长按菜单替换当前选区。
- 导航、刷新或关闭退出多选模式；回到桌面断点后恢复原有 Ctrl/⌘/Shift 点击语义。
- 有上传、下载或等待队列时，用户主动关闭（含头部右滑）、切换标签/抽屉、返回连接页或断开前先确认。取消保留原视图及传输；确认后执行原有关闭流程，远端可能残留部分文件。
- 底层 `hide()`/`dispose()`、断线、账号切换和强制清理不等待用户。确认绑定面板队列代际与标签/身份，迟到批准不会误操作新会话。无传输时不额外弹窗。

## 标签操作与粘贴

- 「更多 → 当前标签操作」复用重命名、克隆会话、关闭其他标签和关闭当前标签菜单；不需要长按或双击。独立单终端/分享路由隐藏该入口。
- 保存服务器克隆仍申请独立的一次性令牌；匿名会话不可克隆，只有一个标签时禁用「关闭其他标签」。
- 读取系统剪贴板失败时显示手动粘贴对话框。可使用系统菜单粘贴，检查内容后明确确认；Enter 在文本框内换行，不直接发送。
- 单次手动提交最多 65,536 个字符，超过限制明确拒绝，不静默截断。多行文本可能立即执行命令，界面对此明确提示。
- 文本不进入 localStorage、日志或草稿；取消、切换标签、离开终端、断线/重连、销毁后清空。迟到的剪贴板读取不能发送到替代 WebSocket。
- 成功后仍走 xterm 的换行规范化、远端协商的 bracketed paste 和 trzsz 路径，并要求 Shell 已就绪。

## 移动 Agent、菜单与玻璃主题

- 移动端隐藏「分析报错／系统负载／端口网络／Docker 状态」四个建议及其空白占位，把空间留给输出；中断任务的恢复按钮仍可使用，桌面建议不变。
- 终端「更多」菜单将「外部AI助手MCP设置」紧接在「AI Agent 助手」之后。长菜单整体滚动，不压缩主题、字号或按钮行；匿名与分享会话的入口权限不变。
- 内置 Liquid Glass 在移动断点（≤767px，或粗指针且≤1180px）使用近实底内容面板，以及实底菜单、弹窗和抽屉，避免后方文字叠透；仍保留背景渐变、圆角、边缘与阴影。桌面、其他内置主题与自定义主题配色不变。

## 验证范围

自动回归：

```bash
pnpm exec vitest run tests/terminal-font-preference.test.ts tests/frontend-ux.test.ts tests/i18n.test.ts
pnpm exec playwright test tests/e2e/mobile-selection.spec.ts tests/e2e/mobile-sftp.spec.ts tests/e2e/mobile-terminal-actions.spec.ts --workers=2
pnpm exec playwright test tests/e2e/mobile-terminal.spec.ts tests/e2e/auth-challenge.spec.ts --workers=2
pnpm exec playwright test tests/e2e/mobile-glass.spec.ts tests/e2e/mcp.spec.ts tests/e2e/agent-responses.spec.ts --workers=2
```

移动精细操作、玻璃表面及上述 Agent/MCP 回归均在 Chromium 和 WebKit 移动项目运行；既有移动终端、用户空间和剪贴板套件也加入 WebKit。桌面右键用例显式使用精细指针；文本自动缩放属性仅在引擎支持时检查，不能把桌面 WebKit 的设备模拟等同于 iOS 自动缩放实现。

**发布前仍应在真实 iPhone Safari、Android Chrome 上检查以下项目，自动化通过不代表已经完成真机验收：**

- 首列/末列、单字符、中文/Emoji/组合字符、换行与跨屏日志选择；手指不会持续遮住唯一可用的选区定位反馈。
- 原生长按菜单、选择模式退出后的系统粘贴、软键盘弹出/收起与横竖屏切换。
- 连续输出、滚动历史与 tmux 下选择优先、不误发输入；边缘自动滚动松手即停。
- 320px 窄屏、三语、四主题下操作区可达；字号调整不会改变表单 16px 输入规则。
- SFTP 不相邻多选、打开软链接、批量操作与传输中主动离开/取消；横向滚动工具时左侧「打开／多选」无文字透出。
- 更多菜单主题/字号区域不重叠，MCP 位于 Agent 下方；移动 Agent 无四个普通建议，中断任务仍有恢复入口。
- Liquid Glass 的菜单、弹窗和抽屉在密集终端输出上清晰可读；切回桌面与其他主题后原样式正常。

尚未扩展：终端放大镜/双指缩放、后台传输、大文件下载架构、完整 VoiceOver/TalkBack 阅读模式。

## English summary

Use **Select** to create and adjust a terminal selection, **Copy/Cancel** to finish, and **More → Terminal font size** for a device-local size preference. SFTP provides explicit **Open** and checkbox selection. Leaving active transfers asks before cancelling them; forced cleanup remains immediate. **Current tab actions** reuses the existing tab menu. Clipboard-read failures offer a nonpersistent manual paste dialog, bound to the originating connection and limited to 65,536 characters. On mobile, generic Agent suggestions are hidden while interrupted-task recovery remains available. MCP settings follow Agent in the terminal menu; menu rows scroll rather than overlap. Built-in Liquid Glass uses more opaque reading surfaces on mobile without changing desktop or custom palettes. Real iOS/Android testing is still required for native menus, touch ergonomics and soft keyboards; desktop browser emulation cannot certify those behaviors.
