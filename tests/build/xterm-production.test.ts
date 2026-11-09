import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontendDir = path.join(rootDir, 'frontend');

describe('frontend production build', () => {
  let outDir: string;
  let bundle = '';
  let css = '';
  let emittedAssetNames: string[] = [];
  let shouldInlineFont: (filePath: string, content: Buffer) => boolean | undefined;

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'cloudssh-vite-'));
    const frontendRequire = createRequire(path.join(frontendDir, 'package.json'));
    const viteEntry = frontendRequire.resolve('vite');
    const { build, loadConfigFromFile } = await import(pathToFileURL(viteEntry).href);
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      path.join(frontendDir, 'vite.config.ts')
    );
    shouldInlineFont = loaded?.config.build?.assetsInlineLimit;
    if (typeof shouldInlineFont !== 'function') throw new Error('Missing explicit font inline policy');
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
    const items = outputs.flatMap((output) => ('output' in output ? output.output : []));
    emittedAssetNames = items.map((item) => item.fileName);
    bundle = items
      .filter((item) => item.type === 'chunk')
      .map((item) => item.code)
      .join('\n');
    css = items
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => String(item.source))
      .join('\n');
  }, 60_000);

  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  it('inlines both local fonts for the single-HTML Worker without external font requests', () => {
    expect([...css.matchAll(/data:font\/woff2;base64,/g)]).toHaveLength(2);
    expect(css).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/);
    expect(css).not.toMatch(/url\(["']?(?!data:)[^)]*\.woff2/);
    expect(emittedAssetNames.filter((name) => /\.woff2?$/.test(name))).toEqual([]);
    expect(css).toMatch(/font-family:["']?Material Symbols Outlined/);
  });

  it('forces only the two Worker fonts inline even above the old 100KiB threshold', () => {
    const largeAsset = Buffer.alloc(256 * 1024);
    for (const filename of ['material-symbols-outlined-subset.woff2', 'jetbrains-mono.woff2']) {
      expect(shouldInlineFont(path.join(frontendDir, 'src/assets/fonts', filename), largeAsset)).toBe(true);
    }
    expect(shouldInlineFont(path.join(frontendDir, 'src/assets/large-image.png'), largeAsset)).toBeUndefined();
    expect(shouldInlineFont(path.join(frontendDir, 'src/assets/fonts/other.woff2'), largeAsset)).toBeUndefined();
  });

  it('preserves the xterm requestMode local declaration', () => {
    const implementations = [...bundle.matchAll(/requestMode\([^)]*\)\{/g)].map((match) =>
      bundle.slice(match.index, match.index + 500)
    );
    const requestMode = implementations.find((code) => code.includes('NOT_RECOGNIZED'));

    expect(requestMode).toBeDefined();
    expect(requestMode).toMatch(/requestMode\([^)]*\)\{(?:let|var|const) [$\w]+;/);
    expect(requestMode).not.toMatch(/void 0\|\|\([$\w]+=\{\}\)/);
  });

  it('bundles Tailwind utilities and plugins without the runtime CDN', async () => {
    const html = await readFile(path.join(frontendDir, 'index.html'), 'utf8');

    expect(html).not.toContain('cdn.tailwindcss.com');
    expect(html).not.toMatch(/\btailwind\.config\s*=/);
    expect(css).toContain('.bg-background');
    expect(css).toContain('background-color:var(--bg)');
    expect(css).toContain('.text-primary-container');
    expect(css).toContain('.md\\:grid-cols-2');
    expect(css).toContain('input:where([type=text])');
  });
});
