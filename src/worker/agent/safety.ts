// Dangerous command detection + user confirmation logic

// Directly blocked — never executed regardless of user intent
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // rm -rf / or rm -rf // — match after normalization to prevent bypass via variable expansion
  { pattern: /\brm\s+(-[a-z]*\s+)*\/\s*($|[^\/])/, label: '删除根目录' },
  { pattern: /\brm\s+(-[a-z]*\s+)*\/\/\s*($|\s)/, label: '删除根目录' },
  // rm with path variables that could resolve to root
  { pattern: /\brm\s+(-[a-z]*\s+)*(~\/\.\.|\/\.\.)\//, label: '删除根目录（路径遍历）' },
  { pattern: /\bdd\s+if=\/dev\/(zero|random|urandom)\s+of=\/dev\/(sd[a-z]|nvme|vd)/, label: '覆写磁盘' },
  { pattern: /\b:(){:|:&};:/, label: 'fork bomb' },
  { pattern: /\bmkfs\.\w+\s+\/dev\/(sd[a-z]|nvme|vd)/, label: '格式化磁盘设备' },
  { pattern: />\s*\/dev\/(sd[a-z]|nvme|vd)/, label: '写入磁盘设备' },
  { pattern: /\bchpasswd\b/, label: '批量修改密码' },
  // find -delete / -exec rm
  { pattern: /\bfind\b.+-delete\b/, label: '递归删除（find -delete）' },
  { pattern: /\bfind\b.+-exec\s+rm\b/, label: '递归删除（find -exec rm）' },
  // xargs rm
  { pattern: /\bxargs\s+.*\brm\b/, label: '批量删除（xargs rm）' },
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
  { pattern: /\bpasswd\b/, reason: '修改用户密码，请确认' },
];

// sudo risk levels: low-risk sudo commands that don't need confirmation
// Note: This only covers read-only system commands. Any sudo command that could
// modify system state requires confirmation.
const SUDO_SAFE_READ_PATTERNS: RegExp[] = [
  // systemctl read-only commands
  /\bsudo\s+systemctl\s+(status|is-active|is-enabled|cat)\b/,
  // systemctl start/restart/enable — safe for most services
  /\bsudo\s+systemctl\s+(start|restart|enable)\b/,
  // Pure read-only system commands
  /\bsudo\s+(journalctl|ss|netstat|lsof|df|free|uname|hostname|uptime|whoami|id|groups|ls|cat|head|tail|grep|wc|file|stat|du|find)\b/,
  // Docker read-only commands
  /\bsudo\s+docker\s+(ps|logs|images|inspect|version|info)\b/,
];

// sudo commands that write to disk or modify system — require confirmation
const SUDO_WRITE_PATTERNS: RegExp[] = [
  /\bsudo\s+(systemctl\s+)?(stop|disable)\b/,
  /\bsudo\s+docker\s+(stop|rm|rmi|restart)\b/,
  /\bsudo\s+(apt|yum|dnf|apk)\s+(install|remove|purge|update|upgrade)\b/,
  /\bsudo\s+user(add|del|mod)\b/,
  /\bsudo\s+group(add|del|mod)\b/,
  /\bsudo\s+(mount|umount)\b/,
  /\bsudo\s+(crontab|at)\b/,
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
  // Blocked commands are rejected outright by the caller — they don't need confirmation
  if (isBlockedCommand(command).blocked) {
    return { required: false };
  }

  // Check confirm patterns
  for (const { pattern, reason } of CONFIRM_PATTERNS) {
    if (pattern.test(command)) {
      return { required: true, reason };
    }
  }

  // sudo: check if it's a safe read-only command
  if (command.includes('sudo ')) {
    // First check if it's a known write operation
    const isWriteOp = SUDO_WRITE_PATTERNS.some(p => p.test(command));
    if (isWriteOp) {
      return { required: true, reason: '此 sudo 命令修改系统状态，请确认' };
    }

    // Then check if it's a known safe read operation
    const isSafeRead = SUDO_SAFE_READ_PATTERNS.some(p => p.test(command));
    if (!isSafeRead) {
      return { required: true, reason: '此 sudo 命令存在风险，请确认' };
    }
  }

  return { required: false };
}
