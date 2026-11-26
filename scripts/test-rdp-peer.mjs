// Explicit opt-in interoperability. No deployment, real user data, public RDP or external ICE servers.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { chromium, webkit } from '@playwright/test';
// Reuse Wrangler's locked workerd/esbuild versions; the production build has no test dependencies.
const require = createRequire(createRequire(import.meta.url).resolve('wrangler'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = require('miniflare');
const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'cloudssh-peer-'));
let mf, browser, agent;
try {
  const cert = join(tmp, 'loopback.pem'),
    key = join(tmp, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' }
  );
  const go = join(tmp, 'peer-test');
  execFileSync('go', ['test', '-mod=readonly', '-c', '-o', go, '.'], {
    cwd: join(root, 'tools/rdp-peer'),
    env: { ...process.env, GOWORK: 'off' },
  });
  const { outputFiles } = await require('esbuild').build({
    absWorkingDir: root,
    entryPoints: ['src/worker/rdp-entry.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    external: ['cloudflare:*'],
    loader: { '.rdp-text': 'text', '.rdp-bin': 'binary' },
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: outputFiles[0].text,
      compatibilityDate: '2026-07-01',
      host: '127.0.0.1',
      port: 0,
      https: true,
      httpsCert: readFileSync(cert, 'utf8'),
      httpsKey: readFileSync(key, 'utf8'),
      log: new Log(LogLevel.ERROR),
      bindings: {
        GITHUB_CLIENT_ID: 'test',
        GITHUB_CLIENT_SECRET: 'test',
        RDP_P2P_SECRET: randomBytes(32).toString('hex'),
      },
      durableObjects: { USER_DB: { className: 'UserDBDO', useSQLite: true } },
      outboundService: () => new Response(null, { status: 403 }),
    })
  );
  const site = (await mf.ready).origin,
    ns = await mf.getDurableObjectNamespace('USER_DB'),
    db = ns.get(ns.idFromName('42'));
  const internal = async (path, body, method = 'POST') => {
    const res = await db.fetch('https://internal/internal/' + path, {
      method,
      body: JSON.stringify(body),
    });
    assert.ok(res.ok, `${path.split('?')[0]}: ${res.status}`);
    return res.json();
  };
  const user = await internal('oauth-user', {
    github_id: 42,
    username: 'rtc-test',
    avatar_url: '',
  });
  const { token } = await internal('session/create', { user_id: user.id });
  const rdp = (path, body, method) => internal(`rdp/${path}?user_id=${user.id}`, body, method);
  for (const engine of process.argv.includes('--webkit') ? [webkit] : [chromium]) {
    const fixture = {
      name: 'Loopback smoke',
      route: 'direct',
      host: 'rdp.example.com',
      login: { username: 'fixture', domain: '', password: 'synthetic' },
    };
    const profile = await rdp('profiles', fixture);
    const { id, revision } = profile;
    // Establish the trust prerequisite through the real store, not by introducing a public seeding API.
    const binding = 'a'.repeat(64);
    const { ticket } = await rdp('ticket', { profile: id, binding, savedRevision: revision });
    const { id: initial } = await rdp('claim', { ticket, binding, supportsDirectPort: true });
    await rdp(
      `profiles/${id}/trust`,
      { lease: initial, revision, fingerprint: 'b'.repeat(64) },
      'PUT'
    );
    await rdp('release', { lease: initial });
    browser = await engine.launch();
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    await ctx.addCookies([{ name: 'session', value: token, url: site, secure: true }]);
    const page = await ctx.newPage();
    page.setDefaultTimeout(12000);
    // Same-origin real account page and iframe. Intercept only the external ICE configuration (hermetic host candidates).
    await page.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(config) {
          super({ ...config, iceServers: [] });
          window.__pc = this;
        }
      };
      const NativeWs = window.WebSocket;
      window.__wire = { signal: 0, binary: 0, relay: 0 };
      window.WebSocket = class extends NativeWs {
        constructor(url, ...args) {
          super(url, ...args);
          const path = new URL(url).pathname;
          if (path === '/api/rdp/session') window.__wire.relay++;
          if (path === '/api/rdp/peer/session') {
            window.__wire.signal++;
            this.addEventListener('message', ({ data }) => {
              if (typeof data !== 'string') window.__wire.binary++;
            });
          }
        }
        send(data) {
          if (new URL(this.url).pathname === '/api/rdp/peer/session' && typeof data !== 'string')
            window.__wire.binary++;
          super.send(data);
        }
      };
    });
    await page.goto(site + '/?lang=en-US');
    await page.locator(`#rdp-peer-${id}`).click();
    const frame = page.frameLocator('iframe[src$="/client"]');
    const code = await frame.locator('#peer-pairing input').inputValue();
    assert.ok(code.startsWith('p1.'));
    const native = process.argv.includes('--native');
    agent = spawn(go, ['-test.run', '^TestBrowserInterop$', '-test.v'], {
      env: { ...process.env, CLOUDSSH_PEER_TEST_SITE: site, CLOUDSSH_PEER_TEST_CA: cert, CLOUDSSH_PEER_TEST_NATIVE: native ? '1' : '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const agentExit = once(agent, 'exit');
    let output = '';
    agent.stdout.on('data', (b) => {
      output += b.toString().slice(0, 512);
    });
    agent.stdin.end(code + '\n');
    await Promise.race([
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          clearInterval(t);
          reject(Error('pair timeout: ' + output.slice(-300)));
        }, 8000);
        const t = setInterval(() => {
          if (output.includes('Paired.')) {
            clearTimeout(timer);
            clearInterval(t);
            resolve();
          }
        }, 30);
      }),
      agentExit.then(() => {
        throw Error('connector exited: ' + output.slice(-300));
      }),
    ]);
    if (native) {
      // No JS/WASM stand-in here. The loopback peer stops at the first native negotiation packet.
      await frame.locator('#peer-pairing button').last().click();
      const [exit] = await Promise.race([agentExit, new Promise((_, reject) => {
        const t=setTimeout(()=>reject(Error('native FreeRDP negotiation did not reach TCP')),35000); t.unref();
      })]);
      assert.equal(exit,0,output.slice(-300)); assert.ok(output.includes('Native RDP negotiation reached loopback TCP.'));
      console.log(`${engine.name()}: bundled FreeRDP WASM → WebRTC → Pion → TCP: valid X.224 connection request (no Windows login attempted)`);
      await browser.close(); browser=undefined; agent=undefined; continue;
    }
    // Exercise the browser adapter and ordinary TCP bytes. This is not a Windows TLS/NLA test.
    await page.route('**/rdp/assets/sdl-freerdp.js', (r) =>
      r.fulfill({
        contentType: 'text/javascript',
        body: `const M=window.Module;
      M.FS={mkdirTree(){},writeFile(){}};M.websocket.on=()=>{};M._cloudssh_take_rdp_rtt=()=>-1;
      M.callMain=()=>{const s=M.createRdpSocket(M.websocket.url);let total=0,offset=0, size=16384;
        const fill=(n)=>Uint8Array.from({length:size},(_,i)=>(n+i)%251); const next=()=>{for(let i=0;i<4;i++){s.send(fill(offset));offset+=size}};
        s.onopen=()=>{M.onWindowsFirstFrame();next()};s.onmessage=({data})=>{const b=new Uint8Array(data);for(let i=0;i<b.length;i++)if(b[i]!==((total+i)%251))throw Error('corrupt echo');total+=b.length;s.consumed(b.length);if(total===offset){if(total<2097152) next();else document.body.dataset.verified=String(total)}};
      };M.onRuntimeInitialized();`,
      })
    );
    await frame.locator('#peer-pairing button').last().click();
    try {
      await frame
        .locator('body[data-verified="2097152"]')
        .waitFor({ state: 'attached', timeout: 30000 });
    } catch {
      const f = page.frames().find((f) => f.url().endsWith('/client'));
      const diag = await f?.evaluate(() => ({
        status: document.getElementById('status')?.textContent,
        state: window.__pc?.connectionState,
        ice: window.__pc?.iceConnectionState,
        candidates: (window.__pc?.localDescription?.sdp || '').match(
          / typ (?:host|srflx|relay|prflx)/g
        ),
        remote: (window.__pc?.remoteDescription?.sdp || '').match(
          / typ (?:host|srflx|relay|prflx)/g
        ),
      }));
      throw Error('No verified echo: ' + JSON.stringify(diag) + ' ' + output.slice(-320));
    }
    assert.deepEqual(
      await page
        .frames()
        .find((f) => f.url().endsWith('/client'))
        .evaluate(() => window.__wire),
      { signal: 1, binary: 0, relay: 0 }
    );
    const latency = page.locator('.rdp-latency');
    await page.waitForFunction(
      () => /WebRTC \d+ ms/.test(document.querySelector('.rdp-latency')?.textContent || ''),
      {},
      { timeout: 12000 }
    );
    const pathTypes = (await latency.getAttribute('title')).match(
      /(?:host|srflx|prflx) \/ (?:host|srflx|prflx)$/
    )?.[0];
    assert.ok(pathTypes, 'a selected non-relay ICE pair is required');
    // Wait for one real authenticated renewal; never count the arrival of input/output as a renewal.
    await page.waitForResponse((r) => r.url().endsWith('/peer-renew') && r.ok(), {
      timeout: 16000,
    });
    await rdp(`profiles/${id}`, { ...fixture, name: 'Revoked', revision }, 'PUT');
    const [exit] = await Promise.race([
      agentExit,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(Error('connector survived revocation')), 5000);
        t.unref();
      }),
    ]);
    assert.equal(exit, 0, output.slice(-300));
    console.log(
      `${engine.name()}: paired → direct ${pathTypes} → 2 MiB checked across repeated credit windows → measured RTT → lease renewed → profile edit closed connector and TCP`
    );
    await browser.close();
    browser = undefined;
    agent = undefined;
  }
} finally {
  agent?.kill();
  await browser?.close();
  await mf?.dispose();
  rmSync(tmp, { recursive: true, force: true });
}
