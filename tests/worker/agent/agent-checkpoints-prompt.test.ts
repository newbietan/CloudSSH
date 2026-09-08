import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_DISTILLATION_PROMPT,
  formatTaskCheckpoints,
  MAX_CHECKPOINT_PROMPT_CHARS,
} from '../../../src/worker/agent/prompt';
import type { AgentCheckpointItem } from '../../../src/worker/agent/types';

describe('agent server checkpoints prompt', () => {
  it('returns empty string when no checkpoints provided', () => {
    expect(formatTaskCheckpoints([])).toBe('');
    expect(formatTaskCheckpoints(null as unknown as AgentCheckpointItem[])).toBe('');
  });

  it('formats task checkpoints into structured markdown with status and guidance', () => {
    const checkpoints: AgentCheckpointItem[] = [
      {
        id: 1,
        title: '排查 502 错误',
        status: 'in_progress',
        done_summary: '定位为 3000 端口 Node 崩溃，已修复依赖并重启服务',
        next_step: '待执行 curl 探测本地端口确认恢复',
      },
      {
        id: 2,
        title: '升级 MySQL 配置',
        status: 'completed',
        done_summary: '优化了 max_connections 参数并重启服务',
        next_step: '已验证正常运行',
      },
    ];

    const formattedZh = formatTaskCheckpoints(checkpoints, 'zh-CN');
    expect(formattedZh).toContain('## 近期运维断点与任务接续 (Server Task Checkpoints)');
    expect(formattedZh).toContain('- [任务] 排查 502 错误 (进行中)');
    expect(formattedZh).toContain('* 已完成/进展: 定位为 3000 端口 Node 崩溃，已修复依赖并重启服务');
    expect(formattedZh).toContain('* 当前断点/下一步: 待执行 curl 探测本地端口确认恢复');
    expect(formattedZh).toContain('- [任务] 升级 MySQL 配置 (已完成)');
    expect(formattedZh).toContain('注意：若用户提问涉及“继续”、“恢复任务”或“刚才到哪了”');

    const formattedEn = formatTaskCheckpoints(checkpoints, 'en-US');
    expect(formattedEn).toContain('## Recent Task Continuity & Checkpoints');
    expect(formattedEn).toContain('- [Task] 排查 502 错误 (In Progress)');
    expect(formattedEn).toContain('* Completed: 定位为 3000 端口 Node 崩溃');
    expect(formattedEn).toContain('* Breakpoint / Next step: 待执行 curl 探测');
    expect(formattedEn).toContain('- [Task] 升级 MySQL 配置 (Completed)');
  });

  it('provides a distillation prompt with strict JSON requirements and anti-leak rules', () => {
    expect(CHECKPOINT_DISTILLATION_PROMPT).toContain('Linux 运维任务总结助手');
    expect(CHECKPOINT_DISTILLATION_PROMPT).toContain('严禁提取或包含任何用户密码、密钥、Token');
    expect(CHECKPOINT_DISTILLATION_PROMPT).toContain('title');
    expect(CHECKPOINT_DISTILLATION_PROMPT).toContain('done_summary');
    expect(CHECKPOINT_DISTILLATION_PROMPT).toContain('next_step');
    expect(CHECKPOINT_DISTILLATION_PROMPT).toContain('{}');
  });

  it('bounds formatted checkpoints length to MAX_CHECKPOINT_PROMPT_CHARS budget', () => {
    const hugeCheckpoints: AgentCheckpointItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      title: `Task_${i}`,
      status: 'in_progress',
      done_summary: 'x'.repeat(200),
      next_step: 'y'.repeat(150),
    }));

    const formatted = formatTaskCheckpoints(hugeCheckpoints);
    expect(formatted.length).toBeLessThan(MAX_CHECKPOINT_PROMPT_CHARS + 300);
    expect(formatted).toContain('- [任务] Task_0');
    expect(formatted).not.toContain('- [任务] Task_9');
  });
});
