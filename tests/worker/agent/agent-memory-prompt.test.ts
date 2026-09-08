import { describe, expect, it } from 'vitest';
import {
  formatServerMemoryForPrompt,
  MAX_MEMORY_PROMPT_CHARS,
  MEMORY_DISTILLATION_PROMPT,
} from '../../../src/worker/agent/prompt';
import type { UnifiedServerMemory } from '../../../src/worker/agent/types';

describe('agent server memory prompt', () => {
  it('injects current system time even when memory is empty', () => {
    const fixedNow = new Date('2026-03-30T14:30:00Z').getTime();
    const promptZh = formatServerMemoryForPrompt({ workLogs: [], knowledge: [] }, 'zh-CN', fixedNow);
    const promptEn = formatServerMemoryForPrompt({ workLogs: [], knowledge: [] }, 'en-US', fixedNow);

    expect(promptZh).toContain('## 当前系统时间基准');
    expect(promptEn).toContain('## Current System Time');
  });

  it('formats work logs and knowledge with relative time and reuse guidance', () => {
    const fixedNow = new Date('2026-03-30T12:00:00').getTime();
    const memory: UnifiedServerMemory = {
      workLogs: [
        {
          id: 1,
          user_id: 1,
          server_id: 1,
          title: '检查服务器硬件信息',
          summary: 'CPU/内存/磁盘正常，负载处于低位',
          created_at: new Date('2026-03-29T14:00:00').getTime(), // 昨天
          updated_at: new Date('2026-03-29T14:00:00').getTime(),
        },
        {
          id: 2,
          user_id: 1,
          server_id: 1,
          title: '检查软件包更新',
          summary: '发现 12 个可升级包',
          created_at: new Date('2026-03-30T10:00:00').getTime(), // 今天
          updated_at: new Date('2026-03-30T10:00:00').getTime(),
        },
      ],
      knowledge: [
        {
          id: 10,
          user_id: 1,
          server_id: 1,
          category: 'credential',
          key: 'deploy_token',
          value: 'ghp_secret1234567890',
          created_at: fixedNow,
          updated_at: fixedNow,
        },
        {
          id: 11,
          user_id: 1,
          server_id: 1,
          category: 'config',
          key: 'docker_registry',
          value: 'reg.internal:5000',
          created_at: fixedNow,
          updated_at: fixedNow,
        },
      ],
    };

    const promptZh = formatServerMemoryForPrompt(memory, 'zh-CN', fixedNow);
    expect(promptZh).toContain('## 当前系统时间基准');
    expect(promptZh).toContain('## 服务器近期工作历程与操作备忘');
    expect(promptZh).toContain('(昨天');
    expect(promptZh).toContain('检查服务器硬件信息: CPU/内存/磁盘正常');
    expect(promptZh).toContain('(今天');
    expect(promptZh).toContain('检查软件包更新: 发现 12 个可升级包');
    expect(promptZh).toContain('## 关键上下文知识、参数与凭据备忘');
    expect(promptZh).toContain('- [凭据/密钥] deploy_token: ghp_secret1234567890');
    expect(promptZh).toContain('- [环境参数] docker_registry: reg.internal:5000');
    expect(promptZh).toContain('请直接带入使用，严禁再次向用户重复索取');

    const promptEn = formatServerMemoryForPrompt(memory, 'en-US', fixedNow);
    expect(promptEn).toContain('## Current System Time');
    expect(promptEn).toContain('## Recent Server Work Logs');
    expect(promptEn).toContain('(Yesterday');
    expect(promptEn).toContain('(Today');
    expect(promptEn).toContain('- [Credential] deploy_token: ghp_secret1234567890');
    expect(promptEn).toContain('REUSE IT DIRECTLY. DO NOT repeatedly ask the user for it');
  });

  it('provides a distillation prompt covering both work logs and user-supplied credentials/knowledge', () => {
    expect(MEMORY_DISTILLATION_PROMPT).toContain('服务器智能会话总结助手');
    expect(MEMORY_DISTILLATION_PROMPT).toContain('workLog');
    expect(MEMORY_DISTILLATION_PROMPT).toContain('knowledge');
    expect(MEMORY_DISTILLATION_PROMPT).toContain('credential');
    expect(MEMORY_DISTILLATION_PROMPT).toContain('下次用户再次执行类似操作时，AI 可以直接复用这些参数与凭据');
  });

  it('bounds prompt length', () => {
    const fixedNow = Date.now();
    const hugeMemory: UnifiedServerMemory = {
      workLogs: Array.from({ length: 10 }, (_, i) => ({
        id: i,
        user_id: 1,
        server_id: 1,
        title: `Work_${i}`,
        summary: 'x'.repeat(200),
        created_at: fixedNow,
        updated_at: fixedNow,
      })),
      knowledge: Array.from({ length: 20 }, (_, i) => ({
        id: i,
        user_id: 1,
        server_id: 1,
        category: 'note',
        key: `key_${i}`,
        value: 'y'.repeat(200),
        created_at: fixedNow,
        updated_at: fixedNow,
      })),
    };

    const prompt = formatServerMemoryForPrompt(hugeMemory, 'zh-CN', fixedNow);
    expect(prompt.length).toBeLessThan(MAX_MEMORY_PROMPT_CHARS + 800);
  });
});
