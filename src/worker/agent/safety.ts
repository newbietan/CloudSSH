// Dangerous command detection + user confirmation logic

// Directly blocked — never executed regardless of user intent
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+(-[a-z]*\s+)*\/($|\s)/, label: '删除根目录' },
  { pattern: /\bdd\s+if=\/dev\/(zero|random|urandom)\s+of=\/dev\/sd/, label: '覆写磁盘' },
  { pattern: /\b:(){:|:&};:/, label: 'fork bomb' },
  { pattern: /\bmkfs\.\w+\s+\/dev\/sd/, label: '格式化磁盘设备' },
  { pattern: />\s*\/dev\/sd[a-z]/, label: '写入磁盘设备' },
];

// Require user confirmation before execution
const CONFIRM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\b/, reason: '递归删除操作不可逆，请确认' },
  { pattern: /\brm\s+(-[a-z]*\s+)+[\/~]/, reason: '删除文件/目录操作不可逆，请确认' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: '此操作将导致服务器重启/关机' },
  { pattern: /\bdd\s+if=/, reason: '磁盘写入操作可能导致数据丢失' },
  { pattern: /\bmkfs\b/, reason: '格式化操作将销毁磁盘数据' },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, reason: '权限全开存在安全风险' },
  { pattern: /\bchown\s+(-R\s+)?root\b/, reason: '修改文件属主为 root，请确认' },
  { pattern: /\biptables\s+(-F|-X|-P\s+INPUT\s+DROP|-P\s+FORWARD\s+DROP)/, reason: '修改防火墙规则可能导致连接中断' },
  { pattern: /\b(ufw|firewall-cmd)\s+(disable|stop|--panic-on)/, reason: '关闭防火墙存在安全风险' },
  { pattern: /\bwget\s.*\|\s*(ba)?sh/, reason: '远程脚本直接执行存在安全风险' },
  { pattern: /\bcurl\s.*\|\s*(ba)?sh/, reason: '远程脚本直接执行存在安全风险' },
  { pattern: /\bchmod\s+(-R\s+)?\+s\b/, reason: '设置 SUID/SGID 位存在安全风险' },
];

// sudo risk levels: low-risk sudo commands that don't need confirmation
const SUDO_SAFE_PATTERNS: RegExp[] = [
  /\bsudo\s+(systemctl\s+)?(status|start|restart|enable|is-active|is-enabled|cat)\b/,
  /\bsudo\s+(journalctl|docker\s+(ps|logs|images|inspect)|ss|netstat|lsof|df|free|uname|hostname|uptime|whoami|id|groups|find|ls|cat|head|tail|grep|wc|file|stat|du)\b/,
];

export function isBlockedCommand(command: string): { blocked: boolean; reason?: string } {
  for (const { pattern, label } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { blocked: true, reason: `此操作已被禁止：${label}` };
    }
  }
  return { blocked: false };
}

export function needsConfirmation(command: string): { required: boolean; reason?: string } {
  // Check blocked first
  const blocked = isBlockedCommand(command);
  if (blocked.blocked) {
    return { required: true, reason: blocked.reason };
  }

  // Check confirm patterns
  for (const { pattern, reason } of CONFIRM_PATTERNS) {
    if (pattern.test(command)) {
      return { required: true, reason };
    }
  }

  // sudo: check if it's a safe sudo command
  if (command.includes('sudo ')) {
    const isSafe = SUDO_SAFE_PATTERNS.some(p => p.test(command));
    if (!isSafe) {
      return { required: true, reason: '此 sudo 命令存在风险，请确认' };
    }
  }

  return { required: false };
}
