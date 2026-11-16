import './mcp-manager.css';
import { t, type TranslationKey } from './i18n';
import { copyTextToClipboard } from './clipboard';
import type { McpActivity, McpScope, McpTokenInfo } from '../../src/mcp-schema';

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
  node.addEventListener('click', action);
  return node;
}
function checkbox(label: string, value: string, checked = false) {
  const wrapper = element('label');
  const input = element('input');
  input.type = 'checkbox';
  input.value = value;
  input.checked = checked;
  const text = element('span');
  text.textContent = label;
  wrapper.append(input, text);
  return { wrapper, input };
}

/** No credential persistence. Closing/logout aborts reads, removes plaintext and stops activity polling. */
export class McpManager {
  private identity: string | null = null;
  private dialog: HTMLDialogElement | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private status: HTMLElement | null = null;
  constructor(private getContext: () => ContextTarget | null) {}
  setIdentity(identity: string | null): void {
    if (this.identity !== identity) this.close();
    this.identity = identity;
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
      this.dialog.querySelectorAll('textarea, input').forEach((node) => {
        (node as HTMLInputElement).value = '';
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
  private error(): void {
    if (this.status) this.status.textContent = t('mcp.error');
  }
  async open(): Promise<void> {
    if (!this.identity) return;
    this.close();
    const generation = this.generation;
    this.controller = new AbortController();
    const dialog = element('dialog');
    dialog.className = 'mcp-dialog';
    dialog.id = 'mcp-dialog';
    dialog.setAttribute('aria-labelledby', 'mcp-title');
    const header = element('header');
    const title = element('h2', 'mcp.title');
    title.id = 'mcp-title';
    header.append(
      title,
      button('common.close', () => this.close())
    );
    dialog.append(header);
    const body = element('div');
    body.className = 'mcp-body';
    dialog.append(body);
    const intro = element('p', 'mcp.intro');
    body.append(intro);
    this.status = element('p');
    this.status.setAttribute('role', 'status');
    this.status.textContent = t('mcp.loading');
    body.append(this.status);
    this.dialog = dialog;
    document.body.append(dialog);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    dialog.showModal();
    try {
      const [servers, tokens] = await Promise.all([
        this.api<{ id: number; name: string }[]>('/api/servers'),
        this.api<McpTokenInfo[]>('/api/mcp/tokens'),
      ]);
      if (generation !== this.generation) return;
      this.status!.textContent = '';
      this.buildForm(body, servers);
      const tokenSection = element('section');
      tokenSection.append(element('h3', 'mcp.tokens'));
      const tokenList = element('div');
      tokenList.id = 'mcp-token-list';
      tokenSection.append(tokenList);
      body.append(tokenSection);
      this.renderTokens(tokenList, tokens);
      this.buildContext(body);
      const activity = element('section');
      activity.append(element('h3', 'mcp.activity'), element('p', 'mcp.activityHelp'));
      const list = element('div');
      list.id = 'mcp-activity-list';
      activity.append(list);
      body.append(activity);
      const refresh = async () => {
        if (generation !== this.generation) return;
        if (!document.hidden) {
          try {
            const items = await this.api<McpActivity[]>('/api/mcp/activity');
            if (generation === this.generation) this.renderActivity(list, items, servers);
          } catch {
            if (generation === this.generation) this.error();
          }
        }
        if (generation === this.generation) this.timer = setTimeout(() => void refresh(), 5000);
      };
      void refresh();
    } catch {
      if (generation === this.generation) this.error();
    }
  }
  private buildForm(parent: HTMLElement, servers: { id: number; name: string }[]): void {
    const section = element('section');
    section.append(element('h3', 'mcp.newToken'));
    const form = element('form');
    form.id = 'mcp-token-form';
    const nameLabel = element('label');
    nameLabel.append(element('span', 'mcp.name'));
    const name = element('input');
    name.name = 'name';
    name.required = true;
    name.maxLength = 50;
    name.autocomplete = 'off';
    nameLabel.append(name);
    const daysLabel = element('label');
    daysLabel.append(element('span', 'mcp.days'));
    const days = element('input');
    days.name = 'days';
    days.type = 'number';
    days.min = '1';
    days.max = '365';
    days.value = '30';
    days.required = true;
    daysLabel.append(days);
    const fields = element('div');
    fields.className = 'mcp-fields';
    fields.append(nameLabel, daysLabel);
    form.append(fields);
    const serverSet = element('fieldset');
    serverSet.append(element('legend', 'mcp.servers'));
    const serverInputs = servers.map((server) => {
      const item = checkbox(server.name, String(server.id));
      serverSet.append(item.wrapper);
      return item.input;
    });
    if (!servers.length) serverSet.append(element('p', 'mcp.noServers'));
    const scopes = element('fieldset');
    scopes.append(element('legend', 'mcp.permissions'));
    const scopeInputs = (['read', 'write', 'exec', 'context'] as const).map((scope) => {
      const item = checkbox(t(`mcp.scope.${scope}`), scope, scope === 'read');
      item.wrapper.querySelector('span')!.dataset.i18n = `mcp.scope.${scope}`;
      scopes.append(item.wrapper);
      return item.input;
    });
    form.append(serverSet, scopes, element('p', 'mcp.execWarning'));
    const submit = element('button', 'mcp.create');
    submit.type = 'submit';
    submit.disabled = !servers.length;
    form.append(submit);
    const secretArea = element('div');
    secretArea.id = 'mcp-created-token';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const serverIds = serverInputs
        .filter((input) => input.checked)
        .map((input) => Number(input.value));
      const selectedScopes = scopeInputs
        .filter((input) => input.checked)
        .map((input) => input.value as McpScope);
      if (!serverIds.length || !selectedScopes.length) {
        this.error();
        return;
      }
      submit.disabled = true;
      const generation = this.generation;
      void (async () => {
        try {
          const result = await this.api<McpTokenInfo & { token: string }>('/api/mcp/tokens', {
            method: 'POST',
            body: JSON.stringify({
              name: name.value,
              serverIds,
              scopes: selectedScopes,
              days: Number(days.value),
            }),
          });
          if (generation !== this.generation) return;
          secretArea.replaceChildren(element('p', 'mcp.secretWarning'));
          const configLabel = element('label');
          configLabel.append(element('span', 'mcp.clientConfig'));
          const output = element('textarea');
          output.readOnly = true;
          output.rows = 11;
          output.id = 'mcp-client-config';
          output.value = JSON.stringify(
            {
              mcpServers: {
                cloudssh: {
                  type: 'http',
                  url: `${location.origin}/mcp`,
                  headers: { Authorization: `Bearer ${result.token}` },
                },
              },
            },
            null,
            2
          );
          configLabel.append(output);
          secretArea.append(
            configLabel,
            button('mcp.copy', () => {
              void copyTextToClipboard(output.value)
                .then(() => {
                  if (this.status) this.status.textContent = t('mcp.copied');
                })
                .catch(() => this.error());
            })
          );
          const list = this.dialog?.querySelector<HTMLElement>('#mcp-token-list');
          const tokens = await this.api<McpTokenInfo[]>('/api/mcp/tokens');
          if (list && generation === this.generation) this.renderTokens(list, tokens);
        } catch {
          if (generation === this.generation) this.error();
        } finally {
          if (generation === this.generation) submit.disabled = false;
        }
      })();
    });
    section.append(form, secretArea);
    parent.append(section);
  }
  private renderTokens(parent: HTMLElement, tokens: McpTokenInfo[]): void {
    parent.replaceChildren();
    if (!tokens.length) parent.append(element('p', 'mcp.noTokens'));
    for (const token of tokens) {
      const row = element('div');
      row.className = 'mcp-row';
      const text = element('span');
      text.textContent = `${token.name} · ${token.scopes.map((scope) => t(`mcp.scope.${scope}`)).join(', ')} · ${new Date(token.expiresAt).toLocaleDateString()}`;
      const revoke = button('mcp.revoke', () => {
        if (revoke.dataset.confirm !== 'true') {
          revoke.dataset.confirm = 'true';
          revoke.dataset.i18n = 'mcp.confirmRevoke';
          revoke.textContent = t('mcp.confirmRevoke');
          return;
        }
        revoke.disabled = true;
        const generation = this.generation;
        void this.api(`/api/mcp/tokens/${token.id}`, { method: 'DELETE' })
          .then(() => {
            if (generation !== this.generation) return;
            row.remove();
            this.dialog?.querySelector('#mcp-created-token')?.replaceChildren();
          })
          .catch(() => {
            if (generation === this.generation) {
              this.error();
              revoke.disabled = false;
            }
          });
      });
      row.append(text, revoke);
      parent.append(row);
    }
  }
  private buildContext(parent: HTMLElement): void {
    const section = element('section');
    section.append(element('h3', 'mcp.context'), element('p', 'mcp.contextHelp'));
    const target = this.getContext();
    if (!target) section.append(element('p', 'mcp.noContext'));
    else {
      const label = element('p');
      label.textContent = target.label;
      section.append(label);
      const code = element('textarea');
      code.readOnly = true;
      code.rows = 3;
      code.setAttribute('aria-label', t('mcp.contextId'));
      const generation = this.generation;
      let expires = 0;
      const toggle = button(expires > Date.now() ? 'mcp.unshare' : 'mcp.share', () => {
        toggle.disabled = true;
        const enabled = expires <= Date.now();
        void this.api<{ expiresAt: number }>('/api/mcp/context', {
          method: 'POST',
          body: JSON.stringify({ ...target, enabled }),
        })
          .then((result) => {
            if (generation !== this.generation) return;
            expires = result.expiresAt;
            render();
          })
          .catch(() => {
            if (generation === this.generation) this.error();
          })
          .finally(() => {
            if (generation === this.generation) toggle.disabled = false;
          });
      });
      const render = () => {
        const enabled = expires > Date.now();
        toggle.dataset.i18n = enabled ? 'mcp.unshare' : 'mcp.share';
        toggle.textContent = t(enabled ? 'mcp.unshare' : 'mcp.share');
        code.value = enabled
          ? JSON.stringify({ server_id: target.serverId, context_id: target.session })
          : '';
        code.hidden = !enabled;
      };
      render();
      toggle.disabled = true;
      section.append(toggle, code);
      void this.api<{ expiresAt: number }>('/api/mcp/context', {
        method: 'POST',
        body: JSON.stringify({ ...target, inspect: true }),
      })
        .then((result) => {
          if (generation !== this.generation) return;
          expires = result.expiresAt;
          render();
          toggle.disabled = false;
        })
        .catch(() => {
          if (generation === this.generation) this.error();
        });
    }
    parent.append(section);
  }
  private renderActivity(
    parent: HTMLElement,
    activity: McpActivity[],
    servers: { id: number; name: string }[]
  ): void {
    parent.replaceChildren();
    if (!activity.length) parent.append(element('p', 'mcp.noActivity'));
    for (const item of activity.slice(0, 30)) {
      const row = element('div');
      row.className = 'mcp-row';
      row.textContent = `${new Date(item.startedAt).toLocaleTimeString()} · ${item.client} · ${servers.find((server) => server.id === item.serverId)?.name ?? item.serverId} · ${item.tool} · ${t(`mcp.status.${item.status}`)}`;
      parent.append(row);
    }
  }
}
