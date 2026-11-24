import { expect, it, vi } from 'vitest';
import type { RdpLease } from '../../src/worker/rdp-store';
import { openRdpTransport } from '../../src/worker/rdp-transport';

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('cloudflare:sockets', () => ({ connect }));

it('dials only the validated IPv4 and port in the claimed profile', async () => {
  const profile: RdpLease['profile'] = { id: 'p', revision: 1, name: 'test', route: 'direct', host: '8.8.8.8',
    hasLogin: true, hasAccessToken: false, tags: [], fingerprint: null };
  const open = (changes: Partial<typeof profile>) => openRdpTransport({ id: 'l', profile: { ...profile, ...changes } }, new AbortController().signal);
  for (const changes of [{ port: 0 }, { port: 25 }, { port: 443 }, { port: 65536 }, {}, { host: '127.0.0.1', port: 53389 }]) {
    await expect(open(changes)).rejects.toThrow('invalid_target');
  }
  await expect(open({ route: 'tunnel', host: 'rdp.example.com', port: 53389 })).rejects.toThrow('invalid_tunnel');
  expect(connect).not.toHaveBeenCalled();
  for (const port of [3389, 53389, 65535]) {
    connect.mockReturnValueOnce({ opened: Promise.resolve(), closed: Promise.resolve(), close: async () => {}, writable: new WritableStream() });
    const transport = await open({ port });
    expect(connect).toHaveBeenLastCalledWith({ hostname: profile.host, port });
    transport.close();
  }
});
