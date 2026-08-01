import { describe, expect, it } from 'vitest';
import { maskIPAddress } from '../frontend/src/host-display';

describe('maskIPAddress', () => {
  it('masks valid IPv4 literals and rejects invalid ones', () => {
    expect(maskIPAddress('192.168.1.25')).toBe('192.168.*.*');
    expect(maskIPAddress('255.0.255.0')).toBe('255.0.*.*');
    expect(maskIPAddress('999.168.1.25')).toBeNull();
    expect(maskIPAddress('1.2.3')).toBeNull();
  });

  it('masks complete, compressed, bracketed, and scoped IPv6 literals', () => {
    expect(maskIPAddress('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:db8:…');
    expect(maskIPAddress('2001:db8::1')).toBe('2001:db8:…');
    expect(maskIPAddress('[2001:db8::1]')).toBe('2001:db8:…');
    expect(maskIPAddress('fe80::1%en0')).toBe('fe80:0:…');
    expect(maskIPAddress('::ffff:192.0.2.128')).toBe('0:0:…');
  });

  it('does not mask hostnames or malformed IPv6 values', () => {
    expect(maskIPAddress('server.example.com')).toBeNull();
    expect(maskIPAddress('2001:db8:::1')).toBeNull();
    expect(maskIPAddress('2001:db8:1:2:3:4:5:6:7')).toBeNull();
  });
});
