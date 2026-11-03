import { describe, expect, it } from 'vitest';
import {
  DETECT_OS_COMMAND,
  detectAndPersistRemoteOS,
  isDetectedOS,
  parseDetectedOS,
} from '../../src/worker/os-detect';

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

  it('识别 Windows OpenSSH 的 %OS% 输出', () => {
    expect(parseDetectedOS('Windows_NT\r\n')).toBe('windows');
  });

  it('空输出返回 unknown', () => {
    expect(parseDetectedOS('')).toBe('unknown');
    expect(parseDetectedOS(undefined as unknown as string)).toBe('unknown');
  });

  it('DETECT_OS_COMMAND 优先 os-release，回退 uname', () => {
    expect(DETECT_OS_COMMAND).toContain('cat /etc/os-release');
    expect(DETECT_OS_COMMAND).toContain('uname -s');
    expect(DETECT_OS_COMMAND).toContain('echo %OS%');
    expect(DETECT_OS_COMMAND).not.toContain('/etc/*-release');
  });

  it('Access 会话把操作系统写进邮箱路由库，而不是哨兵 -2', async () => {
    const names: string[] = [];
    let persistedUserId = '';
    const env = {
      USER_DB: {
        idFromName: (name: string) => {
          names.push(name);
          return name;
        },
        get: () => ({
          fetch: async (req: Request) => {
            const body = (await req.json()) as { user_id?: number };
            persistedUserId = String(body.user_id ?? '');
            return Response.json({ success: true });
          },
        }),
      },
    };

    const os = await detectAndPersistRemoteOS({
      serverId: 4,
      userId: '7',
      githubId: '-2',
      userDbRouteKey: 'cf:2597417538qqcom-a76a843584a0743d',
      env: env as any,
      executeCommand: async () => ({ stdout: 'ID=ubuntu\n' }),
    });

    expect(os).toBe('ubuntu');
    expect(names).toEqual(['cf:2597417538qqcom-a76a843584a0743d']);
    expect(persistedUserId).toBe('7');
  });

  it('仅允许已识别的规范 key 持久化', () => {
    expect(isDetectedOS('ubuntu')).toBe(true);
    expect(isDetectedOS('windows')).toBe(true);
    expect(isDetectedOS('unknown')).toBe(false);
    expect(isDetectedOS(' Ubuntu ')).toBe(false);
  });
});
