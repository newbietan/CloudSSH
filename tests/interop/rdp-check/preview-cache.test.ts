import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./preview-cache.mjs', import.meta.url));
const wasm = 'sdl-freerdp.rdp-bin';
const glue = 'sdl-freerdp.rdp-text';
const licenses = 'licenses.rdp-text';

function withCache(run: (fixture: ReturnType<typeof createFixture>) => void) {
  const fixture = createFixture();
  try { run(fixture); }
  finally { rmSync(fixture.root, { recursive: true, force: true }); }
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloudssh-preview-cache-'));
  const cache = join(root, 'cache');
  const desktop = join(root, 'desktop');
  mkdirSync(cache);
  mkdirSync(desktop);
  writeFileSync(join(cache, wasm), Buffer.from('0061736d01000000', 'hex'));
  writeFileSync(join(cache, glue), 'compiled client');
  writeFileSync(join(cache, licenses), 'licenses');
  writeFileSync(join(desktop, 'desktop.js'), 'script');
  writeFileSync(join(desktop, 'index.html'), 'original');
  return {
    root, cache, desktop,
    prepare: (mode: 'record' | 'stage', target: string) => spawnSync(
      process.execPath, [script, mode, cache, join(root, target), desktop], { encoding: 'utf8' }
    ),
  };
}

describe('test-only FreeRDP cache', () => {
  it('reuses verified compiled files but always packages the current page', () => {
    withCache(({ root, cache, desktop, prepare }) => {
      expect(prepare('record', 'first').status).toBe(0);
      expect(existsSync(join(cache, 'sha256.json'))).toBe(true);
      expect(existsSync(join(cache, 'index.rdp-text'))).toBe(false);
      writeFileSync(join(desktop, 'index.html'), 'updated');
      expect(prepare('stage', 'second').status).toBe(0);
      expect(readFileSync(join(root, 'second', 'index.rdp-text'), 'utf8')).toBe('updated');
      expect(readFileSync(join(root, 'second', glue), 'utf8')).toBe('compiled client');
    });
  });

  it('fails closed on a corrupt cache before staging any files', () => {
    withCache(({ root, cache, prepare }) => {
      expect(prepare('record', 'first').status).toBe(0);
      writeFileSync(join(cache, glue), 'altered client');
      const result = prepare('stage', 'corrupt');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('checksum mismatch');
      expect(existsSync(join(root, 'corrupt'))).toBe(false);
    });
  });

  it('refuses to record invalid WebAssembly', () => {
    withCache(({ cache, prepare }) => {
      writeFileSync(join(cache, wasm), 'not WASM');
      const result = prepare('record', 'invalid');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Invalid RDP preview WASM');
      expect(existsSync(join(cache, 'sha256.json'))).toBe(false);
    });
  });
});
