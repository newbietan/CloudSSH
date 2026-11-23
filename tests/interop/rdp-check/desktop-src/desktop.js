const status = document.getElementById('status');
const canvas = document.getElementById('canvas');
const disconnect = document.getElementById('disconnect');
const routes = ['public', 'tunnel'];
const preview = location.pathname.startsWith('/__rdp-preview/');
const base = preview ? '/__rdp-preview/' : '/';
const buttons = Object.fromEntries(routes.map((route) => [route, document.getElementById(route)]));
const CONFIG_TIMEOUT_MS = 15_000;
const WASM_TIMEOUT_MS = 90_000;
const STARTUP_TIMEOUT_MS = 30_000;
const RELAY_TIMEOUT_MS = 15_000;

async function compileClient(signal) {
  const response = await fetch(base + 'sdl-freerdp.wasm', {
    cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal,
  });
  if (!response.ok) throw new Error('wasm-http');
  if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/wasm') {
    throw new Error('wasm-type');
  }
  return typeof WebAssembly.compileStreaming === 'function'
    ? WebAssembly.compileStreaming(response)
    : WebAssembly.compile(await response.arrayBuffer());
}

async function connectDesktop(route, fingerprint) {
  for (const button of Object.values(buttons)) button.disabled = true;
  disconnect.disabled = false;
  const ws = new URL((preview ? base : '/desktop/') + 'ws/' + route, location.origin);
  ws.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  const abort = new AbortController();
  let phase = 'wasm';
  let finished = false;
  let timer;
  const watch = (ms, message) => {
    clearTimeout(timer);
    timer = setTimeout(() => finish(message), ms);
  };
  function finish(message) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    abort.abort();
    window.removeEventListener('error', runtimeError);
    window.removeEventListener('unhandledrejection', runtimeError);
    status.textContent = message + ' 点击「断开／重试」。';
  }
  function runtimeError() {
    if (phase === 'runtime') finish('FreeRDP 浏览器运行时或工作线程启动失败。');
  }
  const closed = () => finish('连接已结束。');
  status.textContent = '正在下载并编译 FreeRDP WASM；此时还未连接 Windows。';
  watch(WASM_TIMEOUT_MS, '下载或编译 FreeRDP WASM 超时。');

  let compiled;
  try {
    compiled = await compileClient(abort.signal);
  } catch (error) {
    const messages = {
      'wasm-http': '无法下载 FreeRDP WASM；请确认仍在同一测试域名登录。',
      'wasm-type': 'FreeRDP WASM 响应类型不正确。',
    };
    finish(messages[error?.message] || 'FreeRDP WASM 下载或编译失败。');
    return;
  }
  if (finished) return;
  phase = 'runtime';
  status.textContent = 'WASM 已就绪，正在加载 FreeRDP 浏览器运行时。';
  watch(STARTUP_TIMEOUT_MS, 'FreeRDP 工作线程未就绪，尚未连接 Windows。');
  window.addEventListener('error', runtimeError);
  window.addEventListener('unhandledrejection', runtimeError);

  window.Module = {
    canvas,
    websocket: { url: ws.href, subprotocol: null },
    // Use the already compiled module and pass it to Emscripten's pthreads.
    // This also gives this page control over the HTTP response and startup errors.
    instantiateWasm(imports, receive) {
      // Chromium disallows synchronous instantiation above 8 MB on the main thread.
      void WebAssembly.instantiate(compiled, imports).then((instance) => {
        if (finished) return;
        receive(instance, compiled);
        compiled = undefined;
      }).catch(() => finish('FreeRDP WASM 无法初始化。'));
      return {};
    },
    monitorRunDependencies(count) {
      if (!finished && phase === 'runtime' && count > 0) {
        status.textContent = 'WASM 已就绪，正在启动 FreeRDP 工作线程。';
      }
    },
    print() {},
    printErr() {},
    onExit: closed,
    onAbort: () => finish('FreeRDP 运行时已中止。'),
    onRuntimeInitialized() {
      if (finished) return;
      window.removeEventListener('error', runtimeError);
      window.removeEventListener('unhandledrejection', runtimeError);
      phase = 'connecting';
      status.textContent = 'FreeRDP 已启动，正在建立所选线路。';
      watch(RELAY_TIMEOUT_MS, '网页转发通道未能及时建立。');
      window.Module.websocket.on?.('open', () => {
        if (finished) return;
        clearTimeout(timer);
        status.textContent = '网页转发通道已打开；正在验证 Windows 证书，等待画布显示。';
      });
      window.Module.websocket.on?.('error', () => finish('所选线路的网页转发失败。'));
      window.Module.websocket.on?.('close', closed);
      canvas.focus();
      setTimeout(() => {
        if (finished) return;
        try {
          const result = window.Module.callMain([
            '/v:127.0.0.1:3389', '/u:Administrator', '/sec:nla',
            '/cert:deny,fingerprint:sha256:' + fingerprint,
            '/size:1280x720', '-clipboard', '-auto-reconnect', '/audio-mode:2', '/log-level:OFF',
          ]);
          if (result && typeof result.then === 'function') {
            result.then(closed, () => finish('FreeRDP 会话启动失败。'));
          }
        } catch (error) {
          if (error?.name === 'ExitStatus') closed();
          else finish('FreeRDP 会话启动失败。');
        }
      });
    },
  };
  const script = document.createElement('script');
  script.setAttribute('data-cfasync', 'false');
  script.src = base + 'sdl-freerdp.js';
  script.addEventListener('error', () => finish('无法加载 FreeRDP 浏览器脚本。'), { once: true });
  document.head.append(script);
}

async function start() {
  if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') {
    status.textContent = '当前浏览器未启用共享内存，无法启动 FreeRDP。';
    return;
  }
  const response = await fetch(preview ? base + 'config' : '/desktop/config', {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('missing config');
  const config = await response.json();
  if (!/^[0-9a-f]{64}$/.test(config.fingerprint)) throw new Error('missing pin');
  status.textContent = '请选择线路。';
  for (const route of routes) {
    if (!config[route]) continue;
    const button = buttons[route];
    button.disabled = false;
    button.addEventListener('click', () => { void connectDesktop(route, config.fingerprint); }, { once: true });
  }
}

disconnect.addEventListener('click', () => location.reload());
start().catch(() => { status.textContent = '无法读取 RDP 测试配置，请确认测试站登录及有效期。'; });
