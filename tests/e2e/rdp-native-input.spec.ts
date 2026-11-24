import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test } from './fixtures';

// Actual pthreads/WASM require cross-origin isolation. The mobile WebKit suite uses the
// SDL stub for workspace gestures; this Chromium case checks the native preferences ABI.
test('the bundled SDL client reads the no-hotkeys preset before Windows sign-in', async ({ page }) => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const path = `/rdp/${id}`;
  const api = `/api/rdp/profiles/${id}`;
  const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
  const asset = (file: string) => readFileSync(`${__dirname}/../../src/worker/rdp-client/${file}`);
  await page.route(`**${path}`, r => r.fulfill({ contentType: 'text/html', headers: isolation,
    body: `<iframe src="${path}/client" data-connect-saved="true"></iframe>` }));
  await page.route(`**${path}/client`, r => r.fulfill({ contentType: 'text/html', headers: isolation, body: asset('index.rdp-text') }));
  for (const [url, file] of [['desktop', 'desktop'], ['rdp-socket', 'rdp-socket'], ['sdl-freerdp', 'vendor/sdl-freerdp']]) {
    await page.route(`**/rdp/assets/${url}.js`, r => r.fulfill({ contentType: 'text/javascript', headers: isolation, body: asset(`${file}.rdp-text`) }));
  }
  await page.route('**/rdp/assets/sdl-freerdp.wasm', r => r.fulfill({ contentType: 'application/wasm',
    headers: isolation, body: gunzipSync(asset('vendor/sdl-freerdp-gzip.rdp-bin')) }));
  await page.route(`**${api}`, r => r.request().method() === 'GET' ? r.fulfill({ json: {
    id, name: 'Local test', revision: 1, hasLogin: true, fingerprint: null,
  } }) : r.fallback());
  // Finish JS initialization without ever delivering a ticket, credentials, or network target.
  await page.route(`**${api}/connect`, r => r.request().method() === 'POST'
    ? r.fulfill({ status: 409, json: { code: 'profile_changed' } }) : r.fallback());
  await page.goto(path);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#status')).toContainText('Device settings changed');
  const canvas = frame.locator('#canvas');
  await canvas.evaluate(el => {
    const module = Reflect.get(window, 'Module');
    const read = module.FS.read.bind(module.FS);
    module.FS.read = (stream: { path: string }, bytes: Uint8Array, offset: number, length: number, pos?: number) => {
      const n = read(stream, bytes, offset, length, pos);
      if (n > 0 && stream.path.endsWith('/sdl-freerdp.json')) {
        el.dataset.presetRead = (el.dataset.presetRead ?? '') + new TextDecoder().decode(bytes.slice(offset, offset + n));
      }
      return n;
    };
    // The real native client loads its SDL settings even for /help; no socket or Windows is needed.
    module.callMain(['/help']);
  });
  await expect(canvas).toHaveAttribute('data-preset-read', '{"SDL_KeyModMask":["KMOD_NONE"]}');
});
