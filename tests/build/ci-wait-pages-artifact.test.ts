import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/ci-wait-pages-artifact.sh', import.meta.url));
const good = '909 github-pages-123-2 123 false';

function run(responses: string[], overrides: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cloudssh-pages-artifact-'));
  try {
    const log = join(dir, 'calls');
    writeFileSync(log, '');
    const executables = {
      timeout: '#!/bin/bash\nshift\nexec "$@"\n',
      sleep: '#!/bin/bash\nexit 0\n',
      gh: `#!/bin/bash
printf '%s\\n' "$*" >> "$CALL_LOG"
index=$(wc -l < "$CALL_LOG" | tr -d ' ')
line=$(awk -v n="$index" 'NR == n {print; exit}' "$FIXTURE_RESPONSES")
if [[ -z "$line" || "$line" == '404' ]]; then exit 1; fi
printf '%s\\n' "$line"
`,
    };
    for (const [name, contents] of Object.entries(executables)) {
      writeFileSync(join(dir, name), contents, { mode: 0o700 });
    }
    const fixture = join(dir, 'responses');
    writeFileSync(fixture, responses.join('\n') + '\n');
    const result = spawnSync('bash', [script], {
      encoding: 'utf8', timeout: 5_000,
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'newbietan/CloudSSH', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
        PAGES_ARTIFACT_ID: '909', PAGES_ARTIFACT_NAME: 'github-pages-123-2',
        CALL_LOG: log, FIXTURE_RESPONSES: fixture, ...overrides,
      },
    });
    return { ...result, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Pages artifact visibility guard', () => {
  it('returns immediately once the current upload is visible', () => {
    const result = run([good]);
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain('api --method GET repos/newbietan/CloudSSH/actions/artifacts/909');
  });

  it('retries a missing or wrong artifact and accepts only the exact current upload', () => {
    const result = run([
      '404', '909 github-pages-123-1 123 false', '908 github-pages-123-2 123 false',
      '909 github-pages-123-2 321 false', '909 github-pages-123-2 123 true', good,
    ]);
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(6);
  });

  it('fails after a bounded number of reads rather than proceeding to deployment', () => {
    const result = run([...Array(8).fill('404'), good]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not expose the current Pages artifact in time');
    expect(result.calls).toHaveLength(8);
  });

  it.each([{ PAGES_ARTIFACT_ID: '' }, { PAGES_ARTIFACT_NAME: 'github-pages-123-1' }])(
    'rejects invalid upload metadata before querying GitHub: %j', overrides => {
      const result = run([good], overrides);
      expect(result.status).toBe(1);
      expect(result.calls).toHaveLength(0);
    }
  );
});
