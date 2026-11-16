import './mcp-manager.css';
import { getLocale, t, type TranslationKey } from './i18n';
import { copyTextToClipboard } from './clipboard';
import type {
  McpActivity,
  McpConfigInfo,
  McpGrant,
  McpSavedCredentials,
  McpScope,
} from '../../src/mcp-schema';
import { MCP_SCOPES } from '../../src/mcp-schema';
import type { AppConfig } from './app-bootstrap';
import { createAssistantIcon } from './assistant-icons';
import { buildMcpClientConfig, normalizeMcpAccessCredentials } from './mcp-client-config';
import { equalMcpGrants } from './mcp-config-draft';
import './assistant-ui.css';

interface ContextTarget {
  session: string;
  serverId: number;
  label: string;
}
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  key?: TranslationKey
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (key) {
    node.textContent = t(key);
    node.dataset.i18n = key;
  }
  return node;
}
function button(key: TranslationKey, action: () => void): HTMLButtonElement {
  const node = element('button', key);
  node.type = 'button';
  node.className = 'assistant-action';
  node.addEventListener('click', action);
  return node;
}
function disclosure(key: TranslationKey): HTMLDetailsElement {
  const node = element('details');
  node.append(element('summary', key));
  return node;
}

/** One account configuration. Plaintext is fetched only for an explicit copy/view action. */
export class McpManager {
  private identity: string | null = null;
  private authMode: AppConfig['authMode'];
  private dialog: HTMLDialogElement | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private status: HTMLElement | null = null;
  constructor(private getContext: () => ContextTarget | null) {}
  setIdentity(identity: string | null, authMode?: AppConfig['authMode']): void {
    if (this.identity !== identity || this.authMode !== authMode) this.close();
    this.identity = identity;
    this.authMode = authMode;
    document
      .querySelectorAll<HTMLElement>('[data-mcp-open]')
      .forEach((node) => node.classList.toggle('hidden', !identity));
  }
  init(): void {
    document.querySelectorAll('[data-mcp-open]').forEach((node) =>
      node.addEventListener('click', () => {
        document.getElementById('mobile-more-menu')?.classList.add('hidden');
        document.getElementById('mobile-more-btn')?.setAttribute('aria-expanded', 'false');
        void this.open();
      })
    );
  }
  close(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dialog) {
      this.dialog
        .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
        .forEach((node) => {
          node.value = '';
        });
      this.dialog.close();
      this.dialog.remove();
      this.dialog = null;
    }
    this.status = null;
  }
  private async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const controller = this.controller;
    if (!controller) throw new Error('closed');
    const response = await fetch(url, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error('request_failed');
    const result = (await response.json()) as T;
    controller.signal.throwIfAborted();
    return result;
  }
  private message(key: TranslationKey): void {
    if (this.status) this.status.textContent = t(key);
  }
  async open(): Promise<void> {
    if (!this.identity) return;
    this.close();
    const generation = this.generation;
    this.controller = new AbortController();
    const dialog = element('dialog');
    dialog.id = 'mcp-dialog';
    dialog.className = 'mcp-dialog';
    dialog.setAttribute('aria-labelledby', 'mcp-title');
    const header = element('header');
    header.className = 'assistant-panel-header';
    const title = element('h2', 'mcp.title');
    title.id = 'mcp-title';
    title.className = 'assistant-panel-title';
    const icon = createAssistantIcon('mcp');
    icon.classList.add('assistant-panel-icon');
    const close = button('common.close', () => this.close());
    close.className = 'assistant-icon-action';
    close.removeAttribute('data-i18n');
    close.setAttribute('aria-label', t('common.close'));
    close.title = t('common.close');
    close.dataset.i18nAriaLabel = close.dataset.i18nTitle = 'common.close';
    const closeIcon = element('span');
    closeIcon.className = 'material-symbols-outlined';
    closeIcon.setAttribute('aria-hidden', 'true');
    closeIcon.textContent = 'close';
    close.replaceChildren(closeIcon);
    header.append(icon, title, close);
    const body = element('div');
    body.className = 'mcp-body';
    this.status = element('p');
    this.status.setAttribute('role', 'status');
    this.status.textContent = t('mcp.loading');
    body.append(this.status);
    const panel = element('div');
    panel.className = 'mcp-dialog__panel assistant-shell assistant-panel-surface';
    panel.append(header, body);
    dialog.append(panel);
    this.dialog = dialog;
    document.body.append(dialog);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    dialog.showModal();
    try {
      const [servers, info] = await Promise.all([
        this.api<{ id: number; name: string }[]>('/api/servers'),
        this.api<McpConfigInfo>('/api/mcp/config'),
      ]);
      if (generation !== this.generation) return;
      this.status!.textContent = '';
      this.buildConfiguration(body, servers, info);
      this.buildContext(body);
      this.buildActivity(body, servers);
    } catch {
      if (generation === this.generation) {
        this.message('mcp.error');
        body.append(button('mcp.retry', () => void this.open()));
      }
    }
  }
  private buildConfiguration(
    parent: HTMLElement,
    servers: { id: number; name: string }[],
    initial: McpConfigInfo
  ): void {
    let info = initial;
    const generation = this.generation;
    const form = element('form');
    form.id = 'mcp-config-form';
    form.append(element('h3', 'mcp.permissionsTitle'));
    const controls: HTMLInputElement[] = [];
    for (const server of servers) {
      const row = element('fieldset');
      row.className = 'mcp-server-grant';
      const legend = element('legend');
      legend.textContent = server.name;
      row.append(legend);
      for (const scope of MCP_SCOPES) {
        const label = element('label');
        const input = element('input');
        input.type = 'checkbox';
        input.value = scope;
        input.dataset.serverId = String(server.id);
        input.setAttribute('aria-label', `${server.name} · ${t(`mcp.permission.${scope}`)}`);
        input.checked = info.grants.some(
          (grant) => grant.serverId === server.id && grant.scopes.includes(scope)
        );
        label.append(input, element('span', `mcp.permission.${scope}`));
        row.append(label);
        controls.push(input);
      }
      form.append(row);
    }
    if (!servers.length) form.append(element('p', 'mcp.noServers'));
    const access =
      this.authMode === 'cf_access'
        ? this.buildAccessGuide(form, !info.hasAccessCredentials)
        : null;
    const configArea = element('div');
    configArea.id = 'mcp-config-preview';
    const footer = element('footer');
    footer.className = 'mcp-actions assistant-panel-footer';
    const copy = button('mcp.copyConfig', () => void exportConfig(false));
    copy.id = 'mcp-copy-config';
    copy.className = 'assistant-action';
    const view = button('mcp.viewConfig', () => void exportConfig(true));
    view.id = 'mcp-view-config';
    view.className = 'assistant-action';
    const save = element('button', info.configured ? 'mcp.savePermissions' : 'mcp.generate');
    save.type = 'submit';
    save.id = 'mcp-save-config';
    save.className = 'assistant-action assistant-accent-control';
    save.setAttribute('form', form.id);
    const readGrants = (): McpGrant[] =>
      servers.flatMap((server) => {
        const scopes = controls
          .filter((input) => input.dataset.serverId === String(server.id) && input.checked)
          .map((input) => input.value as McpScope);
        return scopes.length ? [{ serverId: server.id, scopes }] : [];
      });
    let busy = false;
    const dirty = () =>
      !info.configured ||
      !equalMcpGrants(readGrants(), info.grants) ||
      !!(
        access &&
        (!info.hasAccessCredentials ||
          access.clientId.value.trim() ||
          access.clientSecret.value.trim())
      );
    const syncButtons = () => {
      const exportDisabled = busy || !info.configured;
      if (copy.disabled !== exportDisabled) copy.disabled = exportDisabled;
      if (view.disabled !== exportDisabled) view.disabled = exportDisabled;
      const saveDisabled = busy || !dirty();
      if (save.disabled !== saveDisabled) save.disabled = saveDisabled;
      save.setAttribute('aria-busy', String(busy));
      save.title = t(
        info.configured && !dirty()
          ? 'mcp.noChanges'
          : info.configured
            ? 'mcp.savePermissions'
            : 'mcp.generate'
      );
      save.dataset.i18n = info.configured ? 'mcp.savePermissions' : 'mcp.generate';
      const label = t(save.dataset.i18n as TranslationKey);
      if (save.textContent !== label) save.textContent = label;
    };
    form.addEventListener('input', syncButtons);
    form.addEventListener('change', syncButtons);
    syncButtons();
    footer.append(view, copy, save);
    const exportConfig = async (preview: boolean) => {
      if (busy) return;
      busy = true;
      syncButtons();
      try {
        const textPromise = this.api<McpSavedCredentials>('/api/mcp/config/credentials', {
          method: 'POST',
        }).then((credentials) => {
          if (generation !== this.generation) throw new Error('closed');
          return JSON.stringify(
            buildMcpClientConfig(location.origin, credentials.token, credentials.access),
            null,
            2
          );
        });
        void textPromise.catch(() => {});
        if (preview) {
          const text = await textPromise;
          const label = element('label');
          label.append(element('span', 'mcp.clientConfig'));
          const output = element('textarea');
          output.readOnly = true;
          output.className = 'terminal-input assistant-field';
          output.id = 'mcp-client-config';
          output.rows = 9;
          output.value = text;
          label.append(output);
          configArea.replaceChildren(label);
        } else {
          // Start the clipboard write during the click, before awaiting the network (Safari).
          if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
            await navigator.clipboard.write([
              new ClipboardItem({
                'text/plain': textPromise.then((text) => new Blob([text], { type: 'text/plain' })),
              }),
            ]);
          } else if (!(await copyTextToClipboard(await textPromise)))
            throw new Error('copy_failed');
          if (generation === this.generation) this.message('mcp.copied');
        }
      } catch {
        if (generation === this.generation) this.message('mcp.error');
      } finally {
        if (generation === this.generation) {
          busy = false;
          syncButtons();
        }
      }
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const grants = readGrants();
      let credentials: ReturnType<typeof normalizeMcpAccessCredentials> | undefined;
      if (
        access &&
        (!info.hasAccessCredentials || access.clientId.value || access.clientSecret.value)
      ) {
        try {
          if (!access.confirmed.checked) throw new Error('policy_not_confirmed');
          credentials = normalizeMcpAccessCredentials({
            clientId: access.clientId.value,
            clientSecret: access.clientSecret.value,
          });
        } catch {
          this.message('mcp.access.invalidCredentials');
          return;
        }
      }
      busy = true;
      syncButtons();
      controls.forEach((input) => {
        input.disabled = true;
      });
      if (access) access.fieldset.disabled = true;
      void (async () => {
        try {
          const result = await this.api<McpConfigInfo>('/api/mcp/config', {
            method: info.configured ? 'PUT' : 'POST',
            body: JSON.stringify({ grants, ...(credentials ? { access: credentials } : {}) }),
          });
          credentials = undefined;
          if (generation !== this.generation) return;
          info = result;
          controls.forEach((input) => {
            input.checked = info.grants.some(
              (grant) =>
                grant.serverId === Number(input.dataset.serverId) &&
                grant.scopes.includes(input.value as McpScope)
            );
          });
          configArea.replaceChildren();
          if (access) {
            access.clientId.value = access.clientSecret.value = '';
            access.confirmed.checked = false;
            access.clientId.required =
              access.clientSecret.required =
              access.confirmed.required =
                false;
            access.details.open = false;
          }
          this.message('mcp.saved');
        } catch {
          if (generation === this.generation) this.message('mcp.error');
        } finally {
          credentials = undefined;
          if (generation === this.generation) {
            controls.forEach((input) => {
              input.disabled = false;
            });
            if (access) access.fieldset.disabled = false;
            busy = false;
            syncButtons();
          }
        }
      })();
    });
    parent.append(form, configArea);
    parent.parentElement?.append(footer);
  }
  private buildAccessGuide(form: HTMLFormElement, required: boolean) {
    const details = disclosure('mcp.access.connection');
    details.id = 'mcp-access-guide';
    details.open = required;
    details.append(element('p', 'mcp.access.shortGuide'));
    const links = element('div');
    links.className = 'mcp-access-links';
    for (const [key, href] of [
      ['mcp.access.dashboard', 'https://one.dash.cloudflare.com/'],
      [
        'mcp.access.docs',
        'https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/',
      ],
    ] as const) {
      const link = element('a', key);
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      links.append(link);
    }
    details.append(links);
    const fieldset = element('fieldset');
    fieldset.className = 'mcp-access-fields';
    const legend = element('legend', 'mcp.access.credentials');
    fieldset.append(legend);
    const clientId = element('input');
    clientId.className = 'terminal-input assistant-field';
    clientId.id = 'mcp-access-client-id';
    clientId.type = 'text';
    clientId.maxLength = 512;
    const clientSecret = element('input');
    clientSecret.className = 'terminal-input assistant-field';
    clientSecret.id = 'mcp-access-client-secret';
    clientSecret.type = 'password';
    clientSecret.maxLength = 4096;
    for (const [key, input] of [
      ['mcp.access.clientId', clientId],
      ['mcp.access.clientSecret', clientSecret],
    ] as const) {
      input.required = required;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'none');
      const label = element('label');
      label.append(element('span', key), input);
      fieldset.append(label);
    }
    const confirmed = element('input');
    confirmed.type = 'checkbox';
    confirmed.id = 'mcp-access-policy-confirmed';
    confirmed.required = required;
    const label = element('label');
    label.append(confirmed, element('span', 'mcp.access.policyShort'));
    fieldset.append(label);
    details.append(fieldset, element('p', 'mcp.encryptedHint'));
    form.append(details);
    return { details, fieldset, clientId, clientSecret, confirmed };
  }
  private buildContext(parent: HTMLElement): void {
    const section = disclosure('mcp.context');
    section.id = 'mcp-context-section';
    const target = this.getContext();
    if (!target) section.append(element('p', 'mcp.noContext'));
    else {
      const generation = this.generation;
      let expires = 0;
      let loaded = false;
      const code = element('textarea');
      code.className = 'terminal-input assistant-field';
      code.readOnly = true;
      code.rows = 3;
      code.hidden = true;
      code.setAttribute('aria-label', t('mcp.contextId'));
      const toggle = button('mcp.share', () => {
        toggle.disabled = true;
        void this.api<{ expiresAt: number }>('/api/mcp/context', {
          method: 'POST',
          body: JSON.stringify({ ...target, enabled: expires <= Date.now() }),
        })
          .then((result) => {
            if (generation === this.generation) {
              expires = result.expiresAt;
              render();
            }
          })
          .catch(() => {
            if (generation === this.generation) this.message('mcp.error');
          })
          .finally(() => {
            if (generation === this.generation) toggle.disabled = false;
          });
      });
      toggle.disabled = true;
      const render = () => {
        const enabled = expires > Date.now();
        toggle.dataset.i18n = enabled ? 'mcp.unshare' : 'mcp.share';
        toggle.textContent = t(enabled ? 'mcp.unshare' : 'mcp.share');
        code.value = enabled
          ? JSON.stringify({ server_id: target.serverId, context_id: target.session })
          : '';
        code.hidden = !enabled;
      };
      section.addEventListener('toggle', () => {
        if (!section.open || loaded) return;
        loaded = true;
        void this.api<{ expiresAt: number }>('/api/mcp/context', {
          method: 'POST',
          body: JSON.stringify({ ...target, inspect: true }),
        })
          .then((result) => {
            if (generation === this.generation) {
              expires = result.expiresAt;
              render();
              toggle.disabled = false;
            }
          })
          .catch(() => {
            if (generation === this.generation) this.message('mcp.error');
          });
      });
      section.append(element('p', 'mcp.contextBrief'), toggle, code);
    }
    parent.append(section);
  }
  private buildActivity(parent: HTMLElement, servers: { id: number; name: string }[]): void {
    const section = disclosure('mcp.activity');
    section.id = 'mcp-activity-section';
    const list = element('div');
    list.id = 'mcp-activity-list';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', t('mcp.activity'));
    list.dataset.i18nAriaLabel = 'mcp.activity';
    list.tabIndex = 0;
    section.append(list);
    parent.append(section);
    const generation = this.generation;
    let refreshId = 0;
    const refresh = async (id: number) => {
      if (id !== refreshId || generation !== this.generation || !section.open) return;
      if (!document.hidden) {
        try {
          const items = await this.api<McpActivity[]>('/api/mcp/activity');
          if (id !== refreshId || generation !== this.generation || !section.open) return;
          list.replaceChildren();
          if (!items.length) list.append(element('p', 'mcp.noActivity'));
          const dateTime = new Intl.DateTimeFormat(getLocale(), {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });
          const time = new Intl.DateTimeFormat(getLocale(), {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });
          for (const item of items.slice(0, 100)) {
            const record = element('div');
            record.className = 'mcp-operation';
            record.setAttribute('role', 'listitem');
            const start = new Date(item.startedAt);
            const end = item.finishedAt === null ? null : new Date(item.finishedAt);
            const period =
              dateTime.format(start) +
              (end
                ? ` — ${end.toDateString() === start.toDateString() ? time.format(end) : dateTime.format(end)}`
                : '');
            record.textContent = `${period}  ${servers.find((s) => s.id === item.serverId)?.name ?? item.serverId} · ${t(`mcp.status.${item.status}`)}  ${item.tool}`;
            list.append(record);
          }
        } catch {
          if (generation === this.generation) this.message('mcp.error');
        }
      }
      if (id === refreshId && generation === this.generation && section.open)
        this.timer = setTimeout(() => void refresh(id), 5000);
    };
    section.addEventListener('toggle', () => {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      refreshId++;
      if (section.open) void refresh(refreshId);
    });
  }
}
