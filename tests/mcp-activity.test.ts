import { describe, expect, it } from 'vitest';
import { activityDuration, projectMcpActivity } from '../frontend/src/mcp-activity';
import type { McpActivity } from '../src/mcp-schema';

const afternoon = new Date(2026, 10, 25, 16, 0).getTime();
const knownServers = new Map([[1, 'RAKLA'], [2, 'Other']]);
const defaults = { knownServers, serverId: null, anomaliesOnly: false, raw: false };

function operation(id: string, start: number, ms: number, extra: Partial<McpActivity> = {}): McpActivity {
  return {
    id, serverId: 1, tool: 'ssh_exec', client: 'MCP', status: 'success',
    startedAt: afternoon + start, finishedAt: afternoon + start + ms, ...extra,
  };
}

const getRows = (projection: ReturnType<typeof projectMcpActivity>) =>
  projection.days.flatMap((day) => day.rows);

describe('MCP activity presentation', () => {
  it('condenses the eight adjacent successes from the example, using real operation durations', () => {
    const source = [
      [3053, 3054], [3040, 3040], [3039, 3039], [3008, 3010],
      [2974, 2991], [2946, 2956], [2914, 2914], [2912, 2912],
    ].map(([start, end], i) => operation(`exec-${i}`, start * 1000, (end - start) * 1000));
    const combined = projectMcpActivity(source, defaults);
    expect(combined).toMatchObject({ anomalyCount: 0, commonServerId: 1 });
    expect(getRows(combined)).toMatchObject([{
      count: 8, slowestMs: 17_000, newest: { id: 'exec-0' }, oldest: { id: 'exec-7' },
    }]);
    expect(getRows(projectMcpActivity(source, { ...defaults, raw: true })).map((row) => row.newest.id))
      .toEqual(source.map((item) => item.id));
    expect(source).toHaveLength(8);
  });

  it('uses the actual time from previous finish to next start, inclusive at 60s, and never merges overlap', () => {
    const source = [
      operation('first', 0, 12_000),
      operation('exact', 72_000, 1000),
      operation('over-gap', 133_001, 2000),
      operation('overlap', 133_050, 1000),
    ];
    const rows = getRows(projectMcpActivity(source, defaults));
    expect(rows.map((row) => [row.newest.id, row.count, row.slowestMs])).toEqual([
      ['overlap', 1, 1000], ['over-gap', 1, 2000], ['exact', 2, 12_000],
    ]);
  });

  it('never crosses another operation in the chronology, even when its server is filtered out', () => {
    const source = [
      operation('older', 0, 500), operation('interleaved', 1000, 500, { serverId: 2 }),
      operation('later', 2000, 500), operation('read', 3000, 500, { tool: 'sftp_read' }),
      operation('newest', 4000, 500), operation('read-new', 5000, 500, { tool: 'sftp_read' }),
    ];
    const all = projectMcpActivity(source, defaults);
    expect(all.commonServerId).toBeNull();
    expect(getRows(all)).toHaveLength(6);
    const scoped = projectMcpActivity(source, { ...defaults, serverId: 1 });
    expect(scoped.commonServerId).toBe(1);
    expect(getRows(scoped).map((row) => [row.newest.id, row.count])).toEqual([
      ['read-new', 1], ['newest', 1], ['read', 1], ['later', 1], ['older', 1],
    ]);
  });

  it('always shows writes individually and filters only unknown, not-executed and nonzero results', () => {
    const source = [
      operation('success-write-a', 0, 300, { tool: 'sftp_write' }),
      operation('success-write-b', 1000, 300, { tool: 'sftp_write' }),
      operation('unknown', 2000, 400, { status: 'unknown', failureReason: 'exec_timeout' }),
      operation('error', 3000, 400, { status: 'error' }),
      operation('nonzero', 4000, 400, { status: 'failed' }),
      operation('running', 5000, 0, { status: 'running', finishedAt: null }),
      operation('other-error', 6000, 300, { serverId: 2, status: 'error' }),
    ];
    expect(getRows(projectMcpActivity(source, defaults))).toHaveLength(7);
    const scoped = projectMcpActivity(source, { ...defaults, anomaliesOnly: true, serverId: 1 });
    expect(scoped.anomalyCount).toBe(3);
    expect(getRows(scoped).map((row) => row.newest.id)).toEqual(['nonzero', 'error', 'unknown']);
    expect(getRows(scoped).at(-1)?.newest.failureReason).toBe('exec_timeout');
  });

  it('does not merge across a local date boundary, even if all calls are within seconds', () => {
    const midnight = new Date(2026, 10, 26).getTime() - afternoon;
    const source = [
      operation('before', midnight - 3000, 500), operation('across', midnight - 1000, 1300),
      operation('after', midnight + 1000, 200),
    ];
    const days = projectMcpActivity(source, defaults).days;
    expect(days.map((day) => new Date(day.startedAt).getDate())).toEqual([26, 25]);
    expect(days.map((day) => day.rows.map((row) => row.count))).toEqual([[1], [1, 1]]);
  });

  it('does not show removed servers, invent durations, or exceed the snapshot limit', () => {
    const pending = operation('pending', 1000, 0, { finishedAt: null });
    const reversed = operation('reversed', 1000, -10);
    expect(activityDuration(pending)).toBeNull();
    expect(activityDuration(reversed)).toBeNull();
    const raw = Array.from({ length: 110 }, (_, i) => operation(String(i), i * 1000, 100));
    raw[2] = operation('deleted', 2000, 50, { serverId: 99 });
    const rows = getRows(projectMcpActivity(raw, { ...defaults, raw: true }));
    expect(rows).toHaveLength(99);
    expect(rows.some((row) => row.newest.id === 'deleted')).toBe(false);
  });
});
