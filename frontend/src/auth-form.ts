// 渲染模板中的 innerHTML 站点均带 `pi-lens-ignore: no-inner-html` 内联抑制：
// 动态值均经 escapeHtml 转义或来自可信 i18n 词条，无用户输入直插；
// GitHub Actions 质量门禁不含该规则（AGENTS.md #27）。
import { onLocaleChange, t, translateDocument } from './i18n';
import { openAdminHashGeneratorDialog } from './admin-hash-generator';
import { loadKnownFingerprint } from './known-hosts';
import { parsePort } from './port';
import { stretchAdminPassword } from './password-stretch';
import { populateRegionSelect } from './regions';
import type { TabManager } from './tab-manager';
import { type ColorScheme, getActiveColorScheme, onColorSchemeChange } from './theme';
import { notify } from './ui-feedback';

// --- Credential encryption helpers ---
async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(window.location.origin + ':cloudssh');
  const baseKey = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as any, iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptCredentials(data: Record<string, unknown>): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(salt);
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  );
  const combined = new Uint8Array(salt.length + iv.length + encrypted.length);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(encrypted, salt.length + iv.length);
  let binary = '';
  for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary);
}

async function decryptCredentials(
  stored: string
): Promise<{
  host: string;
  port: string;
  username: string;
  password: string;
  privateKey?: string;
  authMethod?: string;
} | null> {
  try {
    const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    const salt = raw.slice(0, 16);
    const iv = raw.slice(16, 28);
    const data = raw.slice(28);
    const key = await deriveKey(salt);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return null;
  }
}

export interface ConnectionFormOptions {
  /** 获取 TabManager 实例 */
  getTabManager: () => TabManager;
}

export class ConnectionForm {
  private options: ConnectionFormOptions;
  private turnstileEnabled = false;
  private turnstileVerified = false;
  private turnstileWidgetId: string | null = null;
  private turnstileSitekey = '';
  private turnstileTheme: ColorScheme | null = null;
  /** 密码模式下的浏览器预拉伸参数（/api/config 公开下发）；null = 非密码模式 */
  private passwordAuthParams: { iterations: number; salt: string } | null = null;
  private adminDialogTurnstileId: string | null = null;

  constructor(options: ConnectionFormOptions) {
    this.options = options;
    this.render();
    onColorSchemeChange((colorScheme) => {
      if (
        this.turnstileEnabled &&
        this.turnstileSitekey &&
        !this.turnstileVerified &&
        this.turnstileTheme !== colorScheme
      ) {
        this.renderTurnstile();
      }
    });
    this.loadSavedCredentials();
    this.checkTurnstileConfig();
    onLocaleChange(() => {
      const select = document.getElementById('anon-region') as HTMLSelectElement | null;
      if (select) populateRegionSelect(select, select.value);
      this.renderRecentConnections();
    });
  }

  private async checkTurnstileConfig(): Promise<void> {
    try {
      const response = await fetch('/api/config');
      const config = (await response.json()) as {
        turnstileEnabled: boolean;
        sitekey: string;
        githubAuthEnabled: boolean;
        githubAuthRequired: boolean;
        authMode?: 'password' | 'github' | 'anonymous';
        passwordAuth?: { kdf: string; iterations: number; salt: string } | null;
        passwordHashInvalid?: boolean;
      };
      this.turnstileEnabled = config.turnstileEnabled;
      this.turnstileSitekey = config.sitekey;

      // 单管理员密码模式：登录入口整体替换（与 GitHub 入口互斥，不并列展示）。
      // 哈希损坏 → fail closed 错误面板（与后端坏哈希拒绝登录的语义对齐）
      if (config.authMode === 'password') {
        if (config.passwordHashInvalid || !config.passwordAuth) {
          this.renderAdminHashInvalid();
          return;
        }
        this.passwordAuthParams = {
          iterations: config.passwordAuth.iterations,
          salt: config.passwordAuth.salt,
        };
        if (config.githubAuthRequired) {
          this.renderAdminAuthRequired();
          return;
        }
        if (this.turnstileEnabled && this.turnstileSitekey) {
          this.renderTurnstile();
        }
        this.renderAdminLoginButton();
        return;
      }

      if (config.githubAuthRequired) {
        this.renderGitHubAuthRequired(config.githubAuthEnabled);
        return;
      }
      if (this.turnstileEnabled && this.turnstileSitekey) {
        this.renderTurnstile();
      }
      // 渲染 GitHub 登录按钮（仅当 OAuth 已配置时）
      if (config.githubAuthEnabled) {
        this.renderGitHubLoginButton();
      }
      // 入口可见性（模式感知）：仅匿名模式（未配置任何登录方式）保留页脚入口——
      // 密码模式的自然受众，保持零配置可发现性；GitHub 模式隐藏入口（升级后
      // 界面零变化），切换密码模式经 #password-setup 路由（README 引导）
      if (config.authMode === 'anonymous') {
        this.renderAdminHashGenEntry();
      }
    } catch {
      // Config endpoint not available, skip Turnstile
    }
  }

  private renderGitHubAuthRequired(githubAuthEnabled: boolean): void {
    const container = document.getElementById('connection-form-container');
    if (!container) return;

    // pi-lens-ignore: no-inner-html
    container.innerHTML = `
      <div class="flex min-h-[320px] flex-col items-center justify-center gap-5 px-4 text-center" id="github-auth-required-panel">
        <span class="material-symbols-outlined text-[var(--accent)]" style="font-size: 42px;" aria-hidden="true">lock</span>
        <div class="space-y-2">
          <h2 class="text-sm font-bold tracking-[0.1em] text-on-surface" data-i18n="auth.githubRequired">此 CloudSSH 实例需要 GitHub 登录</h2>
          <p class="mx-auto max-w-md text-xs leading-6 text-muted" data-i18n="auth.githubRequiredHint">登录成功且账号获得管理员授权后，才能使用 SSH 和账号功能。</p>
        </div>
        ${
          githubAuthEnabled
            ? '<span id="github-login-placeholder"></span>'
            : '<p class="text-xs text-error" data-i18n="auth.githubNotConfigured">管理员尚未完整配置 GitHub OAuth，当前无法登录。</p>'
        }
      </div>
    `;
    translateDocument(container);
    if (githubAuthEnabled) this.renderGitHubLoginButton();
    // GitHub 模式（含强制面板）不展示生成器入口：已做出登录选择的用户升级后界面零变化；
    // 切换密码模式经 #password-setup 路由（README 引导）
  }

  private renderGitHubLoginButton(): void {
    const placeholder = document.getElementById('github-login-placeholder');
    if (!placeholder) return;

    placeholder.innerHTML = `
      <button type="button" id="github-login-btn" class="github-login-btn text-[11px] font-bold tracking-[0.1em] text-muted hover:text-primary transition-all cursor-pointer flex items-center gap-1.5 bg-transparent border border-dim px-3 py-1 hover:border-[var(--accent)]">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        <span data-i18n="auth.login">使用 GitHub 登录</span>
      </button>
    `;
    translateDocument(placeholder);

    document.getElementById('github-login-btn')?.addEventListener('click', () => {
      window.location.href = '/api/auth/github';
    });
  }

  // ==================== 单管理员密码登录 UI ====================

  /** 密码模式下 GitHub 入口的位置整体替换为管理员登录按钮（同一挂载点） */
  private renderAdminLoginButton(): void {
    const placeholder = document.getElementById('github-login-placeholder');
    if (!placeholder) return;

    placeholder.innerHTML = `
      <button type="button" id="admin-login-btn" class="github-login-btn text-[11px] font-bold tracking-[0.1em] text-muted hover:text-primary transition-all cursor-pointer flex items-center gap-1.5 bg-transparent border border-dim px-3 py-1 hover:border-[var(--accent)]">
        <span class="material-symbols-outlined" style="font-size: 14px;" aria-hidden="true">admin_panel_settings</span>
        <span data-i18n="auth.adminLogin">管理员登录</span>
      </button>
    `;
    translateDocument(placeholder);

    document.getElementById('admin-login-btn')?.addEventListener('click', () => {
      this.openAdminLoginDialog();
    });
  }

  /** REQUIRE_GITHUB_AUTH=true 且密码模式：强制登录面板（文案替换为管理员语义） */
  private renderAdminAuthRequired(): void {
    const container = document.getElementById('connection-form-container');
    if (!container) return;

    // pi-lens-ignore: no-inner-html
    container.innerHTML = `
      <div class="flex min-h-[320px] flex-col items-center justify-center gap-5 px-4 text-center" id="admin-auth-required-panel">
        <span class="material-symbols-outlined text-[var(--accent)]" style="font-size: 42px;" aria-hidden="true">lock</span>
        <div class="space-y-2">
          <h2 class="text-sm font-bold tracking-[0.1em] text-on-surface" data-i18n="auth.adminRequired">此 CloudSSH 实例需要管理员登录</h2>
          <p class="mx-auto max-w-md text-xs leading-6 text-muted" data-i18n="auth.adminRequiredHint">请使用管理员密码登录后使用 SSH 和账号功能。</p>
        </div>
        <span id="github-login-placeholder"></span>
      </div>
    `;
    translateDocument(container);
    this.renderAdminLoginButton();
  }

  /** 坏哈希 fail closed 错误面板（后端同样拒绝登录，前端同步呈现原因） */
  private renderAdminHashInvalid(): void {
    const container = document.getElementById('connection-form-container');
    if (!container) return;

    // pi-lens-ignore: no-inner-html
    container.innerHTML = `
      <div class="flex min-h-[320px] flex-col items-center justify-center gap-5 px-4 text-center">
        <span class="material-symbols-outlined text-error" style="font-size: 42px;" aria-hidden="true">report</span>
        <div class="space-y-2">
          <h2 class="text-sm font-bold tracking-[0.1em] text-on-surface" data-i18n="auth.adminHashInvalidTitle">管理员密码配置无效</h2>
          <p class="mx-auto max-w-md text-xs leading-6 text-muted" data-i18n="auth.adminHashInvalid">ADMIN_PASSWORD_HASH 格式损坏，登录已停止，请联系管理员修复。</p>
        </div>
        <button type="button" id="admin-hash-regen-btn" class="github-login-btn text-[11px] font-bold tracking-[0.1em] text-muted hover:text-primary transition-all cursor-pointer flex items-center gap-1.5 bg-transparent border border-dim px-3 py-1 hover:border-[var(--accent)]">
          <span class="material-symbols-outlined" style="font-size: 14px;" aria-hidden="true">refresh</span>
          <span data-i18n="auth.adminHashGenRegenerate">在浏览器中重新生成</span>
        </button>
      </div>
    `;
    translateDocument(container);
    document.getElementById('admin-hash-regen-btn')?.addEventListener('click', () => {
      openAdminHashGeneratorDialog();
    });
  }

  /** 匿名/GitHub 模式页脚离散入口：浏览器内生成 ADMIN_PASSWORD_HASH（无需本地 Node 工具） */
  private renderAdminHashGenEntry(): void {
    const placeholder = document.getElementById('github-login-placeholder');
    const row = placeholder?.parentElement;
    if (!row || document.getElementById('admin-hash-gen-entry')) return;

    const entry = document.createElement('button');
    entry.type = 'button';
    entry.id = 'admin-hash-gen-entry';
    entry.className =
      'text-[10px] text-muted/70 hover:text-muted transition-all bg-transparent border-none cursor-pointer tracking-[0.05em] px-1';
    entry.textContent = t('auth.adminHashGenEntry');
    entry.title = t('auth.adminHashGenHint');
    entry.addEventListener('click', () => {
      openAdminHashGeneratorDialog();
    });
    row.appendChild(entry);
  }

  /** 管理员登录对话框：密码输入 + 可选 Turnstile，本地 PBKDF2 预拉伸后提交 */
  private openAdminLoginDialog(): void {
    if (!this.passwordAuthParams) return;

    this.closeAdminLoginDialog();

    const sequence = Date.now();
    const titleId = `admin-login-title-${sequence}`;
    const dialog = document.createElement('dialog');
    dialog.id = 'admin-login-dialog';
    dialog.className = 'auth-challenge-dialog';
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('aria-modal', 'true');

    const form = document.createElement('form');
    form.className = 'auth-challenge-dialog__panel';
    form.method = 'dialog';
    form.noValidate = true;

    const accent = document.createElement('div');
    accent.className = 'auth-challenge-dialog__accent';
    accent.setAttribute('aria-hidden', 'true');

    const header = document.createElement('div');
    header.className = 'auth-challenge-dialog__header';
    const icon = document.createElement('span');
    icon.className = 'auth-challenge-dialog__icon material-symbols-outlined';
    icon.textContent = 'admin_panel_settings';
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('h2');
    title.className = 'auth-challenge-dialog__title';
    title.textContent = t('auth.adminLoginTitle');
    title.id = titleId;
    header.append(icon, title);

    const label = document.createElement('label');
    label.className = 'auth-challenge-dialog__label';
    label.textContent = t('auth.adminPasswordLabel');
    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.className = 'auth-challenge-dialog__input';
    passwordInput.autocomplete = 'current-password';
    passwordInput.setAttribute('data-i18n-aria-label', 'auth.adminPasswordLabel');
    passwordInput.setAttribute('aria-label', t('auth.adminPasswordLabel'));

    const turnstileContainer = document.createElement('div');
    turnstileContainer.className = 'flex justify-center';
    let turnstileToken = '';
    if (this.turnstileEnabled && this.turnstileSitekey && window.turnstile) {
      const widget = document.createElement('div');
      turnstileContainer.appendChild(widget);
      this.adminDialogTurnstileId = window.turnstile.render(widget, {
        sitekey: this.turnstileSitekey,
        theme: getActiveColorScheme(),
        callback: (token: string) => {
          turnstileToken = token;
        },
        'expired-callback': () => {
          turnstileToken = '';
        },
        'error-callback': () => {
          turnstileToken = '';
        },
      });
    }

    const errorText = document.createElement('div');
    errorText.className = 'auth-challenge-dialog__warning';
    errorText.setAttribute('role', 'alert');
    errorText.style.display = 'none';

    const actions = document.createElement('div');
    actions.className = 'auth-challenge-dialog__actions';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'auth-challenge-dialog__button auth-challenge-dialog__button--cancel';
    cancelButton.textContent = t('auth.adminLoginCancel');
    const submitButton = document.createElement('button');
    submitButton.type = 'button';
    submitButton.className = 'auth-challenge-dialog__button auth-challenge-dialog__button--submit';
    submitButton.textContent = t('auth.adminLoginSubmit');
    actions.append(cancelButton, submitButton);

    form.append(accent, header, label, passwordInput, turnstileContainer, errorText, actions);
    dialog.appendChild(form);
    document.body.appendChild(dialog);

    const closeDialog = (): void => this.closeAdminLoginDialog();

    const showError = (message: string): void => {
      errorText.textContent = message;
      errorText.style.display = '';
    };

    let pending = false;
    const submit = async (): Promise<void> => {
      if (pending) return;
      const password = passwordInput.value;
      if (!password) {
        showError(t('auth.validationPassword'));
        passwordInput.focus();
        return;
      }
      // 密码模式下登录必验 Turnstile（与后端 handlePasswordLogin 的必验分支对齐）
      if (this.turnstileEnabled && this.turnstileSitekey && !turnstileToken) {
        showError(t('auth.turnstileRequired'));
        return;
      }
      if (!this.passwordAuthParams) return;

      pending = true;
      submitButton.disabled = true;
      errorText.style.display = 'none';
      try {
        // 浏览器本地 PBKDF2 预拉伸（server relief），原始密码不出浏览器
        const key = await stretchAdminPassword(
          password,
          this.passwordAuthParams.salt,
          this.passwordAuthParams.iterations
        );
        const response = await fetch('/api/auth/password/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, turnstileToken }),
        });

        if (response.ok) {
          // 登录成功：重载进入用户空间（init → /api/auth/me → showUserSpace）
          closeDialog();
          window.location.reload();
          return;
        }

        // 错误按状态码映射 i18n，不回显后端原文
        if (response.status === 401) {
          showError(t('auth.adminLoginFailed'));
          passwordInput.select();
        } else if (response.status === 429) {
          const data = (await response.json().catch(() => ({}))) as { retryAfterSec?: number };
          showError(t('auth.adminLoginLocked', { seconds: data.retryAfterSec ?? 60 }));
        } else if (response.status === 403) {
          showError(t('auth.adminLoginTurnstileFailed'));
          turnstileToken = '';
        } else if (response.status === 500) {
          showError(t('auth.adminHashInvalid'));
        } else if (response.status === 501) {
          showError(t('auth.adminLoginUnavailable'));
        } else {
          showError(t('auth.adminLoginNetwork'));
        }
      } catch {
        showError(t('auth.adminLoginNetwork'));
      } finally {
        pending = false;
        submitButton.disabled = false;
      }
    };

    cancelButton.addEventListener('click', closeDialog);
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeDialog();
    });
    form.addEventListener('submit', (e) => {
      // method=dialog 的原生提交会绕过清理逻辑，统一走自定义提交闭包
      e.preventDefault();
      void submit();
    });
    passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    });
    submitButton.addEventListener('click', () => void submit());

    dialog.showModal();
    passwordInput.focus();
  }

  /** 关闭并销毁管理员登录对话框（含 Turnstile 组件与密码字段残留清理） */
  private closeAdminLoginDialog(): void {
    if (this.adminDialogTurnstileId) {
      try {
        window.turnstile?.remove(this.adminDialogTurnstileId);
      } catch {
        /* 组件已随 DOM 移除时静默容忍 */
      }
      this.adminDialogTurnstileId = null;
    }
    document.getElementById('admin-login-dialog')?.remove();
  }

  private renderTurnstile(): void {
    const container = document.getElementById('turnstile-widget');
    if (!container || !window.turnstile) return;

    if (this.turnstileWidgetId) {
      window.turnstile.remove(this.turnstileWidgetId);
      this.turnstileWidgetId = null;
      container.replaceChildren();
    }

    const wrapper = document.getElementById('turnstile-container');
    if (wrapper) wrapper.style.display = 'block';

    this.turnstileTheme = getActiveColorScheme();
    this.turnstileWidgetId = window.turnstile.render(container, {
      sitekey: this.turnstileSitekey,
      theme: this.turnstileTheme,
      callback: async (token: string) => {
        // Verify with backend and get cookie
        try {
          const response = await fetch('/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
          });
          const result = (await response.json()) as { success: boolean };
          if (result.success) {
            this.turnstileVerified = true;
            // Hide Turnstile widget after successful verification
            const wrapper = document.getElementById('turnstile-container');
            if (wrapper) wrapper.style.display = 'none';
          }
        } catch {
          this.turnstileVerified = false;
        }
      },
      'expired-callback': () => {
        this.turnstileVerified = false;
      },
      'error-callback': () => {
        this.turnstileVerified = false;
      },
    });
  }

  private render(): void {
    const container = document.getElementById('connection-form-container')!;

    // pi-lens-ignore: no-inner-html
    container.innerHTML = `
      <form class="space-y-6" id="connection-form">
        <div class="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div class="sm:col-span-3">
            <label for="host" class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" data-i18n="auth.host">主机地址</label>
            <div class="flex items-center">
              <span class="text-muted mr-2">&gt;</span>
               <input id="host" class="terminal-input text-[13px]" placeholder="192.168.1.1 or 2001:db8::1" type="text" required>
            </div>
          </div>
          <div class="sm:col-span-1">
            <label for="port" class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" data-i18n="auth.port">端口</label>
            <div class="flex items-center">
              <span class="text-muted mr-2">:</span>
              <input id="port" class="terminal-input text-[13px]" placeholder="22" type="number" inputmode="numeric" min="1" max="65535" step="1" value="22" required>
            </div>
          </div>
        </div>
        <div>
          <label for="username" class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" data-i18n="auth.user">用户名</label>
          <div class="flex items-center">
            <span class="material-symbols-outlined text-muted mr-2" style="font-size: 16px;">person</span>
            <input id="username" class="terminal-input text-[13px]" placeholder="admin" type="text" required>
          </div>
        </div>
        <div>
          <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" data-i18n="auth.method">认证方式</label>
          <div class="flex gap-2 mb-3">
            <button type="button" id="auth-tab-password" class="auth-tab auth-tab-active px-3 py-1 text-[11px] font-bold tracking-[0.1em] cursor-pointer transition-all" data-i18n="common.password">密码</button>
            <button type="button" id="auth-tab-key" class="auth-tab px-3 py-1 text-[11px] font-bold tracking-[0.1em] cursor-pointer transition-all" data-i18n="common.privateKey">私钥</button>
          </div>
          <div id="auth-password-section">
            <div class="flex items-center">
              <span class="material-symbols-outlined text-muted mr-2" style="font-size: 16px;">key</span>
              <input id="password" class="terminal-input text-[13px]" placeholder="••••••••" type="password" data-i18n-aria-label="common.password" aria-label="密码">
            </div>
          </div>
          <div id="auth-key-section" style="display:none;">
            <textarea id="private-key" class="terminal-input text-[11px] w-full" rows="5" data-i18n-placeholder="auth.keyPlaceholder" data-i18n-aria-label="common.privateKey" aria-label="私钥" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...粘贴私钥内容...&#10;-----END OPENSSH PRIVATE KEY-----" style="resize:vertical;border:1px solid var(--border-strong);padding:8px;"></textarea>
            <div class="flex items-center gap-2 mt-2">
              <label for="private-key-file" class="text-[11px] text-muted hover:text-primary cursor-pointer flex items-center gap-1 border border-dim px-2 py-1 hover:border-[var(--accent)] transition-all">
                <span class="material-symbols-outlined" style="font-size: 14px;">upload_file</span>
                <span data-i18n="auth.chooseKeyFile">选择密钥文件</span>
              </label>
              <input type="file" id="private-key-file" accept=".pem,.key,.txt,.pub" class="hidden">
              <span id="file-name" class="text-[10px] text-muted truncate"></span>
            </div>
          </div>
        </div>
        <div id="turnstile-container" style="display:none;">
          <div id="turnstile-widget" class="flex justify-center"></div>
        </div>
        <div>
          <label for="anon-region" class="block text-xs font-bold tracking-[0.1em] text-muted mb-2"><span data-i18n="auth.regionHint">连接区域</span> <span class="text-[9px] opacity-60" data-i18n="auth.regionOptional">可选；自动模式由 Cloudflare 调度</span></label>
          <select id="anon-region" class="terminal-input text-[13px] cursor-pointer" style="border:1px solid var(--border-strong);border-bottom:1px solid var(--border-strong);padding:6px 8px;">
            <option value="">自动</option>
          </select>
        </div>
        <div class="flex items-center gap-2 mt-2">
          <input type="checkbox" id="remember-me" class="accent-[var(--accent)] w-4 h-4 cursor-pointer">
          <label for="remember-me" class="text-xs text-muted cursor-pointer select-none" data-i18n="auth.remember">记住连接信息</label>
        </div>
        <div class="pt-4">
          <button id="connect-btn" class="connect-btn w-full py-3 px-4 text-xs font-bold tracking-[0.1em] uppercase flex items-center justify-center gap-2" type="submit">
            <span class="material-symbols-outlined" style="font-size: 18px;">power_settings_new</span>
            <span data-i18n="auth.execute">建立连接</span>
          </button>
        </div>
        <div class="flex flex-wrap justify-between items-center gap-x-2 gap-y-1 mt-4">
          <span id="status-text" class="text-[13px] text-muted flex items-center gap-1">
            <span class="w-2 h-2 bg-surface-dot inline-block"></span> <span data-i18n="auth.statusOffline">状态：离线</span>
          </span>
          <span id="github-login-placeholder"></span>
        </div>
        <!-- Recent Connections Section -->
        <div id="recent-connections-section" class="mt-6 pt-4 border-t border-dim hidden">
          <label class="block text-xs font-bold tracking-[0.1em] text-[var(--accent-secondary)] mb-3" data-i18n="auth.recent">最近连接</label>
          <div id="recent-connections-list" class="space-y-2 max-h-[160px] overflow-y-auto custom-scrollbar pr-1"></div>
        </div>
      </form>
    `;
    translateDocument(container);

    document.getElementById('connection-form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.handleConnect();
    });

    // 填充区域下拉选项（自动选项已存在于 HTML，populateRegionSelect 会完整替换）
    const anonRegionSelect = document.getElementById('anon-region') as HTMLSelectElement | null;
    if (anonRegionSelect) {
      populateRegionSelect(anonRegionSelect, '');
    }

    // Auth method tab switching
    document.getElementById('auth-tab-password')!.addEventListener('click', () => {
      this.setAuthMode('password');
    });
    document.getElementById('auth-tab-key')!.addEventListener('click', () => {
      this.setAuthMode('key');
    });

    // File upload for private key
    const fileInput = document.getElementById('private-key-file') as HTMLInputElement;
    const fileNameSpan = document.getElementById('file-name');

    fileInput.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const content = await file.text();
        const privateKeyTextarea = document.getElementById('private-key') as HTMLTextAreaElement;
        privateKeyTextarea.value = content;
        if (fileNameSpan) {
          fileNameSpan.textContent = file.name;
        }
      } catch (error) {
        notify(t('auth.readKeyFailed') + ' ' + (error instanceof Error ? error.message : ''), {
          title: t('auth.readKeyTitle'),
          variant: 'danger',
        });
      }

      // Reset file input
      fileInput.value = '';
    });
  }

  private authMode: 'password' | 'key' = 'password';

  private setAuthMode(mode: 'password' | 'key'): void {
    this.authMode = mode;
    const pwTab = document.getElementById('auth-tab-password')!;
    const keyTab = document.getElementById('auth-tab-key')!;
    const pwSection = document.getElementById('auth-password-section')!;
    const keySection = document.getElementById('auth-key-section')!;

    pwTab.classList.toggle('auth-tab-active', mode === 'password');
    keyTab.classList.toggle('auth-tab-active', mode === 'key');
    pwSection.style.display = mode === 'password' ? '' : 'none';
    keySection.style.display = mode === 'key' ? '' : 'none';
  }

  private renderRecentConnections(): void {
    const section = document.getElementById('recent-connections-section');
    const list = document.getElementById('recent-connections-list');
    if (!section || !list) return;

    const raw = localStorage.getItem('cloudssh_recent_connections');
    let recent: any[] = [];
    try {
      recent = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(recent)) recent = [];
    } catch {
      recent = [];
    }

    if (recent.length === 0) {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');
    list.innerHTML = '';

    recent.forEach((item, index) => {
      const itemEl = document.createElement('div');
      itemEl.className =
        'flex justify-between items-center text-xs p-2 border border-dim bg-surface/50 hover:bg-surface hover:border-[var(--accent)] transition-all cursor-pointer group relative';

      const authLabel = item.authMethod === 'publickey' ? 'KEY' : 'PWD';
      const labelText = `${item.username}@${item.host}:${item.port}`;

      // pi-lens-ignore: no-inner-html
      itemEl.innerHTML = `
        <div class="flex items-center gap-2 overflow-hidden mr-2 select-none flex-1">
          <span class="material-symbols-outlined text-muted" style="font-size: 14px;">history</span>
          <span class="text-on-surface truncate" title="${labelText}">${labelText}</span>
          <span class="text-[9px] font-bold tracking-[0.05em] text-muted border border-dim px-1.5 py-0.2 shrink-0">${authLabel}</span>
        </div>
        <button type="button" class="delete-history-btn text-muted hover:text-error flex items-center justify-center p-0.5" title="${t('auth.removeHistory')}">
          <span class="material-symbols-outlined" style="font-size: 14px;">close</span>
        </button>
      `;

      // 点击填入
      itemEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.delete-history-btn')) return;
        this.fillConnection(item);
      });

      // 删除单条
      itemEl.querySelector('.delete-history-btn')!.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteConnection(index);
      });

      list.appendChild(itemEl);
    });
  }

  private async fillConnection(item: {
    host: string;
    port: number;
    username: string;
    authMethod: 'password' | 'publickey';
    encryptedCred?: string;
    region?: string;
  }): Promise<void> {
    (document.getElementById('host') as HTMLInputElement).value = item.host || '';
    (document.getElementById('port') as HTMLInputElement).value = (item.port || 22).toString();
    (document.getElementById('username') as HTMLInputElement).value = item.username || '';

    // 还原区域下拉（从 recent connection 的 region 字段；老条目无此字段则默认 Auto）
    const anonRegionSelect = document.getElementById('anon-region') as HTMLSelectElement | null;
    if (anonRegionSelect) {
      anonRegionSelect.value = item.region || '';
    }

    if (item.authMethod === 'publickey') {
      this.setAuthMode('key');
    } else {
      this.setAuthMode('password');
    }

    if (item.encryptedCred) {
      const cred = await decryptCredentials(item.encryptedCred);
      if (cred) {
        (document.getElementById('password') as HTMLInputElement).value = cred.password || '';
        (document.getElementById('private-key') as HTMLTextAreaElement).value =
          cred.privateKey || '';
        (document.getElementById('remember-me') as HTMLInputElement).checked = true;
      } else {
        (document.getElementById('password') as HTMLInputElement).value = '';
        (document.getElementById('private-key') as HTMLTextAreaElement).value = '';
        (document.getElementById('remember-me') as HTMLInputElement).checked = false;
      }
    } else {
      (document.getElementById('password') as HTMLInputElement).value = '';
      (document.getElementById('private-key') as HTMLTextAreaElement).value = '';
      (document.getElementById('remember-me') as HTMLInputElement).checked = false;
    }
  }

  private deleteConnection(index: number): void {
    const raw = localStorage.getItem('cloudssh_recent_connections');
    let recent: any[] = [];
    try {
      recent = raw ? JSON.parse(raw) : [];
    } catch {
      /* 本地存储损坏时回退为空列表，无需上报 */
    }

    if (index >= 0 && index < recent.length) {
      recent.splice(index, 1);
      localStorage.setItem('cloudssh_recent_connections', JSON.stringify(recent));
      this.renderRecentConnections();
    }
  }

  private async loadSavedCredentials(): Promise<void> {
    const recentRaw = localStorage.getItem('cloudssh_recent_connections');
    let recent: any[] = [];
    try {
      recent = recentRaw ? JSON.parse(recentRaw) : [];
      if (!Array.isArray(recent)) recent = [];
    } catch {
      recent = [];
    }

    // 兼容性迁移：如果无 recent_connections 但存在老版单条 cloudssh_cred，则自动将其迁移并存入历史记录
    const oldCred = localStorage.getItem('cloudssh_cred');
    if (recent.length === 0 && oldCred) {
      const cred = await decryptCredentials(oldCred);
      if (cred) {
        const item = {
          id: `${cred.username}@${cred.host}:${cred.port}`,
          host: cred.host,
          port: parseInt(cred.port, 10) || 22,
          username: cred.username,
          authMethod: cred.authMethod === 'publickey' ? 'publickey' : 'password',
          timestamp: Date.now(),
          encryptedCred: oldCred,
        };
        recent.push(item);
        localStorage.setItem('cloudssh_recent_connections', JSON.stringify(recent));
        // 清理老旧单项
        localStorage.removeItem('cloudssh_cred');
      }
    }

    // 渲染历史列表
    this.renderRecentConnections();

    // 默认自动填入最近使用的一条（即第一条）
    if (recent.length > 0) {
      this.fillConnection(recent[0]);
    }
  }

  private async handleConnect(): Promise<void> {
    const hostInput = (document.getElementById('host') as HTMLInputElement).value;
    const host = hostInput.replace(/^\[|\]$/g, '').trim();
    const portInput = document.getElementById('port') as HTMLInputElement;
    const port = parsePort(portInput.value);
    const username = (document.getElementById('username') as HTMLInputElement).value;
    const password = (document.getElementById('password') as HTMLInputElement).value;
    const privateKey = (document.getElementById('private-key') as HTMLTextAreaElement).value;
    const selectedPassword = this.authMode === 'password' ? password : undefined;
    const selectedPrivateKey = this.authMode === 'key' ? privateKey : undefined;
    const remember = (document.getElementById('remember-me') as HTMLInputElement).checked;
    // 匿名路径区域选择（仅作为 manual override；系统不会对此路径自动推断）
    const anonRegionSelect = document.getElementById('anon-region') as HTMLSelectElement | null;
    const regionValue = anonRegionSelect ? anonRegionSelect.value : '';

    if (!host || !username) {
      notify(t('auth.validationHostUser'), {
        title: t('auth.incompleteConnection'),
        variant: 'warning',
      });
      (document.getElementById(host ? 'username' : 'host') as HTMLInputElement)?.focus();
      return;
    }

    if (port === null) {
      notify(t('auth.validationPort'), {
        title: t('auth.incompleteConnection'),
        variant: 'warning',
      });
      portInput.focus();
      return;
    }

    if (this.authMode === 'password' && !password) {
      notify(t('auth.validationPassword'), {
        title: t('auth.incompleteCredentials'),
        variant: 'warning',
      });
      (document.getElementById('password') as HTMLInputElement)?.focus();
      return;
    }

    if (this.authMode === 'key' && !privateKey) {
      notify(t('auth.validationPrivateKey'), {
        title: t('auth.incompleteCredentials'),
        variant: 'warning',
      });
      (document.getElementById('private-key') as HTMLTextAreaElement)?.focus();
      return;
    }

    // Check Turnstile if enabled
    if (this.turnstileEnabled && !this.turnstileVerified) {
      notify(t('auth.turnstileRequired'), {
        title: t('auth.verificationRequired'),
        variant: 'warning',
      });
      document
        .getElementById('turnstile-container')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // 保存连接历史与凭据
    let encryptedCred: string | undefined;
    if (remember) {
      encryptedCred = await encryptCredentials({
        host,
        port: port.toString(),
        username,
        password: selectedPassword ?? '',
        privateKey: selectedPrivateKey,
        authMethod: this.authMode === 'key' ? 'publickey' : 'password',
      });
    }

    // 更新最近连接列表
    const recentRaw = localStorage.getItem('cloudssh_recent_connections');
    let recent: any[] = [];
    try {
      recent = recentRaw ? JSON.parse(recentRaw) : [];
      if (!Array.isArray(recent)) recent = [];
    } catch {
      /* 本地存储损坏时回退为空列表，无需上报 */
    }

    const id = `${username}@${host}:${port}`;
    const newRecord = {
      id,
      host,
      port,
      username,
      authMethod: this.authMode === 'key' ? 'publickey' : 'password',
      timestamp: Date.now(),
      ...(regionValue ? { region: regionValue } : {}), // 区域偏好持久化到 recent
      ...(encryptedCred ? { encryptedCred } : {}),
    };

    // 去重：如果已有相同 id 记录，先删除
    recent = recent.filter((r) => r.id !== id);
    // 插入头部
    recent.unshift(newRecord);
    // 限制最近 5 条
    if (recent.length > 5) {
      recent = recent.slice(0, 5);
    }
    localStorage.setItem('cloudssh_recent_connections', JSON.stringify(recent));

    // 重新渲染历史列表
    this.renderRecentConnections();

    // 通过 TabManager 创建新标签并切换到终端视图
    const tm = this.options.getTabManager();
    const displayLabel = `${username}@${host}`;

    // 切换到终端视图
    document.getElementById('auth-section')!.classList.add('hidden');
    document.getElementById('terminal-section')!.classList.remove('hidden');
    document.getElementById('terminal-section')!.classList.add('flex');

    const tab = tm.createTab(displayLabel, { host, port, username });
    const terminal = tab.terminal;

    terminal.mount();

    try {
      // 加载已知主机指纹（TOFU 验证）
      const expectedFingerprint = await loadKnownFingerprint(host, port);

      await terminal.connect({
        host,
        port,
        username,
        password: selectedPassword,
        authMethod: this.authMode === 'key' ? 'publickey' : 'password',
        privateKey: selectedPrivateKey,
        expectedFingerprint: expectedFingerprint || undefined,
        locationHint: regionValue || undefined,
      });

      // 连接成功后清空敏感凭据字段，避免返回匿名连接页时密码/私钥残留（安全）
      (document.getElementById('password') as HTMLInputElement).value = '';
      (document.getElementById('private-key') as HTMLTextAreaElement).value = '';
    } catch {
      // 连接失败时关闭该标签
      tm.closeTab(tab.id);
      // pi-lens-ignore: no-inner-html
      document.getElementById('status-text')!.innerHTML =
        `<span class="w-2 h-2 bg-surface-dot inline-block"></span> ${t('auth.statusOffline')}`;
    }
  }
}
