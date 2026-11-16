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
      deploy.match(/^        if: github.event_name == 'push' && github.ref == 'refs\/heads\/(?:test|main)'$/gm)
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

describe('CI 验证和部署边界', () => {
  it('PR 和手动执行都经过完整验证，但部署步骤仅允许 test/main 的 push', () => {
    const deploy = readWorkflow('deploy.yml');
    expect(deploy).toContain('  pull_request:\n    branches: [test, main]');
    expect(deploy).toMatch(/^  workflow_dispatch:$/m);
    expect(deploy).not.toContain('pull_request_target');
    for (const command of ['typecheck', 'test:e2e', 'build:frontend']) {
      expect(deploy).toContain(`run: pnpm run ${command}`);
    }
    expect(deploy).toContain('run: pnpm test');
    const sections = deploy.split('      - name: Deploy verified artifact').slice(1);
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(section).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/");
      expect(section).toContain('CLOUDFLARE_API_TOKEN:');
    }
    expect(deploy.slice(0, deploy.indexOf('      - name: Deploy verified artifact'))).not.toContain('secrets.');
  });

  it('将昂贵浏览器安装放在快速检查和构建之后，保留全部浏览器', () => {
    const deploy = readWorkflow('deploy.yml');
    const browsers = deploy.indexOf('run: pnpm exec playwright install --with-deps chromium webkit');
    expect(browsers).toBeGreaterThan(deploy.indexOf('run: pnpm run typecheck'));
    expect(browsers).toBeGreaterThan(deploy.indexOf('run: pnpm test'));
    expect(browsers).toBeGreaterThan(deploy.indexOf('run: pnpm run build:frontend'));
    expect(browsers).toBeLessThan(deploy.indexOf('run: pnpm run test:e2e'));
  });

  it('只取消过期 PR 校验，不中途取消 Worker 或 Pages 部署，并限制 job 时长', () => {
    const deploy = readWorkflow('deploy.yml');
    expect(deploy).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(deploy).toContain('timeout-minutes: 30');
    const pages = readWorkflow('github-pages.yml');
    expect(pages).toContain('group: cloudssh-pages\n  cancel-in-progress: false');
    expect(pages).toContain('timeout-minutes: 10');
    expect(pages).toContain('persist-credentials: false');
  });

  it('互操作 push/PR 均覆盖 MCP 和共享传输的相关变更', () => {
    const interop = readWorkflow('ssh-interop.yml');
    expect(interop).toContain('  pull_request:\n    branches: [test, main]');
    const triggers = interop.split('\n# This workflow')[0];
    for (const path of ['src/worker/mcp-*.ts', 'src/mcp-schema.ts', 'src/worker/direct-tcpip-stream.ts',
      'src/worker/tunnel-stream.ts', 'src/worker/dns-check.ts', 'src/worker/agent/exec-channel.ts',
      'src/types.ts', 'tests/worker/mcp*.test.ts', 'pnpm-workspace.yaml']) {
      expect(triggers.split(`'${path}'`)).toHaveLength(3);
    }
    expect(interop).toContain('cancel-in-progress: true');
    expect(interop).toContain('os: [ubuntu-24.04, macos-15]');
    expect(interop).not.toContain('secrets.');
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
      `name: playwright-report-\${{ github.run_id }}-\${{ github.run_attempt }}`
    );
    expect(upload).toContain('path: |\n            playwright-report/\n            test-results/');
    expect(upload).toContain('retention-days: 7');
    expect(upload).toContain('if-no-files-found: warn');
    expect(deploy.indexOf(uploadHeader)).toBeGreaterThan(deploy.indexOf('run: pnpm run test:e2e'));
    expect(deploy.indexOf(uploadHeader)).toBeLessThan(deploy.indexOf('env:\n          CLOUDFLARE'));
  });
});
