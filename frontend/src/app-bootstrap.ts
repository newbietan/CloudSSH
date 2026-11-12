/** Public runtime configuration only; never cache deployment/auth policy in localStorage. */
export interface AppConfig {
  turnstileEnabled: boolean;
  sitekey?: string;
  githubAuthEnabled: boolean;
  githubAuthRequired: boolean;
  sshSharingEnabled?: boolean;
  authMode?: 'password' | 'cf_access' | 'github' | 'anonymous';
  cfAccessEmail?: string | null;
  cfAccessTeamName?: string;
  passwordAuth?: { kdf: string; iterations: number; salt: string } | null;
  passwordHashInvalid?: boolean;
}

export interface InitialUser {
  id: number;
  github_id: number;
  username: string;
  avatar_url: string | null;
}

export const APP_BOOTSTRAP_TIMEOUT_MS = 10_000;

function isAppConfig(value: unknown): value is AppConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as AppConfig;
  return (
    typeof config.turnstileEnabled === 'boolean' &&
    typeof config.githubAuthEnabled === 'boolean' &&
    typeof config.githubAuthRequired === 'boolean' &&
    (!config.turnstileEnabled || typeof config.sitekey === 'string') &&
    (config.authMode === undefined ||
      ['password', 'cf_access', 'github', 'anonymous'].includes(config.authMode))
  );
}

function isInitialUser(value: unknown): value is InitialUser {
  if (!value || typeof value !== 'object') return false;
  const user = value as InitialUser;
  return (
    Number.isInteger(user.id) &&
    Number.isInteger(user.github_id) &&
    typeof user.username === 'string' &&
    (user.avatar_url === null || typeof user.avatar_url === 'string')
  );
}

/** Resolve both reads before choosing a page. Errors must not masquerade as anonymous login. */
export async function loadInitialAppState(): Promise<{
  config: AppConfig;
  user: InitialUser | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APP_BOOTSTRAP_TIMEOUT_MS);
  const options: RequestInit = {
    signal: controller.signal,
    credentials: 'same-origin',
    cache: 'no-store',
  };
  try {
    const [config, user] = await Promise.all([
      (async () => {
        const response = await fetch('/api/config', options);
        if (!response.ok) throw new Error('Configuration unavailable');
        const value: unknown = await response.json();
        if (!isAppConfig(value)) throw new Error('Invalid configuration');
        return value;
      })(),
      (async () => {
        const response = await fetch('/api/auth/me', options);
        if (response.status === 401) return null;
        if (!response.ok) throw new Error('Authentication unavailable');
        const value: unknown = await response.json();
        if (!isInitialUser(value)) throw new Error('Invalid authentication response');
        return value;
      })(),
    ]);
    return { config, user };
  } finally {
    clearTimeout(timer);
    // Also cancel a still-pending sibling request after HTTP/JSON/validation failures.
    controller.abort();
  }
}
