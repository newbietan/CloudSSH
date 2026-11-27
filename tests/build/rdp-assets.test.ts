import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { RDP_CLIENT_REVISION, RDP_CONNECT_REVISION } from '../../src/rdp-schema';

const root = new URL('../../src/worker/rdp-client/vendor/', import.meta.url);
const asset = (file: string) => readFileSync(new URL(file, root));
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const upstream = 'https://github.com/FreeRDP/FreeRDP';

describe('bundled FreeRDP client', () => {
  it.each(['README.md', 'README_en.md'])('%s credits the upstream repository', (file) => {
    const readme = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    expect(readme).toContain(`[FreeRDP](${upstream})`);
  });

  it('requires the new connect-only ABI without rotating trust or peer renewal', () => {
    const bootstrap = asset('../desktop.rdp-text').toString();
    expect(bootstrap).toContain(`const clientRevision = '${RDP_CLIENT_REVISION}'`);
    expect(bootstrap).toContain(`const connectRevision = '${RDP_CONNECT_REVISION}'`);
    expect(RDP_CONNECT_REVISION).toBeGreaterThan(5);
  });

  it('ships one valid compressed WASM, bounded bytes, and matching digests and source notice', () => {
    const glue = asset('sdl-freerdp.rdp-text');
    const wasm = asset('sdl-freerdp-gzip.rdp-bin');
    const licenses = asset('licenses.rdp-text');
    const raw = gunzipSync(wasm, { maxOutputLength: 24 * 1024 * 1024 });
    expect(wasm.length).toBeLessThan(5 * 1024 * 1024);
    expect(WebAssembly.validate(raw)).toBe(true);
    expect(JSON.parse(asset('sha256.json').toString())).toEqual({
      glue: sha(glue), wasm: sha(wasm), licenses: sha(licenses),
    });
    expect(JSON.parse(asset('client-tags.rdp-text').toString())).toEqual([sha(glue), sha(raw)]);
    expect(licenses.toString()).toContain(
      `${upstream}/tree/65bcca1913a28cbdd7eb913599f692bd2b707991`,
    );
    expect(glue.toString()).toContain('Module["createRdpSocket"](url)');
    expect(glue.toString()).toContain('.socket.consumed(bytesRead)');
    expect(glue.toString()).toContain('pthreadPoolSize=4;');
    for (const hook of ['onWindowsDisplayControl', 'onWindowsFirstFrame', 'onWindowsCertificate', '_cloudssh_take_rdp_rtt']) {
      expect(glue.toString()).toContain(hook);
    }
  });
});
