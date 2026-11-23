import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('./desktop-src/desktop.js', import.meta.url), 'utf8');
const config = { fingerprint: '1'.repeat(64), public: true, tunnel: true };

function fixture() {
  let choose: () => void = () => {};
  const status = { textContent: '' };
  const button = { disabled: true, addEventListener: (_: string, callback: () => void) => { choose = callback; } };
  const disconnect = { disabled: true, addEventListener: vi.fn() };
  const append = vi.fn();
  const wasmURL = '/__rdp-preview/sdl-freerdp.wasm';
  const fetchResource = vi.fn(async (url: string, _options?: RequestInit) => url === wasmURL
    ? new Response('wasm', { headers: { 'Content-Type': 'application/wasm' } })
    : Response.json({ ...config, tunnel: false }));
  const module = {};
  const instance = {};
  const compileStreaming = vi.fn(async () => module);
  const instantiate = vi.fn(async () => instance);
  const window = { addEventListener: vi.fn(), removeEventListener: vi.fn(), Module: undefined } as {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    Module?: { instantiateWasm: (imports: object, receive: (instance: object, module: object) => void) => object };
  };
  const canvas = { focus: vi.fn() };
  const elements: Record<string, object> = { status, canvas, disconnect, public: button, tunnel: { disabled: true } };
  runInNewContext(script, {
    crossOriginIsolated: true, SharedArrayBuffer, AbortSignal, AbortController, URL,
    location: { pathname: '/__rdp-preview/', origin: 'https://test.example', protocol: 'https:' },
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    window,
    fetch: fetchResource, WebAssembly: { compileStreaming, instantiate },
    document: { getElementById: (id: string) => elements[id], head: { append }, createElement: () => ({ setAttribute: vi.fn(), addEventListener: vi.fn() }) },
  });
  return { status, append, fetchResource, compileStreaming, instantiate, module, instance, window, click: () => choose() };
}

describe('FreeRDP browser startup', () => {
  it('compiles the same-origin WASM first and instantiates it asynchronously', async () => {
    const app = fixture();
    await vi.waitFor(() => expect(app.status.textContent).toContain('请选择线路'));
    app.click();
    await vi.waitFor(() => expect(app.append).toHaveBeenCalledOnce());
    expect(app.fetchResource).toHaveBeenLastCalledWith('/__rdp-preview/sdl-freerdp.wasm', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
    expect(app.compileStreaming).toHaveBeenCalledOnce();
    const receive = vi.fn();
    app.window.Module?.instantiateWasm({ shim: true }, receive);
    expect(receive).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledWith(app.instance, app.module));
    expect(app.instantiate).toHaveBeenCalledWith(app.module, { shim: true });
  });

  it('reports a non-WASM response instead of leaving the preview on a black screen', async () => {
    const app = fixture();
    await vi.waitFor(() => expect(app.status.textContent).toContain('请选择线路'));
    app.fetchResource.mockResolvedValueOnce(new Response('<html>expired session</html>', { headers: { 'Content-Type': 'text/html' } }));
    app.click();
    await vi.waitFor(() => expect(app.status.textContent).toContain('响应类型不正确'));
    expect(app.append).not.toHaveBeenCalled();
  });

  it('reports an initialization timeout and ignores a late compile result', async () => {
    const app = fixture();
    await vi.waitFor(() => expect(app.status.textContent).toContain('请选择线路'));
    vi.useFakeTimers();
    try {
      let complete = () => {};
      app.compileStreaming.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve(app.module); }));
      app.click();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(app.status.textContent).toContain('下载或编译 FreeRDP WASM 超时');
      complete();
      await vi.advanceTimersByTimeAsync(0);
      expect(app.append).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
