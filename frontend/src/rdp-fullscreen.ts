import { t } from './i18n';

/** Fullscreen is a local presentation change, not a Windows resolution change.
 * Keep the browsing context (and SDL backing surface) the same size through both transitions. */
export function bindRdpFullscreen(shell: HTMLElement, viewport: HTMLElement, frame: HTMLIFrameElement,
  button: HTMLButtonElement, onError: () => void) {
  let frozen: { w: number; h: number } | undefined;
  let restoreTimer: number | undefined;
  let disposed = false, pending = false, ready = false;
  const active = () => document.fullscreenElement === shell;
  const paint = () => {
    if (!frozen) return;
    const scale = Math.min(viewport.clientWidth / frozen.w, viewport.clientHeight / frozen.h);
    if (scale > 0) frame.style.setProperty('--rdp-scale', String(scale));
  };
  const thaw = () => {
    frozen = undefined;
    frame.style.removeProperty('width'); frame.style.removeProperty('height');
    frame.style.removeProperty('--rdp-scale');
  };
  // The system may restore its normal viewport over several frames (especially macOS).
  const settle = () => {
    clearTimeout(restoreTimer);
    if (frozen && !active() && !pending) restoreTimer = window.setTimeout(thaw, 400);
  };
  const observer = new ResizeObserver(() => { paint(); settle(); });
  observer.observe(viewport);
  const sync = () => {
    button.disabled = pending || (!active() && (!ready || !document.fullscreenEnabled || !shell.requestFullscreen));
    button.textContent = t(active() ? 'rdp.exitFullscreen' : 'rdp.fullscreen');
    paint(); settle();
  };
  const toggle = async () => {
    if (disposed || button.disabled || pending) return;
    pending = true;
    clearTimeout(restoreTimer);
    try {
      if (active()) await document.exitFullscreen();
      else {
        if (!frozen) {
          frozen = { w: Math.max(1, frame.clientWidth), h: Math.max(1, frame.clientHeight) };
          frame.style.width = `${frozen.w}px`; frame.style.height = `${frozen.h}px`;
        }
        await shell.requestFullscreen();
        if (!disposed && !ready && active()) await document.exitFullscreen(); // Session ended during the transition.
      }
    } catch { if (!disposed) onError(); }
    finally { pending = false; if (!disposed) sync(); }
  };
  button.addEventListener('click', toggle);
  shell.addEventListener('fullscreenchange', sync);
  sync();
  return {
    setReady(value: boolean) {
      ready = value; sync();
      if (!value && active()) void document.exitFullscreen().catch(() => {});
    },
    dispose() {
      disposed = true; observer.disconnect(); clearTimeout(restoreTimer);
      button.removeEventListener('click', toggle); shell.removeEventListener('fullscreenchange', sync);
      // Removing the fullscreen shell exits fullscreen. Never wait for it to close a connection.
    },
  };
}
