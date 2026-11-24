import { t } from './i18n';

/** Fullscreen is a local presentation change, not a Windows resolution change.
 * Keep the browsing context (and SDL backing surface) the same size through both transitions. */
export function bindRdpFullscreen(shell: HTMLElement, viewport: HTMLElement, frame: HTMLIFrameElement,
  button: HTMLButtonElement, onError: () => void, focusDesktop: () => void) {
  let frozen: { w: number; h: number } | undefined;
  let sourceCanvas: HTMLCanvasElement | null = null;
  let restoreTimer: number | undefined;
  let disposed = false, pending = false, ready = false;
  const active = () => document.fullscreenElement === shell;
  const paint = () => {
    if (!frozen) return;
    const { width, height } = viewport.getBoundingClientRect();
    if (!width || !height) return;
    // Keep the old proportional presentation while the normal window settles after Esc.
    frame.style.setProperty('--rdp-scale', String(Math.min(width / frozen.w, height / frozen.h)));
    // Measure in the child's *logical* CSS pixels (unaffected by the host transform). A
    // fixed-resolution desktop may already have margins inside the iframe. Map the canvas,
    // not those margins, to the host viewport. Browser hit testing applies the inverse map.
    const rect = sourceCanvas?.getBoundingClientRect();
    const source = rect && rect.width > 0 && rect.height > 0 ? rect :
      { left: 0, top: 0, width: frozen.w, height: frozen.h };
    frame.style.setProperty('--rdp-fill-transform',
      `scale(${width / source.width}, ${height / source.height}) translate(${-source.left}px, ${-source.top}px)`);
  };
  const thaw = () => {
    frozen = undefined;
    if (sourceCanvas) observer.unobserve(sourceCanvas);
    sourceCanvas = null;
    frame.style.removeProperty('--rdp-fill-transform');
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
          sourceCanvas = frame.contentDocument?.querySelector<HTMLCanvasElement>('#canvas') ?? null;
          if (sourceCanvas) observer.observe(sourceCanvas);
        }
        paint();
        await shell.requestFullscreen();
        if (!disposed && !ready && active()) await document.exitFullscreen(); // Session ended during the transition.
      }
    } catch { if (!disposed) onError(); }
    finally { pending = false; if (!disposed) sync(); }
  };
  const fullscreenChanged = () => {
    sync();
    if (ready && !disposed) focusDesktop(); // Both toolbar toggles and the system's fullscreen exit.
  };
  button.addEventListener('click', toggle);
  shell.addEventListener('fullscreenchange', fullscreenChanged);
  sync();
  return {
    setReady(value: boolean) {
      ready = value; sync();
      if (!value && active()) void document.exitFullscreen().catch(() => {});
    },
    dispose() {
      disposed = true; observer.disconnect(); sourceCanvas = null; clearTimeout(restoreTimer);
      button.removeEventListener('click', toggle); shell.removeEventListener('fullscreenchange', fullscreenChanged);
      // Removing the fullscreen shell exits fullscreen. Never wait for it to close a connection.
    },
  };
}
