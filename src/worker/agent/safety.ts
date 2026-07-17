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

  // rm -rf / and variants — flag 顺序无关：只要短选项同时含 r 和 f，且目标是
  // 根目录、家目录或根下通配即视为极度危险。覆盖 rm -rf /、rm -fr /、rm -r -f / 等。
  if (/(^|\s)rm\s+-[a-zA-Z]+/.test(normalized)) {
    const rmMatch = normalized.match(/(^|\s)rm\s+(-[a-zA-Z-]+(?:\s+\S+)?)/);
    if (rmMatch) {
      const flags = rmMatch[2];
      const hasR = /r/.test(flags);
      const hasF = /f/.test(flags);
      if (hasR && hasF) {
        // 提取目标参数（首个非 flag 段）
        const segments = normalized.split(/\s+/);
        const rmIdx = segments.indexOf('rm');
        const flagEnd = segments.findIndex((s, i) => i > rmIdx && !s.startsWith('-'));
        const target = flagEnd > 0 ? segments[flagEnd] : '';
        if (/^(\/|~\/?|\/\*?|\*?)$/.test(target)) {
          return { blocked: true, reason: '禁止执行高危删除操作 (rm -rf /)' };
        }
        // Shell 替换可能展开为根目录 → 一律拦截
        if (/\$[\(\{]/.test(target) || /`/.test(target)) {
          return { blocked: true, reason: '禁止在 rm -rf 中使用 shell 替换（可能展开为根目录）' };
        }
      }
    }
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
    { pattern: /(^|\s)iptables\s+-x(\s|$)/i, reason: '清空自定义链表' },
    { pattern: /(^|\s)ufw\s+disable(\s|$)/i, reason: '禁用防火墙' },
    // 杀全部进程（一锅端），与按 PID 杀进程的 kill 不同，破坏面广且难以恢复
    { pattern: /(^|\s)kill\s+-9\s+(-1|0|1)(\s|$)/, reason: '杀死全部进程' },
    { pattern: /(^|\s)kill\s+--signal\s+sigkill(\s|$)/i, reason: '杀死进程' },
    // 远程脚本执行（curl/wget 管道给 shell），普通 curl/wget 不受影响
    { pattern: /(curl|wget)\b[^|]*\|\s*(sh|bash)(\s|$)/i, reason: '远程下载并执行脚本' },
    // find 递归删除（直接 -delete 或 -exec rm），危险面广
    { pattern: /(^|\s)find\s+.*-delete(\s|$)/, reason: 'find 递归删除文件' },
    { pattern: /(^|\s)find\s+.*-exec\s+rm(\s|$)/, reason: 'find 递归执行 rm' },
  ];

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      return { required: true, reason: `${reason}，为保证安全需要确认` };
    }
  }

  return { required: false };
}
