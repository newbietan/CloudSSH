// Dangerous command detection + user confirmation logic

const CONFIRM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\b/, reason: '递归删除操作不可逆，请确认' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: '此操作将导致服务器重启/关机' },
  { pattern: /\bdd\s+if=/, reason: '磁盘写入操作可能导致数据丢失' },
  { pattern: /\bmkfs\b/, reason: '格式化操作将销毁磁盘数据' },
  { pattern: /\bchmod\s+777\b/, reason: '权限全开存在安全风险' },
  { pattern: /\bsudo\s+rm\b/, reason: '以 root 权限执行删除操作' },
  { pattern: /\b:(){:|:&};:/, reason: '检测到 fork bomb，禁止执行' },
];

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
