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
  const card = el('main', 'auth-shell w-full relative');
  card.id = 'share-landing-card';

  const brandRow = el('div', 'workbench-brand-row');
  const brand = el('div', 'workbench-brand');
  const mark = el('span', 'workbench-mark');
  mark.setAttribute('aria-hidden', 'true');
  brand.append(mark, el('span', undefined, 'CloudSSH'));
  const language = el('div', undefined);
  language.setAttribute('data-language-switcher', '');
  brandRow.append(brand, language);
  card.append(brandRow);

  const box = el('div', 'cyber-box auth-card');
  const headerRow = el('div', 'auth-connection-header');
  headerRow.append(el('h1', 'auth-connection-title', t('share.accessTitle')));
  box.append(headerRow);

  box.append(el('p', 'text-sm text-on-surface mb-4', t('share.accessDescription')));

  const noticeList = el('ul', 'share-notices');
  noticeList.setAttribute('role', 'list');
  for (const [key, iconName] of [
    ['share.noticeOneTime', 'vpn_key'],
    ['share.noticeAudited', 'verified_user'],
    ['share.noticeNoAgent', 'info'],
    ['share.noticeNoReconnect', 'link_off'],
  ] as const) {
    const item = el('li', undefined);
    const icon = el('span', 'material-symbols-outlined', iconName);
    icon.setAttribute('aria-hidden', 'true');
    item.append(icon, el('span', undefined, t(key)));
    noticeList.append(item);
  }
  box.append(noticeList);

  const errorBox = el('div', 'hidden mb-4 text-xs text-error');
  errorBox.id = 'share-claim-error';
  errorBox.setAttribute('role', 'alert');
  box.append(errorBox);

  const button = el(
    'button',
    'cyber-button btn-primary auth-connect-button'
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
