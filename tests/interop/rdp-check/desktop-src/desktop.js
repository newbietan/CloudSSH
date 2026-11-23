const status = document.getElementById('status');
const canvas = document.getElementById('canvas');
const disconnect = document.getElementById('disconnect');
const routes = ['public', 'tunnel'];
const preview = location.pathname.startsWith('/__rdp-preview/');
const base = preview ? '/__rdp-preview/' : '/';
const buttons = Object.fromEntries(routes.map((route) => [route, document.getElementById(route)]));

async function start() {
  if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') {
    status.textContent = '当前浏览器未启用共享内存，无法启动 FreeRDP。';
    return;
  }
  const response = await fetch(preview ? base + 'config' : '/desktop/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('missing config');
  const config = await response.json();
  if (!/^[0-9a-f]{64}$/.test(config.fingerprint)) throw new Error('missing pin');
  status.textContent = '请选择线路。';
  for (const route of routes) {
    if (!config[route]) continue;
    const button = buttons[route];
    button.disabled = false;
    button.addEventListener('click', () => {
      for (const b of Object.values(buttons)) b.disabled = true;
      disconnect.disabled = false;
      status.textContent = '正在初始化 FreeRDP；请在画布内操作。';
      const ws = new URL((preview ? base : '/desktop/') + 'ws/' + route, location.origin);
      ws.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const closed = () => { status.textContent = '连接已结束。点击断开／重试可重新选择线路。'; };
      const failed = () => { status.textContent = 'FreeRDP 启动失败。点击断开／重试可重新选择线路。'; };
      window.Module = {
        canvas,
        websocket: { url: ws.href, subprotocol: null },
        print() {},
        printErr() {},
        onExit: closed,
        onAbort: failed,
        onRuntimeInitialized() {
          status.textContent = '正在建立所选线路。';
          window.Module.websocket.on?.('open', () => {
            status.textContent = '网页转发通道已打开；正在验证 Windows 证书，等待画布显示。';
          });
          window.Module.websocket.on?.('error', () => {
            status.textContent = '所选线路的网页转发失败。请断开后重试。';
          });
          canvas.focus();
          setTimeout(() => {
            try {
              const result = window.Module.callMain([
                '/v:127.0.0.1:3389', '/u:Administrator', '/sec:nla',
                '/cert:deny,fingerprint:sha256:' + config.fingerprint,
                '/size:1280x720', '-clipboard', '-auto-reconnect', '/audio-mode:2', '/log-level:OFF',
              ]);
              if (result && typeof result.then === 'function') result.then(closed, failed);
            } catch { failed(); }
          });
        },
      };
      const script = document.createElement('script');
      script.src = base + 'sdl-freerdp.js';
      script.addEventListener('error', failed, { once: true });
      document.head.append(script);
    }, { once: true });
  }
}

disconnect.addEventListener('click', () => location.reload());
start().catch(() => { status.textContent = '缺少本地双线路或证书配置。'; });
