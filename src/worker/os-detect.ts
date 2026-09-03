/**
 * 远端操作系统检测
 *
 * 通过 exec channel 在远端执行一条命令获取系统标识，再把输出解析为
 * 规范的操作系统 key（小写），用于服务器卡片图标与数据库持久化。
 */
import type { Env } from '../types';

/**
 * 检测命令：优先读取 /etc/os-release（现代发行版），其次旧式
 * /etc/redhat-release，随后回退到 uname -s。末尾的 %OS% 用于兼容
 * 以 cmd.exe 为默认 Shell 的 Windows OpenSSH。
 */
export const DETECT_OS_COMMAND =
  'cat /etc/os-release 2>/dev/null || cat /etc/redhat-release 2>/dev/null || uname -s 2>/dev/null || echo %OS%';

/** 可持久化的规范 OS key；unknown 只表示本次未识别，不应写入数据库。 */
export const DETECTED_OS_KEYS = [
  'ubuntu',
  'debian',
  'centos',
  'rhel',
  'fedora',
  'arch',
  'alpine',
  'rocky',
  'almalinux',
  'opensuse',
  'suse',
  'kali',
  'mint',
  'manjaro',
  'popos',
  'oracle',
  'gentoo',
  'nixos',
  'void',
  'raspbian',
  'macos',
  'freebsd',
  'openbsd',
  'netbsd',
  'linux',
  'solaris',
  'windows',
] as const;

export type DetectedOS = (typeof DETECTED_OS_KEYS)[number];

const DETECTED_OS_KEY_SET = new Set<string>(DETECTED_OS_KEYS);

export function isDetectedOS(value: unknown): value is DetectedOS {
  return typeof value === 'string' && DETECTED_OS_KEY_SET.has(value);
}

/** ID=/ID_LIKE= 值 → 规范 key */
const OS_ALIASES: Record<string, string> = {
  ubuntu: 'ubuntu',
  debian: 'debian',
  centos: 'centos',
  rhel: 'rhel',
  'red hat enterprise linux': 'rhel',
  fedora: 'fedora',
  arch: 'arch',
  alpine: 'alpine',
  rocky: 'rocky',
  almalinux: 'almalinux',
  opensuse: 'opensuse',
  'opensuse-leap': 'opensuse',
  'opensuse-tumbleweed': 'opensuse',
  suse: 'suse',
  kali: 'kali',
  linuxmint: 'mint',
  manjaro: 'manjaro',
  pop: 'popos',
  oracle: 'oracle',
  gentoo: 'gentoo',
  nixos: 'nixos',
  void: 'void',
  raspbian: 'raspbian',
};

/** 兜底：在未解析到 ID 的原始输出里按发行版名扫描（旧式 redhat-release 等） */
const NAME_PATTERNS: Array<[RegExp, string]> = [
  [/ubuntu/i, 'ubuntu'],
  [/debian/i, 'debian'],
  [/centos/i, 'centos'],
  [/red hat|rhel/i, 'rhel'],
  [/fedora/i, 'fedora'],
  [/rocky/i, 'rocky'],
  [/alma/i, 'almalinux'],
  [/arch linux/i, 'arch'],
  [/alpine/i, 'alpine'],
  [/opensuse|suse/i, 'opensuse'],
  [/kali/i, 'kali'],
  [/linux mint|mint/i, 'mint'],
  [/manjaro/i, 'manjaro'],
  [/pop.?os/i, 'popos'],
  [/oracle/i, 'oracle'],
  [/gentoo/i, 'gentoo'],
  [/nixos/i, 'nixos'],
  [/raspbian/i, 'raspbian'],
];

/**
 * 把命令输出解析为规范操作系统 key。
 *
 * 优先级：/etc/os-release 的 ID= → ID_LIKE= → 发行版名扫描 → uname -s 归类。
 * 无法识别时返回 'unknown'。
 */
export function parseDetectedOS(output: string): string {
  const text = output ?? '';

  const idMatch = text.match(/^ID=(.*)$/m);
  const idLikeMatch = text.match(/^ID_LIKE=(.*)$/m);

  const id = idMatch?.[1]?.trim().replace(/["']/g, '').toLowerCase();
  if (id) {
    const canonical = OS_ALIASES[id] || OS_ALIASES[id.split(/[\s-]+/)[0]];
    if (canonical) return canonical;
  }

  const idLike = idLikeMatch?.[1]?.trim().replace(/["']/g, '').toLowerCase();
  if (idLike) {
    for (const like of idLike.split(/\s+/)) {
      const canonical = OS_ALIASES[like];
      if (canonical) return canonical;
    }
  }

  for (const [pattern, canonical] of NAME_PATTERNS) {
    if (pattern.test(text)) return canonical;
  }

  const uname = text.trim().toLowerCase();
  if (uname.includes('darwin')) return 'macos';
  if (uname.includes('freebsd')) return 'freebsd';
  if (uname.includes('openbsd')) return 'openbsd';
  if (uname.includes('netbsd')) return 'netbsd';
  if (uname.includes('linux')) return 'linux';
  if (uname.includes('sunos')) return 'solaris';
  if (
    uname.includes('windows_nt') ||
    uname.includes('mingw') ||
    uname.includes('cygwin') ||
    uname.includes('msys')
  ) {
    return 'windows';
  }

  return 'unknown';
}

export interface DetectRemoteOSContext {
  serverId: number;
  userId: string;
  githubId: string;
  env?: Env | null;
  executeCommand: (command: string, timeout: number) => Promise<{ stdout: string }>;
  onOSDetected?: (os: string) => void;
  sendDebug?: (message: string) => void;
}

/**
 * 在远端执行检测命令，解析操作系统，并在识别成功后写入 UserDBDO。
 */
export async function detectAndPersistRemoteOS(
  ctx: DetectRemoteOSContext
): Promise<string | null> {
  try {
    const result = await ctx.executeCommand(DETECT_OS_COMMAND, 5000);
    // stderr 可能包含 Shell 或权限错误，不能参与发行版名称解析。
    const os = parseDetectedOS(result.stdout);
    if (!isDetectedOS(os)) {
      ctx.sendDebug?.('OS detect returned unknown; leaving it unset for the next connection');
      return null;
    }

    if (ctx.env) {
      try {
        const userDb = ctx.env.USER_DB as any;
        const stub = userDb.get(userDb.idFromName(ctx.githubId));
        const res = await stub.fetch(
          new Request(`http://internal/internal/servers/${ctx.serverId}/os`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: Number(ctx.userId), os }),
          })
        );
        if (!res.ok) {
          ctx.sendDebug?.(`OS detect persist failed: ${res.status}`);
        }
      } catch (e) {
        ctx.sendDebug?.(`OS detect persist error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    ctx.onOSDetected?.(os);
    return os;
  } catch (e) {
    ctx.sendDebug?.(`OS detect error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
