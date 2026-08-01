import { populateRegionSelect, regionLabel } from './regions';
import { confirmAction, notify } from './ui-feedback';
import { onLocaleChange, t } from './i18n';
import { parsePort } from './port';
import { copyTextToClipboard } from './clipboard';
import { maskIPAddress } from './host-display';

interface UserInfo {
  id: number;
  github_id: number;
  username: string;
  avatar_url: string;
}

export interface ServerConfig {
  id: number;
  user_id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'publickey';
  region?: string | null;
  inferred_hint?: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export const SERVER_PAGE_SIZE = 9;

export function normalizeTagsInput(value: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(/[,，]/)) {
    const tag = part.trim().replace(/\s+/g, ' ').slice(0, 24);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 10) break;
  }
  return tags;
}

export function filterServers(
  servers: readonly ServerConfig[],
  query: string,
  selectedTag = '',
): ServerConfig[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return servers.filter((server) => {
    const matchesQuery = !normalizedQuery || [server.name, server.host, server.username]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    const matchesTag = !selectedTag || (server.tags || []).some(
      (tag) => tag.toLocaleLowerCase() === selectedTag.toLocaleLowerCase(),
    );
    return matchesQuery && matchesTag;
  });
}

export function paginateServers(
  servers: readonly ServerConfig[],
  page: number,
  pageSize = SERVER_PAGE_SIZE,
): { items: ServerConfig[]; currentPage: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(servers.length / pageSize));
  const currentPage = Math.min(Math.max(1, Math.floor(page)), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    items: servers.slice(start, start + pageSize),
    currentPage,
    totalPages,
  };
}

/**
 * 用户空间 — 服务器列表管理组件
 */
export class ServerList {
  private user: UserInfo;
  private servers: ServerConfig[] = [];
  private onLogout: () => void;
  private onConnect: (wsUrl: string, serverName: string, hostInfo?: { host: string; port: number; username?: string }) => void;
  private editingServerId: number | null = null;
  private editingOriginalAuthMethod: ServerConfig['auth_method'] | null = null;
  private modalAuthMode: 'password' | 'key' = 'password';
  private searchQuery = '';
  private selectedTag = '';
  private currentPage = 1;

  constructor(
    user: UserInfo,
    onLogout: () => void,
    onConnect: (wsUrl: string, serverName: string, hostInfo?: { host: string; port: number; username?: string }) => void
  ) {
    this.user = user;
    this.onLogout = onLogout;
    this.onConnect = onConnect;
    onLocaleChange(() => this.renderServerGrid());
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

    // 添加服务器按钮
    document.getElementById('add-server-btn')?.addEventListener('click', () => this.showModal('add'));
    document.getElementById('empty-add-btn')?.addEventListener('click', () => this.showModal('add'));

    const searchInput = document.getElementById('server-search') as HTMLInputElement | null;
    const clearSearchButton = document.getElementById('server-search-clear');
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.currentPage = 1;
      this.renderServerGrid();
    });
    clearSearchButton?.addEventListener('click', () => {
      this.searchQuery = '';
      this.currentPage = 1;
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      this.renderServerGrid();
    });

    (document.getElementById('server-tag-filter') as HTMLSelectElement | null)?.addEventListener('change', (event) => {
      this.selectedTag = (event.target as HTMLSelectElement).value;
      this.currentPage = 1;
      this.renderServerGrid();
    });
    document.getElementById('server-page-prev')?.addEventListener('click', () => {
      this.currentPage--;
      this.renderServerGrid();
    });
    document.getElementById('server-page-next')?.addEventListener('click', () => {
      this.currentPage++;
      this.renderServerGrid();
    });

    // Modal 关闭
    document.getElementById('modal-close-btn')?.addEventListener('click', () => this.hideModal());
    document.getElementById('modal-backdrop')?.addEventListener('click', () => this.hideModal());
    document.getElementById('server-modal')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.hideModal();
      }
    });

    // Modal 提交
    document.getElementById('server-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.handleSubmit();
    });

    // Modal 认证方式切换
    document.getElementById('modal-auth-tab-password')?.addEventListener('click', () => this.setModalAuthMode('password'));
    document.getElementById('modal-auth-tab-key')?.addEventListener('click', () => this.setModalAuthMode('key'));

  }

  // ==================== 数据获取 ====================

  private async fetchServers(): Promise<void> {
    try {
      const res = await fetch('/api/servers');
      if (!res.ok) throw new Error('Failed to fetch servers');
      const servers = await res.json() as ServerConfig[];
      this.servers = servers.map((server) => ({
        ...server,
        tags: Array.isArray(server.tags) ? server.tags : [],
      }));
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
    const searchWrapper = document.getElementById('server-search-wrapper');
    const searchEmptyState = document.getElementById('server-search-empty');
    const clearSearchButton = document.getElementById('server-search-clear');
    const tagFilterWrapper = document.getElementById('server-tag-filter-wrapper');
    const tagFilter = document.getElementById('server-tag-filter') as HTMLSelectElement | null;
    const pagination = document.getElementById('server-pagination');
    if (!grid || !emptyState || !searchWrapper || !searchEmptyState) return;

    if (this.servers.length === 0) {
      grid.innerHTML = '';
      searchWrapper.classList.add('hidden');
      pagination?.classList.add('hidden');
      pagination?.classList.remove('flex');
      searchEmptyState.classList.add('hidden');
      searchEmptyState.classList.remove('flex');
      emptyState.classList.remove('hidden');
      emptyState.classList.add('flex');
      return;
    }

    searchWrapper.classList.remove('hidden');
    emptyState.classList.add('hidden');
    emptyState.classList.remove('flex');
    clearSearchButton?.classList.toggle('hidden', this.searchQuery.length === 0);

    const allTags = [...new Set(this.servers.flatMap((server) => server.tags || []))]
      .sort((a, b) => a.localeCompare(b));
    tagFilterWrapper?.classList.toggle('hidden', allTags.length === 0);
    if (tagFilter) {
      if (this.selectedTag && !allTags.includes(this.selectedTag)) this.selectedTag = '';
      tagFilter.innerHTML = [
        `<option value="">${t('server.allTags')}</option>`,
        ...allTags.map((tag) => `<option value="${this.escapeHtml(tag)}">${this.escapeHtml(tag)}</option>`),
      ].join('');
      tagFilter.value = this.selectedTag;
    }

    const filteredServers = filterServers(this.servers, this.searchQuery, this.selectedTag);
    if (filteredServers.length === 0) {
      grid.innerHTML = '';
      pagination?.classList.add('hidden');
      pagination?.classList.remove('flex');
      searchEmptyState.classList.remove('hidden');
      searchEmptyState.classList.add('flex');
      return;
    }

    searchEmptyState.classList.add('hidden');
    searchEmptyState.classList.remove('flex');

    const page = paginateServers(filteredServers, this.currentPage);
    this.currentPage = page.currentPage;
    const visibleServers = page.items;

    grid.innerHTML = visibleServers
      .map((server) => this.renderServerCard(server))
      .join('');

    // 绑定卡片事件
    visibleServers.forEach((server) => {
      document.getElementById(`connect-${server.id}`)?.addEventListener('click', () => this.connectServer(server.id));
      document.getElementById(`edit-${server.id}`)?.addEventListener('click', () => this.showModal('edit', server));
      document.getElementById(`delete-${server.id}`)?.addEventListener('click', () => this.deleteServer(server.id));
      const hostBadge = document.getElementById(`host-badge-${server.id}`);
      if (hostBadge) {
        hostBadge.addEventListener('click', async () => {
          const ok = await copyTextToClipboard(server.host);
          if (ok) {
            hostBadge.classList.add('host-ip-copied');
            setTimeout(() => hostBadge.classList.remove('host-ip-copied'), 800);
            notify(t('server.ipCopied'), { variant: 'success', duration: 1500 });
          } else {
            notify(t('server.ipCopyFailed'), { variant: 'danger' });
          }
        });
      }
    });


    if (page.totalPages > 1) {
      pagination?.classList.remove('hidden');
      pagination?.classList.add('flex');
      const previous = document.getElementById('server-page-prev') as HTMLButtonElement | null;
      const next = document.getElementById('server-page-next') as HTMLButtonElement | null;
      if (previous) previous.disabled = page.currentPage === 1;
      if (next) next.disabled = page.currentPage === page.totalPages;
      const info = document.getElementById('server-page-info');
      if (info) {
        info.textContent = t('server.pageInfo', {
          current: page.currentPage,
          total: page.totalPages,
          count: filteredServers.length,
        });
      }
    } else {
      pagination?.classList.add('hidden');
      pagination?.classList.remove('flex');
    }
  }

  private renderServerCard(server: ServerConfig): string {
    const authIcon = server.auth_method === 'publickey' ? 'vpn_key' : 'password';
    const authLabel = server.auth_method === 'publickey' ? 'KEY' : 'PWD';

    // 区域信息：用户手动覆盖优先，其次系统推断，都没有则显示 Auto
    const effectiveHint = server.region || server.inferred_hint || '';
    const isManual = !!server.region;
    const regionLabelText = regionLabel(effectiveHint);
    const regionTag = effectiveHint
      ? (isManual ? t('server.regionManual') : t('server.regionAuto'))
      : t('server.regionAuto');
    const tagMarkup = (server.tags || []).length > 0
      ? `<div class="flex flex-wrap gap-1 mt-3">${server.tags.map((tag) =>
          `<span class="text-[9px] text-primary border border-[var(--border-strong)] px-1.5 py-0.5">#${this.escapeHtml(tag)}</span>`
        ).join('')}</div>`
      : '';

    const maskedHost = maskIPAddress(server.host);
    const copyIPLabel = this.escapeAttr(t('server.clickToCopyIP'));
    const hostDisplay = maskedHost
      ? `<button type="button" class="host-ip-badge server-host-badge" id="host-badge-${server.id}" title="${copyIPLabel}" aria-label="${copyIPLabel}">${this.escapeHtml(maskedHost)}:${server.port}</button>`
      : `<span class="text-on-surface">${this.escapeHtml(server.host)}:${server.port}</span>`;

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
            <span class="text-dim">${t('server.hostLabel')}</span>
            ${hostDisplay}
          </div>
          <div class="flex items-center gap-2">
            <span class="text-dim">${t('server.userLabel')}</span>
            <span class="text-on-surface">${this.escapeHtml(server.username)}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-dim">${t('server.regionLabel')}</span>
            <span class="text-on-surface flex items-center gap-1">
              <span class="material-symbols-outlined" style="font-size: 11px; color: var(--accent-secondary);">${effectiveHint ? 'my_location' : 'explore'}</span>
              ${this.escapeHtml(regionLabelText)}
            </span>
            <span class="text-[9px] text-dim border border-dim px-1 py-0.5 ml-0.5">${regionTag}</span>
          </div>
          ${tagMarkup}
        </div>

        <div class="server-card-actions flex gap-2 pt-3 border-t border-[var(--border)]">
          <button id="connect-${server.id}" class="cyber-button text-primary flex-1 py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] uppercase flex items-center justify-center gap-1" title="${t('common.connect')}">
            <span class="material-symbols-outlined" style="font-size: 14px;">power_settings_new</span>
            ${t('common.connect')}
          </button>
          <button id="edit-${server.id}" class="cyber-button text-primary py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] flex items-center justify-center" title="${t('common.edit')}">
            <span class="material-symbols-outlined" style="font-size: 14px;">edit</span>
          </button>
          <button id="delete-${server.id}" class="cyber-button py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] flex items-center justify-center text-error border-[var(--error)] hover:bg-[var(--error)] hover:text-[var(--bg)]" title="${t('common.delete')}">
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
        ${t('server.connecting')}
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
      this.onConnect(wsUrl, server.name, {
        host: server.host,
        port: server.port,
        username: server.username,
      });
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), {
        title: t('server.connectFailed'),
        variant: 'danger',
      });
    } finally {
      if (connectBtn) {
        connectBtn.innerHTML = `
          <span class="material-symbols-outlined" style="font-size: 14px;">power_settings_new</span>
          ${t('common.connect')}
        `;
        (connectBtn as HTMLButtonElement).disabled = false;
      }
    }
  }

  private async deleteServer(serverId: number): Promise<void> {
    const server = this.servers.find((s) => s.id === serverId);
    if (!server) return;

    const confirmed = await confirmAction({
      title: t('server.deleteTitle'),
      message: t('server.deleteMessage', { name: server.name }),
      confirmText: t('common.delete'),
      cancelText: t('server.keep'),
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
        title: t('feedback.danger'),
        variant: 'danger',
      });
      await this.fetchServers();
    }
  }

  // ==================== Modal 操作 ====================

  showModal(mode: 'add' | 'edit', server?: ServerConfig): void {
    this.editingServerId = mode === 'edit' && server ? server.id : null;
    this.editingOriginalAuthMethod = mode === 'edit' && server ? server.auth_method : null;

    const modal = document.getElementById('server-modal');
    const title = document.getElementById('modal-title');
    const submitBtn = document.getElementById('server-submit-btn');
    if (!modal || !title || !submitBtn) return;

    title.textContent = mode === 'add' ? t('server.add') : t('server.edit');
    submitBtn.innerHTML = `
      <span class="material-symbols-outlined" style="font-size: 18px;">save</span>
      ${mode === 'add' ? t('server.save') : t('server.update')}
    `;

    // 填充表单
    if (mode === 'edit' && server) {
      (document.getElementById('server-name') as HTMLInputElement).value = server.name;
      (document.getElementById('server-host') as HTMLInputElement).value = server.host;
      (document.getElementById('server-port') as HTMLInputElement).value = server.port.toString();
      (document.getElementById('server-username') as HTMLInputElement).value = server.username;
      (document.getElementById('server-password') as HTMLInputElement).value = '';
      (document.getElementById('server-private-key') as HTMLTextAreaElement).value = '';
      (document.getElementById('server-tags') as HTMLInputElement).value = (server.tags || []).join(', ');

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
          inferredInfo.textContent = t('server.regionInferred', { region: regionLabel(server.inferred_hint) });
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
      (document.getElementById('server-tags') as HTMLInputElement).value = '';
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
    this.editingOriginalAuthMethod = null;
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
    const portInput = document.getElementById('server-port') as HTMLInputElement;
    const port = parsePort(portInput.value);
    const username = (document.getElementById('server-username') as HTMLInputElement).value.trim();
    const password = (document.getElementById('server-password') as HTMLInputElement).value;
    const privateKey = (document.getElementById('server-private-key') as HTMLTextAreaElement).value;
    const tags = normalizeTagsInput((document.getElementById('server-tags') as HTMLInputElement).value);

    if (!name || !host || !username) {
      notify(t('server.detailsRequired'), {
        title: t('server.detailsTitle'),
        variant: 'warning',
      });
      const missingId = !name ? 'server-name' : !host ? 'server-host' : 'server-username';
      (document.getElementById(missingId) as HTMLInputElement)?.focus();
      return;
    }

    if (port === null) {
      notify(t('auth.validationPort'), {
        title: t('server.detailsTitle'),
        variant: 'warning',
      });
      portInput.focus();
      return;
    }

    const authMethod = this.modalAuthMode === 'key' ? 'publickey' : 'password';
    const credential = authMethod === 'publickey' ? privateKey : password;
    const authMethodChanged = this.editingServerId !== null
      && this.editingOriginalAuthMethod !== null
      && authMethod !== this.editingOriginalAuthMethod;

    // 新增或切换认证方式时必须填写与新方式匹配的凭据
    if ((!this.editingServerId || authMethodChanged) && !credential) {
      notify(authMethodChanged
        ? t('server.credentialRequiredAfterAuthChange')
        : t(authMethod === 'publickey' ? 'auth.validationPrivateKey' : 'auth.validationPassword'), {
        title: t('auth.incompleteCredentials'),
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
      ${t('server.saving')}
    `;

    try {
      const body: any = { name, host, port, username, auth_method: authMethod, tags };
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
          notify(t('server.savedRegion', { region: regionLabel(hint) }), { variant: 'success' });
        } else {
          // 推断失败（私网 IP / 限流 / 未命中映射表）
          notify(t('server.savedAuto'), {
            title: t('feedback.success'),
            variant: 'warning',
          });
        }
      }

      this.hideModal();
      await this.fetchServers();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), {
        title: t('feedback.danger'),
        variant: 'danger',
      });
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `
        <span class="material-symbols-outlined" style="font-size: 18px;">save</span>
        ${this.editingServerId ? t('server.update') : t('server.save')}
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

  private escapeAttr(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
