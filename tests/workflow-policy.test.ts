import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflowDir = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file));
const readWorkflow = (file: string) =>
  readFileSync(new URL(file, workflowDir), 'utf8').replace(/\r\n/g, '\n');
const readDeployJob = (name: string) =>
  readWorkflow('deploy.yml').split(`\n  ${name}:\n`)[1]?.split(/^  [\w-]+:\n/m)[0] ?? '';

describe('Fork 工作流执行策略', () => {
  // This source-level contract checks every job, including future workflows.
  // A step-level guard is too late: it would still allocate a runner/matrix.
  it.each(workflows.filter((file) => file !== 'sync-upstream.yml'))(
    '%s 的所有 job 仅在维护者仓库中执行',
    (file) => {
      const jobs = readWorkflow(file).split('\njobs:\n')[1] ?? '';
      const jobHeaders = jobs.match(/^  [\w-]+:$/gm) ?? [];
      const ownerGuards = jobs.match(/^    if: (?:>-\n      )?github\.repository_owner == 'newbietan'(?: &&[^\n]*)?$/gm) ?? [];
      expect(jobHeaders.length).toBeGreaterThan(0);
      expect(ownerGuards).toHaveLength(jobHeaders.length);
    }
  );

  it('builds exactly once in each deploying job, without injecting secrets into the build', () => {
    const deploy = readWorkflow('deploy.yml');
    for (const job of [readDeployJob('validate-test'), readDeployJob('deploy-production')]) {
      expect(job.match(/run: pnpm run build:frontend/g)).toHaveLength(1);
      expect(job.match(/run: pnpm exec wrangler deploy(?: --env test)?$/gm)).toHaveLength(1);
      const build = job.indexOf('run: pnpm run build:frontend');
      const deployStep = job.indexOf('      - name: Deploy verified artifact');
      expect(build).toBeLessThan(deployStep);
      expect(job.slice(0, deployStep)).not.toContain('secrets.');
      expect(job.slice(deployStep)).toContain('secrets.CLOUDFLARE_API_TOKEN');
      expect(job.slice(deployStep)).toContain('secrets.CLOUDFLARE_ACCOUNT_ID');
    }
    expect(deploy).not.toContain('run: pnpm run deploy');
    expect(deploy).not.toMatch(/^\s*continue-on-error:\s*true/m);
    expect(deploy).not.toMatch(/run: pnpm run test:e2e[^\n]*\|\|/);
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
  it('test 分支保留全量验证，main PR 和手动触发只做内容核验，不部署', () => {
    const deploy = readWorkflow('deploy.yml');
    expect(deploy).toContain('  pull_request:\n    branches: [test, main]');
    expect(deploy).toMatch(/^  workflow_dispatch:$/m);
    expect(deploy).not.toContain('pull_request_target');
    const validate = readDeployJob('validate-test');
    expect(validate).toContain("(github.event_name == 'pull_request' && github.base_ref == 'test')");
    expect(validate).toContain("((github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/test')");
    for (const command of ['typecheck', 'test:e2e', 'build:frontend']) {
      expect(validate).toContain(`run: pnpm run ${command}`);
    }
    expect(validate).toContain('run: pnpm test');
    expect(validate).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/test'");
    const verify = readDeployJob('verify-production');
    expect(verify).toContain("(github.event_name == 'pull_request' && github.base_ref == 'main')");
    expect(verify).toContain("((github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main')");
    expect(verify).toContain('actions: read');
    expect(verify).toContain('GH_TOKEN: ${{ github.token }}');
    expect(verify).toContain("WAIT_TEST_HEAD: ${{ github.event_name == 'pull_request' && github.head_ref == 'test' && github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.head.sha || '' }}");
    expect(verify).toContain('run: node scripts/ci-verify-tested-release.mjs');
    expect(verify).not.toMatch(/secrets\.|wrangler deploy|pnpm|always\(\)|continue-on-error/);
    // Checkout must use the current workflow event SHA (PR merge result), not PR head.
    expect(verify).not.toContain('\n          ref:');
    const production = readDeployJob('deploy-production');
    expect(production).toContain('needs: verify-production');
    expect(production).toMatch(/^    if: github\.repository_owner == 'newbietan' && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m);
    expect(production).toContain('pnpm install --frozen-lockfile');
    expect(production).not.toMatch(/playwright|pnpm test|typecheck|test:e2e|always\(\)/i);
  });

  it('aligns test only after a proven main push deploy with an isolated repository token', () => {
    const deploy = readWorkflow('deploy.yml');
    const sync = readDeployJob('sync-released-test');
    const verify = readDeployJob('verify-production');
    expect(verify).toContain('tested_sha: ${{ steps.proof.outputs.tested_sha }}');
    expect(verify).toContain('id: proof');
    expect(readFileSync(new URL('../scripts/ci-verify-tested-release.mjs', import.meta.url), 'utf8'))
      .toContain('`tested_sha=${result.testCommit}\\n`');
    expect(sync).toContain('needs: [verify-production, deploy-production]');
    expect(sync).toContain("github.repository == 'newbietan/CloudSSH' &&");
    expect(sync).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(sync).toContain('contents: write\n      pull-requests: read');
    expect(deploy.match(/contents: write/g)).toHaveLength(1);
    expect(sync).toContain('ref: ${{ github.sha }}\n          persist-credentials: false');
    expect(sync).toContain('GH_TOKEN: ${{ github.token }}');
    expect(sync).toContain('TESTED_SHA: ${{ needs.verify-production.outputs.tested_sha }}');
    expect(sync).toContain('run: node scripts/ci-sync-released-test.mjs');
    expect(sync).not.toMatch(/secrets\.|pull_request_target|always\(\)|continue-on-error|wrangler|pnpm/);
  });

  it('retires the RDP preview and keeps the standard deployment free of compiler steps', () => {
    const deploy = readWorkflow('deploy.yml');
    expect(deploy).not.toMatch(/CLOUDSSH_RDP_TEST_CONFIG|preview-worker\.ts|prepare-preview\.sh|build-freerdp\.sh/);
  });

  it('runs both manual FreeRDP build phases as the host owner of the disposable checkout', () => {
    const script = readFileSync(
      new URL('../scripts/build-freerdp.sh', import.meta.url), 'utf8'
    );
    expect(script.match(/docker run\b/g)).toHaveLength(1);
    expect(script).toContain('docker run --rm --user "$(id -u):$(id -g)"');
    expect(script).toContain('-e HOME=/src/.cloudssh-build-home');
    expect(script).toContain('-e EM_CACHE=/src/.cloudssh-build-home/emscripten-cache');
    expect(script).toMatch(/run_sdk bash -euc '[^\n]*--no-build/);
    expect(script).toMatch(/run_sdk bash -euc '[\s\S]*?bash -e scripts\/emscripten\.sh --no-clone/);
    expect(script).not.toContain('chmod -R');
  });

  it('测试档位不跳过类型检查、单测、构建或部署前打包', () => {
    const deploy = readWorkflow('deploy.yml');
    for (const [name, command] of [
      ['Type check', 'pnpm run typecheck'],
      ['Unit and integration tests', 'pnpm test'],
      ['Build frontend', 'pnpm run build:frontend'],
    ]) {
      expect(deploy).toContain(`      - name: ${name}\n        run: ${command}\n`);
    }
    const installChromium = deploy.split('      - name: Install Playwright Chromium (reduced test profile)\n')[1]?.split('      - name:')[0] ?? '';
    expect(installChromium).toContain("if: steps.e2e-profile.outputs.profile == 'chromium'");
    expect(installChromium).toContain('run: pnpm exec playwright install --with-deps chromium\n');
    expect(deploy).toContain('fetch-depth: 2');
    expect(deploy).not.toContain('CLOUDSSH_TEST_E2E');
    expect(deploy).toContain('run: node scripts/ci-test-e2e.mjs');
    expect(readWorkflow('ssh-interop.yml')).not.toContain('CLOUDSSH_TEST_E2E');
  });

  it('将完整浏览器安装放在快速检查和构建之后', () => {
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
    expect(readDeployJob('validate-test')).toContain('timeout-minutes: 30');
    expect(readDeployJob('verify-production')).toContain("timeout-minutes: ${{ github.event_name == 'pull_request' && 65 || 5 }}");
    expect(readDeployJob('deploy-production')).toContain('timeout-minutes: 10');
    const pages = readWorkflow('github-pages.yml');
    expect(pages).toContain('    concurrency:\n      group: cloudssh-pages\n      cancel-in-progress: false');
    expect(pages).toContain('timeout-minutes: 10');
    expect(pages).toContain('persist-credentials: false');
  });

  it('Pages 只在 main 静态站点文件改变时自动发布，允许 main 手动发布', () => {
    const pages = readWorkflow('github-pages.yml');
    expect(pages.split('\n\njobs:')[0]).toContain(
      '  push:\n    branches: [main]\n    paths:\n      - "docs/index.html"\n      - "docs/theme-editor/**"\n  workflow_dispatch:'
    );
    expect(pages).not.toContain('"docs/**"');
    expect(pages).toMatch(/^    if: github\.repository_owner == 'newbietan' && github\.ref == 'refs\/heads\/main'$/m);
    expect(pages).toContain('cp docs/index.html');
    expect(pages).toContain('cp -R docs/theme-editor');
    expect(pages).not.toContain('path: "docs"');
    expect(pages).toContain('name: github-pages');
  });

  it('Pages 先确认本次尝试的产物可见，再执行唯一的部署步骤', () => {
    const pages = readWorkflow('github-pages.yml');
    const step = (action: string) => pages.split(`uses: actions/${action}@`)[1]?.split('\n      - ')[0] ?? '';
    expect(pages).toContain('PAGES_ARTIFACT_NAME: github-pages-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(step('upload-pages-artifact')).toContain('          name: ${{ env.PAGES_ARTIFACT_NAME }}');
    expect(step('deploy-pages')).toContain('          artifact_name: ${{ env.PAGES_ARTIFACT_NAME }}');
    expect(pages).toContain('actions: read');
    expect(pages).toContain('PAGES_ARTIFACT_ID: ${{ steps.upload.outputs.artifact_id }}');
    const wait = pages.indexOf('run: bash scripts/ci-wait-pages-artifact.sh');
    expect(wait).toBeGreaterThan(pages.indexOf('uses: actions/upload-pages-artifact@'));
    expect(wait).toBeLessThan(pages.indexOf('uses: actions/deploy-pages@'));
    expect(pages.match(/uses: actions\/deploy-pages@/g)).toHaveLength(1);
    expect(pages).not.toMatch(/always\(\)|continue-on-error/);
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
    expect(deploy).toContain("id: e2e\n        if: steps.e2e-profile.outputs.profile != 'skip' && steps.e2e-profile.outputs.profile != 'chromium'\n        run: pnpm run test:e2e\n");
    expect(deploy).toContain("id: e2e-chromium\n        if: steps.e2e-profile.outputs.profile == 'chromium'\n        run: pnpm run test:e2e --project=chromium");
    expect(upload).toContain('!cancelled()');
    for (const id of ['e2e', 'e2e-chromium']) {
      expect(upload).toContain(`steps.${id}.outcome == 'success'`);
      expect(upload).toContain(`steps.${id}.outcome == 'failure'`);
    }
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
