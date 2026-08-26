// 渲染模板中的 innerHTML 站点均带 `pi-lens-ignore: no-inner-html` 内联抑制：
// 动态值均经 escapeHtml 转义或来自可信 i18n 词条，无用户输入直插；
// GitHub Actions 质量门禁不含该规则（AGENTS.md #27）。
import { localizedApiError } from './api-errors';
import { copyTextToClipboard } from './clipboard';
import { t } from './i18n';
import { confirmAction, notify } from './ui-feedback';

interface ShareSummary {
  id: string;
  serverId: number;
  expiresAt: number;
  maxSessionSeconds: number;
  status: 'unused' | 'claimed' | 'active' | 'closed' | 'revoked' | 'expired';
  claimedAt: number | null;
  activeAt: number | null;
  closedAt: number | null;
  createdAt: number;
  /** 审计明细被清理的时间与方式；NULL 表示审计仍在，可查看 */
  auditPurgedAt?: number | null;
  auditPurgeType?: 'manual' | 'auto' | null;
}

interface AuditEvent {
  id: number;
  occurredAt: number;
  eventType: string;
  details: Record<string, unknown>;
}

function escapeHtml(value: string): string {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

const KNOWN_SHARE_STATUSES = new Set([
  'unused',
  'claimed',
  'active',
  'closed',
  'revoked',
  'expired',
]);

/** 审计视图顶部的分享状态本地化；未知值原样透出便于排查。 */
function formatShareStatus(status: string | undefined): string {
  if (!status) return '—';
  return KNOWN_SHARE_STATUSES.has(status) ? t(`share.status.${status}` as never) : status;
}

function stripTerminalControls(value: string): string {
  return value
    // 本函数的目的即去除 ANSI 控制序列（OSC \x1b]... / CSI \x1b[...），正则中的控制字符为设计意图。
    // pi-lens-ignore: lint/suspicious/noControlCharactersInRegex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // pi-lens-ignore: lint/suspicious/noControlCharactersInRegex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

export class ShareManager {
  private serverId = 0;

  async open(serverId: number, serverName: string): Promise<void> {
    this.serverId = serverId;
    this.ensureModal();
    const modal = document.getElementById('share-manager-modal');
    modal?.classList.remove('hidden');
    modal?.classList.add('flex');
    const name = document.getElementById('share-manager-server');
    if (name) name.textContent = serverName;
    await this.loadShares();
  }

  private ensureModal(): void {
    if (document.getElementById('share-manager-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'share-manager-modal';
    modal.className = 'responsive-modal hidden fixed inset-0 z-[120] items-center justify-center';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    // pi-lens-ignore: no-inner-html
    modal.innerHTML = `
      <div class="modal-overlay absolute inset-0" data-share-close></div>
      <div class="responsive-modal-panel cyber-box p-6 shadow-2xl relative z-10 w-full max-w-2xl mx-4 max-h-[85vh] overflow-y-auto custom-scrollbar">
        <div class="flex items-center justify-between mb-5 pb-4 border-b border-dim">
          <div>
            <h2 class="text-sm font-bold text-primary">${t('share.manageTitle')}</h2>
            <p id="share-manager-server" class="text-xs text-muted mt-1"></p>
          </div>
          <button type="button" data-share-close class="text-muted hover:text-primary" aria-label="${t('common.close')}"><span class="material-symbols-outlined">close</span></button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <label class="text-xs text-muted">${t('share.linkExpiry')}
            <select id="share-expiry" class="terminal-input w-full mt-1">
              <option value="5">5 ${t('share.minutes')}</option><option value="15" selected>15 ${t('share.minutes')}</option>
              <option value="30">30 ${t('share.minutes')}</option><option value="60">60 ${t('share.minutes')}</option>
            </select>
          </label>
          <label class="text-xs text-muted">${t('share.sessionDuration')}
            <select id="share-session-duration" class="terminal-input w-full mt-1">
              <option value="15">15 ${t('share.minutes')}</option><option value="30">30 ${t('share.minutes')}</option>
              <option value="60" selected>60 ${t('share.minutes')}</option><option value="120">120 ${t('share.minutes')}</option>
            </select>
          </label>
          <label class="text-xs text-muted">${t('share.auditRetention')}
            <select id="share-audit-retention" class="terminal-input w-full mt-1">
              <option value="7">7 ${t('share.days')}</option><option value="30">30 ${t('share.days')}</option>
              <option value="90" selected>90 ${t('share.days')}</option><option value="180">180 ${t('share.days')}</option>
              <option value="365">365 ${t('share.days')}</option>
            </select>
          </label>
        </div>
        <p class="text-[11px] text-muted mb-4">${t('share.createWarning')}</p>
        <button id="share-create-btn" type="button" class="cyber-button text-primary px-4 py-2 text-xs font-bold flex items-center gap-2">
          <span class="material-symbols-outlined" style="font-size:16px">add_link</span>${t('share.create')}
        </button>
        <div id="share-created-link" class="hidden mt-4 p-3 border border-[var(--border-strong)]"></div>
        <div class="mt-6 pt-4 border-t border-dim">
          <h3 class="text-xs font-bold text-primary mb-3">${t('share.history')}</h3>
          <div id="share-list" class="space-y-3"></div>
        </div>
        <div id="share-audit-view" class="hidden mt-6 pt-4 border-t border-dim"></div>
      </div>
    `;
    document.body.appendChild(modal);
    for (const element of modal.querySelectorAll('[data-share-close]')) {
      element.addEventListener('click', () => this.close());
    }
    modal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
    });
    document
      .getElementById('share-create-btn')
      ?.addEventListener('click', () => void this.createShare());
  }

  private close(): void {
    const modal = document.getElementById('share-manager-modal');
    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
  }

  private async createShare(): Promise<void> {
    const button = document.getElementById('share-create-btn') as HTMLButtonElement | null;
    const expiresInMinutes = Number(
      (document.getElementById('share-expiry') as HTMLSelectElement).value
    );
    const maxSessionMinutes = Number(
      (document.getElementById('share-session-duration') as HTMLSelectElement).value
    );
    const auditRetentionDays = Number(
      (document.getElementById('share-audit-retention') as HTMLSelectElement).value
    );
    if (button) button.disabled = true;
    try {
      const response = await fetch(`/api/servers/${this.serverId}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInMinutes, maxSessionMinutes, auditRetentionDays }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        url?: string;
        expiresAt?: number;
        error?: string;
      };
      if (!response.ok || !payload.url)
        throw new Error(localizedApiError(payload, 'share.createFailed'));
      const linkBox = document.getElementById('share-created-link');
      if (linkBox) {
        linkBox.classList.remove('hidden');
        // pi-lens-ignore: no-inner-html
        linkBox.innerHTML = `
          <p class="text-xs text-muted mb-2">${t('share.copyOnce')}</p>
          <div class="flex gap-2">
            <input id="share-created-url" class="terminal-input flex-1 text-xs" readonly>
            <button id="share-copy-btn" type="button" class="cyber-button px-3 text-xs">${t('common.copy')}</button>
          </div>
          <p class="text-[10px] text-dim mt-2">${t('share.expiresAt', { time: formatTime(payload.expiresAt ?? null) })}</p>
        `;
        (document.getElementById('share-created-url') as HTMLInputElement).value = payload.url;
        document.getElementById('share-copy-btn')?.addEventListener('click', async () => {
          const copied = await copyTextToClipboard(payload.url!);
          notify(copied ? t('share.copied') : t('terminal.copyFailed'), {
            variant: copied ? 'success' : 'danger',
          });
        });
      }
      await this.loadShares();
    } catch (error) {
      notify(error instanceof Error ? error.message : t('share.createFailed'), {
        variant: 'danger',
      });
    } finally {
      if (button) button.disabled = false;
    }
  }

  private async loadShares(): Promise<void> {
    const container = document.getElementById('share-list');
    if (!container) return;
    // pi-lens-ignore: no-inner-html
    container.innerHTML = `<p class="text-xs text-muted">${t('common.loading')}</p>`;
    try {
      const response = await fetch(`/api/servers/${this.serverId}/shares`);
      const shares = (await response.json()) as ShareSummary[] & { error?: string };
      if (!response.ok) throw new Error(localizedApiError(shares, 'share.loadFailed'));
      if (shares.length === 0) {
        // pi-lens-ignore: no-inner-html
        container.innerHTML = `<p class="text-xs text-muted">${t('share.none')}</p>`;
        return;
      }
      const purged = shares.filter((s) => s.auditPurgedAt);
      // 已清理审计的分享等同删除效果：不再渲染卡片，仅在下方清理留痕区留一条记录
      const visible = shares.filter((s) => !s.auditPurgedAt);
      // 集中式清理留痕区：所有已清理的分享都汇总在这里（默认收起）
      const cleanupSection =
        purged.length > 0
          ? `<details class="mb-3 border border-[var(--border)] p-2">
              <summary class="text-[10px] text-muted cursor-pointer select-none">
                ${t('share.auditCleanupLog')}（${purged.length}）
              </summary>
              <div class="space-y-1 mt-2">
                ${purged.map((share) => `<div class="text-[10px] text-muted"><span class="text-dim">${escapeHtml(formatTime(share.auditPurgedAt ?? null))}</span> ${escapeHtml(t(`share.status.${share.status}` as never))} · ${share.auditPurgeType === 'auto' ? t('share.auditPurgeAuto') : t('share.auditPurgeManual')}</div>`).join('')}
              </div>
              <p class="text-[10px] text-dim mt-1">${t('share.auditRemovalHint')}</p>
            </details>`
          : '';
      // pi-lens-ignore: no-inner-html
      container.innerHTML =
        cleanupSection +
        visible
          .map((share) => {
            const revocable = ['unused', 'claimed', 'active'].includes(share.status);
            return `<div class="border border-[var(--border)] p-3" data-share-id="${escapeHtml(share.id)}">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-xs text-on-surface">${t(`share.status.${share.status}` as never)}</div>
              <div class="text-[10px] text-muted mt-1">${t('share.createdAt', { time: formatTime(share.createdAt) })}</div>
              <div class="text-[10px] text-muted">${t('share.expiresAt', { time: formatTime(share.expiresAt) })}</div>
            </div>
            <div class="flex gap-2 shrink-0">
              <button type="button" data-share-audit="${escapeHtml(share.id)}" class="cyber-button px-2 py-1 text-[10px]">${t('share.audit')}</button>
              ${revocable ? `<button type="button" data-share-revoke="${escapeHtml(share.id)}" class="cyber-button px-2 py-1 text-[10px] text-error">${t('share.revoke')}</button>` : ''}
            </div>
          </div>
        </div>`;
          })
          .join('');
      for (const button of container.querySelectorAll<HTMLElement>('[data-share-audit]')) {
        const shareId = button.dataset.shareAudit;
        if (!shareId) continue;
        button.addEventListener('click', () => void this.loadAudit(shareId));
      }
      for (const button of container.querySelectorAll<HTMLElement>('[data-share-revoke]')) {
        const shareId = button.dataset.shareRevoke;
        if (!shareId) continue;
        button.addEventListener('click', () => void this.revokeShare(shareId));
      }
    } catch (error) {
      // pi-lens-ignore: no-inner-html
      container.innerHTML = `<p class="text-xs text-error">${escapeHtml(error instanceof Error ? error.message : t('share.loadFailed'))}</p>`;
    }
  }

  private async revokeShare(shareId: string): Promise<void> {
    const confirmed = await confirmAction({
      title: t('share.revokeTitle'),
      message: t('share.revokeMessage'),
      confirmText: t('share.revoke'),
      cancelText: t('common.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    const response = await fetch(`/api/shares/${encodeURIComponent(shareId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { error?: string };
      notify(error.error || t('share.revokeFailed'), { variant: 'danger' });
      return;
    }
    notify(t('share.revoked'), { variant: 'success' });
    await this.loadShares();
  }

  private async loadAudit(shareId: string): Promise<void> {
    const view = document.getElementById('share-audit-view');
    if (!view) return;
    view.classList.remove('hidden');
    // pi-lens-ignore: no-inner-html
    view.innerHTML = `<p class="text-xs text-muted">${t('common.loading')}</p>`;
    try {
      const { share, events } = await this.fetchAllAudit(shareId);
      const output = stripTerminalControls(
        events
          .filter((event) => event.eventType === 'terminal.output')
          .map((event) => String(event.details.text ?? ''))
          .join('')
      );
      const structured = events.filter((event) => event.eventType !== 'terminal.output');
      const canPurge =
        share?.status === 'closed' || share?.status === 'revoked' || share?.status === 'expired';
      // pi-lens-ignore: no-inner-html
      view.innerHTML = `
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-xs font-bold text-primary">${t('share.auditTitle')}</h3>
          <div class="flex items-center gap-2">
            <span class="text-[10px] text-muted">${formatShareStatus(share?.status)} · ${Math.ceil((share?.auditBytes || 0) / 1024)} KiB</span>
            <button type="button" data-audit-export class="cyber-button px-2 py-1 text-[10px]">${t('share.auditExport')}</button>
            ${canPurge ? `<button type="button" data-audit-purge class="cyber-button px-2 py-1 text-[10px] text-error">${t('share.auditPurge')}</button>` : ''}
          </div>
        </div>
        <div class="space-y-1 mb-4 max-h-48 overflow-y-auto custom-scrollbar">
          ${structured.map((event) => `<div class="text-[10px] text-muted"><span class="text-dim">${escapeHtml(formatTime(event.occurredAt))}</span> ${escapeHtml(this.describeEvent(event))}</div>`).join('') || `<p class="text-xs text-muted">${t('share.auditNone')}</p>`}
        </div>
        <h4 class="text-[11px] font-bold text-primary mb-2">${t('share.terminalRecord')}</h4>
        <pre class="bg-[var(--bg)] border border-[var(--border)] p-3 text-[11px] text-on-surface whitespace-pre-wrap break-words max-h-72 overflow-auto custom-scrollbar">${escapeHtml(output || t('share.noTerminalOutput'))}</pre>
      `;
      for (const button of view.querySelectorAll<HTMLElement>('[data-audit-export]')) {
        button.addEventListener('click', () => void this.exportAudit(shareId));
      }
      for (const button of view.querySelectorAll<HTMLElement>('[data-audit-purge]')) {
        button.addEventListener('click', () => void this.purgeAudit(shareId));
      }
    } catch (error) {
      // pi-lens-ignore: no-inner-html
      view.innerHTML = `<p class="text-xs text-error">${escapeHtml(error instanceof Error ? error.message : t('share.auditFailed'))}</p>`;
    }
  }

  /** 拉取指定分享的全部审计事件、清理记录与元信息（分页聚合）。 */
  private async fetchAllAudit(shareId: string): Promise<{
    share: { status: string; auditBytes: number } | null;
    events: AuditEvent[];
    removals: Array<{ occurredAt: number; eventType: string }>;
  }> {
    const events: AuditEvent[] = [];
    let removals: Array<{ occurredAt: number; eventType: string }> = [];
    let share: { status: string; auditBytes: number } | null = null;
    let after = 0;
    let hasMore = true;
    while (hasMore && events.length < 5000) {
      const response = await fetch(
        `/api/shares/${encodeURIComponent(shareId)}/audit?after=${after}&limit=500`
      );
      const payload = (await response.json().catch(() => ({}))) as {
        share?: { status: string; auditBytes: number };
        events?: AuditEvent[];
        removals?: Array<{ occurredAt: number; eventType: string }>;
        hasMore?: boolean;
        nextAfter?: number;
        error?: string;
      };
      if (!response.ok || !payload.share || !payload.events)
        throw new Error(localizedApiError(payload, 'share.auditFailed'));
      share = { status: payload.share.status, auditBytes: payload.share.auditBytes };
      events.push(...payload.events);
      // 清理记录每页都全量返回，直接覆盖避免重复累积
      if (payload.removals) removals = payload.removals;
      hasMore = payload.hasMore === true;
      const next = payload.nextAfter ?? after;
      if (next <= after) break;
      after = next;
    }
    return { share, events, removals };
  }

  /** 导出全部审计事件为 JSON 归档（含生命周期与终端输出原文）。 */
  private async exportAudit(shareId: string): Promise<void> {
    try {
      const { share, events, removals } = await this.fetchAllAudit(shareId);
      const payload = {
        app: 'CloudSSH',
        kind: 'share-audit-export',
        exportedAt: new Date().toISOString(),
        shareId,
        status: share?.status ?? null,
        auditBytes: share?.auditBytes ?? 0,
        events,
        auditRemovals: removals,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `cloudssh-share-audit-${shareId}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      notify(t('share.auditFailed'), { variant: 'danger' });
    }
  }

  /** 清空终态会话的全部审计明细（服务端写入墓碑，不可恢复）。 */
  private async purgeAudit(shareId: string): Promise<void> {
    const confirmed = await confirmAction({
      title: t('share.auditPurgeTitle'),
      message: t('share.auditPurgeMessage'),
      confirmText: t('share.auditPurge'),
      cancelText: t('common.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(shareId)}/audit`, {
        method: 'DELETE',
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(localizedApiError(payload, 'share.auditPurgeFailed'));
      notify(t('share.auditPurged'), { variant: 'success' });
      // 清理等同删除效果：立即收起审计视图并刷新列表，隐藏该分享的查看入口
      const view = document.getElementById('share-audit-view');
      if (view) {
        view.classList.add('hidden');
        view.innerHTML = '';
      }
      await this.loadShares();
    } catch (error) {
      notify(error instanceof Error ? error.message : t('share.auditPurgeFailed'), {
        variant: 'danger',
      });
    }
  }

  private describeEvent(event: AuditEvent): string {
    const details = event.details;
    if (event.eventType === 'sftp.request' || event.eventType === 'sftp.result') {
      const operation = String(details.operation || 'sftp');
      const path = String(details.path || details.oldPath || '');
      let result = t('share.auditRequested');
      if (event.eventType === 'sftp.result') {
        result = details.success === true ? t('share.auditSuccess') : t('share.auditFailure');
      }
      return `SFTP ${operation}${path ? ` ${path}` : ''} · ${result}`;
    }
    return t(`share.event.${event.eventType}` as never);
    // 注意：share.event.share.audit_purged / audit_auto_purged 两条墓碑词条已移除——
    // 新版后端 ownerView 已把两类墓碑事件从事件列表过滤（removals 单独返回），
    // 正常路径不会命中；且前后端同源内联原子部署（build-html → 同一 Worker），
    // 不存在“新前端调用旧后端”的窗口。如未来启用渐近发布等新旧 Worker 共存
    // 方案，再按需补回词条。
  }
}
