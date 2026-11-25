import { isMcpFailureReason, type McpActivity } from '../../src/mcp-schema';
import { getLocale, localizedElement as element, t, type TranslationKey } from './i18n';
import { activityDayKey, projectMcpActivity, type McpActivityRow } from './mcp-activity';

const toolLabels: Record<string, TranslationKey> = {
  ssh_exec: 'mcp.activitySshExec',
  sftp_read: 'mcp.activitySftpRead',
  sftp_list: 'mcp.activitySftpList',
  sftp_write: 'mcp.activitySftpWrite',
};

function statusLabel(item: McpActivity, raw: boolean): string {
  switch (item.status) {
    case 'success': return raw ? t('mcp.status.success') : '';
    case 'running': return t('mcp.status.running');
    case 'error': return t('mcp.status.error');
    case 'failed': return t('mcp.status.failed');
    default: return t('mcp.status.unknown');
  }
}

function timeFormat(fractional: boolean): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(getLocale(), {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    ...(fractional ? { fractionalSecondDigits: 3 } : {}),
  });
}

function durationFormat(unit: 'millisecond' | 'second'): Intl.NumberFormat {
  return new Intl.NumberFormat(getLocale(), {
    style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: unit === 'second' ? 1 : 0,
  });
}

/** Purely local presentation of a bounded account snapshot. Controls never issue requests. */
export function createMcpActivityView(servers: { id: number; name: string }[]) {
  const names = new Map(servers.map((server) => [server.id, server.name]));
  let items: McpActivity[] | null = null;
  let loadFailed = false;
  let raw = false;
  let anomaliesOnly = false;
  const section = element('details');
  section.id = 'mcp-activity-section';
  const summary = element('summary', 'mcp.activity');
  const toolbar = element('div');
  toolbar.className = 'mcp-activity-toolbar';
  const scope = element('label');
  scope.className = 'mcp-activity-scope';
  scope.append(element('span', 'mcp.activityServer'));
  const select = element('select');
  select.id = 'mcp-activity-server';
  select.className = 'terminal-input assistant-field';
  const all = element('option', 'mcp.activityAllServers');
  all.value = '';
  select.append(all);
  for (const [id, name] of names) {
    const option = element('option');
    option.value = String(id);
    option.textContent = name;
    select.append(option);
  }
  scope.append(select);
  scope.hidden = names.size <= 1;
  const anomalies = element('button');
  anomalies.type = 'button';
  anomalies.id = 'mcp-activity-anomalies';
  anomalies.className = 'assistant-action';
  const rawToggle = element('button', 'mcp.activityRaw');
  rawToggle.type = 'button';
  rawToggle.id = 'mcp-activity-raw';
  rawToggle.className = 'assistant-action';
  for (const control of [anomalies, rawToggle]) control.setAttribute('aria-controls', 'mcp-activity-list');
  toolbar.append(scope, anomalies, rawToggle);
  const list = element('div');
  list.id = 'mcp-activity-list';
  list.setAttribute('role', 'region');
  list.setAttribute('aria-label', t('mcp.activity'));
  list.dataset.i18nAriaLabel = 'mcp.activity';
  list.tabIndex = 0;
  section.append(summary, toolbar, list);

  function render(resetScroll = false) {
    if (!section.open) return;
    const serverId = select.value ? Number(select.value) : null;
    const projection = projectMcpActivity(items ?? [], { knownServers: names, serverId, anomaliesOnly, raw });
    const countFormat = new Intl.NumberFormat(getLocale());
    anomalies.textContent = items === null
      ? t('mcp.activityAnomaliesLabel')
      : t('mcp.activityAnomalies', { count: countFormat.format(projection.anomalyCount) });
    anomalies.setAttribute('aria-pressed', String(anomaliesOnly));
    rawToggle.setAttribute('aria-pressed', String(raw));
    const fragment = document.createDocumentFragment();
    if (loadFailed && items !== null) fragment.append(element('p', 'mcp.activityRefreshFailed'));
    if (!projection.days.length) {
      const key = items === null
        ? loadFailed ? 'mcp.activityLoadFailed' : 'mcp.activityLoading'
        : anomaliesOnly ? 'mcp.activityNoAnomalies' : 'mcp.noActivity';
      fragment.append(element('p', key));
    } else {
      const date = new Intl.DateTimeFormat(getLocale(), {
        year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const time = timeFormat(raw);
      const seconds = durationFormat('second');
      const milliseconds = durationFormat('millisecond');
      const formatDuration = (ms: number) => ms < 1000 ? milliseconds.format(ms) : seconds.format(ms / 1000);
      const withRange = (row: McpActivityRow) => {
        const start = time.format(row.oldest.startedAt);
        const end = row.newest.finishedAt;
        if ((!raw && row.count === 1) || row.slowestMs === null || end === null) return start;
        return `${start} – ${activityDayKey(end) === activityDayKey(row.oldest.startedAt) ? '' : `${date.format(end)} `}${time.format(end)}`;
      };
      for (const day of projection.days) {
        const heading = element('h3');
        heading.className = 'mcp-activity-day';
        const name = projection.commonServerId === null ? undefined : names.get(projection.commonServerId);
        heading.textContent = [date.format(day.startedAt), name].filter(Boolean).join(' · ');
        const rows = element('ul');
        rows.setAttribute('role', 'list');
        rows.className = 'mcp-activity-rows';
        for (const row of day.rows) {
          const item = row.newest;
          const record = element('li');
          record.className = 'mcp-operation';
          record.dataset.serverId = String(item.serverId);
          record.dataset.status = item.status;
          const knownTool = Object.hasOwn(toolLabels, item.tool);
          const tool = knownTool && raw ? item.tool : t(knownTool ? toolLabels[item.tool] : 'mcp.activityOtherTool');
          const count = row.count > 1 ? t('mcp.activityCount', { count: countFormat.format(row.count) }) : '';
          const status = statusLabel(item, raw);
          const reason = (item.status === 'error' || item.status === 'unknown') && isMcpFailureReason(item.failureReason)
            ? t(`mcp.failure.${item.failureReason}`) : '';
          const elapsed = row.slowestMs === null ? '' : row.count > 1
            ? t('mcp.activitySlowest', { duration: formatDuration(row.slowestMs) })
            : formatDuration(row.slowestMs);
          record.textContent = [
            withRange(row), projection.commonServerId === null ? names.get(item.serverId) : '',
            [tool, count].filter(Boolean).join(' '), status, reason, elapsed,
          ].filter(Boolean).join(' · ');
          rows.append(record);
        }
        fragment.append(heading, rows);
      }
    }
    const left = list.scrollLeft;
    const top = list.scrollTop;
    list.replaceChildren(fragment);
    list.scrollLeft = resetScroll ? 0 : left;
    list.scrollTop = resetScroll ? 0 : top;
  }

  select.addEventListener('change', () => render(true));
  anomalies.addEventListener('click', () => { anomaliesOnly = !anomaliesOnly; render(true); });
  rawToggle.addEventListener('click', () => { raw = !raw; render(true); });
  return {
    section,
    render,
    setItems(data: McpActivity[]) {
      items = data.slice(0, 100);
      loadFailed = false;
      render();
    },
    setError() { loadFailed = true; render(); },
    removeServer(id: number) {
      if (!names.delete(id)) return;
      const removingSelected = select.value === String(id);
      Array.from(select.options).find((option) => option.value === String(id))?.remove();
      if (removingSelected || names.size <= 1) select.value = '';
      scope.hidden = names.size <= 1;
      // Keep the separator in the snapshot. The projection drops deleted rows before rendering.
      render(removingSelected);
    },
  };
}
