import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontendDir = path.join(rootDir, 'frontend');

describe('frontend production build', () => {
  it('preserves the xterm requestMode local declaration', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'cloudssh-vite-'));

    try {
      const frontendRequire = createRequire(path.join(frontendDir, 'package.json'));
      const viteEntry = frontendRequire.resolve('vite');
      const { build } = await import(pathToFileURL(viteEntry).href);
      const result = await build({
        root: frontendDir,
        configFile: path.join(frontendDir, 'vite.config.ts'),
        logLevel: 'silent',
        build: {
          outDir,
          write: false,
        },
      });

      const outputs = Array.isArray(result) ? result : [result];
      const bundle = outputs
        .flatMap((output) => ('output' in output ? output.output : []))
        .filter((item) => item.type === 'chunk')
        .map((item) => item.code)
        .join('\n');

      const implementations = [...bundle.matchAll(/requestMode\([^)]*\)\{/g)]
        .map((match) => bundle.slice(match.index, match.index + 500));
      const requestMode = implementations.find((code) => code.includes('NOT_RECOGNIZED'));

      expect(requestMode).toBeDefined();
      expect(requestMode).toMatch(/requestMode\([^)]*\)\{(?:let|var|const) [$\w]+;/);
      expect(requestMode).not.toMatch(/void 0\|\|\([$\w]+=\{\}\)/);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
