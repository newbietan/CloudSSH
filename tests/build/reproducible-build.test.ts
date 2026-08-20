import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as {
  packageManager?: string;
  devDependencies: Record<string, string>;
};
const buildScript = readFileSync(new URL('../../scripts/build-html.js', import.meta.url), 'utf8');
const deployWorkflow = readFileSync(
  new URL('../../.github/workflows/deploy.yml', import.meta.url),
  'utf8'
);

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
