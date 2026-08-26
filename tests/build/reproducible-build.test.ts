import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 以测试文件本身为锚点解析仓库相对路径（workers-types 的全局 URL 与 node:url.URL
// 存在类型差异，这里统一走 fileURLToPath + path.join，避免跨类型使用）。
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRootFile = (relative: string): string =>
  readFileSync(join(rootDir, relative), 'utf8');

const packageJson = JSON.parse(readRootFile('package.json')) as {
  packageManager?: string;
  devDependencies: Record<string, string>;
};
const buildScript = readRootFile('scripts/build-html.js');
const deployWorkflow = readRootFile('.github/workflows/deploy.yml');

describe('reproducible build and deployment gate', () => {
  it('pins the package manager and matching Vitest packages', () => {
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(packageJson.devDependencies.vitest).toBe(
      packageJson.devDependencies['@vitest/coverage-v8']
    );
  });

  it('keeps dependency installation outside the frontend build', () => {
    expect(buildScript).not.toMatch(/pnpm['", ]+install|npx pnpm install/);
    expect(buildScript).toContain('Expected exactly one JS and one CSS bundle');
  });

  it('requires frozen installs, type checks, tests, build and E2E before deploy', () => {
    const installIndex = deployWorkflow.indexOf('pnpm install --frozen-lockfile');
    const typecheckIndex = deployWorkflow.indexOf('pnpm run typecheck');
    const testIndex = deployWorkflow.indexOf('pnpm test');
    const buildIndex = deployWorkflow.indexOf('pnpm run build:frontend');
    const e2eIndex = deployWorkflow.indexOf('pnpm run test:e2e');
    const deployIndex = deployWorkflow.indexOf('pnpm run deploy:test');

    const steps = [installIndex, typecheckIndex, testIndex, buildIndex, e2eIndex, deployIndex];
    expect(steps.every((index) => index >= 0)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });
});
