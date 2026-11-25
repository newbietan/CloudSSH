import { t } from './i18n';

type Size = { w: number; h: number };

/** Freeze the runtime through fullscreen transitions. Only an explicit resolution choice
 * for a DISP-capable session can change its logical viewport while fullscreen. */
export function bindRdpFullscreen(shell: HTMLElement, viewport: HTMLElement, frame: HTMLIFrameElement,
  button: HTMLButtonElement, resolution: HTMLSelectElement, onError: () => void, focusDesktop: () => void) {
  let original: Size | undefined, frozen: Size | undefined;
  let sourceCanvas: HTMLCanvasElement | null = null;
  let restoreTimer: number | undefined, fitTimer: number | undefined;
  let disposed = false, pending = false, ready = false, displayControl = false;
  const active = () => document.fullscreenElement === shell;
  resolution.setAttribute('aria-label', t('rdp.fullscreenResolution'));
  resolution.title = t('rdp.fullscreenResolution');
  resolution.append(
    new Option(t('rdp.scaleOnly'), 'local'), new Option(t('rdp.matchFullscreen'), 'fit'),
    new Option('1280 × 720', '720p'), new Option('1920 × 1080', '1080p'),
  );
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
  const setLogicalSize = (size: Size) => {
    if (size.w === frozen?.w && size.h === frozen.h) return;
    frozen = size;
    frame.style.width = `${size.w}px`;
    frame.style.height = `${size.h}px`;
    paint();
  };
  const canSwitch = () => !disposed && ready && displayControl && active() && !pending;
  const scheduleFit = () => {
    clearTimeout(fitTimer);
    if (!canSwitch() || resolution.value !== 'fit') return;
    fitTimer = window.setTimeout(() => {
      if (!canSwitch() || resolution.value !== 'fit') return;
      const w = viewport.clientWidth, h = viewport.clientHeight;
      if (w && h) setLogicalSize({ w, h }); // The runtime applies its existing RDP size limits.
    }, 250);
  };
  const resolutionChanged = () => {
    clearTimeout(fitTimer);
    if (!canSwitch() || !original) return;
    switch (resolution.value) {
      case 'fit': scheduleFit(); break;
      case '720p': setLogicalSize({ w: 1280, h: 720 }); break;
      case '1080p': setLogicalSize({ w: 1920, h: 1080 }); break;
      case 'local': setLogicalSize(original); break;
    }
  };
  const thaw = () => {
    original = frozen = undefined;
    if (sourceCanvas) observer.unobserve(sourceCanvas);
    sourceCanvas = null;
    frame.style.removeProperty('--rdp-fill-transform');
    frame.style.removeProperty('width'); frame.style.removeProperty('height');
    frame.style.removeProperty('--rdp-scale');
    sync();
  };
  // The system may restore its normal viewport over several frames (especially macOS).
  const settle = () => {
    clearTimeout(restoreTimer);
    if (frozen && !active() && !pending) restoreTimer = window.setTimeout(thaw, 400);
  };
  const observer = new ResizeObserver(entries => {
    paint();
    if (entries.some(entry => entry.target === viewport)) { settle(); scheduleFit(); }
  });
  observer.observe(viewport);
  const sync = () => {
    const full = active();
    button.disabled = pending || (!full && (!!frozen || !ready || !document.fullscreenEnabled || !shell.requestFullscreen));
    button.textContent = t(full ? 'rdp.exitFullscreen' : 'rdp.fullscreen');
    resolution.hidden = !full || !ready || !displayControl;
    resolution.disabled = !canSwitch();
    if (!full) resolution.value = 'local';
    paint(); settle(); scheduleFit();
  };
  const toggle = async () => {
    if (disposed || button.disabled || pending) return;
    pending = true;
    sync();
    try {
      if (active()) await document.exitFullscreen();
      else {
        original = { w: Math.max(1, frame.clientWidth), h: Math.max(1, frame.clientHeight) };
        sourceCanvas = frame.contentDocument?.querySelector<HTMLCanvasElement>('#canvas') ?? null;
        if (sourceCanvas) observer.observe(sourceCanvas);
        setLogicalSize(original);
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
  resolution.addEventListener('change', resolutionChanged);
  shell.addEventListener('fullscreenchange', fullscreenChanged);
  sync();
  return {
    enableDisplayControl() { displayControl = true; sync(); },
    setReady(value: boolean) {
      ready = value;
      if (!ready) displayControl = false;
      sync();
      if (!value && active()) void document.exitFullscreen().catch(() => {});
    },
    dispose() {
      disposed = true; observer.disconnect(); sourceCanvas = null;
      clearTimeout(restoreTimer); clearTimeout(fitTimer);
      button.removeEventListener('click', toggle);
      resolution.removeEventListener('change', resolutionChanged);
      shell.removeEventListener('fullscreenchange', fullscreenChanged);
      // Removing the fullscreen shell exits fullscreen. Never wait for it to close a connection.
    },
  };
}
