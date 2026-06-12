import { Env } from '../types';

export { SSHSessionDO } from './durable-object';

const HTML = `<!DOCTYPE html>
<html class="dark" lang="en">
<head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1.0" name="viewport">
<title>CloudSSH - Connect</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"><\/script>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<script>
tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "background": "#131313",
        "on-surface": "#e5e2e1",
        "on-surface-variant": "#bbccb0",
        "outline": "#86957d",
        "outline-variant": "#3c4b36",
        "primary-container": "#4af626",
        "on-primary-fixed": "#022100",
        "surface": "#131313",
        "surface-variant": "#353534",
        "secondary-container": "#14d1ff",
        "error": "#ffb4ab",
        "error-container": "#93000a"
      },
      fontFamily: {
        "body": ["JetBrains Mono"],
        "headline": ["JetBrains Mono"],
        "label": ["JetBrains Mono"],
        "code": ["JetBrains Mono"]
      }
    }
  }
}
<\/script>
<style>
body {
  background-color: #0a0a0a;
  color: #4af626;
}
.scanlines {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  background: linear-gradient(to bottom, rgba(255,255,255,0), rgba(255,255,255,0) 50%, rgba(0,0,0,0.1) 50%, rgba(0,0,0,0.1));
  background-size: 100% 4px;
  pointer-events: none;
  z-index: 50;
}
.flicker {
  animation: flicker 0.15s infinite;
  pointer-events: none;
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  background: rgba(74, 246, 38, 0.02);
  z-index: 49;
}
@keyframes flicker {
  0% { opacity: 0.8; }
  50% { opacity: 1; }
  100% { opacity: 0.9; }
}
.terminal-input {
  background: transparent;
  border: none;
  border-bottom: 1px solid #3c4b36;
  color: #4af626;
  font-family: 'JetBrains Mono', monospace;
  padding: 8px 0;
  width: 100%;
  outline: none;
  transition: border-color 0.2s;
}
.terminal-input:focus {
  border-bottom: 1px solid #4af626;
  box-shadow: none;
}
.terminal-input::placeholder {
  color: #3c4b36;
}
.blinking-cursor::after {
  content: '\\2588';
  color: #14d1ff;
  animation: blink 1s step-end infinite;
  margin-left: 4px;
  font-size: 0.9em;
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.cyber-box {
  background-color: #121212;
  border: 1px solid #1f1f1f;
}
.cyber-button {
  border: 1px solid #4af626;
  color: #4af626;
  transition: all 0.2s ease;
  position: relative;
  overflow: hidden;
}
.cyber-button:hover {
  background-color: #4af626;
  color: #0a0a0a;
}
#terminal-container .xterm { height: 500px; }
@media (max-width: 768px) { #terminal-container .xterm { height: 400px; } }
</style>
</head>
<body class="min-h-screen flex items-center justify-center p-6 relative overflow-hidden font-body text-sm">
<div class="scanlines"></div>
<div class="flicker"></div>

<!-- Login Form -->
<main id="auth-section" class="w-full max-w-md relative z-10">
  <div class="mb-8 text-center">
    <div class="text-3xl font-bold text-[#4af626] tracking-tighter mb-2">
      CloudSSH<span class="blinking-cursor"></span>
    </div>
  </div>
  <div class="cyber-box p-6 shadow-2xl relative">
    <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[#4af626] to-transparent opacity-50"></div>
    <div class="flex items-center justify-between mb-8 pb-4 border-b border-[#3c4b36]">
      <span class="text-xs font-bold tracking-[0.1em] text-[#14d1ff]">CONNECTION_PARAMETERS</span>
      <span class="material-symbols-outlined text-[#14d1ff]" style="font-variation-settings: 'FILL' 0;">terminal</span>
    </div>
    <form class="space-y-6" id="connection-form">
      <div class="grid grid-cols-4 gap-4">
        <div class="col-span-3">
          <label class="block text-xs font-bold tracking-[0.1em] text-[#bbccb0] mb-2">HOST_ADDRESS</label>
          <div class="flex items-center">
            <span class="text-[#bbccb0] mr-2">&gt;</span>
            <input id="host" class="terminal-input text-[13px]" placeholder="192.168.1.1" type="text" required>
          </div>
        </div>
        <div class="col-span-1">
          <label class="block text-xs font-bold tracking-[0.1em] text-[#bbccb0] mb-2">PORT</label>
          <div class="flex items-center">
            <span class="text-[#bbccb0] mr-2">:</span>
            <input id="port" class="terminal-input text-[13px]" placeholder="22" type="text" value="22">
          </div>
        </div>
      </div>
      <div>
        <label class="block text-xs font-bold tracking-[0.1em] text-[#bbccb0] mb-2">AUTH_USER</label>
        <div class="flex items-center">
          <span class="material-symbols-outlined text-[#bbccb0] mr-2" style="font-size: 16px;">person</span>
          <input id="username" class="terminal-input text-[13px]" placeholder="admin" type="text" required>
        </div>
      </div>
      <div>
        <label class="block text-xs font-bold tracking-[0.1em] text-[#bbccb0] mb-2">AUTH_KEY</label>
        <div class="flex items-center">
          <span class="material-symbols-outlined text-[#bbccb0] mr-2" style="font-size: 16px;">key</span>
          <input id="password" class="terminal-input text-[13px]" placeholder="••••••••" type="password" required>
        </div>
      </div>
      <div class="pt-6">
        <button id="connect-btn" class="cyber-button w-full py-3 px-4 text-xs font-bold tracking-[0.1em] uppercase flex items-center justify-center gap-2 bg-[#4af626] text-[#022100]" type="button">
          <span class="material-symbols-outlined" style="font-size: 18px;">power_settings_new</span>
          Execute_Connection
        </button>
      </div>
      <div class="flex justify-between items-center mt-4">
        <span id="status-text" class="text-[13px] text-[#bbccb0] flex items-center gap-1">
          <span class="w-2 h-2 bg-[#353534] inline-block"></span> STATUS: OFFLINE
        </span>
      </div>
    </form>
  </div>
  <div class="mt-8 text-center text-[13px] text-[#bbccb0] opacity-60">
    SYSTEM READY. WAITING FOR INPUT.
  </div>
  <div class="mt-4 text-center">
    <a href="https://github.com/newbietan/CloudSSH" class="text-[13px] text-[#4af626] opacity-60 hover:opacity-100 transition-colors tracking-widest uppercase">[ GitHub Open Source ]</a>
  </div>
</main>

<!-- Terminal -->
<div id="toolbar" class="hidden fixed top-0 left-0 right-0 z-40 justify-between items-center px-4 py-3 bg-[#121212] border-b border-[#1f1f1f]">
  <span id="connection-info" class="text-[13px] text-[#14d1ff] font-code"></span>
  <button id="disconnect-btn" class="text-xs text-[#ffb4ab] border border-[#ffb4ab] px-3 py-1 hover:bg-[#ffb4ab] hover:text-[#0a0a0a] transition-all">DISCONNECT</button>
</div>
<div id="terminal-container" class="hidden fixed inset-0 pt-12 bg-[#0a0a0a] z-30 p-2"></div>

<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"><\/script>
<script>
let term, ws;
document.getElementById('connect-btn').addEventListener('click', connect);
document.getElementById('disconnect-btn').addEventListener('click', disconnect);
document.getElementById('connection-form').addEventListener('keypress', (e) => { if (e.key === 'Enter') connect(); });

function connect() {
  const host = document.getElementById('host').value;
  const port = document.getElementById('port').value || '22';
  const user = document.getElementById('username').value;
  const pass = document.getElementById('password').value;
  if (!host || !user || !pass) { alert('请填写所有必填字段'); return; }
  document.getElementById('auth-section').style.display = 'none';
  document.getElementById('toolbar').style.display = 'flex';
  document.getElementById('terminal-container').style.display = 'block';
  document.getElementById('connection-info').textContent = user + '@' + host + ':' + port;
  document.getElementById('status-text').innerHTML = '<span class="w-2 h-2 bg-[#4af626] inline-block animate-pulse"></span> STATUS: CONNECTING';
  term = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: '"JetBrains Mono", monospace', theme: { background: '#0a0a0a', foreground: '#4af626', cursor: '#14d1ff' } });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(document.getElementById('terminal-container'));
  fitAddon.fit();
  window.addEventListener('resize', () => fitAddon.fit());
  term.writeln('\\x1b[1;33m[*] Connecting to ' + user + '@' + host + ':' + port + '...\\x1b[0m');
  const wsUrl = 'wss://' + window.location.host + '/api/ssh?host=' + encodeURIComponent(host) + '&port=' + port + '&user=' + encodeURIComponent(user) + '&pass=' + encodeURIComponent(pass);
  ws = new WebSocket(wsUrl);
  ws.onopen = () => { term.writeln('\\x1b[32m[+] WebSocket connected\\x1b[0m'); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      try { const m = JSON.parse(e.data); if (m.type === 'status') term.writeln('\\x1b[32m[*] ' + m.message + '\\x1b[0m'); else if (m.type === 'error') term.writeln('\\x1b[31m[!] ' + m.message + '\\x1b[0m'); } catch { term.write(e.data); }
    } else {
      const r = new FileReader(); r.onload = () => term.write(new Uint8Array(r.result)); r.readAsArrayBuffer(e.data);
    }
  };
  ws.onclose = (e) => { term.writeln('\\x1b[33m[*] Connection closed (code=' + e.code + ')\\x1b[0m'); document.getElementById('status-text').innerHTML = '<span class="w-2 h-2 bg-[#93000a] inline-block"></span> STATUS: DISCONNECTED'; };
  ws.onerror = () => term.writeln('\\x1b[31m[!] Connection error\\x1b[0m');
  term.onData((d) => { if (ws?.readyState === 1) ws.send(d); });
  term.onResize(({cols, rows}) => { if (ws?.readyState === 1) ws.send(JSON.stringify({type:'resize',cols,rows})); });
}

function disconnect() {
  ws?.close(); ws = null; term?.dispose();
  document.getElementById('auth-section').style.display = 'block';
  document.getElementById('toolbar').style.display = 'none';
  document.getElementById('terminal-container').style.display = 'none';
  document.getElementById('status-text').innerHTML = '<span class="w-2 h-2 bg-[#353534] inline-block"></span> STATUS: OFFLINE';
}
<\/script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/ssh') {
      return handleSSHConnection(request, env);
    }

    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok', timestamp: Date.now() });
    }

    return new Response(HTML, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  },
};

async function handleSSHConnection(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return Response.json(
      { error: 'Expected WebSocket upgrade' },
      { status: 426 }
    );
  }

  const url = new URL(request.url);
  const host = url.searchParams.get('host');
  const port = parseInt(url.searchParams.get('port') || '22');
  const username = url.searchParams.get('user');
  const password = url.searchParams.get('pass');

  if (!host || !username || !password) {
    return Response.json(
      { error: 'Missing required parameters: host, user, pass' },
      { status: 400 }
    );
  }

  const doId = env.SSH_SESSION.idFromName(`ssh:${host}:${port}:${username}`);
  const stub = env.SSH_SESSION.get(doId);

  return stub.fetch(request);
}
