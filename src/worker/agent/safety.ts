// Strict whitelist-based command safety logic

const SAFE_COMMANDS = new Set([
  'pwd', 'ls', 'cat', 'whoami', 'id', 'groups', 
  'uname', 'uptime', 'date', 'echo', 'which', 'whereis', 
  'hostname', 'ps', 'df', 'free', 'head', 'tail', 'wc', 'grep', 'stat', 'file'
]);

/**
 * Check if a command is blocked (never allowed)
 * In the new whitelist model, we no longer outright block commands.
 * We simply require user confirmation for anything not explicitly whitelisted.
 */
export function isBlockedCommand(command: string): { blocked: boolean; reason?: string } {
  return { blocked: false };
}

/**
 * Check if a command requires user confirmation
 * Only explicitly safe, read-only commands can run without confirmation.
 */
export function needsConfirmation(command: string): { required: boolean; reason?: string } {
  const trimmed = command.trim();
  
  // Extract the base command (first word)
  const baseCmd = trimmed.split(/\s+/)[0];
  
  // If not in the whitelist, requires confirmation
  if (!SAFE_COMMANDS.has(baseCmd)) {
    return { required: true, reason: `命令 ${baseCmd} 未在安全白名单中，需要确认` };
  }
  
  // Even if the base command is whitelisted, check for dangerous shell metacharacters
  // like pipes, redirections, logical operators, variable expansion, or subshells.
  if (/[|><;&$()\{\}\\\`]/.test(trimmed)) {
    return { required: true, reason: '命令包含复杂的 shell 元字符，需要确认以保证安全' };
  }
  
  // Check for sudo - even for whitelisted commands, we prompt for sudo just to be safe
  if (trimmed.includes('sudo')) {
    return { required: true, reason: '命令使用了 sudo 提权，需要确认' };
  }

  return { required: false };
}
