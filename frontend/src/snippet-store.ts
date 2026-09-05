/**
 * 命令片段存储层。
 *
 * - 登录用户：RemoteSnippetStore → /api/snippets（云端 UserDBDO，跨设备同步）
 * - 匿名用户：LocalSnippetStore → localStorage（仅本机，不落库）
 *
 * 两种后端共用 src/snippet-schema.ts 的限额与校验，行为保持一致。
 */

import {
  normalizeSnippetInput,
  SNIPPET_CATEGORY_MAX_LENGTH,
  SNIPPET_COMMAND_MAX_LENGTH,
  SNIPPET_MAX_COUNT,
  SNIPPET_NAME_MAX_LENGTH,
  type SnippetValidationError,
} from '../../src/snippet-schema';
import { t } from './i18n';

export interface CommandSnippet {
  id: string;
  name: string;
  command: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

export type SnippetErrorCode = SnippetValidationError | 'limitReached' | 'notFound' | 'network';

export class SnippetStoreError extends Error {
  constructor(public readonly code: SnippetErrorCode) {
    super(`Snippet store error: ${code}`);
    this.name = 'SnippetStoreError';
  }
}

export interface SnippetStore {
  list(): Promise<CommandSnippet[]>;
  create(name: string, command: string, category?: string): Promise<CommandSnippet>;
  update(id: string, name: string, command: string, category?: string): Promise<CommandSnippet>;
  remove(id: string): Promise<void>;
}

/** 将存储层错误映射为面向用户的多语言提示。 */
export function snippetErrorMessage(error: unknown): string {
  if (error instanceof SnippetStoreError) {
    switch (error.code) {
      case 'nameRequired':
        return t('snippets.error.nameRequired');
      case 'commandRequired':
        return t('snippets.error.commandRequired');
      case 'nameTooLong':
        return t('snippets.error.nameTooLong', {
          max: SNIPPET_NAME_MAX_LENGTH,
        });
      case 'commandTooLong':
        return t('snippets.error.commandTooLong', {
          max: SNIPPET_COMMAND_MAX_LENGTH,
        });
      case 'categoryTooLong':
        return t('snippets.error.categoryTooLong', {
          max: SNIPPET_CATEGORY_MAX_LENGTH,
        });
      case 'limitReached':
        return t('snippets.error.limitReached', { max: SNIPPET_MAX_COUNT });
      case 'notFound':
        return t('snippets.error.notFound');
      case 'network':
        return t('snippets.error.network');
      default:
        return t('snippets.saveFailed');
    }
  }
  return t('snippets.saveFailed');
}

// ==================== 云端存储（登录用户） ====================

interface SnippetRow {
  id: number | string;
  name: string;
  command: string;
  category?: string;
  created_at?: string;
  updated_at?: string;
}

function toSnippet(row: SnippetRow): CommandSnippet {
  return {
    id: String(row.id),
    name: row.name,
    command: row.command,
    category: row.category ?? '',
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  };
}

async function toStoreError(response: Response): Promise<SnippetStoreError> {
  let code: SnippetErrorCode = 'network';
  try {
    const body = (await response.json()) as { error?: unknown };
    if (body && typeof body.error === 'string') code = body.error as SnippetErrorCode;
  } catch {
    // 保留默认 network 错误码
  }
  return new SnippetStoreError(code);
}

export class RemoteSnippetStore implements SnippetStore {
  async list(): Promise<CommandSnippet[]> {
    const response = await fetch('/api/snippets');
    if (!response.ok) throw await toStoreError(response);
    const rows = (await response.json()) as SnippetRow[];
    return Array.isArray(rows) ? rows.map(toSnippet) : [];
  }

  async create(name: string, command: string, category?: string): Promise<CommandSnippet> {
    const normalized = normalizeSnippetInput(name, command, category);
    if (!normalized.ok) throw new SnippetStoreError(normalized.error);
    const response = await fetch('/api/snippets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: normalized.value.name,
        command: normalized.value.command,
        category: normalized.value.category,
      }),
    });
    if (!response.ok) throw await toStoreError(response);
    return toSnippet((await response.json()) as SnippetRow);
  }

  async update(
    id: string,
    name: string,
    command: string,
    category?: string
  ): Promise<CommandSnippet> {
    const normalized = normalizeSnippetInput(name, command, category);
    if (!normalized.ok) throw new SnippetStoreError(normalized.error);
    const response = await fetch(`/api/snippets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: normalized.value.name,
        command: normalized.value.command,
        category: normalized.value.category,
      }),
    });
    if (!response.ok) throw await toStoreError(response);
    return toSnippet((await response.json()) as SnippetRow);
  }

  async remove(id: string): Promise<void> {
    const response = await fetch(`/api/snippets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await toStoreError(response);
  }
}

// ==================== 本地存储（匿名用户降级） ====================

const LOCAL_STORAGE_KEY = 'cloudssh_snippets';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function isStoredSnippet(value: unknown): value is CommandSnippet {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.command === 'string' &&
    (item.category === undefined || typeof item.category === 'string') &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string'
  );
}

export class LocalSnippetStore implements SnippetStore {
  constructor(private readonly storage: StorageLike = localStorage) {}

  async list(): Promise<CommandSnippet[]> {
    return this.read();
  }

  async create(name: string, command: string, category?: string): Promise<CommandSnippet> {
    const normalized = normalizeSnippetInput(name, command, category);
    if (!normalized.ok) throw new SnippetStoreError(normalized.error);
    const items = this.read();
    if (items.length >= SNIPPET_MAX_COUNT) throw new SnippetStoreError('limitReached');
    const now = new Date().toISOString();
    const snippet: CommandSnippet = {
      id: crypto.randomUUID(),
      name: normalized.value.name,
      command: normalized.value.command,
      category: normalized.value.category,
      createdAt: now,
      updatedAt: now,
    };
    items.push(snippet);
    this.write(items);
    return snippet;
  }

  async update(
    id: string,
    name: string,
    command: string,
    category?: string
  ): Promise<CommandSnippet> {
    const normalized = normalizeSnippetInput(name, command, category);
    if (!normalized.ok) throw new SnippetStoreError(normalized.error);
    const items = this.read();
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new SnippetStoreError('notFound');
    const updated: CommandSnippet = {
      ...items[index],
      name: normalized.value.name,
      command: normalized.value.command,
      category: normalized.value.category,
      updatedAt: new Date().toISOString(),
    };
    items[index] = updated;
    this.write(items);
    return updated;
  }

  async remove(id: string): Promise<void> {
    this.write(this.read().filter((item) => item.id !== id));
  }

  private read(): CommandSnippet[] {
    try {
      const raw = this.storage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isStoredSnippet).map((item) => ({
        ...item,
        category: item.category ?? '',
      }));
    } catch {
      return [];
    }
  }

  private write(items: CommandSnippet[]): void {
    this.storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(items));
  }
}
