import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const root = new URL('../../src/worker/rdp-client/vendor/', import.meta.url);
const asset = (file: string) => readFileSync(new URL(file, root));
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

describe('bundled FreeRDP client', () => {
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
    expect(licenses.toString()).toContain('65bcca1913a28cbdd7eb913599f692bd2b707991');
    expect(glue.toString()).toContain('Module["createRdpSocket"](url)');
    expect(glue.toString()).toContain('.socket.consumed(bytesRead)');
    expect(glue.toString()).toContain('pthreadPoolSize=4;');
    for (const hook of ['onWindowsDisplayControl', 'onWindowsFirstFrame', 'onWindowsCertificate', '_cloudssh_take_rdp_rtt']) {
      expect(glue.toString()).toContain(hook);
    }
  });
});
