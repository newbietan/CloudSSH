// Best-effort command guardrails, NOT a shell sandbox or a complete security boundary.

/**
 * Check if a command is blocked (never allowed)
 * Recognizes direct catastrophic commands only; wrappers/obfuscation need confirmation below.
 * Never execute or expand the command locally to classify it.
 */
export function isBlockedCommand(command: string): { blocked: boolean; reason?: string } {
  const trimmed = command.trim();
  const normalized = trimmed.toLowerCase();

  // Fork bombs
  if (trimmed.includes(':(){ :|:& };:') || trimmed.includes('fork while fork')) {
    return { blocked: true, reason: '禁止执行 Fork Bomb (资源耗尽攻击)' };
  }

  // rm -rf / and variants — shell 控制符同样属于命令边界，避免
  // true;rm -rf /、true&&rm -rf / 等无空格组合绕过检查。
  const rmPattern = /(?:^|[\s;&|()])rm\s+((?:-[^\s;&|()]+\s+)+)([^\s;&|]+)/g;
  for (const rmMatch of normalized.matchAll(rmPattern)) {
    const flags = rmMatch[1];
    const hasR = /r/.test(flags);
    const hasF = /f/.test(flags);
    if (hasR && hasF) {
      const target = rmMatch[2].replace(/\)+$/, '');
      if (/^(\/|~\/?|\/\*?|\*?)$/.test(target)) {
        return { blocked: true, reason: '禁止执行高危删除操作 (rm -rf /)' };
      }
      // Shell 替换可能展开为根目录 → 一律拦截
      if (/\$[({]/.test(target) || /`/.test(target)) {
        return { blocked: true, reason: '禁止在 rm -rf 中使用 shell 替换（可能展开为根目录）' };
      }
    }
  }

  // Wiping disk
  if (/(^|[\s;&|()])mkfs(\.[a-z0-9]+)?\s+/.test(normalized)) {
    return { blocked: true, reason: '禁止格式化磁盘' };
  }
  if (/(^|[\s;&|()])dd\s+.*of=\/dev\/(sd|hd|nvme|vd)[a-z0-9]/.test(normalized)) {
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
  // 仅在命令位置识别执行器，避免把 grep node / find . 当作代码执行。
  // 常用启动器的参数（sudo -u root / env KEY=value）也纳入有限匹配。
  const executionPrefix =
    String.raw`(?:^|[;&|()\n])\s*` +
    String.raw`(?:(?:sudo|env|command|exec|nohup|busybox)\s+(?:[^\s;&|()]+\s+)*?)?` +
    String.raw`(?:[^\s;&|()]*\/)?`;

  // 不尝试还原动态 Shell 代码：执行包裹与 IFS 混淆统一交给用户确认。
  // 包括绝对路径解释器、管道/stdin 脚本与组合参数（bash -lc / python -c 等）。
  // 有意允许一定误报；正则不是完整 Shell 解析器，也不保证拦住所有绕过。
  const DANGEROUS_PATTERNS = [
    { pattern: /\$(?:\{ifs[^}]*\}|ifs\b)/, reason: '使用 IFS 动态构造命令' },
    { pattern: new RegExp(`${executionPrefix}eval(?=\\s|[;&|()]|$)`), reason: 'eval 动态执行命令' },
    {
      pattern: new RegExp(`${executionPrefix}(?:sh|bash|dash|ash|zsh|ksh|fish)(?=\\s|[;&|()]|$)`),
      reason: 'Shell 包裹或脚本执行',
    },
    {
      pattern: new RegExp(
        executionPrefix +
        String.raw`(?:python(?:\d+(?:\.\d+)*)?|pypy\d*|perl|ruby|node(?:js)?|php|` +
        String.raw`lua(?:\d+(?:\.\d+)*)?|awk|gawk|mawk)(?=\s|[;&|()]|$)`
      ),
      reason: '解释器执行代码或脚本',
    },
    // 嵌入 docker exec / find -exec / xargs 等非枚举启动器时，仍识别显式代码参数。
    {
      pattern: /(^|[\s;&|()])(?:[^\s;&|()]*\/)?(?:sh|bash|dash|ash|zsh|ksh|fish)\s+-[^\s;&|()]*c(?=\s|[;&|()]|$)/,
      reason: 'Shell 动态代码执行',
    },
    {
      pattern: /(^|[\s;&|()])(?:[^\s;&|()]*\/)?(?:python\d*|perl|ruby|node(?:js)?|php|lua)\s+(?:-[cer]|--eval)(?=\s|[;&|()]|$)/,
      reason: '解释器动态代码执行',
    },
    { pattern: new RegExp(`${executionPrefix}(?:source|\\.)(?=\\s)`), reason: '在当前 Shell 执行脚本' },
    { pattern: /(^|[\s;&|()])rm(?=\s|[;&|()]|$)/, reason: '删除文件操作' },
    { pattern: /(^|[\s;&|()])reboot(?=\s|[;&|()]|$)/, reason: '重启服务器' },
    { pattern: /(^|[\s;&|()])shutdown(?=\s|[;&|()]|$)/, reason: '关闭服务器' },
    { pattern: /(^|[\s;&|()])halt(?=\s|[;&|()]|$)/, reason: '停止服务器' },
    { pattern: /(^|[\s;&|()])poweroff(?=\s|[;&|()]|$)/, reason: '关闭服务器电源' },
    { pattern: /(^|[\s;&|()])init\s+[06](?=\s|[;&|()]|$)/, reason: '更改运行级别(关机或重启)' },
    { pattern: /(^|[\s;&|()])passwd(?=\s|[;&|()]|$)/, reason: '修改密码' },
    { pattern: /(^|[\s;&|()])chown\s+-r(?=\s|[;&|()]|$)/i, reason: '递归修改文件所有者' },
    { pattern: /(^|[\s;&|()])chmod\s+-r(?=\s|[;&|()]|$)/i, reason: '递归修改文件权限' },
    { pattern: /(^|[\s;&|()])fdisk(?=\s|[;&|()]|$)/, reason: '磁盘分区操作' },
    { pattern: /(^|[\s;&|()])parted(?=\s|[;&|()]|$)/, reason: '磁盘分区操作' },
    { pattern: /(^|[\s;&|()])dd(?=\s|[;&|()]|$)/, reason: '低级磁盘拷贝/覆盖' },
    { pattern: /(^|[\s;&|()])iptables\s+-f(?=\s|[;&|()]|$)/i, reason: '清空防火墙规则' },
    { pattern: /(^|[\s;&|()])iptables\s+-x(?=\s|[;&|()]|$)/i, reason: '清空自定义链表' },
    { pattern: /(^|[\s;&|()])ufw\s+disable(?=\s|[;&|()]|$)/i, reason: '禁用防火墙' },
    // 杀全部进程（一锅端），与按 PID 杀进程的 kill 不同，破坏面广且难以恢复
    { pattern: /(^|[\s;&|()])kill\s+-9\s+(-1|0|1)(?=\s|[;&|()]|$)/, reason: '杀死全部进程' },
    { pattern: /(^|[\s;&|()])kill\s+--signal\s+sigkill(?=\s|[;&|()]|$)/i, reason: '杀死进程' },
    // 远程脚本执行（curl/wget 管道给 shell），普通 curl/wget 不受影响
    { pattern: /(curl|wget)\b[^|]*\|\s*(sh|bash)(?=\s|[;&|()]|$)/i, reason: '远程下载并执行脚本' },
    // find 递归删除（直接 -delete 或 -exec rm），危险面广
    { pattern: /(^|[\s;&|()])find\s+.*-delete(?=\s|[;&|()]|$)/, reason: 'find 递归删除文件' },
    { pattern: /(^|[\s;&|()])find\s+.*-exec\s+rm(?=\s|[;&|()]|$)/, reason: 'find 递归执行 rm' },
  ];

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      return { required: true, reason: `${reason}，为保证安全需要确认` };
    }
  }

  return { required: false };
}

/**
 * Normalizes a Unix file path for security checks (resolves . and .. components).
 */
export function normalizeSecurityPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) return '';
  const isAbsolute = trimmed.startsWith('/');
  const parts = trimmed.split(/\/+/);
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push('..');
      }
    } else {
      stack.push(part);
    }
  }
  const resolved = stack.join('/');
  return isAbsolute ? `/${resolved}` : resolved;
}

/**
 * Checks if a file path is strictly blocked from any modification.
 */
export function isBlockedFilePath(filePath: string): { blocked: boolean; reason?: string } {
  const norm = normalizeSecurityPath(filePath).toLowerCase();
  if (norm.startsWith('/dev/') && !norm.startsWith('/dev/null')) {
    return { blocked: true, reason: '禁止对块设备或特殊设备节点执行写入操作' };
  }
  if (norm.startsWith('/proc/') || norm.startsWith('/sys/')) {
    return { blocked: true, reason: '禁止直接修改虚拟内核文件系统 (/proc, /sys)' };
  }
  return { blocked: false };
}

/**
 * Checks if reading a file requires user confirmation (e.g. private keys, shadow file).
 */
export function needsFileReadConfirmation(filePath: string): { required: boolean; reason?: string } {
  const norm = normalizeSecurityPath(filePath);
  const lower = norm.toLowerCase();

  if (lower === '/etc/shadow' || lower === '/etc/gshadow') {
    return { required: true, reason: `读取系统密码哈希敏感文件 (${norm})` };
  }

  // Private keys
  const filename = lower.split('/').pop() || '';
  if (
    filename === 'id_rsa' ||
    filename === 'id_ed25519' ||
    filename === 'id_ecdsa' ||
    filename === 'id_dsa' ||
    filename.endsWith('.pem') ||
    filename.endsWith('.key') ||
    lower.includes('/.ssh/id_')
  ) {
    return { required: true, reason: `读取私钥凭据文件 (${norm})` };
  }

  return { required: false };
}

/**
 * Checks if writing/modifying a file requires mandatory user confirmation.
 */
export function needsFileWriteConfirmation(filePath: string): { required: boolean; reason?: string } {
  const norm = normalizeSecurityPath(filePath);
  const lower = norm.toLowerCase();

  const blocked = isBlockedFilePath(filePath);
  if (blocked.blocked) {
    return { required: true, reason: blocked.reason };
  }

  // System configuration & boot
  if (lower.startsWith('/etc/')) {
    return { required: true, reason: `修改系统核心配置文件 (${norm})` };
  }
  if (lower.startsWith('/boot/')) {
    return { required: true, reason: `修改系统引导启动目录 (${norm})` };
  }
  if (
    lower.startsWith('/bin/') ||
    lower.startsWith('/sbin/') ||
    lower.startsWith('/usr/bin/') ||
    lower.startsWith('/usr/sbin/') ||
    lower.startsWith('/lib/') ||
    lower.startsWith('/lib64/')
  ) {
    return { required: true, reason: `修改系统二进制可执行程序或系统库 (${norm})` };
  }

  // Cron jobs
  if (lower.startsWith('/var/spool/cron/') || lower.includes('/cron.') || lower === '/etc/crontab') {
    return { required: true, reason: `修改系统定时任务配置 (${norm})` };
  }

  // SSH authorized keys and configuration
  if (lower.includes('/.ssh/') || lower.includes('/authorized_keys') || lower.endsWith('/.ssh')) {
    return { required: true, reason: `修改 SSH 授权公钥或配置 (${norm})` };
  }

  // Root home directory files
  if (lower.startsWith('/root/') && (lower.includes('/.') || lower.endsWith('.sh') || lower.endsWith('.conf'))) {
    return { required: true, reason: `修改 root 主目录下敏感文件 (${norm})` };
  }

  return { required: false };
}
