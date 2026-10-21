import { afterEach, describe, expect, it, vi } from 'vitest';
import { distillMemory } from '../../../src/worker/agent/memory';
import { formatServerMemoryForPrompt } from '../../../src/worker/agent/prompt';
import { normalizeKnowledgeInput, type UnifiedServerMemory } from '../../../src/server-memory-schema';
import type { MemoryTask } from '../../../src/worker/agent/types';
import { aiConfig, responseObject } from './responses-fixtures';

vi.mock('../../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));
afterEach(() => vi.restoreAllMocks());
const key = 'prefix-' + 'A'.repeat(1200) + '-suffix';
const memory: UnifiedServerMemory = { revision: 3, workLogs: [], knowledge: [{ id: 1, user_id: 1, server_id: 1,
  category: 'credential', key: 'deployment_key', value: key, created_at: 1, updated_at: 1 }] };
const task: MemoryTask = { taskId: 'task-1', goal: '部署服务', conversation: '用户要求部署；执行配置读取后拿到已有密钥，服务随后启动。',
  locale: 'zh-CN', timezone: 'UTC' };

describe('Practical server memory', () => {
  it('provides saved credentials in full without requiring a matching key name in the request', () => {
    const prompt = formatServerMemoryForPrompt(memory);
    expect(prompt).toContain(key);
    expect(prompt).not.toMatch(/REDACTED|prefix-\.\.\./);
    expect(normalizeKnowledgeInput({ category: 'credential', key: 'private_key', value: '  ' + key + '\n' }))
      .toMatchObject({ ok: true, value: { value: '  ' + key + '\n' } });
  });

  it('summarizes conversation and saves reusable values without source/evidence rules', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(responseObject('memory', JSON.stringify({
      workLog: { mode: 'create', title: '部署服务', summary: '使用已有密钥完成部署，服务启动正常。' },
      knowledge: [{ action: 'set', category: 'credential', key: 'service_key', value: key }],
    }))));
    const result = await distillMemory(aiConfig, task, memory, new AbortController().signal);
    expect(result).toMatchObject({ expectedRevision: 3, workLog: { title: '部署服务' }, knowledge: [{ key: 'service_key', value: key }] });
    const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(request.store).toBe(false);
    expect(request).not.toHaveProperty('tools');
    expect(request.input[0].content).toContain(key);
    expect(request.input[0].content).toContain(task.conversation);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('supports updating and forgetting existing knowledge as proposed by the model', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(responseObject('memory', JSON.stringify({
      workLog: null, knowledge: [{ action: 'delete', category: 'note', key: 'old_port', value: null },
        { action: 'set', category: 'config', key: 'port', value: '8080' }],
    }))));
    expect((await distillMemory(aiConfig, task, memory, new AbortController().signal)).knowledge)
      .toEqual([{ action: 'delete', category: 'note', key: 'old_port', value: '' },
        { action: 'set', category: 'config', key: 'port', value: '8080' }]);
  });

  it('leaves failed generation to the single background retry path', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(responseObject('memory', 'invalid JSON')));
    await expect(distillMemory(aiConfig, task, memory, new AbortController().signal)).rejects.toMatchObject({ code: 'responses_schema' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
