import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RDP_CONNECTOR_FILENAME } from '../../src/rdp-schema';
import { inspectRdpConnectorArchive } from '../../src/worker/rdp-connector-archive';

const packager = fileURLToPath(new URL('../../scripts/package-rdp-connector.sh', import.meta.url));
const exe = RDP_CONNECTOR_FILENAME.replace(/\.zip$/, '.exe');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture(callback: (input: string, output: string, bytes: Buffer) => void) {
  const root = mkdtempSync(join(tmpdir(), 'rdp-release-'));
  try {
    const input = join(root, 'build');
    const output = join(root, 'release');
    const bytes = Buffer.concat([Buffer.from('MZ'), randomBytes(4096)]); // Unsigned fixture, not executable.
    mkdirSync(input);
    writeFileSync(join(input, exe), bytes);
    writeFileSync(join(input, 'SHA256SUMS'), `${sha(bytes)}  ${exe}\n`);
    writeFileSync(join(input, 'LICENSES.txt'), 'Fixture notices');
    // Only approved public files are included, even if a file was accidentally left in this directory.
    writeFileSync(join(input, 'cloudssh-binding.cloudssh-rdp.json'), 'not part of a release');
    callback(input, output, bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('official RDP connector ZIP', () => {
  it('packages an unsigned build with the fixed layout, identical bytes and checksums', () => fixture((input, output, bytes) => {
    execFileSync('bash', [packager, input, output]);
    const path = join(output, RDP_CONNECTOR_FILENAME);
    const zipped = readFileSync(path);
    expect(inspectRdpConnectorArchive(new Uint8Array(zipped).buffer)).not.toBeNull();
    expect(execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n').sort()).toEqual(['LICENSES.txt', 'SHA256SUMS', exe].sort());
    expect(execFileSync('unzip', ['-p', path, exe]).equals(bytes)).toBe(true);
    expect(execFileSync('unzip', ['-p', path, 'SHA256SUMS'], { encoding: 'utf8' })).toBe(`${sha(bytes)}  ${exe}\n`);
    expect(readFileSync(join(output, 'SHA256SUMS'), 'utf8')).toBe(`${sha(zipped)}  ${RDP_CONNECTOR_FILENAME}\n`);
  }));

  it('fails if the verified build bytes changed before packaging', () => fixture((input, output, bytes) => {
    bytes[3] ^= 1;
    writeFileSync(join(input, exe), bytes);
    const result = spawnSync('bash', [packager, input, output], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('checksum mismatch');
    expect(() => readFileSync(join(output, RDP_CONNECTOR_FILENAME))).toThrow();
  }));
});
