import { RDP_CLIENT_REVISION, isRdpId, parseRdpProfile, type RdpCard, type RdpProfile } from '../../src/rdp-schema';
import { localizedElement, t, type TranslationKey } from './i18n';

import { normalizeServerTags } from '../../src/server-tags';

const API = '/api/rdp/profiles';

/** Windows fields mounted into the shared server modal, not a second dialog. */
export class RdpManager {
  private readonly requests = new AbortController();
  private readonly name: HTMLInputElement;
  private readonly tags: HTMLInputElement;
  private readonly host: HTMLInputElement;
  private readonly transport = document.createElement('select');
  private readonly access = document.createElement('fieldset');
  private readonly id: HTMLInputElement;
  private readonly secret: HTMLInputElement;
  private readonly clear = document.createElement('input');
  private readonly clearLabel = document.createElement('label');
  private generation = 0;
  private identity?: { username: string; domain: string };
  private loadingIdentity = false;
  private readonly loginFields = document.createElement('fieldset');
  private readonly username: HTMLInputElement;
  private readonly domain: HTMLInputElement;
  private readonly password: HTMLInputElement;
  private editing?: RdpProfile;

  private readonly editNotice = localizedElement('p', 'rdp.editEndsSession');

  constructor(parent: HTMLFieldSetElement, private readonly onChange: () => void) {
    const identity = document.createElement('div');
    identity.className = 'server-identity-fields';
    const [name, nameLabel] = this.field('rdp-name', 64, 'rdp.name');
    this.name = name;
    const routeLabel = this.label('rdp.route', this.transport);
    this.transport.id = 'server-rdp-route';
    this.transport.className = 'terminal-input w-full';
    for (const [key, value] of [['rdp.direct', 'direct'], ['rdp.tunnel', 'tunnel']] as const) {
      const option = localizedElement('option', key);
      option.value = value;
      this.transport.append(option);
    }
    const [tags, tagsLabel] = this.field('rdp-tags', 300, 'server.tags');
    this.tags = tags;
    tags.dataset.i18nPlaceholder = 'server.tagsPlaceholder';
    tags.placeholder = t('server.tagsPlaceholder');
    identity.append(nameLabel, tagsLabel);

    const columns = document.createElement('div');
    columns.className = 'server-settings-columns';
    const target = document.createElement('div');
    target.className = 'server-settings-section';
    const authentication = document.createElement('div');
    authentication.className = 'server-settings-section';
    const [host, hostLabel] = this.field('rdp-host', 253, 'rdp.host');
    this.host = host;
    name.required = host.required = true;
    host.spellcheck = false;
    target.append(routeLabel, hostLabel);
    const [username, userLabel] = this.field('rdp-user', 128, 'auth.user');
    const [domain, domainLabel] = this.field('rdp-domain', 128, 'rdp.domain');
    const [password, passLabel] = this.field('rdp-password', 1024, 'common.password', 'password');
    this.username = username; this.domain = domain; this.password = password;
    username.required = true;
    this.loginFields.className = 'grid gap-3 min-w-0';
    this.loginFields.append(userLabel, passLabel, domainLabel);
    this.host.oninput = username.oninput = domain.oninput = () => this.updatePasswordRequirement();
    authentication.append(this.loginFields);
    columns.append(target, authentication);

    this.access.className = 'rdp-tunnel-fields mt-4 pt-4 border-t border-outline-variant';
    const legend = localizedElement('legend', 'rdp.access');
    legend.className = 'text-xs font-semibold text-muted';
    const [id, idLabel] = this.field('rdp-access-id', 256, 'rdp.accessId');
    this.id = id;
    const [secret, secretLabel] = this.field('rdp-access-secret', 512, 'rdp.accessSecret', 'password');
    this.secret = secret;
    this.clear.type = 'checkbox';
    this.clearLabel.className = 'flex gap-2 items-center text-xs text-muted';
    this.clearLabel.append(this.clear, localizedElement('span', 'rdp.clearAccess'));
    const credentials = document.createElement('div');
    credentials.className = 'server-service-token-fields';
    credentials.append(idLabel, secretLabel);
    this.access.append(legend, credentials, this.clearLabel);
    this.transport.onchange = this.clear.onchange = () => this.updateTransport();
    this.editNotice.className = 'text-xs text-muted mt-2';
    parent.replaceChildren(identity, columns, this.access, this.editNotice);
    for (const event of ['input', 'change']) parent.addEventListener(event, () => this.syncEdit(), { signal: this.requests.signal });
    this.reset();
  }

  private label(key: TranslationKey, control: HTMLInputElement | HTMLSelectElement): HTMLLabelElement {
    const group = document.createElement('label');
    const label = localizedElement('span', key);
    label.className = 'block text-xs font-bold tracking-[0.1em] text-muted mb-2';
    group.append(label, control);
    return group;
  }

  private field(id: string, max: number, label: TranslationKey, type = 'text') {
    const field = document.createElement('input');
    field.id = `server-${id}`;
    field.className = 'terminal-input text-[13px] w-full';
    field.type = type;
    field.maxLength = max;
    field.autocomplete = 'off';
    return [field, this.label(label, field)] as const;
  }

  dispose(): void {
    this.requests.abort();
    this.reset();
  }

  reset(row?: RdpProfile): void {
    this.editing = row;
    this.name.value = row?.name ?? '';
    this.host.value = row?.host ?? '';
    this.tags.value = (row?.tags ?? []).join(', ');
    this.transport.value = row?.route ?? 'direct';
    this.id.value = this.secret.value = this.domain.value = this.password.value = '';
    this.username.value = row?.hasLogin ? '' : 'Administrator';
    this.identity = undefined;
    const generation = ++this.generation;
    this.loginFields.disabled = this.loadingIdentity = row?.hasLogin === true;
    if (row?.hasLogin) void this.loadIdentity(row, generation);
    this.clear.checked = false;
    this.clearLabel.hidden = !row?.hasAccessToken;
    this.updateTransport();
    this.syncEdit();
  }

  private async loadIdentity(row: RdpProfile, generation: number): Promise<void> {
    try {
      const res = await this.request(`/${row.id}/login-identity`, 'POST', { revision: row.revision },
        AbortSignal.any([this.requests.signal, AbortSignal.timeout(10000)]));
      if (!res.ok) throw new Error();
      const data = await res.json() as { username: string; domain: string; revision: number };
      if (data.revision !== row.revision || typeof data.username !== 'string' || typeof data.domain !== 'string') throw new Error();
      if (this.generation !== generation) return;
      this.identity = { username: data.username, domain: data.domain };
      this.username.value = data.username;
      this.domain.value = data.domain;
    } catch {
      // Identity could not be verified: require a complete replacement, never reuse the password.
      if (this.generation === generation) this.username.value = 'Administrator';
    } finally {
      if (this.generation === generation) {
        this.loginFields.disabled = this.loadingIdentity = false;
        this.updatePasswordRequirement();
        this.syncEdit();
      }
    }
  }

  get canSubmit(): boolean {
    if (this.loadingIdentity) return false;
    const row = this.editing;
    if (!row) return true;
    return this.name.value.trim() !== row.name || this.host.value.trim().toLowerCase() !== row.host ||
      this.transport.value !== row.route || JSON.stringify(normalizeServerTags(this.tags.value)) !== JSON.stringify(row.tags ?? []) ||
      this.username.value.trim() !== (this.identity?.username ?? 'Administrator') ||
      this.domain.value.trim() !== (this.identity?.domain ?? '') || this.password.value !== '' ||
      (this.transport.value === 'tunnel' && (this.clear.checked || !!this.id.value || !!this.secret.value));
  }

  private syncEdit(): void {
    this.editNotice.hidden = !this.editing || !this.canSubmit;
    this.onChange();
  }

  private canKeepPassword(): boolean {
    return !!this.identity && this.editing?.host === this.host.value.trim().toLowerCase() &&
      this.editing.route === this.transport.value && this.identity.username === this.username.value.trim() &&
      this.identity.domain === this.domain.value.trim();
  }

  private updatePasswordRequirement(): void {
    this.password.required = !this.canKeepPassword();
    this.password.placeholder = this.password.required ? '' : t('rdp.keepLogin');
  }

  focus(): void { this.name.focus({ preventScroll: true }); }

  private updateTransport(): void {
    this.updatePasswordRequirement();
    this.access.hidden = this.transport.value !== 'tunnel';
    this.access.disabled = this.access.hidden;
    this.host.placeholder = this.access.hidden ? '203.0.113.10' : 'rdp.example.com';
    this.id.disabled = this.secret.disabled = this.clear.checked;
  }

  private request(path: string, method = 'GET', body?: unknown, signal = this.requests.signal): Promise<Response> {
    return fetch(API + path, {
      method, cache: 'no-store', signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-CloudSSH-RDP-Client': String(RDP_CLIENT_REVISION) }, body: JSON.stringify(body) }),
    });
  }

  async list(signal: AbortSignal): Promise<RdpCard[]> {
    const response = await this.request('', 'GET', undefined, signal);
    if (!response.ok) throw response;
    const data = await response.json() as { profiles: RdpCard[] };
    return data.profiles.filter(row => isRdpId(row.id));
  }

  async save(): Promise<void> {
    const editing = this.editing;
    const input: Record<string, unknown> = {
      name: this.name.value, route: this.transport.value, host: this.host.value, tags: normalizeServerTags(this.tags.value),
    };
    if (this.transport.value === 'tunnel' && (this.clear.checked || this.id.value || this.secret.value)) {
      input.accessId = this.clear.checked ? '' : this.id.value;
      input.accessSecret = this.clear.checked ? '' : this.secret.value;
    }
    if (this.loadingIdentity) throw new Error(t('rdp.loadingIdentity'));
    if (!this.canKeepPassword() || this.password.value) {
      input.login = { username: this.username.value.trim(), domain: this.domain.value.trim(), password: this.password.value };
    }
    const data = parseRdpProfile(input);
    if (!data) throw new Error(t('rdp.invalid'));
    const pending = this.request(editing ? `/${editing.id}` : '', editing ? 'PUT' : 'POST', editing ? { ...data, revision: editing.revision } : data);
    this.secret.value = this.password.value = '';
    this.syncEdit();
    const response = await pending.catch(() => null);
    if (response?.status === 401) throw new Error(t('rdp.signInAgain'));
    const result = await response?.json().catch(() => null);
    if (!response?.ok) {
      if (result?.code === 'profile_changed') throw new Error(t('rdp.profileChanged'));
      if (result?.code === 'profile_limit') throw new Error(t('rdp.profileLimit'));
      if (result?.code === 'invalid_profile' || result?.code === 'login_required') throw new Error(t('rdp.invalid'));
      throw new Error(t('rdp.failed'));
    }
    if (!isRdpId(result?.id)) throw new Error(t('rdp.failed'));
  }

  async remove(id: string): Promise<void> {
    const response = await this.request(`/${id}`, 'DELETE');
    if (!response.ok) throw new Error(t('rdp.failed'));
    const data = await response.json() as { success?: boolean };
    if (data.success !== true) throw new Error(t('rdp.failed'));
  }
}
