import { onLocaleChange, t } from './i18n';
import type { MobileModifier, MobileTerminalKey } from './mobile-input';
import type { SSHTerminal } from './terminal';
import { notify } from './ui-feedback';

type TerminalGetter = () => SSHTerminal | null;

const VIEWPORT_FIT_STABLE_DELAY_MS = 120;
const SOFT_KEYBOARD_MIN_OCCLUSION_PX = 120;
const MOBILE_LAYOUT_QUERY = '(max-width: 767px), (max-width: 1180px) and (pointer: coarse)';

const TERMINAL_KEY_ACTIONS = new Set<MobileTerminalKey>([
  'escape',
  'tab',
  'arrow_up',
  'arrow_down',
  'arrow_right',
  'arrow_left',
  'home',
  'end',
  'page_up',
  'page_down',
]);

export class MobileTerminalController {
  private viewportFrame: number | null = null;
  private fitTimer: ReturnType<typeof setTimeout> | null = null;
  private maximumViewportHeight = 0;
  private moreMenu: HTMLElement | null;
  private modifierButtons: HTMLButtonElement[];
  private activeTerminal: SSHTerminal | null = null;
  private readonly viewportListener = () => this.scheduleViewportUpdate();
  private readonly viewportResetListener = () => {
    this.maximumViewportHeight = 0;
    this.scheduleViewportUpdate();
  };
  private readonly terminalStateListener = () => this.syncTerminalState();
  private readonly outsideMenuListener = (event: PointerEvent) => {
    const target = event.target as Node | null;
    const button = document.getElementById('mobile-more-btn');
    if (target && (this.moreMenu?.contains(target) || button?.contains(target))) return;
    this.hideMoreMenu();
  };

  constructor(private readonly getTerminal: TerminalGetter) {
    this.moreMenu = document.getElementById('mobile-more-menu');
    this.modifierButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-mobile-modifier]')
    );
  }

  start(): void {
    window.addEventListener('resize', this.viewportListener, { passive: true });
    window.addEventListener('orientationchange', this.viewportResetListener, { passive: true });
    window.visualViewport?.addEventListener('resize', this.viewportListener, { passive: true });
    window.visualViewport?.addEventListener('scroll', this.viewportListener, { passive: true });
    document.addEventListener('fullscreenchange', this.viewportResetListener);
    document.addEventListener('cloudssh:mobile-modifier-change', this.terminalStateListener);
    document.addEventListener('cloudssh:active-terminal-change', this.terminalStateListener);
    document.addEventListener('pointerdown', this.outsideMenuListener, true);

    document
      .getElementById('mobile-more-btn')
      ?.addEventListener('click', () => this.toggleMoreMenu());
    document.getElementById('mobile-search-btn')?.addEventListener('click', () => {
      this.getTerminal()?.toggleSearch();
      this.hideMoreMenu();
    });
    document.getElementById('mobile-export-btn')?.addEventListener('click', () => {
      this.getTerminal()?.exportToFile();
      this.hideMoreMenu();
    });
    document.getElementById('mobile-landscape-btn')?.addEventListener('click', () => {
      void this.requestLandscape();
      this.hideMoreMenu();
    });

    document.querySelectorAll<HTMLButtonElement>('[data-terminal-key]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.terminalKey || '';
        const terminal = this.getTerminal();
        if (terminal && TERMINAL_KEY_ACTIONS.has(key as MobileTerminalKey)) {
          terminal.sendMobileKey(key as MobileTerminalKey);
        } else if (terminal && key) {
          terminal.sendInput(key);
        }
        this.syncModifierButtons();
      });
    });

    this.modifierButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const terminal = this.getTerminal();
        if (!terminal) return;
        const modifier = button.dataset.mobileModifier as MobileModifier;
        terminal.setMobileModifier(terminal.getMobileModifier() === modifier ? null : modifier);
        this.syncModifierButtons();
        terminal.focus();
      });
    });

    document.getElementById('mobile-copy-btn')?.addEventListener('click', () => {
      void this.handleCopyAction();
    });
    document.getElementById('mobile-paste-btn')?.addEventListener('click', () => {
      void this.getTerminal()?.pasteFromClipboard();
    });
    document.getElementById('mobile-keyboard-hide-btn')?.addEventListener('click', () => {
      this.getTerminal()?.blur();
    });

    onLocaleChange(() => this.updateOrientationLabel());
    this.updateOrientationLabel();
    this.syncTerminalState();
    this.scheduleViewportUpdate();
  }

  private scheduleViewportUpdate(): void {
    if (this.viewportFrame !== null) cancelAnimationFrame(this.viewportFrame);
    this.viewportFrame = requestAnimationFrame(() => {
      this.viewportFrame = null;
      const visualViewport = window.visualViewport;
      const viewportHeight = Math.max(1, Math.round(visualViewport?.height ?? window.innerHeight));
      const viewportOffsetTop = Math.max(0, Math.round(visualViewport?.offsetTop ?? 0));
      const isMobileLayout = window.matchMedia?.(MOBILE_LAYOUT_QUERY).matches ?? false;

      if (this.maximumViewportHeight === 0 || viewportHeight > this.maximumViewportHeight) {
        this.maximumViewportHeight = viewportHeight;
      }
      const keyboardOpen =
        isMobileLayout &&
        this.maximumViewportHeight - viewportHeight >= SOFT_KEYBOARD_MIN_OCCLUSION_PX;

      const root = document.documentElement;
      root.style.setProperty('--visual-viewport-height', `${viewportHeight}px`);
      root.style.setProperty('--visual-viewport-offset-top', `${viewportOffsetTop}px`);
      root.classList.toggle('mobile-keyboard-open', keyboardOpen);
      this.scheduleStableFit();
      this.updateOrientationLabel();
    });
  }

  private scheduleStableFit(): void {
    if (!document.body.classList.contains('terminal-active')) return;
    if (this.fitTimer !== null) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      this.fitTimer = null;
      this.getTerminal()?.fit();
    }, VIEWPORT_FIT_STABLE_DELAY_MS);
  }

  private toggleMoreMenu(): void {
    const hidden = this.moreMenu?.classList.contains('hidden') ?? true;
    this.moreMenu?.classList.toggle('hidden', !hidden);
    document.getElementById('mobile-more-btn')?.setAttribute('aria-expanded', String(hidden));
  }

  private hideMoreMenu(): void {
    this.moreMenu?.classList.add('hidden');
    document.getElementById('mobile-more-btn')?.setAttribute('aria-expanded', 'false');
  }

  private syncModifierButtons(): void {
    const active = this.getTerminal()?.getMobileModifier() ?? null;
    this.modifierButtons.forEach((button) => {
      const pressed = button.dataset.mobileModifier === active;
      button.classList.toggle('is-active', pressed);
      button.setAttribute('aria-pressed', String(pressed));
    });
  }

  private syncTerminalState(): void {
    const terminal = this.getTerminal();
    if (this.activeTerminal && this.activeTerminal !== terminal) {
      this.activeTerminal.setMobileSelectionMode(false);
    }
    this.activeTerminal = terminal;
    this.syncModifierButtons();
    this.syncCopyButton();
    this.scheduleStableFit();
  }

  private syncCopyButton(): void {
    const button = document.getElementById('mobile-copy-btn');
    if (!button) return;
    const active = this.getTerminal()?.isMobileSelectionMode() ?? false;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }

  private async handleCopyAction(): Promise<void> {
    const terminal = this.getTerminal();
    if (!terminal) return;

    if (terminal.hasSelection()) {
      const copied = await terminal.copyCurrentSelection();
      if (copied) {
        terminal.setMobileSelectionMode(false);
        terminal.clearSelection();
      }
      this.syncCopyButton();
      return;
    }

    const enabled = !terminal.isMobileSelectionMode();
    terminal.setMobileSelectionMode(enabled);
    if (enabled) {
      terminal.blur();
      notify(t('terminal.mobileSelectionHint'), { variant: 'info' });
    }
    this.syncCopyButton();
  }

  private updateOrientationLabel(): void {
    const button = document.getElementById('mobile-landscape-btn');
    if (!button) return;
    const label = this.isTerminalFullscreen()
      ? t('terminal.exitFullscreen')
      : t('terminal.landscapeMode');
    const text = button.querySelector<HTMLElement>('[data-mobile-landscape-label]');
    if (text) text.textContent = label;
    button.title = label;
  }

  private async requestLandscape(): Promise<void> {
    if (this.isTerminalFullscreen()) {
      try {
        screen.orientation?.unlock?.();
      } catch {
        /* ignore */
      }
      await document.exitFullscreen?.();
      return;
    }

    const fullscreenTarget = document.documentElement;
    if (!fullscreenTarget.requestFullscreen) {
      notify(t('terminal.landscapeUnsupported'), { variant: 'warning' });
      return;
    }

    try {
      await fullscreenTarget.requestFullscreen();
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (orientation: 'landscape') => Promise<void>;
      };
      if (orientation.lock) {
        await orientation.lock('landscape');
      } else {
        notify(t('terminal.rotateManually'), { variant: 'info' });
      }
    } catch {
      if (this.isTerminalFullscreen()) {
        notify(t('terminal.rotateManually'), { variant: 'info' });
      } else {
        notify(t('terminal.landscapeUnsupported'), { variant: 'warning' });
      }
    } finally {
      this.scheduleViewportUpdate();
    }
  }

  leaveTerminal(): void {
    this.activeTerminal?.setMobileSelectionMode(false);
    this.syncCopyButton();
    if (this.isTerminalFullscreen()) {
      try {
        screen.orientation?.unlock?.();
      } catch {
        /* ignore */
      }
      void document.exitFullscreen?.();
    }
    document.documentElement.classList.remove('mobile-keyboard-open');
    this.hideMoreMenu();
  }

  private isTerminalFullscreen(): boolean {
    return document.fullscreenElement === document.documentElement;
  }
}
