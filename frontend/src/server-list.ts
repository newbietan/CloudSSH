import { populateRegionSelect, regionLabel } from './regions';
import { confirmAction, notify } from './ui-feedback';

interface UserInfo {
  id: number;
  github_id: number;
  username: string;
  avatar_url: string;
}

interface ServerConfig {
  id: number;
  user_id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'publickey';
  region?: string | null;
  inferred_hint?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 用户空间 — 服务器列表管理组件
 */
export class ServerList {
  private user: UserInfo;
  private servers: ServerConfig[] = [];
  private onLogout: () => void;
  private onConnect: (wsUrl: string, serverName: string, hostInfo?: { host: string; port: number }) => void;
  private editingServerId: number | null = null;
  private modalAuthMode: 'password' | 'key' = 'password';

  constructor(
    user: UserInfo,
    onLogout: () => void,
    onConnect: (wsUrl: string, serverName: string, hostInfo?: { host: string; port: number }) => void
  ) {
    this.user = user;
    this.onLogout = onLogout;
    this.onConnect = onConnect;
    this.init();
  }

  private async init(): Promise<void> {
    this.renderUserInfo();
    this.bindEvents();
    await this.fetchServers();

    // 设置用户空间的版权年份
    const yearSpan = document.getElementById('user-copyright-year');
    if (yearSpan) yearSpan.textContent = new Date().getFullYear().toString();
  }

  // ==================== 渲染用户信息 ====================

  private renderUserInfo(): void {
    const container = document.getElementById('user-info');
    if (!container) return;

    container.innerHTML = '';
    const img = document.createElement('img');
    img.src = this.user.avatar_url;
    img.alt = this.user.username;
    img.className = 'user-avatar w-8 h-8';
    container.appendChild(img);
    const span = document.createElement('span');
    span.className = 'text-xs font-bold tracking-[0.1em] text-muted';
    span.textContent = this.user.username;
    container.appendChild(span);
  }

  // ==================== 事件绑定 ====================

  private bindEvents(): void {
    // 退出登录
    document.getElementById('logout-btn')?.addEventListener('click', () => this.logout());

    // AI 配置
    document.getElementById('ai-config-btn')?.addEventListener('click', () => {
      import('./main').then(m => m.showAIConfig());
    });

    // 添加服务器按钮
    document.getElementById('add-server-btn')?.addEventListener('click', () => this.showModal('add'));
    document.getElementById('empty-add-btn')?.addEventListener('click', () => this.showModal('add'));

    // Modal 关闭
    document.getElementById('modal-close-btn')?.addEventListener('click', () => this.hideModal());
    document.getElementById('modal-backdrop')?.addEventListener('click', () => this.hideModal());

    // Modal 提交
    document.getElementById('server-submit-btn')?.addEventListener('click', () => this.handleSubmit());

    // Modal 认证方式切换
    document.getElementById('modal-auth-tab-password')?.addEventListener('click', () => this.setModalAuthMode('password'));
    document.getElementById('modal-auth-tab-key')?.addEventListener('click', () => this.setModalAuthMode('key'));

    // 回车提交
    document.getElementById('server-form')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleSubmit();
      }
    });
  }

  // ==================== 数据获取 ====================

  private async fetchServers(): Promise<void> {
    try {
      const res = await fetch('/api/servers');
      if (!res.ok) throw new Error('Failed to fetch servers');
      this.servers = await res.json();
      this.renderServerGrid();
    } catch (e) {
      console.error('Failed to fetch servers:', e);
      this.servers = [];
      this.renderServerGrid();
    }
  }

  // ==================== 渲染服务器卡片 ====================

  private renderServerGrid(): void {
    const grid = document.getElementById('server-grid');
    const emptyState = document.getElementById('empty-state');
    if (!grid || !emptyState) return;

    if (this.servers.length === 0) {
      grid.innerHTML = '';
      emptyState.classList.remove('hidden');
      emptyState.classList.add('flex');
      return;
    }

    emptyState.classList.add('hidden');
    emptyState.classList.remove('flex');

    grid.innerHTML = this.servers
      .map((server) => this.renderServerCard(server))
      .join('');

    // 绑定卡片事件
    this.servers.forEach((server) => {
      document.getElementById(`connect-${server.id}`)?.addEventListener('click', () => this.connectServer(server.id));
      document.getElementById(`edit-${server.id}`)?.addEventListener('click', () => this.showModal('edit', server));
      document.getElementById(`delete-${server.id}`)?.addEventListener('click', () => this.deleteServer(server.id));
    });
  }

  private renderServerCard(server: ServerConfig): string {
    const authIcon = server.auth_method === 'publickey' ? 'vpn_key' : 'password';
    const authLabel = server.auth_method === 'publickey' ? 'KEY' : 'PWD';

    // 区域信息：用户手动覆盖优先，其次系统推断，都没有则显示 Auto
    const effectiveHint = server.region || server.inferred_hint || '';
    const isManual = !!server.region;
    const regionLabelText = regionLabel(effectiveHint);
    const regionTag = effectiveHint
      ? (isManual ? '手动' : '自动')
      : '自动';

    return `
      <div class="server-card p-5 relative group" id="card-${server.id}">
        <div class="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[var(--border-strong)] to-transparent group-hover:via-[var(--accent)] transition-all duration-300"></div>
        
        <div class="flex items-start justify-between mb-3">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-primary" style="font-size: 20px; font-variation-settings: 'FILL' 0;">dns</span>
            <h3 class="text-sm font-bold text-primary tracking-[0.05em]">${this.escapeHtml(server.name)}</h3>
          </div>
          <span class="text-[10px] font-bold tracking-[0.1em] text-muted border border-dim px-2 py-0.5 flex items-center gap-1">
            <span class="material-symbols-outlined" style="font-size: 12px;">${authIcon}</span>
            ${authLabel}
          </span>
        </div>

        <div class="space-y-1.5 text-xs text-muted mb-4">
          <div class="flex items-center gap-2">
            <span class="text-dim">HOST</span>
            <span class="text-on-surface">${this.escapeHtml(server.host)}:${server.port}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-dim">USER</span>
            <span class="text-on-surface">${this.escapeHtml(server.username)}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-dim">REGION</span>
            <span class="text-on-surface flex items-center gap-1">
              <span class="material-symbols-outlined" style="font-size: 11px; color: var(--accent-secondary);">${effectiveHint ? 'my_location' : 'explore'}</span>
              ${this.escapeHtml(regionLabelText)}
            </span>
            <span class="text-[9px] text-dim border border-dim px-1 py-0.5 ml-0.5">${regionTag}</span>
          </div>
        </div>

        <div class="flex gap-2 pt-3 border-t border-[var(--border)]">
          <button id="connect-${server.id}" class="cyber-button text-primary flex-1 py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] uppercase flex items-center justify-center gap-1" title="Connect">
            <span class="material-symbols-outlined" style="font-size: 14px;">power_settings_new</span>
            CONNECT
          </button>
          <button id="edit-${server.id}" class="cyber-button text-primary py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] flex items-center justify-center" title="Edit">
            <span class="material-symbols-outlined" style="font-size: 14px;">edit</span>
          </button>
          <button id="delete-${server.id}" class="cyber-button py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] flex items-center justify-center text-error border-[var(--error)] hover:bg-[var(--error)] hover:text-[var(--bg)]" title="Delete">
            <span class="material-symbols-outlined" style="font-size: 14px;">delete</span>
          </button>
        </div>
      </div>
    `;
  }

  // ==================== 服务器操作 ====================

  private async connectServer(serverId: number): Promise<void> {
    const server = this.servers.find((s) => s.id === serverId);
    if (!server) return;

    const connectBtn = document.getElementById(`connect-${serverId}`);
    if (connectBtn) {
      connectBtn.innerHTML = `
        <span class="material-symbols-outlined animate-spin" style="font-size: 14px;">progress_activity</span>
        CONNECTING...
      `;
      (connectBtn as HTMLButtonElement).disabled = true;
    }

    try {
      const res = await fetch(`/api/servers/${serverId}/connect`, {
        method: 'POST',
      });

      if (!res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const err = await res.json() as { error?: string };
          throw new Error(err.error || 'Connection failed');
        }
        throw new Error(`服务器错误 (${res.status})`);
      }

      const { wsUrl } = await res.json() as { wsUrl: string };

      // 在当前页面内创建新标签并连接
      this.onConnect(wsUrl, server.name, { host: server.host, port: server.port });
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), {
        title: '连接失败',
        variant: 'danger',
      });
    } finally {
      if (connectBtn) {
        connectBtn.innerHTML = `
          <span class="material-symbols-outlined" style="font-size: 14px;">power_settings_new</span>
          CONNECT
        `;
        (connectBtn as HTMLButtonElement).disabled = false;
      }
    }
  }

  private async deleteServer(serverId: number): Promise<void> {
    const server = this.servers.find((s) => s.id === serverId);
    if (!server) return;

    const confirmed = await confirmAction({
      title: '删除服务器',
      message: `确定要删除服务器“${server.name}”吗？保存的连接信息和凭据也会一并删除。`,
      confirmText: '删除',
      cancelText: '保留',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      const card = document.getElementById(`card-${serverId}`);
      if (card) card.classList.add('removing');

      const res = await fetch(`/api/servers/${serverId}`, {
        method: 'DELETE',
      });

      if (!res.ok) throw new Error('Delete failed');

      // 等待动画完成后移除
      await new Promise((r) => setTimeout(r, 300));
      this.servers = this.servers.filter((s) => s.id !== serverId);
      this.renderServerGrid();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), {
        title: '删除失败',
        variant: 'danger',
      });
      await this.fetchServers();
    }
  }

  // ==================== Modal 操作 ====================

  showModal(mode: 'add' | 'edit', server?: ServerConfig): void {
    this.editingServerId = mode === 'edit' && server ? server.id : null;

    const modal = document.getElementById('server-modal');
    const title = document.getElementById('modal-title');
    const submitBtn = document.getElementById('server-submit-btn');
    if (!modal || !title || !submitBtn) return;

    title.textContent = mode === 'add' ? 'ADD_SERVER' : 'EDIT_SERVER';
    submitBtn.innerHTML = `
      <span class="material-symbols-outlined" style="font-size: 18px;">save</span>
      ${mode === 'add' ? 'SAVE_SERVER' : 'UPDATE_SERVER'}
    `;

    // 填充表单
    if (mode === 'edit' && server) {
      (document.getElementById('server-name') as HTMLInputElement).value = server.name;
      (document.getElementById('server-host') as HTMLInputElement).value = server.host;
      (document.getElementById('server-port') as HTMLInputElement).value = server.port.toString();
      (document.getElementById('server-username') as HTMLInputElement).value = server.username;
      (document.getElementById('server-password') as HTMLInputElement).value = '';
      (document.getElementById('server-private-key') as HTMLTextAreaElement).value = '';

      if (server.auth_method === 'publickey') {
        this.setModalAuthMode('key');
      } else {
        this.setModalAuthMode('password');
      }

      // 区域下拉：回显用户保存的 region（"" = Auto）
      const regionSelect = document.getElementById('server-region') as HTMLSelectElement | null;
      const inferredInfo = document.getElementById('server-region-inferred');
      if (regionSelect) {
        populateRegionSelect(regionSelect, server.region || '');
      }
      // 显示系统推断值（仅编辑时，让用户了解 DB 持久化的 hint）
      if (inferredInfo) {
        if (server.inferred_hint) {
          inferredInfo.textContent = `系统推断：${regionLabel(server.inferred_hint)}`;
        } else {
          inferredInfo.textContent = '';
        }
      }
    } else {
      // 清空表单
      (document.getElementById('server-name') as HTMLInputElement).value = '';
      (document.getElementById('server-host') as HTMLInputElement).value = '';
      (document.getElementById('server-port') as HTMLInputElement).value = '22';
      (document.getElementById('server-username') as HTMLInputElement).value = '';
      (document.getElementById('server-password') as HTMLInputElement).value = '';
      (document.getElementById('server-private-key') as HTMLTextAreaElement).value = '';
      this.setModalAuthMode('password');

      // 新增时：region 默认 Auto，无系统推断可显示
      const regionSelect = document.getElementById('server-region') as HTMLSelectElement | null;
      const inferredInfo = document.getElementById('server-region-inferred');
      if (regionSelect) populateRegionSelect(regionSelect, '');
      if (inferredInfo) inferredInfo.textContent = '';
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');

    // 聚焦第一个输入框
    setTimeout(() => {
      (document.getElementById('server-name') as HTMLInputElement)?.focus();
    }, 100);
  }

  hideModal(): void {
    const modal = document.getElementById('server-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
    this.editingServerId = null;
  }

  private setModalAuthMode(mode: 'password' | 'key'): void {
    this.modalAuthMode = mode;
    const pwTab = document.getElementById('modal-auth-tab-password')!;
    const keyTab = document.getElementById('modal-auth-tab-key')!;
    const pwSection = document.getElementById('modal-password-section')!;
    const keySection = document.getElementById('modal-key-section')!;

    pwTab.classList.toggle('auth-tab-active', mode === 'password');
    keyTab.classList.toggle('auth-tab-active', mode === 'key');
    pwSection.style.display = mode === 'password' ? '' : 'none';
    keySection.style.display = mode === 'key' ? '' : 'none';
  }

  private async handleSubmit(): Promise<void> {
    const name = (document.getElementById('server-name') as HTMLInputElement).value.trim();
    const host = (document.getElementById('server-host') as HTMLInputElement).value.trim();
    const port = parseInt((document.getElementById('server-port') as HTMLInputElement).value || '22');
    const username = (document.getElementById('server-username') as HTMLInputElement).value.trim();
    const password = (document.getElementById('server-password') as HTMLInputElement).value;
    const privateKey = (document.getElementById('server-private-key') as HTMLTextAreaElement).value;

    if (!name || !host || !username) {
      notify('请填写服务器名称、主机和用户名', {
        title: '服务器信息不完整',
        variant: 'warning',
      });
      const missingId = !name ? 'server-name' : !host ? 'server-host' : 'server-username';
      (document.getElementById(missingId) as HTMLInputElement)?.focus();
      return;
    }

    const authMethod = this.modalAuthMode === 'key' ? 'publickey' : 'password';
    const credential = authMethod === 'publickey' ? privateKey : password;

    // 新增时必须填写凭据，编辑时可选
    if (!this.editingServerId && !credential) {
      notify(authMethod === 'publickey' ? '请粘贴私钥内容' : '请输入密码', {
        title: '认证信息不完整',
        variant: 'warning',
      });
      const credentialId = authMethod === 'publickey' ? 'server-private-key' : 'server-password';
      (document.getElementById(credentialId) as HTMLInputElement | HTMLTextAreaElement)?.focus();
      return;
    }

    const submitBtn = document.getElementById('server-submit-btn') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.innerHTML = `
      <span class="material-symbols-outlined animate-spin" style="font-size: 18px;">progress_activity</span>
      SAVING...
    `;

    try {
      const body: any = { name, host, port, username, auth_method: authMethod };
      if (credential) body.credential = credential;

      // 区域偏好：空字符串表示 Auto（让系统自动推断）
      const regionSelect = document.getElementById('server-region') as HTMLSelectElement | null;
      if (regionSelect) {
        body.region = regionSelect.value || '';
      }

      // 保存请求（后端在保存时会同步推断 locationHint，故时间可能略长）
      let res: Response;
      if (this.editingServerId) {
        res = await fetch(`/api/servers/${this.editingServerId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch('/api/servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error || 'Save failed');
      }

      const responseData = await res.json() as any;

      // DEBUG_MODE 时，响应中包含 _debug 字段：显示完整调试日志
      if (responseData._debug && Array.isArray(responseData._debug)) {
        console.log('[locationHint 调试信息]');
        responseData._debug.forEach((msg: string) => console.log(msg));
        this.showDebugNotification(responseData._debug);
      }

      // 非调试模式：用简短 toast 提示推断结果，让用户知道区域调度已生效
      // POST 与 PUT 路径后端均会返回最新记录（含 inferred_hint 字段）
      if (!responseData._debug) {
        const inferred = responseData.inferred_hint || null;
        const userRegion = body.region || null;
        if (userRegion || inferred) {
          // 用户手动指定优先显示手动值，否则显示系统推断值
          const hint = userRegion || inferred;
          notify(`已保存，区域：${regionLabel(hint)}`, { variant: 'success' });
        } else {
          // 推断失败（私网 IP / 限流 / 未命中映射表）
          notify('已保存，未能推断区域（将使用自动调度）', {
            title: '保存成功',
            variant: 'warning',
          });
        }
      }

      this.hideModal();
      await this.fetchServers();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), {
        title: '保存失败',
        variant: 'danger',
      });
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `
        <span class="material-symbols-outlined" style="font-size: 18px;">save</span>
        ${this.editingServerId ? 'UPDATE_SERVER' : 'SAVE_SERVER'}
      `;
    }
  }

  // ==================== DEBUG 通知 ====================

  private showDebugNotification(debugLines: string[]): void {
    // 创建通知元素
    const notification = document.createElement('div');
    notification.className = 'fixed bottom-4 right-4 z-[200] max-w-md p-4 rounded-lg shadow-2xl border border-[var(--accent)] bg-[var(--bg-surface)] text-[var(--text)] font-mono text-[11px] leading-relaxed custom-scrollbar';
    notification.style.maxHeight = '300px';
    notification.style.overflowY = 'auto';

    const title = document.createElement('div');
    title.className = 'text-[var(--accent)] font-bold mb-2 text-xs';
    title.textContent = '[locationHint 调试信息]';
    notification.appendChild(title);

    const content = document.createElement('div');
    content.className = 'text-muted whitespace-pre-wrap';
    content.textContent = debugLines.join('\n');
    notification.appendChild(content);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'absolute top-2 right-2 text-muted hover:text-[var(--accent)] cursor-pointer';
    closeBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">close</span>';
    closeBtn.onclick = () => notification.remove();
    notification.appendChild(closeBtn);

    document.body.appendChild(notification);

    // 8 秒后自动消失
    setTimeout(() => {
      if (notification.parentNode) {
        notification.style.transition = 'opacity 0.3s';
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
      }
    }, 8000);
  }

  // ==================== 退出登录 ====================

  private async logout(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // 即使请求失败也清除本地状态
    }
    this.onLogout();
  }

  // ==================== 工具函数 ====================

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
