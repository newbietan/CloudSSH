import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Duplex } from 'node:stream';
import { createSecureContext, TLSSocket } from 'node:tls';
import { gunzipSync } from 'node:zlib';
import { RDP_CONNECT_KEY_HEADER } from '../../src/rdp-schema';
import { testRdpGrant } from '../fixtures/rdp-connect';
import { expect, test, type Page } from './fixtures';

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

const nativeEndings = ['activation timeout', 'browser deadline', 'transport close'] as const;
for (const end of nativeEndings) {
  test(`the real WASM reports its NLA substate on ${end}`, ({ page }) => exerciseNlaEnd(page, end));
}

async function exerciseNlaEnd(page: Page, end: typeof nativeEndings[number]) {
  // Standard X.224 + TLS on an in-memory wire. No TCP listener, Windows target, NTLM challenge
  // or completed login. The pin is for a certificate made with a public protocol-test key.
  const cert = readFileSync(`${__dirname}/../fixtures/rdp-nla-test-cert.pem`);
  const secureContext = createSecureContext({ cert, key: readFileSync(`${__dirname}/../ssh/fixtures/id_rsa_2048_pkcs1.pem`) });
  const fingerprint = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
  await page.route(`**${api}`, r => r.request().method() === 'GET' ? r.fulfill({ json: {
    id, name: 'TLS fixture', revision: 1, hasLogin: true, fingerprint,
  } }) : r.fallback());
  let attempts = 0, sawToken = false;
  await page.route(`**${api}/connect`, async r => {
    if (r.request().method() !== 'POST') return r.fallback();
    attempts++;
    return r.fulfill({ json: await testRdpGrant(r.request().headers()[RDP_CONNECT_KEY_HEADER.toLowerCase()], {
      origin: new URL(r.request().url()).origin, profile: id, revision: 1, transport: 'relay', ticket: '2'.repeat(64),
    }, { username: 'tester', domain: '', password: 'synthetic' }) });
  });
  const client = readFileSync(`${__dirname}/../../src/worker/rdp-client/desktop.rdp-text`, 'utf8');
  // Shorten just the deadline under test, leaving the *other* clock alone.
  const body = end === 'activation timeout' ? client.replace('const activationTimeoutMs = 45_000;', 'const activationTimeoutMs = 2000;')
    : end === 'browser deadline' ? client.replace('const postTrustFrameMs = activationTimeoutMs + 15_000;', 'const postTrustFrameMs = 2000;') : client;
  await page.route('**/rdp/assets/desktop.js', r => r.fulfill({ contentType: 'text/javascript', body }));
  let closeTransport: (() => Promise<void>) | undefined;
  await page.routeWebSocket('**/api/rdp/session', ws => {
    let negotiated = false;
    closeTransport = () => ws.close({ code: 1000 });
    const wire = new Duplex({ read() {}, write(bytes, _, done) { ws.send(Buffer.from(bytes)); done(); } });
    const tls = new TLSSocket(wire, { isServer: true, secureContext });
    tls.on('data', () => { sawToken = true; }); // Discard the first CredSSP request, never answer it.
    tls.on('error', () => ws.close());
    ws.onClose(() => { tls.destroy(); wire.destroy(); });
    ws.onMessage(message => {
      if (typeof message === 'string') {
        if (JSON.parse(message).type === 'ticket') ws.send(JSON.stringify({ type: 'ready', lease: id }));
      } else if (negotiated) wire.push(message);
      else {
        negotiated = true;
        ws.send(Buffer.from('030000130ed000000000000200080002000000', 'hex')); // PROTOCOL_HYBRID
      }
    });
  });
  await page.goto(path);
  const status = page.frameLocator('iframe').locator('#status');
  if (end === 'transport close') {
    await expect.poll(() => sawToken, { timeout: 12_000 }).toBe(true);
    // Arrange close at a known native state, without using a machine-dependent sleep.
    await expect.poll(() => status.evaluate(() => Reflect.get(window, 'Module')?._cloudssh_read_rdp_state?.())).toBe(0x0202);
    await closeTransport!();
  }
  if (end === 'activation timeout') {
    await expect(status).toContainText('FreeRDP state at timeout: NLA / NEGO_TOKEN.', { timeout: 16_000 });
    await expect(status).toContainText('ERRCONNECT_ACTIVATION_TIMEOUT');
  } else {
    const source = end === 'browser deadline' ? 'The browser stopped waiting for the first frame.' : 'The desktop transport closed.';
    await expect(status).toContainText(`${source} Last FreeRDP state: NLA / NEGO_TOKEN.`, { timeout: 16_000 });
    await expect(status).not.toContainText('ERRCONNECT_ACTIVATION_TIMEOUT');
  }
  expect(sawToken).toBe(true);
  expect(attempts).toBe(1);
}
