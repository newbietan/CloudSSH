import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { TrzszFilter } from 'trzsz';
import '@xterm/xterm/css/xterm.css';
import { AuthChallengeDialog, type AuthChallengeSubmission } from './auth-challenge-dialog';
import { copyTextToClipboard } from './clipboard';
import { createResumeChallengeParams, hasDeviceBindingSupport } from './device-identity';
import { SHARE_RESUME_RETRY_WINDOW_MS } from '../../src/share-resume-schema';
import { type TranslationKey, t } from './i18n';
import {
  type ChangedHostKeyMessage,
  normalizeChangedHostKeyMessage,
  normalizeVerifiedHostKeyMessage,
  saveKnownFingerprint,
} from './known-hosts';
import {
  applyMobileModifier,
  diffTextareaInput,
  isIOSLike,
  type MobileModifier,
  type MobileTerminalKey,
  mobileTerminalKeySequence,
} from './mobile-input';
import { currentTerminalFontSize } from './terminal-layout';
import { localizedSSHMessage } from './terminal-status';
import { centerTerminalText } from './terminal-text';
import { getActiveTerminalTheme, onTerminalThemeChange } from './theme';
import { confirmAction, notify } from './ui-feedback';

const TRZSZ_MAX_DATA_CHUNK_SIZE = 2 * 1024 * 1024;
const NON_RETRIABLE_AUTH_EVENTS = new Set([
  'auth_failed',
  'auth_interactive_protocol_error',
  'auth_interactive_limit',
  'auth_interactive_client_unavailable',
  'auth_interactive_timeout',
  'auth_interactive_invalid_response',
  'auth_interactive_failed',
  'auth_password_change_required',
  'auth_protocol_error',
]);
const RTT_HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_RESPONSE_TIMEOUT_MS = 10_000;

export interface SSHHostInfo {
  host: string;
  port: number;
  username?: string;
  /** 登录用户保存的服务器 ID，用于断线后重新申请一次性连接令牌。 */
  serverId?: number;
}

export type ReconnectWebSocketFactory = () => Promise<WebSocket>;

export interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  authMethod?: 'password' | 'publickey';
  privateKey?: string;
  expectedFingerprint?: string;
  /** 匿名路径手动覆盖的区域偏好（保存服务器路径不使用此字段） */
  locationHint?: string;
}

export interface TerminalSelectionAnchor {
  clientX: number;
  clientY: number;
}

export type TerminalShortcutAction = 'search' | 'clear';

/**
 * 匹配终端快捷键：
 * - 搜索：Ctrl+Shift+F（通用）或 Cmd+F（macOS）
 * - 清屏/清除滚动缓冲区：Cmd+K（macOS）或 Ctrl+Shift+K（Win/Linux）
 */
export function matchTerminalShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
): TerminalShortcutAction | null {
  const key = e.key.toLowerCase();
  const isSearchShortcut =
    (e.ctrlKey && e.shiftKey && key === 'f') ||
    (e.metaKey && !e.ctrlKey && !e.altKey && key === 'f');
  if (isSearchShortcut) return 'search';

  const isClearShortcut =
    (e.metaKey && !e.ctrlKey && !e.altKey && key === 'k') ||
    (e.ctrlKey && e.shiftKey && key === 'k');
  if (isClearShortcut) return 'clear';

  return null;
}

/** 末次恢复尝试所需的最小窗口余量：预留一次握手往返，避免注定失败的冲刺。 */
const RESUME_FINAL_ATTEMPT_MARGIN_MS = 3000;

interface ConnectOptions {
  resetDisplay?: boolean;
}

interface WebSocketConnectOptions extends ConnectOptions {
  reconnectFactory?: ReconnectWebSocketFactory;
  /** resume-only：仅允许秒级恢复，不回退完整重连（分享会话 ticket 已一次性消费）。 */
  resumeOnly?: boolean;
}

interface TerminalCell {
  column: number;
  row: number;
}

interface MobileScrollGesture {
  pointerId: number;
  startX: number;
  startY: number;
  lastY: number;
  remainder: number;
  active: boolean;
}

const MOBILE_SCROLL_START_THRESHOLD_PX = 10;
const MOBILE_VIEWPORT_QUERY = '(max-width: 767px), (max-width: 1180px) and (pointer: coarse)';
const MOBILE_CONNECTION_RECOVERY_QUERY = '(pointer: coarse)';

function supportsMobileConnectionRecovery(): boolean {
  return (
    navigator.maxTouchPoints > 0 &&
    (window.matchMedia?.(MOBILE_CONNECTION_RECOVERY_QUERY).matches ?? false)
  );
}

export class SSHTerminal {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private webglAddon!: WebglAddon;
  private searchAddon: SearchAddon;
  private ws: WebSocket | null = null;
  private authChallengeDialog: AuthChallengeDialog | null = null;
  private container: HTMLElement;
  private disposables: { dispose(): void }[] = [];
  private terminalDisposables: { dispose(): void }[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private trzszFilter: TrzszFilter | null = null;
  private mounted: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastConfig: SSHConnectionConfig | null = null;
  private lastHostInfo: SSHHostInfo | null = null;
  private reconnectWebSocketFactory: ReconnectWebSocketFactory | null = null;
  private canReconnect: boolean = true;
  private sessionReady: boolean = false;
  private restoreCursorBlinkAfterReturnPrompt: boolean = false;
  private onSessionClosed?: (event: CloseEvent, willReconnect: boolean) => void;
  private onSessionReady?: () => void;
  private onAgentFrameHandler?: (msg: any) => void;
  private onOSDetectedHandler?: (serverId: number, os: string) => void;
  private sftpAttachUrl: string | null = null;
  private searchBox: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchVisible: boolean = false;
  private cfLatency: number | null = null;
  private cfColo: string | null = null;
  private lastPingTime: number | null = null;
  private pendingHeartbeatId: string | null = null;
  private heartbeatResponseTimeout: ReturnType<typeof setTimeout> | null = null;
  private pageHiddenAt: number | null = null;
  private wsLatency: number | null = null;
  private onLatencyUpdated?: (
    cfLatency: number | null,
    cfColo: string | null,
    wsLatency: number | null
  ) => void;
  private onSelectionChanged?: (selection: string, anchor: TerminalSelectionAnchor | null) => void;
  private selectionAnchor: TerminalSelectionAnchor | null = null;
  private selectionPointerActive = false;
  private mobileSelectionMode = false;
  private mobileSelectionPointerId: number | null = null;
  private mobileSelectionStart: TerminalCell | null = null;
  private mobileScrollGesture: MobileScrollGesture | null = null;
  private mobileModifier: MobileModifier | null = null;
  private imeTextarea: HTMLTextAreaElement | null = null;
  private imePendingBaseline: string | null = null;
  private imePendingHandled = false;
  private imeKeyupTimer: ReturnType<typeof setTimeout> | null = null;
  private viewportRestoreFrame: number | null = null;
  private readonly mobileConnectionRecoveryEnabled: boolean;
  private pendingHostKeyChangeSocket: WebSocket | null = null;
  private activeSessionId: string | null = null;
  private activeResumeToken: string | null = null;
  /** 分享会话专用：断线后只走秒级恢复路径，失败则宣告分享结束。 */
  private resumeOnlyMode: boolean = false;
  /** 当前断线周期的分享恢复截止时刻（对齐服务端宽限窗口）；null 表示尚未开始计时。 */
  private shareResumeDeadline: number | null = null;
  /** 恢复时无法生成设备验证材料（隐私模式/站点数据清理）；用于一次性提示。 */
  private shareResumeChallengeMissing = false;
  /** 服务端在 session_created 中声明的设备绑定状态：绑定会话的恢复需挑战签名。 */
  private sessionRequiresDeviceSig = false;
  /** 服务端已因到期等原因终结分享会话：停止无效重试并给出终态提示。 */
  private shareSessionEndedByServer = false;
  /** 分享会话是否具备断线恢复资格（未绑定设备身份的环境为 false）。 */
  private shareResumeSupported = true;
  private readonly contextMenuPasteListener = async (event: MouseEvent): Promise<void> => {
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    event.preventDefault();
    await this.pasteFromClipboard();
  };
  private themeCleanup: () => void;
  private resizeListener: () => void;
  private readonly selectionPointerDownListener = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.selectionPointerActive = true;
    this.selectionAnchor = { clientX: event.clientX, clientY: event.clientY };
    if (this.mobileSelectionMode && event.pointerType !== 'mouse') {
      const cell = this.getTerminalCell(event.clientX, event.clientY);
      if (!cell) {
        this.selectionPointerActive = false;
        return;
      }
      event.preventDefault();
      this.mobileSelectionPointerId = event.pointerId;
      this.mobileSelectionStart = cell;
      try {
        this.container.setPointerCapture?.(event.pointerId);
      } catch {
        /* synthetic events and older browsers may not support capture */
      }
      this.updateMobileSelection(cell);
      return;
    }
    this.beginMobileScroll(event);
  };
  private readonly selectionPointerMoveListener = (event: PointerEvent): void => {
    if (!this.selectionPointerActive) return;
    this.selectionAnchor = { clientX: event.clientX, clientY: event.clientY };
    if (this.mobileSelectionPointerId === event.pointerId && this.mobileSelectionStart) {
      event.preventDefault();
      const cell = this.getTerminalCell(event.clientX, event.clientY);
      if (cell) this.updateMobileSelection(cell);
      return;
    }
    if (this.updateMobileScroll(event)) return;
    if (this.terminal.hasSelection()) {
      this.notifySelectionChanged();
    }
  };
  private readonly selectionPointerUpListener = (event: PointerEvent): void => {
    if (!this.selectionPointerActive) return;
    if (this.mobileSelectionPointerId === event.pointerId && this.mobileSelectionStart) {
      event.preventDefault();
      const cell = this.getTerminalCell(event.clientX, event.clientY);
      if (cell) this.updateMobileSelection(cell);
      this.finishMobileSelectionPointer();
      this.selectionPointerActive = false;
      this.selectionAnchor = { clientX: event.clientX, clientY: event.clientY };
      this.notifySelectionChanged();
      return;
    }
    const handledMobileScroll = this.finishMobileScroll(event.pointerId);
    if (handledMobileScroll) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.selectionPointerActive = false;
    this.selectionAnchor = { clientX: event.clientX, clientY: event.clientY };
    this.notifySelectionChanged();
    const selection = this.terminal.getSelection();
    if (selection && event.pointerType !== 'touch') {
      void this.copySelectionToClipboard(selection);
    }
  };
  private readonly selectionPointerCancelListener = (event: PointerEvent): void => {
    if (this.mobileSelectionPointerId === event.pointerId) {
      this.finishMobileSelectionPointer();
    }
    this.finishMobileScroll(event.pointerId);
    this.selectionPointerActive = false;
  };
  private readonly visibilityChangeListener = (): void => {
    if (document.visibilityState === 'hidden') {
      this.pageHiddenAt = Date.now();
      // 后台页面可能冻结所有定时器。清除旧探测，回到前台后重新验证，
      // 避免一个在后台过期的计时器把仍健康的连接误判为断线。
      this.stopHeartbeat();
      return;
    }
    this.verifyConnectionAfterResume();
  };
  private readonly pageShowListener = (): void => {
    if (document.visibilityState !== 'hidden') this.verifyConnectionAfterResume();
  };
  private readonly onlineListener = (): void => {
    if (document.visibilityState !== 'hidden') this.verifyConnectionAfterResume();
  };

  constructor(containerId: string) {
    this.container = document.getElementById(containerId)!;
    // 桌面浏览器切换标签页也会触发 visibilitychange，但通常不会挂起网络栈。
    // 仅在手机/平板这类以触摸为主的环境监听后台恢复，避免无意义的探测和日志。
    this.mobileConnectionRecoveryEnabled = supportsMobileConnectionRecovery();
    this.resizeListener = () => {
      // visualViewport 的连续变化由 MobileTerminalController 稳定后统一处理，
      // 桌面端和不支持 visualViewport 的浏览器仍保留直接适配。
      const mobileViewportManaged =
        Boolean(window.visualViewport) &&
        (window.matchMedia?.(MOBILE_VIEWPORT_QUERY).matches ?? false);
      if (!mobileViewportManaged) this.fit();
    };

    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: currentTerminalFontSize(),
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      theme: getActiveTerminalTheme(),
      allowProposedApi: true,
      scrollback: 10000,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.searchAddon);
    this.themeCleanup = onTerminalThemeChange((theme) => {
      this.terminal.options.theme = theme;
    });
    this.registerCursorRestoreHandlers();
    this.terminalDisposables.push(
      this.terminal.onSelectionChange(() => {
        this.notifySelectionChanged();
      })
    );
    this.container.addEventListener('pointerdown', this.selectionPointerDownListener, true);
    this.container.addEventListener('pointermove', this.selectionPointerMoveListener, true);
    window.addEventListener('pointerup', this.selectionPointerUpListener, true);
    window.addEventListener('pointercancel', this.selectionPointerCancelListener, true);

    // Terminal shortcuts: Search (Ctrl+Shift+F / Cmd+F) & Clear Buffer (Cmd+K / Ctrl+Shift+K)
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const action = matchTerminalShortcut(e);
      if (action === 'search') {
        if (e.type === 'keydown') {
          e.preventDefault();
          this.toggleSearch();
        }
        return false;
      }
      if (action === 'clear') {
        if (e.type === 'keydown') {
          e.preventDefault();
          this.clearBuffer();
        }
        return false;
      }
      if (e.key === 'Escape' && this.searchVisible) {
        if (e.type === 'keydown') {
          this.hideSearch();
        }
        return false;
      }
      return true;
    });

    window.addEventListener('resize', this.resizeListener);
    if (this.mobileConnectionRecoveryEnabled) {
      document.addEventListener('visibilitychange', this.visibilityChangeListener);
      window.addEventListener('pageshow', this.pageShowListener);
    }
    window.addEventListener('online', this.onlineListener);

    // 右键粘贴（选区已通过鼠标松手自动复制到剪贴板）
    this.container.addEventListener('contextmenu', this.contextMenuPasteListener);

    // Drag-and-drop file upload support (trzsz)
    this.container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    this.container.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.trzszFilter && e.dataTransfer?.items) {
        this.trzszFilter
          .uploadFiles(e.dataTransfer.items)
          .then(() => console.log('[trzsz] Drag-drop upload success'))
          .catch((err: any) => console.error('[trzsz] Drag-drop upload error:', err));
      }
    });
  }

  setSessionClosedHandler(handler: (event: CloseEvent, willReconnect: boolean) => void): void {
    this.onSessionClosed = handler;
  }

  setSessionReadyHandler(handler: () => void): void {
    this.onSessionReady = handler;
  }

  setAgentFrameHandler(handler: (msg: any) => void): void {
    this.onAgentFrameHandler = handler;
  }

  setOSDetectedHandler(handler: (serverId: number, os: string) => void): void {
    this.onOSDetectedHandler = handler;
  }

  sendWebSocketMessage(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /** 通过与物理键盘相同的 trzsz 输入管线发送移动端快捷键。 */
  sendInput(data: string): boolean {
    if (!data || !this.sessionReady || this.ws?.readyState !== WebSocket.OPEN || !this.trzszFilter)
      return false;
    this.processTerminalInput(data);
    this.terminal.focus();
    return true;
  }

  /** 按 xterm 当前 application cursor mode 发送移动端功能键。 */
  sendMobileKey(key: MobileTerminalKey): boolean {
    const data = mobileTerminalKeySequence(
      key,
      this.terminal.modes.applicationCursorKeysMode,
      this.mobileModifier
    );
    this.setMobileModifier(null);
    return this.sendInput(data);
  }

  setMobileModifier(modifier: MobileModifier | null): void {
    this.mobileModifier = modifier;
    this.container.dispatchEvent(
      new CustomEvent('cloudssh:mobile-modifier-change', { bubbles: true })
    );
  }

  getMobileModifier(): MobileModifier | null {
    return this.mobileModifier;
  }

  focus(): void {
    this.terminal.focus();
  }

  blur(): void {
    this.imeTextarea?.blur();
  }

  hasSelection(): boolean {
    return this.terminal.hasSelection();
  }

  isMobileSelectionMode(): boolean {
    return this.mobileSelectionMode;
  }

  setMobileSelectionMode(enabled: boolean): void {
    if (this.mobileSelectionMode === enabled) return;
    this.mobileSelectionMode = enabled;
    this.container.classList.toggle('mobile-selection-mode', enabled);
    if (enabled) {
      this.finishMobileScroll();
    } else {
      this.finishMobileSelectionPointer();
      this.selectionPointerActive = false;
    }
  }

  async copyCurrentSelection(): Promise<boolean> {
    const selection = this.terminal.getSelection();
    if (!selection) {
      notify(t('terminal.noSelection'), { variant: 'info' });
      return false;
    }
    return this.copySelectionToClipboard(selection);
  }

  async pasteFromClipboard(): Promise<boolean> {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !this.sessionReady || this.ws?.readyState !== WebSocket.OPEN) return false;
      // xterm 会统一换行，并且仅在远端显式启用 bracketed paste 时添加控制序列。
      // paste() 还会经过 onData/trzsz 输入管线，与键盘粘贴保持一致。
      this.setMobileModifier(null);
      this.terminal.paste(text);
      return true;
    } catch (err) {
      console.error('Failed to read clipboard', err);
      notify(t('terminal.pasteFailed'), { variant: 'danger' });
      return false;
    }
  }

  /** 将文本填入当前远端终端输入行，不附加回车。 */
  fillInput(text: string): boolean {
    if (!text || /[\r\n]/.test(text)) return false;
    if (!this.sessionReady || this.ws?.readyState !== WebSocket.OPEN || !this.trzszFilter)
      return false;

    this.trzszFilter.processTerminalInput(text);
    this.terminal.focus();
    return true;
  }

  /**
   * 将命令片段插入远端终端。单行复用 fillInput，多行走 xterm paste 管线；run 为 true 时追加回车。
   */
  insertSnippet(command: string, run: boolean): boolean {
    const trimmed = command.trim();
    if (!trimmed) return false;
    if (/[\r\n]/.test(trimmed)) {
      if (!this.sessionReady || this.ws?.readyState !== WebSocket.OPEN) return false;
      this.setMobileModifier(null);
      this.terminal.paste(trimmed);
    } else if (!this.fillInput(trimmed)) {
      return false;
    }
    if (run) return this.sendInput('\r');
    this.terminal.focus();
    return true;
  }

  setLatencyUpdatedHandler(
    handler: (cfLatency: number | null, cfColo: string | null, wsLatency: number | null) => void
  ): void {
    this.onLatencyUpdated = handler;
    if (this.cfLatency !== null || this.cfColo !== null || this.wsLatency !== null) {
      handler(this.cfLatency, this.cfColo, this.wsLatency);
    }
  }

  setSelectionChangeHandler(
    handler: (selection: string, anchor: TerminalSelectionAnchor | null) => void
  ): void {
    this.onSelectionChanged = handler;
    this.notifySelectionChanged();
  }

  clearSelection(): void {
    this.terminal.clearSelection();
    this.selectionAnchor = null;
    this.notifySelectionChanged();
  }

  getSFTPWebSocketUrl(): string | null {
    return this.sftpAttachUrl;
  }

  private notifySelectionChanged(): void {
    const selection = this.terminal.getSelection();
    if (!selection) {
      this.selectionAnchor = null;
    }
    this.onSelectionChanged?.(selection, this.selectionAnchor);
  }

  private getTerminalCell(clientX: number, clientY: number): TerminalCell | null {
    const screen = this.container.querySelector<HTMLElement>('.xterm-screen');
    const columns = this.terminal.cols;
    const rows = this.terminal.rows;
    if (!screen || columns < 1 || rows < 1) return null;

    const rect = screen.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const x = Math.min(Math.max(clientX - rect.left, 0), Math.max(0, rect.width - 0.01));
    const y = Math.min(Math.max(clientY - rect.top, 0), Math.max(0, rect.height - 0.01));
    const column = Math.min(columns - 1, Math.floor((x / rect.width) * columns));
    const viewportRow = Math.min(rows - 1, Math.floor((y / rect.height) * rows));
    return {
      column,
      row: this.terminal.buffer.active.viewportY + viewportRow,
    };
  }

  private updateMobileSelection(end: TerminalCell): void {
    if (!this.mobileSelectionStart) return;
    const columns = this.terminal.cols;
    const startOffset = this.mobileSelectionStart.row * columns + this.mobileSelectionStart.column;
    const endOffset = end.row * columns + end.column;
    const firstOffset = Math.min(startOffset, endOffset);
    const lastOffset = Math.max(startOffset, endOffset);
    this.terminal.select(
      firstOffset % columns,
      Math.floor(firstOffset / columns),
      lastOffset - firstOffset + 1
    );
  }

  private finishMobileSelectionPointer(): void {
    const pointerId = this.mobileSelectionPointerId;
    if (pointerId !== null && this.container.hasPointerCapture?.(pointerId)) {
      this.container.releasePointerCapture?.(pointerId);
    }
    this.mobileSelectionPointerId = null;
    this.mobileSelectionStart = null;
  }

  private beginMobileScroll(event: PointerEvent): void {
    if (event.pointerType === 'mouse' || this.mobileSelectionMode) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.xterm-screen')) return;
    // 备用屏幕和远端鼠标协议由远端应用控制，不能把滑动误当作本地历史滚动。
    if (
      this.terminal.buffer.active.type !== 'normal' ||
      this.terminal.modes.mouseTrackingMode !== 'none'
    )
      return;

    this.mobileScrollGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      remainder: 0,
      active: false,
    };
  }

  private updateMobileScroll(event: PointerEvent): boolean {
    const gesture = this.mobileScrollGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;

    if (!gesture.active) {
      const distanceX = Math.abs(event.clientX - gesture.startX);
      const distanceY = Math.abs(event.clientY - gesture.startY);
      if (distanceY < MOBILE_SCROLL_START_THRESHOLD_PX) return false;
      if (distanceX > distanceY) {
        this.finishMobileScroll(event.pointerId);
        return false;
      }
      gesture.active = true;
      try {
        this.container.setPointerCapture?.(event.pointerId);
      } catch {
        /* synthetic events and older browsers may not support capture */
      }
    }

    event.preventDefault();
    event.stopPropagation();
    const cellHeight = this.getTerminalCellHeight();
    if (cellHeight <= 0) return true;

    gesture.remainder += gesture.lastY - event.clientY;
    gesture.lastY = event.clientY;
    const lines = Math.trunc(gesture.remainder / cellHeight);
    if (lines !== 0) {
      this.terminal.scrollLines(lines);
      gesture.remainder -= lines * cellHeight;
    }
    return true;
  }

  private finishMobileScroll(pointerId?: number): boolean {
    const gesture = this.mobileScrollGesture;
    if (!gesture || (pointerId !== undefined && gesture.pointerId !== pointerId)) return false;
    if (this.container.hasPointerCapture?.(gesture.pointerId)) {
      this.container.releasePointerCapture?.(gesture.pointerId);
    }
    this.mobileScrollGesture = null;
    return gesture.active;
  }

  private getTerminalCellHeight(): number {
    const screen = this.container.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || this.terminal.rows < 1) return 0;
    return screen.getBoundingClientRect().height / this.terminal.rows;
  }

  /** 将选中文字写入剪贴板，并按实际复制结果提供反馈。 */
  private async copySelectionToClipboard(text: string): Promise<boolean> {
    const copied = await copyTextToClipboard(text);
    if (!copied) {
      notify(t('terminal.copyFailed'), { variant: 'danger' });
      return false;
    }
    notify(t('terminal.copySuccess'), { variant: 'success', duration: 1500 });
    return true;
  }

  mount(): void {
    if (this.mounted) {
      this.fit();
      return;
    }

    this.terminal.open(this.container);
    this.mounted = true;
    this.installIOSIMEFallback();

    // Load WebGL addon after terminal is opened
    try {
      this.webglAddon = new WebglAddon();
      this.webglAddon.onContextLoss((e) => {
        console.warn('WebGL context lost', e);
        this.webglAddon.dispose();
      });
      this.terminal.loadAddon(this.webglAddon);
    } catch (e) {
      console.warn('WebGL addon failed to load, falling back to canvas/dom', e);
    }

    this.fit();
  }

  private createSearchBox(): void {
    if (this.searchBox) return;

    const box = document.createElement('div');
    box.className = 'cloudssh-search-box';
    box.style.display = 'none';

    const searchInputEl = document.createElement('input');
    searchInputEl.type = 'text';
    searchInputEl.className = 'cloudssh-search-input';
    searchInputEl.placeholder = t('terminal.searchPlaceholder');
    box.appendChild(searchInputEl);
    box.appendChild(
      this.createSearchButton('cloudssh-search-prev', 'terminal.searchPrevious', 'arrow_upward')
    );
    box.appendChild(
      this.createSearchButton('cloudssh-search-next', 'terminal.searchNext', 'arrow_downward')
    );
    box.appendChild(
      this.createSearchButton('cloudssh-search-close', 'terminal.searchClose', 'close')
    );

    this.container.style.position = 'relative';
    this.container.appendChild(box);
    this.searchBox = box;
    this.searchInput = box.querySelector('.cloudssh-search-input') as HTMLInputElement;

    // Search on input
    this.searchInput.addEventListener('input', () => {
      const term = this.searchInput!.value;
      if (term) {
        this.searchAddon.findNext(term, { incremental: true });
      }
    });

    // Enter = next, Shift+Enter = previous
    this.searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      const term = this.searchInput!.value;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          this.searchAddon.findPrevious(term);
        } else {
          this.searchAddon.findNext(term);
        }
      }
    });

    // Button handlers
    box.querySelector('.cloudssh-search-prev')!.addEventListener('click', () => {
      const term = this.searchInput!.value;
      if (term) this.searchAddon.findPrevious(term);
    });
    box.querySelector('.cloudssh-search-next')!.addEventListener('click', () => {
      const term = this.searchInput!.value;
      if (term) this.searchAddon.findNext(term);
    });
    box.querySelector('.cloudssh-search-close')!.addEventListener('click', () => {
      this.hideSearch();
    });
  }

  private createSearchButton(
    extraClass: string,
    titleKey: TranslationKey,
    icon: string
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = `cloudssh-search-btn ${extraClass}`;
    button.title = t(titleKey);
    const iconSpan = document.createElement('span');
    iconSpan.className = 'material-symbols-outlined';
    iconSpan.style.fontSize = '16px';
    iconSpan.textContent = icon;
    button.appendChild(iconSpan);
    return button;
  }

  private static renderStatusDot(
    target: HTMLElement,
    dotClass: string,
    text: string,
    dotTag: 'div' | 'span' = 'div'
  ): void {
    target.textContent = '';
    const dot = document.createElement(dotTag);
    dot.className = dotClass;
    target.appendChild(dot);
    target.append(` ${text}`);
  }

  toggleSearch(): void {
    if (this.searchVisible) {
      this.hideSearch();
    } else {
      this.showSearch();
    }
  }

  showSearch(): void {
    this.createSearchBox();
    if (!this.searchBox) return;
    this.searchBox.style.display = 'flex';
    this.searchVisible = true;
    this.searchInput?.focus();
    this.searchInput?.select();
  }

  hideSearch(): void {
    if (!this.searchBox) return;
    this.searchBox.style.display = 'none';
    this.searchVisible = false;
    this.terminal.focus();
  }

  /**
   * 清除滚动历史缓冲区（Scrollback Buffer），使当前行为首行。
   */
  clearBuffer(): void {
    this.terminal.clear();
  }

  // ==================== known_hosts (TOFU) ====================

  private async handleVerifiedHostKey(message: unknown): Promise<void> {
    const hostKey = normalizeVerifiedHostKeyMessage(message);
    if (!hostKey) return;
    const requireCloud = Boolean(this.lastHostInfo?.serverId);
    try {
      await saveKnownFingerprint(hostKey.host, hostKey.port, hostKey.fingerprint, requireCloud);
    } catch {
      notify(t('terminal.hostKeySaveFailed'), {
        title: t('terminal.hostKeySaveTitle'),
        variant: 'danger',
      });
    }
  }

  private async handleChangedHostKey(socket: WebSocket, message: unknown): Promise<void> {
    const hostKey = normalizeChangedHostKeyMessage(message);
    if (!hostKey || this.pendingHostKeyChangeSocket) return;

    this.canReconnect = false;
    this.clearReconnectTimeout();
    this.pendingHostKeyChangeSocket = socket;
    try {
      const trusted = await confirmAction({
        title: t('terminal.hostKeyChangeTitle'),
        message: t('terminal.hostKeyChangeMessage', {
          host: hostKey.displayHost,
          port: hostKey.port,
          known: hostKey.expectedFingerprint,
          actual: hostKey.fingerprint,
          keyType: hostKey.keyType,
        }),
        confirmText: t('terminal.hostKeyTrustAndReconnect'),
        cancelText: t('terminal.hostKeyCancel'),
        variant: 'danger',
      });
      if (!trusted || socket !== this.ws) return;

      const requireCloud = Boolean(this.lastHostInfo?.serverId);
      try {
        await saveKnownFingerprint(hostKey.host, hostKey.port, hostKey.fingerprint, requireCloud);
      } catch {
        notify(t('terminal.hostKeyTrustFailed'), {
          title: t('terminal.hostKeyChangeTitle'),
          variant: 'danger',
        });
        return;
      }

      try {
        await this.reconnectAfterHostKeyTrust(hostKey);
      } catch {
        notify(t('terminal.hostKeyReconnectFailed'), {
          title: t('terminal.hostKeyChangeTitle'),
          variant: 'danger',
        });
      }
    } finally {
      if (this.pendingHostKeyChangeSocket === socket) {
        this.pendingHostKeyChangeSocket = null;
      }
    }
  }

  private async reconnectAfterHostKeyTrust(hostKey: ChangedHostKeyMessage): Promise<void> {
    this.reconnectAttempts = 0;
    if (this.lastConfig) {
      const config = { ...this.lastConfig, expectedFingerprint: hostKey.fingerprint };
      this.terminal.writeln(`\x1b[32m[+] ${t('terminal.reconnecting')}\x1b[0m`);
      await this.connect(config, { resetDisplay: false });
      return;
    }

    const reconnectFactory = this.reconnectWebSocketFactory;
    if (reconnectFactory) {
      this.terminal.writeln(`\x1b[32m[+] ${t('terminal.reconnecting')}\x1b[0m`);
      const socket = await reconnectFactory();
      if (
        this.reconnectWebSocketFactory !== reconnectFactory ||
        this.ws !== this.pendingHostKeyChangeSocket
      ) {
        socket.close(1000);
        return;
      }
      this.connectWithWebSocket(socket, this.lastHostInfo ?? undefined, {
        resetDisplay: false,
        reconnectFactory,
      });
      return;
    }

    notify(t('terminal.hostKeyTrustedReconnectManually'), {
      title: t('terminal.hostKeyChangeTitle'),
      variant: 'warning',
    });
  }

  async connect(config: SSHConnectionConfig, options: ConnectOptions = {}): Promise<void> {
    this.resetActiveConnection();
    this.lastConfig = config;
    this.lastHostInfo = null;
    this.reconnectWebSocketFactory = null;
    this.canReconnect = true;
    this.sessionReady = false;
    if (options.resetDisplay !== false) {
      this.showConnectingBanner();
    }

    const termStatus = document.getElementById('term-status');
    if (termStatus)
      SSHTerminal.renderStatusDot(
        termStatus,
        'w-2 h-2 bg-primary-container animate-pulse',
        t('terminal.connecting')
      );

    let wsUrl: URL;
    try {
      wsUrl = new URL(window.location.href);
    } catch {
      throw new Error('Invalid window location');
    }
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.pathname = '/api/ssh';
    // 匿名路径：用户在前端选定 region 后作为 URL query 传给 Worker；
    // Worker 在 get() 前读取并传入 locationHint（仅手动覆盖路径）
    if (config.locationHint) {
      wsUrl.searchParams.set('region', config.locationHint);
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl.toString());
      this.ws = socket;
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        if (socket !== this.ws) return;
        this.terminal.writeln(`\x1b[32m[+] ${t('terminal.wsSendingCredentials')}\x1b[0m`);
        socket.send(
          JSON.stringify({
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            authMethod: config.authMethod,
            privateKey: config.privateKey,
            expectedFingerprint: config.expectedFingerprint,
            ...this.getTerminalSize(),
          })
        );

        this.startHeartbeat();
        resolve();
      };

      this.ws.onerror = () => {
        reject(new Error(t('terminal.wsFailed')));
      };

      this.setupWebSocketHandlers(reject);
    });
  }

  connectWithWebSocket(
    ws: WebSocket,
    hostInfo?: SSHHostInfo,
    options: WebSocketConnectOptions = {}
  ): void {
    this.resetActiveConnection();
    this.lastConfig = null;
    this.lastHostInfo = hostInfo ?? null;
    this.reconnectWebSocketFactory = options.reconnectFactory ?? null;
    this.resumeOnlyMode = options.resumeOnly === true;
    this.shareResumeDeadline = null;
    this.shareResumeChallengeMissing = false;
    this.sessionRequiresDeviceSig = false;
    this.canReconnect = Boolean(this.reconnectWebSocketFactory);
    this.sessionReady = false;
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    if (options.resetDisplay !== false) {
      this.showConnectingBanner();
    }

    const termStatus = document.getElementById('term-status');
    if (termStatus)
      SSHTerminal.renderStatusDot(
        termStatus,
        'w-2 h-2 bg-primary-container animate-pulse',
        t('terminal.connecting')
      );

    const handleOpen = () => {
      if (ws !== this.ws) return;
      this.terminal.writeln(`\x1b[32m[+] ${t('terminal.wsAuthenticating')}\x1b[0m`);
      this.sendResize();
      this.startHeartbeat();
    };
    ws.onopen = handleOpen;
    this.setupWebSocketHandlers();

    if (ws.readyState === WebSocket.OPEN) {
      handleOpen();
    }
  }

  private setupWebSocketHandlers(rejectFn?: (reason?: any) => void): void {
    if (!this.ws) return;
    const socket = this.ws;

    // Trzsz file transfer support
    this.trzszFilter = new TrzszFilter({
      writeToTerminal: (data: string | ArrayBuffer | Uint8Array | Blob) => {
        if (typeof data === 'string') {
          this.terminal.write(data);
        } else if (data instanceof Uint8Array) {
          this.terminal.write(data);
        } else if (data instanceof ArrayBuffer) {
          this.terminal.write(new Uint8Array(data));
        } else if (data instanceof Blob) {
          data.arrayBuffer().then((buf) => this.terminal.write(new Uint8Array(buf)));
        }
      },
      sendToServer: (data: string | Uint8Array) => {
        if (this.sessionReady && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(data);
        }
      },
      terminalColumns: this.terminal.cols,
      maxDataChunkSize: TRZSZ_MAX_DATA_CHUNK_SIZE,
    });

    this.ws.onmessage = (event) => {
      if (socket !== this.ws) return;
      if (typeof event.data === 'string') {
        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          // Only parsing failures are terminal output. Exceptions raised by
          // control-message handlers must never be swallowed as text.
          this.trzszFilter!.processServerOutput(event.data);
          return;
        }

        try {
          if (msg.type === 'auth_challenge') {
            this.handleAuthChallenge(socket, msg);
            return;
          }

          if (msg.type === 'sftp_attach') {
            this.sftpAttachUrl = msg.url || null;
            return;
          }

          if (msg.type === 'session_created') {
            this.activeSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
            this.activeResumeToken = typeof msg.resumeToken === 'string' ? msg.resumeToken : null;
            // 绑定状态由服务端判定；未绑定环境（resumeEnabled=false）不支持断线自动恢复
            this.sessionRequiresDeviceSig = msg.deviceBound === true;
            this.shareResumeSupported = msg.resumeEnabled !== false;
          }

          if (msg.type === 'session_resumed') {
            // 服务端每次成功恢复都会轮换 resume token，旧 token 即刻失效
            if (typeof msg.resumeToken === 'string' && msg.resumeToken) {
              this.activeResumeToken = msg.resumeToken;
            }
            // 断线期间保留的 SFTP attach URL，用于恢复后重建 SFTP 数据通道
            if (typeof msg.sftpAttachUrl === 'string' && msg.sftpAttachUrl) {
              this.sftpAttachUrl = msg.sftpAttachUrl;
            }
            this.sessionReady = true;
            this.reconnectAttempts = 0;
            // 恢复成功：重置恢复窗口倒计时，下次断线获得完整预算
            this.shareResumeDeadline = null;
            this.shareResumeChallengeMissing = false;
            this.terminal.writeln(`\x1b[32m[*] ${t('terminal.sessionResumed')}\x1b[0m`);
            const termStatus = document.getElementById('term-status');
            if (termStatus)
              SSHTerminal.renderStatusDot(
                termStatus,
                'w-2 h-2 bg-[var(--color-primary)]',
                t('terminal.connected')
              );
            this.onSessionReady?.();
            this.startHeartbeat();
            return;
          }

          if (msg.type === 'agent_frame') {
            this.onAgentFrameHandler?.(msg);
            return;
          }

          switch (msg.type) {
            case 'status':
              this.terminal.writeln(
                `\x1b[32m[*] ${localizedSSHMessage(msg.message, msg.event, msg.params)}\x1b[0m`
              );
              if (msg.event === 'auth_success' || msg.message === '认证成功') {
                this.authChallengeDialog?.dismiss();
              }
              if (msg.event === 'shell_ready' || msg.message === 'Shell 已就绪') {
                this.sessionReady = true;
                this.reconnectAttempts = 0;
                this.onSessionReady?.();
              }
              break;
            case 'error':
              if (NON_RETRIABLE_AUTH_EVENTS.has(msg.event)) {
                this.canReconnect = false;
                this.clearReconnectTimeout();
                this.authChallengeDialog?.dismiss();
              }
              if (msg.event === 'share_session_expired') {
                // 服务端已按最长会话时长终结：后续恢复请求必然失败，直接进入终态
                this.shareSessionEndedByServer = true;
              }
              this.terminal.writeln(
                `\x1b[31m[!] ${localizedSSHMessage(msg.message, msg.event, msg.params)}\x1b[0m`
              );
              break;
            case 'debug':
              this.terminal.writeln(`\x1b[90m[DEBUG] ${msg.message}\x1b[0m`);
              break;
            case 'host_key_verified':
              void this.handleVerifiedHostKey(msg);
              break;
            case 'host_key_changed':
              void this.handleChangedHostKey(socket, msg).catch(() => {
                notify(t('terminal.hostKeyTrustFailed'), {
                  title: t('terminal.hostKeyChangeTitle'),
                  variant: 'danger',
                });
              });
              break;
            case 'pong':
              this.handleHeartbeatResponse(msg);
              break;
            case 'rtt':
              this.cfLatency = msg.latency;
              this.cfColo = msg.colo;
              this.onLatencyUpdated?.(this.cfLatency, this.cfColo, this.wsLatency);
              break;
            case 'os_detected':
              this.onOSDetectedHandler?.(msg.serverId, msg.os);
              return;
          }
        } catch (error) {
          console.error('WebSocket control message handling failed', error);
          if (msg?.type === 'auth_challenge') {
            this.rejectAuthChallenge(socket, msg);
          }
        }
      } else {
        this.trzszFilter!.processServerOutput(event.data);
      }
    };

    this.ws.onclose = (event) => {
      if (socket !== this.ws) return;

      this.authChallengeDialog?.dismiss();
      this.stopHeartbeat();
      this.sessionReady = false;
      this.terminal.writeln(
        `\x1b[33m[*] ${t('terminal.connectionClosed', { code: event.code })}\x1b[0m`
      );
      const termStatus = document.getElementById('term-status');
      if (termStatus)
        SSHTerminal.renderStatusDot(
          termStatus,
          'w-2 h-2 bg-[var(--error)]',
          t('terminal.disconnected')
        );
      const statusText = document.getElementById('status-text');
      if (statusText)
        SSHTerminal.renderStatusDot(
          statusText,
          'w-2 h-2 bg-surface-dot inline-block',
          t('auth.statusOffline'),
          'span'
        );

      const willReconnect = event.code !== 1000 && this.hasReconnectStrategy();
      this.onSessionClosed?.(event, willReconnect);
      if (willReconnect) {
        this.scheduleReconnect();
      } else if (this.resumeOnlyMode && event.code !== 1000 && !this.shareResumeSupported) {
        // 无恢复资格（认领环境无法绑定设备身份）：明确告知而非静默掉线
        this.terminal.writeln(`\x1b[31m[!] ${t('terminal.shareResumeUnsupported')}\x1b[0m`);
      } else if (this.resumeOnlyMode && this.shareSessionEndedByServer) {
        // 服务端已终结（到期/撤销）：给出终态而非静默掉线
        this.terminal.writeln(`\x1b[31m[!] ${t('terminal.shareResumeEnded')}\x1b[0m`);
      }
    };

    this.ws.onerror = () => {
      if (socket === this.ws) this.authChallengeDialog?.dismiss();
      this.terminal.writeln(`\x1b[31m[!] ${t('terminal.connectionError')}\x1b[0m`);
      if (rejectFn) rejectFn(new Error(t('terminal.wsFailed')));
    };

    // User input goes through trzsz filter
    this.disposables.push(
      this.terminal.onData((data) => {
        if (this.imePendingBaseline !== null && data) {
          this.imePendingHandled = true;
        }
        this.processTerminalInput(data);
      })
    );

    // Binary input support
    this.disposables.push(
      this.terminal.onBinary((data) => {
        if (this.sessionReady) this.trzszFilter!.processBinaryInput(data);
      })
    );

    // Terminal resize: send to server + update trzsz column count
    this.disposables.push(
      this.terminal.onResize(({ cols, rows }) => {
        this.sendResize({ cols, rows });
        this.trzszFilter?.setTerminalColumns(cols);
      })
    );
  }

  private handleAuthChallenge(socket: WebSocket, payload: unknown): void {
    if (socket !== this.ws) return;

    const challengeTarget =
      typeof payload === 'object' && payload !== null
        ? (payload as { host?: unknown; port?: unknown })
        : {};
    const challengeHost =
      typeof challengeTarget.host === 'string'
        ? challengeTarget.host
        : (this.lastConfig?.host ?? '');
    const challengePort =
      typeof challengeTarget.port === 'number' && Number.isInteger(challengeTarget.port)
        ? challengeTarget.port
        : (this.lastConfig?.port ?? 22);

    this.authChallengeDialog ??= new AuthChallengeDialog();
    const shown = this.authChallengeDialog.show(payload, {
      host: challengeHost,
      port: challengePort,
      onShown: (id: string) => {
        if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: 'auth_challenge_ack', id }));
      },
      onSubmit: (submission: AuthChallengeSubmission) => {
        // The callback belongs to the socket that produced this challenge. A
        // reconnect must never receive a stale password or one-time code.
        if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(submission));
      },
      onCancel: (id: string) => {
        if (socket !== this.ws) return;
        this.canReconnect = false;
        this.clearReconnectTimeout();
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'auth_cancel', id }));
        }
      },
    });

    if (!shown) {
      this.rejectAuthChallenge(socket, payload);
    }
  }

  private rejectAuthChallenge(socket: WebSocket, payload: unknown): void {
    if (socket !== this.ws) return;
    this.canReconnect = false;
    this.clearReconnectTimeout();
    this.authChallengeDialog?.dismiss();
    this.terminal.writeln(`\x1b[31m[!] ${t('authChallenge.invalid')}\x1b[0m`);
    if (socket.readyState !== WebSocket.OPEN) return;

    const id =
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as { id?: unknown }).id === 'string'
        ? (payload as { id: string }).id
        : null;
    if (id) {
      socket.send(JSON.stringify({ type: 'auth_cancel', id }));
    } else {
      socket.close(1000, 'Invalid authentication challenge');
    }
  }

  fit(): boolean {
    const fontSize = currentTerminalFontSize();
    if (this.terminal.options.fontSize !== fontSize) {
      this.terminal.options.fontSize = fontSize;
    }
    if (!this.mounted || this.container.clientWidth === 0 || this.container.clientHeight === 0)
      return false;
    const dimensions = this.fitAddon.proposeDimensions();
    if (
      !dimensions ||
      (dimensions.cols === this.terminal.cols && dimensions.rows === this.terminal.rows)
    )
      return false;

    const buffer = this.terminal.buffer.active;
    const bufferType = buffer.type;
    const wasAtBottom = buffer.viewportY >= buffer.baseY;
    const distanceFromBottom = Math.max(0, buffer.baseY - buffer.viewportY);
    this.fitAddon.fit();
    const restoreViewport = () => {
      const resizedBuffer = this.terminal.buffer.active;
      if (resizedBuffer.type !== bufferType) return;
      if (wasAtBottom) {
        this.terminal.scrollToBottom();
      } else {
        this.terminal.scrollToLine(Math.max(0, resizedBuffer.baseY - distanceFromBottom));
      }
    };
    restoreViewport();
    if (this.viewportRestoreFrame !== null) cancelAnimationFrame(this.viewportRestoreFrame);
    this.viewportRestoreFrame = requestAnimationFrame(() => {
      this.viewportRestoreFrame = null;
      // xterm 的自定义滚动视口会在 resize 后下一帧同步 scrollHeight，
      // 再恢复一次可避免初次恢复被旧的滚动范围截断。
      restoreViewport();
    });
    return true;
  }

  private processTerminalInput(data: string): void {
    if (!this.sessionReady || !this.trzszFilter) return;
    const transformed = applyMobileModifier(data, this.mobileModifier);
    if (transformed.consumed) this.setMobileModifier(null);
    this.trzszFilter.processTerminalInput(transformed.data);
  }

  /**
   * xterm.js 6.0 尚未包含上游 keyCode=229 keyup 修复。这里只在 iOS-like
   * 环境补发 xterm 未观察到的 textarea 差异；若 xterm 已产生 onData 则不重复发送。
   */
  private installIOSIMEFallback(): void {
    if (this.imeTextarea) return;
    const textarea = this.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (!textarea) return;
    this.imeTextarea = textarea;
    textarea.setAttribute('enterkeyhint', 'enter');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.spellcheck = false;
    if (!isIOSLike(navigator)) return;
    textarea.addEventListener('keydown', this.imeKeydownListener, true);
    textarea.addEventListener('keyup', this.imeKeyupListener, true);
    textarea.addEventListener('compositionstart', this.imeCompositionStartListener, true);
  }

  private readonly imeKeydownListener = (event: KeyboardEvent): void => {
    if (event.keyCode !== 229 || !this.imeTextarea) return;
    if (this.imePendingBaseline === null) {
      this.imePendingBaseline = this.imeTextarea.value;
      this.imePendingHandled = false;
    }
  };

  private readonly imeKeyupListener = (_event: KeyboardEvent): void => {
    // iOS 中文输入法只保证 keydown 使用 229；对应 keyup 可能是空格的 32、
    // 标点的 0，或其他实际键码。只要存在待处理的 229 周期就应检查差异。
    if (this.imePendingBaseline === null) return;
    if (this.imeKeyupTimer !== null) clearTimeout(this.imeKeyupTimer);
    // 让 xterm 自己在 keyup 或先前的 0ms fallback 中优先消费输入。
    this.imeKeyupTimer = setTimeout(() => {
      this.imeKeyupTimer = null;
      if (!this.imePendingHandled && this.imeTextarea && this.imePendingBaseline !== null) {
        const diff = diffTextareaInput(this.imePendingBaseline, this.imeTextarea.value);
        if (diff) this.sendInput(diff);
      }
      this.clearIMEPendingInput();
    }, 0);
  };

  private readonly imeCompositionStartListener = (): void => {
    this.clearIMEPendingInput();
  };

  private clearIMEPendingInput(): void {
    if (this.imeKeyupTimer !== null) {
      clearTimeout(this.imeKeyupTimer);
      this.imeKeyupTimer = null;
    }
    this.imePendingBaseline = null;
    this.imePendingHandled = false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (document.visibilityState === 'hidden') return;
    this.sendHeartbeatProbe();
    this.heartbeatInterval = setInterval(
      () => this.sendHeartbeatProbe(),
      RTT_HEARTBEAT_INTERVAL_MS
    );
  }

  private sendHeartbeatProbe(): void {
    const socket = this.ws;
    if (
      document.visibilityState === 'hidden' ||
      socket?.readyState !== WebSocket.OPEN ||
      this.pendingHeartbeatId !== null
    )
      return;

    const id = crypto.randomUUID();
    this.pendingHeartbeatId = id;
    this.lastPingTime = performance.now();
    socket.send(JSON.stringify({ type: 'ping', id }));
    this.heartbeatResponseTimeout = setTimeout(() => {
      if (socket !== this.ws || this.pendingHeartbeatId !== id) return;
      this.pendingHeartbeatId = null;
      this.heartbeatResponseTimeout = null;
      this.lastPingTime = null;
      if (document.visibilityState === 'hidden') return;
      this.recoverUnresponsiveConnection(socket);
    }, HEARTBEAT_RESPONSE_TIMEOUT_MS);
  }

  private handleHeartbeatResponse(message: { id?: unknown }): void {
    if (this.pendingHeartbeatId === null || this.lastPingTime === null) return;
    // 新后端会回传探测 ID；保留对尚未升级后端无 ID pong 的兼容。
    if (typeof message.id === 'string' && message.id !== this.pendingHeartbeatId) return;
    if (this.heartbeatResponseTimeout) {
      clearTimeout(this.heartbeatResponseTimeout);
      this.heartbeatResponseTimeout = null;
    }
    this.pendingHeartbeatId = null;
    this.wsLatency = Math.round(performance.now() - this.lastPingTime);
    this.lastPingTime = null;
    this.onLatencyUpdated?.(this.cfLatency, this.cfColo, this.wsLatency);
  }

  private verifyConnectionAfterResume(): void {
    const returnedFromBackground = this.pageHiddenAt !== null;
    this.pageHiddenAt = null;
    const socket = this.ws;
    if (!socket) return;

    if (socket.readyState === WebSocket.OPEN) {
      if (returnedFromBackground) {
        this.terminal.writeln(`\x1b[33m[*] ${t('terminal.resumeChecking')}\x1b[0m`);
      }
      this.startHeartbeat();
      return;
    }

    if (
      socket.readyState === WebSocket.CLOSED &&
      this.hasReconnectStrategy() &&
      this.reconnectTimeout === null
    ) {
      this.scheduleReconnect();
    }
  }

  private recoverUnresponsiveConnection(socket: WebSocket): void {
    if (socket !== this.ws) return;
    this.terminal.writeln(`\x1b[31m[!] ${t('terminal.resumeStale')}\x1b[0m`);
    const event = new CloseEvent('close', {
      code: 4000,
      reason: 'Heartbeat timeout',
      wasClean: false,
    });
    const willReconnect = this.hasReconnectStrategy();
    this.onSessionClosed?.(event, willReconnect);
    this.resetActiveConnection();
    if (willReconnect) this.scheduleReconnect();
  }

  private getTerminalSize(): { cols: number; rows: number } {
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  private sendResize(size = this.getTerminalSize()): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'resize',
          ...size,
        })
      );
    }
  }

  private registerCursorRestoreHandlers(): void {
    this.terminalDisposables.push(
      this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        if (params[0] === 2004 && this.terminal.buffer.active.type === 'normal') {
          this.restoreCursorBlinkAfterReturnPrompt = true;
        }
        return false;
      })
    );

    this.terminalDisposables.push(
      this.terminal.onWriteParsed(() => {
        if (!this.restoreCursorBlinkAfterReturnPrompt) return;
        this.restoreCursorBlinkAfterReturnPrompt = false;
        this.terminal.options.cursorBlink = true;
      })
    );
  }

  private resetTerminalDisplay(): void {
    this.terminal.reset();
    this.terminal.options.cursorBlink = true;
    this.terminal.write('\x1b[2J\x1b[3J\x1b[H');
  }

  private showConnectingBanner(): void {
    this.resetTerminalDisplay();
    const bannerText = centerTerminalText(t('terminal.bannerConnecting'), 34);
    this.terminal.write(
      '\x1b[1;33m╔══════════════════════════════════╗\x1b[0m\r\n' +
        `\x1b[1;33m║${bannerText}║\x1b[0m\r\n` +
        '\x1b[1;33m╚══════════════════════════════════╝\x1b[0m\r\n\r\n'
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatResponseTimeout) {
      clearTimeout(this.heartbeatResponseTimeout);
      this.heartbeatResponseTimeout = null;
    }
    this.pendingHeartbeatId = null;
    this.lastPingTime = null;
  }

  private disposeConnectionDisposables(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private resetActiveConnection(): void {
    this.authChallengeDialog?.dismiss();
    this.stopHeartbeat();
    this.clearReconnectTimeout();
    this.disposeConnectionDisposables();

    const socket = this.ws;
    this.ws = null;
    this.sftpAttachUrl = null;
    this.trzszFilter = null;
    this.sessionReady = false;

    this.cfLatency = null;
    this.cfColo = null;
    this.wsLatency = null;

    if (
      socket &&
      socket.readyState !== WebSocket.CLOSED &&
      socket.readyState !== WebSocket.CLOSING
    ) {
      socket.close(1000);
    }
  }

  private hasReconnectStrategy(): boolean {
    // 分享恢复模式：以凭据持有 + 宽限窗口预算为准，不受常规次数上限约束——
    // 指数退避需能铺满服务端完整的断线保持期，给用户留出切换网络的时间。
    if (this.resumeOnlyMode) {
      return (
        this.shareResumeSupported &&
        Boolean(this.activeSessionId && this.activeResumeToken) &&
        (this.shareResumeDeadline === null || Date.now() < this.shareResumeDeadline)
      );
    }
    return (
      this.canReconnect &&
      this.reconnectAttempts < this.maxReconnectAttempts &&
      Boolean(
        this.lastConfig ||
          this.reconnectWebSocketFactory ||
          (this.activeSessionId && this.activeResumeToken)
      )
    );
  }

  private async tryResumeSession(): Promise<boolean> {
    if (!this.activeSessionId || !this.activeResumeToken) return false;
    try {
      const params = new URLSearchParams({
        session: this.activeSessionId,
        resume_token: this.activeResumeToken,
        cols: String(this.terminal.cols),
        rows: String(this.terminal.rows),
      });
      // 设备绑定挑战签名：浏览器不支持或密钥不可用时省略；
      // 服务端仅对认领时绑定了公钥的分享会话强制校验。
      const challenge = await createResumeChallengeParams(this.activeSessionId);
      this.shareResumeChallengeMissing = !challenge && hasDeviceBindingSupport();
      if (challenge) {
        params.set('did_nonce', challenge.nonce);
        params.set('did_ts', String(challenge.timestamp));
        params.set('did_sig', challenge.signature);
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/api/ssh?${params.toString()}`
      );
      socket.binaryType = 'arraybuffer';
      this.resetActiveConnection();
      this.ws = socket;
      this.setupWebSocketHandlers();
      return true;
    } catch {
      this.activeSessionId = null;
      this.activeResumeToken = null;
      return false;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimeout();

    this.reconnectAttempts++;

    // 分享会话（resume-only）：ticket 已一次性消费，完整重连不可能也不被允许，
    // 仅允许秒级恢复，有限重试后宣告分享结束。
    if (this.resumeOnlyMode) {
      this.scheduleShareResume();
      return;
    }

    // 首次重连时，如果持有断线保持凭据，优先进行 1-RTT 毫秒级无缝恢复；
    // 恢复失败（含服务端拒绝）回退到常规指数退避完整重连。
    if (this.reconnectAttempts === 1 && this.activeSessionId && this.activeResumeToken) {
      this.terminal.writeln(`\x1b[32m[+] ${t('terminal.reconnecting')}\x1b[0m`);
      void this.tryResumeSession().then((resumed) => {
        if (!resumed) this.scheduleFallbackReconnect();
      });
      return;
    }

    this.scheduleFallbackReconnect();
  }

  /** 分享会话的短间隔秒级恢复循环；超出尝试上限后输出终态并停止。 */
  private scheduleShareResume(): void {
    // 服务端已终结会话（如达到最长会话时长）：不再空转重试
    if (this.shareSessionEndedByServer) {
      this.finishShareResume();
      return;
    }
    if (!this.hasReconnectStrategy()) {
      this.finishShareResume();
      return;
    }
    // 首次进入本断线周期时启动宽限窗口倒计时（对齐服务端 SESSION_GRACE_PERIOD_MS）
    if (this.shareResumeDeadline === null) {
      this.shareResumeDeadline = Date.now() + SHARE_RESUME_RETRY_WINDOW_MS;
    }
    const remainingMs = this.shareResumeDeadline - Date.now();
    if (remainingMs <= RESUME_FINAL_ATTEMPT_MARGIN_MS) {
      // 剩余不足以完成一次有意义的握手往返：直接进入终态，避免注定
      // 撞上服务端过期的末次冲刺（此前会在窗口边缘发出必败请求）
      this.finishShareResume();
      return;
    }
    // 首次重试时提示设备验证材料缺失（服务端将拒绝无签名的恢复请求）
    if (
      this.reconnectAttempts === 1 &&
      this.sessionRequiresDeviceSig &&
      this.shareResumeChallengeMissing
    ) {
      this.terminal.writeln(`\x1b[33m[!] ${t('terminal.shareResumeNoDeviceIdentity')}\x1b[0m`);
    }
    // 第二次重试仍失败且验证材料正常：大概率是浏览器环境与认领时不一致
    // （无痕模式重开、清除站点数据、更换浏览器/设备），给出友善原因提示
    if (
      this.reconnectAttempts === 2 &&
      this.sessionRequiresDeviceSig &&
      !this.shareResumeChallengeMissing
    ) {
      this.terminal.writeln(`\x1b[33m[!] ${t('terminal.shareResumeEnvironmentHint')}\x1b[0m`);
    }
    // 与常规重连一致的指数退避（首次 1s 起）；被窗口剩余时间截断时即为
    // 末次尝试：实际等待缩短、明确告知用户，保证最后一次请求在服务端
    // 保持期耗尽前发出
    const backoffDelay = Math.min(1000 * 2 ** Math.max(0, this.reconnectAttempts - 1), 30000);
    const isFinalAttempt = backoffDelay > remainingMs;
    const delay = Math.min(backoffDelay, remainingMs);
    const delaySeconds = Math.max(1, Math.round(delay / 1000));
    if (isFinalAttempt) {
      this.terminal.writeln(`\x1b[33m[*] ${t('terminal.shareResumeFinalAttempt')}\x1b[0m`);
    }
    this.terminal.writeln(
      `\x1b[33m[*] ${t('terminal.resumingSession', { seconds: delaySeconds, attempt: this.reconnectAttempts })}\x1b[0m`
    );

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      void this.tryResumeSession().then((resumed) => {
        // 构造失败立即终态；构造成功后的失败由 onclose 驱动下一轮恢复
        if (!resumed) this.finishShareResume();
      });
    }, delay);
  }

  /** 分享会话恢复彻底失败：清理凭据并输出终态提示。 */
  private finishShareResume(): void {
    this.resumeOnlyMode = false;
    this.shareResumeDeadline = null;
    this.shareResumeChallengeMissing = false;
    this.sessionRequiresDeviceSig = false;
    this.activeSessionId = null;
    this.activeResumeToken = null;
    this.terminal.writeln(`\x1b[31m[!] ${t('terminal.shareResumeEnded')}\x1b[0m`);
  }

  /** 常规指数退避重连：完整重建连接（lastConfig 或 factory）。 */
  private scheduleFallbackReconnect(): void {
    this.clearReconnectTimeout();

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);

    this.terminal.writeln(
      `\x1b[33m[*] ${t('terminal.reconnectWait', { seconds: delay / 1000, attempt: this.reconnectAttempts, max: this.maxReconnectAttempts })}\x1b[0m`
    );

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      if (this.lastConfig) {
        this.terminal.writeln(`\x1b[32m[+] ${t('terminal.reconnecting')}\x1b[0m`);
        try {
          await this.connect(this.lastConfig, { resetDisplay: false });
        } catch {
          this.terminal.writeln(`\x1b[31m[!] ${t('terminal.reconnectFailed')}\x1b[0m`);
        }
      } else if (this.reconnectWebSocketFactory) {
        this.terminal.writeln(`\x1b[32m[+] ${t('terminal.reconnecting')}\x1b[0m`);
        const reconnectFactory = this.reconnectWebSocketFactory;
        try {
          const socket = await reconnectFactory();
          // 用户可能在令牌请求期间主动关闭标签或发起另一条连接。
          // 这时丢弃迟到的 socket，避免页面被已经取消的重连重新拉起。
          if (
            this.reconnectWebSocketFactory !== reconnectFactory ||
            !this.canReconnect ||
            this.reconnectAttempts >= this.maxReconnectAttempts
          ) {
            socket.close(1000);
            return;
          }
          this.connectWithWebSocket(socket, this.lastHostInfo ?? undefined, {
            resetDisplay: false,
            reconnectFactory,
          });
        } catch {
          this.terminal.writeln(`\x1b[31m[!] ${t('terminal.reconnectFailed')}\x1b[0m`);
          if (this.hasReconnectStrategy()) this.scheduleReconnect();
        }
      }
    }, delay);
  }

  disconnect(): void {
    this.reconnectAttempts = this.maxReconnectAttempts;
    this.setMobileSelectionMode(false);
    this.resetActiveConnection();
    this.lastConfig = null;
    this.lastHostInfo = null;
    this.reconnectWebSocketFactory = null;
    this.resumeOnlyMode = false;
    this.shareResumeDeadline = null;
    this.shareResumeChallengeMissing = false;
    this.sessionRequiresDeviceSig = false;
    this.activeSessionId = null;
    this.activeResumeToken = null;
    this.resetTerminalDisplay();
  }

  dispose(): void {
    this.disconnect();
    this.authChallengeDialog?.destroy();
    this.authChallengeDialog = null;
    window.removeEventListener('resize', this.resizeListener);
    if (this.mobileConnectionRecoveryEnabled) {
      document.removeEventListener('visibilitychange', this.visibilityChangeListener);
      window.removeEventListener('pageshow', this.pageShowListener);
    }
    window.removeEventListener('online', this.onlineListener);
    this.container.removeEventListener('pointerdown', this.selectionPointerDownListener, true);
    this.container.removeEventListener('pointermove', this.selectionPointerMoveListener, true);
    window.removeEventListener('pointerup', this.selectionPointerUpListener, true);
    window.removeEventListener('pointercancel', this.selectionPointerCancelListener, true);
    this.container.removeEventListener('contextmenu', this.contextMenuPasteListener);
    this.imeTextarea?.removeEventListener('keydown', this.imeKeydownListener, true);
    this.imeTextarea?.removeEventListener('keyup', this.imeKeyupListener, true);
    this.imeTextarea?.removeEventListener(
      'compositionstart',
      this.imeCompositionStartListener,
      true
    );
    this.clearIMEPendingInput();
    if (this.viewportRestoreFrame !== null) cancelAnimationFrame(this.viewportRestoreFrame);
    this.viewportRestoreFrame = null;
    this.imeTextarea = null;
    this.themeCleanup();
    for (const d of this.terminalDisposables) d.dispose();
    this.terminalDisposables = [];
    this.terminal.dispose();
  }

  exportToFile(filename?: string): void {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    const text = lines.join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    let actualFilename = filename;
    if (!actualFilename) {
      const host = this.lastConfig?.host || 'terminal';
      const port = this.lastConfig?.port || '';
      const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
      actualFilename = `${host}_${port}_${dateStr}.txt`;
    }

    a.download = actualFilename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
