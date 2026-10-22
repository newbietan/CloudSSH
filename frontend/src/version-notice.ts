import {
  APP_VERSION,
  isNewerStableVersion,
  normalizeStableVersion,
  VERSION_CHANGELOG_URL,
  VERSION_CHECK_INTERVAL_MS,
  VERSION_RETRY_INTERVAL_MS,
} from '../../src/version';
import { getLocale, onLocaleChange, t } from './i18n';

export const VERSION_CACHE_KEY = 'cloudssh_version_check';
export const VERSION_DISMISSED_KEY = 'cloudssh_version_dismissed';

export interface VersionCache {
  checkedAt: number;
  latestVersion: string | null;
}

export function parseVersionCache(raw: string | null, now: number): VersionCache | null {
  if (!raw || raw.length > 512) return null;
  try {
    const value = JSON.parse(raw) as Partial<VersionCache> | null;
    if (!value || typeof value.checkedAt !== 'number' || !Number.isFinite(value.checkedAt)) {
      return null;
    }
    const latestVersion = normalizeStableVersion(value.latestVersion);
    if (latestVersion !== value.latestVersion) return null;
    const age = now - value.checkedAt;
    const ttl = latestVersion === null ? VERSION_RETRY_INTERVAL_MS : VERSION_CHECK_INTERVAL_MS;
    if (age < 0 || age >= ttl) return null;
    return { checkedAt: value.checkedAt, latestVersion };
  } catch {
    return null;
  }
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or disabled storage: retain the same behavior in memory for this page.
  }
}

/** Passive inline hints only; no automatic refresh, navigation, focus changes, or dialogs. */
export function initVersionNotice(): () => void {
  const containers = [...document.querySelectorAll<HTMLElement>('[data-version-notice]')];
  if (containers.length === 0) return () => {};
  let cache = parseVersionCache(readStorage(VERSION_CACHE_KEY), Date.now());
  let dismissed = readStorage(VERSION_DISMISSED_KEY);
  let inFlight = false;
  let disposed = false;
  let controller: AbortController | null = null;
  let renderedState = '';

  const render = (): void => {
    const latest = cache?.latestVersion;
    const showUpdate = latest && latest !== dismissed && isNewerStableVersion(latest, APP_VERSION);
    const state = `${getLocale()}:${showUpdate ? latest : ''}`;
    if (state === renderedState) return;
    renderedState = state;
    for (const container of containers) {
      container.classList.add('version-notice');
      container.classList.toggle('version-notice--update', !!showUpdate);
      const current = document.createElement('span');
      current.className = 'version-notice__current';
      current.textContent = `v${APP_VERSION}`;
      current.title = t('version.current', { version: APP_VERSION });
      container.replaceChildren(current);
      if (!showUpdate) continue;

      const link = document.createElement('a');
      link.className = 'version-notice__link';
      link.href = VERSION_CHANGELOG_URL;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = t('version.available', { version: latest });
      link.title = t('version.hint', { current: APP_VERSION, latest });
      link.setAttribute('aria-label', link.title);
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'version-notice__dismiss';
      dismiss.textContent = '×';
      dismiss.title = t('version.dismiss');
      dismiss.setAttribute('aria-label', t('version.dismiss'));
      dismiss.addEventListener('click', (event) => {
        event.stopPropagation();
        dismissed = latest;
        writeStorage(VERSION_DISMISSED_KEY, latest);
        render();
      });
      container.append(link, dismiss);
    }
  };

  const check = async (): Promise<void> => {
    if (
      disposed || inFlight || document.visibilityState === 'hidden' || navigator.onLine === false
    ) return;
    // Reuse another tab's fresh check, but expired caches never suppress future checks.
    cache =
      parseVersionCache(readStorage(VERSION_CACHE_KEY), Date.now()) ??
      (cache ? parseVersionCache(JSON.stringify(cache), Date.now()) : null);
    if (cache) {
      render();
      return;
    }
    inFlight = true;
    controller = new AbortController();
    const timeout = window.setTimeout(() => controller?.abort(), 5000);
    let latestVersion: string | null = null;
    try {
      const response = await fetch('/api/version', {
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (response.ok) {
        const data: unknown = await response.json();
        if (data && typeof data === 'object' && 'latestVersion' in data) {
          latestVersion = normalizeStableVersion(data.latestVersion);
        }
      }
    } catch {
      // Updates are optional; failed checks must not produce a toast or connection error.
    } finally {
      window.clearTimeout(timeout);
      controller = null;
      inFlight = false;
    }
    if (disposed) return;
    cache = { checkedAt: Date.now(), latestVersion };
    writeStorage(VERSION_CACHE_KEY, JSON.stringify(cache));
    render();
  };

  const onVisibility = (): void => {
    void check();
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === VERSION_DISMISSED_KEY || event.key === null) {
      dismissed = readStorage(VERSION_DISMISSED_KEY);
      render();
    }
    if (event.key === VERSION_CACHE_KEY || event.key === null) void check();
  };
  render();
  void check();
  // Recheck long-lived visible pages without polling hidden terminal sessions.
  const interval = window.setInterval(onVisibility, VERSION_RETRY_INTERVAL_MS);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onVisibility);
  window.addEventListener('storage', onStorage);
  const removeLocaleListener = onLocaleChange(render);
  return () => {
    disposed = true;
    controller?.abort();
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onVisibility);
    window.removeEventListener('storage', onStorage);
    removeLocaleListener();
  };
}
