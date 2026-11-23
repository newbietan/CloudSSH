import { parsePublic, parseTunnel, type RdpCheckEnv } from './probe';

export const PREVIEW_PATH = '/__rdp-preview';
const MAX_TEST_WINDOW_MS = 24 * 60 * 60 * 1000;

export function readPreviewConfig(raw: string | undefined, now = Date.now()) {
  if (!raw || raw.length > 2048) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { expiresAt, publicIp, publicPort, tunnelHost, certificate } = parsed as Record<string, unknown>;
    if (
      typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now || expiresAt - now > MAX_TEST_WINDOW_MS ||
      typeof publicIp !== 'string' || typeof publicPort !== 'string' || typeof tunnelHost !== 'string' ||
      typeof certificate !== 'string' || !/^[a-f0-9]{64}$/.test(certificate)
    ) return null;
    const targets: RdpCheckEnv = {
      RDP_CHECK_ENABLE_DESKTOP: '1', RDP_CHECK_PUBLIC_IP: publicIp, RDP_CHECK_PUBLIC_PORT: publicPort,
      RDP_CHECK_TUNNEL_HOST: tunnelHost, RDP_CHECK_CERT_SHA256: certificate,
    };
    if (!parsePublic(targets) || !parseTunnel(targets)) return null;
    return { expiresAt, targets };
  } catch {
    return null;
  }
}

export function isPreviewRoute(path: string): boolean {
  return path === PREVIEW_PATH || path.startsWith(PREVIEW_PATH + '/');
}

export const previewDocumentHeaders = {
  'Cache-Control': 'private, no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
