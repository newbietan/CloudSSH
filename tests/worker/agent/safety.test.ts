import { describe, it, expect } from 'vitest';
import { isBlockedCommand, needsConfirmation } from '../../../src/worker/agent/safety';

describe('safety — isBlockedCommand (黑名单极度危险操作)', () => {
  it('应当拦截极度危险的命令', () => {
    expect(isBlockedCommand('rm -rf /').blocked).toBe(true);
    expect(isBlockedCommand(' rm -rf /* ').blocked).toBe(true);
    expect(isBlockedCommand(':(){ :|:& };:').blocked).toBe(true);
    expect(isBlockedCommand('mkfs.ext4 /dev/sda').blocked).toBe(true);
    expect(isBlockedCommand('dd if=/dev/zero of=/dev/sda').blocked).toBe(true);
  });

  it('常规命令应当直接放行', () => {
    expect(isBlockedCommand('ls').blocked).toBe(false);
    expect(isBlockedCommand('cat /etc/os-release').blocked).toBe(false);
    expect(isBlockedCommand('ss -tulpn').blocked).toBe(false);
    expect(isBlockedCommand('docker ps').blocked).toBe(false);
  });
});

describe('safety — needsConfirmation (高风险操作需要确认)', () => {
  it('常见的高风险破坏性命令必须确认', () => {
    const dangerousCommands = [
      'rm -rf /tmp/test',
      'reboot',
      'shutdown now',
      'halt',
      'poweroff',
      'init 0',
      'init 6',
      'passwd root',
      'chown -R root:root /var/www',
      'chmod -R 777 /var/www',
      'fdisk /dev/sdb',
      'parted /dev/sdb',
      'dd if=a of=b',
      'iptables -F',
      'ufw disable',
      'sudo rm file'
    ];
    for (const cmd of dangerousCommands) {
      const r = needsConfirmation(cmd);
      expect(r.required, `cmd="${cmd}"`).toBe(true);
    }
  });

  it('多命令组合中包含高风险命令时必须确认', () => {
    expect(needsConfirmation('ls && rm -rf /tmp/test').required).toBe(true);
    expect(needsConfirmation('rm file || echo "failed"').required).toBe(true);
    expect(needsConfirmation('cat file | rm -rf').required).toBe(true);
    expect(needsConfirmation('cd /; rm file').required).toBe(true);
  });

  it('一般的命令、查询、安装操作应当由 AI 大脑自己判断，底层免确认', () => {
    const safeCommands = [
      'ls -la',
      'pwd',
      'cat /etc/os-release',
      'cat /etc/os-release 2>/dev/null || cat /etc/alpine-release',
      'ss -tulpn',
      'ps aux | grep node',
      'npm install',
      'apt-get install nginx',
      'curl http://example.com',
      'echo "hello" > test.txt',
      'docker run nginx',
      'sudo tail -f /var/log/syslog'
    ];
    for (const cmd of safeCommands) {
      const r = needsConfirmation(cmd);
      expect(r.required, `cmd="${cmd}"`).toBe(false);
    }
  });
});
