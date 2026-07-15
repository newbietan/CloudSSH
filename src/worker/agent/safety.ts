// Blacklist-based command safety logic

/**
 * Check if a command is blocked (never allowed)
 * This is the ultimate fallback to prevent catastrophic destruction.
 */
export function isBlockedCommand(command: string): { blocked: boolean; reason?: string } {
  const trimmed = command.trim();
  const normalized = trimmed.toLowerCase();

  // Fork bombs
  if (trimmed.includes(':(){ :|:& };:') || trimmed.includes('fork while fork')) {
    return { blocked: true, reason: '禁止执行 Fork Bomb (资源耗尽攻击)' };
  }

  // rm -rf / and variants
  if (/(^|\s)rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(\/|~\/?|\/\*?)(\s|$)/.test(normalized)) {
    return { blocked: true, reason: '禁止执行高危删除操作 (rm -rf /)' };
  }
  
  // Wiping disk
  if (/(^|\s)mkfs(\.[a-z0-9]+)?\s+/.test(normalized)) {
    return { blocked: true, reason: '禁止格式化磁盘' };
  }
  if (/(^|\s)dd\s+.*of=\/dev\/(sd|hd|nvme|vd)[a-z0-9]/.test(normalized)) {
    return { blocked: true, reason: '禁止覆盖块设备' };
  }

  return { blocked: false };
}

/**
 * Check if a command requires mandatory user confirmation.
 * The AI is the "brain" and can choose to ask for confirmation via the ask_user_confirmation tool.
 * This is just a fallback for extremely high-risk commands that could break the system.
 */
export function needsConfirmation(command: string): { required: boolean; reason?: string } {
  const trimmed = command.trim();
  const normalized = trimmed.toLowerCase();
  
  // 高危操作黑名单（正则表达式匹配）
  const DANGEROUS_PATTERNS = [
    { pattern: /(^|\s)rm(\s|$)/, reason: '删除文件操作' },
    { pattern: /(^|\s)reboot(\s|$)/, reason: '重启服务器' },
    { pattern: /(^|\s)shutdown(\s|$)/, reason: '关闭服务器' },
    { pattern: /(^|\s)halt(\s|$)/, reason: '停止服务器' },
    { pattern: /(^|\s)poweroff(\s|$)/, reason: '关闭服务器电源' },
    { pattern: /(^|\s)init\s+[06](\s|$)/, reason: '更改运行级别(关机或重启)' },
    { pattern: /(^|\s)passwd(\s|$)/, reason: '修改密码' },
    { pattern: /(^|\s)chown\s+-r(\s|$)/i, reason: '递归修改文件所有者' },
    { pattern: /(^|\s)chmod\s+-r(\s|$)/i, reason: '递归修改文件权限' },
    { pattern: /(^|\s)fdisk(\s|$)/, reason: '磁盘分区操作' },
    { pattern: /(^|\s)parted(\s|$)/, reason: '磁盘分区操作' },
    { pattern: /(^|\s)dd(\s|$)/, reason: '低级磁盘拷贝/覆盖' },
    { pattern: /(^|\s)iptables\s+-f(\s|$)/i, reason: '清空防火墙规则' },
    { pattern: /(^|\s)ufw\s+disable(\s|$)/i, reason: '禁用防火墙' },
  ];

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      return { required: true, reason: `${reason}，为保证安全需要确认` };
    }
  }

  return { required: false };
}
