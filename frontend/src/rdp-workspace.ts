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

/** Only the RDP workspace is cross-origin isolated; normal OAuth and Turnstile pages are not. */
export class RdpWorkspace {
  private dialog?: HTMLDialogElement;
  private observer?: MutationObserver;
  private readonly events = new AbortController();
  private releaseView?: () => void;

  constructor(private readonly hasSshTabs: () => boolean, private readonly onRecorded: () => void,
    private readonly standalone = false) {
    window.addEventListener('popstate', () => this.restore(false), { signal: this.events.signal });
    window.addEventListener('pagehide', () => this.close(), { signal: this.events.signal });
    window.addEventListener('pageshow', e => {
      if (e.persisted && this.standalone && !this.dialog) this.leave();
    }, { signal: this.events.signal });
    this.restore(true);
  }
  private leave(): void {
    this.close();
    if (this.standalone) location.replace('/');
    else history.replaceState(null, '', '/');
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
    const button = (label: string) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'cyber-button text-primary';
      item.textContent = label;
      return item;
    };
    const fullscreen = button(t('rdp.fullscreen'));
    const back = button(t('common.back'));
    back.title = t('rdp.disconnectBack');
    back.onclick = () => this.leave();
    bar.append(title, fullscreen, back);
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
    const current = () => this.dialog === dialog && !this.events.signal.aborted;
    const presentation = bindRdpFullscreen(shell, viewport, frame, fullscreen, () => {
      if (current()) frame.contentWindow?.dispatchEvent(new Event('cloudssh-rdp-fullscreen-error'));
    });
    this.releaseView = () => {
      presentation.dispose();
      // Ask a live same-origin client to close its socket and cancel pending work before removing it.
      if (frame.contentDocument) frame.contentWindow?.dispatchEvent(new Event('cloudssh-rdp-disconnect'));
    };
    frame.addEventListener('cloudssh-rdp-starting', event => {
      if (!current()) return;
      const name = (event as CustomEvent).detail;
      if (typeof name === 'string') title.textContent = `${t('rdp.desktopTitle')} · ${name}`;
    });
    frame.addEventListener('cloudssh-rdp-ready', () => {
      if (current()) presentation.setReady(true);
    });
    frame.addEventListener('cloudssh-rdp-ended', () => {
      if (current()) presentation.setReady(false);
    });
    frame.addEventListener('cloudssh-rdp-recorded', () => {
      if (this.dialog === dialog && !this.events.signal.aborted) this.onRecorded();
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
  private close(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    const dialog = this.dialog;
    this.dialog = undefined;
    try { this.releaseView?.(); } finally {
      this.releaseView = undefined;
      dialog?.close();
      dialog?.remove(); // Destroys the isolated WASM realm even if it did not acknowledge closure.
    }
  }
  dispose(): void { this.events.abort(); this.close(); }
}
