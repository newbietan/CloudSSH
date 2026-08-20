import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalSnippetStore } from '../frontend/src/snippet-store';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  clear(): void {
    this.data.clear();
  }
}

describe('LocalSnippetStore 匿名降级', () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('空存储返回空数组', async () => {
    const store = new LocalSnippetStore(storage);
    expect(await store.list()).toEqual([]);
  });

  it('创建后可列出，更新与删除隔离', async () => {
    const store = new LocalSnippetStore(storage);
    const a = await store.create('查看磁盘', 'df -h');
    const b = await store.create('查内存', 'free -m');
    expect((await store.list()).length).toBe(2);
    const updated = await store.update(a.id, '看磁盘', 'df -hT');
    expect(updated.name).toBe('看磁盘');
    await store.remove(b.id);
    expect((await store.list()).length).toBe(1);
  });

  it('损坏的 JSON 返回空数组而非抛错', async () => {
    storage.setItem('cloudssh_snippets', 'not-json');
    const store = new LocalSnippetStore(storage);
    expect(await store.list()).toEqual([]);
  });

  it('达到上限后拒绝', async () => {
    const store = new LocalSnippetStore(storage);
    for (let i = 0; i < 100; i++) await store.create('n' + i, 'echo ' + i);
    await expect(store.create('overflow', 'echo hi')).rejects.toThrow();
  });
});
