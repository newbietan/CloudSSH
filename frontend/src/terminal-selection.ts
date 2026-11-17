import type { IDisposable, Terminal } from '@xterm/xterm';
import { onLocaleChange, t } from './i18n';

interface Cell { column: number; row: number }
type Endpoint = 'start' | 'end';
const HANDLE_SIZE = 44;
const EDGE_PX = 28;
const SCROLL_ROWS_PER_SECOND = 18;

/** Touch-only controls over xterm's authoritative selection. No transcript copy or remote input. */
export class TerminalTouchSelection {
  enabled = false;
  private readonly handles: Record<Endpoint, HTMLButtonElement>;
  private readonly disposables: IDisposable[] = [];
  private readonly unsubscribeLocale: () => void;
  private pointerId: number | null = null;
  private anchor: Cell | null = null;
  private anchorAtStart = true;
  private pointer = { x: 0, y: 0 };
  private offset = { x: 0, y: 0 };
  private scrollFrame: number | null = null;
  private lastTime = 0;
  private scrollRemainder = 0;
  private columns: number;

  constructor(
    private readonly terminal: Terminal,
    private readonly container: HTMLElement,
    private readonly changed: (anchor?: { clientX: number; clientY: number }) => void,
    private readonly invalidated: () => void
  ) {
    this.columns = terminal.cols;
    this.handles = { start: this.createHandle('start'), end: this.createHandle('end') };
    const translate = () => {
      this.handles.start.setAttribute('aria-label', t('terminal.selectionStart'));
      this.handles.end.setAttribute('aria-label', t('terminal.selectionEnd'));
    };
    translate();
    this.unsubscribeLocale = onLocaleChange(translate);
    this.disposables.push(
      terminal.onSelectionChange(() => {
        if (!terminal.hasSelection()) this.finish();
        this.render();
        this.changed();
      }),
      terminal.onScroll(() => this.render()),
      terminal.onRender(() => this.render()),
      terminal.onResize(({ cols }) => {
        this.finish();
        if (this.enabled && cols !== this.columns) {
          this.setEnabled(false);
          this.terminal.clearSelection();
          this.invalidated();
        }
        this.columns = cols;
        this.render();
      }),
      terminal.buffer.onBufferChange(() => {
        this.setEnabled(false);
        this.terminal.clearSelection();
      })
    );
    container.addEventListener('pointerdown', this.down, true);
    container.addEventListener('pointermove', this.pointerMove, true);
    container.addEventListener('contextmenu', this.contextMenu, true);
    window.addEventListener('pointerup', this.up, true);
    window.addEventListener('pointercancel', this.cancel, true);
    window.addEventListener('blur', this.cancel);
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.container.classList.toggle('mobile-selection-mode', enabled);
    if (!enabled) this.finish();
    this.render();
    this.changed();
  }

  private createHandle(endpoint: Endpoint): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `terminal-selection-handle terminal-selection-handle--${endpoint}`;
    button.dataset.endpoint = endpoint;
    button.hidden = true;
    button.addEventListener('keydown', (event) => {
      const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -this.terminal.cols, ArrowDown: this.terminal.cols }[event.key];
      if (delta === undefined || !this.enabled) return;
      const range = this.range();
      if (!range) return;
      event.preventDefault();
      event.stopPropagation();
      this.anchor = endpoint === 'start' ? range.end : range.start;
      this.anchorAtStart = endpoint !== 'start';
      const cell = endpoint === 'start' ? range.start : range.end;
      const index = Math.max(0, Math.min(this.terminal.buffer.active.length * this.terminal.cols - 1,
        cell.row * this.terminal.cols + cell.column + delta));
      this.select(this.normalize({ column: index % this.terminal.cols, row: Math.floor(index / this.terminal.cols) }));
      this.anchor = null;
    });
    this.container.append(button);
    return button;
  }

  private screenRect(): DOMRect | null {
    const rect = this.container.querySelector('.xterm-screen')?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  }

  private normalize(cell: Cell): Cell {
    const line = this.terminal.buffer.active.getLine(cell.row);
    // Wide glyph continuation cells have width=0. Combining marks belong to their base cell.
    if (cell.column > 0 && line?.getCell(cell.column)?.getWidth() === 0) {
      return { ...cell, column: cell.column - 1 };
    }
    return cell;
  }

  private cellAt(x: number, y: number): Cell | null {
    const rect = this.screenRect();
    if (!rect) return null;
    const column = Math.min(this.terminal.cols - 1, Math.max(0, Math.floor((x - rect.left) / rect.width * this.terminal.cols)));
    const row = this.terminal.buffer.active.viewportY + Math.min(this.terminal.rows - 1,
      Math.max(0, Math.floor((y - rect.top) / rect.height * this.terminal.rows)));
    return this.normalize({ column, row });
  }

  private range(): { start: Cell; end: Cell } | null {
    const range = this.terminal.getSelectionPosition();
    if (!range) return null;
    const end = range.end.y * this.terminal.cols + range.end.x - 1;
    return {
      start: this.normalize({ column: range.start.x, row: range.start.y }),
      end: this.normalize({ column: end % this.terminal.cols, row: Math.floor(end / this.terminal.cols) }),
    };
  }

  private readonly down = (event: PointerEvent): void => {
    if (!this.enabled || event.pointerType === 'mouse' || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.pointerId !== null) return;
    const cell = this.cellAt(event.clientX, event.clientY);
    if (!cell) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.terminal-selection-handle') : null;
    let endpoint = target?.dataset.endpoint as Endpoint | undefined;
    if (endpoint) {
      // Hit areas may overlap for a one-character range. Choose the nearest visible knob,
      // not whichever button happens to be last in DOM order.
      const knobDistance = (side: Endpoint) => {
        const handle = this.handles[side];
        if (handle.hidden) return Infinity;
        const bounds = handle.getBoundingClientRect();
        const knobX = Number.parseFloat(handle.style.getPropertyValue('--selection-knob-x'));
        const knobY = Number.parseFloat(handle.style.getPropertyValue('--selection-knob-y'));
        return Math.hypot(event.clientX - bounds.left - knobX, event.clientY - bounds.top - knobY);
      };
      if (knobDistance('start') !== knobDistance('end')) {
        endpoint = knobDistance('start') < knobDistance('end') ? 'start' : 'end';
      }
    }
    const range = this.range();
    this.pointer = { x: event.clientX, y: event.clientY };
    this.offset = { x: 0, y: 0 };
    if (endpoint && range) {
      this.anchor = endpoint === 'start' ? range.end : range.start;
      this.anchorAtStart = endpoint === 'end';
      const movingCell = range[endpoint];
      const rect = this.screenRect()!;
      // Preserve grab offset even when a handle was clamped away from the viewport edge.
      this.offset = {
        x: rect.left + (movingCell.column + 0.5) * rect.width / this.terminal.cols - event.clientX,
        y: rect.top + (movingCell.row - this.terminal.buffer.active.viewportY + 0.5) * rect.height / this.terminal.rows - event.clientY,
      };
    } else {
      this.anchor = cell;
      this.select(cell);
    }
    this.pointerId = event.pointerId;
    try { this.container.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.pointer = { x: event.clientX, y: event.clientY };
    this.update();
    this.scheduleScroll();
  };

  private readonly up = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.pointer = { x: event.clientX, y: event.clientY };
    this.update();
    this.finish();
  };

  private readonly cancel = (): void => { this.finish(); };
  private readonly contextMenu = (event: MouseEvent): void => {
    if (!this.enabled) return;
    // Capture before xterm focuses/selects its tiny helper textarea. Normal paste is untouched.
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private update(): void {
    const range = this.range();
    if (!range) { this.finish(); return; }
    // xterm adjusts the range when incoming output trims scrollback; never retain stale row indices.
    this.anchor = this.anchorAtStart ? range.start : range.end;
    const cell = this.cellAt(this.pointer.x + this.offset.x, this.pointer.y + this.offset.y);
    if (cell) this.select(cell);
  }

  private select(end: Cell): void {
    if (!this.anchor) return;
    const cols = this.terminal.cols;
    const a = this.anchor.row * cols + this.anchor.column;
    const b = end.row * cols + end.column;
    this.anchorAtStart = a <= b;
    const first = a <= b ? this.anchor : end;
    const last = a <= b ? end : this.anchor;
    const width = Math.max(1, this.terminal.buffer.active.getLine(last.row)?.getCell(last.column)?.getWidth() ?? 1);
    this.terminal.select(first.column, first.row, Math.abs(a - b) + width);
    this.render();
    this.changed({ clientX: this.pointer.x, clientY: this.pointer.y });
  }

  private scrollDirection(): number {
    if (this.pointerId === null || this.terminal.buffer.active.type !== 'normal') return 0;
    const rect = this.screenRect();
    if (!rect) return 0;
    const y = this.pointer.y;
    return y < rect.top + EDGE_PX ? -1 : y > rect.bottom - EDGE_PX ? 1 : 0;
  }

  private scheduleScroll(): void {
    if (this.scrollFrame !== null || !this.scrollDirection()) return;
    this.lastTime = performance.now();
    this.scrollFrame = requestAnimationFrame(this.scroll);
  }

  private readonly scroll = (now: number): void => {
    this.scrollFrame = null;
    const direction = this.scrollDirection();
    if (!direction) { this.scrollRemainder = 0; return; }
    this.scrollRemainder += Math.min(50, now - this.lastTime) / 1000 * SCROLL_ROWS_PER_SECOND;
    this.lastTime = now;
    const rows = Math.floor(this.scrollRemainder);
    if (rows > 0) {
      this.scrollRemainder -= rows;
      this.terminal.scrollLines(direction * rows);
      this.update();
    }
    if (this.pointerId !== null) this.scrollFrame = requestAnimationFrame(this.scroll);
  };

  private finish(): void {
    if (this.pointerId !== null && this.container.hasPointerCapture?.(this.pointerId)) {
      this.container.releasePointerCapture(this.pointerId);
    }
    this.pointerId = null;
    this.anchor = null;
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = null;
    this.scrollRemainder = 0;
  }

  private render(): void {
    const range = this.enabled ? this.range() : null;
    if (!range) {
      this.handles.start.hidden = true;
      this.handles.end.hidden = true;
      return;
    }
    const rect = this.screenRect();
    const parent = this.container.getBoundingClientRect();
    for (const endpoint of ['start', 'end'] as const) {
      const handle = this.handles[endpoint];
      const cell = range?.[endpoint];
      const row = cell ? cell.row - this.terminal.buffer.active.viewportY : -1;
      handle.hidden = !cell || !rect || row < 0 || row >= this.terminal.rows;
      if (handle.hidden || !cell || !rect) continue;
      const width = Math.max(1, this.terminal.buffer.active.getLine(cell.row)?.getCell(cell.column)?.getWidth() ?? 1);
      const x = rect.left - parent.left + (cell.column + (endpoint === 'end' ? width : 0)) * rect.width / this.terminal.cols;
      const y = rect.top - parent.top + (row + (endpoint === 'end' ? 1 : 0)) * rect.height / this.terminal.rows;
      const half = HANDLE_SIZE / 2;
      const left = Math.min(Math.max(x - half, 0), Math.max(0, parent.width - HANDLE_SIZE));
      const top = Math.min(Math.max(y - half, 0), Math.max(0, parent.height - HANDLE_SIZE));
      const anchorX = x - left;
      const anchorY = y - top;
      const knobX = Math.min(HANDLE_SIZE - 8, Math.max(8, anchorX));
      const knobY = Math.min(HANDLE_SIZE - 8, Math.max(8, anchorY + (endpoint === 'start' ? -8 : 8)));
      handle.style.left = `${left}px`;
      handle.style.top = `${top}px`;
      // Clamp the hit area and round knob, not the text boundary. A short stem stays on the
      // exact cell edge so first/last-column handles do not visually point at another character.
      handle.style.setProperty('--selection-anchor-x', `${anchorX}px`);
      handle.style.setProperty('--selection-anchor-y', `${anchorY}px`);
      handle.style.setProperty('--selection-knob-x', `${knobX}px`);
      handle.style.setProperty('--selection-knob-y', `${knobY}px`);
      handle.style.setProperty('--selection-stem-length', `${Math.hypot(knobX - anchorX, knobY - anchorY)}px`);
      handle.style.setProperty('--selection-stem-angle', `${Math.atan2(knobY - anchorY, knobX - anchorX)}rad`);
    }
  }

  dispose(): void {
    this.setEnabled(false);
    this.finish();
    this.unsubscribeLocale();
    this.disposables.forEach(disposable => disposable.dispose());
    Object.values(this.handles).forEach(handle => handle.remove());
    this.container.removeEventListener('pointerdown', this.down, true);
    this.container.removeEventListener('pointermove', this.pointerMove, true);
    this.container.removeEventListener('contextmenu', this.contextMenu, true);
    window.removeEventListener('pointerup', this.up, true);
    window.removeEventListener('pointercancel', this.cancel, true);
    window.removeEventListener('blur', this.cancel);
  }
}
