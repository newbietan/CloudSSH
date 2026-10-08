import { describe, expect, it } from 'vitest';
import {
  extractDistillationSnapshot, formatDistillationMessages, formatDistillationPromptInput,
  formatServerMemoryForPrompt, MAX_MEMORY_PROMPT_CHARS, MEMORY_DISTILLATION_PROMPT,
  MEMORY_FORMAT, CHECKPOINT_FORMAT, shouldBypassDistillation,
} from '../../../src/worker/agent/prompt';
import type { TaskRecord, UnifiedServerMemory } from '../../../src/worker/agent/types';
import { functionCall } from './responses-fixtures';

const now = new Date('2026-03-30T12:00:00Z').getTime();
const memory: UnifiedServerMemory = {
  workLogs: [{ id: 1, user_id: 1, server_id: 1, title: '检查端口', summary: '8080 被占用', created_at: now - 86400000, updated_at: now - 86400000 }],
  knowledge: [{ id: 1, user_id: 1, server_id: 1, category: 'credential', key: 'deploy_token', value: 'ghp_example', created_at: now, updated_at: now }],
};

describe('Responses task records and server memory', () => {
  it('anchors system time even without memory in every locale', () => {
    for (const [locale, heading] of [['zh-CN', '当前系统时间'], ['zh-TW', '當前系統時間'], ['en-US', 'Current System Time']] as const) {
      expect(formatServerMemoryForPrompt({ workLogs: [], knowledge: [] }, locale, now, 'UTC')).toContain(heading);
    }
  });

  it('preserves timestamped work logs, credentials, and reuse guidance', () => {
    const zh = formatServerMemoryForPrompt(memory, 'zh-CN', now, 'UTC');
    expect(zh).toContain('昨天'); expect(zh).toContain('8080 被占用');
    expect(zh).toContain('deploy_token: ghp_example'); expect(zh).toContain('严禁再次向用户重复索取');
    const tw = formatServerMemoryForPrompt(memory, 'zh-TW', now, 'UTC');
    expect(tw).toContain('憑據／金鑰'); expect(tw).toContain('嚴禁再次向使用者重複索取');
    const en = formatServerMemoryForPrompt(memory, 'en-US', now, 'UTC');
    expect(en).toContain('Yesterday'); expect(en).toContain('REUSE IT DIRECTLY');
  });

  it('bounds full-capacity memory without cutting continuity guidance', () => {
    const huge = { workLogs: Array.from({ length: 10 }, (_, i) => ({ ...memory.workLogs[0], id: i, summary: 'x'.repeat(300) })),
      knowledge: Array.from({ length: 50 }, (_, i) => ({ ...memory.knowledge[0], id: i, key: `key_${i}`, value: 'y'.repeat(512) })) };
    for (const locale of ['zh-CN', 'zh-TW', 'en-US'] as const) {
      const text = formatServerMemoryForPrompt(huge, locale, now, 'UTC');
      expect(text.length).toBeLessThan(MAX_MEMORY_PROMPT_CHARS + 800);
      expect(text).toContain(locale === 'en-US' ? 'DO NOT repeatedly ask' : locale === 'zh-TW' ? '嚴禁再次' : '严禁再次');
    }
  });

  it('retains the root user request and latest bounded task evidence', () => {
    const records: TaskRecord[] = [{ role: 'user', content: '修复 nginx，token=ghp_example' }];
    for (let i = 1; i <= 10; i++) {
      const call = functionCall(`call_${i}`, 'execute_command', { command: `cmd_${i}`, timeout_ms: null });
      records.push({ role: 'assistant', content: '', calls: [call] });
      records.push({ role: 'tool', callId: call.call_id, content: JSON.stringify({ stdout: 'x'.repeat(20_000), stderr: '', exit_code: 0 }) });
    }
    records.push({ role: 'assistant', content: '服务已恢复' });
    const snapshot = extractDistillationSnapshot(records);
    expect(snapshot).toHaveLength(16);
    expect(snapshot[0].content).toContain('token=ghp_example');
    const text = formatDistillationMessages(snapshot);
    expect(text).toContain('用户诉求: 修复 nginx');
    expect(text).toContain('执行操作: cmd_');
    expect(text).toContain('exit_code');
    expect(text).toContain('最终结论: 服务已恢复');
    expect(text).not.toContain('x'.repeat(1000));
  });

  it('does not describe a proposed/unexecuted call as executed', () => {
    const records: TaskRecord[] = [{ role: 'user', content: '检查' }, { role: 'assistant', content: '', calls: [functionCall()] }];
    expect(formatDistillationMessages(records)).not.toContain('执行操作:');
    records.push({ role: 'tool', callId: 'call_1', content: '{"status":"cancelled","executed":false}' });
    expect(formatDistillationMessages(records)).toContain('cancelled');
  });

  it('bypasses trivial greetings but retains real tasks and supplied knowledge', () => {
    expect(extractDistillationSnapshot([])).toEqual([]);
    for (const greeting of ['你好！', 'hi', '早安，在嗎？']) {
      expect(shouldBypassDistillation([{ role: 'user', content: greeting }, { role: 'assistant', content: 'Hello' }])).toBe(true);
    }
    expect(shouldBypassDistillation([{ role: 'user', content: '請記住連接埠 5432' }])).toBe(false);
    expect(shouldBypassDistillation([{ role: 'assistant', content: '', calls: [functionCall()] }])).toBe(false);
  });

  it('includes existing entities and consecutive-work merge instructions', () => {
    const records: TaskRecord[] = [{ role: 'user', content: '改为 9090' }, { role: 'assistant', content: '修改完成' }];
    const recent = [{ ...memory.workLogs[0], updated_at: now - 5 * 60000 }];
    const text = formatDistillationPromptInput(records, recent, memory.knowledge, { now, locale: 'zh-CN', timeZone: 'UTC' });
    expect(text).toContain('当前已沉淀的知识'); expect(text).toContain('deploy_token');
    expect(text).toContain('用户诉求: 改为 9090'); expect(text).toContain('最终结论: 修改完成');
    expect(text).toContain('必须输出 "mode": "update_latest"');
    const tw = formatDistillationPromptInput(records, recent, [], { now, locale: 'zh-TW', timeZone: 'UTC' });
    expect(tw).toContain('必須輸出 "mode": "update_latest"');
  });

  it('uses strict structured schemas for both checkpoint and memory, allowing null workLog', () => {
    expect(MEMORY_DISTILLATION_PROMPT).toContain('服务器智能会话总结助手');
    expect(MEMORY_DISTILLATION_PROMPT).toContain('状态不明');
    expect(MEMORY_FORMAT.schema.required).toEqual(['workLog', 'knowledge']);
    expect(MEMORY_FORMAT.schema.properties.workLog.anyOf[0]).toEqual({ type: 'null' });
    expect(CHECKPOINT_FORMAT.schema.required).toContain('unknown');
    expect(CHECKPOINT_FORMAT.schema.additionalProperties).toBe(false);
  });
});
