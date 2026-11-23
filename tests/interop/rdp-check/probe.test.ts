import { describe, expect, it, vi } from 'vitest';
import { createRdpCheck, PROBE_ORIGIN, type RdpCheckEnv, type RdpCheckIO } from './probe';

const env: RdpCheckEnv = {
  RDP_CHECK_PUBLIC_IP: '93.184.215.14',
  RDP_CHECK_TUNNEL_HOST: 'rdp.example.com',
  RDP_CHECK_ACCESS_ID: 'test-id',
  RDP_CHECK_ACCESS_SECRET: 'sensitive-test-secret',
};

function fixture() {
  const checkTcp = vi.fn(async (_ip: string, _port: number, _signal: AbortSignal) => {});
  const checkTunnel = vi.fn<RdpCheckIO['checkTunnel']>(async () => 101);
  return { checkTcp, checkTunnel, request: createRdpCheck({ checkTcp, checkTunnel }, 50) };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`${PROBE_ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: PROBE_ORIGIN },
    ...init,
  });
}

describe('local-only RDP reachability checker', () => {
  it('checks the fixed public IPv4 and defaults to 3389', async () => {
    const { request, checkTcp, checkTunnel } = fixture();
    const response = await request(
      req('/check/public', {
        headers: { Origin: PROBE_ORIGIN, 'Content-Length': '0' },
        body: '',
      }),
      env
    );
    expect(await response.json()).toEqual({ code: 'direct_tcp_open' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(checkTcp).toHaveBeenCalledOnce();
    expect(checkTcp).toHaveBeenCalledWith('93.184.215.14', 3389, expect.any(AbortSignal));
    expect(checkTunnel).not.toHaveBeenCalled();
  });

  it('only sends configured Access headers to the fixed tunnel host', async () => {
    const { request, checkTcp, checkTunnel } = fixture();
    const response = await request(
      req('/check/tunnel', {
        headers: { Origin: PROBE_ORIGIN, 'CF-Access-Client-Secret': 'browser-provided' },
      }),
      env
    );
    expect(await response.json()).toEqual({ code: 'tunnel_ws_open' });
    expect(checkTcp).not.toHaveBeenCalled();
    expect(checkTunnel).toHaveBeenCalledOnce();
    const [[host, headers]] = checkTunnel.mock.calls;
    expect(host).toBe('rdp.example.com');
    expect(headers.get('upgrade')).toBe('websocket');
    expect(headers.get('cf-access-client-id')).toBe('test-id');
    expect(headers.get('cf-access-client-secret')).toBe('sensitive-test-secret');
  });

  it('rejects non-local, cross-origin, unknown and request-controlled targets before dialing', async () => {
    const { request, checkTcp, checkTunnel } = fixture();
    const attempts: [Request, number][] = [
      [new Request('https://rdp.example.org/check/public', { method: 'POST' }), 404],
      [req('/check/public', { method: 'GET' }), 405],
      [req('/check/public', { headers: {} }), 403],
      [req('/check/tunnel', { headers: { Origin: 'https://other.example.org' } }), 403],
      [req('/check/public?port=1234'), 404],
      [req('/check/tunnel', { body: '{"host":"other.example.org"}' }), 400],
      [req('/check/public', { headers: { Origin: PROBE_ORIGIN, 'Content-Length': '4' } }), 400],
      [req('/check/public', { headers: { Origin: PROBE_ORIGIN, 'Transfer-Encoding': 'chunked' } }), 400],
      [req('/check/other'), 404],
    ];
    for (const [attempt, status] of attempts) expect((await request(attempt, env)).status).toBe(status);
    expect(checkTcp).not.toHaveBeenCalled();
    expect(checkTunnel).not.toHaveBeenCalled();
  });

  it.each(['', '127.0.0.1', '192.168.1.4', '100.64.1.4', '203.0.113.4', '93.184.215.014'])(
    'rejects non-public or ambiguous IPv4 %j',
    async (ip) => {
      const { request, checkTcp } = fixture();
      expect((await request(req('/check/public'), { ...env, RDP_CHECK_PUBLIC_IP: ip })).status)
        .toBe(400);
      expect(checkTcp).not.toHaveBeenCalled();
    }
  );

  it('rejects missing token halves, URL-style hosts and bad ports', async () => {
    const { request, checkTcp, checkTunnel } = fixture();
    expect((await request(req('/check/tunnel'), { ...env, RDP_CHECK_ACCESS_SECRET: '' })).status)
      .toBe(400);
    expect((await request(req('/check/tunnel'), {
      ...env,
      RDP_CHECK_TUNNEL_HOST: 'https://rdp.example.com/path',
    })).status).toBe(400);
    expect((await request(req('/check/public'), { ...env, RDP_CHECK_PUBLIC_PORT: '65536' })).status)
      .toBe(400);
    expect(checkTcp).not.toHaveBeenCalled();
    expect(checkTunnel).not.toHaveBeenCalled();
  });

  it('reports access denial or unreachable without leaking upstream errors', async () => {
    const { request, checkTcp, checkTunnel } = fixture();
    for (const status of [302, 401, 403] as const) {
      checkTunnel.mockResolvedValueOnce(status);
      const response = await request(req('/check/tunnel'), env);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ code: 'tunnel_access_denied' });
    }
    checkTcp.mockRejectedValueOnce(new Error('host/port/private-token'));
    const response = await request(req('/check/public'), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: 'unreachable' });
  });

  it('allows one attempt at a time, aborts on deadline and allows a later attempt', async () => {
    vi.useFakeTimers();
    try {
      const { request, checkTcp } = fixture();
      checkTcp.mockImplementationOnce(async (_ip, _port, _signal) => new Promise(() => {}));
      const pending = request(req('/check/public'), env);
      expect((await request(req('/check/tunnel'), env)).status).toBe(409);
      await vi.advanceTimersByTimeAsync(50);
      expect((await pending).status).toBe(504);
      expect(checkTcp.mock.calls[0][2].aborted).toBe(true);
      expect((await request(req('/check/public'), env)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
