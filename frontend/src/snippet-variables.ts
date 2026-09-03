/**
 * 命令片段参数占位符（{{var}}）纯函数工具库。
 */

/**
 * 提取命令片段中的所有参数占位符名称（保持出现顺序并去重）。
 * 语法支持 {{var}} 或 {{ var }}，变量名可包含字母、数字、下划线、短横线以及任意非花括号字符。
 *
 * 示例：
 *   'docker logs -f --tail 100 {{container}} && docker top {{container}}' -> ['container']
 *   'ping -c 4 {{host}} -p {{port}}' -> ['host', 'port']
 */
export function extractSnippetVariables(command: string): string[] {
  const regex = /\{\{\s*([^}]+?)\s*\}\}/g;
  const seen = new Set<string>();
  const vars: string[] = [];
  for (const match of command.matchAll(regex)) {
    const name = match[1]?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      vars.push(name);
    }
  }
  return vars;
}

/**
 * 将命令片段中的 {{var}} 占位符安全替换为对应的值。
 * 若某个变量未在 values 中指定，则保持占位符原样。
 */
export function resolveSnippetVariables(
  command: string,
  values: Record<string, string>
): string {
  return command.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (fullMatch, varName: string) => {
    const key = varName.trim();
    if (Object.hasOwn(values, key)) {
      return values[key];
    }
    return fullMatch;
  });
}
