import { describe, expect, it } from 'vitest';
import {
  DISTILLATION_PROMPT,
  formatServerMemories,
  MAX_MEMORY_PROMPT_CHARS,
} from '../../../src/worker/agent/prompt';
import type { AgentMemoryItem } from '../../../src/worker/agent/types';

describe('agent server memories prompt', () => {
  it('returns empty string when no memories provided', () => {
    expect(formatServerMemories([])).toBe('');
    expect(formatServerMemories(null as unknown as AgentMemoryItem[])).toBe('');
  });

  it('formats server memories into structured markdown with categories and disclaimer', () => {
    const memories: AgentMemoryItem[] = [
      {
        category: 'path',
        fact_key: 'nginx_conf',
        fact_value: '/etc/nginx/nginx.conf',
        source: 'manual',
      },
      {
        category: 'service',
        fact_key: 'web_server',
        fact_value: 'OpenResty 1.21',
        source: 'auto',
      },
      {
        category: 'rule',
        fact_key: 'restart_rule',
        fact_value: '重启前必须执行 nginx -t 测试语法',
        source: 'manual',
      },
      {
        category: 'env',
        fact_key: 'container_runtime',
        fact_value: 'podman',
        source: 'auto',
      },
      {
        category: 'custom',
        fact_key: 'note',
        fact_value: '备份目录挂载在 /mnt/backup',
        source: 'manual',
      },
    ];

    const formatted = formatServerMemories(memories);
    expect(formatted).toContain('## 服务器已知资产与记忆 (Server Dossier)');
    expect(formatted).toContain('- [路径] nginx_conf: /etc/nginx/nginx.conf');
    expect(formatted).toContain('- [服务] web_server: OpenResty 1.21');
    expect(formatted).toContain('- [运维规则] restart_rule: 重启前必须执行 nginx -t 测试语法');
    expect(formatted).toContain('- [环境] container_runtime: podman');
    expect(formatted).toContain('- [常识] note: 备份目录挂载在 /mnt/backup');
    expect(formatted).toContain('注意：上述记忆为历史运维沉淀事实');
  });

  it('provides a distillation prompt with strict JSON requirements and anti-leak rules', () => {
    expect(DISTILLATION_PROMPT).toContain('Linux 运维知识提炼助手');
    expect(DISTILLATION_PROMPT).toContain('严禁提取：任何用户密码、密钥、Token');
    expect(DISTILLATION_PROMPT).toContain('JSON 数组');
    expect(DISTILLATION_PROMPT).toContain('fact_key');
    expect(DISTILLATION_PROMPT).toContain('fact_value');
    expect(DISTILLATION_PROMPT).toContain('[]');
  });

  it('bounds formatted memories length to MAX_MEMORY_PROMPT_CHARS budget', () => {
    const hugeMemories: AgentMemoryItem[] = Array.from({ length: 20 }, (_, i) => ({
      category: 'custom',
      fact_key: `key_${i}`,
      fact_value: 'x'.repeat(200),
      source: 'manual',
    }));

    const formatted = formatServerMemories(hugeMemories);
    expect(formatted.length).toBeLessThan(MAX_MEMORY_PROMPT_CHARS + 300);
    // Should include first few items but truncate later ones
    expect(formatted).toContain('- [常识] key_0:');
    expect(formatted).not.toContain('- [常识] key_19:');
  });
});
