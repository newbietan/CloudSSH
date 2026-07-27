const SHELL_LANGUAGES = new Set([
  'bash',
  'cmd',
  'fish',
  'powershell',
  'pwsh',
  'sh',
  'shell',
  'shellscript',
  'zsh',
]);

export function normalizeCodeLanguage(language: string | null | undefined): string {
  return (language || '')
    .trim()
    .split(/\s+/, 1)[0]
    .toLowerCase()
    .replace(/^language-/, '');
}

/**
 * 仅从明确标注为 Shell 的单行代码块中提取可填入终端的命令。
 * 返回 null 表示代码块仍可复制，但不应提供“填入终端”操作。
 */
export function getTerminalFillCommand(
  language: string | null | undefined,
  code: string,
): string | null {
  if (!SHELL_LANGUAGES.has(normalizeCodeLanguage(language))) return null;

  const command = code.replace(/\r\n?/g, '\n').trim();
  if (!command || command.includes('\n')) return null;
  if (/[\u0000-\u001f\u007f]/.test(command)) return null;

  return command.startsWith('$ ') ? command.slice(2).trimStart() || null : command;
}
