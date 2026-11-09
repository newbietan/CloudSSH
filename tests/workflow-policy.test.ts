import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflowDir = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file));
const readWorkflow = (file: string) =>
  readFileSync(new URL(file, workflowDir), 'utf8').replace(/\r\n/g, '\n');

describe('Fork 工作流执行策略', () => {
  // This source-level contract checks every job, including future workflows.
  // A step-level guard is too late: it would still allocate a runner/matrix.
  it.each(workflows.filter((file) => file !== 'sync-upstream.yml'))(
    '%s 的所有 job 仅在维护者仓库中执行',
    (file) => {
      const jobs = readWorkflow(file).split('\njobs:\n')[1] ?? '';
      const jobHeaders = jobs.match(/^  [\w-]+:$/gm) ?? [];
      const ownerGuards = jobs.match(/^    if: github\.repository_owner == 'newbietan'$/gm) ?? [];
      expect(jobHeaders.length).toBeGreaterThan(0);
      expect(ownerGuards).toHaveLength(jobHeaders.length);
    }
  );

  it('deploys the already-tested frontend artifact without rebuilding it with deployment secrets', () => {
    const deploy = readWorkflow('deploy.yml');
    expect(deploy.match(/run: pnpm run build:frontend/g)).toHaveLength(1);
    expect(deploy.match(/run: pnpm exec wrangler deploy(?: --env test)?$/gm)).toHaveLength(2);
    expect(deploy).not.toContain('run: pnpm run deploy');
    expect(deploy.indexOf('run: pnpm run test:e2e')).toBeLessThan(
      deploy.indexOf('run: pnpm exec wrangler deploy')
    );
    expect(deploy).not.toMatch(/^\s*continue-on-error:\s*true/m);
    expect(deploy).not.toMatch(/run: pnpm run test:e2e[^\n]*\|\|/);
    expect(
      deploy.match(/^        if: github.ref == 'refs\/heads\/(?:test|main)'$/gm)
    ).toHaveLength(2);
  });

  it('Fork 可直接手动同步，定时同步需要显式开启', () => {
    const sync = readWorkflow('sync-upstream.yml');
    expect(sync).toMatch(/^  workflow_dispatch:$/m);
    expect(sync).toMatch(/^  schedule:$/m);
    expect(sync).toContain(
      `    if: >-
      github.event.repository.fork == true &&
      (github.event_name == 'workflow_dispatch' || vars.AUTO_SYNC_UPSTREAM == 'true')
`
    );
    expect(sync).toContain('"repos/${REPOSITORY}/merge-upstream"');
    expect(sync).toContain('-f branch=main');
    expect(sync).not.toContain('secrets.');
  });
});

describe('浏览器 CI 并发与报告策略', () => {
  const config = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');

  it('CI 使用两个 worker，保留浏览器项目及原重试策略', () => {
    expect(config).toMatch(/workers:\s*process\.env\.CI\s*\?\s*2\s*:\s*undefined/);
    expect(config).toMatch(/fullyParallel:\s*true/);
    expect(config).toMatch(/retries:\s*process\.env\.CI\s*\?\s*2\s*:\s*0/);
    expect(config).toContain("name: 'chromium'");
    expect(config).toContain("name: 'webkit-mobile'");
  });

  it('提供 HTML/JSON 报告，不增加全程 trace 或截图', () => {
    expect(config).toContain("['github']");
    expect(config).toContain("['html', { open: 'never' }]");
    expect(config).toContain("['json', { outputFile: 'test-results/results.json' }]");
    expect(config).toContain("trace: 'on-first-retry'");
    expect(config).toContain("screenshot: 'only-on-failure'");
  });

  it('实际执行的 E2E 成功或失败时上传报告七天，取消或未执行时不上传', () => {
    const deploy = readWorkflow('deploy.yml');
    const uploadHeader = '      - name: Upload browser test reports\n';
    const upload = deploy.split(uploadHeader)[1]?.split('\n      - name:')[0] ?? '';
    expect(deploy).toContain('          persist-credentials: false');
    expect(deploy).toContain('        id: e2e\n        run: pnpm run test:e2e');
    expect(upload).toContain(`if: \${{ !cancelled() && steps.e2e.outcome != 'skipped' }}`);
    expect(upload).toMatch(/uses: actions\/upload-artifact@[a-f0-9]{40} /);
    expect(upload).toContain(
      `name: playwright-report-\${{ github.ref_name }}-\${{ github.run_attempt }}`
    );
    expect(upload).toContain('path: |\n            playwright-report/\n            test-results/');
    expect(upload).toContain('retention-days: 7');
    expect(upload).toContain('if-no-files-found: warn');
    expect(deploy.indexOf(uploadHeader)).toBeGreaterThan(deploy.indexOf('run: pnpm run test:e2e'));
    expect(deploy.indexOf(uploadHeader)).toBeLessThan(deploy.indexOf('env:\n          CLOUDFLARE'));
  });
});
