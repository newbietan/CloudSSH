import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, copyFileSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { readUint32 } from '../../src/ssh/utils';
import { SSH_MSG_CHANNEL_CLOSE } from '../../src/types';
import { SSHSession } from '../../src/worker/ssh-session';
import { withMcpSftp, mcpRead, mcpWrite, mcpList } from '../../src/worker/mcp-sftp';
import { readFileSync } from 'node:fs';

// Opt-in: this starts a loopback-only sshd using the current OS account and public test keys.
// It never edits system sshd configuration, account passwords, or ~/.ssh/authorized_keys.
const enabled = process.env.CLOUDSSH_SSHD_INTEROP === '1';
const sshd = process.env.CLOUDSSH_SSHD_BINARY || '/usr/sbin/sshd';
const fixtures = resolve(__dirname, '../ssh/fixtures');
const cases = [
  ['ssh-ed25519', 'id_ed25519', false],
  ['ssh-ed25519', 'id_ed25519', false, true],
  ['ssh-ed25519-cert-v01@openssh.com', 'id_ed25519', true],
  ['rsa-sha2-256-cert-v01@openssh.com', 'id_rsa_2048', true],
  ['rsa-sha2-512-cert-v01@openssh.com', 'id_rsa_2048', true],
  ['ecdsa-sha2-nistp256-cert-v01@openssh.com', 'id_ecdsa_256', true],
  ['ecdsa-sha2-nistp384-cert-v01@openssh.com', 'id_ecdsa_384', true],
  ['ecdsa-sha2-nistp521-cert-v01@openssh.com', 'id_ecdsa_521', true],
] as const;

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
async function connectLocal(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  try { await once(socket, 'connect'); return socket; }
  catch (error) { socket.destroy(); throw error; }
}
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

describe.skipIf(!enabled)('real OpenSSH loopback interoperability', () => {
  it.each(cases)('authenticates, opens PTY/Shell, executes and reads SFTP with %s', async (algorithm, keyName, certificate, headless: boolean = false) => {
    const directory = mkdtempSync(join(tmpdir(), 'cloudssh-interop-'));
    let child: ChildProcess | undefined;
    let session: SSHSession | undefined;
    let socket: Socket | undefined;
    try {
      const username = userInfo().username;
      if (!/^[a-zA-Z0-9_.-]+\$?$/.test(username)) throw new Error('Unsupported test account name');
      const hostKey = join(directory, 'host');
      const caKey = join(directory, 'ca');
      copyFileSync(join(fixtures, keyName), hostKey);
      copyFileSync(join(fixtures, `${keyName}.pub`), `${hostKey}.pub`);
      copyFileSync(join(fixtures, 'id_ed25519'), caKey);
      copyFileSync(join(fixtures, 'id_ed25519.pub'), join(directory, 'authorized_keys'));
      chmodSync(hostKey, 0o600);
      chmodSync(caKey, 0o600);
      if (certificate) execFileSync('ssh-keygen', [
        '-q', '-s', caKey, '-I', 'cloudssh-public-interop', '-h', '-n', '127.0.0.1',
        '-V', '-1m:+1h', `${hostKey}.pub`,
      ], { stdio: 'pipe' });
      const port = await freePort();
      const config = join(directory, 'sshd_config');
      writeFileSync(config, [
        `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`,
        ...(certificate ? [`HostCertificate ${hostKey}-cert.pub`] : []),
        `HostKeyAlgorithms ${algorithm}`, `PidFile ${join(directory, 'pid')}`,
        `AuthorizedKeysFile ${join(directory, 'authorized_keys')}`, `AllowUsers ${username}`,
        'StrictModes no', 'UsePAM no', 'PubkeyAuthentication yes',
        'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
        'AuthenticationMethods publickey', 'PermitRootLogin yes',
        // Headless fixture reserves the only session channel with SFTP to test explicit open denial.
        ...(headless ? ['MaxSessions 1'] : []),
        'Subsystem sftp internal-sftp', 'LogLevel ERROR',
      ].join('\n') + '\n');
      child = spawn(sshd, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
      // Drain bounded diagnostics without printing user/account names or key material.
      child.stderr?.on('data', () => {});
      let launchError = false;
      child.on('error', () => { launchError = true; });
      await vi.waitFor(async () => {
        if (launchError || child!.exitCode !== null) throw new Error('Local sshd could not start; check sshd availability and test account permissions');
        socket = await connectLocal(port);
      }, { timeout: 5000, interval: 50 });
      const messages: Array<{ type?: string; event?: string }> = [];
      const ws = {
        readyState: 1,
        send(value: string | ArrayBuffer) {
          if (typeof value === 'string') messages.push(JSON.parse(value));
        },
        close() { this.readyState = 3; },
      };
      session = new SSHSession(ws as unknown as WebSocket, {
        readable: Readable.toWeb(socket!), writable: Writable.toWeb(socket!),
        close: () => socket?.destroy(),
      }, {
        host: '127.0.0.1', port, username, password: '', authMethod: 'publickey',
        privateKey: readFileSync(join(fixtures, 'id_ed25519'), 'utf8'),
      }, false, undefined, undefined, undefined, undefined,
      { openShellOnAuth: !headless, ownsWebSocket: !headless, allowKeyboardInteractive: false });
      await session.startHandshake();
      if (headless) await session.waitUntilAuthenticated();
      else await vi.waitFor(() => expect(messages.some((message) => message.event === 'shell_ready')).toBe(true),
        { timeout: 7000, interval: 25 });
      const internal = session as any;
      expect(internal.negotiatedHostKeyAlgorithm).toBe(algorithm);
      const result = await session.executeCommand('printf CLOUDSSH_INTEROP_OK', 5000);
      expect(result).toMatchObject({ stdout: 'CLOUDSSH_INTEROP_OK', exitCode: 0 });
      if (headless) {
        const nonzero = await session.executeCommand('printf before-exit; exit 7', 5000);
        expect(nonzero).toMatchObject({ stdout: 'before-exit', exitCode: 7 });
        const sftpChannelId = internal.nextChannelID as number;
        const packets = vi.spyOn(internal, 'handleSessionPacket');
        await withMcpSftp(session, async sftp => {
          await expect(session!.executeCommand('printf must-not-run', 5000)).rejects.toMatchObject({
            code: 'exec_channel_rejected', outcome: 'not_executed',
          });
          const path = join(directory, 'mcp-text.txt');
          await mcpWrite(sftp, path, 'MCP first 你好');
          const first = await mcpRead(sftp, path);
          expect(first.content).toBe('MCP first 你好');
          await mcpWrite(sftp, path, 'MCP replacement', first.fileHash!);
          expect((await mcpRead(sftp, path)).content).toBe('MCP replacement');
          expect((await mcpList(sftp, directory, 100)).entries.some(entry => entry.name === 'mcp-text.txt')).toBe(true);
        });
        // withMcpSftp closes locally; wait for sshd to release its single channel slot.
        await vi.waitFor(() => expect(packets.mock.calls.some(([type, payload]) =>
          type === SSH_MSG_CHANNEL_CLOSE && readUint32(payload as Uint8Array, 1) === sftpChannelId
        )).toBe(true), { timeout: 3000, interval: 10 });
        packets.mockRestore();
        expect(await session.executeCommand('printf recovered', 5000)).toMatchObject({
          stdout: 'recovered', exitCode: 0,
        });
        await expect(session.executeCommand('exec sleep 3', 1000)).rejects.toMatchObject({
          code: 'exec_timeout', outcome: 'unknown',
        });
        expect(messages.some(message => message.event === 'shell_ready')).toBe(false);
        return;
      }
      await internal.openSFTPChannel();
      await vi.waitFor(() => expect(internal.sftpHandler?.sftp?.version).toBe(3), { timeout: 5000 });
      const attrs = await internal.sftpHandler.sftp.stat(directory);
      expect(attrs[0]).toBe(105); // SSH_FXP_ATTRS from the real internal-sftp server.
      expect(messages.filter((message) => message.type === 'error')).toEqual([]);
    } finally {
      session?.close(true);
      socket?.destroy();
      await stop(child);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
