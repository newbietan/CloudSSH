import { describe, it, expect } from 'vitest';
import { isBlockedCommand, needsConfirmation } from '../../../src/worker/agent/safety';

describe('safety — isBlockedCommand', () => {
  it('应当废弃硬拦截（直接返回 false）', () => {
    // 根据新的白名单策略，任何命令都不在底层被硬拦截，而是全部由 confirmation 兜底
    expect(isBlockedCommand('rm -rf /').blocked).toBe(false);
    expect(isBlockedCommand(':(){:|:&};:').blocked).toBe(false);
    expect(isBlockedCommand('ls').blocked).toBe(false);
  });
});

describe('safety — needsConfirmation', () => {
  // ----- 白名单安全命令 -----
  describe('白名单安全命令（免确认）', () => {
    it('基本读取命令应直接执行', () => {
      const safeCommands = [
        'ls', 'ls -la', 'pwd', 'whoami', 'id',
        'cat file.txt', 'echo "hello"', 'date', 'uptime',
        'uname -a', 'hostname', 'ps aux', 'df -h', 'free -m',
        'which ls', 'whereis bash', 'head -n 10 file', 'tail -f log',
        'wc -l file', 'grep search file', 'stat file', 'file binary'
      ];
      for (const cmd of safeCommands) {
        const r = needsConfirmation(cmd);
        expect(r.required, `cmd="${cmd}"`).toBe(false);
      }
    });

    it('前后有空格的白名单命令', () => {
      expect(needsConfirmation('  ls -l  ').required).toBe(false);
      expect(needsConfirmation('\n pwd \t').required).toBe(false);
    });
  });

  // ----- 非白名单命令 -----
  describe('非白名单命令（强制拦截要求确认）', () => {
    it('危险命令必须确认', () => {
      expect(needsConfirmation('rm -rf /').required).toBe(true);
      expect(needsConfirmation('shutdown now').required).toBe(true);
      expect(needsConfirmation('dd if=/dev/zero of=/dev/sda').required).toBe(true);
      expect(needsConfirmation('mkfs.ext4 /dev/sda1').required).toBe(true);
    });

    it('即使是常见操作，只要不在白名单也必须确认', () => {
      const untestedCommands = [
        'npm install', 'python script.py', 'git clone url',
        'curl http://example.com', 'wget http://example.com',
        'apt update', 'systemctl restart nginx', 'docker run image',
        'mkdir test', 'touch file', 'mv a b', 'cp a b'
      ];
      for (const cmd of untestedCommands) {
        expect(needsConfirmation(cmd).required, `cmd="${cmd}"`).toBe(true);
      }
    });
  });

  // ----- 危险字符/组合逃逸防范 -----
  describe('危险字符/提权防范', () => {
    it('包含 sudo 必须确认（即使是白名单命令）', () => {
      expect(needsConfirmation('sudo ls -l').required).toBe(true);
      expect(needsConfirmation('sudo cat /etc/shadow').required).toBe(true);
      expect(needsConfirmation('sudo id').required).toBe(true);
    });

    it('包含管道符必须确认', () => {
      expect(needsConfirmation('ls -l | grep txt').required).toBe(true);
      expect(needsConfirmation('cat file | wc -l').required).toBe(true);
    });

    it('包含重定向符必须确认', () => {
      expect(needsConfirmation('echo hello > file.txt').required).toBe(true);
      expect(needsConfirmation('cat < file.txt').required).toBe(true);
      expect(needsConfirmation('ls >> out.txt').required).toBe(true);
    });

    it('包含逻辑操作符必须确认', () => {
      expect(needsConfirmation('ls && pwd').required).toBe(true);
      expect(needsConfirmation('cd dir || exit').required).toBe(true);
      expect(needsConfirmation('ls ; pwd').required).toBe(true);
    });

    it('包含变量/命令展开符必须确认', () => {
      expect(needsConfirmation('echo $PATH').required).toBe(true);
      expect(needsConfirmation('ls $(pwd)').required).toBe(true);
      expect(needsConfirmation('ls `pwd`').required).toBe(true); // 注意由于 regex 是针对特定字符，反引号未必包含，但白名单机制仍然会检查 $ 或 () 等
      // 如果使用了花括号等
      expect(needsConfirmation('echo {1..10}').required).toBe(true);
    });

    it('包含后台运行符必须确认', () => {
      expect(needsConfirmation('ping google.com &').required).toBe(true);
    });
    
    it('包含转义字符可能绕过审查，必须确认', () => {
      expect(needsConfirmation('l\\s').required).toBe(true);
    });
  });
});
