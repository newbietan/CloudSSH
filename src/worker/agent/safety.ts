// Dangerous command detection + user confirmation logic

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+(-[rfivR]+\s+)*\//, label: '递归删除' },
  { pattern: /\bmkfs\b/i, label: '格式化磁盘' },
  { pattern: /\bdd\s+if=/i, label: '磁盘写入' },
  { pattern: /\b(shutdown|halt|poweroff)\b/i, label: '关机' },
  { pattern: /\breboot\b/i, label: '重启' },
  { pattern: /\bkill\s+-9\s+1\b/i, label: '杀 init 进程' },
  { pattern: /\bsudo\s+rm\b/i, label: 'sudo rm' },
  { pattern: />\s*\/dev\/sd[a-z]/i, label: '写入磁盘设备' },
  { pattern: /\b:(){:|:&};:/, label: 'fork bomb' },
];

const CONFIRM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\b/, reason: '递归删除操作不可逆，请确认' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: '此操作将导致服务器重启/关机' },
  { pattern: /\bdd\s+if=/, reason: '磁盘写入操作可能导致数据丢失' },
  { pattern: /\bmkfs\b/, reason: '格式化操作将销毁磁盘数据' },
  { pattern: /\bchmod\s+777\b/, reason: '权限全开存在安全风险' },
  { pattern: /\bsudo\s+rm\b/, reason: '以 root 权限执行删除操作' },
  { pattern: /\b:(){:|:&};:/, reason: '检测到 fork bomb，禁止执行' },
];

export function isDangerousCommand(command: string): { safe: boolean; reason?: string } {
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `检测到潜在危险操作：${label}` };
    }
  }
  return { safe: true };
}

export function needsConfirmation(command: string): { required: boolean; reason?: string } {
  for (const { pattern, reason } of CONFIRM_PATTERNS) {
    if (pattern.test(command)) {
      return { required: true, reason };
    }
  }
  if (command.includes('sudo ')) {
    return { required: true, reason: '命令需要 sudo 权限，请确认' };
  }
  return { required: false };
}
