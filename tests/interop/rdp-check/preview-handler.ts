import {
  isPreviewOwner,
  isPreviewRoute,
  PREVIEW_PATH,
  previewDocumentHeaders,
  readPreviewConfig,
} from './preview-policy';
import type { RdpCheckEnv } from './probe';

export interface PreviewBindings {
  RDP_PREVIEW_CONFIG?: string;
}

type File = readonly [asset: string | ArrayBuffer, mime: string];

interface Dependencies<E extends PreviewBindings, C> {
  main(request: Request, env: E, ctx: C): Promise<Response>;
  getOwner(request: Request, env: E, ctx: C): Promise<string | null>;
  open(
    request: Request, targets: RdpCheckEnv, route: 'public' | 'tunnel', origin: string, remainingMs: number
  ): Response;
  files: ReadonlyMap<string, File>;
  now?: () => number;
}

const hidden = () => new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });

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
    const asset = deps.files.get(path === '/' ? '/index.html' : path);
    if (!isUpgrade && path !== '' && path !== '/config' && !asset) return hidden();
    if (isUpgrade && (
      request.headers.get('Origin') !== url.origin ||
      request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
    )) return hidden();

    try {
      const owner = await deps.getOwner(request, env, ctx);
      if (!owner || !isPreviewOwner(preview.owner, owner)) return hidden();
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
    if (!asset) return hidden();
    return new Response(asset[0], { headers: { ...previewDocumentHeaders, 'Content-Type': asset[1] } });
  };
}
