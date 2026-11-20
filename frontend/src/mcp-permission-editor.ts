import { MCP_SCOPES, type McpGrant, type McpScope } from '../../src/mcp-schema';
import { getLocale, localizedElement as element, onLocaleChange, t } from './i18n';
import { McpGrantDraft } from './mcp-config-draft';

export interface McpServerOption {
  id: number;
  name: string;
  tags?: readonly string[];
}

/** Desktop uses a real table; narrow screens mount native disclosures instead. There is only one
 * set of editable controls at a time, and neither layout is the source of grants sent on save. */
export function createMcpPermissionEditor(
  initialServers: readonly McpServerOption[],
  initial: { configured: boolean; grants: McpGrant[] },
  signal: AbortSignal
) {
  let servers = [...initialServers];
  const draft = new McpGrantDraft(servers.map(({ id }) => id), initial.grants);
  const section = element('details');
  section.id = 'mcp-permissions';
  section.open = !initial.configured;
  const summary = element('summary');
  const count = element('span');
  count.className = 'mcp-grant-count';
  summary.append(element('strong', 'mcp.permissionsTitle'), count);
  const fields = element('fieldset');
  fields.className = 'mcp-grant-fields';
  const legend = element('legend', 'mcp.permissionsTitle');
  legend.className = 'sr-only';
  fields.append(legend);
  section.append(summary, fields);

  const toolbar = element('div');
  toolbar.className = 'mcp-grant-toolbar';
  const search = element('input');
  search.type = 'search';
  search.className = 'terminal-input assistant-field';
  search.autocomplete = 'off';
  search.dataset.i18nPlaceholder = search.dataset.i18nAriaLabel = 'mcp.grants.search';
  search.placeholder = t('mcp.grants.search');
  search.setAttribute('aria-label', search.placeholder);
  // Searching inside the configuration form must never implicitly submit permissions.
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) event.preventDefault();
  });
  const filter = element('select');
  filter.className = 'terminal-input assistant-field';
  filter.dataset.i18nAriaLabel = 'mcp.grants.filter';
  filter.setAttribute('aria-label', t('mcp.grants.filter'));
  for (const value of ['all', 'authorized', 'unauthorized'] as const) {
    const option = element('option', `mcp.grants.${value}`);
    option.value = value;
    filter.append(option);
  }
  toolbar.append(search, filter);
  const hint = element('p', 'mcp.grants.filterHint');
  const empty = element('p', servers.length ? 'mcp.grants.noMatch' : 'mcp.noServers');
  const list = element('div');
  list.className = 'mcp-grant-list';
  if (servers.length) fields.append(toolbar, hint);
  fields.append(list, empty);

  const narrow = matchMedia('(max-width: 767px), (max-width: 1180px) and (pointer: coarse)');
  const rows = new Map<number, {
    node: HTMLElement;
    server: McpServerOption;
    inputs: Map<McpScope, HTMLInputElement>;
    description?: HTMLElement;
  }>();
  function updateCount() {
    count.textContent = t(draft.changedCount ? 'mcp.grants.previewCount' : 'mcp.grants.count', {
      count: draft.authorizedCount, total: servers.length,
    });
  }
  function syncRow(id: number) {
    const row = rows.get(id)!;
    const scopes = draft.scopes(id);
    for (const [scope, input] of row.inputs) {
      input.checked = scopes.includes(scope);
      input.setAttribute('aria-label', `${row.server.name} · ${t(`mcp.permission.${scope}`)}`);
    }
    if (row.description) {
      row.description.textContent = scopes.length
        ? scopes.map((scope) => t(`mcp.permission.${scope}`)).join(getLocale() === 'en-US' ? ', ' : '、')
        : t('mcp.grants.unauthorized');
    }
  }
  function applyFilter() {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const [id, { node, server }] of rows) {
      // Filter by the saved baseline, so checking the first box in “Not authorized” doesn't
      // make the row disappear before the owner has chosen the remaining permissions.
      const matchesAccess =
        filter.value === 'all' || (filter.value === 'authorized') === draft.wasAuthorized(id);
      const matchesText = !query || [server.name, ...(server.tags ?? [])].some((term) =>
        term.toLocaleLowerCase().includes(query)
      );
      node.hidden = !(matchesAccess && matchesText);
      if (!node.hidden) visible++;
    }
    list.hidden = visible === 0;
    empty.hidden = visible !== 0;
    hint.hidden = filter.value === 'all';
    list.scrollTop = 0;
  }
  let renderedMobile: boolean | undefined;
  function renderLayout() {
    const mobile = narrow.matches;
    if (!section.open || renderedMobile === mobile) return;
    renderedMobile = mobile;
    rows.clear();
    const layout = mobile ? element('div') : element('table');
    let body: HTMLElement = layout;
    if (layout instanceof HTMLTableElement) {
      layout.setAttribute('aria-label', t('mcp.permissionsTitle'));
      layout.dataset.i18nAriaLabel = 'mcp.permissionsTitle';
      const header = layout.createTHead().insertRow();
      for (const key of ['server.name', ...MCP_SCOPES.map((s) => `mcp.permission.${s}` as const)] as const) {
        const th = element('th', key);
        th.scope = 'col';
        header.append(th);
      }
      body = layout.createTBody();
    }
    for (const server of servers) {
      const node = mobile ? element('details') : element('tr');
      node.dataset.grantId = String(server.id);
      let description: HTMLElement | undefined;
      let group: HTMLElement = node;
      if (mobile) {
        const heading = element('summary');
        const name = element('strong');
        name.textContent = server.name;
        description = element('span');
        description.className = 'mcp-grant-description';
        heading.append(name, description);
        group = element('div');
        group.className = 'mcp-grant-choices';
        node.append(heading, group);
      } else {
        const th = element('th');
        th.scope = 'row';
        th.textContent = server.name;
        node.append(th);
      }
      const inputs = new Map<McpScope, HTMLInputElement>();
      for (const scope of MCP_SCOPES) {
        const input = element('input');
        input.type = 'checkbox';
        input.dataset.serverId = String(server.id);
        input.value = scope;
        inputs.set(scope, input);
        input.addEventListener('change', () => {
          if (rows.get(server.id)?.node !== node) return;
          draft.setScope(server.id, scope, input.checked);
          syncRow(server.id);
          updateCount();
        });
        const label = element('label');
        label.append(input);
        if (mobile) label.append(element('span', `mcp.permission.${scope}`));
        const cell = mobile ? group : element('td');
        cell.append(label);
        if (!mobile) node.append(cell);
      }
      rows.set(server.id, { node, server, inputs, description });
      syncRow(server.id);
      body.append(node);
    }
    list.replaceChildren(layout);
    applyFilter();
  }
  search.addEventListener('input', applyFilter);
  filter.addEventListener('change', applyFilter);
  section.addEventListener('toggle', renderLayout);
  narrow.addEventListener('change', renderLayout, { signal });
  signal.addEventListener('abort', onLocaleChange(() => {
    for (const id of rows.keys()) syncRow(id);
    updateCount();
  }), { once: true });
  renderLayout();
  updateCount();
  return {
    section, fields, draft,
    removeServer(id: number) {
      servers = servers.filter((server) => server.id !== id);
      draft.removeServer(id);
      rows.get(id)?.node.remove();
      rows.delete(id);
      if (!servers.length) {
        toolbar.remove();
        hint.remove();
        empty.dataset.i18n = 'mcp.noServers';
        empty.textContent = t('mcp.noServers');
      }
      updateCount();
      applyFilter();
    },
    reset(grants: McpGrant[]) {
      draft.reset(grants);
      for (const id of rows.keys()) syncRow(id);
      updateCount();
      applyFilter();
    },
  };
}
