import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/ci-test-e2e.mjs', import.meta.url));

function profile(event: string, ref: string, requested: string) {
  const temp = mkdtempSync(join(tmpdir(), 'cloudssh-e2e-profile-'));
  try {
    const output = join(temp, 'out');
    const summary = join(temp, 'summary');
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        GITHUB_REF: ref,
        TEST_E2E_PROFILE: requested,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    return {
      output: readFileSync(output, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
      warning: result.stderr,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe('CI browser scope selection', () => {
  it.each([['', 'full'], ['full', 'full'], ['chromium', 'chromium'], ['skip', 'skip']])(
    '%j requests %s only for a test push',
    (requested, selected) => {
      const result = profile('push', 'refs/heads/test', requested);
      expect(result.output).toBe(`profile=${selected}\n`);
      expect(result.summary).toContain('Browser validation:');
      expect(result.warning).toBe('');
      if (selected === 'skip') expect(result.summary).toContain('not run');
      if (selected === 'chromium') expect(result.summary).toContain('mobile WebKit not run');
    }
  );

  it.each([
    ['push', 'refs/heads/main'],
    ['push', 'refs/heads/other'],
    ['pull_request', 'refs/pull/201/merge'],
    ['pull_request', 'refs/heads/test'],
    ['workflow_dispatch', 'refs/heads/test'],
  ])('always runs full browser checks for %s %s', (event, ref) => {
    for (const requested of ['skip', 'chromium']) {
      expect(profile(event, ref, requested).output).toBe('profile=full\n');
    }
  });

  it('warns without logging an unknown value and fails closed to full', () => {
    const injected = 'skip\nprofile=skip';
    const result = profile('push', 'refs/heads/test', injected);
    expect(result.output).toBe('profile=full\n');
    expect(result.warning).toContain('::warning::');
    expect(result.warning).not.toContain(injected);
  });
});
