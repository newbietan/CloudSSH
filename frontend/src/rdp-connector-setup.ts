import {
  isRdpId,
  RDP_CLIENT_REVISION,
  RDP_CONNECTOR_FILENAME,
  RDP_CONNECTOR_MAX_DOWNLOAD,
  type RdpConnector,
  type RdpProfile,
} from '../../src/rdp-schema';
import { localizedElement, t, type TranslationKey } from './i18n';
import { confirmAction } from './ui-feedback';

const selector = '/api/rdp/profiles/';
const fingerprint = /^[a-f0-9]{64}$/;
const stateKeys = {
  unbound: 'rdp.connectorUnbound',
  waiting: 'rdp.connectorWaiting',
  pending: 'rdp.connectorPending',
  online: 'rdp.connectorOnline',
  offline: 'rdp.connectorOffline',
  other_origin: 'rdp.connectorOtherOrigin',
} as const;
export function connectorState(state: unknown): TranslationKey {
  return typeof state === 'string' && Object.hasOwn(stateKeys, state)
    ? stateKeys[state as keyof typeof stateKeys]
    : stateKeys.unbound;
}

function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
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

/** Owned by the authenticated device list. Never transfers the short-lived grant via URL or clipboard. */
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

  open(profile: RdpProfile, launchAfterConfirm = true): void {
    this.dispose();
    const dialog = document.createElement('dialog');
    dialog.className = 'rdp-connector-dialog';
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
    const title = localizedElement('h2', 'rdp.connectorSetup');
    title.id = 'rdp-connector-title';
    const who = document.createElement('p');
    who.textContent = profile.name;
    const steps = localizedElement('p', 'rdp.connectorIntro');
    const actionHint = document.createElement('p');
    actionHint.setAttribute('role', 'status');
    const result = document.createElement('p');
    result.setAttribute('role', 'alert');
    const detail = document.createElement('section');
    detail.hidden = true;
    const label = document.createElement('p');
    const key = document.createElement('code');
    const check = localizedElement('p', 'rdp.connectorCheckKey');
    const tools = document.createElement('div');
    tools.className = 'rdp-connector-actions';
    const controls = document.createElement('div');
    controls.className = 'rdp-connector-actions';
    const button = (key: TranslationKey) => {
      const b = localizedElement('button', key);
      b.type = 'button';
      b.className = 'cyber-button text-primary';
      return b;
    };
    const download = button('rdp.connectorDownload'),
      enroll = button('rdp.connectorBindingFile');
    const confirm = button(
      launchAfterConfirm ? 'rdp.connectorApproveOpen' : 'rdp.connectorApprove'
    );
    const unlink = button('rdp.connectorUnlink'),
      open = button('rdp.open'),
      back = button('common.close');
    detail.append(label, check, key, confirm);
    tools.append(download, enroll);
    const previewNotice = localizedElement('p', 'rdp.connectorPreviewNotice');
    previewNotice.hidden = !this.preview;
    controls.append(open, unlink, back);
    dialog.append(title, who, steps, previewNotice, tools, actionHint, detail, result, controls);
    back.onclick = dismiss;
    const goto = () => {
      dismiss();
      this.openDesktop(profile.id);
    };
    open.onclick = goto;
    let state: RdpConnector = profile.connector ?? { state: 'unbound' };
    let busy = false,
      downloading = false,
      waitUntil = 0;
    const api = `${selector}${profile.id}`;
    const get = (path: string, method = 'GET', data?: object, timeout = 10_000) =>
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
      const current = state;
      const phase = current.state;
      const waiting = waitUntil > Date.now();
      const caption =
        waiting && phase !== 'online' ? t('rdp.connectorStarting') : t(connectorState(phase));
      if (actionHint.textContent !== caption) actionHint.textContent = caption;
      const installed = phase === 'online' || phase === 'offline' || phase === 'other_origin';
      tools.hidden = installed;
      steps.hidden = installed;
      previewNotice.hidden = installed || !this.preview;
      enroll.disabled = busy;
      confirm.disabled = busy;
      detail.hidden = phase !== 'pending' && phase !== 'other_origin';
      check.hidden = confirm.hidden = phase !== 'pending';
      label.textContent = phase === 'pending' ? current.label : '';
      key.textContent =
        phase === 'pending' ? current.fingerprint : phase === 'other_origin' ? current.origin : '';
      open.hidden = phase !== 'online' || !launchAfterConfirm;
      unlink.hidden = phase === 'unbound';
      unlink.disabled = busy;
      download.disabled = downloading;
    };
    const refresh = async () => {
      const res = await get(`${api}/connector`);
      if (!res.ok) throw new Error();
      const latest = (await res.json()) as RdpConnector;
      if (life.signal.aborted || !Object.hasOwn(stateKeys, latest?.state)) return;
      state = latest;
      paint();
      if (waitUntil > Date.now() && state.state === 'online') goto();
    };
    const handle = (
      operation: () => Promise<void>,
      errKey: TranslationKey = 'rdp.connectorActionFailed'
    ) => {
      if (busy || life.signal.aborted) return;
      busy = true;
      result.textContent = '';
      paint();
      void operation()
        .catch(() => {
          if (!life.signal.aborted) result.textContent = t(errKey);
        })
        .finally(() => {
          busy = false;
          if (!life.signal.aborted) paint();
        });
    };
    download.onclick = () => {
      if (downloading) return;
      downloading = true;
      result.textContent = '';
      paint();
      void (async () => {
        const res = await get('/rdp/download/windows-x64', 'GET', undefined, 60_000);
        if (
          !res.ok ||
          !res.body ||
          res.headers.get('Content-Type') !== 'application/zip' ||
          (res.headers.get('X-CloudSSH-Connector-Build') === 'test-unsigned' && !this.preview)
        )
          throw new Error();
        const size = res.headers.get('Content-Length');
        const reader = res.body.getReader();
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
        if (bytes < 1024 || (size !== null && Number(size) !== bytes) || life.signal.aborted)
          throw new Error();
        saveFile(new Blob(parts, { type: 'application/zip' }), RDP_CONNECTOR_FILENAME);
      })()
        .catch(() => {
          if (!life.signal.aborted) result.textContent = t('rdp.connectorDownloadFailed');
        })
        .finally(() => {
          downloading = false;
          if (!life.signal.aborted) paint();
        });
    };
    enroll.onclick = () =>
      handle(async () => {
        const res = await get(`${api}/connector-enroll`, 'POST', { revision: profile.revision });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (
          data?.version !== 2 ||
          data.origin !== location.origin ||
          !/^e2\.[a-zA-Z0-9.-]{100,277}$/.test(data.grant) ||
          !Number.isSafeInteger(data.expires) ||
          data.expires <= Date.now() ||
          life.signal.aborted
        )
          throw new Error();
        saveFile(
          new Blob([JSON.stringify(data)], { type: 'application/json' }),
          'cloudssh-binding.cloudssh-rdp.json'
        );
        state = { state: 'waiting', expires: data.expires };
        paint();
      });
    confirm.onclick = () =>
      handle(async () => {
        if (state.state !== 'pending' || !isRdpId(state.id) || !fingerprint.test(state.fingerprint))
          return;
        const res = await get(`${api}/connector-confirm`, 'POST', {
          device: state.id,
          fingerprint: state.fingerprint,
        });
        if (!res.ok) throw new Error();
        if (life.signal.aborted) return;
        if (launchAfterConfirm) waitUntil = Date.now() + 35_000;
        this.refreshCards();
        await refresh();
      });
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
        const res = await get(`${api}/connector`, 'DELETE');
        if (!res.ok) throw new Error();
        waitUntil = 0;
        this.refreshCards();
        await refresh();
      });
    paint();
    document.body.append(dialog);
    dialog.showModal();
    let failedReads = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    life.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    const until = Date.now() + 16 * 60_000;
    const refreshPresence = async () => {
      if (life.signal.aborted || Date.now() >= until) return;
      if (!document.hidden && !busy) {
        try {
          await refresh();
          failedReads = 0;
        } catch {
          if (++failedReads === 2 && !life.signal.aborted)
            result.textContent = t('rdp.connectorActionFailed');
        }
      }
      if (!life.signal.aborted)
        timer = setTimeout(refreshPresence, failedReads || state.state === 'online' ? 5000 : 2000);
    };
    void refreshPresence();
  }
}
