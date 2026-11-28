import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { RDP_CONNECT_KEY_HEADER } from '../../src/rdp-schema';
import { testRdpGrant } from '../fixtures/rdp-connect';
import { expect, test } from './fixtures';

// Actual pthreads/WASM require cross-origin isolation. The mobile WebKit suite uses the
// SDL stub for workspace gestures. These Chromium cases exercise the shipped native parser.
const id = '12345678-1234-1234-1234-123456789abc';
const path = `/rdp/${id}`;
const api = `/api/rdp/profiles/${id}`;
test.beforeEach(async ({ page }) => {
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
});

test('the bundled SDL client reads the no-hotkeys preset before Windows sign-in', async ({ page }) => {
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

test('the bundled FreeRDP accepts the activation policy and emits an NLA negotiation request', async ({ page }) => {
  await page.route(`**${api}/connect`, async r => {
    if (r.request().method() !== 'POST') return r.fallback();
    const json = await testRdpGrant(r.request().headers()[RDP_CONNECT_KEY_HEADER.toLowerCase()], {
      origin: new URL(r.request().url()).origin, profile: id, revision: 1, transport: 'relay', ticket: '1'.repeat(64),
    }, { username: 'tester', domain: '', password: 'synthetic' });
    return r.fulfill({ json });
  });
  // Only the carrier is fake. No Windows endpoint: inspect the first TPKT/X.224 request,
  // never record its cookie, return server bytes, or proceed to TLS/CredSSP.
  await page.route('**/rdp/assets/rdp-socket.js', r => r.fulfill({ contentType: 'text/javascript', body: `
    window.createCloudSshRdpSocket = () => {
      const socket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, readyState: 0,
        send(value) {
          const b = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
          const n = b.length;
          if (n >= 19 && b[0] === 3 && b[1] === 0 && ((b[2] << 8) | b[3]) === n && b[5] === 0xe0 &&
              b[n-8] === 1 && b[n-6] === 8 && b[n-5] === 0 && (b[n-4] & 2)) document.documentElement.dataset.nlaRequest = 'yes';
        }, close() { this.readyState = 3; }
      };
      queueMicrotask(() => { socket.readyState = 1; socket.onopen?.(new Event('open')); });
      return socket;
    };
  ` }));
  await page.goto(path);
  await expect(page.frameLocator('iframe').locator('html')).toHaveAttribute('data-nla-request', 'yes', { timeout: 12_000 });
});
