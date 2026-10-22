import { version } from '../package.json';

/** Build-time version; never infer the running UI version from a cached HTTP response. */
export const APP_VERSION = version;
export const VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const VERSION_RETRY_INTERVAL_MS = 15 * 60 * 1000;
export const VERSION_CHANGELOG_URL = 'https://github.com/newbietan/CloudSSH/blob/main/CHANGELOG.md';

function parseVersion(value: unknown): { parts: number[]; prerelease: boolean } | null {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      value
    );
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  if (
    match[4]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')
  ) {
    return null;
  }
  return { parts, prerelease: !!match[4] };
}

/** Only stable upstream versions are advertised. Normalize v-prefix/build metadata. */
export function normalizeStableVersion(value: unknown): string | null {
  const parsed = parseVersion(value);
  return parsed && !parsed.prerelease ? parsed.parts.join('.') : null;
}

export function isNewerStableVersion(latest: unknown, current: string): boolean {
  const next = parseVersion(latest);
  const running = parseVersion(current);
  if (!next || next.prerelease || !running) return false;
  for (let i = 0; i < 3; i++) {
    if (next.parts[i] !== running.parts[i]) return next.parts[i] > running.parts[i];
  }
  return running.prerelease;
}
