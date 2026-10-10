/**
 * Shared bounded upload policy for browser flow control and Worker write concurrency.
 * These limits apply to SFTP data, not encrypted WebSocket carrier messages:
 * tunnel-stream.ts independently enforces the cloudflared 16KiB message boundary.
 */
export interface SFTPUploadPolicy {
  readonly chunkSize: number;
  readonly initialWindowBytes: number;
  readonly minWindowBytes: number;
  readonly maxWindowBytes: number;
  readonly windowStepBytes: number;
  readonly maxInFlightWrites: number;
  readonly progressAckBytes: number;
}

const DIRECT_UPLOAD_POLICY: SFTPUploadPolicy = Object.freeze({
  chunkSize: 128 * 1024,
  initialWindowBytes: 2 * 1024 * 1024,
  minWindowBytes: 1024 * 1024,
  maxWindowBytes: 8 * 1024 * 1024,
  windowStepBytes: 512 * 1024,
  maxInFlightWrites: 16,
  progressAckBytes: 256 * 1024,
});

const TUNNEL_UPLOAD_POLICY: SFTPUploadPolicy = Object.freeze({
  chunkSize: 32 * 1024,
  initialWindowBytes: 256 * 1024,
  minWindowBytes: 128 * 1024,
  maxWindowBytes: 2 * 1024 * 1024,
  windowStepBytes: 128 * 1024,
  maxInFlightWrites: 16,
  progressAckBytes: 32 * 1024,
});

export function getSFTPUploadPolicy(isTunnel: boolean): SFTPUploadPolicy {
  return isTunnel ? TUNNEL_UPLOAD_POLICY : DIRECT_UPLOAD_POLICY;
}
