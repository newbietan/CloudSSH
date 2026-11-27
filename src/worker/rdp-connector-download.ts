import {
  RDP_CONNECTOR_DOWNLOAD,
  RDP_CONNECTOR_FILENAME,
  RDP_CONNECTOR_MAX_DOWNLOAD,
} from '../rdp-schema';

const assetPath = /^\/[a-z0-9/_-]{12,350}$/i;
const assetHosts = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const unavailable = () =>
  Response.json(
    { code: 'connector_download_unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } }
  );
const packageHeaders = (size: number) => ({
  'Content-Type': 'application/zip',
  'Content-Length': String(size),
  'Content-Disposition': `attachment; filename="${RDP_CONNECTOR_FILENAME}"`,
  'Cache-Control': 'private, no-store, no-transform',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
});

/** Fixed published release only. No user URLs, credentials, cookies or redirect responses reach the browser. */
export async function downloadRdpConnector(
  signal?: AbortSignal,
  requestAsset = fetch,
  preview?: ArrayBuffer
): Promise<Response> {
  if (preview) {
    const size = preview.byteLength;
    if (size < 1024 || size > RDP_CONNECTOR_MAX_DOWNLOAD) return unavailable();
    return new Response(preview, {
      headers: { ...packageHeaders(size), 'X-CloudSSH-Connector-Build': 'test-unsigned' },
    });
  }
  const deadline = AbortSignal.timeout(45_000);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  async function fetchRelease(url: string) {
    return requestAsset(url, {
      method: 'GET',
      redirect: 'manual',
      signal: abort,
      headers: { Accept: 'application/octet-stream' },
    });
  }
  try {
    let res = await fetchRelease(RDP_CONNECTOR_DOWNLOAD);
    if (res.status >= 300 && res.status < 400) {
      const target = new URL(res.headers.get('Location') ?? '', RDP_CONNECTOR_DOWNLOAD);
      void res.body?.cancel().catch(() => {});
      if (
        target.protocol !== 'https:' ||
        !assetHosts.has(target.hostname) ||
        target.port ||
        target.username ||
        target.password ||
        target.hash ||
        target.href.length > 4096 ||
        !assetPath.test(target.pathname)
      )
        return unavailable();
      res = await fetchRelease(target.href);
    }
    const size = Number(res.headers.get('Content-Length'));
    if (
      res.status !== 200 ||
      !Number.isSafeInteger(size) ||
      size < 1024 ||
      size > RDP_CONNECTOR_MAX_DOWNLOAD ||
      !res.body ||
      ![
        'application/zip',
        'application/octet-stream',
        'binary/octet-stream',
        'application/x-zip-compressed',
      ].includes(res.headers.get('Content-Type')?.split(';')[0].trim() ?? '')
    ) {
      void res.body?.cancel().catch(() => {});
      return unavailable();
    }
    let received = 0;
    const reader = res.body.getReader();
    // Bound actual bytes, even if a response lied about the length; no ZIP or secret is stored in the Worker.
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        const { value, done } = await reader.read();
        if (done) {
          if (received !== size) throw new Error('incomplete connector download');
          return stream.close();
        }
        received += value.byteLength;
        if (received > size) {
          await reader.cancel();
          throw new Error('invalid connector download size');
        }
        stream.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { headers: packageHeaders(size) });
  } catch {
    return unavailable();
  }
}
