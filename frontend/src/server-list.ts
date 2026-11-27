import { readApiJson } from './api-errors';
import { notifyServerRemoved, serverOwnerKey } from './server-removal';
import { agentSessionDraftKey } from './agent/session-draft';
import type { AppConfig } from './app-bootstrap';
import { copyTextToClipboard } from './clipboard';
import { isValidTunnelHostname, maskIPAddress } from './host-display';
import { getLocale, onLocaleChange, t } from './i18n';
import { osDisplayName, osIconSvg } from './os-icons';
import { parsePort } from './port';
import { bindPrivateKeyFile, preparePrivateKey } from './private-key-import';
import { requestCloudflareSshCertificate } from './cf-ssh-ca';
import { populateRegionSelect, regionLabel } from './regions';
import { ShareManager } from './share-manager';
import type { SSHHostInfo } from './terminal';
import { confirmAction, notify } from './ui-feedback';
import { formatTimestampWithRelative } from '../../src/server-memory-schema';
import { RDP_DEFAULT_PORT, isRdpId, type RdpCard, type RdpConnector, type RdpProfile } from '../../src/rdp-schema';
import { RdpManager } from './rdp-manager';
import { RdpConnectorSetup } from './rdp-connector-setup';

interface UserInfo {
  id: number;
  github_id: number;
  username: string;
  avatar_url: string | null;
}

export interface ServerConfig {
  id: number;
  user_id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'publickey' | 'none';
  region?: string | null;
  inferred_hint?: string | null;
  tags: string[];
  /** 连接时检测到的远端操作系统（canonical key，如 ubuntu/debian/centos） */
  os?: string | null;
  jump_server_id?: number | null;
  transport_type?: 'direct' | 'cf_tunnel';
  cf_tunnel_host?: string | null;
  cf_access_client_id?: string | null;
  has_cf_access_client_secret?: boolean;
  /** Cloudflare Zero Trust SSH CA 团队标识（非空表示使用原生 SSH CA 短期证书认证） */
  cf_ssh_ca_team?: string | null;
  /** 最近连接成功的 Unix 毫秒时间戳 */
  last_connected_at?: number | null;
  created_at: string;
  updated_at: string;
}

interface ServerSavePayload {
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'publickey' | 'none';
  tags: string[];
  credential?: string;
  region?: string;
  jump_server_id?: number | null;
  transport_type?: 'direct' | 'cf_tunnel';
  cf_tunnel_host?: string;
  cf_access_client_id?: string;
  cf_access_client_secret?: string;
  cf_ssh_ca_team?: string | null;
}

interface ServerSaveResponse {
  inferred_hint?: string | null;
  _debug?: unknown;
}

export const SERVER_PAGE_SIZE = 6;
export const TABLET_SERVER_PAGE_SIZE = 6;
export const MOBILE_SERVER_PAGE_SIZE = 3;

export type ServerSortMode = 'recent' | 'updated' | 'created' | 'name';
export const SERVER_SORT_STORAGE_KEY = 'cloudssh_server_sort';

export function resolveServerPageSize(viewportWidth: number, coarsePointer: boolean): number {
  if (viewportWidth < 768) return MOBILE_SERVER_PAGE_SIZE;
  if (viewportWidth <= 1180 && coarsePointer) return TABLET_SERVER_PAGE_SIZE;
  return SERVER_PAGE_SIZE;
}

function currentServerPageSize(): number {
  return resolveServerPageSize(window.innerWidth, window.matchMedia('(pointer: coarse)').matches);
}

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
  selectedTag = ''
): ServerConfig[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return servers.filter((server) => {
    const matchesQuery =
      !normalizedQuery ||
      [server.name, server.host, server.username].some((value) =>
        value.toLocaleLowerCase().includes(normalizedQuery)
      );
    const matchesTag =
      !selectedTag ||
      (server.tags || []).some(
        (tag) => tag.toLocaleLowerCase() === selectedTag.toLocaleLowerCase()
      );
    return matchesQuery && matchesTag;
  });
}

export function paginateServers<T>(
  servers: readonly T[],
  page: number,
  pageSize = SERVER_PAGE_SIZE
): { items: T[]; currentPage: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(servers.length / pageSize));
  const currentPage = Math.min(Math.max(1, Math.floor(page)), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    items: servers.slice(start, start + pageSize),
    currentPage,
    totalPages,
  };
}

type SortableServer = {
  name: string;
  last_connected_at?: number | null;
  updated_at?: string | number | null;
  created_at?: string | number | null;
};

function sortTimestamp(value: SortableServer['updated_at']): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  // SSH uses SQLite datetime('now') (UTC); newer card metadata is Unix milliseconds.
  const normalizedDate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  return Date.parse(normalizedDate) || 0;
}

export function sortServers<T extends SortableServer>(servers: readonly T[], sortMode: ServerSortMode = 'recent'): T[] {
  return [...servers].sort((a, b) => {
    if (sortMode === 'name') return a.name.localeCompare(b.name);
    if (sortMode === 'recent') {
      const byConnection = (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0);
      if (byConnection) return byConnection;
    }
    const key = sortMode === 'created' ? 'created_at' : 'updated_at';
    return sortTimestamp(b[key]) - sortTimestamp(a[key]);
  });
}

/**
 * 用户空间 — 服务器列表管理组件
 */
export class ServerList {
  private user: UserInfo;
  private servers: ServerConfig[] = [];
  private rdpProfiles: RdpCard[] = [];
  private readonly rdp?: RdpManager;
  private readonly rdpConnector?: RdpConnectorSetup;
  private readonly modalEvents = new AbortController();
  private disposed = false;
  private modalKind: 'ssh' | 'rdp' = 'ssh';
  private rdpSaving = false;
  private listState = {
    ssh: { generation: 0, loaded: false, failed: false, pending: false },
    rdp: { generation: 0, loaded: false, failed: false, pending: false },
  };
  private listAccessDenied = false;
  private onLogout: () => void;
  private onConnect: (wsUrl: string, serverName: string, hostInfo?: SSHHostInfo) => void;
  private editingServerId: number | null = null;
  private editingOriginalAuthMethod: ServerConfig['auth_method'] | null = null;
  /** 入口隐藏时保留已存团队标识，避免普通编辑把 cf_ssh_ca_team 清成 null。 */
  private editingOriginalCfTeam: string | null = null;
  private modalAuthMode: 'password' | 'key' | 'none' | 'cf_ca' = 'password';
  private modalTransportMode: 'direct' | 'cf_tunnel' = 'direct';
  private modalGeneration = 0;
  private resetKeyPicker?: () => void;
  private clearCfAccessClientSecret = false;
  private searchQuery = '';
  private selectedTag = '';
  private sortMode: ServerSortMode = 'recent';
  private currentPage = 1;
  private pageSize = currentServerPageSize();
  private sharingEnabled = false;
  /** 与连接表单一致：只有 Cloudflare Access 登录才显示 SSH CA 入口。 */
  private cfSshCaEnabled = false;
  private readonly shareManager = new ShareManager();

  constructor(
    user: UserInfo,
    onLogout: () => void,
    onConnect: (wsUrl: string, serverName: string, hostInfo?: SSHHostInfo) => void,
    config: AppConfig,
    private readonly openRdp?: (id: string) => void,
  ) {
    this.user = user;
    this.onLogout = onLogout;
    this.onConnect = onConnect;
    this.sharingEnabled = config.sshSharingEnabled === true;
    this.cfSshCaEnabled = config.authMode === 'cf_access';
    const fields = document.querySelector<HTMLFieldSetElement>('#server-rdp-fields');
    if (config.rdpEnabled === true && fields) {
      if (config.rdpConnectorEnabled === true) this.rdpConnector = new RdpConnectorSetup(
        id => { if (!this.disposed) this.openRdp?.(id); }, () => { void this.fetchRdpProfiles(); }, config.rdpConnectorPreview === true);
      this.rdp = new RdpManager(fields, () => this.syncRdpSubmit(), !!this.rdpConnector,
        row => { if (!this.disposed) this.rdpConnector?.open(row, false); });
    }
    try {
      const savedSort = localStorage.getItem(SERVER_SORT_STORAGE_KEY) as ServerSortMode | null;
      if (savedSort && ['recent', 'updated', 'created', 'name'].includes(savedSort)) {
        this.sortMode = savedSort;
      }
    } catch {
      /* ignore */
    }
    const unbindLocale = onLocaleChange(() => this.renderServerGrid());
    this.modalEvents.signal.addEventListener('abort', unbindLocale, { once: true });
    this.init();
  }

  disposeRdp(): void {
    this.disposed = true;
    this.modalEvents.abort();
    this.servers = [];
    this.rdpProfiles = [];
    document.getElementById('server-grid')?.replaceChildren();
    document.getElementById('server-list-notice')?.classList.add('hidden');
    this.rdp?.dispose();
    this.rdpConnector?.dispose();
    this.hideModal();
  }

  private async init(): Promise<void> {
    this.renderUserInfo();
    this.bindEvents();
    this.applyCfSshCaAvailability();
    this.renderSkeletonGrid();
    await this.fetchServers();

    // 设置用户空间的版权年份
    const yearSpan = document.getElementById('user-copyright-year');
    if (yearSpan) yearSpan.textContent = new Date().getFullYear().toString();
  }

  refreshPageSize(): void {
    const nextPageSize = currentServerPageSize();
    if (nextPageSize === this.pageSize) return;
    this.pageSize = nextPageSize;
    this.currentPage = 1;
    this.renderServerGrid();
  }

  /** 用户切回主页或重新展示时调用：先使用内存状态即时重排，再静默拉取后台最新数据同步 */
  async refresh(): Promise<void> {
    this.renderServerGrid();
    await this.fetchServers();
  }

  /** 连接后由 os_detected 消息回调：更新某台服务器的操作系统并即时重渲染图标 */
  updateServerOS(serverId: number, os: string | null): void {
    const server = this.servers.find((s) => s.id === serverId);
    if (!server || server.os === os) return;
    server.os = os;
    this.renderServerGrid();
  }

  // ==================== 渲染用户信息 ====================

  private renderUserInfo(): void {
    const container = document.getElementById('user-info');
    if (!container) return;

    container.innerHTML = '';
    if (this.user.avatar_url) {
      const img = document.createElement('img');
      // GitHub's public avatar endpoint supports CORS. An isolated account page must not rely on no-cors embedding.
      if (window.crossOriginIsolated) img.crossOrigin = 'anonymous';
      img.src = this.user.avatar_url;
      img.alt = this.user.username;
      img.className = 'user-avatar w-8 h-8';
      container.appendChild(img);
    } else {
      // 本地管理员（密码模式）无头像：首字母回退块，复用同款描边样式
      const fallback = document.createElement('span');
      fallback.className =
        'user-avatar w-8 h-8 flex items-center justify-center text-[11px] font-bold text-muted select-none';
      fallback.textContent = (this.user.username || 'A').slice(0, 1).toUpperCase();
      fallback.setAttribute('aria-hidden', 'true');
      container.appendChild(fallback);
    }
    const span = document.createElement('span');
    span.className = 'text-xs font-bold tracking-[0.1em] text-muted';
    span.textContent = this.user.username;
    container.appendChild(span);
  }

  // ==================== 事件绑定 ====================

  private bindEvents(): void {
    this.resetKeyPicker = bindPrivateKeyFile(document.getElementById('server-key-picker')!,
      document.querySelector<HTMLTextAreaElement>('#server-private-key')!, 'server-private-key-file', this.modalEvents.signal);
    // 退出登录
    document.getElementById('logout-btn')?.addEventListener('click', () => this.logout());

    // 添加服务器按钮
    document
      .getElementById('add-server-btn')
      ?.addEventListener('click', () => this.showModal('add'));
    document
      .getElementById('empty-add-btn')
      ?.addEventListener('click', () => this.showModal('add'));

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

    (document.getElementById('server-tag-filter') as HTMLSelectElement | null)?.addEventListener(
      'change',
      (event) => {
        this.selectedTag = (event.target as HTMLSelectElement).value;
        this.currentPage = 1;
        this.renderServerGrid();
      }
    );
    const sortSelect = document.getElementById('server-sort') as HTMLSelectElement | null;
    if (sortSelect) {
      sortSelect.value = this.sortMode;
      sortSelect.addEventListener('change', () => {
        const mode = sortSelect.value as ServerSortMode;
        if (['recent', 'updated', 'created', 'name'].includes(mode)) {
          this.sortMode = mode;
          try {
            localStorage.setItem(SERVER_SORT_STORAGE_KEY, mode);
          } catch {
            /* ignore */
          }
          this.currentPage = 1;
          this.renderServerGrid();
        }
      });
    }
    document.getElementById('server-page-prev')?.addEventListener('click', () => {
      this.currentPage--;
      this.renderServerGrid();
    });
    document.getElementById('server-page-next')?.addEventListener('click', () => {
      this.currentPage++;
      this.renderServerGrid();
    });

    document.getElementById('server-list-retry')?.addEventListener('click', () => {
      if (this.listAccessDenied) { location.reload(); return; }
      for (const kind of ['ssh', 'rdp'] as const) {
        if (this.listState[kind].failed && !this.listState[kind].pending) void this.fetchList(kind);
      }
    }, { signal: this.modalEvents.signal });

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
      if (this.disposed) return;
      if (this.modalKind === 'rdp') void this.saveRdp();
      else void this.handleSubmit();
    }, { signal: this.modalEvents.signal });
    for (const [id, kind] of [['server-kind-linux', 'ssh'], ['server-kind-windows', 'rdp']] as const) {
      const button = document.getElementById(id);
      if (button) button.onclick = () => {
        const submit = document.querySelector<HTMLButtonElement>('#server-submit-btn');
        if (this.rdp && !submit?.disabled && !this.disposed) this.setModalKind(kind);
      };
    }

    document.getElementById('server-empty-password')?.addEventListener('change', () => {
      this.setModalAuthMode(this.modalAuthMode);
    });

    // Modal 认证方式切换
    document
      .getElementById('modal-auth-tab-password')
      ?.addEventListener('click', () => this.setModalAuthMode('password'));
    document
      .getElementById('modal-auth-tab-key')
      ?.addEventListener('click', () => this.setModalAuthMode('key'));
    document
      .getElementById('modal-auth-tab-cf-ca')
      ?.addEventListener('click', () => this.setModalAuthMode('cf_ca'));
    document
      .getElementById('modal-auth-tab-none')
      ?.addEventListener('click', () => this.setModalAuthMode('none'));
    document
      .getElementById('modal-transport-tab-direct')
      ?.addEventListener('click', () => this.setModalTransportMode('direct'));
    document
      .getElementById('modal-transport-tab-tunnel')
      ?.addEventListener('click', () => this.setModalTransportMode('cf_tunnel'));
    document
      .getElementById('server-jump-host')
      ?.addEventListener('change', () => this.updateRegionControls());
    document.getElementById('server-cf-access-toggle')?.addEventListener('click', () => {
      const fields = document.getElementById('server-cf-access-fields');
      this.setCfAccessFieldsOpen(fields?.classList.contains('hidden') ?? true);
    });
    document
      .getElementById('server-cf-clear-secret-btn')
      ?.addEventListener('click', () => this.handleClearCfSecret());
    document.getElementById('server-cf-client-secret')?.addEventListener('input', () => {
      this.clearCfAccessClientSecret = false;
      const statusEl = document.getElementById('server-cf-secret-status');
      if (statusEl) {
        statusEl.textContent = '';
        statusEl.classList.add('hidden');
      }
    });
  }

  // ==================== 数据获取 ====================

  private async fetchServers(): Promise<void> {
    await Promise.all([this.fetchList('ssh'), this.fetchRdpProfiles()]);
  }

  fetchRdpProfiles(): Promise<void> { return this.fetchList('rdp'); }

  private async fetchList(kind: 'ssh' | 'rdp'): Promise<void> {
    if (this.disposed || this.listAccessDenied || (kind === 'rdp' && !this.rdp)) return;
    const state = this.listState[kind];
    const generation = ++state.generation;
    const current = () => !this.disposed && !this.listAccessDenied && generation === state.generation;
    state.pending = true;
    if (state.failed) this.renderListNotice();
    try {
      const signal = AbortSignal.any([this.modalEvents.signal, AbortSignal.timeout(10000)]);
      if (kind === 'ssh') {
        const res = await fetch('/api/servers', { cache: 'no-store', signal });
        if (!res.ok) throw res;
        const rows = await res.json() as ServerConfig[];
        if (!current()) return;
        this.servers = rows.map(server => ({ ...server, tags: Array.isArray(server.tags) ? server.tags : [] }));
      } else {
        const rows = await this.rdp!.list(signal);
        if (!current()) return;
        this.rdpProfiles = rows;
      }
      state.loaded = true;
      state.failed = false;
    } catch (error) {
      if (!current()) return;
      state.failed = true;
      // Never keep the previous account's cards on an explicit authentication/permission failure.
      if (error instanceof Response && (error.status === 401 || error.status === 403)) {
        this.listAccessDenied = true;
        this.hideModal();
        this.servers = [];
        this.rdpProfiles = [];
      }
    } finally {
      if (!this.disposed && generation === state.generation) {
        state.pending = false;
        this.renderServerGrid();
      }
    }
  }

  private renderListNotice(): void {
    const failed = (['ssh', 'rdp'] as const).filter(kind => this.listState[kind].failed);
    const status = document.getElementById('server-list-status');
    if (!status) return;
    const message = this.listAccessDenied ? t('server.listSessionChanged') : failed.map(kind =>
      t(this.listState[kind].loaded ? 'server.listStale' : 'server.listUnavailable', { kind: kind === 'ssh' ? 'SSH' : 'Windows' })
    ).join(' ');
    if (status.textContent !== message) status.textContent = message;
    status.parentElement?.classList.toggle('hidden', !this.listAccessDenied && !failed.length);
    const retry = document.querySelector<HTMLButtonElement>('#server-list-retry');
    if (retry) retry.disabled = !this.listAccessDenied && failed.every(kind => this.listState[kind].pending);
  }

  private applyCfSshCaAvailability(): void {
    document
      .getElementById('modal-auth-tab-cf-ca')
      ?.classList.toggle('hidden', !this.cfSshCaEnabled);
  }

  // ==================== 渲染服务器卡片 ====================

  private renderServerGrid(): void {
    if (this.disposed) return;
    const grid = document.getElementById('server-grid');
    const emptyState = document.getElementById('empty-state');
    const searchWrapper = document.getElementById('server-search-wrapper');
    const searchEmptyState = document.getElementById('server-search-empty');
    const clearSearchButton = document.getElementById('server-search-clear');
    const tagFilterWrapper = document.getElementById('server-tag-filter-wrapper');
    const tagFilter = document.getElementById('server-tag-filter') as HTMLSelectElement | null;
    const pagination = document.getElementById('server-pagination');
    if (!grid || !emptyState || !searchWrapper || !searchEmptyState) return;
    this.renderListNotice();
    grid.removeAttribute('aria-busy');

    if (this.servers.length === 0 && this.rdpProfiles.length === 0) {
      grid.innerHTML = '';
      searchWrapper.classList.add('hidden');
      pagination?.classList.add('hidden');
      pagination?.classList.remove('flex');
      searchEmptyState.classList.add('hidden');
      searchEmptyState.classList.remove('flex');
      const listed = (s: typeof this.listState.ssh) => s.loaded && !s.failed;
      const confirmedEmpty = !this.listAccessDenied && listed(this.listState.ssh) && (!this.rdp || listed(this.listState.rdp));
      emptyState.classList.toggle('hidden', !confirmedEmpty);
      emptyState.classList.toggle('flex', confirmedEmpty);
      return;
    }

    searchWrapper.classList.remove('hidden');
    emptyState.classList.add('hidden');
    emptyState.classList.remove('flex');
    clearSearchButton?.classList.toggle('hidden', this.searchQuery.length === 0);

    const allTags = [...new Set([...this.servers, ...this.rdpProfiles].flatMap((server) => server.tags || []))].sort((a, b) =>
      a.localeCompare(b)
    );
    tagFilterWrapper?.classList.toggle('hidden', allTags.length === 0);
    if (tagFilter) {
      if (this.selectedTag && !allTags.includes(this.selectedTag)) this.selectedTag = '';
      tagFilter.innerHTML = [
        `<option value="">${t('server.allTags')}</option>`,
        ...allTags.map(
          (tag) => `<option value="${this.escapeHtml(tag)}">${this.escapeHtml(tag)}</option>`
        ),
      ].join('');
      tagFilter.value = this.selectedTag;
    }

    const sortSelect = document.getElementById('server-sort') as HTMLSelectElement | null;
    if (sortSelect && sortSelect.value !== this.sortMode) {
      sortSelect.value = this.sortMode;
    }

    const filteredServers = filterServers(this.servers, this.searchQuery, this.selectedTag);
    const query = this.searchQuery.trim().toLocaleLowerCase();
    const windows = this.rdpProfiles.filter((row) =>
      (!this.selectedTag || (row.tags ?? []).includes(this.selectedTag)) &&
      (!query || [row.name, row.host, row.username ?? '', 'Windows Server', 'RDP', ...(row.tags ?? [])].some((value) => value.toLocaleLowerCase().includes(query)))
    );
    const entries = sortServers<ServerConfig | RdpCard>([...filteredServers, ...windows], this.sortMode)
      .map(row => 'route' in row ? { kind: 'rdp' as const, row } : { kind: 'ssh' as const, row });
    if (entries.length === 0) {
      grid.innerHTML = '';
      pagination?.classList.add('hidden');
      pagination?.classList.remove('flex');
      searchEmptyState.classList.remove('hidden');
      searchEmptyState.classList.add('flex');
      return;
    }

    searchEmptyState.classList.add('hidden');
    searchEmptyState.classList.remove('flex');

    const page = paginateServers(entries, this.currentPage, this.pageSize);
    this.currentPage = page.currentPage;
    grid.innerHTML = page.items.map((entry, index) => entry.kind === 'ssh'
      ? this.renderServerCard(entry.row, index, this.searchQuery === '')
      : this.renderRdpCard(entry.row)).join('');

    // Keep RDP out of all SSH-only card actions, sharing, and jump choices.
    for (const entry of page.items) {
      this.bindHostCopy(entry.row.id, entry.row.host);
      if (entry.kind === 'rdp') {
        const { row } = entry;
        const open = document.querySelector<HTMLButtonElement>(`#rdp-open-${row.id}`);
        open?.addEventListener('click', () => { void this.openWindowsCard(row, open); });
        document.getElementById(`rdp-edit-${row.id}`)?.addEventListener('click', () => this.editRdp(row));
        document.getElementById(`rdp-delete-${row.id}`)?.addEventListener('click', () => { void this.deleteRdp(row); });
        continue;
      }
      const server = entry.row;
      document
        .getElementById(`connect-${server.id}`)
        ?.addEventListener('click', () => this.connectServer(server.id));
      document
        .getElementById(`clone-${server.id}`)
        ?.addEventListener('click', () => this.showModal('clone', server));
      document
        .getElementById(`edit-${server.id}`)
        ?.addEventListener('click', () => this.showModal('edit', server));
      document.getElementById(`share-${server.id}`)?.addEventListener('click', () => {
        void this.shareManager.open(server.id, server.name);
      });
      document
        .getElementById(`delete-${server.id}`)
        ?.addEventListener('click', () => this.deleteServer(server.id));
    }

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
          count: entries.length,
        });
      }
    } else {
      pagination?.classList.add('hidden');
      pagination?.classList.remove('flex');
    }
  }

  /** 冷加载骨架屏：按当前分页尺寸渲染占位卡片，fetchServers 完成后由 renderServerGrid 整体替换 */
  private renderSkeletonGrid(): void {
    const grid = document.getElementById('server-grid');
    if (!grid) return;
    grid.setAttribute('aria-busy', 'true');
    const skeletonCard = `<div class="skeleton-card" aria-hidden="true">
      <div class="skeleton-line" style="width: 55%"></div>
      <div class="skeleton-line" style="width: 80%"></div>
      <div class="skeleton-line" style="width: 70%"></div>
      <div class="skeleton-line" style="width: 75%"></div>
      <div class="skeleton-line" style="width: 100%; height: 28px; margin-top: 8px"></div>
    </div>`;
    grid.innerHTML = Array.from({ length: this.pageSize }, () => skeletonCard).join('');
  }

  /** 渲染服务器名称前的图标：已识别操作系统 → 品牌 SVG，否则回退到默认 dns 图标 */
  private renderOSIconMarkup(os: string | null | undefined): string {
    const svg = osIconSvg(os);
    if (svg) {
      const label = osDisplayName(os) ?? t('os.linux');
      return `<span class="server-os-icon shrink-0" title="${this.escapeAttr(label)}">${svg}</span>`;
    }
    return `<span class="material-symbols-outlined text-primary shrink-0" style="font-size: 20px; font-variation-settings: 'FILL' 0;">dns</span>`;
  }

  private bindHostCopy(id: number | string, host: string): void {
    const badge = document.getElementById(`host-badge-${id}`);
    badge?.addEventListener('click', async () => {
      const ok = await copyTextToClipboard(host); // Copy the actual host, never the mask or display port.
      if (this.disposed) return;
      const ip = maskIPAddress(host) !== null;
      if (ok) {
        badge.classList.add('host-ip-copied');
        setTimeout(() => badge.classList.remove('host-ip-copied'), 800);
        notify(t(ip ? 'server.ipCopied' : 'server.hostCopied'), { variant: 'success', duration: 1500 });
      } else notify(t(ip ? 'server.ipCopyFailed' : 'server.hostCopyFailed'), { variant: 'danger' });
    });
  }

  private renderHostRow(id: string | number, host: string, port: number | null): string {
    const masked = maskIPAddress(host);
    const display = Number.isInteger(port) && masked && host.includes(':') ? `[${masked}]` : masked ?? host;
    const copyLabel = this.escapeAttr(t(masked ? 'server.clickToCopyIP' : 'server.clickToCopyHost'));
    return `<div class="server-card-meta-row flex items-center gap-2 min-w-0">
      <span class="text-dim">${t('server.hostLabel')}</span>
      <button type="button" class="host-ip-badge server-host-badge min-w-0 truncate" id="host-badge-${this.escapeAttr(String(id))}" title="${copyLabel}" aria-label="${copyLabel}">${this.escapeHtml(display)}${Number.isInteger(port) ? `:${port}` : ''}</button>
    </div>`;
  }

  private async openWindowsCard(row: RdpCard, button: HTMLButtonElement): Promise<void> {
    if (this.disposed || button.disabled) return;
    if (!row.hasLogin) return this.editRdp(row);
    if (row.route === 'connector' && this.rdpConnector && (!row.connector || ['unbound', 'waiting', 'other_origin'].includes(row.connector.state))) {
      // The user may have closed the installer guide before Windows came online. A stale card must not
      // send them back through setup when they explicitly ask to open the already installed desktop.
      button.disabled = true;
      const connector = await fetch(`/api/rdp/profiles/${row.id}/connector`, { cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([this.modalEvents.signal, AbortSignal.timeout(4000)]),
      }).then(res => res.ok ? res.json() as Promise<RdpConnector> : undefined).catch(() => undefined);
      button.disabled = false;
      if (this.disposed || !button.isConnected) return;
      if (connector?.state !== 'online' && connector?.state !== 'offline') {
        this.rdpConnector.open({ ...row, connector: connector ?? row.connector });
        return;
      }
    }
    this.openRdp?.(row.id);
  }

  private renderRdpCard(row: RdpCard): string {
    if (!isRdpId(row.id)) return '';
    const connected = row.last_connected_at ? formatTimestampWithRelative(row.last_connected_at, Date.now(), getLocale()) : t('rdp.noConnectionRecord');
    return `<div class="server-card p-5 relative group" id="rdp-card-${row.id}">
      <div class="flex items-center gap-2 mb-3 min-w-0">
        ${this.renderOSIconMarkup('windows')}
        <h3 class="server-card-title text-sm font-bold text-primary truncate min-w-0 flex-1" title="${this.escapeAttr(row.name)}">${this.escapeHtml(row.name)}</h3>
        <span class="shrink-0 text-[10px] text-muted border border-dim px-2 py-0.5">RDP</span>
      </div>
      <div class="space-y-1.5 text-xs text-muted mb-4">
        ${row.route !== 'connector' ? this.renderHostRow(row.id, row.host, row.route === 'direct' ? (row.port ?? RDP_DEFAULT_PORT) : null) : ''}
        <div class="server-card-meta-row flex items-center gap-2 min-w-0"><span class="text-dim">${t('server.userLabel')}</span><span class="text-on-surface truncate" title="${this.escapeAttr(row.username ?? '—')}">${this.escapeHtml(row.username ?? '—')}</span></div>
        <div>${t(row.route === 'connector' ? 'rdp.connectorRoute' : row.route === 'tunnel' ? 'rdp.tunnel' : 'rdp.direct')}</div>
        <div class="server-card-meta-row flex items-center gap-2 min-w-0"><span class="text-dim">${t('server.lastConnected')}</span><span class="text-on-surface truncate" title="${this.escapeAttr(connected)}">${this.escapeHtml(connected)}</span></div>
        ${(row.tags ?? []).length ? `<div class="flex flex-wrap gap-1 mt-3">${row.tags.map(tag => `<span class="text-[9px] text-primary border border-[var(--border-strong)] px-1.5 py-0.5">#${this.escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="server-card-actions flex gap-2 pt-3 border-t border-[var(--border)]">
        <button type="button" id="rdp-open-${row.id}" class="server-connect-button cyber-button text-primary flex-1 min-w-0 py-1.5 px-3 text-xs flex items-center justify-center">${t(row.hasLogin ? 'rdp.open' : 'rdp.complete')}</button>
        <button type="button" id="rdp-edit-${row.id}" class="cyber-button text-primary px-3" aria-label="${this.escapeAttr(t('rdp.edit'))}">
          <span class="material-symbols-outlined" aria-hidden="true" style="font-size:14px">edit</span>
        </button>
        <button type="button" id="rdp-delete-${row.id}" class="cyber-button text-error px-3" aria-label="${this.escapeAttr(t('rdp.remove'))}">
          <span class="material-symbols-outlined" aria-hidden="true" style="font-size:14px">delete</span>
        </button>
      </div>
    </div>`;
  }

  private renderServerCard(server: ServerConfig, index = 0, animate = false): string {
    const isCfCa = this.cfSshCaEnabled && Boolean(server.cf_ssh_ca_team);
    const authIcon = isCfCa
      ? 'verified_user'
      : server.auth_method === 'none'
        ? 'person'
        : server.auth_method === 'publickey'
          ? 'vpn_key'
          : 'password';
    const authLabel = isCfCa
      ? 'CF CA'
      : server.auth_method === 'none'
        ? 'NONE'
        : server.auth_method === 'publickey'
          ? 'KEY'
          : 'PWD';
    const isTunnel = server.transport_type === 'cf_tunnel';
    const tunnelBadge = isTunnel
      ? `<span class="shrink-0 text-[10px] font-bold tracking-[0.1em] text-[var(--accent-secondary)] border border-[var(--accent-secondary)] px-1.5 py-0.5">${t('server.tunnelBadge')}</span>`
      : '';

    // 下游节点自身的区域不参与调度；连接区域始终由跳板链入口决定。
    const usesJumpHost = !isTunnel && server.jump_server_id !== null && server.jump_server_id !== undefined;
    const effectiveHint = usesJumpHost ? '' : server.region || server.inferred_hint || '';
    const isManual = !!server.region;
    let regionLabelText = regionLabel('');
    if (usesJumpHost) {
      regionLabelText = t('server.regionViaJump');
    } else if (effectiveHint) {
      regionLabelText = regionLabel(effectiveHint);
    } else if (isTunnel) {
      regionLabelText = t('region.autoShort');
    }
    let regionTag = t('server.regionAuto');
    if (usesJumpHost) {
      regionTag = t('server.regionInherited');
    } else if (isManual && (isTunnel || effectiveHint)) {
      regionTag = t('server.regionManual');
    }
    let regionIcon = 'explore';
    if (isTunnel) {
      regionIcon = 'cloud';
    } else if (usesJumpHost) {
      regionIcon = 'route';
    } else if (effectiveHint) {
      regionIcon = 'my_location';
    }
    const tagMarkup =
      (server.tags || []).length > 0
        ? `<div class="flex flex-wrap gap-1 mt-3">${server.tags
            .map(
              (tag) =>
                `<span class="text-[9px] text-primary border border-[var(--border-strong)] px-1.5 py-0.5">#${this.escapeHtml(tag)}</span>`
            )
            .join('')}</div>`
        : '';
    const jumpNames = this.getJumpPath(server);
    const jumpMarkup =
      jumpNames.length > 0
        ? `<div class="server-card-meta-row flex items-center gap-2 min-w-0">
          <span class="text-dim">${t('server.jumpPath')}</span>
          <span class="text-on-surface min-w-0 truncate" title="${this.escapeAttr(jumpNames.join(' → '))}">${jumpNames.map((name) => this.escapeHtml(name)).join(' → ')}</span>
        </div>`
        : '';

    const lastConnectedText = server.last_connected_at
      ? formatTimestampWithRelative(server.last_connected_at, Date.now(), getLocale())
      : t('server.neverConnected');

    const shareButton = this.sharingEnabled
      ? `<button id="share-${server.id}" class="cyber-button text-primary py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] flex items-center justify-center" title="${t('share.create')}">
          <span class="material-symbols-outlined" style="font-size:14px">share</span>
        </button>`
      : '';

    return `
      <div class="server-card p-5 relative group${animate ? ' server-card--enter' : ''}" id="card-${server.id}"${animate ? ` style="--stagger-index: ${index}"` : ''}>
        <div class="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[var(--border-strong)] to-transparent group-hover:via-[var(--accent)] transition-all duration-300"></div>

        <div class="flex items-start justify-between gap-2 mb-3">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            ${this.renderOSIconMarkup(server.os)}
            <h3 class="server-card-title text-sm font-bold text-primary tracking-[0.05em] truncate min-w-0" title="${this.escapeAttr(server.name)}">${this.escapeHtml(server.name)}</h3>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            ${tunnelBadge}
            <span class="shrink-0 text-[10px] font-bold tracking-[0.1em] text-muted border border-dim px-2 py-0.5 flex items-center gap-1">
              <span class="material-symbols-outlined" style="font-size: 12px;">${authIcon}</span>
              ${authLabel}
            </span>
          </div>
        </div>

        <div class="space-y-1.5 text-xs text-muted mb-4">
          ${this.renderHostRow(server.id, server.host, isTunnel ? null : server.port)}
          <div class="server-card-meta-row flex items-center gap-2 min-w-0">
            <span class="text-dim">${t('server.userLabel')}</span>
            <span class="text-on-surface min-w-0 truncate">${this.escapeHtml(server.username)}</span>
          </div>
          ${jumpMarkup}
          <div class="server-card-region-row flex items-center gap-2 min-w-0">
            <span class="text-dim">${t('server.regionLabel')}</span>
            <span class="text-on-surface flex items-center gap-1">
              <span class="material-symbols-outlined" style="font-size: 11px; color: var(--accent-secondary);">${regionIcon}</span>
              ${this.escapeHtml(regionLabelText)}
            </span>
            <span class="text-[9px] text-dim border border-dim px-1 py-0.5 ml-0.5">${regionTag}</span>
          </div>
          <div class="server-card-meta-row flex items-center gap-2 min-w-0">
            <span class="text-dim">${t('server.lastConnected')}</span>
            <span class="text-on-surface min-w-0 truncate" title="${this.escapeAttr(lastConnectedText)}">${this.escapeHtml(lastConnectedText)}</span>
          </div>
          ${tagMarkup}
        </div>

        <div class="server-card-actions flex gap-2 pt-3 border-t border-[var(--border)]">
          <button id="connect-${server.id}" class="server-connect-button cyber-button text-primary flex-1 min-w-0 py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] uppercase flex items-center justify-center gap-1" title="${t('common.connect')}">
            <span class="material-symbols-outlined" style="font-size: 14px;">power_settings_new</span>
            ${t('common.connect')}
          </button>
          <button id="clone-${server.id}" class="cyber-button text-primary py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] flex items-center justify-center" title="${t('server.clone')}">
            <span class="material-symbols-outlined" style="font-size: 14px;">content_copy</span>
          </button>
          <button id="edit-${server.id}" class="cyber-button text-primary py-1.5 px-3 text-[10px] font-bold tracking-[0.1em] flex items-center justify-center" title="${t('common.edit')}">
            <span class="material-symbols-outlined" style="font-size: 14px;">edit</span>
          </button>
          ${shareButton}
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
      let ephemeralCredential: string | undefined;
      if (server.cf_ssh_ca_team) {
        if (connectBtn) {
          connectBtn.innerHTML = `
            <span class="material-symbols-outlined animate-spin" style="font-size: 14px;">progress_activity</span>
            ${t('auth.cfMinting')}
          `;
        }
        const creds = await requestCloudflareSshCertificate(server.cf_ssh_ca_team);
        ephemeralCredential = `${creds.privateKey}\n${creds.certificate}`;
      }

      const res = await fetch(`/api/servers/${serverId}/connect`, {
        method: 'POST',
        redirect: 'manual',
        headers: ephemeralCredential ? { 'Content-Type': 'application/json' } : undefined,
        body: ephemeralCredential ? JSON.stringify({ ephemeralCredential }) : undefined,
      });

      const { wsUrl } = await readApiJson<{ wsUrl: string }>(res, 'api.requestFailed');

      // 连接凭证获取成功：记录最新连接时间并在最近连接排序下就地重置至首屏
      server.last_connected_at = Date.now();
      if (this.sortMode === 'recent') {
        this.currentPage = 1;
      }

      // 在当前页面内创建新标签并连接
      this.onConnect(wsUrl, server.name, {
        host: server.host,
        port: server.port,
        username: server.username,
        serverId: server.id,
        cfSshCaTeam: server.cf_ssh_ca_team || undefined,
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

      // A proxy/login HTML page with status 200 isn't a committed deletion.
      const result = await readApiJson<{ success?: boolean }>(res, 'api.requestFailed');
      if (result.success !== true) throw new Error(t('api.invalidResponse', { status: res.status }));
      notifyServerRemoved(serverOwnerKey(this.user), serverId);
      const draftKey = agentSessionDraftKey(this.user.github_id, serverId);
      if (draftKey) {
        try { localStorage.removeItem(draftKey); } catch { /* Storage may be unavailable. */ }
      }
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

  private async deleteRdp(row: RdpProfile): Promise<void> {
    if (!this.rdp || this.disposed || !(await confirmAction({
      title: t('rdp.remove'), message: t('rdp.removeConfirm'),
      confirmText: t('common.delete'), cancelText: t('server.keep'), variant: 'danger',
    })) || this.disposed) return;
    try {
      await this.rdp.remove(row.id);
      if (this.disposed) return;
      this.rdpProfiles = this.rdpProfiles.filter(profile => profile.id !== row.id);
      this.renderServerGrid();
      await this.fetchRdpProfiles();
    } catch {
      if (!this.disposed) notify(t('rdp.failed'), { variant: 'danger' });
    }
  }

  private editRdp(row: RdpProfile): void {
    if (!this.rdp || this.disposed) return;
    this.showModal('add');
    this.rdp.reset(row);
    document.getElementById('server-kind-switch')?.classList.add('hidden');
    const title = document.getElementById('modal-title');
    if (title) {
      title.dataset.i18n = 'server.edit';
      title.textContent = t('server.edit');
    }
    this.setModalKind('rdp');
  }

  private setModalKind(kind: 'ssh' | 'rdp', focus = true): void {
    this.resetKeyPicker?.();
    this.modalKind = kind;
    const ssh = document.querySelector<HTMLFieldSetElement>('#server-ssh-fields');
    const rdp = document.querySelector<HTMLFieldSetElement>('#server-rdp-fields');
    for (const [panel, shown] of [[ssh, kind === 'ssh'], [rdp, kind === 'rdp']] as const) {
      if (!panel) continue;
      panel.disabled = !shown;
      panel.classList.toggle('hidden', !shown);
    }
    document.getElementById('server-kind-linux')?.setAttribute('aria-pressed', String(kind === 'ssh'));
    document.getElementById('server-kind-windows')?.setAttribute('aria-pressed', String(kind === 'rdp'));
    const fields = document.querySelector<HTMLElement>('#server-modal .server-modal-fields');
    if (fields) fields.scrollTop = 0;
    this.syncRdpSubmit();
    if (!focus) return;
    if (kind === 'rdp') this.rdp?.focus();
    else document.getElementById('server-name')?.focus({ preventScroll: true });
  }

  private syncRdpSubmit(): void {
    if (this.disposed || this.modalKind !== 'rdp' || !this.rdp) return;
    const submit = document.querySelector<HTMLButtonElement>('#server-submit-btn');
    if (submit) submit.disabled = this.rdpSaving || !this.rdp.canSubmit;
  }

  private async saveRdp(): Promise<void> {
    const submit = document.querySelector<HTMLButtonElement>('#server-submit-btn');
    if (!this.rdp?.canSubmit || !submit || this.rdpSaving) return;
    const generation = this.modalGeneration;
    this.rdpSaving = submit.disabled = true;
    try {
      const saved = await this.rdp.save();
      if (!this.disposed && generation === this.modalGeneration) {
        this.hideModal();
        if (saved.revision === 1) this.rdpConnector?.open(saved);
      }
      await this.fetchRdpProfiles();
    } catch (error) {
      if (!this.disposed && generation === this.modalGeneration) {
        notify(error instanceof Error ? error.message : t('rdp.failed'), { variant: 'danger' });
      }
    } finally {
      if (generation === this.modalGeneration) {
        this.rdpSaving = false;
        this.syncRdpSubmit();
      }
    }
  }

  // ==================== Modal 操作 ====================

  showModal(mode: 'add' | 'edit' | 'clone', server?: ServerConfig): void {
    if (this.disposed) return;
    this.modalGeneration++;
    this.rdpSaving = false;
    this.rdp?.reset();
    this.setModalKind('ssh', false);
    document.getElementById('server-kind-switch')?.classList.toggle('hidden', !this.rdp || mode !== 'add');
    this.editingServerId = mode === 'edit' && server ? server.id : null;
    this.editingOriginalAuthMethod = mode === 'edit' && server ? server.auth_method : null;
    this.editingOriginalCfTeam =
      mode === 'edit' && server?.cf_ssh_ca_team ? server.cf_ssh_ca_team : null;

    const modal = document.getElementById('server-modal');
    const title = document.getElementById('modal-title');
    const submitBtn = document.getElementById('server-submit-btn');
    if (!modal || !title || !submitBtn) return;
    (submitBtn as HTMLButtonElement).disabled = false;
    (document.getElementById('server-empty-password') as HTMLInputElement).checked = false;

    const titleKey = mode === 'add' ? 'server.add' : mode === 'clone' ? 'server.cloneTitle' : 'server.edit';
    title.dataset.i18n = titleKey;
    title.textContent = t(titleKey);
    submitBtn.innerHTML = `
      <span class="material-symbols-outlined" style="font-size: 18px;">save</span>
      ${mode === 'edit' ? t('server.update') : t('server.save')}
    `;
    this.populateJumpHostSelect(server?.jump_server_id ?? null);

    // 填充表单
    if ((mode === 'edit' || mode === 'clone') && server) {
      const nameSuffix = mode === 'clone' ? ` (${t('common.copy')})` : '';
      (document.getElementById('server-name') as HTMLInputElement).value = `${server.name}${nameSuffix}`;
      (document.getElementById('server-host') as HTMLInputElement).value = server.host;
      (document.getElementById('server-port') as HTMLInputElement).value = server.port.toString();
      (document.getElementById('server-username') as HTMLInputElement).value = server.username;
      (document.getElementById('server-password') as HTMLInputElement).value = '';
      (document.getElementById('server-private-key') as HTMLTextAreaElement).value = '';
      const cfCaInput = document.getElementById('server-cf-ca-team') as HTMLInputElement | null;
      if (cfCaInput) cfCaInput.value = server.cf_ssh_ca_team || '';
      (document.getElementById('server-tags') as HTMLInputElement).value = (server.tags || []).join(
        ', '
      );

      this.setModalAuthMode(
        this.cfSshCaEnabled && server.cf_ssh_ca_team
          ? 'cf_ca'
          : server.auth_method === 'publickey'
            ? 'key'
            : server.auth_method === 'none'
              ? 'none'
              : 'password'
      );

      const transport = server.transport_type === 'cf_tunnel' ? 'cf_tunnel' : 'direct';
      this.setModalTransportMode(transport);

      this.clearCfAccessClientSecret = false;
      const secretStatusEl = document.getElementById('server-cf-secret-status');
      if (secretStatusEl) {
        secretStatusEl.textContent = '';
        secretStatusEl.classList.add('hidden');
      }
      const clearBtn = document.getElementById('server-cf-clear-secret-btn');
      if (clearBtn) {
        // 克隆体没有已存密钥可清除，显示该按钮会与「重新输入」提示互相冲突
        clearBtn.classList.toggle(
          'hidden',
          mode === 'clone' || !server.has_cf_access_client_secret
        );
      }

      const clientIdInput = document.getElementById('server-cf-client-id') as HTMLInputElement | null;
      const clientSecretInput = document.getElementById(
        'server-cf-client-secret'
      ) as HTMLInputElement | null;
      if (clientIdInput) clientIdInput.value = server.cf_access_client_id || '';
      if (clientSecretInput) {
        clientSecretInput.value = '';
        if (mode === 'clone' && server.has_cf_access_client_secret) {
          clientSecretInput.placeholder = t('server.reenterSecretOnClone');
        } else {
          clientSecretInput.placeholder = server.has_cf_access_client_secret ? '••••••••' : '';
        }
      }
      if (mode === 'clone' && server.has_cf_access_client_secret && secretStatusEl) {
        secretStatusEl.textContent = t('server.cloneSecretHint');
        secretStatusEl.classList.remove('hidden');
      }

      // 区域下拉：回显用户保存的 region（"" = Auto）
      const regionSelect = document.getElementById('server-region') as HTMLSelectElement | null;
      const inferredInfo = document.getElementById('server-region-inferred');
      if (regionSelect) {
        populateRegionSelect(regionSelect, server.region || '');
      }
      if (inferredInfo) {
        // 旧版本可能为下游节点保存过提示；该值不代表实际连接入口，不能回显。
        inferredInfo.dataset.inferredHint = server.jump_server_id ? '' : server.inferred_hint || '';
      }
    } else {
      // 清空表单
      (document.getElementById('server-name') as HTMLInputElement).value = '';
      (document.getElementById('server-host') as HTMLInputElement).value = '';
      (document.getElementById('server-port') as HTMLInputElement).value = '22';
      (document.getElementById('server-username') as HTMLInputElement).value = '';
      (document.getElementById('server-password') as HTMLInputElement).value = '';
      (document.getElementById('server-private-key') as HTMLTextAreaElement).value = '';
      const cfCaInput = document.getElementById('server-cf-ca-team') as HTMLInputElement | null;
      if (cfCaInput) cfCaInput.value = '';
      (document.getElementById('server-tags') as HTMLInputElement).value = '';
      this.setModalAuthMode('password');
      this.setModalTransportMode('direct');

      this.clearCfAccessClientSecret = false;
      const secretStatusEl = document.getElementById('server-cf-secret-status');
      if (secretStatusEl) {
        secretStatusEl.textContent = '';
        secretStatusEl.classList.add('hidden');
      }
      document.getElementById('server-cf-clear-secret-btn')?.classList.add('hidden');

      const clientIdInput = document.getElementById('server-cf-client-id') as HTMLInputElement | null;
      const clientSecretInput = document.getElementById(
        'server-cf-client-secret'
      ) as HTMLInputElement | null;
      if (clientIdInput) clientIdInput.value = '';
      if (clientSecretInput) {
        clientSecretInput.value = '';
        clientSecretInput.placeholder = '';
      }

      // 新增时：region 默认 Auto，无系统推断可显示
      const regionSelect = document.getElementById('server-region') as HTMLSelectElement | null;
      const inferredInfo = document.getElementById('server-region-inferred');
      if (regionSelect) populateRegionSelect(regionSelect, '');
      if (inferredInfo) inferredInfo.dataset.inferredHint = '';
    }

    this.updateRegionControls();

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    const fields = modal.querySelector<HTMLElement>('.server-modal-fields');
    if (fields) fields.scrollTop = 0;

    // Focus synchronously once visible: a delayed callback can steal focus from a
    // field the user has already started editing, or from a newer dialog.
    (document.getElementById('server-name') as HTMLInputElement)?.focus({ preventScroll: true });
  }

  hideModal(): void {
    this.modalGeneration++;
    this.resetKeyPicker?.();
    const key = document.querySelector<HTMLTextAreaElement>('#server-private-key');
    if (key) key.value = '';
    this.rdpSaving = false;
    this.rdp?.reset();
    const modal = document.getElementById('server-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
    this.editingServerId = null;
    this.editingOriginalAuthMethod = null;
  }

  private setModalTransportMode(mode: 'direct' | 'cf_tunnel'): void {
    this.modalTransportMode = mode;
    const directTab = document.getElementById('modal-transport-tab-direct');
    const tunnelTab = document.getElementById('modal-transport-tab-tunnel');
    const jumpSection = document.getElementById('server-jump-host-section');
    const regionSection = document.getElementById('server-region-section');
    const cfAccessSection = document.getElementById('server-cf-access-section');
    const hostLabel = document.getElementById('server-host-label');
    const hostInput = document.getElementById('server-host') as HTMLInputElement | null;
    const hostField = document.getElementById('server-host-field');
    const portField = document.getElementById('server-port-field');
    const portInput = document.getElementById('server-port') as HTMLInputElement | null;

    directTab?.classList.toggle('auth-tab-active', mode === 'direct');
    tunnelTab?.classList.toggle('auth-tab-active', mode === 'cf_tunnel');

    const isTunnel = mode === 'cf_tunnel';
    if (isTunnel) {
      if (jumpSection) jumpSection.style.display = 'none';
      if (regionSection) regionSection.style.display = '';
      if (cfAccessSection) cfAccessSection.classList.remove('hidden');
      this.setCfAccessFieldsOpen(false);
      if (hostLabel) hostLabel.textContent = t('server.tunnelHost');
      if (hostInput) hostInput.placeholder = t('server.tunnelHostPlaceholder');
    } else {
      if (jumpSection) jumpSection.style.display = '';
      if (regionSection) regionSection.style.display = '';
      if (cfAccessSection) cfAccessSection.classList.add('hidden');
      if (hostLabel) hostLabel.textContent = t('auth.host');
      if (hostInput) hostInput.placeholder = '192.168.1.1';
    }

    // 隧道连接只看域名（实际端口由内网 cloudflared 配置决定）：隐藏端口字段，域名输入占满整行；
    // 隐藏时同步移除 required，避免空值阻断表单校验（保存时端口回落 22，仅作存储记录）
    if (portField) portField.style.display = isTunnel ? 'none' : '';
    if (portInput) portInput.required = !isTunnel;
    hostField?.classList.toggle('ssh-host-field-wide', isTunnel);

    this.updateRegionControls();
  }

  private setCfAccessFieldsOpen(open: boolean): void {
    const fields = document.getElementById('server-cf-access-fields');
    const toggle = document.getElementById('server-cf-access-toggle');
    const chevron = document.getElementById('server-cf-access-chevron');
    fields?.classList.toggle('hidden', !open);
    toggle?.setAttribute('aria-expanded', String(open));
    if (chevron) chevron.textContent = open ? 'expand_less' : 'expand_more';
  }

  private handleClearCfSecret(): void {
    this.clearCfAccessClientSecret = true;
    const secretInput = document.getElementById(
      'server-cf-client-secret'
    ) as HTMLInputElement | null;
    const statusEl = document.getElementById('server-cf-secret-status');
    const clearBtn = document.getElementById('server-cf-clear-secret-btn');
    if (secretInput) {
      secretInput.value = '';
      secretInput.placeholder = '';
    }
    if (statusEl) {
      statusEl.textContent = t('server.secretCleared');
      statusEl.classList.remove('hidden');
    }
    if (clearBtn) {
      clearBtn.classList.add('hidden');
    }
  }

  private setModalAuthMode(mode: 'password' | 'key' | 'none' | 'cf_ca'): void {
    if (mode === 'cf_ca' && !this.cfSshCaEnabled) return;
    this.resetKeyPicker?.();
    this.modalAuthMode = mode;
    for (const value of ['password', 'key', 'none', 'cf_ca'] as const) {
      const tabId = value === 'cf_ca' ? 'modal-auth-tab-cf-ca' : `modal-auth-tab-${value}`;
      const sectionId = value === 'cf_ca' ? 'modal-cf-ca-section' : `modal-${value}-section`;
      const tab = document.getElementById(tabId);
      const section = document.getElementById(sectionId);
      tab?.classList.toggle('auth-tab-active', mode === value);
      tab?.setAttribute('aria-pressed', String(mode === value));
      if (section) section.style.display = mode === value ? '' : 'none';
    }
    const editingPassword =
      mode === 'password' &&
      this.editingServerId !== null &&
      this.editingOriginalAuthMethod === 'password';
    const emptyPassword = document.getElementById('server-empty-password') as HTMLInputElement;
    document.getElementById('server-empty-password-option')!
      .classList.toggle('hidden', !editingPassword);
    const password = document.getElementById('server-password') as HTMLInputElement;
    password.disabled = editingPassword && emptyPassword.checked;
    document.getElementById('server-password-hint')!.classList.toggle('hidden', !editingPassword);
    if (editingPassword) password.setAttribute('aria-describedby', 'server-password-hint');
    else password.removeAttribute('aria-describedby');
  }

  private getJumpPath(server: ServerConfig): string[] {
    const byId = new Map(this.servers.map((item) => [item.id, item]));
    const names: string[] = [];
    const seen = new Set<number>([server.id]);
    let currentId = server.jump_server_id ?? null;
    while (currentId !== null && names.length < 3 && !seen.has(currentId)) {
      seen.add(currentId);
      const current = byId.get(currentId);
      if (!current) break;
      names.unshift(current.name);
      currentId = current.jump_server_id ?? null;
    }
    return names;
  }

  private populateJumpHostSelect(selectedId: number | null): void {
    const select = document.getElementById('server-jump-host') as HTMLSelectElement | null;
    if (!select) return;
    select.innerHTML = '';
    const direct = document.createElement('option');
    direct.value = '';
    direct.textContent = t('server.jumpHostNone');
    select.appendChild(direct);

    const byId = new Map(this.servers.map((item) => [item.id, item]));
    for (const candidate of this.servers) {
      if (candidate.id === this.editingServerId) continue;
      if (candidate.transport_type === 'cf_tunnel') continue;
      if (candidate.cf_ssh_ca_team) continue;
      const seen = new Set<number>();
      let current: ServerConfig | undefined = candidate;
      let depth = 0;
      let invalid = false;
      while (current) {
        if (
          seen.has(current.id) ||
          current.id === this.editingServerId ||
          current.cf_ssh_ca_team
        ) {
          invalid = true;
          break;
        }
        seen.add(current.id);
        depth++;
        if (depth > 3) {
          invalid = true;
          break;
        }
        current = current.jump_server_id ? byId.get(current.jump_server_id) : undefined;
      }
      if (invalid) continue;
      const option = document.createElement('option');
      option.value = String(candidate.id);
      option.textContent = candidate.name;
      select.appendChild(option);
    }
    select.value = selectedId ? String(selectedId) : '';
  }

  private updateRegionControls(): void {
    const jumpSelect = document.getElementById('server-jump-host') as HTMLSelectElement | null;
    const regionSelect = document.getElementById('server-region') as HTMLSelectElement | null;
    const inferredInfo = document.getElementById('server-region-inferred');
    if (!jumpSelect || !regionSelect || !inferredInfo) return;

    const isTunnel = this.modalTransportMode === 'cf_tunnel';
    if (isTunnel) {
      regionSelect.disabled = false;
      regionSelect.classList.remove('cursor-not-allowed', 'opacity-60');
      inferredInfo.textContent = '';
      inferredInfo.classList.add('hidden');
      return;
    }

    inferredInfo.classList.remove('hidden');

    const usesJumpHost = jumpSelect.value !== '';
    regionSelect.disabled = usesJumpHost;
    regionSelect.classList.toggle('cursor-not-allowed', usesJumpHost);
    regionSelect.classList.toggle('opacity-60', usesJumpHost);
    if (usesJumpHost) {
      // 下游节点没有独立的连接区域；切回直连时从 Auto 重新开始。
      regionSelect.value = '';
      inferredInfo.textContent = t('server.regionViaJumpHint');
      return;
    }

    const inferredHint = inferredInfo.dataset.inferredHint || '';
    inferredInfo.textContent = inferredHint
      ? t('server.regionInferred', { region: regionLabel(inferredHint) })
      : '';
  }

  private async handleSubmit(): Promise<void> {
    const generation = this.modalGeneration;
    const editingServerId = this.editingServerId;
    if ((document.getElementById('server-submit-btn') as HTMLButtonElement).disabled) return;
    const name = (document.getElementById('server-name') as HTMLInputElement).value.trim();
    const host = (document.getElementById('server-host') as HTMLInputElement).value.trim();
    const portInput = document.getElementById('server-port') as HTMLInputElement;
    const isTunnel = this.modalTransportMode === 'cf_tunnel';
    // 隧道连接只看域名：端口仅为存储记录，隐藏字段缺省（如先在直连模式清空再切隧道）时回落 22
    let port = parsePort(portInput.value);
    if (isTunnel && port === null) port = 22;
    const username = (document.getElementById('server-username') as HTMLInputElement).value.trim();
    const password = (document.getElementById('server-password') as HTMLInputElement).value;
    const privateKey = (document.getElementById('server-private-key') as HTMLTextAreaElement).value;
    const tags = normalizeTagsInput(
      (document.getElementById('server-tags') as HTMLInputElement).value
    );
    const jumpValue =
      (document.getElementById('server-jump-host') as HTMLSelectElement | null)?.value || '';
    const jumpServerId = jumpValue ? Number(jumpValue) : null;

    if (!name || !host || !username) {
      notify(t('server.detailsRequired'), {
        title: t('server.detailsTitle'),
        variant: 'warning',
      });
      let missingId = 'server-name';
      if (name) {
        if (host) {
          missingId = 'server-username';
        } else {
          missingId = 'server-host';
        }
      }
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

    const isCfCa = this.modalAuthMode === 'cf_ca';
    let cfSshCaTeam: string | null = null;
    if (isCfCa) {
      const teamInput = document.getElementById('server-cf-ca-team') as HTMLInputElement | null;
      cfSshCaTeam = teamInput?.value.trim() || '';
      if (!cfSshCaTeam) {
        notify(t('auth.cfTeamRequired'), {
          title: t('server.detailsTitle'),
          variant: 'warning',
        });
        teamInput?.focus();
        return;
      }
    }

    const authMethod =
      this.modalAuthMode === 'key' || this.modalAuthMode === 'cf_ca'
        ? 'publickey'
        : this.modalAuthMode;
    const useEmptyPassword =
      authMethod === 'password' &&
      (document.getElementById('server-empty-password') as HTMLInputElement).checked;
    let credential =
      authMethod === 'none' || useEmptyPassword || isCfCa
        ? ''
        : authMethod === 'publickey' ? privateKey : password;
    const authMethodChanged =
      this.editingServerId !== null &&
      this.editingOriginalAuthMethod !== null &&
      authMethod !== this.editingOriginalAuthMethod;

    // 只有非 CF CA 的常规私钥模式必须非空；编辑已有密码时留空仍保留原值，除非明确勾选设为空密码。
    if (
      authMethod === 'publickey' &&
      !isCfCa &&
      (!this.editingServerId || authMethodChanged) &&
      !credential
    ) {
      notify(
        authMethodChanged
          ? t('server.credentialRequiredAfterAuthChange')
          : t('auth.validationPrivateKey'),
        {
          title: t('auth.incompleteCredentials'),
          variant: 'warning',
        }
      );
      (document.getElementById('server-private-key') as HTMLTextAreaElement)?.focus();
      return;
    }

    let cleanTunnelHost: string | null = null;
    if (isTunnel) {
      cleanTunnelHost = host
        .replace(/^(https?|wss?):\/\//i, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '');
      if (!isValidTunnelHostname(cleanTunnelHost)) {
        notify(t('server.invalidTunnelHost'), {
          title: t('server.detailsTitle'),
          variant: 'warning',
        });
        document.getElementById('server-host')?.focus();
        return;
      }
    }

    const submitBtn = document.getElementById('server-submit-btn') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.innerHTML = `
      <span class="material-symbols-outlined animate-spin" style="font-size: 18px;">progress_activity</span>
      ${t('server.saving')}
    `;

    try {
      if (authMethod === 'publickey' && credential) {
        const prepared = await preparePrivateKey(credential, true);
        if (!prepared || generation !== this.modalGeneration || this.modalAuthMode !== 'key' ||
            (document.getElementById('server-host') as HTMLInputElement).value.trim() !== host ||
            (document.getElementById('server-username') as HTMLInputElement).value.trim() !== username ||
            (document.getElementById('server-private-key') as HTMLTextAreaElement).value !== privateKey ||
            (this.modalTransportMode === 'cf_tunnel') !== isTunnel) return;
        credential = prepared.key;
      }
      const body: ServerSavePayload = {
        name,
        host,
        port,
        username,
        auth_method: authMethod,
        tags,
        transport_type: this.modalTransportMode,
        jump_server_id: isTunnel ? null : jumpServerId,
      };
      const preserveHiddenCfCa =
        !this.cfSshCaEnabled &&
        Boolean(this.editingOriginalCfTeam) &&
        authMethod === 'publickey' &&
        !authMethodChanged;
      if (!preserveHiddenCfCa) {
        body.cf_ssh_ca_team = isCfCa ? cfSshCaTeam : null;
      }
      if (
        credential ||
        (authMethod === 'password' && (!this.editingServerId || authMethodChanged || useEmptyPassword))
      ) {
        body.credential = credential;
      }

      if (isTunnel && cleanTunnelHost) {
        body.cf_tunnel_host = cleanTunnelHost;
        const clientId = (
          document.getElementById('server-cf-client-id') as HTMLInputElement | null
        )?.value.trim();
        const clientSecret = (
          document.getElementById('server-cf-client-secret') as HTMLInputElement | null
        )?.value.trim();
        if (clientId !== undefined) body.cf_access_client_id = clientId;
        if (clientSecret) {
          body.cf_access_client_secret = clientSecret;
        } else if (this.clearCfAccessClientSecret) {
          body.cf_access_client_secret = '';
        }
      }

      // 直连入口或 Cloudflare 隧道入口均可提交手动区域偏好以优化调度
      const regionSelect = document.getElementById('server-region') as HTMLSelectElement | null;
      if (regionSelect && (isTunnel || jumpServerId === null)) {
        body.region = regionSelect.value || '';
      }

      // 保存请求（后端在保存时会同步推断 locationHint，故时间可能略长）
      let res: Response;
      if (editingServerId) {
        res = await fetch(`/api/servers/${editingServerId}`, {
          method: 'PUT',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch('/api/servers', {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      const responseData = await readApiJson<ServerSaveResponse>(res, 'api.requestFailed');
      const debugLines = Array.isArray(responseData._debug)
        ? responseData._debug.filter((line): line is string => typeof line === 'string')
        : null;

      // DEBUG_MODE 时，响应中包含 _debug 字段：显示完整调试日志
      if (debugLines) {
        console.log('[locationHint 调试信息]');
        for (const msg of debugLines) console.log(msg);
        this.showDebugNotification(debugLines);
      }

      // 非调试模式：用简短 toast 提示推断结果，让用户知道区域调度已生效
      // POST 与 PUT 路径后端均会返回最新记录（含 inferred_hint 字段）
      if (!debugLines) {
        if (isTunnel) {
          const userRegion = body.region || null;
          if (userRegion) {
            notify(t('server.savedRegion', { region: regionLabel(userRegion) }), {
              variant: 'success',
            });
          } else {
            notify(t('server.savedTunnel'), { variant: 'success' });
          }
        } else if (jumpServerId === null) {
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
        } else {
          notify(t('server.savedViaJump'), { variant: 'success' });
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
      // An old unlock/save must never mutate a subsequently opened editor's controls.
      if (generation === this.modalGeneration) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
          <span class="material-symbols-outlined" style="font-size: 18px;">save</span>
          ${this.editingServerId ? t('server.update') : t('server.save')}
        `;
      }
    }
  }

  // ==================== DEBUG 通知 ====================

  private showDebugNotification(debugLines: string[]): void {
    // 创建通知元素
    const notification = document.createElement('div');
    notification.className =
      'fixed bottom-4 right-4 z-[200] max-w-md p-4 rounded-lg shadow-2xl border border-[var(--accent)] bg-[var(--bg-surface)] text-[var(--text)] font-mono text-[11px] leading-relaxed custom-scrollbar';
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
    closeBtn.className =
      'absolute top-2 right-2 text-muted hover:text-[var(--accent)] cursor-pointer';
    closeBtn.innerHTML =
      '<span class="material-symbols-outlined" style="font-size: 16px;">close</span>';
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
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as { logoutUrl?: string };
      if (data?.logoutUrl === '/cdn-cgi/access/logout') {
        window.location.href = '/cdn-cgi/access/logout';
        return;
      }
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
    return text
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
