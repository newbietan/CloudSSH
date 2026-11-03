import { describe, expect, it, vi } from 'vitest';
import { UserDBDO } from '../../../src/worker/user-db';

class ConfigSql {
  statements: Array<{ query: string; values: unknown[] }> = [];
  row: Record<string, any> | null = {
    base_url: 'https://api.example.com/v1', model: 'test-model', api_key_enc: 'encrypted-existing',
    api_key_last4: 'last', context_window: 32_768, max_output_tokens: 2048, updated_at: '',
  };
  constructor(private migrated = true) {}
  exec(query: string, ...values: unknown[]) {
    this.statements.push({ query, values });
    if (query === 'PRAGMA table_info(ai_configs)') {
      return { toArray: () => this.migrated ? [{ name: 'context_window' }, { name: 'max_output_tokens' }, { name: 'budget_source' }] : [] };
    }
    if (query.startsWith('SELECT') && query.includes('FROM ai_configs WHERE user_id = ?')) {
      return { toArray: () => values[0] === 7 && this.row ? [this.row] : [] };
    }
    if (query.startsWith('INSERT INTO ai_configs')) {
      const keepKey = query.includes("VALUES (?, ?, ?, '', ''");
      const index = keepKey ? 3 : 5;
      this.row = { ...this.row, base_url: values[1], model: values[2],
        api_key_enc: keepKey ? this.row?.api_key_enc : values[3],
        api_key_last4: keepKey ? this.row?.api_key_last4 : values[4],
        context_window: values[index], max_output_tokens: values[index + 1], budget_source: values[index + 2] };
    }
    return { toArray: () => [] };
  }
}
function setup(migrated = true) {
  const sql = new ConfigSql(migrated);
  const db = new UserDBDO({ storage: { sql } } as unknown as DurableObjectState, {} as never);
  return { sql, db };
}
function put(db: UserDBDO, values: Record<string, unknown> = {}) {
  return db.fetch(new Request('http://internal/internal/ai-config', { method: 'PUT',
    body: JSON.stringify({ user_id: 7, base_url: 'https://api.example.com/v1', model: 'test-model', ...values }) }));
}

describe('AI configuration model budgets', () => {
  it('upgrades old SQLite rows idempotently without Wrangler DO migrations', () => {
    const old = setup(false).sql;
    expect(old.statements.filter(item => item.query.startsWith('ALTER TABLE ai_configs'))).toHaveLength(3);
    expect(setup(true).sql.statements.some(item => item.query.startsWith('ALTER TABLE ai_configs'))).toBe(false);
  });
  it('derives limits from the model and keeps a provider-reported window', async () => {
    const { db, sql } = setup();
    expect((await put(db, { provider_context_window: 16_384, provider_max_output_tokens: 1024 })).status).toBe(200);
    expect(sql.row).toMatchObject({
      context_window: 16_384, max_output_tokens: 1024, budget_source: 'provider', api_key_enc: 'encrypted-existing',
    });
    const publicConfig = await db.fetch(new Request('http://internal/internal/ai-config?user_id=7'));
    const data = await publicConfig.json();
    expect(data).toMatchObject({ context_window: 16_384, max_output_tokens: 1024, budget_source: 'provider' });
    expect(JSON.stringify(data)).not.toContain('encrypted-existing');
    expect((await db.fetch(new Request('http://internal/internal/ai-config?user_id=8'))).status).toBe(200);
    await expect((await db.fetch(new Request('http://internal/internal/ai-config?user_id=8'))).json()).resolves.toEqual({ configured: false });
  });
  it('ignores handwritten budgets and recomputes when the model changes', async () => {
    const { db, sql } = setup();
    await put(db, { context_window: 16_384, max_output_tokens: 1024 });
    expect(sql.row).toMatchObject({ context_window: 128_000, max_output_tokens: 8192, budget_source: 'model' });
    await put(db, { model: 'gpt-6-luna' });
    expect(sql.row).toMatchObject({ context_window: 1_000_000, max_output_tokens: 128_000, budget_source: 'model' });
  });
  it('still requires a new key after an address change, including budget-only writes', async () => {
    const { db, sql } = setup();
    const response = await put(db, { base_url: 'https://other.example.com/v1', max_output_tokens: 1024 });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'responses_key_required' });
    expect(sql.row?.base_url).toBe('https://api.example.com/v1');
  });
  it('sends saved limits only through the internal decrypted-config path', async () => {
    const { db } = setup();
    vi.spyOn(db as any, 'decryptCredential').mockResolvedValue('private-test-key');
    const response = await db.fetch(new Request('http://internal/internal/ai-config/decrypt?user_id=7'));
    await expect(response.json()).resolves.toMatchObject({ api_key: 'private-test-key', context_window: 32_768, max_output_tokens: 2048 });
  });
  it('writes a new key and budgets together on the initial configuration', async () => {
    const { db, sql } = setup();
    sql.row = null;
    const encrypt = vi.spyOn(db as any, 'encryptCredential').mockResolvedValue('encrypted-new');
    expect((await put(db, { api_key: 'new-private-key', model: 'deepseek-v4-pro' })).status).toBe(200);
    expect(encrypt).toHaveBeenCalledWith('new-private-key', 7);
    expect(sql.row).toMatchObject({ api_key_enc: 'encrypted-new', context_window: 1_000_000, max_output_tokens: 128_000, budget_source: 'model' });
  });
});
