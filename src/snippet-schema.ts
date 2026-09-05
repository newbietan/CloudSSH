/**
 * 命令片段（Command Snippets）共享校验模式。
 *
 * Worker（/api/snippets → UserDBDO）与前端（匿名用户 localStorage 降级存储）
 * 共用同一套限额与校验逻辑，保证云端与本地两种存储后端行为一致。
 */

/** 每个用户最多保存的命令片段数量。 */
export const SNIPPET_MAX_COUNT = 100;
/** 片段名称最大长度（Unicode 码点）。 */
export const SNIPPET_NAME_MAX_LENGTH = 50;
/** 片段分类最大长度（Unicode 码点）。 */
export const SNIPPET_CATEGORY_MAX_LENGTH = 30;
/** 片段命令最大长度（Unicode 码点）。 */
export const SNIPPET_COMMAND_MAX_LENGTH = 2000;

export type SnippetValidationError =
  | 'nameRequired'
  | 'commandRequired'
  | 'nameTooLong'
  | 'commandTooLong'
  | 'categoryTooLong';

export interface NormalizedSnippetInput {
  name: string;
  command: string;
  category: string;
}

export type SnippetInputResult =
  | { ok: true; value: NormalizedSnippetInput }
  | { ok: false; error: SnippetValidationError };

/**
 * 校验并规范化片段输入：去除首尾空白后要求名称与命令均非空且不超过长度上限。
 * 分类为可选字段，去除首尾空白后不得超过长度上限，未提供时归一化为空字符串。
 * 长度按 Unicode 码点计数，避免多字节字符被字节长度误判。
 */
export function normalizeSnippetInput(
  name: unknown,
  command: unknown,
  category?: unknown
): SnippetInputResult {
  if (typeof name !== 'string') return { ok: false, error: 'nameRequired' };
  const trimmedName = name.trim();
  if (!trimmedName) return { ok: false, error: 'nameRequired' };
  if ([...trimmedName].length > SNIPPET_NAME_MAX_LENGTH) {
    return { ok: false, error: 'nameTooLong' };
  }

  if (typeof command !== 'string') return { ok: false, error: 'commandRequired' };
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return { ok: false, error: 'commandRequired' };
  if ([...trimmedCommand].length > SNIPPET_COMMAND_MAX_LENGTH) {
    return { ok: false, error: 'commandTooLong' };
  }

  let trimmedCategory = '';
  if (category !== undefined && category !== null) {
    if (typeof category !== 'string') {
      return { ok: false, error: 'categoryTooLong' };
    }
    trimmedCategory = category.trim();
    if ([...trimmedCategory].length > SNIPPET_CATEGORY_MAX_LENGTH) {
      return { ok: false, error: 'categoryTooLong' };
    }
  }

  return {
    ok: true,
    value: {
      name: trimmedName,
      command: trimmedCommand,
      category: trimmedCategory,
    },
  };
}
