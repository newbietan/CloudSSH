import { isRdpId, parseRdpProfile, type RdpProfile, type RdpProfileInput } from '../../src/rdp-schema';
import { localizedElement, t, type TranslationKey } from './i18n';

const API = '/api/rdp/profiles';
function button(label: TranslationKey, action: () => void): HTMLButtonElement {
  const result = localizedElement('button', label);
  result.className = 'cyber-button px-3 py-2 text-sm';
  result.type = 'button';
  result.onclick = action;
  return result;
}

export class RdpManager {
  private readonly root = document.createElement('section');
  private readonly grid = document.createElement('div');
  private readonly status = document.createElement('p');
  private readonly requests = new AbortController();
  private dialog: HTMLDialogElement | undefined;
  private generation = 0;

  constructor(parent: HTMLElement) {
    const heading = localizedElement('h2', 'rdp.title');
    heading.className = 'text-base font-semibold';
    const header = document.createElement('div');
    header.className = 'flex flex-wrap items-center justify-between gap-3 mb-3';
    header.append(heading, button('rdp.add', () => this.edit()));
    this.status.setAttribute('role', 'status');
    this.status.className = 'text-muted text-sm';
    this.grid.className = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4';
    this.root.className = 'pt-6 mt-6 border-t border-outline-variant';
    this.root.append(header, this.status, this.grid);
    parent.append(this.root);
    void this.refresh();
  }
  dispose(): void {
    this.requests.abort();
    this.dialog?.close();
    this.root.remove();
  }
  private request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(API + path, {
      method, cache: 'no-store', signal: this.requests.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  }
  private error(target: HTMLElement, key: TranslationKey): void {
    target.dataset.i18n = key;
    target.textContent = t(key);
  }
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    try {
      const response = await this.request('');
      if (!response.ok) throw new Error('load failed');
      const data = await response.json() as { profiles: RdpProfile[] };
      if (generation !== this.generation || this.requests.signal.aborted) return;
      this.grid.replaceChildren(...data.profiles.filter(row => isRdpId(row.id)).map(row => this.createCard(row)));
      delete this.status.dataset.i18n;
      this.status.textContent = '';
      if (!this.grid.childElementCount) this.error(this.status, 'rdp.empty');
    } catch {
      if (!this.requests.signal.aborted && generation === this.generation) this.error(this.status, 'rdp.failed');
    }
  }
  private createCard(row: RdpProfile): HTMLElement {
    const card = document.createElement('div');
    card.className = 'rounded-xl border border-outline-variant bg-elevated p-4 min-w-0';
    const title = document.createElement('h3');
    title.className = 'font-semibold break-words';
    title.textContent = row.name;
    const route = localizedElement('p', row.route === 'direct' ? 'rdp.direct' : 'rdp.tunnel');
    const host = document.createElement('p');
    host.className = 'text-muted break-all font-mono text-sm';
    host.textContent = row.host;
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap gap-2 mt-3';
    const open = localizedElement('a', 'rdp.open');
    open.className = 'cyber-button px-3 py-2 text-sm';
    open.href = `/rdp/${row.id}`;
    open.target = '_blank';
    open.rel = 'noopener';
    actions.append(open, button('rdp.edit', () => this.edit(row)), button('rdp.remove', () => this.remove(row)));
    card.append(title, route, host, actions);
    return card;
  }
  private modal(title: TranslationKey): HTMLDialogElement {
    this.dialog?.close();
    const dialog = document.createElement('dialog');
    dialog.className = 'rdp-device-dialog';
    const heading = localizedElement('h2', title);
    heading.className = 'font-semibold mb-3';
    heading.id = 'rdp-device-title';
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.append(heading);
    dialog.addEventListener('close', () => {
      if (this.dialog === dialog) this.dialog = undefined;
      dialog.remove();
    }, { once: true });
    this.root.append(dialog);
    this.dialog = dialog;
    return dialog;
  }
  private edit(row?: RdpProfile): void {
    const dialog = this.modal(row ? 'rdp.edit' : 'rdp.add');
    const form = document.createElement('form');
    form.className = 'grid gap-3';
    form.autocomplete = 'off';
    function input(label: TranslationKey, max: number, value = '', type = 'text') {
      const group = document.createElement('label');
      const field = document.createElement('input');
      field.className = 'terminal-input w-full';
      field.type = type;
      field.maxLength = max;
      field.autocomplete = 'off';
      field.value = value;
      group.append(localizedElement('span', label), field);
      return { group, field };
    }
    const name = input('rdp.name', 64, row?.name);
    const host = input('rdp.host', 253, row?.host);
    const fingerprint = input('rdp.fingerprint', 96, row?.fingerprint);
    for (const field of [name.field, host.field, fingerprint.field]) field.required = true;
    const transport = document.createElement('select');
    transport.className = 'terminal-input w-full';
    for (const [key, value] of [['rdp.direct', 'direct'], ['rdp.tunnel', 'tunnel']] as const) {
      const option = localizedElement('option', key);
      option.value = value;
      transport.append(option);
    }
    transport.value = row?.route ?? 'direct';
    const routeLabel = document.createElement('label');
    routeLabel.append(localizedElement('span', 'rdp.route'), transport);
    const access = document.createElement('fieldset');
    access.className = 'grid gap-2';
    access.append(localizedElement('legend', 'rdp.access'));
    const id = input('rdp.accessId', 256);
    const secret = input('rdp.accessSecret', 512, '', 'password');
    const clear = document.createElement('input');
    clear.type = 'checkbox';
    const clearLabel = document.createElement('label');
    clearLabel.className = 'flex gap-2 items-center';
    clearLabel.append(clear, localizedElement('span', 'rdp.clearAccess'));
    clearLabel.hidden = !row?.hasAccessToken;
    access.append(id.group, secret.group, clearLabel);
    const update = () => {
      access.hidden = transport.value !== 'tunnel';
      access.disabled = access.hidden;
      id.field.disabled = secret.field.disabled = clear.checked;
    };
    transport.onchange = clear.onchange = update;
    update();
    const actions = document.createElement('div');
    actions.className = 'flex gap-2 justify-end';
    const save = button('rdp.save', () => {});
    save.type = 'submit';
    actions.append(button('rdp.cancel', () => dialog.close()), save);
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    form.append(name.group, routeLabel, host.group, fingerprint.group, localizedElement('p', 'rdp.pinHelp'), access, status, actions);
    dialog.append(form);
    dialog.addEventListener('close', () => { secret.field.value = ''; });
    form.onsubmit = (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const input: Record<string, unknown> = {
        name: name.field.value, route: transport.value, host: host.field.value, fingerprint: fingerprint.field.value,
      };
      if (transport.value === 'tunnel' && (clear.checked || id.field.value || secret.field.value)) {
        input.accessId = clear.checked ? '' : id.field.value;
        input.accessSecret = clear.checked ? '' : secret.field.value;
      }
      const data: RdpProfileInput | null = parseRdpProfile(input);
      if (!data) { this.error(status, 'rdp.invalid'); return; }
      save.disabled = true;
      secret.field.value = '';
      void (async () => {
        const response = await this.request(row ? `/${row.id}` : '', row ? 'PUT' : 'POST', row ? { ...data, revision: row.revision } : data);
        if (!response.ok) throw new Error('write failed');
        dialog.close();
        await this.refresh();
      })().catch(() => { if (dialog.open) this.error(status, 'rdp.failed'); }).finally(() => { save.disabled = false; });
    };
    dialog.showModal();
  }
  private remove(row: RdpProfile): void {
    const dialog = this.modal('rdp.remove');
    const hint = localizedElement('p', 'rdp.removeConfirm');
    hint.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'flex gap-2 mt-4 justify-end';
    const remove = button('rdp.remove', () => {
      remove.disabled = true;
      void (async () => {
        const response = await this.request(`/${row.id}`, 'DELETE');
        if (!response.ok) throw new Error('remove failed');
        dialog.close();
        await this.refresh();
      })().catch(() => { if (dialog.open) this.error(hint, 'rdp.failed'); }).finally(() => { remove.disabled = false; });
    });
    actions.append(button('rdp.cancel', () => dialog.close()), remove);
    dialog.append(hint, actions);
    dialog.showModal();
  }
}
