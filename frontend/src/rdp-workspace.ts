import { isRdpId } from '../../src/rdp-schema';
import { t } from './i18n';
import { confirmAction } from './ui-feedback';
import { bindRdpFullscreen } from './rdp-fullscreen';

const intentKey = 'cloudssh_rdp_open_once'; // Contains no credentials; never sufficient for authorization.
const themeProperties = ['--bg', '--bg-elevated', '--text', '--text-muted', '--accent', '--border', '--border-strong'];

export function rdpEntryId(): string | undefined {
  const id = /^\/rdp\/([^/]+)$/.exec(location.pathname)?.[1];
  return isRdpId(id) ? id : undefined;
}

/** Verified account home and RDP pages can host the isolated runtime. Login pages never need it. */
export class RdpWorkspace {
  private dialog?: HTMLDialogElement;
  private observer?: MutationObserver;
  private readonly events = new AbortController();
  private releaseView?: () => void;
  private returning?: HTMLDialogElement;
  private accountUrl = '/';

  constructor(private readonly hasSshTabs: () => boolean, private readonly onRecorded: () => void,
    private readonly standalone = false, private readonly sameOwner?: () => Promise<boolean>) {
    window.addEventListener('popstate', () => {
      if (this.dialog) void this.leave(); else this.restore(false);
    }, { signal: this.events.signal });
    let leftDuringDesktop = false;
    window.addEventListener('pagehide', () => {
      leftDuringDesktop = !!this.dialog;
      if (leftDuringDesktop) {
        const app = document.getElementById('app');
        if (app) { app.hidden = true; app.inert = true; }
      }
      this.close();
    }, { signal: this.events.signal });
    window.addEventListener('pageshow', e => {
      if (e.persisted && (this.standalone || leftDuringDesktop || rdpEntryId())) location.replace('/');
    }, { signal: this.events.signal });
    this.restore(true);
  }
  private async leave(): Promise<void> {
    const dialog = this.dialog;
    if (this.standalone || !dialog) {
      this.close();
      if (this.standalone) location.replace('/');
      else history.replaceState(null, '', this.accountUrl);
      return;
    }
    if (this.returning === dialog) return;
    this.returning = dialog;
    // Disconnect immediately. Keep the list behind the modal inert until the original owner is confirmed.
    const message = document.createElement('p');
    message.className = 'm-auto text-muted';
    message.setAttribute('role', 'status');
    message.textContent = t('rdp.returning');
    this.observer?.disconnect();
    this.releaseClient();
    dialog.replaceChildren(message);
    let ok = false;
    try { ok = await this.sameOwner?.() === true; } catch { /* An unverifiable identity must not reveal a previous list. */ }
    if (this.dialog !== dialog || this.events.signal.aborted) return;
    if (!ok) { location.replace('/'); return; }
    // popstate already restored the previous URL on browser Back. Toolbar Back consumes the entry we pushed.
    if (rdpEntryId()) history.back();
    this.close();
  }
  private restore(consumeIntent: boolean): void {
    this.close();
    const id = rdpEntryId();
    if (!id) { if (this.standalone) this.leave(); return; }
    let connect = false;
    if (consumeIntent) {
      try {
        const saved = sessionStorage.getItem(intentKey);
        sessionStorage.removeItem(intentKey);
        const now = Date.now();
        const intent = JSON.parse(saved ?? 'null');
        connect = intent?.id === id && intent.until >= now && intent.until <= now + 30000;
      } catch { /* Deep links and unavailable storage require a Connect click. */ }
    }
    if (connect) this.mount(id);
    else this.leave(); // Bookmark/refresh is not permission to release credentials.
  }
  async open(id: string): Promise<void> {
    if (!isRdpId(id) || this.events.signal.aborted) return;
    const path = `/rdp/${id}`;
    if (!window.crossOriginIsolated) {
      if (this.hasSshTabs() && !await confirmAction({ title: t('rdp.open'), message: t('rdp.leaveSsh'),
        confirmText: t('authChallenge.continue'), cancelText: t('common.cancel') })) return;
      if (this.events.signal.aborted) return;
      try { sessionStorage.setItem(intentKey, JSON.stringify({ id, until: Date.now() + 30000 })); } catch { /* ask on entry */ }
      location.assign(path);
      return;
    }
    this.accountUrl = location.pathname + location.search + location.hash;
    history.pushState(null, '', path);
    this.mount(id);
  }
  private mount(id: string): void {
    this.close();
    const dialog = document.createElement('dialog');
    dialog.className = 'rdp-workspace';
    dialog.setAttribute('aria-label', t('rdp.open'));
    const shell = document.createElement('div');
    shell.className = 'rdp-shell';
    const viewport = document.createElement('div');
    viewport.className = 'rdp-viewport';
    const bar = document.createElement('header');
    const title = document.createElement('h1');
    title.textContent = t('rdp.desktopTitle');
    // showModal() would otherwise focus Back while Full screen is disabled.
    title.tabIndex = -1;
    title.autofocus = true;
    const button = (label: string) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'cyber-button text-primary';
      item.textContent = label;
      return item;
    };
    const fullscreen = button(t('rdp.fullscreen'));
    const resolution = document.createElement('select');
    resolution.className = 'rdp-resolution';
    const back = button(t('common.back'));
    back.title = t('rdp.disconnectBack');
    back.onclick = () => this.leave();
    const latency = document.createElement('span');
    latency.className = 'rdp-latency';
    bar.append(title, latency, resolution, fullscreen, back);
    const frame = document.createElement('iframe');
    frame.title = t('rdp.open');
    frame.src = `/rdp/${id}/client`;
    // Only the host toolbar may request fullscreen. No deferred SDL request on a canvas click.
    frame.allow = "fullscreen 'none'";
    frame.dataset.connectSaved = 'true';
    const applyTheme = () => {
      const doc = frame.contentDocument;
      if (!doc || doc.location.origin !== location.origin) return;
      const style = getComputedStyle(document.body);
      for (const key of themeProperties) doc.documentElement.style.setProperty(key, style.getPropertyValue(key));
      doc.documentElement.style.colorScheme = getComputedStyle(document.documentElement).colorScheme;
    };
    frame.onload = applyTheme;
    const current = () => this.dialog === dialog && this.returning !== dialog && !this.events.signal.aborted;
    const focusDesktop = () => {
      if (!current() || !dialog.open || document.hidden || !document.hasFocus()) return;
      // Move the default or fullscreen focus, not a user's deliberate focus on Back or another dialog.
      const active = document.activeElement;
      if (![title, fullscreen, frame, shell, dialog, document.body].some(el => el === active) &&
          !(resolution.hidden && active === resolution)) return;
      const client = frame.contentDocument;
      if (client && !client.querySelector('dialog[open]')) {
        client.getElementById('canvas')?.focus({ preventScroll: true });
      }
    };
    const presentation = bindRdpFullscreen(shell, viewport, frame, fullscreen, resolution, () => {
      if (current()) frame.contentWindow?.dispatchEvent(new Event('cloudssh-rdp-fullscreen-error'));
    }, focusDesktop);
    this.releaseView = () => {
      presentation.dispose();
      // Ask a live same-origin client to close its socket and cancel pending work before removing it.
      if (frame.contentDocument) frame.contentWindow?.dispatchEvent(new Event('cloudssh-rdp-disconnect'));
    };
    let retried = false;
    frame.addEventListener('cloudssh-rdp-reconnect', event => {
      if (!current() || retried) return;
      const { revision, fingerprint } = (event as CustomEvent).detail ?? {};
      if (!Number.isSafeInteger(revision) || revision < 1 || typeof fingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/.test(fingerprint)) return;
      retried = true;
      presentation.setReady(false);
      frame.dataset.reconnectRevision = String(revision);
      frame.dataset.reconnectFingerprint = fingerprint;
      frame.dataset.connectSaved = 'true';
      frame.src = `/rdp/${id}/client`;
    });
    frame.addEventListener('cloudssh-rdp-starting', event => {
      if (!current()) return;
      const name = (event as CustomEvent).detail;
      if (typeof name === 'string') title.textContent = `${t('rdp.desktopTitle')} · ${name}`;
    });
    frame.addEventListener('cloudssh-rdp-latency', event => {
      if (!current()) return;
      const sample = (event as CustomEvent).detail;
      if (typeof sample?.text !== 'string' || typeof sample.help !== 'string') return;
      latency.textContent = sample.text;
      latency.title = sample.help;
    });
    frame.addEventListener('cloudssh-rdp-display-control', () => {
      if (current()) presentation.enableDisplayControl();
    });
    frame.addEventListener('cloudssh-rdp-ready', () => {
      if (!current()) return;
      presentation.setReady(true);
      focusDesktop();
    });
    frame.addEventListener('cloudssh-rdp-ended', () => {
      if (current()) presentation.setReady(false);
    });
    frame.addEventListener('cloudssh-rdp-recorded', () => {
      if (current()) this.onRecorded();
    }, { once: true });
    this.observer = new MutationObserver(applyTheme);
    this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    dialog.oncancel = event => { event.preventDefault(); }; // Don't drop a desktop on an accidental Esc.
    viewport.append(frame);
    shell.append(bar, viewport);
    dialog.append(shell);
    document.body.append(dialog);
    this.dialog = dialog;
    dialog.showModal();
  }
  private releaseClient(): void {
    try { this.releaseView?.(); } catch { /* An already-detached client still gets removed. */ }
    this.releaseView = undefined;
  }
  private close(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    const dialog = this.dialog;
    this.dialog = this.returning = undefined;
    this.releaseClient();
    dialog?.close();
    dialog?.remove(); // Destroys the isolated WASM realm even if it did not acknowledge closure.
  }
  dispose(): void { this.events.abort(); this.close(); }
}
