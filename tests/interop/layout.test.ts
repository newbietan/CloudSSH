import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const interopDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(interopDir, '../..');

// These checks run without Go/OpenSSH so normal pnpm test guards the layout too.
describe('test-only Go workspace layout', () => {
  it('keeps the Go workspace and dependency files under interoperability tests', () => {
    expect(existsSync(resolve(rootDir, 'go.work'))).toBe(false);
    expect(existsSync(resolve(rootDir, 'go.work.sum'))).toBe(false);
    for (const file of ['go.work', 'go.work.sum', 'gateway/go.mod', 'gateway/go.sum']) {
      expect(existsSync(resolve(interopDir, file)), file).toBe(true);
    }
  });

  it('resolves the workspace module relative to the interoperability directory', () => {
    const workspace = readFileSync(resolve(interopDir, 'go.work'), 'utf8');
    const modulePath = workspace.match(/^use\s+(\S+)\s*$/m)?.[1];
    expect(modulePath).toBe('./gateway');
    if (!modulePath) throw new Error('Missing test gateway module in Go workspace');
    const moduleFile = resolve(interopDir, modulePath, 'go.mod');
    expect(readFileSync(moduleFile, 'utf8')).toMatch(/^module cloudssh\.test\/interop-gateway$/m);
  });

  it('covers the relocated Go workspace in push and pull-request CI filters', () => {
    const workflow = readFileSync(resolve(rootDir, '.github/workflows/ssh-interop.yml'), 'utf8');
    expect(workflow.match(/^\s+- 'tests\/interop\/\*\*'$/gm)).toHaveLength(2);
    expect(workflow).not.toMatch(/^\s+- 'go\.work(?:\.sum)?'$/m);
  });
});
