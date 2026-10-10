import { describe, expect, it } from 'vitest';
import { getSFTPUploadPolicy } from '../src/sftp-upload-policy';

describe('SFTP bounded upload policy', () => {
  it('widens only the tunnel pipeline, keeping 32KiB data chunks and prompt ACKs', () => {
    expect(getSFTPUploadPolicy(true)).toEqual({
      chunkSize: 32 * 1024,
      initialWindowBytes: 256 * 1024,
      minWindowBytes: 128 * 1024,
      maxWindowBytes: 2 * 1024 * 1024,
      windowStepBytes: 128 * 1024,
      maxInFlightWrites: 16,
      progressAckBytes: 32 * 1024,
    });
  });

  it('preserves all direct TCP upload parameters', () => {
    expect(getSFTPUploadPolicy(false)).toEqual({
      chunkSize: 128 * 1024,
      initialWindowBytes: 2 * 1024 * 1024,
      minWindowBytes: 1024 * 1024,
      maxWindowBytes: 8 * 1024 * 1024,
      windowStepBytes: 512 * 1024,
      maxInFlightWrites: 16,
      progressAckBytes: 256 * 1024,
    });
  });

  it.each([true, false])('keeps mode=%s windows bounded, chunk-aligned and ACK-safe', (isTunnel) => {
    const policy = getSFTPUploadPolicy(isTunnel);
    expect(policy.minWindowBytes).toBeLessThanOrEqual(policy.initialWindowBytes);
    expect(policy.initialWindowBytes).toBeLessThanOrEqual(policy.maxWindowBytes);
    expect(policy.progressAckBytes).toBeLessThanOrEqual(policy.minWindowBytes);
    expect(policy.maxInFlightWrites * policy.chunkSize).toBeLessThanOrEqual(policy.maxWindowBytes);
    for (const size of [
      policy.minWindowBytes,
      policy.initialWindowBytes,
      policy.maxWindowBytes,
      policy.windowStepBytes,
      policy.progressAckBytes,
    ]) {
      expect(size).toBeGreaterThan(0);
      expect(size % policy.chunkSize).toBe(0);
    }
    expect(Object.isFrozen(policy)).toBe(true);
  });
});
