# 站内弹窗样式

站内弹窗统一使用 `frontend/src/app-modal.css`。同一主题下，添加服务器、AI 配置、MCP、Windows 连接器等共用背景材质、边框、圆角、阴影、标题和遮罩；不同业务仍可有不同宽度、正文布局和滚动区域。

- 新弹窗优先使用原生 `<dialog class="app-modal">`，设置 `aria-labelledby`，内部放一个 `.app-modal__panel`。需要内边距时加 `.app-modal__inset`；复杂长表单只让正文滚动。宽度用 `--app-modal-width`，不要重新定义面板背景、圆角或遮罩。
- 动态界面可用 `frontend/src/modal-ui.ts` 的 `createModalHeader` 生成标题与三语关闭按钮；静态模板复用 `app-modal__header`、`app-modal__title`、`app-modal__close`。已有覆盖层继续使用 `.modal-overlay`。操作可复用 `.app-modal__actions` 和 `.app-modal__button`；主操作加 `app-modal__button--primary`，表单输入沿用 `.terminal-input`。
- 赛博朋克的顶边强调线由共享 CSS 提供，弹窗中不再单独绘制；移动 Liquid Glass 使用实底，桌面保持玻璃边缘和模糊。风险提示可覆盖标题强调色 `--app-modal-accent`，不可用另一套窗体替代文字说明。
- 弹窗的焦点、取消、请求取消及清理由业务负责。不要把全屏桌面、抽屉、下拉菜单或 Agent 对话中的行内确认套成模态弹窗。
- RDP 证书弹窗在同源隔离帧内复用同一份 CSS。父工作区只同步白名单主题变量，不把独立帧的证书确认或凭据处理移到共享 UI。

`tests/e2e/modal-themes.spec.ts` 比较四种主题中的实际服务器、AI、MCP 和 Windows 弹窗；`mobile-glass.spec.ts` 验证触屏/窄屏阅读材质。
