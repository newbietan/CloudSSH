import {
  RDP_CLIENT_REVISION,
  RDP_CONNECTOR_MAX_DOWNLOAD,
  rdpConnectorSetupFilename,
  type RdpConnector,
  type RdpProfile,
} from '../../src/rdp-schema';
import { localizedElement, t, type TranslationKey } from './i18n';
import { createModalHeader } from './modal-ui';
import { confirmAction } from './ui-feedback';

const stateKeys = {
  unbound: null,
  waiting: 'rdp.connectorWaiting',
  online: 'rdp.connectorOnline',
  offline: 'rdp.connectorOffline',
  other_origin: 'rdp.connectorOtherOrigin',
} as const;

function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Only an explicit download authorizes the current device. No grant in URLs, storage, or clipboard. */
export class RdpConnectorSetup {
  private closeView?: () => void;
  constructor(
    private readonly openDesktop: (id: string) => void,
    private readonly refreshCards: () => void,
    private readonly preview = false
  ) {}
  dispose() {
    this.closeView?.();
  }

  open(profile: RdpProfile, showOpen = true): void {
    this.dispose();
    const dialog = document.createElement('dialog');
    dialog.className = 'app-modal rdp-connector-dialog';
    dialog.setAttribute('aria-labelledby', 'rdp-connector-title');
    const life = new AbortController();
    const dismiss = () => {
      life.abort();
      dialog.close();
      dialog.remove();
      if (this.closeView === dismiss) this.closeView = undefined;
    };
    this.closeView = dismiss;
    dialog.oncancel = (e) => {
      e.preventDefault();
      dismiss();
    };
    const { header } = createModalHeader('rdp-connector-title', 'rdp.connectorSetup', dismiss);
    const panel = document.createElement('div');
    panel.className = 'app-modal__panel app-modal__inset';
    const name = document.createElement('p');
    name.className = 'rdp-connector-device';
    name.textContent = profile.name;
    const steps = localizedElement('p', 'rdp.connectorIntro');
    const previewNote = localizedElement('p', 'rdp.connectorPreviewNotice');
    previewNote.className = 'rdp-connector-preview';
    const help = document.createElement('details');
    help.className = 'rdp-connector-help';
    help.append(
      localizedElement('summary', 'rdp.connectorInstallDetails'),
      localizedElement('p', 'rdp.connectorPackageHint')
    );
    if (this.preview) help.append(localizedElement('p', 'rdp.connectorPreviewHelp'));
    const hint = document.createElement('p');
    hint.setAttribute('role', 'status');
    const result = document.createElement('p');
    result.setAttribute('role', 'alert');
    const site = document.createElement('code');
    const actions = document.createElement('div');
    actions.className = 'app-modal__actions rdp-connector-actions';
    const button = (key: TranslationKey) => {
      const b = localizedElement('button', key);
      b.type = 'button';
      b.className = 'app-modal__button';
      return b;
    };
    const download = button('rdp.connectorDownload'),
      unlink = button('rdp.connectorUnlink'),
      open = button('rdp.open');
    for (const primary of [download, open]) primary.classList.add('app-modal__button--primary');
    actions.append(unlink, download, open);
    panel.append(header, name, steps, hint, site, previewNote, help, result, actions);
    dialog.append(panel);
    open.onclick = () => {
      dismiss();
      this.openDesktop(profile.id);
    };

    const api = `/api/rdp/profiles/${profile.id}/connector`;
    let state: RdpConnector = profile.connector ?? { state: 'unbound' };
    let busy = false,
      downloading = false,
      failures = 0,
      statusRequest = false;
    let until = Date.now() + 16 * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = (path: string, method = 'GET', data?: object, timeout = 10_000) =>
      fetch(path, {
        method,
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.any([life.signal, AbortSignal.timeout(timeout)]),
        headers: {
          'X-CloudSSH-RDP-Client': String(RDP_CLIENT_REVISION),
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
    const paint = () => {
      const current = state,
        phase = current.state,
        fresh = phase === 'unbound' || phase === 'waiting';
      const key = downloading ? 'rdp.connectorPackaging' : stateKeys[phase];
      const text = key ? t(key) : '';
      if (hint.textContent !== text) hint.textContent = text;
      steps.hidden = download.hidden = help.hidden = !fresh;
      if (!fresh) help.open = false;
      const downloadKey = phase === 'waiting' ? 'rdp.connectorRedownload' : 'rdp.connectorDownload';
      if (download.dataset.i18n !== downloadKey) {
        download.dataset.i18n = downloadKey;
        download.textContent = t(downloadKey);
      }
      previewNote.hidden = !fresh || !this.preview;
      site.hidden = phase !== 'other_origin';
      site.textContent = phase === 'other_origin' ? current.origin : '';
      open.hidden = phase !== 'online' || !showOpen;
      unlink.hidden = phase === 'unbound';
      unlink.disabled = download.disabled = busy;
    };
    const refresh = async () => {
      const res = await request(api);
      if (!res.ok) throw new Error();
      const current = (await res.json()) as RdpConnector;
      if (life.signal.aborted || !Object.hasOwn(stateKeys, current?.state)) return;
      const old = state.state;
      state = current;
      paint();
      if (state.state === 'online' && old !== 'online') this.refreshCards();
    };
    const refreshPresence = async () => {
      timer = undefined;
      if (life.signal.aborted || Date.now() >= until || statusRequest) return;
      statusRequest = true;
      try {
        if (!document.hidden && !busy) {
          await refresh();
          failures = 0;
        }
      } catch {
        if (++failures === 2 && !life.signal.aborted)
          result.textContent = t('rdp.connectorActionFailed');
      } finally {
        statusRequest = false;
      }
      if (!life.signal.aborted)
        timer = setTimeout(refreshPresence, failures || state.state === 'online' ? 5000 : 2000);
    };
    life.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    const handle = (operation: () => Promise<void>, key: TranslationKey) => {
      if (busy || life.signal.aborted) return;
      busy = true;
      result.textContent = '';
      paint();
      void operation()
        .catch(() => {
          if (!life.signal.aborted) result.textContent = t(key);
        })
        .finally(() => {
          busy = downloading = false;
          if (!life.signal.aborted) {
            paint();
            if (timer === undefined && Date.now() < until) void refreshPresence();
          }
        });
    };
    download.onclick = () =>
      handle(async () => {
        downloading = true;
        paint();
        const res = await request(`${api}-setup`, 'POST', { revision: profile.revision }, 60_000);
        if (res.status === 409) {
          result.textContent = t('rdp.connectorActionFailed');
          await refresh();
          return;
        }
        if (
          !res.ok ||
          !res.body ||
          res.headers.get('Content-Type') !== 'application/zip' ||
          (res.headers.get('X-CloudSSH-Connector-Build') === 'test-unsigned' && !this.preview)
        )
          throw new Error();
        const size = res.headers.get('Content-Length'),
          reader = res.body.getReader();
        const parts: Uint8Array<ArrayBuffer>[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > RDP_CONNECTOR_MAX_DOWNLOAD) throw new Error();
            parts.push(value.slice());
          }
        } finally {
          void reader.cancel().catch(() => {});
        }
        if (!bytes || (size !== null && Number(size) !== bytes) || life.signal.aborted)
          throw new Error();
        saveFile(
          new Blob(parts, { type: 'application/zip' }),
          rdpConnectorSetupFilename(profile.id)
        );
        until = Date.now() + 16 * 60_000;
        await refresh().catch(() => {}); // The downloaded ZIP is usable even if the status check failed.
      }, 'rdp.connectorDownloadFailed');
    unlink.onclick = () =>
      handle(async () => {
        if (
          !(await confirmAction({
            title: t('rdp.connectorUnlink'),
            message: t('rdp.connectorUnlinkWarning'),
            confirmText: t('rdp.connectorUnlink'),
            cancelText: t('common.cancel'),
            variant: 'danger',
          })) ||
          life.signal.aborted
        )
          return;
        if (!(await request(api, 'DELETE')).ok) throw new Error();
        this.refreshCards();
        await refresh();
      }, 'rdp.connectorActionFailed');
    paint();
    document.body.append(dialog);
    dialog.showModal();
    void refreshPresence();
  }
}
