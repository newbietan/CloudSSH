// Explicit opt-in interoperability. No deployment, real account data, public RDP or external ICE.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';

const require = createRequire(createRequire(import.meta.url).resolve('wrangler'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = require('miniflare');
const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'cloudssh-connector-'));
const native = process.argv.includes('--native');
const preview = process.argv.includes('--preview');
const blockedICE = process.argv.includes('--blocked-ice');
const engine = process.argv.includes('--webkit') ? webkit : chromium;
const fingerprint = 'b'.repeat(64);
const route = process.argv.includes('--tunnel') ? 'tunnel' : 'direct';
const fixture = {
  name: 'Loopback smoke', route, host: 'rdp.example.com',
  ...(route === 'tunnel' ? { accessId: 'tunnel-fixture', accessSecret: 'synthetic-service-token' } : { port: 53389 }),
  login: { username: 'fixture', domain: '', password: 'synthetic' },
};
const exe = 'cloudssh-rdp-connector-windows-amd64.exe';
const meter = '.rdp-latency > summary';
const metric = name => `.rdp-latency-panel [data-metric="${name}"] dd`;
const bindingName = 'cloudssh-binding.cloudssh-rdp.json';
const upstream = 'https://github.com/newbietan/CloudSSH/releases/download/rdp-connector-v3/cloudssh-rdp-connector-windows-amd64.zip';
let mf, browser, agent, iceSink;
let dropPort = 0, dropped = 0;

function newAgent(go, site, cert, binding) {
  const child = spawn(go, ['-test.run', '^TestBrowserInterop$', '-test.v'], {
    env: { ...process.env, CLOUDSSH_PEER_TEST_SITE: site, CLOUDSSH_PEER_TEST_CA: cert,
      CLOUDSSH_PEER_TEST_ID: join(tmp, 'identity.json'), CLOUDSSH_PEER_TEST_NATIVE: native ? '1' : '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-8192); });
  const exited = once(child, 'exit');
  child.stdin.on('error', () => {});
  child.stdin.end(binding ? JSON.stringify(binding) : '');
  return {
    async wait(text, timeout = 20000) {
      const deadline = Date.now() + timeout;
      while (!output.includes(text)) {
        if (Date.now() >= deadline || child.exitCode !== null || child.signalCode) throw Error(`connector did not report ${text}: ${output.slice(-700)}`);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    },
    async stop() { child.kill(); await exited; },
  };
}

try {
  if (blockedICE) {
    iceSink = createSocket('udp4');
    iceSink.on('message', () => { dropped++; }); // Listen only on loopback; never acknowledge ICE probes.
    const listening = once(iceSink, 'listening');
    iceSink.bind(0, '127.0.0.1');
    await listening;
    dropPort = iceSink.address().port;
  }
  const cert = join(tmp, 'loopback.pem'), key = join(tmp, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const go = join(tmp, 'connector-test');
  execFileSync('go', ['test', '-mod=readonly', '-c', '-o', go, '.'], {
    cwd: join(root, 'tools/rdp-peer'), env: { ...process.env, GOWORK: 'off' },
  });
  const { outputFiles } = await require('esbuild').build({ absWorkingDir: root, entryPoints: [preview ? 'src/worker/rdp-preview-entry.ts' : 'src/worker/rdp-entry.ts'], bundle: true,
    write: false, format: 'esm', target: 'es2022', platform: 'browser', external: ['cloudflare:*'], loader: { '.rdp-text': 'text', '.rdp-bin': 'binary' } });
  const genericPath = preview ? join(root, 'src/worker/rdp-client/connector-preview.generated.rdp-bin') : join(tmp, 'generic.zip');
  if (!preview) {
    const files = join(tmp, 'packager-fixture');
    mkdirSync(files);
    writeFileSync(join(files, exe), Buffer.alloc(2048, 1));
    writeFileSync(join(files, 'SHA256SUMS'), 'Fixture only'); writeFileSync(join(files, 'LICENSES.txt'), 'Fixture only');
    execFileSync('zip', ['-q', '-X', '-0', genericPath, exe, 'SHA256SUMS', 'LICENSES.txt'], { cwd: files });
  }
  const genericZip = readFileSync(genericPath);
  mf = new Miniflare(convertV4MiniflareOptions({
    cf: false, modules: true, script: outputFiles[0].text, compatibilityDate: '2026-07-01', host: '127.0.0.1', port: 0, https: true,
    httpsCert: readFileSync(cert, 'utf8'), httpsKey: readFileSync(key, 'utf8'), log: new Log(LogLevel.ERROR),
    bindings: { GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test' },
    durableObjects: { USER_DB: { className: 'UserDBDO', useSQLite: true }, RDP_AUTHORITY: { className: 'RdpAuthorityDO', useSQLite: true } },
    outboundService: request => request.url === upstream
      ? new Response(genericZip, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(genericZip.length) } })
      : new Response(null, { status: 403 }),
  }));
  const site = (await mf.ready).origin, ns = await mf.getDurableObjectNamespace('USER_DB'), db = ns.get(ns.idFromName('42'));
  const internal = async (path, body) => {
    const res = await db.fetch('https://internal/internal/' + path, { method: 'POST', body: JSON.stringify(body) });
    assert.ok(res.ok, `${path.split('?')[0]}: ${res.status}`); return res.json();
  };
  const user = await internal('oauth-user', { github_id: 42, username: 'rtc-test', avatar_url: '' });
  browser = await engine.launch();
  async function client(fault = '') {
    const forceFallback = !!fault;
    const { token } = await internal('session/create', { user_id: user.id });
    // The workspace's ?lang must also win in the desktop frame, regardless of the browser language.
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'zh-CN' });
    await ctx.addCookies([{ name: 'session', value: token, url: site, secure: true }]);
    const page = await ctx.newPage(); page.setDefaultTimeout(16000);
    await page.addInitScript(({ failing, dropPort }) => {
      const Native = window.RTCPeerConnection;
      // Redirect advertised candidates in both directions to a nonresponding loopback socket.
      // Unlike removing all candidates, this lets the real ICE stacks start checking.
      const unreachable = desc => desc && ({ type: desc.type, sdp:
        desc.sdp.replace(/^a=(?:candidate:|end-of-candidates)[^\r\n]*(?:\r?\n|$)/gm, '').trimEnd() +
        `\r\na=candidate:1 1 UDP 2130706431 127.0.0.1 ${dropPort} typ host\r\n` });
      if (failing === 'ice') {
        const original = console.debug.bind(console);
        window.__peerDiagnostics = [];
        console.debug = (...args) => {
          if (args[0] === '[CloudSSH WebRTC] preflight ended') window.__peerDiagnostics.push(args[1]);
          original(...args);
        };
      }
      window.RTCPeerConnection = class extends Native {
        constructor(config) {
          const expected = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] }];
          if (JSON.stringify(config.iceServers) !== JSON.stringify(expected)) throw new Error('unexpected direct ICE configuration');
          if (failing === 'constructor') throw new DOMException('WebRTC disabled fixture', 'NotSupportedError');
          super({ ...config, iceServers: [] });
        }
        createOffer(...args) { return failing === 'offer' ? Promise.reject(new Error('ICE unavailable fixture')) : super.createOffer(...args); }
        get localDescription() { return failing === 'ice' ? unreachable(super.localDescription) : super.localDescription; }
        setRemoteDescription(desc, ...args) { return super.setRemoteDescription(failing === 'ice' ? unreachable(desc) : desc, ...args); }
        async getStats(...args) {
          if (window.__freezeIceStats && this.lastReport) return this.lastReport;
          return this.lastReport = await super.getStats(...args);
        }
      };
      const Ws = window.WebSocket;
      window.__wire = { signal: 0, binary: 0, relay: 0, native: 0, events: [] };
      window.WebSocket = class extends Ws {
        constructor(url, ...args) {
          super(url, ...args);
          const path = new URL(url).pathname;
          if (path === '/api/rdp/session') { window.__wire.relay++; window.__wire.events.push('relay'); }
          if (path === '/api/rdp/peer/session') {
            window.__wire.signal++; window.__wire.events.push('peer');
            this.addEventListener('message', ({ data }) => { if (typeof data !== 'string') window.__wire.binary++; });
          }
        }
        send(data) { if (new URL(this.url).pathname === '/api/rdp/peer/session' && typeof data !== 'string') window.__wire.binary++; super.send(data); }
        close(...args) { if (new URL(this.url).pathname === '/api/rdp/peer/session') window.__wire.events.push('stop-peer'); super.close(...args); }
      };
    }, { failing: fault, dropPort });
    if (!native && !forceFallback) await page.route('**/rdp/assets/rdp-socket.js', r => r.fulfill({
      contentType: 'text/javascript', body: readFileSync(join(root, 'src/worker/rdp-client/rdp-socket.rdp-text'), 'utf8') + `
        // Delay one delivered pong without changing ICE, RDP bytes, ACKs or the production adapter.
        const create = window.createCloudSshRdpSocket;
        window.createCloudSshRdpSocket = (url, ticket, peer) => {
          const socket = create(url, ticket, peer);
          const handle = peer.onmessage;
          let injected = false;
          peer.onmessage = event => {
            if (!injected && typeof event.data === 'string' && JSON.parse(event.data).type === 'pong') {
              injected = true; setTimeout(() => handle(event), 750); return;
            }
            handle(event);
          };
          return socket;
        };`,
    }));
    if (!native) await page.route('**/rdp/assets/sdl-freerdp.js', r => r.fulfill({ contentType: 'text/javascript', body: `const M=window.Module;
      M.FS={mkdirTree(){},writeFile(){}};M.websocket.on=()=>{};M._cloudssh_take_rdp_rtt=()=>-1;
      M.callMain=args=>{if(!args.includes('/u:fixture')||M.takeWindowsPassword()!=='synthetic'||M.takeWindowsPassword()!==undefined)throw Error('credential handoff failed');
        window.__wire.native++;const s=M.createRdpSocket(M.websocket.url);let total=0,offset=0,size=16384;
        const fill=(n)=>Uint8Array.from({length:size},(_,i)=>(n+i)%251);const next=()=>{for(let i=0;i<4;i++){s.send(fill(offset));offset+=size}};
        s.onopen=()=>{if(${forceFallback}){M.onWindowsFirstFrame();document.body.dataset.verified='relay';return}
          const decision=M.onWindowsCertificate('${fingerprint}');
          const ready=()=>{M.onWindowsFirstFrame();next()};if(decision===1)ready();else if(decision===0){const t=setInterval(()=>{if(M.onWindowsCertificate(null)===1){clearInterval(t);ready()}},20)}};
        s.onmessage=({data})=>{const b=new Uint8Array(data);for(let i=0;i<b.length;i++)if(b[i]!==((total+i)%251))throw Error('corrupt echo');total+=b.length;s.consumed(b.length);if(total===offset){if(total<2097152)next();else document.body.dataset.verified=String(total)}};
      };M.onRuntimeInitialized();` }));
    let relayPings = 0;
    if (forceFallback) await page.routeWebSocket('**/api/rdp/session', ws => {
      ws.onMessage(async data => {
        if (typeof data !== 'string') return;
        const value = JSON.parse(data);
        if (value.type === 'ping') { relayPings++; ws.send(JSON.stringify({ type: 'pong', id: value.id })); return; }
        if (value.type !== 'ticket') return;
        // Claim the real, fresh browser-bound relay ticket, but don't dial an external Windows server.
        const cookies = await ctx.cookies(site);
        const key = cookies.find(cookie => cookie.name === '__Host-cloudssh_rdp')?.value;
        assert.match(key, /^[a-f0-9]{64}$/);
        const binding = createHash('sha256').update(`${key}\n${token}`).digest('hex');
        const relay = await internal(`rdp/claim?user_id=${user.id}`, { ticket: value.ticket, binding, supportsDirectPort: true });
        assert.equal(relay.profile.route, route);
        assert.equal(relay.profile.host, fixture.host);
        assert.equal(relay.profile.port, fixture.port);
        assert.equal(relay.accessId, fixture.accessId);
        assert.equal(relay.accessSecret, fixture.accessSecret);
        ws.send(JSON.stringify({ type: 'ready', lease: relay.id, desktopReport: true }));
      });
    });
    await page.goto(site + '/?lang=en-US', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return { ctx, page, relayPings: () => relayPings };
  }
  async function api(page, path, method = 'GET', data) {
    const response = await page.evaluate(async ({ path, method, data }) => {
      const r = await fetch(path, { method, headers: { 'X-CloudSSH-RDP-Client': '5', 'Content-Type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { path, method, data });
    assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status}`);
    return response.body;
  }
  const { ctx, page } = await client();
  const config = await api(page, '/api/config');
  assert.equal(config.rdpConnectorEnabled, true);
  assert.equal(config.rdpConnectorPreview === true, preview);
  const { id, revision } = await api(page, '/api/rdp/profiles', 'POST', fixture), p = `/api/rdp/profiles/${id}`;
  const setup = () => ctx.request.post(site + p + '/connector-setup', {
    headers: { Origin: site, 'X-CloudSSH-RDP-Client': '5' }, data: { revision },
  });
  const downloaded = await setup();
  assert.equal(downloaded.status(), 200);
  assert.match(downloaded.headers()['cache-control'], /no-store/);
  assert.equal(downloaded.headers()['x-cloudssh-connector-build'], preview ? 'test-unsigned' : undefined);
  const personalPath = join(tmp, 'personal.zip');
  writeFileSync(personalPath, await downloaded.body(), { mode: 0o600 });
  execFileSync('unzip', ['-tq', personalPath], { stdio: 'ignore' });
  assert.ok(execFileSync('unzip', ['-p', personalPath, exe], { maxBuffer: 24 * 1024 * 1024 })
    .equals(execFileSync('unzip', ['-p', genericPath, exe], { maxBuffer: 24 * 1024 * 1024 })), 'installer bytes must be identical');
  const binding = JSON.parse(execFileSync('unzip', ['-p', personalPath, bindingName], { maxBuffer: 8192 }).toString());
  assert.equal(binding.origin, site);
  assert.equal(binding.version, 3);
  assert.equal((await api(page, p + '/connector')).state, 'waiting');
  agent = newAgent(go, site, cert, binding);
  await agent.wait('Device registered:');
  await agent.wait('Connector online');
  assert.equal((await api(page, p + '/connector')).state, 'online');
  assert.equal((await setup()).status(), 409);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  const open = async page => { await page.locator(`#rdp-open-${id}`).click(); return page.frameLocator('iframe[src$="/client"]'); };
  const inspect = async page => page.frames().find(f => f.url().endsWith('/client')).evaluate(() => window.__wire);
  const connectResponse = (page, transport) => page.waitForResponse(r => r.url().endsWith('/connect') &&
    (r.request().headers()['x-cloudssh-rdp-transport'] || 'relay') === transport, { timeout: 26000 });
  async function inspectGrant(response) {
    assert.ok(response.ok(), 'connect must return a sealed grant');
    assert.match(response.headers()['cache-control'], /no-store/);
    assert.equal(response.request().headers()['x-cloudssh-rdp-client'], '6');
    const clientKey = response.request().headers()['x-cloudssh-rdp-client-key'];
    assert.match(clientKey, /^[A-Za-z0-9_-]{87}$/);
    const wire = await response.text();
    assert.ok(!wire.includes(fixture.login.password) && !wire.includes(fixture.login.username), 'no clear credentials on the wire');
    const { ticket, revision, loginEnvelope, ...rest } = JSON.parse(wire);
    assert.deepEqual(rest, {});
    assert.match(ticket, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(revision) && loginEnvelope?.version === 1);
    return { ticket, clientKey, senderKey: loginEnvelope.senderKey };
  }
  const firstGrant = connectResponse(page, 'device').then(inspectGrant);
  const frame = await open(page);
  await firstGrant;
  if (native) {
    await agent.wait('Native RDP negotiation reached loopback TCP.', 35000);
    assert.equal((await inspect(page)).relay, 0);
    console.log(`${engine.name()}: installed identity → bundled FreeRDP WASM → WebRTC → Pion → TCP: X.224 (no Windows sign-in)`);
  } else {
    await frame.locator('#certificate-accept').waitFor();
    const material = el => {
      const css = getComputedStyle(el);
      return [css.backgroundColor, css.borderTopLeftRadius, css.boxShadow];
    };
    assert.deepEqual(await frame.locator('#certificate .app-modal__panel').evaluate(material),
      await page.locator('#server-modal .app-modal__panel').evaluate(material), 'certificate frame must use shared modal chrome');
    await frame.locator('#certificate-accept').click();
    await frame.locator('body[data-verified="2097152"]').waitFor({ timeout: 26000 });
    const wire = await inspect(page);
    assert.deepEqual(wire, { signal: 1, binary: 0, relay: 0, native: 1, events: ['peer'] });
    await page.waitForFunction(sel => /^WebRTC (?:· Channel )?\d+ ms$/.test(document.querySelector(sel)?.textContent || ''), meter, { timeout: 12000 });
    await page.locator(meter).click();
    await page.waitForFunction(sel => parseInt(document.querySelector(sel)?.textContent || '', 10) >= 740, metric('peak'));
    const typ = await page.locator(metric('ice')).textContent();
    assert.match(typ, /^(?:host|srflx|prflx) \/ (?:host|srflx|prflx)$/, 'an actual non-relay candidate pair is required');
    if (engine === chromium) {
      // The link comes from the real selected ICE pair, not the artificially delayed desktop pong.
      await page.waitForFunction(sel => /^\d+ ms$/.test(document.querySelector(sel)?.textContent || ''), metric('link'), { timeout: 16000 });
    }
    const quality = await page.evaluate(({ meter, link }) => ({
      label: document.querySelector(meter)?.textContent, link: document.querySelector(link)?.textContent,
    }), { meter, link: metric('link') });
    if (quality.link === '—') assert.match(quality.label, /^WebRTC · Channel \d+ ms$/);
    else {
      assert.equal(quality.label, `WebRTC ${quality.link}`);
      assert.ok(parseInt(quality.link, 10) < 750, 'ICE RTT does not include the delayed pong');
    }
    console.log(`${engine.name()}: link ${quality.link}, separate 750 ms channel spike preserved`);
    assert.equal((await api(page, p)).fingerprint, fingerprint);
    const renewal = page.waitForResponse(r => r.url().endsWith('/peer-renew') && r.ok(), { timeout: 16000 });
    if (quality.link !== '—') {
      // Repeat the same RTCStatsReport while the healthy channel keeps delivering new pongs.
      await frame.locator('html').evaluate(() => { window.__freezeIceStats = true; });
      await Promise.all([renewal, page.waitForFunction(({ meter, link }) =>
        document.querySelector(link)?.textContent === '—' && /^WebRTC · Channel \d+ ms$/.test(document.querySelector(meter)?.textContent || ''),
        { meter, link: metric('link') }, { timeout: 22000 })]);
      console.log(`${engine.name()}: a stale ICE report expires and the toolbar labels the live channel`);
    } else await renewal;
    await ctx.close(); await agent.wait('Loopback TCP closed.'); await agent.stop(); agent = undefined;
    const second = await client();
    agent = newAgent(go, site, cert);
    await agent.wait('Connector online'); await second.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    const two = await open(second.page);
    await two.locator('body[data-verified="2097152"]').waitFor({ timeout: 26000 });
    assert.equal((await inspect(second.page)).relay, 0);
    await api(second.page, p, 'PUT', { ...fixture, revision, name: 'Renamed without re-enrollment' });
    await agent.wait('Loopback TCP closed.');
    assert.equal((await api(second.page, p + '/connector')).state, 'online');
    await second.ctx.close();
    const fault = blockedICE ? 'ice' : route === 'tunnel' ? 'constructor' : 'offer';
    const fallback = await client(fault);
    const transportRequests = [];
    fallback.page.on('request', req => { if (req.url().endsWith('/connect')) transportRequests.push(req.headers()['x-cloudssh-rdp-transport'] || 'relay'); });
    const grants = Promise.all(['device', 'relay'].map(transport => connectResponse(fallback.page, transport).then(inspectGrant)));
    const three = await open(fallback.page);
    const [directGrant, relayGrant] = await grants;
    for (const field of ['ticket', 'clientKey', 'senderKey']) assert.notEqual(directGrant[field], relayGrant[field]);
    await three.locator('body[data-verified="relay"]').waitFor({ timeout: 24000 });
    await fallback.page.waitForFunction(sel => /^Relay \d+ ms$/.test(document.querySelector(sel)?.textContent || ''), meter, { timeout: 14000, polling: 200 }).catch(async error => {
      const label = await fallback.page.locator(meter).textContent();
      const visibility = await three.locator('body').evaluate(() => document.visibilityState);
      throw new Error(`Relay latency not shown: meter=${label}, visibility=${visibility}, pings=${fallback.relayPings()}`, { cause: error });
    });
    const fb = await inspect(fallback.page);
    assert.deepEqual(transportRequests, ['device', 'relay']);
    assert.equal(fb.native, 1); assert.equal(fb.binary, 0);
    // Playwright's mocked relay socket can bypass the constructor wrapper; the two ordered ticket requests and
    // the started fallback desktop independently prove that route. The real direct socket must have been closed.
    if (fault !== 'constructor') assert.deepEqual(fb.events.slice(0, 2), ['peer', 'stop-peer']);
    else assert.ok(!fb.events.includes('peer'), 'no signaling socket when RTC construction is unavailable');
    if (blockedICE) {
      const diagnostics = await three.locator('html').evaluate(() => window.__peerDiagnostics);
      assert.equal(diagnostics.length, 1);
      const [d] = diagnostics;
      assert.deepEqual(Object.keys(d).sort(), [
        'afterAnswerMs', 'browserCandidates', 'connection', 'connectorCandidates', 'dataChannel', 'elapsedMs', 'ice', 'phase', 'reason', 'source',
      ]);
      assert.equal(d.source, 'deadline');
      assert.equal(d.reason, 'peer_timeout');
      assert.equal(d.phase, 'opening');
      assert.equal(d.ice, 'checking');
      assert.ok(d.afterAnswerMs > 0, 'the answer was installed before the deadline');
      assert.deepEqual(d.browserCandidates, { host: 1, srflx: 0, prflx: 0, relay: 0 });
      assert.deepEqual(d.connectorCandidates, d.browserCandidates);
      assert.ok(dropped > 0, 'the loopback sink received ICE probes');
      console.log(`${engine.name()}: SDP answer applied → ICE ${d.ice} → own preflight deadline (${d.elapsedMs} ms) → relay once`);
    }
    await api(fallback.page, p + '/connector', 'DELETE');
    assert.equal((await api(fallback.page, p + '/connector')).state, 'unbound');
    console.log(`${engine.name()}: single ZIP with unchanged EXE → installed key + automatic binding → direct ${typ} / first trust, 2 MiB byte check and renewal → process restart + new login opens without pairing → failed WebRTC setup silently uses saved ${route} relay with one native start and Relay latency → unlink`);
  }
} finally {
  await agent?.stop();
  await browser?.close();
  await mf?.dispose();
  if (iceSink) iceSink.close();
  rmSync(tmp, { recursive: true, force: true });
}
