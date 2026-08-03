import { describe, expect, it } from 'vitest';
import { DETECT_OS_COMMAND, parseDetectedOS } from '../../src/worker/os-detect';

describe('parseDetectedOS', () => {
  it('解析 Ubuntu 的 /etc/os-release', () => {
    const output = `NAME="Ubuntu"
VERSION="22.04.3 LTS (Jammy Jellyfish)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 22.04.3 LTS"
VERSION_ID="22.04"`;
    expect(parseDetectedOS(output)).toBe('ubuntu');
  });

  it('解析带引号的 ID（CentOS）', () => {
    const output = `NAME="CentOS Linux"
VERSION="7 (Core)"
ID="centos"
ID_LIKE="rhel fedora"`;
    expect(parseDetectedOS(output)).toBe('centos');
  });

  it('解析 Debian', () => {
    const output = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
ID=debian`;
    expect(parseDetectedOS(output)).toBe('debian');
  });

  it('解析 Alpine', () => {
    const output = `NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.19.1`;
    expect(parseDetectedOS(output)).toBe('alpine');
  });

  it('ID 未知时回退到 ID_LIKE（ID 为欧拉等自研发行版）', () => {
    const output = `ID=myos
ID_LIKE="debian"
PRETTY_NAME="My OS"`;
    expect(parseDetectedOS(output)).toBe('debian');
  });

  it('旧式 /etc/redhat-release 按名称扫描识别 CentOS', () => {
    const output = 'CentOS Linux release 7.9.2009 (Core)';
    expect(parseDetectedOS(output)).toBe('centos');
  });

  it('按 uname -s 归类 macOS (Darwin)', () => {
    expect(parseDetectedOS('Darwin\n')).toBe('macos');
  });

  it('按 uname -s 归类 FreeBSD', () => {
    expect(parseDetectedOS('FreeBSD')).toBe('freebsd');
  });

  it('按 uname -s 归类通用 Linux', () => {
    expect(parseDetectedOS('Linux')).toBe('linux');
  });

  it('空输出返回 unknown', () => {
    expect(parseDetectedOS('')).toBe('unknown');
    expect(parseDetectedOS(undefined as unknown as string)).toBe('unknown');
  });

  it('DETECT_OS_COMMAND 优先 os-release，回退 uname', () => {
    expect(DETECT_OS_COMMAND).toContain('cat /etc/os-release');
    expect(DETECT_OS_COMMAND).toContain('uname -s');
  });
});
