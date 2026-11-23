import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const selector = fileURLToPath(new URL('../../scripts/ci-test-e2e.mjs', import.meta.url));
const pushScript = fileURLToPath(new URL('../../scripts/push-test.sh', import.meta.url));
const title = 'ci: 设置本次 test 推送的浏览器测试';

function fixture(run: (dir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'cloudssh-e2e-profile-'));
  try {
    git(root, 'init', '-q', '-b', 'test');
    git(root, 'config', 'user.name', 'CloudSSH Test');
    git(root, 'config', 'user.email', 'ci@example.com');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'app.txt'), 'original');
    git(root, 'add', 'app.txt');
    git(root, 'commit', '-qm', 'Initial');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function profile(cwd: string, event = 'push', ref = 'refs/heads/test') {
  const output = join(cwd, '.git', 'e2e-output');
  const summary = join(cwd, '.git', 'e2e-summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const result = spawnSync(process.execPath, [selector], {
    cwd,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: ref,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      TEST_E2E_PROFILE: 'skip', // The retired variable cannot change CI, even if still set.
    },
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return {
    output: readFileSync(output, 'utf8'),
    summary: readFileSync(summary, 'utf8'),
  };
}

function marker(cwd: string, value: string) {
  git(cwd, 'commit', '-q', '--allow-empty', '-m', title, '-m', `CloudSSH-Test-E2E: ${value}`);
}

describe('CI browser scope selection', () => {
  it.each(['chromium', 'skip'])('accepts an exact one-off marker for %s on test', (selected) => {
    fixture((cwd) => {
      expect(profile(cwd).output).toBe('profile=full\n');
      marker(cwd, selected);
      const result = profile(cwd);
      expect(result.output).toBe(`profile=${selected}\n`);
      expect(result.summary).toContain('not run');
      git(cwd, 'commit', '-qm', 'A subsequent normal push', '--allow-empty');
      expect(profile(cwd).output).toBe('profile=full\n');
    });
  });

  it('ignores even valid markers on main pushes, PRs, and manual checks', () => {
    fixture((cwd) => {
      marker(cwd, 'skip');
      for (const [event, ref] of [
        ['push', 'refs/heads/main'],
        ['pull_request', 'refs/pull/201/merge'],
        ['workflow_dispatch', 'refs/heads/test'],
      ]) expect(profile(cwd, event, ref).output).toBe('profile=full\n');
    });
  });

  it('ignores malformed markers and matching messages on commits with file changes', () => {
    fixture((cwd) => {
      marker(cwd, 'skip\nCloudSSH-Test-E2E: chromium');
      expect(profile(cwd).output).toBe('profile=full\n');
      writeFileSync(join(cwd, 'app.txt'), 'changed');
      git(cwd, 'add', 'app.txt');
      marker(cwd, 'skip');
      expect(profile(cwd).output).toBe('profile=full\n');
    });
  });

  it('pushes an empty opt-in marker without changing the actual work commit', () => {
    fixture((cwd) => {
      const remote = join(cwd, '.git', 'remote');
      git(cwd, 'init', '-q', '--bare', remote);
      git(cwd, 'remote', 'add', 'origin', remote);
      git(cwd, 'push', '-q', 'origin', 'test');
      const unchanged = spawnSync('bash', [pushScript, '--e2e=skip'], { cwd });
      expect(unchanged.status).not.toBe(0);
      writeFileSync(join(cwd, 'app.txt'), 'next commit');
      git(cwd, 'commit', '-qam', 'Actual changes');
      const codeCommit = git(cwd, 'rev-parse', 'HEAD');
      expect(spawnSync('bash', [pushScript, '--e2e=skip'], { cwd, encoding: 'utf8' }).status).toBe(0);
      expect(git(cwd, 'rev-parse', 'HEAD^')).toBe(codeCommit);
      expect(git(cwd, 'diff', 'HEAD^', 'HEAD', '--')).toBe('');
      expect(git(remote, 'rev-parse', 'refs/heads/test')).toBe(git(cwd, 'rev-parse', 'HEAD'));
      expect(profile(cwd).output).toBe('profile=skip\n');
    });
  });
});
