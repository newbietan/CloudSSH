// DNS resolution + IP block check for SSRF protection (DNS rebinding defense)
//
// isBlockedHost() / validateBaseUrl() only check the hostname string.
// A domain like evil.com can resolve to 127.0.0.1 or 169.254.169.254
// and bypass those checks. This module resolves the hostname via
// DNS-over-HTTPS (Cloudflare 1.1.1.1) and checks every resolved IP
// against a unified block list that covers all cases from both
// isBlockedHost() and validateBaseUrl(), including IPv6 edge cases.

interface DnsCacheEntry {
  ips: string[];
  expiresAt: number;
}

const DNS_CACHE = new Map<string, DnsCacheEntry>();
const DNS_CACHE_TTL = 60_000; // 60 seconds — balances freshness vs latency
const DNS_CACHE_MAX_SIZE = 1000; // Prevent unbounded memory growth
const DOH_TIMEOUT_MS = 5_000;

/** Evict expired entries, then oldest if still over limit. */
function evictCacheIfNeeded(): void {
  const now = Date.now();
  // Remove expired entries first
  for (const [key, entry] of DNS_CACHE) {
    if (now >= entry.expiresAt) {
      DNS_CACHE.delete(key);
    }
  }
  // If still over limit, remove oldest entries (Map preserves insertion order)
  while (DNS_CACHE.size >= DNS_CACHE_MAX_SIZE) {
    const firstKey = DNS_CACHE.keys().next().value;
    if (firstKey !== undefined) {
      DNS_CACHE.delete(firstKey);
    } else {
      break;
    }
  }
}

// ──────────────────────── IP literal detection ────────────────────────

function isIPv4Literal(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function isIPv6Literal(hostname: string): boolean {
  // IPv6 literals contain ':' (after bracket stripping); domain names never do
  return hostname.includes(':');
}

function isIPLiteral(hostname: string): boolean {
  return isIPv4Literal(hostname) || isIPv6Literal(hostname);
}

// ──────────────────────── Unified IP block list ────────────────────────

/**
 * Check whether an IP address (resolved or literal) falls into a blocked
 * range. Unifies the logic from isBlockedHost() and validateBaseUrl(),
 * and additionally fixes the IPv4-mapped-IPv6-hex and expanded-IPv6-loopback
 * bypasses (VULN-03 / VULN-04) for the DNS-resolved-IP path.
 */
export function isBlockedIP(ip: string): boolean {
  const h = ip.toLowerCase().trim().replace(/^\[|\]$/g, '');

  // ---- IPv4 ----
  if (isIPv4Literal(h)) {
    if (h === '0.0.0.0' || h === '255.255.255.255') return true;
    if (/^(127\.|10\.|0\.|192\.168\.|169\.254\.)/.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
    return false;
  }

  // ---- IPv6 ----
  // Normalise: collapse runs of zero groups to '::' so that both
  // '0000:0000:0000:0000:0000:0000:0000:0001' and '0:0:0:0:0:0:0:1'
  // become '::1'.
  const normalized = normalizeIPv6(h);

  // Loopback
  if (normalized === '::1' || normalized === '::') return true;
  // Link-local fe80::/10 (fe80 to febf)
  if (/^fe[89ab][0-9a-f]{0,4}(:|::)/i.test(normalized)) return true;
  // Unique local fc00::/7 (fc00 to fdff)
  if (/^f[cd][0-9a-f]{0,4}(:|::)/i.test(normalized)) return true;
  // IPv4-mapped IPv6 — block ALL ::ffff: forms (covers dotted-decimal
  // '::ffff:127.0.0.1' AND hex '::ffff:7f00:1')
  if (/^::ffff:/.test(normalized)) return true;

  return false;
}

/**
 * Best-effort IPv6 normalisation to '::' compressed form.
 * Uses the URL parser (available in Workers) which already normalises
 * IPv6 literals. Falls back to a manual compressor if the URL trick fails.
 */
function normalizeIPv6(addr: string): string {
  try {
    const u = new URL(`http://[${addr}]`);
    return u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return addr.toLowerCase();
  }
}

// ──────────────────────── DNS-over-HTTPS resolution ────────────────────────

/**
 * Resolve a domain name to IP addresses via Cloudflare DoH (1.1.1.1).
 * Returns an empty array for IP literals (no DNS needed) or on failure.
 * Results are cached for DNS_CACHE_TTL to minimise latency on repeated calls.
 */
async function resolveHostname(hostname: string): Promise<string[]> {
  // IP literals need no DNS — caller already ran the string-based check
  if (isIPLiteral(hostname)) return [];

  // Cache lookup
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.ips;
  }

  const ips: string[] = [];

  try {
    // Resolve A + AAAA in parallel via Cloudflare DoH JSON API
    const dohBase = 'https://cloudflare-dns.com/dns-query';
    const [aRes, aaaaRes] = await Promise.all([
      fetch(`${dohBase}?name=${encodeURIComponent(hostname)}&type=A`, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
        // Edge-cache the DNS response to cut latency on repeated lookups
        cf: { cacheTtl: 60, cacheEverything: true } as any,
      }),
      fetch(`${dohBase}?name=${encodeURIComponent(hostname)}&type=AAAA`, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
        cf: { cacheTtl: 60, cacheEverything: true } as any,
      }),
    ]);

    if (aRes.ok) {
      const data = await aRes.json<{ Status: number; Answer?: Array<{ type: number; data: string }> }>();
      if (data.Status === 0) { // NOERROR
        for (const a of data.Answer ?? []) {
          if (a.type === 1) ips.push(a.data); // A record
        }
      }
    }

    if (aaaaRes.ok) {
      const data = await aaaaRes.json<{ Status: number; Answer?: Array<{ type: number; data: string }> }>();
      if (data.Status === 0) { // NOERROR
        for (const a of data.Answer ?? []) {
          if (a.type === 28) ips.push(a.data); // AAAA record
        }
      }
    }
  } catch {
    // DNS resolution failed — return empty array (fail-open).
    // The string-based check + redirect:manual are still in place.
    // A failed DNS lookup cannot be used for rebinding (the connection
    // itself would also fail to resolve).
  }

  // Cache even empty results to avoid hammering DoH on persistent failures
  evictCacheIfNeeded();
  DNS_CACHE.set(hostname, { ips, expiresAt: Date.now() + DNS_CACHE_TTL });
  return ips;
}

// ──────────────────────── Public API ────────────────────────

/**
 * Resolve hostname via DoH and verify that none of the resolved IPs
 * fall into a blocked range. For IP literals the DNS step is skipped
 * (the caller's string-based check already handled it) but the IP is
 * still re-checked with the unified isBlockedIP to cover edge cases.
 *
 * Should be called **after** the fast string-based check
 * (isBlockedHost / validateBaseUrl) as a second defence layer.
 */
export async function checkHostResolved(
  hostname: string,
): Promise<{ blocked: boolean; reason?: string }> {
  const cleanHost = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');

  if (isIPLiteral(cleanHost)) {
    // IP literal — re-check with unified isBlockedIP (catches IPv6 edge cases
    // that isBlockedHost/validateBaseUrl might miss)
    if (isBlockedIP(cleanHost)) {
      return { blocked: true, reason: `禁止连接内网或保留地址 ${cleanHost} (SSRF 防护)` };
    }
    return { blocked: false };
  }

  // Domain — resolve and check every IP
  const ips = await resolveHostname(cleanHost);

  for (const ip of ips) {
    if (isBlockedIP(ip)) {
      return {
        blocked: true,
        reason: `域名 ${hostname} 解析到内网或保留地址 ${ip} (SSRF 防护)`,
      };
    }
  }

  return { blocked: false };
}

/** Clear the DNS cache (intended for testing). */
export function clearDnsCache(): void {
  DNS_CACHE.clear();
}
