import type { IDisposable, Terminal } from '@xterm/xterm';
import { copyTextToClipboard, copyTextWithExecCommand } from './clipboard';
import { onLocaleChange, t } from './i18n';
import { notify } from './ui-feedback';

export const MAX_REMOTE_COPY_BYTES = 64 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_REMOTE_COPY_BYTES / 3) * 4;
const INTERACTION_WINDOW_MS = 2_500;
const ACTION_TIMEOUT_MS = 30_000;

/** Support only nonempty OSC 52 writes to the clipboard (`c`), never reads or clears. */
export function parseRemoteCopy(data: string): string | null {
  if (!data.startsWith('c;') || data.length > MAX_BASE64_LENGTH + 2) return null;
  const encoded = data.slice(2);
  if (!encoded || /[^A-Za-z0-9+/=]/.test(encoded)) return null;

  try {
    const decoded = atob(encoded);
    if (decoded.length > MAX_REMOTE_COPY_BYTES) return null;
    const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    for (const char of text) {
      const code = char.charCodeAt(0);
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) {
        return null;
      }
    }
    return text;
  } catch {
    return null;
  }
}

/** One instance per ready non-share WebSocket; no application permission is stored. */
export class TerminalRemoteCopy {
  private interactionUntil = 0;
  private generation = 0;
  private parser: IDisposable | null = null;
  private pending: { text: string; button: HTMLButtonElement; clear: () => void } | null = null;
  private writing = false;
  private latest: string | null = null;

  constructor(
    private readonly terminal: Terminal,
    private readonly host: HTMLElement,
    private readonly connected: () => boolean
  ) {
    document.addEventListener('visibilitychange', this.visibilityChanged);
    window.addEventListener('focus', this.visibilityChanged);
    window.addEventListener('blur', this.visibilityChanged);
    this.resume();
  }

  private visible(): boolean {
    return this.connected() && document.visibilityState === 'visible' && document.hasFocus() &&
      this.host.getClientRects().length > 0;
  }

  private readonly visibilityChanged = (event: Event) => {
    if (event.type === 'blur' || !this.visible()) this.suspend();
    else this.resume();
  };

  resume(): void {
    if (this.parser || !this.visible()) return;
    const generation = this.generation;
    // xterm queues writes. Drain hidden/previous output before installing a fresh handler;
    // don't inject a control character into an unrelated in-progress terminal sequence.
    this.terminal.write('', () => {
      if (this.parser || generation !== this.generation || !this.visible()) return;
      this.parser = this.terminal.parser.registerOscHandler(52, data => {
        if (generation === this.generation && this.visible() && performance.now() < this.interactionUntil) {
          const text = parseRemoteCopy(data);
          if (text !== null) {
            this.interactionUntil = 0;
            this.receive(text);
          }
        }
        return true;
      });
    });
  }

  suspend(): void {
    this.generation++;
    this.interactionUntil = 0;
    this.parser?.dispose();
    this.parser = null;
    this.pending?.clear();
    this.latest = null;
  }

  dispose(): void {
    this.suspend();
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    window.removeEventListener('focus', this.visibilityChanged);
    window.removeEventListener('blur', this.visibilityChanged);
  }

  noteInteraction(event: Event): void {
    // At most one OSC write per recent trusted in-terminal gesture. Background output
    // and browser actions elsewhere on the page do not open this window.
    if (event.isTrusted && this.visible()) {
      this.interactionUntil = performance.now() + INTERACTION_WINDOW_MS;
    }
  }

  focusAction(): boolean {
    if (!this.pending || !this.visible()) return false;
    this.pending.button.focus();
    return true;
  }

  private receive(text: string): void {
    this.pending?.clear();
    if (this.writing) this.latest = text; // Keep only the newest locally initiated copy.
    else void this.write(text, false);
  }

  private async write(text: string, fromClick: boolean): Promise<void> {
    const generation = this.generation;
    const current = () => generation === this.generation && this.visible();
    this.writing = true;
    let copied = false;
    try {
      if (fromClick) {
        copied = await copyTextToClipboard(
          text, undefined, value => current() && copyTextWithExecCommand(value)
        );
      } else {
        // Never simulate a copy gesture or use execCommand for automatic remote writes.
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch { /* API unavailable, browser permission denied or a gesture is required. */ }
    this.writing = false;
    const next = this.latest;
    this.latest = null;
    if (current() && !copied && !fromClick && next === null) {
      this.showAction(text);
      return;
    }
    if (fromClick && current()) {
      if (copied) notify(t('terminal.copySuccess'), { variant: 'success', duration: 1500 });
      else notify(t('terminal.copyFailed'), { variant: 'danger' });
    }
    if (next !== null && this.parser && this.visible()) this.receive(next);
  }

  private showAction(text: string): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'terminal-remote-copy';
    button.setAttribute('aria-keyshortcuts', 'Alt+Shift+C');
    const translate = () => {
      button.textContent = t('terminal.remoteCopyOnce');
      button.title = t('terminal.remoteCopyGestureHint');
    };
    const cleanupLocale = onLocaleChange(translate);
    const deadline = performance.now() + ACTION_TIMEOUT_MS;
    const clear = () => {
      if (this.pending?.button !== button) return;
      this.pending = null;
      clearTimeout(timer);
      cleanupLocale();
      button.remove();
    };
    const timer = window.setTimeout(() => {
      const restoreFocus = document.activeElement === button && this.visible();
      clear();
      if (restoreFocus) this.terminal.focus();
    }, ACTION_TIMEOUT_MS);
    this.pending = { text, button, clear };
    button.addEventListener('click', event => {
      if (!event.isTrusted || this.pending?.button !== button) return;
      if (performance.now() >= deadline || !this.visible()) { clear(); return; }
      const value = this.pending.text;
      clear();
      void this.write(value, true); // Start in the browser's trusted click, before any await.
      this.terminal.focus();
    });
    button.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      event.stopPropagation();
      clear();
      if (this.visible()) this.terminal.focus();
    });
    translate();
    this.host.append(button);
  }
}
