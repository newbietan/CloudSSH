import { mountLanguageSwitchers, onLocaleChange, t } from './i18n';

export interface ClaimedShare {
  wsUrl: string;
  serverName: string;
  sessionExpiresAt: number;
}

export function parseShareToken(hash: string): string | null {
  return hash.match(/^#\/share\/([A-Za-z0-9_-]{40,128})$/)?.[1] ?? null;
}

export function takeShareTokenFromLocation(): string | null {
  const token = parseShareToken(window.location.hash);
  if (!token) return null;
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return token;
}

export function renderShareLanding(
  token: string,
  onConnected: (claim: ClaimedShare) => void,
): void {
  let claiming = false;

  const render = () => {
    const authSection = document.getElementById('auth-section');
    const userSection = document.getElementById('user-space-section');
    const terminalSection = document.getElementById('terminal-section');
    if (!authSection || !userSection || !terminalSection) return;
    userSection.classList.add('hidden');
    userSection.classList.remove('flex');
    terminalSection.classList.add('hidden');
    terminalSection.classList.remove('flex');
    authSection.classList.remove('hidden');
    authSection.innerHTML = `
      <main class="w-full max-w-lg relative z-10" id="share-landing-card">
        <div class="mb-8 text-center">
          <div class="text-3xl font-bold text-primary tracking-tighter mb-2">CloudSSH</div>
        </div>
        <div class="cyber-box p-6 shadow-2xl relative">
          <div class="theme-accent-line absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent opacity-50"></div>
          <div class="flex items-center justify-between mb-5 pb-4 border-b border-dim">
            <span class="text-sm font-bold text-primary">${t('share.accessTitle')}</span>
            <div data-language-switcher></div>
          </div>
          <p class="text-sm text-on-surface mb-4">${t('share.accessDescription')}</p>
          <ul class="space-y-2 text-xs text-muted mb-6 list-disc pl-5">
            <li>${t('share.noticeOneTime')}</li>
            <li>${t('share.noticeAudited')}</li>
            <li>${t('share.noticeNoAgent')}</li>
            <li>${t('share.noticeNoReconnect')}</li>
          </ul>
          <div id="share-claim-error" class="hidden mb-4 text-xs text-error" role="alert"></div>
          <button id="share-claim-btn" type="button" class="cyber-button text-primary w-full py-2.5 text-xs font-bold tracking-[0.1em] flex items-center justify-center gap-2">
            <span class="material-symbols-outlined" style="font-size:18px">login</span>
            <span>${t('share.claimAndConnect')}</span>
          </button>
        </div>
      </main>
    `;
    mountLanguageSwitchers(authSection);
    const button = document.getElementById('share-claim-btn') as HTMLButtonElement | null;
    button?.addEventListener('click', async () => {
      if (claiming) return;
      claiming = true;
      button.disabled = true;
      button.innerHTML = `<span class="material-symbols-outlined animate-spin" style="font-size:18px">progress_activity</span><span>${t('share.claiming')}</span>`;
      const errorBox = document.getElementById('share-claim-error');
      errorBox?.classList.add('hidden');
      try {
        const response = await fetch('/api/share/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const payload = await response.json().catch(() => ({})) as ClaimedShare & { error?: string };
        if (!response.ok) throw new Error(payload.error || t('share.claimFailed'));
        onConnected(payload);
      } catch (error) {
        claiming = false;
        button.disabled = false;
        button.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px">login</span><span>${t('share.claimAndConnect')}</span>`;
        if (errorBox) {
          errorBox.textContent = error instanceof Error ? error.message : t('share.claimFailed');
          errorBox.classList.remove('hidden');
        }
      }
    });
  };

  render();
  onLocaleChange(() => {
    if (!claiming && document.getElementById('share-landing-card')) render();
  });
}

export function renderShareEnded(): void {
  const authSection = document.getElementById('auth-section');
  if (!authSection) return;
  authSection.classList.remove('hidden');
  authSection.innerHTML = `
    <main class="w-full max-w-md relative z-10">
      <div class="cyber-box p-6 text-center">
        <span class="material-symbols-outlined text-muted mb-3" style="font-size:42px">link_off</span>
        <h1 class="text-base font-bold text-primary mb-3">${t('share.endedTitle')}</h1>
        <p class="text-xs text-muted">${t('share.endedDescription')}</p>
      </div>
    </main>
  `;
}
