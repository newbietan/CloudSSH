import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isBlockedIP, checkHostResolved, clearDnsCache } from '../../src/worker/dns-check';
import { validateBaseUrlWithDNS } from '../../src/worker/agent/ssrf';

// =====================================================================
// dns-check.test.ts
// ---------------------------------------------------------------
// Tests for the DNS rebinding defence layer (VULN-01 / VULN-02 fix).
//
// Three layers of tests:
//   1. isBlockedIP — unified IP range check (pure function)
//   2. checkHostResolved — DoH resolution + IP check (mocked fetch)
//   3. validateBaseUrlWithDNS — end-to-end AI base_url validation
// =====================================================================

// ── Mock global fetch for DoH ──────────────────────────────────────────

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as any).fetch = fetchMock;
  clearDnsCache();
});
afterEach(() => {
  (globalThis as any).fetch = undefined as any;
});

/** Helper: build a DoH JSON response */
function dohResponse(answers: Array<{ type: number; data: string }>): Response {
  return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
    headers: { 'Content-Type': 'application/dns-json' },
  });
}

// =====================================================================
// 1. isBlockedIP — pure function, no network
// =====================================================================

describe('isBlockedIP — IPv4', () => {
  it('blocks private ranges', () => {
    expect(isBlockedIP('127.0.0.1')).toBe(true);
    expect(isBlockedIP('10.0.0.1')).toBe(true);
    expect(isBlockedIP('192.168.1.1')).toBe(true);
    expect(isBlockedIP('169.254.1.1')).toBe(true);
    expect(isBlockedIP('172.16.0.1')).toBe(true);
    expect(isBlockedIP('172.31.255.255')).toBe(true);
    expect(isBlockedIP('0.0.0.0')).toBe(true);
    expect(isBlockedIP('255.255.255.255')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isBlockedIP('8.8.8.8')).toBe(false);
    expect(isBlockedIP('1.1.1.1')).toBe(false);
    expect(isBlockedIP('93.184.216.34')).toBe(false);
    expect(isBlockedIP('172.32.0.1')).toBe(false); // outside 172.16/12
  });
});

describe('isBlockedIP — IPv6', () => {
  it('blocks loopback in all forms', () => {
    expect(isBlockedIP('::1')).toBe(true);
    expect(isBlockedIP('0:0:0:0:0:0:0:1')).toBe(true);
    // VULN-04 fix: expanded form must also be blocked
    expect(isBlockedIP('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
  });

  it('blocks unspecified address', () => {
    expect(isBlockedIP('::')).toBe(true);
    expect(isBlockedIP('0:0:0:0:0:0:0:0')).toBe(true);
  });

  it('blocks link-local fe80::/10', () => {
    expect(isBlockedIP('fe80::1')).toBe(true);
    expect(isBlockedIP('fe90::1')).toBe(true);
    expect(isBlockedIP('fea0::1')).toBe(true);
    expect(isBlockedIP('feb0::1')).toBe(true);
  });

  it('blocks unique local fc00::/7', () => {
    expect(isBlockedIP('fc00::1')).toBe(true);
    expect(isBlockedIP('fd00::1')).toBe(true);
    expect(isBlockedIP('fd12:3456:7890::1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 in all forms (VULN-03 fix)', () => {
    // dotted-decimal
    expect(isBlockedIP('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIP('::ffff:10.0.0.1')).toBe(true);
    // hex — was a bypass in isBlockedHost but isBlockedIP catches it
    expect(isBlockedIP('::ffff:7f00:1')).toBe(true);
    expect(isBlockedIP('::ffff:a00:1')).toBe(true);
  });

  it('allows public IPv6', () => {
    expect(isBlockedIP('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    expect(isBlockedIP('2001:4860:4860::8888')).toBe(false);
  });
});

// =====================================================================
// 2. checkHostResolved — DNS resolution + IP check
// =====================================================================

describe('checkHostResolved — IP literal (no DNS needed)', () => {
  it('blocks internal IPv4 directly', async () => {
    const r = await checkHostResolved('192.168.1.1');
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('192.168.1.1');
  });

  it('blocks ::ffff:7f00:1 (VULN-03 hex form)', async () => {
    const r = await checkHostResolved('::ffff:7f00:1');
    expect(r.blocked).toBe(true);
  });

  it('blocks expanded IPv6 loopback (VULN-04)', async () => {
    const r = await checkHostResolved('0000:0000:0000:0000:0000:0000:0000:0001');
    expect(r.blocked).toBe(true);
  });

  it('allows public IP', async () => {
    const r = await checkHostResolved('8.8.8.8');
    expect(r.blocked).toBe(false);
  });

  it('does NOT call fetch for IP literals', async () => {
    await checkHostResolved('127.0.0.1');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('checkHostResolved — domain DNS rebinding defence', () => {
  it('blocks domain resolving to 127.0.0.1 (VULN-01)', async () => {
    fetchMock
      .mockResolvedValueOnce(dohResponse([{ type: 1, data: '127.0.0.1' }]))
      .mockResolvedValueOnce(dohResponse([]));

    const r = await checkHostResolved('evil.rebinding.com');

    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('evil.rebinding.com');
    expect(r.reason).toContain('127.0.0.1');
  });

  it('blocks domain resolving to 169.254.169.254 (cloud metadata)', async () => {
    fetchMock
      .mockResolvedValueOnce(dohResponse([{ type: 1, data: '169.254.169.254' }]))
      .mockResolvedValueOnce(dohResponse([]));

    const r = await checkHostResolved('metadata.evil.com');

    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('169.254.169.254');
  });

  it('blocks domain resolving to IPv6 loopback via AAAA', async () => {
    fetchMock
      .mockResolvedValueOnce(dohResponse([]))
      .mockResolvedValueOnce(dohResponse([{ type: 28, data: '::1' }]));

    const r = await checkHostResolved('ipv6.rebinding.com');

    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('::1');
  });

  it('blocks if ANY resolved IP is internal (A internal, AAAA public)', async () => {
    fetchMock
      .mockResolvedValueOnce(dohResponse([{ type: 1, data: '10.0.0.5' }]))
      .mockResolvedValueOnce(dohResponse([{ type: 28, data: '2606:2800:220:1::1' }]));

    const r = await checkHostResolved('mixed.evil.com');

    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('10.0.0.5');
  });

  it('allows domain resolving to public IPs', async () => {
    fetchMock
      .mockResolvedValueOnce(dohResponse([{ type: 1, data: '93.184.216.34' }]))
      .mockResolvedValueOnce(dohResponse([{ type: 28, data: '2606:2800:220:1:248:1893:25c8:1946' }]));

    const r = await checkHostResolved('api.example.com');

    expect(r.blocked).toBe(false);
  });

  it('fails open when DNS resolution fails', async () => {
    fetchMock.mockRejectedValue(new Error('DNS timeout'));

    const r = await checkHostResolved('unreachable.example.com');

    // Fail open — DNS failure means connection would also fail,
    // so no rebinding risk. String-based check + redirect:manual still in place.
    expect(r.blocked).toBe(false);
  });

  it('uses cache on repeated calls', async () => {
    fetchMock
      .mockResolvedValueOnce(dohResponse([{ type: 1, data: '8.8.8.8' }]))
      .mockResolvedValueOnce(dohResponse([]));

    await checkHostResolved('cached.example.com');
    const r = await checkHostResolved('cached.example.com');

    // Second call should not trigger additional fetch (cached)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.blocked).toBe(false);
  });
});

// =====================================================================
// 3. validateBaseUrlWithDNS — end-to-end AI base_url validation
// =====================================================================

describe('validateBaseUrlWithDNS — string check + DNS check', () => {
  it('blocks internal IP without DNS call (fast path)', async () => {
    const r = await validateBaseUrlWithDNS('https://192.168.1.1/v1');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('内网');
    // No DoH fetch should be made for IP literals
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks domain resolving to internal IP (DNS rebinding)', async () => {
    fetchMock
      .mockResolvedValueOnce(dohResponse([{ type: 1, data: '10.0.0.1' }]))
      .mockResolvedValueOnce(dohResponse([]));

    const r = await validateBaseUrlWithDNS('https://evil.rebinding.com/v1');

    expect(r.valid).toBe(false);
    expect(r.reason).toContain('10.0.0.1');
  });

  it('blocks domain resolving to cloud metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(dohResponse([{ type: 1, data: '169.254.169.254' }]))
      .mockResolvedValueOnce(dohResponse([]));

    const r = await validateBaseUrlWithDNS('https://metadata.evil.com/v1');

    expect(r.valid).toBe(false);
    expect(r.reason).toContain('169.254.169.254');
  });

  it('allows domain resolving to public IP', async () => {
    fetchMock
      .mockResolvedValueOnce(dohResponse([{ type: 1, data: '93.184.216.34' }]))
      .mockResolvedValueOnce(dohResponse([]));

    const r = await validateBaseUrlWithDNS('https://api.openai.com/v1');

    expect(r.valid).toBe(true);
  });

  it('still validates protocol and format (string check first)', async () => {
    const r = await validateBaseUrlWithDNS('file:///etc/passwd');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('协议');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
