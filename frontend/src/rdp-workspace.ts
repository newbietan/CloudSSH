import { isRdpId } from '../../src/rdp-schema';
import { t } from './i18n';
import { confirmAction } from './ui-feedback';

const intentKey = 'cloudssh_rdp_open_once'; // Contains no credentials; never sufficient for authorization.
const themeProperties = ['--bg', '--bg-elevated', '--text', '--text-muted', '--accent', '--border', '--border-strong'];

/** Only the RDP workspace is cross-origin isolated; normal OAuth and Turnstile pages are not. */
export class RdpWorkspace {
  private dialog?: HTMLDialogElement;
  private observer?: MutationObserver;
  private readonly events = new AbortController();
  private readonly pathId = () => /^\/rdp\/([^/]+)$/.exec(location.pathname)?.[1];

  constructor(private readonly hasSshTabs: () => boolean, private readonly onRecorded: () => void) {
    window.addEventListener('popstate', () => this.restore(false), { signal: this.events.signal });
    window.addEventListener('pagehide', () => this.close(), { signal: this.events.signal });
    this.restore(true);
  }
  private restore(consumeIntent: boolean): void {
    this.close();
    const id = this.pathId();
    if (!isRdpId(id)) return;
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
    else history.replaceState(null, '', '/'); // Bookmark/refresh is not permission to release credentials.
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
    const disconnect = button(t('rdp.disconnect'));
    const fullscreen = button(t('rdp.fullscreen'));
    const back = button(t('common.back'));
    disconnect.disabled = fullscreen.disabled = true;
    back.onclick = () => { history.replaceState(null, '', '/'); this.close(); };
    bar.append(title, disconnect, fullscreen, back);
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
    frame.addEventListener('cloudssh-rdp-starting', event => {
      if (!current()) return;
      const name = (event as CustomEvent).detail;
      if (typeof name === 'string') title.textContent = `${t('rdp.desktopTitle')} · ${name}`;
      disconnect.disabled = false;
    });
    frame.addEventListener('cloudssh-rdp-ready', () => {
      if (current()) fullscreen.disabled = !document.fullscreenEnabled || !frame.requestFullscreen;
    });
    frame.addEventListener('cloudssh-rdp-ended', () => {
      if (!current()) return;
      disconnect.disabled = fullscreen.disabled = true;
      if (document.fullscreenElement === frame) void document.exitFullscreen().catch(() => {});
    });
    disconnect.onclick = () => frame.contentWindow?.dispatchEvent(new Event('cloudssh-rdp-disconnect'));
    fullscreen.onclick = () => {
      if (!current() || fullscreen.disabled) return;
      void frame.requestFullscreen().catch(() => {
        if (current()) frame.contentWindow?.dispatchEvent(new Event('cloudssh-rdp-fullscreen-error'));
      });
    };
    frame.addEventListener('fullscreenchange', () => {
      frame.contentDocument?.documentElement.toggleAttribute('data-desktop-fullscreen', document.fullscreenElement === frame);
    });
    frame.addEventListener('cloudssh-rdp-recorded', () => {
      if (this.dialog === dialog && !this.events.signal.aborted) this.onRecorded();
    }, { once: true });
    this.observer = new MutationObserver(applyTheme);
    this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    dialog.oncancel = event => { event.preventDefault(); }; // Don't drop a desktop on an accidental Esc.
    dialog.append(bar, frame);
    document.body.append(dialog);
    this.dialog = dialog;
    dialog.showModal();
  }
  private close(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.dialog?.close();
    this.dialog?.remove(); // Destroys the isolated WASM realm and its connection.
    this.dialog = undefined;
  }
  dispose(): void { this.events.abort(); this.close(); }
}
