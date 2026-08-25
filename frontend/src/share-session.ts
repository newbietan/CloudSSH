import { localizedApiError } from './api-errors';
import { exportDevicePublicKeySpki } from './device-identity';
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

/** 创建带可选 class 与文本的元素（textContent 赋值，杜绝 HTML 注入面）。 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 分享认领按钮的双态渲染（空闲 / 认领中）。 */
function renderClaimButton(button: HTMLButtonElement, claiming: boolean): void {
  const icon = document.createElement('span');
  icon.className = `material-symbols-outlined${claiming ? ' animate-spin' : ''}`;
  icon.style.fontSize = '18px';
  icon.textContent = claiming ? 'progress_activity' : 'login';
  const label = document.createElement('span');
  label.textContent = claiming ? t('share.claiming') : t('share.claimAndConnect');
  button.replaceChildren(icon, label);
}

function buildShareLandingCard(): HTMLElement {
  const card = el('main', 'w-full max-w-lg relative z-10');
  card.id = 'share-landing-card';

  const brand = el('div', 'mb-8 text-center');
  brand.append(el('div', 'text-3xl font-bold text-primary tracking-tighter mb-2', 'CloudSSH'));
  card.append(brand);

  const box = el('div', 'cyber-box p-6 shadow-2xl relative');
  box.append(
    el(
      'div',
      'theme-accent-line absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent opacity-50'
    )
  );

  const headerRow = el('div', 'flex items-center justify-between mb-5 pb-4 border-b border-dim');
  headerRow.append(el('span', 'text-sm font-bold text-primary', t('share.accessTitle')));
  headerRow.append(el('div', undefined));
  headerRow.lastElementChild?.setAttribute('data-language-switcher', '');
  box.append(headerRow);

  box.append(el('p', 'text-sm text-on-surface mb-4', t('share.accessDescription')));

  const noticeList = el('ul', 'space-y-2 text-xs text-muted mb-6 list-disc pl-5');
  for (const key of [
    'share.noticeOneTime',
    'share.noticeAudited',
    'share.noticeNoAgent',
    'share.noticeNoReconnect',
  ] as const) {
    noticeList.append(el('li', undefined, t(key)));
  }
  box.append(noticeList);

  const errorBox = el('div', 'hidden mb-4 text-xs text-error');
  errorBox.id = 'share-claim-error';
  errorBox.setAttribute('role', 'alert');
  box.append(errorBox);

  const button = el(
    'button',
    'cyber-button text-primary w-full py-2.5 text-xs font-bold tracking-[0.1em] flex items-center justify-center gap-2'
  );
  button.type = 'button';
  button.id = 'share-claim-btn';
  renderClaimButton(button, false);
  box.append(button);

  card.append(box);
  return card;
}

export function renderShareLanding(
  token: string,
  onConnected: (claim: ClaimedShare) => void
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
    authSection.replaceChildren(buildShareLandingCard());
    mountLanguageSwitchers(authSection);
    const button = document.getElementById('share-claim-btn') as HTMLButtonElement | null;
    button?.addEventListener('click', async () => {
      if (claiming) return;
      claiming = true;
      button.disabled = true;
      renderClaimButton(button, true);
      const errorBox = document.getElementById('share-claim-error');
      errorBox?.classList.add('hidden');
      try {
        const devicePubKey = await exportDevicePublicKeySpki();
        // 存储回读校验失败（如无痕模式）：不绑定公钥，该分享会话不具备断线
        // 恢复资格（严格口径）。不在认领页提示——瞬态存储在页面会话内可用，
        // 无可靠检测手段；断线时由终端提示原因并即时终结。
        const response = await fetch('/api/share/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, devicePubKey: devicePubKey ?? undefined }),
        });
        const payload = (await response.json().catch(() => ({}))) as ClaimedShare & {
          error?: string;
        };
        if (!response.ok) throw new Error(localizedApiError(payload, 'share.claimFailed'));
        onConnected(payload);
      } catch (error) {
        claiming = false;
        button.disabled = false;
        renderClaimButton(button, false);
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

  const main = el('main', 'w-full max-w-md relative z-10');
  const box = el('div', 'cyber-box p-6 text-center');

  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined text-muted mb-3';
  icon.style.fontSize = '42px';
  icon.textContent = 'link_off';

  box.append(icon);
  box.append(el('h1', 'text-base font-bold text-primary mb-3', t('share.endedTitle')));
  box.append(el('p', 'text-xs text-muted', t('share.endedDescription')));
  main.append(box);
  authSection.replaceChildren(main);
}
