const { chromium } = require('@playwright/test');
const { resolve } = require('node:path');

const outputPath = resolve(__dirname, '../docs/assets/og-cloudssh.png');

const markup = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 1200px; height: 630px; margin: 0; overflow: hidden; }
    body {
      position: relative;
      display: grid;
      grid-template-columns: 0.92fr 1.08fr;
      align-items: center;
      gap: 58px;
      padding: 72px;
      color: #f5f7ff;
      background:
        radial-gradient(circle at 8% 95%, rgba(255, 43, 214, .2), transparent 29%),
        radial-gradient(circle at 94% 6%, rgba(0, 246, 255, .17), transparent 36%),
        #05020a;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body::before {
      content: "";
      position: absolute;
      inset: 0;
      opacity: .28;
      background-image:
        linear-gradient(rgba(0, 246, 255, .08) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 43, 214, .07) 1px, transparent 1px);
      background-size: 78px 78px;
      mask-image: linear-gradient(100deg, #000, transparent 78%);
    }
    .copy, .terminal { position: relative; z-index: 1; }
    .eyebrow {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 24px;
      color: #ff2bd6;
      font: 700 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: .14em;
      text-transform: uppercase;
    }
    .eyebrow::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ffe600;
      box-shadow: 0 0 18px rgba(255, 230, 0, .7);
    }
    h1 {
      margin: 0;
      color: #f4faf6;
      font-size: 78px;
      line-height: .94;
      letter-spacing: -.065em;
    }
    h1 span {
      color: transparent;
      background: linear-gradient(90deg, #ffe600, #65ff6a 42%, #00f6ff 72%, #ff2bd6);
      background-clip: text;
    }
    .tagline {
      max-width: 500px;
      margin: 28px 0 0;
      color: #bcb3cb;
      font-size: 24px;
      line-height: 1.45;
    }
    .facts {
      display: flex;
      gap: 18px;
      margin-top: 36px;
      color: #b7aec7;
      font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .facts span {
      padding: 9px 11px;
      border: 1px solid rgba(0, 246, 255, .34);
      border-radius: 1px;
      background: rgba(13, 7, 21, .76);
    }
    .terminal {
      overflow: hidden;
      height: 410px;
      border: 1px solid rgba(0, 246, 255, .56);
      border-radius: 2px;
      background: rgba(8, 4, 13, .97);
      box-shadow: 12px 12px 0 rgba(255, 43, 214, .12), 0 34px 80px rgba(0, 0, 0, .54);
      transform: perspective(900px) rotateY(-7deg) rotateX(2deg);
    }
    .chrome, .status {
      display: flex;
      align-items: center;
      padding: 0 18px;
      color: #6f8579;
      font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .chrome { height: 48px; gap: 7px; border-bottom: 1px solid rgba(158, 188, 172, .15); }
    .chrome i { width: 9px; height: 9px; border-radius: 50%; background: #ff7a7a; }
    .chrome i:nth-child(2) { background: #e7bc68; }
    .chrome i:nth-child(3) { background: #65f58d; }
    .chrome b { margin-left: 12px; font-weight: 600; }
    .chrome em { margin-left: auto; color: #43d9e6; font-style: normal; }
    .screen {
      height: 312px;
      padding: 29px 24px;
      color: #b8cbc0;
      font: 15px/2 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .screen p { margin: 0; white-space: nowrap; }
    .screen .prompt { color: #65f58d; }
    .screen .cyan { color: #43d9e6; }
    .screen .muted { color: #53655c; }
    .status { height: 50px; justify-content: space-between; border-top: 1px solid rgba(158, 188, 172, .15); }
    .status strong { color: #65f58d; }
  </style>
</head>
<body>
  <section class="copy">
    <div class="eyebrow">Open source · Serverless</div>
    <h1>Cloud<span>SSH</span></h1>
    <p class="tagline">A serverless Web SSH terminal built for the Cloudflare edge.</p>
    <div class="facts"><span>SFTP</span><span>AI AGENT</span><span>THEME V2</span></div>
  </section>
  <section class="terminal">
    <div class="chrome"><i></i><i></i><i></i><b>cloudssh / edge-session</b><em>CF-HKG</em></div>
    <div class="screen">
      <p><span class="muted">[edge]</span> <span class="cyan">connected</span> via Cloudflare Workers</p>
      <p><span class="prompt">root@cloud:~#</span> uname -a</p>
      <p>Linux production 6.8.0 x86_64 GNU/Linux</p>
      <p><span class="prompt">root@cloud:~#</span> systemctl status cloudssh</p>
      <p><span class="cyan">● active (running)</span> · latency 42ms</p>
      <p><span class="prompt">root@cloud:~#</span> ▌</p>
    </div>
    <div class="status"><strong>● CONNECTED</strong><span>SSH · AES-256-GCM</span><span>RTT 42ms</span></div>
  </section>
</body>
</html>`;

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.setContent(markup, { waitUntil: 'load' });
    await page.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
