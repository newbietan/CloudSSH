import { connect } from 'cloudflare:sockets';
import { desktopConfig, openDesktop } from './desktop';
import { createRdpCheck, PROBE_ORIGIN, type RdpCheckEnv } from './probe';

interface Env extends RdpCheckEnv {
  DESKTOP_ASSETS?: Fetcher;
}

const desktopHeaders = {
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const check = createRdpCheck({
  async checkTcp(ip, port, signal) {
    const socket = connect({ hostname: ip, port });
    const close = () => {
      void socket.close().catch(() => {});
    };
    // The closed promise can reject independently of opened.
    void socket.closed.catch(() => {});
    signal.addEventListener('abort', close, { once: true });
    try {
      if (signal.aborted) return;
      await socket.opened;
    } finally {
      signal.removeEventListener('abort', close);
      close();
    }
  },
  async checkTunnel(host, headers, signal) {
    const response = await fetch(`https://${host}/`, { headers, redirect: 'manual', signal });
    if (response.status === 302 || response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => {});
      return response.status;
    }
    if (response.status !== 101 || !response.webSocket) {
      void response.body?.cancel().catch(() => {});
      throw new Error('tunnel upgrade failed');
    }
    response.webSocket.accept();
    response.webSocket.close(1000, 'Probe finished');
    return 101;
  },
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/desktop/ws/public' || url.pathname === '/desktop/ws/tunnel') {
      return openDesktop(request, env, url.pathname.endsWith('/public') ? 'public' : 'tunnel');
    }
    const path = url.pathname === '/desktop' ? '/index.html' : url.pathname;
    if (['/index.html', '/desktop/config', '/desktop.js', '/sdl-freerdp.js', '/sdl-freerdp.wasm'].includes(path)) {
      const config = desktopConfig(env);
      if (!config || !env.DESKTOP_ASSETS || url.origin !== PROBE_ORIGIN || url.search || request.method !== 'GET') {
        return new Response(null, { status: 404 });
      }
      if (path === '/desktop/config') return Response.json(config, { headers: desktopHeaders });
      const response = await env.DESKTOP_ASSETS.fetch(new Request(new URL(path, url)));
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(desktopHeaders)) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    }
    return check(request, env);
  },
};
