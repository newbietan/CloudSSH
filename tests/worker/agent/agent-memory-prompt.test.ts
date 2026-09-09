import { describe, expect, it } from 'vitest';
import {
  extractDistillationSnapshot,
  formatDistillationMessages,
  formatDistillationPromptInput,
  formatServerMemoryForPrompt,
  MAX_MEMORY_PROMPT_CHARS,
  MEMORY_DISTILLATION_PROMPT,
  shouldBypassDistillation,
} from '../../../src/worker/agent/prompt';
import type { ChatMessage, UnifiedServerMemory } from '../../../src/worker/agent/types';

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

  it('bounds prompt length and strictly preserves guidance under full capacity', () => {
    const fixedNow = Date.now();
    const hugeMemory: UnifiedServerMemory = {
      workLogs: Array.from({ length: 10 }, (_, i) => ({
        id: i,
        user_id: 1,
        server_id: 1,
        title: `Work_${i}`,
        summary: 'x'.repeat(300),
        created_at: fixedNow,
        updated_at: fixedNow,
      })),
      knowledge: Array.from({ length: 50 }, (_, i) => ({
        id: i,
        user_id: 1,
        server_id: 1,
        category: 'credential',
        key: `key_${i}`,
        value: 'y'.repeat(512),
        created_at: fixedNow,
        updated_at: fixedNow,
      })),
    };

    const promptZh = formatServerMemoryForPrompt(hugeMemory, 'zh-CN', fixedNow, 'Asia/Shanghai');
    expect(promptZh.length).toBeLessThan(MAX_MEMORY_PROMPT_CHARS + 800);
    expect(promptZh).toContain('【记忆与连续性行为指引】');
    expect(promptZh).toContain('严禁再次向用户重复索取');

    const promptEn = formatServerMemoryForPrompt(hugeMemory, 'en-US', fixedNow, 'UTC');
    expect(promptEn.length).toBeLessThan(MAX_MEMORY_PROMPT_CHARS + 800);
    expect(promptEn).toContain('【Memory & Continuity Guidance】');
    expect(promptEn).toContain('DO NOT repeatedly ask the user for it!');
  });

  it('extracts distillation snapshot preserving the root user prompt in complex tasks', () => {
    // 模拟一个多轮复杂任务（超过 16 步）
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '排查 Nginx 启动失败原因并修复，Token: ghp_test123' },
    ];

    // 添加 10 轮工具交互（20 条消息）
    for (let i = 1; i <= 10; i++) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call_${i}`,
            type: 'function',
            function: {
              name: 'execute_command',
              arguments: JSON.stringify({ command: `cmd_${i}` }),
            },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: `call_${i}`,
        content: `output_${i}`,
      });
    }

    messages.push({
      role: 'assistant',
      content: '已经帮您修复了端口冲突并成功启动 Nginx 服务。',
    });

    const snapshot = extractDistillationSnapshot(messages);
    expect(snapshot.length).toBe(16); // 1 条用户起始意图 + 15 条尾部上下文
    expect(snapshot[0].role).toBe('user');
    expect(snapshot[0].content).toContain('排查 Nginx 启动失败原因并修复');
    expect(snapshot[0].content).toContain('ghp_test123');
    expect(snapshot[snapshot.length - 1].content).toContain('已经帮您修复了端口冲突');

    // 格式化文本输出：只输出高信息密度的诉求、命令与最终结论，彻底排除底层工具原始输出
    const formatted = formatDistillationMessages(snapshot);
    expect(formatted).toContain('用户诉求: 排查 Nginx 启动失败原因并修复');
    expect(formatted).toContain('执行操作: cmd_');
    expect(formatted).toContain('最终结论: 已经帮您修复了端口冲突');
    // 确保绝对不包含冗长的工具原始输出（output_）
    expect(formatted).not.toContain('output_');
  });

  it('handles small conversations and empty inputs cleanly', () => {
    expect(extractDistillationSnapshot([])).toEqual([]);

    const simpleMessages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '查看磁盘' },
      { role: 'assistant', content: '磁盘占用 20%' },
    ];
    const snapshot = extractDistillationSnapshot(simpleMessages);
    expect(snapshot.length).toBe(2);
    expect(snapshot[0].content).toBe('查看磁盘');
    expect(snapshot[1].content).toBe('磁盘占用 20%');
  });

  it('bypasses distillation on trivial greetings without tool calls and without knowledge', () => {
    // 纯问候且无工具调用 -> 熔断跳过
    const greetingSnapshot: ChatMessage[] = [
      { role: 'user', content: '你好！' },
      { role: 'assistant', content: '你好，有什么可以帮您？' },
    ];
    expect(shouldBypassDistillation(greetingSnapshot)).toBe(true);

    const hiSnapshot: ChatMessage[] = [
      { role: 'user', content: '  hi  ' },
      { role: 'assistant', content: 'Hello!' },
    ];
    expect(shouldBypassDistillation(hiSnapshot)).toBe(true);

    // 包含工具调用 -> 不跳过
    const toolSnapshot: ChatMessage[] = [
      { role: 'user', content: '你好' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'execute_command', arguments: '{"command":"uptime"}' },
          },
        ],
      },
    ];
    expect(shouldBypassDistillation(toolSnapshot)).toBe(false);

    // 虽无工具调用，但用户主动提供凭据/参数 -> 不跳过
    const credentialSnapshot: ChatMessage[] = [
      { role: 'user', content: '你好，这是我的 Token: ghp_1234567890abcdef' },
      { role: 'assistant', content: '收到您的 Token。' },
    ];
    expect(shouldBypassDistillation(credentialSnapshot)).toBe(false);
  });

  it('formats distillation prompt input with existing work logs and knowledge schema', () => {
    const snapshot: ChatMessage[] = [
      { role: 'user', content: '请将端口修改为 9090' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'execute_command',
              arguments: JSON.stringify({ command: 'sed -i s/8080/9090/ nginx.conf' }),
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: '已将端口修改为 9090。',
      },
    ];

    const promptInput = formatDistillationPromptInput(
      snapshot,
      [
        {
          id: 1,
          user_id: 1,
          server_id: 1,
          title: '排查端口占用',
          summary: '发现 8080 端口冲突',
          created_at: 1000,
          updated_at: 1000,
        },
      ],
      [
        {
          id: 10,
          user_id: 1,
          server_id: 1,
          category: 'config',
          key: 'app_port',
          value: '8080',
          created_at: 1000,
          updated_at: 1000,
        },
      ]
    );

    expect(promptInput).toContain('【服务器最近的工作历程】');
    expect(promptInput).toContain('- [排查端口占用]');
    expect(promptInput).toContain('发现 8080 端口冲突');
    expect(promptInput).toContain('【当前已沉淀的知识与凭据项（更新时请复用完全相同的 key 名）】');
    expect(promptInput).toContain('- [config] app_port: 8080');
    expect(promptInput).toContain('【本轮会话记录】');
    expect(promptInput).toContain('用户诉求: 请将端口修改为 9090');
    expect(promptInput).toContain('最终结论: 已将端口修改为 9090。');
  });

  it('injects strong consecutive merge guidance when recent log was updated within 30 minutes', () => {
    const snapshot: ChatMessage[] = [
      { role: 'user', content: '服务已成功启动' },
      { role: 'assistant', content: '8090 端口已正常监听。' },
    ];

    const baseTime = 1774900000000;
    const recentPromptInput = formatDistillationPromptInput(
      snapshot,
      [
        {
          id: 1,
          user_id: 1,
          server_id: 1,
          title: '排查端口并准备部署',
          summary: '8080 端口被占用，准备切换 8090',
          created_at: baseTime,
          updated_at: baseTime,
        },
      ],
      [],
      {
        now: baseTime + 5 * 60 * 1000, // 5 分钟后连续操作
        locale: 'zh-CN',
      }
    );

    expect(recentPromptInput).toContain('【连续运维任务合并强指引（非常重要）】');
    expect(recentPromptInput).toContain('排查端口并准备部署');
    expect(recentPromptInput).toContain('8080 端口被占用，准备切换 8090');
    expect(recentPromptInput).toContain('必须输出 "mode": "update_latest"');
    expect(recentPromptInput).toContain('严禁输出 "create" 造成连续操作被拆成多条琐碎的碎片日志');
  });
});
