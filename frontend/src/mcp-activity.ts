import type { McpActivity } from '../../src/mcp-schema';

const MERGE_GAP_MS = 60_000;
const MAX_RECENT_ACTIVITIES = 100;

export type McpActivityRow = {
  newest: McpActivity;
  oldest: McpActivity;
  count: number;
  slowestMs: number | null;
};

type ActivityDay = { startedAt: number; rows: McpActivityRow[] };

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
}

export function activityDuration(item: McpActivity): number | null {
  return validTime(item.finishedAt) && item.finishedAt >= item.startedAt
    ? item.finishedAt - item.startedAt
    : null;
}

export function activityDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function isAnomaly(item: McpActivity): boolean {
  return item.status === 'error' || item.status === 'unknown' || item.status === 'failed';
}

function mergeableEnd(item: McpActivity): number | null {
  if (item.status !== 'success' ||
    (item.tool !== 'ssh_exec' && item.tool !== 'sftp_read' && item.tool !== 'sftp_list')) return null;
  const end = item.finishedAt;
  return validTime(end) && end >= item.startedAt &&
    activityDayKey(item.startedAt) === activityDayKey(end) ? end : null;
}

function follows(newer: McpActivity, older: McpActivity): boolean {
  if (newer.serverId !== older.serverId || newer.tool !== older.tool) return false;
  const earlierEnd = mergeableEnd(older);
  if (earlierEnd === null || mergeableEnd(newer) === null) return false;
  const gap = newer.startedAt - earlierEnd;
  return gap >= 0 && gap <= MERGE_GAP_MS &&
    activityDayKey(newer.startedAt) === activityDayKey(older.startedAt);
}

/** A presentation-only projection. Filtering cannot join rows separated in the original stream. */
export function projectMcpActivity(
  items: readonly McpActivity[],
  options: {
    knownServers: ReadonlyMap<number, string>;
    serverId: number | null;
    anomaliesOnly: boolean;
    raw: boolean;
  }
): { anomalyCount: number; commonServerId: number | null; days: ActivityDay[] } {
  const ordered = items.slice(0, MAX_RECENT_ACTIVITIES)
    .filter((item) => validTime(item.startedAt))
    .sort((a, b) => b.startedAt - a.startedAt);
  const days: ActivityDay[] = [];
  let anomalyCount = 0;
  let commonServerId: number | null | undefined;
  let dayKey: string | undefined;
  let visibleDay: ActivityDay | undefined;
  let previousRow: McpActivityRow | undefined;
  for (const item of ordered) {
    const currentDay = activityDayKey(item.startedAt);
    if (currentDay !== dayKey) {
      dayKey = currentDay;
      visibleDay = undefined;
      previousRow = undefined;
    }
    if (!options.knownServers.has(item.serverId) ||
      (options.serverId !== null && item.serverId !== options.serverId)) {
      previousRow = undefined;
      continue;
    }
    if (isAnomaly(item)) anomalyCount++;
    else if (options.anomaliesOnly) {
      previousRow = undefined;
      continue;
    }
    if (commonServerId === undefined) commonServerId = item.serverId;
    else if (commonServerId !== item.serverId) commonServerId = null;
    if (!visibleDay) {
      visibleDay = { startedAt: item.startedAt, rows: [] };
      days.push(visibleDay);
    }
    const duration = activityDuration(item);
    if (!options.raw && previousRow && follows(previousRow.oldest, item)) {
      previousRow.count++;
      previousRow.oldest = item;
      previousRow.slowestMs = Math.max(previousRow.slowestMs ?? 0, duration ?? 0);
      continue;
    }
    previousRow = { newest: item, oldest: item, count: 1, slowestMs: duration };
    visibleDay.rows.push(previousRow);
  }
  return { anomalyCount, commonServerId: commonServerId ?? null, days };
}
