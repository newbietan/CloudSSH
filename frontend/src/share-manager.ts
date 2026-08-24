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
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
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
    if (button) button.disabled = true;
    try {
      const response = await fetch(`/api/servers/${this.serverId}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInMinutes, maxSessionMinutes }),
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
      // pi-lens-ignore: no-inner-html
      container.innerHTML = shares
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
      const events: AuditEvent[] = [];
      let after = 0;
      let hasMore = true;
      let share: { status: string; auditBytes: number } | null = null;
      while (hasMore && events.length < 5000) {
        const response = await fetch(
          `/api/shares/${encodeURIComponent(shareId)}/audit?after=${after}&limit=500`
        );
        const payload = (await response.json().catch(() => ({}))) as {
          share?: { status: string; auditBytes: number };
          events?: AuditEvent[];
          hasMore?: boolean;
          nextAfter?: number;
          error?: string;
        };
        if (!response.ok || !payload.share || !payload.events)
          throw new Error(payload.error || t('share.auditFailed'));
        share = payload.share;
        events.push(...payload.events);
        hasMore = payload.hasMore === true;
        const next = payload.nextAfter ?? after;
        if (next <= after) break;
        after = next;
      }
      const output = stripTerminalControls(
        events
          .filter((event) => event.eventType === 'terminal.output')
          .map((event) => String(event.details.text ?? ''))
          .join('')
      );
      const structured = events.filter((event) => event.eventType !== 'terminal.output');
      // pi-lens-ignore: no-inner-html
      view.innerHTML = `
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-xs font-bold text-primary">${t('share.auditTitle')}</h3>
          <span class="text-[10px] text-muted">${formatShareStatus(share?.status)} · ${Math.ceil((share?.auditBytes || 0) / 1024)} KiB</span>
        </div>
        <div class="space-y-1 mb-4 max-h-48 overflow-y-auto custom-scrollbar">
          ${structured.length ? structured.map((event) => `<div class="text-[10px] text-muted"><span class="text-dim">${escapeHtml(formatTime(event.occurredAt))}</span> ${escapeHtml(this.describeEvent(event))}</div>`).join('') : `<p class="text-xs text-muted">${t('share.auditNone')}</p>`}
        </div>
        <h4 class="text-[11px] font-bold text-primary mb-2">${t('share.terminalRecord')}</h4>
        <pre class="bg-[var(--bg)] border border-[var(--border)] p-3 text-[11px] text-on-surface whitespace-pre-wrap break-words max-h-72 overflow-auto custom-scrollbar">${escapeHtml(output || t('share.noTerminalOutput'))}</pre>
      `;
    } catch (error) {
      // pi-lens-ignore: no-inner-html
      view.innerHTML = `<p class="text-xs text-error">${escapeHtml(error instanceof Error ? error.message : t('share.auditFailed'))}</p>`;
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
  }
}
