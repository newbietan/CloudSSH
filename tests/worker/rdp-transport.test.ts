import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RDP_MAX_BODY } from '../../src/rdp-schema';
import type { RdpLease } from '../../src/worker/rdp-store';
import { openRdpTransport } from '../../src/worker/rdp-transport';

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('cloudflare:sockets', () => ({ connect }));

const profile: RdpLease['profile'] = {
  id: 'p', revision: 1, name: 'test', route: 'direct', host: '8.8.8.8', port: 53389,
  hasLogin: true, hasAccessToken: false, tags: [], fingerprint: null,
};
const dnsHost = 'rdp.example.com';
const ipv6 = '2001:4860::1234';
const open = (changes: Partial<typeof profile>, signal = new AbortController().signal) =>
  openRdpTransport({ id: 'l', profile: { ...profile, ...changes } }, signal);

function fakeSocket(opened = Promise.resolve()) {
  return {
    opened, closed: Promise.resolve(), close: vi.fn(async () => {}),
    readable: new ReadableStream({ start: controller => controller.close() }),
    writable: new WritableStream(),
  };
}

function mockDns(read: (type: number, signal: AbortSignal) => Response | Promise<Response>) {
  const query = vi.fn(async (url: string, options: RequestInit) => {
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://cloudflare-dns.com/dns-query');
    expect(parsed.searchParams.get('name')).toBe(dnsHost);
    expect(options.redirect).toBe('manual');
    expect(new Headers(options.headers).get('Accept')).toBe('application/dns-json');
    return read(Number(parsed.searchParams.get('type')), options.signal!);
  });
  vi.stubGlobal('fetch', query);
  return query;
}

const dns = (type: number, ...addresses: string[]) => Response.json({
  Status: 0, Answer: [{ type: 5, data: 'alias.example.net.' }, ...addresses.map(data => ({ type, data }))],
});

beforeEach(() => { connect.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('dials validated IPv4 and bracketed IPv6 literals at the claimed port without DNS', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const changes of [{ port: 0 }, { port: 25 }, { port: 443 }, { port: 65536 }, { port: undefined },
    { host: '127.0.0.1' }, { host: '[::ffff:8.8.8.8]' }, { host: 'fe80::1%en0' }]) {
    await expect(open(changes)).rejects.toThrow('invalid_target');
  }
  await expect(open({ route: 'tunnel', host: dnsHost })).rejects.toThrow('invalid_tunnel');
  expect(connect).not.toHaveBeenCalled();
  for (const port of [3389, 53389, 65535]) {
    connect.mockReturnValueOnce(fakeSocket());
    const transport = await open({ port });
    expect(connect).toHaveBeenLastCalledWith({ hostname: profile.host, port });
    transport.close();
  }
  connect.mockReturnValueOnce(fakeSocket());
  const transport = await open({ host: '[2001:4860:0:0:0:0:0:1234]' });
  expect(connect).toHaveBeenLastCalledWith({ hostname: `[${ipv6}]`, port: 53389 });
  transport.close();
  expect(fetch).not.toHaveBeenCalled();
});

it('dials only the newly resolved literal when DDNS changes between sessions, including AAAA-only', async () => {
  let useV6 = false;
  const query = mockDns(type => useV6 && type === 28 ? dns(type, ipv6) :
    !useV6 && type === 1 ? dns(type, '9.9.9.9') : Response.json({ Status: 0 }));
  connect.mockImplementation(() => fakeSocket());
  (await open({ host: 'RDP.Example.COM.' })).close();
  useV6 = true;
  (await open({ host: dnsHost })).close();
  expect(query).toHaveBeenCalledTimes(4);
  expect(connect.mock.calls).toEqual([
    [{ hostname: '9.9.9.9', port: 53389 }],
    [{ hostname: `[${ipv6}]`, port: 53389 }],
  ]);
});

it('falls back to the other family after bounded TCP timeout and never retries after a socket opens', async () => {
  vi.useFakeTimers();
  mockDns(type => type === 1 ? dns(type, '9.9.9.9', '8.8.8.8') : dns(type, ipv6));
  let lateOpen!: () => void;
  const stalled = fakeSocket(new Promise<void>(resolve => { lateOpen = resolve; }));
  const alive = fakeSocket();
  connect.mockReturnValueOnce(stalled).mockReturnValueOnce(alive);
  const pending = open({ host: dnsHost });
  await vi.advanceTimersByTimeAsync(1999);
  expect(connect).toHaveBeenCalledExactlyOnceWith({ hostname: '9.9.9.9', port: 53389 });
  await vi.advanceTimersByTimeAsync(1);
  const transport = await pending;
  expect(stalled.close).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenLastCalledWith({ hostname: `[${ipv6}]`, port: 53389 });
  lateOpen();
  await transport.read(vi.fn()); // Upstream EOF after TCP open isn't a reason to replay RDP.
  transport.close();
  expect(connect).toHaveBeenCalledTimes(2);
  expect(alive.close).toHaveBeenCalledOnce();
});

it('caps failed connection attempts and deduplicates answers', async () => {
  mockDns(type => type === 1 ? dns(type, '9.9.9.9', '9.9.9.9', '8.8.8.8', '1.1.1.1') : dns(type, ipv6, '2001:4860::5555'));
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  connect.mockImplementation(() => {
    const socket = fakeSocket(Promise.reject(new Error('connection refused')));
    sockets.push(socket);
    return socket;
  });
  await expect(open({ host: dnsHost })).rejects.toThrow('dial_failed');
  expect(connect.mock.calls.map(([target]) => target.hostname)).toEqual(['9.9.9.9', `[${ipv6}]`, '8.8.8.8']);
  for (const socket of sockets) expect(socket.close).toHaveBeenCalledOnce();
});

it.each([
  [1, '127.0.0.1'], [1, '100.64.0.2'], [1, '198.18.1.1'], [1, '224.0.0.1'], [1, '9.009.9.9'],
  [28, '::ffff:7f00:1'], [28, 'fc00::1'], [28, '2001:db8::1'], [28, '2002:7f00:1::1'], [28, '3fff:0fff::1'],
])('rejects the entire DNS result when type %s includes %s', async (badType, host) => {
  mockDns(type => type === badType ? dns(type, type === 1 ? '9.9.9.9' : ipv6, host) : dns(type, type === 1 ? '8.8.8.8' : ipv6));
  await expect(open({ host: dnsHost })).rejects.toThrow('direct_dns_blocked');
  expect(connect).not.toHaveBeenCalled();
});

it.each([
  () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.com' } }),
  () => Response.json({ Status: 2 }),
  () => Response.json({ Status: 0, TC: true }),
  () => Response.json({ Status: 0, Answer: [null] }),
  () => dns(28, ...Array<string>(65).fill(ipv6)),
  () => new Response(' '.repeat(RDP_MAX_BODY + 1)),
])('fails closed when one DNS query is invalid, even with usable results from the other', async invalid => {
  mockDns(type => type === 1 ? dns(type, '9.9.9.9') : invalid());
  await expect(open({ host: dnsHost })).rejects.toThrow('direct_dns_failed');
  expect(connect).not.toHaveBeenCalled();
});

it('does not dial when there are no addresses in either DNS answer', async () => {
  mockDns(type => dns(type));
  await expect(open({ host: dnsHost })).rejects.toThrow('direct_dns_failed');
  expect(connect).not.toHaveBeenCalled();
});

it('times out and cancels a stalled DNS body before dialing anything', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  mockDns(type => type === 1 ? dns(type, '9.9.9.9') : new Response(new ReadableStream({ cancel })));
  const rejected = expect(open({ host: dnsHost })).rejects.toThrow('direct_dns_failed');
  await vi.advanceTimersByTimeAsync(2500);
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(connect).not.toHaveBeenCalled();
});

it('cancels the active dial on disconnect, without attempting another address', async () => {
  vi.useFakeTimers();
  mockDns(type => type === 1 ? dns(type, '9.9.9.9') : dns(type, ipv6));
  const socket = fakeSocket(new Promise(() => {}));
  connect.mockReturnValueOnce(socket);
  const controller = new AbortController();
  const rejected = expect(open({ host: dnsHost }, controller.signal)).rejects.toThrow('disconnected');
  await vi.advanceTimersByTimeAsync(0);
  expect(connect).toHaveBeenCalledOnce();
  controller.abort(new Error('disconnected'));
  await rejected;
  expect(socket.close).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not route a Tunnel through literal dialing or send Access headers to DoH', async () => {
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    const parsed = new URL(url);
    const headers = new Headers(options.headers);
    if (parsed.hostname === 'cloudflare-dns.com') {
      expect(headers.get('CF-Access-Client-Id')).toBeNull();
      expect(headers.get('CF-Access-Client-Secret')).toBeNull();
      const type = Number(parsed.searchParams.get('type'));
      return type === 1 ? dns(type, '9.9.9.9') : dns(type);
    }
    expect(url).toBe(`https://${dnsHost}/`);
    expect(options.redirect).toBe('manual');
    expect(headers.get('CF-Access-Client-Id')).toBe('id');
    expect(headers.get('CF-Access-Client-Secret')).toBe('secret');
    return new Response(null, { status: 403 });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(openRdpTransport({ id: 'l', profile: { ...profile, host: dnsHost, route: 'tunnel', port: undefined },
    accessId: 'id', accessSecret: 'secret' }, new AbortController().signal)).rejects.toThrow('tunnel_unavailable');
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(connect).not.toHaveBeenCalled();
});
