import { describe, expect, it } from 'vitest';
import { version as frontendVersion } from '../frontend/package.json';
import {
  APP_VERSION,
  isNewerStableVersion,
  normalizeStableVersion,
  VERSION_CHECK_INTERVAL_MS,
  VERSION_RETRY_INTERVAL_MS,
} from '../src/version';
import { parseVersionCache } from '../frontend/src/version-notice';

describe('update version policy', () => {
  it('uses the package version and keeps frontend/backend aligned', () => {
    expect(APP_VERSION).toBe(frontendVersion);
    expect(normalizeStableVersion(APP_VERSION)).toBe(APP_VERSION);
  });

  it.each([
    ['2.10.0', '2.9.9', true],
    ['3.0.0', '2.99.99', true],
    ['2.7.3', '2.7.2', true],
    ['v2.7.3', '2.7.2', true],
    ['2.7.2', '2.7.2', false],
    ['2.7.1', '2.7.2', false],
    ['2.7.2+build.2', '2.7.2+build.1', false],
    ['2.7.2', '2.7.2-rc.1', true],
    ['2.7.1', '2.7.2-rc.1', false],
    ['2.8.0-beta.1', '2.7.2', false],
    ['2.8.0', 'invalid', false],
    ['garbage', '2.7.2', false],
  ])('compares %s against %s → %s', (latest, current, expected) => {
    expect(isNewerStableVersion(latest, current)).toBe(expected);
  });

  it.each([
    null, undefined, 42, {}, '', '2.7', '02.7.2', '2.7.2\n', ' 2.7.2',
    '2.7.2-beta.1', '2.7.2-01', '9007199254740992.0.0', '1'.repeat(200),
    'https://evil.example/2.7.3', '<img src=x onerror=alert(1)>',
  ])('rejects invalid or prerelease metadata: %j', (value) => {
    expect(normalizeStableVersion(value)).toBeNull();
  });

  it('normalizes only stable version metadata', () => {
    expect(normalizeStableVersion('v2.10.3+build.5')).toBe('2.10.3');
  });
});

describe('browser update cache', () => {
  const now = 1_800_000_000_000;
  const cache = (latestVersion: unknown, age: number) => JSON.stringify({
    latestVersion, checkedAt: now - age,
  });

  it('caches successful checks for six hours', () => {
    expect(parseVersionCache(cache('2.8.0', VERSION_CHECK_INTERVAL_MS - 1), now)?.latestVersion).toBe('2.8.0');
    expect(parseVersionCache(cache('2.8.0', VERSION_CHECK_INTERVAL_MS), now)).toBeNull();
  });

  it('backs off unknown or failed checks for 15 minutes', () => {
    expect(parseVersionCache(cache(null, VERSION_RETRY_INTERVAL_MS - 1), now)?.latestVersion).toBeNull();
    expect(parseVersionCache(cache(null, VERSION_RETRY_INTERVAL_MS), now)).toBeNull();
  });

  it.each([null, '', '{', 'null', '[]', '{}', '42', '"hello"', 'x'.repeat(513)])('ignores corrupt storage: %j', (raw) => {
    expect(parseVersionCache(raw, now)).toBeNull();
  });

  it('rejects missing, noncanonical, prerelease and future-dated cache entries', () => {
    for (const raw of [
      JSON.stringify({ checkedAt: now }),
      JSON.stringify({ latestVersion: '2.8.0', checkedAt: 'now' }),
      cache('2.8.0-beta', 0), cache('v2.8.0', 0), cache('2.8.0', -1), cache({}, 0),
    ]) expect(parseVersionCache(raw, now)).toBeNull();
  });
});
