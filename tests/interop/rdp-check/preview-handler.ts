import type { Env } from '../../../src/types';
import { getAuthenticatedUser, initializeAccessIdentity } from '../../../src/worker/auth';
import {
  isPreviewRoute,
  PREVIEW_PATH,
  previewDocumentHeaders,
  readPreviewConfig,
} from './preview-policy';
import type { RdpCheckEnv } from './probe';

export interface PreviewBindings {
  RDP_PREVIEW_CONFIG?: string;
}

export async function verifyPreviewSession(
  request: Request,
  env: Env,
  ctx?: Pick<ExecutionContext, 'access'>
): Promise<boolean> {
  await initializeAccessIdentity(request, ctx);
  return (await getAuthenticatedUser(request, env)) !== null;
}

type File = readonly [asset: string | ArrayBuffer, mime: string];

interface Dependencies<E extends PreviewBindings, C> {
  main(request: Request, env: E, ctx: C): Promise<Response>;
  isAuthenticated(request: Request, env: E, ctx: C): Promise<boolean>;
  open(
    request: Request, targets: RdpCheckEnv, route: 'public' | 'tunnel', origin: string, remainingMs: number
  ): Response;
  files: ReadonlyMap<string, File>;
  gzipWasm?: ArrayBuffer;
  clientTags?: ReadonlyMap<string, string>;
  now?: () => number;
}

const hidden = () => new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });

function acceptsGzip(value: string | null): boolean {
  // Browsers advertise gzip explicitly. Honor an explicit refusal and fail
  // back to the original bytes if the header is missing or malformed.
  for (const item of value?.split(',') ?? []) {
    const match = /^gzip\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.exec(item.trim());
    if (match) return match[1] === undefined || Number(match[1]) > 0;
  }
  return false;
}

export function createPreviewHandler<E extends PreviewBindings, C>(deps: Dependencies<E, C>) {
  const now = deps.now ?? Date.now;
  return async (request: Request, env: E, ctx: C): Promise<Response> => {
    const url = new URL(request.url);
    if (!isPreviewRoute(url.pathname)) return deps.main(request, env, ctx);

    const preview = readPreviewConfig(env.RDP_PREVIEW_CONFIG, now());
    if (url.protocol !== 'https:' || request.method !== 'GET' || url.search || !preview) {
      return hidden();
    }
    const path = url.pathname.slice(PREVIEW_PATH.length);
    const isUpgrade = path === '/ws/public' || path === '/ws/tunnel';
    const gzipWasm = path === '/sdl-freerdp.wasm' ? deps.gzipWasm : undefined;
    const asset = deps.files.get(path === '/' ? '/index.html' : path);
    if (!isUpgrade && path !== '' && path !== '/config' && !asset && !gzipWasm) return hidden();
    if (isUpgrade && (
      request.headers.get('Origin') !== url.origin ||
      request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
    )) return hidden();

    try {
      if (!(await deps.isAuthenticated(request, env, ctx))) return hidden();
    } catch {
      return hidden();
    }

    const remainingMs = preview.expiresAt - now();
    if (remainingMs <= 0) return hidden();
    if (path === '') {
      return new Response(null, {
        status: 302, headers: { Location: PREVIEW_PATH + '/', 'Cache-Control': 'no-store' },
      });
    }
    if (isUpgrade) {
      return deps.open(request, preview.targets, path === '/ws/public' ? 'public' : 'tunnel', url.origin, remainingMs);
    }
    if (path === '/config') {
      return Response.json({ fingerprint: preview.targets.RDP_CHECK_CERT_SHA256, public: true, tunnel: true }, {
        headers: previewDocumentHeaders,
      });
    }
    const headers = new Headers({ ...previewDocumentHeaders, 'Content-Type': gzipWasm ? 'application/wasm' : asset?.[1] ?? '' });
    if (gzipWasm) headers.set('Vary', 'Accept-Encoding');
    const tag = deps.clientTags?.get(path);
    if (tag && /^[0-9a-f]{64}$/.test(tag)) {
      const validator = `"${tag}"`;
      headers.set('Cache-Control', 'private, no-cache, no-transform');
      // Raw and gzip responses decode to the same module; use a weak validator.
      headers.set('ETag', `W/${validator}`);
      const candidates = request.headers.get('If-None-Match');
      if (candidates && candidates.length <= 1024 && candidates.split(',').some((item) => {
        const candidate = item.trim();
        return candidate === '*' || candidate.replace(/^W\//, '') === validator;
      })) return new Response(null, { status: 304, headers });
    }
    if (gzipWasm) {
      if (acceptsGzip(request.headers.get('Accept-Encoding'))) {
        headers.set('Content-Encoding', 'gzip');
        // These bytes are already compressed; don't have Workers encode them again.
        return new Response(gzipWasm, { headers, encodeBody: 'manual' });
      }
      // Uncommon fallback: stream-decode trusted static bytes rather than deploy a second WASM copy.
      const body = new Blob([gzipWasm]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(body, { headers });
    }
    if (!asset) return hidden();
    return new Response(asset[0], { headers });
  };
}
