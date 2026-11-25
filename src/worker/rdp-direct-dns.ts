import { RDP_MAX_BODY, isPublicRdpIPv4, normalizePublicRdpIPv6, readRdpJson } from '../rdp-schema';

const DNS_TIMEOUT_MS = 2500;
const MAX_ANSWERS = 64;
const MAX_DIAL_ADDRESSES = 3;

export class RdpDirectDnsError extends Error {
  constructor(readonly code: 'direct_dns_failed' | 'direct_dns_blocked') {
    super(code);
  }
}

async function lookup(host: string, family: 1 | 28, signal: AbortSignal): Promise<string[]> {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${family}`, {
    headers: { Accept: 'application/dns-json' }, cf: { cacheTtl: 0 }, redirect: 'manual', signal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new RdpDirectDnsError('direct_dns_failed');
  }
  // The shared bounded reader also limits chunked responses without Content-Length.
  if (Number(response.headers.get('Content-Length')) > RDP_MAX_BODY) {
    void response.body?.cancel().catch(() => {});
    throw new RdpDirectDnsError('direct_dns_failed');
  }
  const json = await readRdpJson(response, signal) as { Status?: unknown; TC?: unknown; Answer?: unknown } | null;
  signal.throwIfAborted();
  if (json?.Status !== 0 || (json.TC !== undefined && json.TC !== false) ||
      (json.Answer !== undefined && (!Array.isArray(json.Answer) || json.Answer.length > MAX_ANSWERS))) {
    throw new RdpDirectDnsError('direct_dns_failed');
  }
  const addresses = new Set<string>();
  for (const answer of (json.Answer ?? []) as { type?: unknown; data?: unknown }[]) {
    if (!answer || !Number.isInteger(answer.type)) throw new RdpDirectDnsError('direct_dns_failed');
    if (answer.type !== 1 && answer.type !== 28) continue; // e.g. a CNAME in the answer chain
    const ip = answer.data;
    const verified = typeof ip === 'string' && (answer.type === 1
      ? (isPublicRdpIPv4(ip) ? ip : null)
      : normalizePublicRdpIPv6(ip));
    if (!verified) throw new RdpDirectDnsError('direct_dns_blocked');
    if (answer.type === family) addresses.add(verified);
  }
  return [...addresses];
}

/** Resolve both families before any dial. Do not cache app-side or pass DNS names to connect(). */
export async function resolveRdpDirectHost(host: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const lookupSignal = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);
  try {
    const [ipv4, ipv6] = await Promise.all([lookup(host, 1, lookupSignal), lookup(host, 28, lookupSignal)]);
    lookupSignal.throwIfAborted();
    const candidates: string[] = [];
    // Prefer IPv4 when present for continuity, but try the other family before a second IPv4.
    for (let i = 0; i < Math.max(ipv4.length, ipv6.length) && candidates.length < MAX_DIAL_ADDRESSES; i++) {
      if (ipv4[i]) candidates.push(ipv4[i]);
      if (ipv6[i] && candidates.length < MAX_DIAL_ADDRESSES) candidates.push(ipv6[i]);
    }
    if (!candidates.length) throw new RdpDirectDnsError('direct_dns_failed');
    return candidates;
  } catch (err) {
    signal.throwIfAborted();
    if (err instanceof RdpDirectDnsError) throw err;
    throw new RdpDirectDnsError('direct_dns_failed');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
