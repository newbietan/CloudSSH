import { describe, expect, it, vi } from 'vitest';
import { ExecutionJournal, redactEvidence } from '../../../src/worker/agent/execution-journal';
import { AgentMemoryManager, selectServerMemory } from '../../../src/worker/agent/memory';
import type { AgentMemoryProvider, UnifiedServerMemory } from '../../../src/worker/agent/types';
import { aiConfig, functionCall, responseObject } from './responses-fixtures';

vi.mock('../../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));

const sampleMemory: UnifiedServerMemory = {
  revision: 3,
  workLogs: [
    { id: 1, user_id: 1, server_id: 1, title: '检查服务', summary: '重启 nginx', created_at: 1000, updated_at: 1000 },
    { id: 2, user_id: 1, server_id: 1, title: '配置端口', summary: '修改为 8080', created_at: 2000, updated_at: 2000 },
  ],
  knowledge: [
    { id: 10, user_id: 1, server_id: 1, category: 'config', key: 'nginx_port', value: '8080', created_at: 1000, updated_at: 1000 },
    { id: 11, user_id: 1, server_id: 1, category: 'credential', key: 'db_password', value: 'secret123', created_at: 1000, updated_at: 1000 },
    { id: 12, user_id: 1, server_id: 1, category: 'rule', key: 'deploy_rule', value: 'use docker', created_at: 1000, updated_at: 1000 },
    { id: 13, user_id: 1, server_id: 1, category: 'config', key: 'redis_path', value: '/var/run/redis', created_at: 1000, updated_at: 1000, stale: true },
  ],
};

describe('AgentMemoryManager and selectServerMemory', () => {
  it('selects task-relevant knowledge and rules while omitting irrelevant credentials and stale items', () => {
    const selected = selectServerMemory(sampleMemory, '检查 nginx 端口配置');
    const keys = selected.knowledge.map(k => k.key);
    expect(keys).toContain('nginx_port');
    expect(keys).toContain('deploy_rule');
    expect(keys).not.toContain('db_password');
    expect(keys).not.toContain('redis_path');
    expect(selected.workLogs.length).toBeGreaterThanOrEqual(1);
    expect(selected.workLogs.map(l => l.title)).toContain('配置端口');
  });

  it('selects credentials only when explicitly relevant to the goal', () => {
    const selected = selectServerMemory(sampleMemory, '连接 db_password 数据库');
    const keys = selected.knowledge.map(k => k.key);
    expect(keys).toContain('db_password');
  });

  it('includes historical work logs when user asks about previous work', () => {
    const selected = selectServerMemory(sampleMemory, '今天做了哪些工作？');
    expect(selected.workLogs).toHaveLength(2);
  });

  it('ExecutionJournal tracks outcomes, redacts credentials, and projects task evidence', () => {
    const journal = new ExecutionJournal();
    const call1 = functionCall('c1', 'execute_command', { command: 'echo "password=supersecret"' });
    const fact1 = journal.settle('task_1', call1, JSON.stringify({ stdout: 'password=supersecret', exit_code: 0 }));
    expect(fact1.status).toBe('succeeded');
    expect(fact1.executed).toBe(true);
    expect(fact1.description).toContain('[REDACTED]');
    expect(fact1.evidence).toContain('[REDACTED]');

    const call2 = functionCall('c2', 'execute_command', { command: 'rm -rf /' });
    const fact2 = journal.settle('task_1', call2, JSON.stringify({ stderr: 'Blocked', blocked: true, exit_code: -1 }));
    expect(fact2.status).toBe('blocked');
    expect(fact2.executed).toBe(false);

    const records = journal.taskRecords('task_1', '检查密码');
    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({ role: 'user', content: '检查密码' });
  });

  it('redactEvidence masks common token patterns and private keys', () => {
    expect(redactEvidence('sk-abcdef1234567890abcdef')).toBe('[REDACTED TOKEN]');
    expect(redactEvidence('Bearer ya29.abcdef1234567890')).toBe('Bearer [REDACTED]');
    expect(redactEvidence('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----')).toBe('[REDACTED PRIVATE KEY]');
  });

  it('AgentMemoryManager queues distillation, respects revision, and updates memory', async () => {
    const saved: any[] = [];
    const provider: AgentMemoryProvider = {
      fetchUnifiedMemory: vi.fn(async () => ({ ...sampleMemory, revision: 4 })),
      saveBatchMemory: vi.fn(async batch => { saved.push(batch); }),
    };
    const emitted: any[] = [];
    const manager = new AgentMemoryManager(provider, () => 1, frame => emitted.push(frame));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(responseObject('resp_mem', JSON.stringify({
      workLog: { mode: 'update_latest', title: '更新 nginx 端口', summary: '成功修改为 8080' },
      knowledge: [{ action: 'set', category: 'config', key: 'nginx_port', value: '8080' }],
    })))));

    const journal = new ExecutionJournal();
    const call = functionCall('c1', 'execute_command', { command: 'systemctl restart nginx' });
    journal.settle('task_1', call, JSON.stringify({ stdout: 'restarted port 8080', exit_code: 0 }));
    const taskRecords = journal.taskRecords('task_1', '重启 nginx');

    await manager.enqueue({
      records: taskRecords,
      memory: sampleMemory,
      goal: '重启 nginx',
      config: aiConfig,
      locale: 'zh-CN',
      timezone: 'UTC',
      interrupted: false,
      iteration: 2,
      epoch: 1,
      sessionId: 'sess_1',
    });

    expect(provider.saveBatchMemory).toHaveBeenCalledTimes(1);
    expect(saved[0]).toMatchObject({
      expectedRevision: 3,
      sessionId: 'sess_1',
      workLog: { title: '更新 nginx 端口' },
    });
    expect(emitted).toContainEqual({ subType: 'memory_updated' });
  });

  it('emits conflict status when provider rejects with 409', async () => {
    const provider: AgentMemoryProvider = {
      fetchUnifiedMemory: vi.fn(async () => sampleMemory),
      saveBatchMemory: vi.fn(async () => {
        const err: any = new Error('Conflict');
        err.status = 409;
        throw err;
      }),
    };
    const emitted: any[] = [];
    const manager = new AgentMemoryManager(provider, () => 1, frame => emitted.push(frame));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(responseObject('resp_mem', JSON.stringify({
      workLog: { mode: 'create', title: '测试', summary: '测试' },
      knowledge: [],
    })))));

    const journal = new ExecutionJournal();
    const call = functionCall();
    journal.settle('task_1', call, JSON.stringify({ stdout: 'ok', exit_code: 0 }));
    const taskRecords = journal.taskRecords('task_1', '测试');

    await manager.enqueue({
      records: taskRecords,
      memory: sampleMemory,
      goal: '测试',
      config: aiConfig,
      locale: 'zh-CN',
      timezone: 'UTC',
      interrupted: false,
      iteration: 1,
      epoch: 1,
      sessionId: 'sess_1',
    });

    expect(emitted).toContainEqual({ subType: 'memory_status', code: 'memory_failed' });
  });
});
