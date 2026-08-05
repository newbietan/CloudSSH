const messages = {
  'zh-CN': {
    'meta.description': 'CloudSSH 是基于 Cloudflare Workers 的 Serverless Web SSH 终端，集成 SFTP、AI 助手、移动端适配和 Theme V2。',
    'a11y.skip': '跳到主要内容',
    'a11y.primaryNav': '主要导航',
    'a11y.terminalPreview': 'CloudSSH 终端界面预览',
    'a11y.themePresets': 'Theme V2 内置主题预览',
    'nav.features': '核心能力',
    'nav.architecture': '架构',
    'nav.themes': '主题',
    'nav.deploy': '部署',
    'hero.eyebrow': '开源 · Serverless · 全球边缘网络',
    'hero.titleLine1': '把服务器终端，',
    'hero.titleLine2': '放进任何浏览器。',
    'hero.lead': 'CloudSSH 基于 Cloudflare Workers 与 Durable Objects，在边缘节点完成 SSH 协议处理。无需安装客户端，也无需维护传统中转服务器。',
    'action.production': '打开正式演示',
    'action.test': '体验测试版本',
    'action.themeEditor': '在线设计主题',
    'action.openThemeEditor': '打开在线主题编辑器',
    'common.test': '测试',
    'hero.fact1Value': '纯 TypeScript',
    'hero.fact1Label': '自研 SSH-2.0 协议栈',
    'hero.fact2Value': '零传统服务器',
    'hero.fact2Label': 'Cloudflare 原生架构',
    'hero.fact3Value': '桌面 + 移动端',
    'hero.fact3Label': '随时访问你的终端',
    'terminal.connected': '已连接',
    'hero.sftpTitle': '批量文件管理',
    'hero.sftpText': '多选 · 队列 · 取消',
    'hero.agentTitle': '运维智能助手',
    'hero.agentText': '上下文 · 工具 · 确认',
    'portal.kicker': '立即体验',
    'portal.productionTitle': '正式演示站',
    'portal.testTitle': '测试演示站',
    'portal.themeTitle': 'Theme V2 编辑器',
    'portal.themeMeta': '设计 · 预览 · 导出 JSON',
    'video.kicker': '完整演示',
    'video.title': '先看它如何工作，再决定是否部署。',
    'video.lead': '8 分 27 秒演示从连接服务器、终端操作到文件管理的完整流程。视频可直接在本页播放。',
    'video.frameTitle': 'CloudSSH B 站演示视频',
    'video.openBilibili': '在 B 站打开',
    'features.kicker': '不只是一个 Web 终端',
    'features.title': '连接、管理、传输与协作，都在一个标签页内。',
    'features.lead': 'CloudSSH 将终端、文件管理与智能运维组合为完整工作流，同时保持部署简单、边界清晰。',
    'feature.sshTitle': '浏览器原生 SSH-2.0',
    'feature.sshText': '纯 TypeScript 协议栈，支持 Curve25519、ECDH、AES-GCM/CTR、Ed25519、ECDSA 与 RSA，无需外部 SSH 库。',
    'feature.sftpTitle': '可视化 SFTP',
    'feature.sftpText': '目录浏览、上传下载、重命名与删除；支持多选、连续选择、批量任务、传输队列和取消。',
    'feature.agentTitle': 'AI 运维助手',
    'feature.agentText': 'BYOK 接入 OpenAI 兼容模型，理解终端上下文并调用 8 个运维工具；危险命令需要确认，高风险模式直接拦截。',
    'feature.agentPrompt': '分析当前服务状态…',
    'feature.mobileTitle': '真正可用的移动终端',
    'feature.mobileText': '适配软键盘、安全区、iOS 输入法、触摸选区和快捷键栏，手机 3 张、平板 6 张、桌面 9 张服务器卡片。',
    'feature.sessionTitle': '多会话与低延迟反馈',
    'feature.sessionText': '单页面管理多个隔离会话，状态栏同时展示客户端 RTT、Cloudflare 到主机的连接延迟与 Colo 节点。',
    'capability.kicker': '完整能力版图',
    'capability.title': '常用能力已经连成一套，而不是散落的功能开关。',
    'capability.identityTitle': '身份与服务器管理',
    'capability.identityText': 'GitHub OAuth、已保存服务器、标签筛选与加密凭据存储。',
    'capability.trustTitle': '主机信任',
    'capability.trustText': '首次连接展示 SHA-256 指纹，后续连接检测 Host Key 变化。',
    'capability.networkTitle': '广泛连接兼容',
    'capability.networkText': 'IPv4 / IPv6 双栈，兼容 OpenSSH 与 Dropbear。',
    'capability.transferTitle': '两种文件流',
    'capability.transferText': '可视化 SFTP 与 trzsz 原生终端传输并行可用。',
    'capability.privacyTitle': '隐私展示与区域调度',
    'capability.privacyText': 'IP 视觉掩码减少截图泄露；保存服务器时可借助 IPinfo 优化区域。',
    'capability.qualityTitle': '持续质量门禁',
    'capability.qualityText': '类型检查、单元与集成测试、可复现构建、E2E 与无障碍回归。',
    'architecture.kicker': '架构设计',
    'architecture.title': '浏览器到服务器，只有必要的三层。',
    'architecture.lead': '控制面、会话状态和 TCP 连接都运行在 Cloudflare 原生服务中，不需要常驻 VPS 中转层。',
    'architecture.clientTag': '客户端',
    'architecture.clientTitle': '浏览器',
    'architecture.edgeText': '路由、认证、SSH 会话与用户数据',
    'architecture.serverTag': '目标端',
    'architecture.serverTitle': '你的 SSH 服务器',
    'architecture.note1': '浏览器与边缘节点之间使用 HTTPS/WSS。',
    'architecture.note2': 'Worker 与目标主机之间建立完整加密 SSH 会话。',
    'architecture.note3': '每个活动会话由独立 Durable Object 管理并彼此隔离。',
    'themes.title': '主题不止换颜色，也改变界面的性格。',
    'themes.lead': '颜色、形状、密度、字体、阴影、动效和组件风格统一进入版本化主题格式。在线编辑、实时预览，再导出 JSON 到 CloudSSH。',
    'themes.dimension1': '颜色与对比度',
    'themes.dimension2': '圆角与布局密度',
    'themes.dimension3': '字体、阴影与动效',
    'themes.dimension4': '按钮、输入框、卡片与标签页',
    'security.kicker': '安全边界',
    'security.title': '明确每一段信任，也明确每一项限制。',
    'security.lead': 'CloudSSH 不以“浏览器工具”作为降低安全标准的理由。连接、身份、主机指纹、凭据和 AI 操作分别建立边界。',
    'security.inspectSource': '审查安全实现',
    'security.item1Title': '分段加密',
    'security.item1Text': '浏览器到 Worker 使用 HTTPS/WSS，Worker 到服务器使用 SSH-2.0。',
    'security.item2Title': 'TOFU 主机校验',
    'security.item2Text': '首次展示 SHA-256 指纹，后续连接检测 Host Key 变化。',
    'security.item3Title': '凭据内部流转',
    'security.item3Text': '已保存凭据通过一次性令牌在服务端内部传递，不返回浏览器。',
    'security.item4Title': 'AI 操作确认',
    'security.item4Text': '危险命令默认要求用户确认，禁止模式直接拒绝执行。',
    'deploy.kicker': '快速部署',
    'deploy.title': '从 Fork 到自己的 Web SSH，只需三步。',
    'deploy.lead': '使用 Cloudflare Dashboard Git 集成或 Wrangler CLI。域名、OAuth 和 Turnstile 都是可选配置。',
    'deploy.step1Title': 'Fork 仓库',
    'deploy.step1Text': '复制 CloudSSH 到自己的 GitHub 账号，保留后续同步上游的能力。',
    'deploy.step2Title': '连接 Cloudflare',
    'deploy.step2Text': '在 Workers & Pages 中连接仓库，使用项目内置构建配置。',
    'deploy.step3Title': '配置并访问',
    'deploy.step3Text': '按需添加 OAuth、Turnstile 和自定义域名，然后开始连接服务器。',
    'deploy.readGuide': '查看完整部署指南',
    'deploy.forkNow': 'Fork CloudSSH',
    'openSource.title': '代码开放，边界透明，欢迎共同完善。',
    'openSource.text': 'CloudSSH 由 TanXin（@newbietan）发起并持续维护。你可以审查协议实现、安全策略和部署过程，也可以通过 Issue 与 Pull Request 参与项目。',
    'openSource.github': '查看 GitHub 仓库',
    'openSource.contributors': '贡献者名单',
    'footer.tagline': '运行在 Cloudflare 上的 Serverless Web SSH 终端。',
    'footer.production': '正式演示',
    'footer.test': '测试演示',
    'footer.theme': '主题编辑器'
  },
  'en-US': {
    'meta.description': 'CloudSSH is a serverless Web SSH terminal on Cloudflare Workers with SFTP, an AI assistant, mobile support, and Theme V2.',
    'a11y.skip': 'Skip to main content',
    'a11y.primaryNav': 'Primary navigation',
    'a11y.terminalPreview': 'CloudSSH terminal interface preview',
    'a11y.themePresets': 'Theme V2 preset preview',
    'nav.features': 'Features',
    'nav.architecture': 'Architecture',
    'nav.themes': 'Themes',
    'nav.deploy': 'Deploy',
    'hero.eyebrow': 'Open source · Serverless · Global edge network',
    'hero.titleLine1': 'Put your server terminal',
    'hero.titleLine2': 'in any browser.',
    'hero.lead': 'CloudSSH uses Cloudflare Workers and Durable Objects to handle SSH at the edge. No client installation and no traditional relay server to maintain.',
    'action.production': 'Open production demo',
    'action.test': 'Try test release',
    'action.themeEditor': 'Design a theme online',
    'action.openThemeEditor': 'Open the theme editor',
    'common.test': 'TEST',
    'hero.fact1Value': 'Pure TypeScript',
    'hero.fact1Label': 'In-house SSH-2.0 stack',
    'hero.fact2Value': 'No traditional server',
    'hero.fact2Label': 'Cloudflare-native architecture',
    'hero.fact3Value': 'Desktop + mobile',
    'hero.fact3Label': 'Reach your terminal anywhere',
    'terminal.connected': 'Connected',
    'hero.sftpTitle': 'Batch file management',
    'hero.sftpText': 'Multi-select · Queue · Cancel',
    'hero.agentTitle': 'Operations AI assistant',
    'hero.agentText': 'Context · Tools · Confirmation',
    'portal.kicker': 'Explore now',
    'portal.productionTitle': 'Production demo',
    'portal.testTitle': 'Test demo',
    'portal.themeTitle': 'Theme V2 editor',
    'portal.themeMeta': 'Design · Preview · Export JSON',
    'video.kicker': 'Full walkthrough',
    'video.title': 'See how it works before you deploy.',
    'video.lead': 'An 8:27 walkthrough covering server connection, terminal operations, and file management. Play it directly on this page.',
    'video.frameTitle': 'CloudSSH demo video on Bilibili',
    'video.openBilibili': 'Open on Bilibili',
    'features.kicker': 'More than a Web terminal',
    'features.title': 'Connect, manage, transfer, and collaborate in one tab.',
    'features.lead': 'CloudSSH combines terminal access, file management, and intelligent operations into one coherent workflow while keeping deployment simple and boundaries clear.',
    'feature.sshTitle': 'Browser-native SSH-2.0',
    'feature.sshText': 'A pure TypeScript stack with Curve25519, ECDH, AES-GCM/CTR, Ed25519, ECDSA, and RSA—without an external SSH library.',
    'feature.sftpTitle': 'Visual SFTP',
    'feature.sftpText': 'Browse, upload, download, rename, and delete with multi-select, ranges, batch tasks, transfer queues, and cancellation.',
    'feature.agentTitle': 'AI operations assistant',
    'feature.agentText': 'Bring an OpenAI-compatible model, reason over terminal context, and use eight operations tools. Dangerous commands require confirmation; blocked patterns never run.',
    'feature.agentPrompt': 'Analyze the current service state…',
    'feature.mobileTitle': 'A mobile terminal that works',
    'feature.mobileText': 'Handles soft keyboards, safe areas, iOS IME, touch selection, and shortcuts, with 3 server cards on phones, 6 on tablets, and 9 on desktops.',
    'feature.sessionTitle': 'Multiple sessions and live latency',
    'feature.sessionText': 'Manage isolated sessions on one page while the status bar shows client RTT, Cloudflare-to-host connection latency, and the active Colo.',
    'capability.kicker': 'Complete capability map',
    'capability.title': 'The everyday capabilities work as one system, not a pile of switches.',
    'capability.identityTitle': 'Identity and server management',
    'capability.identityText': 'GitHub OAuth, saved servers, tag filters, and encrypted credential storage.',
    'capability.trustTitle': 'Host trust',
    'capability.trustText': 'See the SHA-256 fingerprint on first connection and detect later Host Key changes.',
    'capability.networkTitle': 'Broad connectivity',
    'capability.networkText': 'IPv4 / IPv6 dual stack with OpenSSH and Dropbear compatibility.',
    'capability.transferTitle': 'Two file workflows',
    'capability.transferText': 'Use visual SFTP and native trzsz terminal transfers side by side.',
    'capability.privacyTitle': 'Private display and placement',
    'capability.privacyText': 'IP masking reduces screenshot exposure; IPinfo can optimize placement when a server is saved.',
    'capability.qualityTitle': 'Continuous quality gate',
    'capability.qualityText': 'Type checks, unit and integration tests, reproducible builds, E2E, and accessibility regression.',
    'architecture.kicker': 'Architecture',
    'architecture.title': 'Only the three layers you need from browser to server.',
    'architecture.lead': 'The control plane, session state, and TCP connection run on Cloudflare-native services. There is no always-on VPS relay layer.',
    'architecture.clientTag': 'Client',
    'architecture.clientTitle': 'Browser',
    'architecture.edgeText': 'Routing, identity, SSH sessions, and user data',
    'architecture.serverTag': 'Target',
    'architecture.serverTitle': 'Your SSH server',
    'architecture.note1': 'HTTPS/WSS protects the browser-to-edge segment.',
    'architecture.note2': 'The Worker establishes a complete encrypted SSH session to the target host.',
    'architecture.note3': 'A dedicated Durable Object manages and isolates each active session.',
    'themes.title': 'Themes change more than color—they change the interface character.',
    'themes.lead': 'Color, shape, density, typography, shadow, motion, and component styles share one versioned theme format. Edit online, preview live, and export JSON to CloudSSH.',
    'themes.dimension1': 'Color and contrast',
    'themes.dimension2': 'Shape and layout density',
    'themes.dimension3': 'Typography, shadow, and motion',
    'themes.dimension4': 'Buttons, inputs, cards, and tabs',
    'security.kicker': 'Security boundaries',
    'security.title': 'Make every trust boundary—and every limitation—explicit.',
    'security.lead': 'CloudSSH does not lower its security standard because it runs in a browser. Connections, identity, host keys, credentials, and AI actions each have their own boundary.',
    'security.inspectSource': 'Inspect the security implementation',
    'security.item1Title': 'Segmented encryption',
    'security.item1Text': 'HTTPS/WSS protects browser-to-Worker traffic; SSH-2.0 protects Worker-to-server traffic.',
    'security.item2Title': 'TOFU host verification',
    'security.item2Text': 'The first connection shows a SHA-256 fingerprint; later connections detect Host Key changes.',
    'security.item3Title': 'Internal credential flow',
    'security.item3Text': 'Saved credentials move server-side through one-time tokens and are not returned to the browser.',
    'security.item4Title': 'AI action confirmation',
    'security.item4Text': 'Dangerous commands require user confirmation, while prohibited patterns are rejected outright.',
    'deploy.kicker': 'Quick deployment',
    'deploy.title': 'Three steps from Fork to your own Web SSH.',
    'deploy.lead': 'Use Cloudflare Dashboard Git integration or Wrangler CLI. Custom domains, OAuth, and Turnstile are optional.',
    'deploy.step1Title': 'Fork the repository',
    'deploy.step1Text': 'Copy CloudSSH to your GitHub account and keep the option to sync future upstream releases.',
    'deploy.step2Title': 'Connect Cloudflare',
    'deploy.step2Text': 'Connect the repository in Workers & Pages and use the build configuration included with the project.',
    'deploy.step3Title': 'Configure and connect',
    'deploy.step3Text': 'Optionally add OAuth, Turnstile, and a custom domain, then start connecting to servers.',
    'deploy.readGuide': 'Read the full deployment guide',
    'deploy.forkNow': 'Fork CloudSSH',
    'openSource.title': 'Open code, transparent boundaries, and room to improve together.',
    'openSource.text': 'CloudSSH was initiated by TanXin (@newbietan), who continues to maintain it. Review the protocol implementation, security policy, and deployment path—or contribute through Issues and Pull Requests.',
    'openSource.github': 'View the GitHub repository',
    'openSource.contributors': 'Meet the contributors',
    'footer.tagline': 'A serverless Web SSH terminal on Cloudflare.',
    'footer.production': 'Production demo',
    'footer.test': 'Test demo',
    'footer.theme': 'Theme editor'
  }
};

const localeStorageKey = 'cloudssh_pages_locale';

function normalizeLocale(value) {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US';
  return null;
}

function getInitialLocale() {
  const queryLocale = normalizeLocale(new URLSearchParams(window.location.search).get('lang'));
  if (queryLocale) return queryLocale;

  try {
    const storedLocale = normalizeLocale(localStorage.getItem(localeStorageKey));
    if (storedLocale) return storedLocale;
  } catch {
    // Storage may be unavailable in privacy-restricted contexts.
  }

  return (navigator.languages || [navigator.language])
    .map(normalizeLocale)
    .find(Boolean) || 'zh-CN';
}

function applyLocale(locale, updateUrl = true) {
  const dictionary = messages[locale] || messages['zh-CN'];
  document.documentElement.lang = locale;

  document.querySelectorAll('[data-i18n]').forEach((element) => {
    const value = dictionary[element.dataset.i18n];
    if (value) element.textContent = value;
  });

  document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
    const value = dictionary[element.dataset.i18nAriaLabel];
    if (value) element.setAttribute('aria-label', value);
  });

  document.querySelectorAll('[data-i18n-title]').forEach((element) => {
    const value = dictionary[element.dataset.i18nTitle];
    if (value) element.setAttribute('title', value);
  });

  const metaDescription = document.querySelector('meta[name="description"]');
  const openGraphDescription = document.querySelector('meta[property="og:description"]');
  const twitterDescription = document.querySelector('meta[name="twitter:description"]');
  if (metaDescription) metaDescription.setAttribute('content', dictionary['meta.description']);
  if (openGraphDescription) openGraphDescription.setAttribute('content', dictionary['meta.description']);
  if (twitterDescription) twitterDescription.setAttribute('content', dictionary['meta.description']);

  const toggle = document.getElementById('language-toggle');
  const toggleLabel = document.getElementById('language-toggle-label');
  const isChinese = locale === 'zh-CN';
  if (toggleLabel) toggleLabel.textContent = isChinese ? 'English' : '简体中文';
  if (toggle) toggle.setAttribute('aria-label', isChinese ? 'Switch to English' : '切换到简体中文');

  try {
    localStorage.setItem(localeStorageKey, locale);
  } catch {
    // Language switching still works for the current page.
  }

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('lang', isChinese ? 'zh-CN' : 'en-US');
    history.replaceState(null, '', url);
  }
}

const activeLocale = getInitialLocale();
applyLocale(activeLocale, false);

document.getElementById('language-toggle')?.addEventListener('click', () => {
  applyLocale(document.documentElement.lang === 'zh-CN' ? 'en-US' : 'zh-CN');
});

document.getElementById('current-year').textContent = String(new Date().getFullYear());

const header = document.querySelector('.site-header');
const syncHeader = () => header?.classList.toggle('is-scrolled', window.scrollY > 12);
syncHeader();
window.addEventListener('scroll', syncHeader, { passive: true });

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const revealElements = document.querySelectorAll('.reveal');
if (reducedMotion || !('IntersectionObserver' in window)) {
  revealElements.forEach((element) => element.classList.add('is-visible'));
} else {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12 });
  revealElements.forEach((element) => observer.observe(element));
}
