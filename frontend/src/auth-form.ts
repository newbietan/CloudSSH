import { loadKnownFingerprint } from './terminal';
import type { TabManager } from './tab-manager';

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

async function encryptCredentials(data: object): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(salt);
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded));
  const combined = new Uint8Array(salt.length + iv.length + encrypted.length);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(encrypted, salt.length + iv.length);
  let binary = '';
  for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary);
}

async function decryptCredentials(stored: string): Promise<{ host: string; port: string; username: string; password: string; privateKey?: string; authMethod?: string } | null> {
  try {
    const raw = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
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

  constructor(options: ConnectionFormOptions) {
    this.options = options;
    this.render();
    this.loadSavedCredentials();
    this.checkTurnstileConfig();
  }

  private async checkTurnstileConfig(): Promise<void> {
    try {
      const response = await fetch('/api/config');
      const config = (await response.json()) as {
        turnstileEnabled: boolean;
        sitekey: string;
        githubAuthEnabled: boolean;
      };
      this.turnstileEnabled = config.turnstileEnabled;
      this.turnstileSitekey = config.sitekey;
      if (this.turnstileEnabled && this.turnstileSitekey) {
        this.renderTurnstile();
      }
      // 渲染 GitHub 登录按钮（仅当 OAuth 已配置时）
      if (config.githubAuthEnabled) {
        this.renderGitHubLoginButton();
      }
    } catch {
      // Config endpoint not available, skip Turnstile
    }
  }

  private renderGitHubLoginButton(): void {
    const placeholder = document.getElementById('github-login-placeholder');
    if (!placeholder) return;

    placeholder.innerHTML = `
      <button type="button" id="github-login-btn" class="github-login-btn text-[11px] font-bold tracking-[0.1em] text-muted hover:text-primary transition-all cursor-pointer flex items-center gap-1.5 bg-transparent border border-dim px-3 py-1 hover:border-[var(--accent)]">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        LOGIN
      </button>
    `;

    document.getElementById('github-login-btn')?.addEventListener('click', () => {
      window.location.href = '/api/auth/github';
    });
  }

  private renderTurnstile(): void {
    const container = document.getElementById('turnstile-widget');
    if (!container || !window.turnstile) return;

    const wrapper = document.getElementById('turnstile-container');
    if (wrapper) wrapper.style.display = 'block';

    this.turnstileWidgetId = window.turnstile.render(container, {
      sitekey: this.turnstileSitekey,
      theme: 'dark',
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

    container.innerHTML = `
      <form class="space-y-6" id="connection-form">
        <div class="grid grid-cols-4 gap-4">
          <div class="col-span-3">
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2">HOST_ADDRESS</label>
            <div class="flex items-center">
              <span class="text-muted mr-2">&gt;</span>
               <input id="host" class="terminal-input text-[13px]" placeholder="192.168.1.1 or 2001:db8::1" type="text" required>
            </div>
          </div>
          <div class="col-span-1">
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2">PORT</label>
            <div class="flex items-center">
              <span class="text-muted mr-2">:</span>
              <input id="port" class="terminal-input text-[13px]" placeholder="22" type="text" value="22">
            </div>
          </div>
        </div>
        <div>
          <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2">AUTH_USER</label>
          <div class="flex items-center">
            <span class="material-symbols-outlined text-muted mr-2" style="font-size: 16px;">person</span>
            <input id="username" class="terminal-input text-[13px]" placeholder="admin" type="text" required>
          </div>
        </div>
        <div>
          <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2">AUTH_METHOD</label>
          <div class="flex gap-2 mb-3">
            <button type="button" id="auth-tab-password" class="auth-tab auth-tab-active px-3 py-1 text-[11px] font-bold tracking-[0.1em] cursor-pointer transition-all">PASSWORD</button>
            <button type="button" id="auth-tab-key" class="auth-tab px-3 py-1 text-[11px] font-bold tracking-[0.1em] cursor-pointer transition-all">PRIVATE_KEY</button>
          </div>
          <div id="auth-password-section">
            <div class="flex items-center">
              <span class="material-symbols-outlined text-muted mr-2" style="font-size: 16px;">key</span>
              <input id="password" class="terminal-input text-[13px]" placeholder="••••••••" type="password">
            </div>
          </div>
          <div id="auth-key-section" style="display:none;">
            <textarea id="private-key" class="terminal-input text-[11px] w-full" rows="5" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...粘贴 Ed25519 私钥内容...&#10;-----END OPENSSH PRIVATE KEY-----" style="resize:vertical;border:1px solid var(--border-strong);padding:8px;"></textarea>
          </div>
        </div>
        <div id="turnstile-container" style="display:none;">
          <div id="turnstile-widget" class="flex justify-center"></div>
        </div>
        <div class="flex items-center gap-2 mt-2">
          <input type="checkbox" id="remember-me" class="accent-[var(--accent)] w-4 h-4 cursor-pointer">
          <label for="remember-me" class="text-xs text-muted cursor-pointer select-none">REMEMBER_CONNECTION</label>
        </div>
        <div class="pt-4">
          <button id="connect-btn" class="connect-btn w-full py-3 px-4 text-xs font-bold tracking-[0.1em] uppercase flex items-center justify-center gap-2" type="button">
            <span class="material-symbols-outlined" style="font-size: 18px;">power_settings_new</span>
            Execute_Connection
          </button>
        </div>
        <div class="flex justify-between items-center mt-4">
          <span id="status-text" class="text-[13px] text-muted flex items-center gap-1">
            <span class="w-2 h-2 bg-surface-dot inline-block"></span> STATUS: OFFLINE
          </span>
          <span id="github-login-placeholder"></span>
        </div>
        <!-- Recent Connections Section -->
        <div id="recent-connections-section" class="mt-6 pt-4 border-t border-dim hidden">
          <label class="block text-xs font-bold tracking-[0.1em] text-[var(--accent-secondary)] mb-3">RECENT_CONNECTIONS</label>
          <div id="recent-connections-list" class="space-y-2 max-h-[160px] overflow-y-auto custom-scrollbar pr-1"></div>
        </div>
      </form>
    `;

    document.getElementById('connect-btn')!.addEventListener('click', () => {
      this.handleConnect();
    });

    document.getElementById('connection-form')!.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.handleConnect();
    });

    // Auth method tab switching
    document.getElementById('auth-tab-password')!.addEventListener('click', () => {
      this.setAuthMode('password');
    });
    document.getElementById('auth-tab-key')!.addEventListener('click', () => {
      this.setAuthMode('key');
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
      itemEl.className = 'flex justify-between items-center text-xs p-2 border border-dim bg-surface/50 hover:bg-surface hover:border-[var(--accent)] transition-all cursor-pointer group relative';
      
      const authLabel = item.authMethod === 'publickey' ? 'KEY' : 'PWD';
      const labelText = `${item.username}@${item.host}:${item.port}`;

      itemEl.innerHTML = `
        <div class="flex items-center gap-2 overflow-hidden mr-2 select-none flex-1">
          <span class="material-symbols-outlined text-muted" style="font-size: 14px;">history</span>
          <span class="text-on-surface truncate" title="${labelText}">${labelText}</span>
          <span class="text-[9px] font-bold tracking-[0.05em] text-muted border border-dim px-1.5 py-0.2 shrink-0">${authLabel}</span>
        </div>
        <button class="delete-history-btn text-muted hover:text-error flex items-center justify-center p-0.5" title="Remove from history">
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

  private async fillConnection(item: { host: string; port: number; username: string; authMethod: 'password' | 'publickey'; encryptedCred?: string }): Promise<void> {
    (document.getElementById('host') as HTMLInputElement).value = item.host || '';
    (document.getElementById('port') as HTMLInputElement).value = (item.port || 22).toString();
    (document.getElementById('username') as HTMLInputElement).value = item.username || '';

    if (item.authMethod === 'publickey') {
      this.setAuthMode('key');
    } else {
      this.setAuthMode('password');
    }

    if (item.encryptedCred) {
      const cred = await decryptCredentials(item.encryptedCred);
      if (cred) {
        (document.getElementById('password') as HTMLInputElement).value = cred.password || '';
        (document.getElementById('private-key') as HTMLTextAreaElement).value = cred.privateKey || '';
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
    } catch {}
    
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
          port: parseInt(cred.port) || 22,
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
    const port = parseInt(
      (document.getElementById('port') as HTMLInputElement).value || '22'
    );
    const username = (document.getElementById('username') as HTMLInputElement).value;
    const password = (document.getElementById('password') as HTMLInputElement).value;
    const privateKey = (document.getElementById('private-key') as HTMLTextAreaElement).value;
    const remember = (document.getElementById('remember-me') as HTMLInputElement).checked;

    if (!host || !username) {
      alert('请填写主机名和用户名');
      return;
    }

    if (this.authMode === 'password' && !password) {
      alert('请输入密码');
      return;
    }

    if (this.authMode === 'key' && !privateKey) {
      alert('请粘贴私钥内容');
      return;
    }

    // Check Turnstile if enabled
    if (this.turnstileEnabled && !this.turnstileVerified) {
      alert('请完成人机验证');
      return;
    }

    // 保存连接历史与凭据
    let encryptedCred: string | undefined = undefined;
    if (remember) {
      encryptedCred = await encryptCredentials({
        host,
        port: port.toString(),
        username,
        password,
        privateKey: this.authMode === 'key' ? privateKey : undefined,
        authMethod: this.authMode === 'key' ? 'publickey' : 'password',
      });
    }

    // 更新最近连接列表
    const recentRaw = localStorage.getItem('cloudssh_recent_connections');
    let recent: any[] = [];
    try {
      recent = recentRaw ? JSON.parse(recentRaw) : [];
      if (!Array.isArray(recent)) recent = [];
    } catch {}

    const id = `${username}@${host}:${port}`;
    const newRecord = {
      id,
      host,
      port,
      username,
      authMethod: this.authMode === 'key' ? 'publickey' : 'password',
      timestamp: Date.now(),
      ...(encryptedCred ? { encryptedCred } : {}),
    };

    // 去重：如果已有相同 id 记录，先删除
    recent = recent.filter(r => r.id !== id);
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
        password,
        authMethod: this.authMode === 'key' ? 'publickey' : 'password',
        privateKey,
        expectedFingerprint: expectedFingerprint || undefined,
      });
    } catch (error) {
      // 连接失败时关闭该标签
      tm.closeTab(tab.id);
      document.getElementById('status-text')!.innerHTML = '<span class="w-2 h-2 bg-surface-dot inline-block"></span> STATUS: OFFLINE';
    }
  }
}

