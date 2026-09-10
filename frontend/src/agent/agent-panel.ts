// Agent panel UI — right sidebar for AI Agent interaction

import DOMPurify from 'dompurify';
import { marked, type Tokens } from 'marked';
import {
  formatTimestampWithRelative,
  isSensitiveKeyOrValue,
  normalizeKnowledgeInput,
  type ServerKnowledgeItem,
  type UnifiedServerMemory,
} from '../../../src/server-memory-schema';
import { copyTextToClipboard } from '../clipboard';
import { getLocale, onLocaleChange, t, translateDocument } from '../i18n';
import { confirmAction, notify } from '../ui-feedback';
import { getTerminalFillCommand, normalizeCodeLanguage } from './code-actions';
import {
  buildTerminalSelectionMessage,
  createTerminalSelectionContext,
  type TerminalSelectionContext,
} from './terminal-selection-context';

interface TerminalFillTarget {
  label: string;
  available: boolean;
}

// Configure marked once at module load: GFM enabled, custom renderer for theme-aware styling
marked.use({
  gfm: true,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const language = normalizeCodeLanguage(lang);
      const safeLang = language
        ? `<span class="agent-md-lang">${escapeHtml(language)}</span>`
        : '<span class="agent-md-lang" aria-hidden="true"></span>';
      return `<div class="agent-md-code-block" data-code-language="${escapeHtml(language)}">
        <div class="agent-md-code-toolbar">
          ${safeLang}
          <div class="agent-md-code-meta"></div>
          <div class="agent-md-code-actions"></div>
        </div>
        <pre class="agent-md-pre"><code>${escapeHtml(text)}</code></pre>
      </div>`;
    },
    codespan({ text }: Tokens.Codespan) {
      return `<code class="agent-md-inline-code">${escapeHtml(text)}</code>`;
    },
    link({ href, title, text }: Tokens.Link) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noopener noreferrer" class="agent-md-link">${text}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(href)}"${titleAttr} alt="${escapeHtml(text)}" class="agent-md-img" loading="lazy">`;
    },
  },
});

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 30 分钟断点续接窗口（与服务端 CONSECUTIVE_TASK_WINDOW_MS 连续任务合并窗口严格对齐） */
const SESSION_DRAFT_TTL_MS = 30 * 60 * 1000;

export class AgentPanel {
  private panelEl: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private contextEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLElement | null = null;
  private isVisible: boolean = false;
  private isAgentRunning: boolean = false;
  private isWaitingConfirmation: boolean = false;
  private wsSend: ((data: string) => void) | null = null;
  private getTerminalFillTarget: (() => TerminalFillTarget) | null = null;
  private fillTerminalInput: ((command: string) => boolean) | null = null;
  private onLayoutChange?: () => void;
  private streamingEl: HTMLElement | null = null;
  private streamingText: string = '';
  private thinkingProcessEl: HTMLElement | null = null;
  private thinkingStepsEl: HTMLElement | null = null;
  private thinkingCurrentEl: HTMLElement | null = null;
  private thinkingStatusEl: HTMLElement | null = null;
  private thinkingIsDone: boolean = false;
  private thinkingStepCount: number = 0;
  private thinkingLiveEl: HTMLElement | null = null;
  private thinkingAllSteps: Array<{ tool: string; label: string }> = [];
  private livePreviewCache: string[] = [];
  private localeCleanup: (() => void) | null = null;
  private pendingTerminalSelection: TerminalSelectionContext | null = null;
  private pendingConfirmation: {
    command: string;
    element: HTMLElement;
    previousFocus: HTMLElement | null;
  } | null = null;

  // Unified Server Memory state (Work Logs & Knowledge)
  private isMemoryDrawerOpen: boolean = false;
  private activeMemoryTab: 'workLog' | 'knowledge' = 'workLog';
  private unifiedMemory: UnifiedServerMemory = { workLogs: [], knowledge: [] };
  private isBatchMode: boolean = false;
  private selectedKnowledgeIds: Set<number> = new Set();
  private collapsedDateGroups: Set<string> = new Set(['older']);
  private memoryDrawerEl: HTMLElement | null = null;
  private memoryTabWorkLogBtn: HTMLElement | null = null;
  private memoryTabKnowledgeBtn: HTMLElement | null = null;
  private memoryContentEl: HTMLElement | null = null;
  private memoryCountEl: HTMLElement | null = null;
  private memoryAddBtn: HTMLElement | null = null;
  private memoryAddFormContainerEl: HTMLElement | null = null;
  private memoryBatchBtn: HTMLElement | null = null;
  private memoryBatchBarEl: HTMLElement | null = null;
  private memorySelectedCountEl: HTMLElement | null = null;
  private memoryBatchCancelBtn: HTMLButtonElement | null = null;
  private memoryBatchDeleteBtn: HTMLButtonElement | null = null;
  private revealedSecretIds: Set<number> = new Set();
  private sessionMessages: Array<{
    role: string;
    content: string;
    hasTerminalSelection?: boolean;
  }> = [];

  constructor(
    private parentEl: HTMLElement,
    private isLoggedIn: boolean,
    private serverId?: number
  ) {}

  setServerId(serverId?: number): void {
    const prevServerId = this.serverId;
    this.serverId = serverId;
    this.revealedSecretIds.clear();
    this.exitBatchMode();
    if (prevServerId !== serverId) {
      this.loadSessionDraft();
    }
    if (this.isMemoryDrawerOpen) {
      void this.fetchServerMemory();
    } else if (this.isVisible && this.serverId) {
      void this.fetchServerMemory();
    }
  }

  setLayoutChangeHandler(handler: () => void): void {
    this.onLayoutChange = handler;
  }

  setWebSocketSend(fn: (data: string) => void): void {
    this.wsSend = fn;
  }

  setTerminalFillHandler(
    getTarget: () => TerminalFillTarget,
    fillInput: (command: string) => boolean
  ): void {
    this.getTerminalFillTarget = getTarget;
    this.fillTerminalInput = fillInput;
  }

  render(): void {
    if (this.panelEl) return;

    this.panelEl = document.createElement('div');
    this.panelEl.id = 'agent-panel';
    this.panelEl.className =
      'shrink-0 border-l border-[var(--border)] flex flex-col bg-[var(--bg)] overflow-hidden h-full relative';
    this.panelEl.style.width = 'min(clamp(420px, 40vw, 600px), 100%)';
    this.panelEl.style.display = 'none';

    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    this.panelEl.innerHTML = `
      <div class="agent-panel-header flex items-center justify-between px-4 h-12 border-b border-[var(--border)] bg-[var(--bg-elevated)] shrink-0">
        <div class="flex items-center gap-2 min-w-0">
          <span class="material-symbols-outlined text-[var(--accent-secondary)]" style="font-size: 18px; font-variation-settings: 'FILL' 1;">smart_toy</span>
          <span class="text-xs font-bold tracking-[0.1em] text-[var(--accent-secondary)] truncate" data-i18n="agent.title">AI Agent 助手</span>
        </div>
        <div class="flex items-center gap-1">
          <button id="agent-memory-btn" class="agent-header-btn text-muted hover:text-primary transition-colors cursor-pointer p-1 rounded hover:bg-[var(--bg-hover)] flex items-center justify-center" data-i18n-title="agent.memoryTitle" title="工作备忘与记忆" aria-label="工作备忘与记忆">
            <span class="material-symbols-outlined" style="font-size:18px;" aria-hidden="true">history_edu</span>
          </button>
          <button id="agent-close-btn" class="agent-close-button text-muted hover:text-primary transition-colors cursor-pointer p-1" data-i18n-title="agent.backToTerminal" data-i18n-aria-label="agent.backToTerminal" title="返回终端" aria-label="返回终端">
            <span class="agent-mobile-back material-symbols-outlined" style="font-size:18px;" aria-hidden="true">arrow_back</span>
            <span class="agent-mobile-back agent-back-label" data-i18n="agent.backToTerminal">返回终端</span>
            <span class="agent-desktop-close material-symbols-outlined" style="font-size:18px;" aria-hidden="true">close</span>
          </button>
        </div>
      </div>
      <div id="agent-memory-drawer" class="agent-memory-drawer hidden flex flex-col bg-[var(--bg)] absolute inset-x-0 top-12 bottom-0 z-20 overflow-hidden">
        <div class="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-elevated)] shrink-0">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="material-symbols-outlined text-[var(--accent-secondary)]" style="font-size: 16px;">history_edu</span>
            <span class="text-xs font-bold text-primary truncate" data-i18n="agent.memoryHeader">工作备忘与记忆</span>
            <span id="agent-memory-count" class="text-[11px] text-muted font-code shrink-0"></span>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button id="agent-memory-batch-btn" type="button" class="hidden text-[11px] px-2 py-0.5 rounded border border-outline-variant/60 text-muted hover:text-primary hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-1 cursor-pointer">
              <span class="material-symbols-outlined text-[13px]">checklist</span>
              <span id="agent-memory-batch-btn-text" data-i18n="agent.batchManage">批量管理</span>
            </button>
            <button id="agent-memory-add-btn" type="button" class="hidden text-[11px] px-2 py-0.5 rounded border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors flex items-center gap-1 cursor-pointer">
              <span class="material-symbols-outlined text-[13px]">add</span>
              <span data-i18n="agent.addKnowledge">添加备忘</span>
            </button>
            <button id="agent-memory-close-btn" type="button" class="text-muted hover:text-primary p-1 cursor-pointer" data-i18n-title="agent.close" title="关闭">
              <span class="material-symbols-outlined text-[16px]">close</span>
            </button>
          </div>
        </div>
        <div class="flex border-b border-[var(--border)] bg-[var(--bg-elevated)]/50 shrink-0 text-xs">
          <button id="agent-tab-work-log" type="button" class="flex-1 py-1.5 text-center font-medium border-b-2 border-[var(--accent)] text-[var(--accent)] transition-colors cursor-pointer" data-i18n="agent.tabWorkLog">工作历程</button>
          <button id="agent-tab-knowledge" type="button" class="flex-1 py-1.5 text-center font-medium border-b-2 border-transparent text-muted hover:text-primary transition-colors cursor-pointer" data-i18n="agent.tabKnowledge">知识与凭据</button>
        </div>
        <div id="agent-memory-add-form" class="hidden p-3 border-b border-[var(--border)] bg-[var(--bg-elevated)] shrink-0"></div>
        <div id="agent-memory-content" class="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar text-[12px]"></div>
        <div id="agent-memory-batch-bar" class="hidden flex items-center justify-between px-3 py-1.5 bg-[var(--bg-elevated)] border-t border-[var(--border)] text-xs shrink-0">
          <div class="flex items-center gap-2">
            <span id="agent-memory-selected-count" class="text-primary font-medium text-[11px]">已选择 0 项</span>
          </div>
          <div class="flex items-center gap-1.5">
            <button id="agent-memory-batch-cancel" type="button" class="px-2 py-0.5 rounded text-muted hover:text-primary hover:bg-[var(--bg-hover)] cursor-pointer text-[11px]" data-i18n="agent.batchCancel">退出管理</button>
            <button id="agent-memory-batch-delete" type="button" class="px-2.5 py-0.5 rounded bg-error/15 text-error hover:bg-error/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium flex items-center gap-1 cursor-pointer text-[11px]" disabled>
              <span class="material-symbols-outlined text-[13px]">delete</span>
              <span data-i18n="agent.batchDelete">批量删除</span>
            </button>
          </div>
        </div>
      </div>
      <div id="agent-messages" class="flex-1 overflow-y-auto px-4 py-3 space-y-3 custom-scrollbar text-[13px]"></div>
      <div class="agent-panel-composer px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-elevated)]">
        <div id="agent-quick-chips" class="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-2 select-none">
          <button type="button" class="agent-quick-chip shrink-0 text-[11px] px-2 py-0.5 rounded border border-outline-variant/60 hover:border-[var(--accent)] text-muted hover:text-primary transition-colors cursor-pointer flex items-center gap-1 bg-[var(--bg)]" data-prompt-key="promptError">
            <span class="material-symbols-outlined text-[13px] text-error">error_outline</span>
            <span data-i18n="agent.chipError">分析报错</span>
          </button>
          <button type="button" class="agent-quick-chip shrink-0 text-[11px] px-2 py-0.5 rounded border border-outline-variant/60 hover:border-[var(--accent)] text-muted hover:text-primary transition-colors cursor-pointer flex items-center gap-1 bg-[var(--bg)]" data-prompt-key="promptSystem">
            <span class="material-symbols-outlined text-[13px] text-primary">monitoring</span>
            <span data-i18n="agent.chipSystem">系统负载</span>
          </button>
          <button type="button" class="agent-quick-chip shrink-0 text-[11px] px-2 py-0.5 rounded border border-outline-variant/60 hover:border-[var(--accent)] text-muted hover:text-primary transition-colors cursor-pointer flex items-center gap-1 bg-[var(--bg)]" data-prompt-key="promptNetwork">
            <span class="material-symbols-outlined text-[13px] text-secondary">lan</span>
            <span data-i18n="agent.chipNetwork">端口网络</span>
          </button>
          <button type="button" class="agent-quick-chip shrink-0 text-[11px] px-2 py-0.5 rounded border border-outline-variant/60 hover:border-[var(--accent)] text-muted hover:text-primary transition-colors cursor-pointer flex items-center gap-1 bg-[var(--bg)]" data-prompt-key="promptDocker">
            <span class="material-symbols-outlined text-[13px]">deployed_code</span>
            <span data-i18n="agent.chipDocker">Docker 状态</span>
          </button>
        </div>
        <div id="agent-context" class="agent-context-container hidden"></div>
        <div class="flex gap-2.5 items-end">
          <textarea id="agent-input" data-i18n-placeholder="agent.placeholder" placeholder="描述你希望 Agent 完成的任务…"
            rows="1"
            class="terminal-input flex-1 text-[13px] resize-none overflow-y-auto"
            style="max-height: 140px; line-height: 1.5; padding: 8px 12px; border-radius: 8px;"
            autocomplete="off"></textarea>
          <button id="agent-send-btn" class="agent-send-btn shrink-0" data-i18n-title="agent.send" title="发送">
            <span class="material-symbols-outlined" style="font-size:20px;">arrow_upward</span>
          </button>
        </div>
      </div>
    `;
    translateDocument(this.panelEl);
    this.localeCleanup = onLocaleChange(() => {
      this.updateInputState();
      this.renderTerminalSelectionContext();
      this.refreshCodeBlockActions();
      if (this.isMemoryDrawerOpen) {
        this.renderMemoryContent();
      }
    });

    this.parentEl.appendChild(this.panelEl);
    this.messagesEl = this.panelEl.querySelector('#agent-messages');
    this.contextEl = this.panelEl.querySelector('#agent-context');
    this.inputEl = this.panelEl.querySelector('#agent-input') as HTMLTextAreaElement;
    this.sendBtn = this.panelEl.querySelector('#agent-send-btn');
    this.memoryDrawerEl = this.panelEl.querySelector('#agent-memory-drawer');
    this.memoryTabWorkLogBtn = this.panelEl.querySelector('#agent-tab-work-log');
    this.memoryTabKnowledgeBtn = this.panelEl.querySelector('#agent-tab-knowledge');
    this.memoryContentEl = this.panelEl.querySelector('#agent-memory-content');
    this.memoryCountEl = this.panelEl.querySelector('#agent-memory-count');
    this.memoryAddBtn = this.panelEl.querySelector('#agent-memory-add-btn');
    this.memoryAddFormContainerEl = this.panelEl.querySelector('#agent-memory-add-form');
    this.memoryBatchBtn = this.panelEl.querySelector('#agent-memory-batch-btn');
    this.memoryBatchBarEl = this.panelEl.querySelector('#agent-memory-batch-bar');
    this.memorySelectedCountEl = this.panelEl.querySelector('#agent-memory-selected-count');
    this.memoryBatchCancelBtn = this.panelEl.querySelector('#agent-memory-batch-cancel');
    this.memoryBatchDeleteBtn = this.panelEl.querySelector('#agent-memory-batch-delete');
    this.bindEvents();
    this.updateInputState();
    if (this.serverId) {
      this.loadSessionDraft();
    }
  }

  private bindEvents(): void {
    this.panelEl?.querySelector('#agent-close-btn')?.addEventListener('click', () => this.hide());
    this.panelEl?.querySelector('#agent-memory-btn')?.addEventListener('click', () => this.toggleMemoryDrawer());
    this.panelEl?.querySelector('#agent-memory-close-btn')?.addEventListener('click', () => this.closeMemoryDrawer());
    this.memoryTabWorkLogBtn?.addEventListener('click', () => this.switchMemoryTab('workLog'));
    this.memoryTabKnowledgeBtn?.addEventListener('click', () => this.switchMemoryTab('knowledge'));
    this.memoryAddBtn?.addEventListener('click', () => this.toggleAddKnowledgeForm());
    this.memoryBatchBtn?.addEventListener('click', () => this.toggleBatchMode());
    this.memoryBatchCancelBtn?.addEventListener('click', () => this.exitBatchMode());
    this.memoryBatchDeleteBtn?.addEventListener('click', () => void this.handleBatchDelete());

    this.panelEl?.querySelectorAll('.agent-quick-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = (btn as HTMLElement).dataset.promptKey;
        if (!key || !this.inputEl) return;
        const promptText = t(`agent.${key}` as any);
        this.inputEl.value = promptText;
        this.inputEl.focus();
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 140)}px`;
        this.updateInputState();
      });
    });

    this.sendBtn?.addEventListener('click', () => this.handleSend());

    this.inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    this.panelEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.isMemoryDrawerOpen) {
          this.closeMemoryDrawer();
          return;
        }
        this.hide();
      }
    });

    this.inputEl?.addEventListener('input', () => {
      const el = this.inputEl!;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 140) + 'px';
      this.updateInputState();
    });
  }

  get isOpen(): boolean {
    return this.isVisible;
  }

  toggle(): void {
    this.isVisible ? this.hide() : this.show();
  }

  show(): void {
    if (!this.isLoggedIn) return;
    this.isVisible = true;
    if (this.panelEl) this.panelEl.style.display = 'flex';
    document.body.classList.add('agent-panel-open');
    this.inputEl?.focus();
    if (this.serverId) void this.fetchServerMemory();
    // 触发终端重新适配（面板展开后终端区域缩小，需要 refit）
    requestAnimationFrame(() => this.onLayoutChange?.());
  }

  hide(): void {
    this.rejectPendingConfirmation(false);
    this.isVisible = false;
    if (this.panelEl) this.panelEl.style.display = 'none';
    document.body.classList.remove('agent-panel-open');
    // 触发终端重新适配（面板收起后终端区域恢复，需要 refit）
    requestAnimationFrame(() => this.onLayoutChange?.());
  }

  /** 离开当前会话上下文时，安全地拒绝仍在等待的危险操作。 */
  rejectPendingConfirmation(restoreFocus = true): void {
    this.resolvePendingConfirmation(false, restoreFocus);
  }

  /**
   * 将终端选区作为待发送上下文附加到输入区。每个面板只保留最新一条选区快照。
   */
  attachTerminalSelection(content: string, sourceLabel: string): boolean {
    const context = createTerminalSelectionContext(content, sourceLabel);
    if (!context) return false;

    this.pendingTerminalSelection = context;
    this.renderTerminalSelectionContext();
    this.show();
    this.inputEl?.focus();
    return true;
  }

  clearTerminalSelectionContext(): void {
    this.pendingTerminalSelection = null;
    this.renderTerminalSelectionContext();
  }

  handleAgentFrame(msg: any): void {
    switch (msg.subType) {
      case 'thinking':
        this.showThinking(msg.iteration);
        break;
      case 'executing':
        this.showExecuting(msg.tool, msg.args);
        break;
      case 'stream_chunk':
        this.handleStreamChunk(msg.content);
        break;
      case 'stream_end':
        this.handleStreamEnd(msg.content);
        this.isAgentRunning = false;
        this.updateInputState();
        break;
      case 'response':
        this.addAgentResponse(msg.content);
        this.isAgentRunning = false;
        this.updateInputState();
        break;
      case 'confirm_required':
        this.showConfirmDialog(msg.command, msg.reason);
        break;
      case 'error':
        this.showError(msg.message);
        this.isAgentRunning = false;
        this.updateInputState();
        break;
      case 'progress_extend':
        this.showProgressExtend(msg.message, msg.currentIteration, msg.newMax, msg.reason);
        break;
      case 'memory_updated':
        this.clearSessionDraft();
        if (this.serverId) {
          void this.fetchServerMemory();
        }
        break;
    }
  }

  private handleSend(): void {
    if (this.isMemoryDrawerOpen) {
      this.closeMemoryDrawer();
    }
    const text = this.inputEl?.value || '';
    const selection = this.pendingTerminalSelection;
    if (!this.sendMessage(text, selection)) return;

    this.inputEl!.value = '';
    this.inputEl!.style.height = 'auto';
    if (selection) this.clearTerminalSelectionContext();
    this.updateInputState();
  }

  /** 提交用户消息；返回 false 表示 Agent 当前不可接收新请求。 */
  sendMessage(text: string, terminalSelection: TerminalSelectionContext | null = null): boolean {
    const message = text.trim();
    if (!message) return false;
    if (this.isAgentRunning) return false;
    if (this.isWaitingConfirmation) return false;
    const outboundMessage = terminalSelection
      ? buildTerminalSelectionMessage(message, terminalSelection)
      : message;

    // Reset streaming + thinking process state
    this.streamingEl = null;
    this.streamingText = '';
    this.removeThinkingProcess();
    this.thinkingStepCount = 0;
    this.livePreviewCache = [];

    this.addUserMessage(message, !!terminalSelection);
    this.isAgentRunning = true;
    this.updateInputState();

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this.wsSend?.(
      JSON.stringify({
        type: 'agent_start',
        message: outboundMessage,
        locale: getLocale(),
        timezone,
      })
    );
    return true;
  }

  private updateInputState(): void {
    const blocked = this.isAgentRunning || this.isWaitingConfirmation;
    if (this.inputEl) {
      this.inputEl.disabled = blocked;
      this.inputEl.placeholder = blocked ? t('agent.thinking') : t('agent.placeholder');
    }
    if (this.sendBtn) {
      (this.sendBtn as HTMLButtonElement).disabled = blocked || !this.inputEl?.value.trim();
    }
  }

  private addUserMessage(text: string, hasTerminalSelection = false): void {
    this.removeResumeChip();
    this.sessionMessages.push({ role: 'user', content: text, hasTerminalSelection });
    this.saveSessionDraft(true);
    this.appendMessage('user', text, { hasTerminalSelection });
  }

  private renderTerminalSelectionContext(): void {
    if (!this.contextEl) return;
    const context = this.pendingTerminalSelection;
    this.contextEl.classList.toggle('hidden', !context);
    this.contextEl.replaceChildren();
    if (!context) return;

    const source = context.sourceLabel || t('agent.selectionUnknownSource');
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    this.contextEl.innerHTML = `
      <div class="agent-context-chip">
        <details class="agent-context-details">
          <summary class="agent-context-summary">
            <span class="material-symbols-outlined agent-context-icon" aria-hidden="true">terminal</span>
            <span class="agent-context-title">${t('agent.selectionAttachment')}</span>
            <span class="agent-context-meta">${escapeHtml(
              t('agent.selectionAttachmentMeta', {
                lines: context.lineCount,
                characters: context.characterCount,
              })
            )}</span>
            <span class="material-symbols-outlined agent-context-expand" aria-hidden="true">expand_more</span>
          </summary>
          <div class="agent-context-source">${escapeHtml(source)}</div>
          <pre class="agent-context-preview">${escapeHtml(context.content)}</pre>
        </details>
        <button type="button" class="agent-context-remove"
          aria-label="${escapeHtml(t('agent.removeSelection'))}"
          title="${escapeHtml(t('agent.removeSelection'))}">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>
    `;
    this.contextEl
      .querySelector<HTMLButtonElement>('.agent-context-remove')
      ?.addEventListener('click', () => {
        this.clearTerminalSelectionContext();
        this.inputEl?.focus();
      });
  }

  private showThinking(iteration: number): void {
    this.ensureThinkingProcess();
    const firstIteration = iteration === 0;
    if (!firstIteration) {
      this.addThinkingStep('thinking', t('agent.thinkingStep', { step: iteration + 1 }));
    } else if (!this.thinkingCurrentEl) {
      this.addThinkingStep('thinking', t('agent.analyzing'));
    }
  }

  private showExecuting(tool: string, args: any): void {
    if (this.streamingEl) {
      this.convertStreamToThoughtStep();
    }
    this.ensureThinkingProcess();
    const cmd = args?.command || '';
    const label =
      tool === 'ask_user_confirmation'
        ? t('agent.requestConfirmation')
        : tool === 'execute_command' && cmd
          ? `$ ${cmd}`
          : `${tool}(${JSON.stringify(args || {})})`;
    this.addThinkingStep(tool, label);
    this.updateLivePreview(label);
  }

  private ensureThinkingProcess(): void {
    if (this.thinkingProcessEl) return;

    const container = document.createElement('div');
    container.className = 'agent-thinking-process';

    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    container.innerHTML = `
      <button class="tp-accordion" type="button">
        <span class="tp-chevron material-symbols-outlined">expand_more</span>
        <span class="tp-icon material-symbols-outlined" style="font-variation-settings:'FILL' 1;">smart_toy</span>
        <span class="tp-status">${t('agent.thinking')}</span>
        <div class="thinking-dots">
          <span class="w-1 h-1 rounded-full bg-[var(--agent-agent-color)] animate-bounce" style="animation-delay:0ms;"></span>
          <span class="w-1 h-1 rounded-full bg-[var(--agent-agent-color)] animate-bounce" style="animation-delay:150ms;"></span>
          <span class="w-1 h-1 rounded-full bg-[var(--agent-agent-color)] animate-bounce" style="animation-delay:300ms;"></span>
        </div>
      </button>
      <div class="tp-live-preview"></div>
      <div class="tp-body">
        <div class="tp-steps"></div>
        <div class="tp-current"></div>
      </div>
    `;

    const accordion = container.querySelector('.tp-accordion') as HTMLElement;
    accordion?.addEventListener('click', () => {
      if (!this.thinkingIsDone) return;
      container.classList.toggle('tp-expanded');
    });

    this.thinkingProcessEl = container;
    this.thinkingStepsEl = container.querySelector('.tp-steps') as HTMLElement;
    this.thinkingStatusEl = container.querySelector('.tp-status') as HTMLElement;
    this.thinkingCurrentEl = container.querySelector('.tp-current') as HTMLElement;
    this.thinkingLiveEl = container.querySelector('.tp-live-preview') as HTMLElement;
    this.thinkingIsDone = false;
    this.messagesEl?.appendChild(container);
    this.scrollToBottom();
  }

  private updateLivePreview(label: string): void {
    if (!this.thinkingLiveEl) return;
    this.livePreviewCache.push(label);
    if (this.livePreviewCache.length > 2) this.livePreviewCache.shift();
    const icon =
      '<span class="material-symbols-outlined tp-live-icon" style="font-variation-settings:\'FILL\' 0;">terminal</span>';
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    this.thinkingLiveEl.innerHTML = this.livePreviewCache
      .map((l) => `<div class="tp-live-item">${icon}<span>${escapeHtml(l)}</span></div>`)
      .join('');
  }

  private addThinkingStep(tool: string, label: string): void {
    if (!this.thinkingStepsEl || !this.thinkingCurrentEl) return;

    // 记录全部步骤，供完成时完整展示
    this.thinkingAllSteps.push({ tool, label });

    // Move the previous step into history BEFORE clearing current
    if (this.thinkingCurrentEl.childElementCount > 0) {
      this.thinkingStepsEl.appendChild(this.thinkingCurrentEl.firstElementChild!);
      // 保留历史中最新的 2 条记录，移除更早的
      while (this.thinkingStepsEl.children.length > 2) {
        this.thinkingStepsEl.removeChild(this.thinkingStepsEl.firstChild!);
      }
    }
    this.thinkingCurrentEl.replaceChildren();
    this.thinkingStepCount++;

    const stepEl = document.createElement('div');
    stepEl.className = 'tp-step tp-step-active';

    const icon =
      tool === 'execute_command' || tool === 'terminal'
        ? '<span class="material-symbols-outlined tp-step-icon" style="font-variation-settings:\'FILL\' 0;">terminal</span>'
        : '<span class="material-symbols-outlined tp-step-icon" style="font-variation-settings:\'FILL\' 1;">smart_toy</span>';

    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    stepEl.innerHTML = `${icon}<span class="tp-step-label">${escapeHtml(label)}</span>`;

    this.thinkingCurrentEl.appendChild(stepEl);

    if (this.thinkingStatusEl) {
      this.thinkingStatusEl.textContent = t(
        this.thinkingIsDone ? 'agent.completedSteps' : 'agent.processingSteps',
        { count: this.thinkingStepCount }
      );
    }
    this.scrollToBottom();
  }

  private collapseThinkingProcess(): void {
    if (!this.thinkingProcessEl || this.thinkingIsDone) return;
    this.thinkingIsDone = true;

    if (this.thinkingCurrentEl?.firstElementChild) {
      this.thinkingStepsEl?.appendChild(this.thinkingCurrentEl.firstElementChild);
    }
    this.thinkingCurrentEl!.replaceChildren();

    // 完成时从完整记录重建，展示所有步骤
    if (this.thinkingStepsEl) {
      this.thinkingStepsEl.replaceChildren();
      for (const step of this.thinkingAllSteps) {
        const stepEl = document.createElement('div');
        stepEl.className = 'tp-step tp-step-done';
        const icon =
          step.tool === 'execute_command' || step.tool === 'terminal'
            ? '<span class="material-symbols-outlined tp-step-icon" style="font-variation-settings:\'FILL\' 0;">check_circle</span>'
            : '<span class="material-symbols-outlined tp-step-icon" style="font-variation-settings:\'FILL\' 1;">check_circle</span>';
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
        stepEl.innerHTML = `${icon}<span class="tp-step-label">${escapeHtml(step.label)}</span>`;
        this.thinkingStepsEl.appendChild(stepEl);
      }
    }

    this.thinkingProcessEl.querySelectorAll('.tp-step-active').forEach((el) => {
      el.classList.remove('tp-step-active');
      el.classList.add('tp-step-done');
      const icon = el.querySelector('.tp-step-icon') as HTMLElement | null;
      if (icon) icon.textContent = 'check_circle';
    });

    if (this.thinkingStatusEl) {
      this.thinkingStatusEl.textContent = t('agent.completedSteps', {
        count: this.thinkingStepCount,
      });
    }

    const mainIcon = this.thinkingProcessEl.querySelector('.tp-icon') as HTMLElement | null;
    if (mainIcon) mainIcon.textContent = 'check_circle';

    const dots = this.thinkingProcessEl.querySelector('.thinking-dots') as HTMLElement | null;
    if (dots) dots.style.display = 'none';

    // Enable expand affordance: show chevron + mark done
    this.thinkingProcessEl.classList.add('tp-done');

    // Hide live preview when collapsed — historical steps are accessible via expand
    if (this.thinkingLiveEl) this.thinkingLiveEl.replaceChildren();
  }

  private removeThinkingProcess(): void {
    if (this.thinkingProcessEl) {
      this.thinkingProcessEl.remove();
    }
    this.thinkingProcessEl = null;
    this.thinkingStepsEl = null;
    this.thinkingCurrentEl = null;
    this.thinkingStatusEl = null;
    this.thinkingLiveEl = null;
    this.thinkingIsDone = false;
    this.thinkingAllSteps = [];
    this.livePreviewCache = [];
  }

  private addAgentResponse(content: string): void {
    this.collapseThinkingProcess();
    this.sessionMessages.push({ role: 'response', content: content || '' });
    this.saveSessionDraft(false);
    this.appendMessage('response', content || '');
  }

  private handleStreamChunk(content: string): void {
    // First chunk: collapse thinking, create the streaming message element
    if (!this.streamingEl) {
      this.collapseThinkingProcess();
    }
    if (!this.streamingEl) {
      this.streamingText = '';
      const el = document.createElement('div');
      el.className = 'agent-message agent-response';

      const themeColor = 'var(--agent-agent-color)';
      const roleIcon = `<span class="material-symbols-outlined text-[14px]" style="color:${themeColor};font-variation-settings:'FILL' 1;">smart_toy</span>`;

    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
      el.innerHTML = `
        <div class="flex gap-2 items-start">
          <div class="shrink-0 mt-0.5">${roleIcon}</div>
          <div class="flex-1 min-w-0 text-[13px] whitespace-pre-wrap agent-md-content"></div>
        </div>
      `;

      this.streamingEl = el;
      this.messagesEl?.appendChild(el);
    }

    // Append plain text as it arrives; keep a live blinking cursor visible
    this.streamingText += content;
    const contentEl = this.streamingEl.querySelector('.agent-md-content');
    if (contentEl) {
      contentEl.textContent = this.streamingText;
      if (!contentEl.querySelector('.streaming-cursor')) {
        const cursor = document.createElement('span');
        cursor.className = 'streaming-cursor';
        contentEl.appendChild(cursor);
      }
    }
    this.scrollToBottom();
  }

  private handleStreamEnd(content: string): void {
    if (this.streamingEl) {
      // Remove raw text + cursor, replace with fully parsed Markdown
      const contentEl = this.streamingEl.querySelector('.agent-md-content');
      if (contentEl) {
        contentEl.classList.remove('whitespace-pre-wrap');
        // renderMarkdown() wraps output in its own .agent-md-content div,
        // so we extract the inner HTML to avoid nesting.
        const tmp = document.createElement('div');
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
        tmp.innerHTML = this.renderMarkdown(content || this.streamingText || '');
        const inner = tmp.querySelector('.agent-md-content');
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
        contentEl.innerHTML = inner ? inner.innerHTML : content || this.streamingText || '';
        this.enhanceCodeBlocks(contentEl);
      }
      this.sessionMessages.push({ role: 'response', content: content || this.streamingText || '' });
      this.saveSessionDraft(false);
      this.streamingEl = null;
      this.streamingText = '';
    } else {
      // Fallback: no streaming element (e.g., empty response)
      this.addAgentResponse(content || '');
    }
  }

  private showError(message: string): void {
    if (this.streamingEl) {
      this.streamingEl.remove();
      this.streamingEl = null;
      this.streamingText = '';
    }
    this.collapseThinkingProcess();
    this.sessionMessages.push({ role: 'error', content: message || t('feedback.danger') });
    this.saveSessionDraft(false);
    this.appendMessage('error', message || t('feedback.danger'));
  }

  private showProgressExtend(
    message: string,
    currentIteration: number,
    newMax: number,
    reason: string
  ): void {
    const el = document.createElement('div');
    el.className =
      'agent-progress-extend p-2 rounded border border-[var(--accent)] bg-[var(--accent-bg)] text-[11px]';
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    el.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined text-[14px]" style="color:var(--accent);font-variation-settings:'FILL' 1;">trending_up</span>
        <span class="font-bold text-[var(--accent)]">${t('agent.progressTitle')}</span>
      </div>
      <div class="agent-progress-detail mt-1">
        ${escapeHtml(t('agent.progressCurrent', { message, current: currentIteration, max: newMax }))}
      </div>
      <div class="agent-progress-detail mt-1 text-[11px]">
        ${escapeHtml(t('agent.progressReason', { reason }))}
      </div>
    `;
    this.messagesEl?.appendChild(el);
    this.scrollToBottom();
  }

  private showConfirmDialog(command: string, reason: string): void {
    if (this.streamingEl) {
      this.convertStreamToThoughtStep();
    }
    const terminalSectionHidden =
      document.getElementById('terminal-section')?.classList.contains('hidden') ?? false;
    if (!this.isVisible || this.parentEl.style.display === 'none' || terminalSectionHidden) {
      this.wsSend?.(JSON.stringify({ type: 'agent_confirm', approved: false, command }));
      return;
    }
    this.rejectPendingConfirmation(false);
    this.isWaitingConfirmation = true;
    this.updateInputState();

    const el = document.createElement('div');
    el.className = 'agent-confirm p-3 rounded border border-[var(--error)] bg-[var(--error-bg)]';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'agent-confirm-title');
    el.setAttribute('aria-describedby', 'agent-confirm-description');
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    el.innerHTML = `
      <div id="agent-confirm-title" class="text-[11px] font-bold text-[var(--error)] mb-1">⚠ ${t('agent.confirmTitle')}</div>
      <div class="text-[12px] mb-1 font-code bg-black/20 p-1 rounded">$ ${escapeHtml(command)}</div>
      <div id="agent-confirm-description" class="text-[11px] text-[var(--on-surface-variant)] mb-2">${escapeHtml(reason)}</div>
      <div class="flex gap-2">
        <button type="button" class="agent-confirm-no cyber-button flex-1 py-1 text-[11px] font-bold">${t('agent.reject')}</button>
        <button type="button" class="agent-confirm-yes cyber-button flex-1 py-1 text-[11px] font-bold bg-[var(--error)] text-white">${t('agent.confirm')}</button>
      </div>
    `;

    const rejectButton = el.querySelector<HTMLButtonElement>('.agent-confirm-no')!;
    const confirmButton = el.querySelector<HTMLButtonElement>('.agent-confirm-yes')!;
    this.pendingConfirmation = {
      command,
      element: el,
      previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };

    rejectButton.addEventListener('click', () => {
      this.resolvePendingConfirmation(false);
    });
    confirmButton.addEventListener('click', () => {
      this.resolvePendingConfirmation(true);
    });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.resolvePendingConfirmation(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const first = rejectButton;
      const last = confirmButton;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    this.messagesEl?.appendChild(el);
    this.scrollToBottom();
    requestAnimationFrame(() => rejectButton.focus());
  }

  private resolvePendingConfirmation(approved: boolean, restoreFocus = true): void {
    const pending = this.pendingConfirmation;
    if (!pending) return;

    this.pendingConfirmation = null;
    this.wsSend?.(
      JSON.stringify({
        type: 'agent_confirm',
        approved,
        command: pending.command,
      })
    );
    pending.element.remove();
    this.isWaitingConfirmation = false;
    this.updateInputState();

    if (restoreFocus) {
      requestAnimationFrame(() => {
        const target = pending.previousFocus?.isConnected ? pending.previousFocus : this.inputEl;
        target?.focus();
      });
    }
  }

  private convertStreamToThoughtStep(): void {
    if (!this.streamingEl) return;

    const thoughts = this.streamingText.trim();
    this.streamingEl.remove();
    this.streamingEl = null;
    this.streamingText = '';

    if (thoughts && this.thinkingProcessEl) {
      // 重新激活思考面板
      this.thinkingIsDone = false;
      this.thinkingProcessEl.classList.remove('tp-done');

      const mainIcon = this.thinkingProcessEl.querySelector('.tp-icon') as HTMLElement | null;
      if (mainIcon) mainIcon.textContent = 'smart_toy';

      const dots = this.thinkingProcessEl.querySelector('.thinking-dots') as HTMLElement | null;
      if (dots) dots.style.display = '';

      // 将思考文本作为一个“规划与思考”步骤加入记录
      this.addThinkingStep('thought', thoughts);
    }
  }

  private appendMessage(
    role: string,
    content: string,
    options: { hasTerminalSelection?: boolean } = {}
  ): void {
    const el = document.createElement('div');
    el.className = `agent-message agent-${role}`;

    const isUser = role === 'user';
    const isAgent = role === 'response';
    const isExecuting = role === 'executing';
    const isError = role === 'error';

    const themeColor = isUser
      ? 'var(--agent-user-color)'
      : isAgent
        ? 'var(--agent-agent-color)'
        : isError
          ? 'var(--error)'
          : 'var(--on-surface-variant)';

    const roleIcon = isUser
      ? `<span class="material-symbols-outlined text-[14px]" style="color:${themeColor};font-variation-settings:'FILL' 1;">person</span>`
      : isAgent
        ? `<span class="material-symbols-outlined text-[14px]" style="color:${themeColor};font-variation-settings:'FILL' 1;">smart_toy</span>`
        : isExecuting
          ? `<span class="material-symbols-outlined text-[14px]" style="color:${themeColor};font-variation-settings:'FILL' 0;">terminal</span>`
          : `<span class="material-symbols-outlined text-[14px]" style="color:${themeColor};font-variation-settings:'FILL' 1;">error</span>`;

    let renderedContent: string;
    if (isAgent) {
      renderedContent = this.renderMarkdown(content || '');
    } else if (isUser) {
      renderedContent = `<div style="color:${themeColor};white-space:pre-wrap;word-break:break-word;">${escapeHtml(content)}</div>`;
    } else if (isExecuting) {
      renderedContent = `<div class="font-code text-[11px]" style="color:${themeColor};white-space:pre-wrap;word-break:break-all;">${escapeHtml(content)}</div>`;
    } else {
      renderedContent = `<div style="color:${themeColor};word-break:break-word;">${escapeHtml(content)}</div>`;
    }
    const terminalSelectionBadge =
      isUser && options.hasTerminalSelection
        ? `<div class="agent-message-context">
          <span class="material-symbols-outlined" aria-hidden="true">terminal</span>
          <span>${t('agent.selectionAttachedMessage')}</span>
        </div>`
        : '';

    // User messages: bubble on right. Agent/others: full width on left.
    if (isUser) {
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
      el.innerHTML = `
        <div class="flex justify-end">
          <div class="max-w-[85%] px-3 py-2 rounded-lg" style="background: color-mix(in srgb, ${themeColor} 12%, transparent); border: 1px solid color-mix(in srgb, ${themeColor} 30%, transparent);">
            ${terminalSelectionBadge}
            <div class="flex gap-2 items-start">
              <div class="flex-1 min-w-0 text-[13px]">${renderedContent}</div>
              <div class="shrink-0 mt-0.5">${roleIcon}</div>
            </div>
          </div>
        </div>
      `;
    } else {
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
      el.innerHTML = `
        <div class="flex gap-2 items-start">
          <div class="shrink-0 mt-0.5">${roleIcon}</div>
          <div class="flex-1 min-w-0 text-[13px]">${renderedContent}</div>
        </div>
      `;
    }

    this.messagesEl?.appendChild(el);
    if (isAgent) {
      this.enhanceCodeBlocks(el);
    }
    this.scrollToBottom();
  }

  private renderMarkdown(text: string): string {
    // marked parses full GFM; renderer hooks inject theme-aware classes.
    // DOMPurify strips XSS (javascript:/vbscript:/data: URLs, event handlers, etc.).
    let raw: string;
    try {
      raw = marked.parse(text, { async: false }) as string;
    } catch {
      // Fallback: escape and return raw as paragraph if parser fails
      return `<div class="agent-md-content">${escapeHtml(text)}</div>`;
    }
    const clean = DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target', 'rel', 'class', 'loading', 'data-code-language'],
      ALLOW_UNKNOWN_PROTOCOLS: false,
      USE_PROFILES: { html: true },
    });
    return `<div class="agent-md-content">${clean}</div>`;
  }

  private enhanceCodeBlocks(root: ParentNode): void {
    root.querySelectorAll<HTMLElement>('.agent-md-code-block').forEach((block) => {
      if (block.dataset.actionsReady === 'true') return;

      const codeEl = block.querySelector<HTMLElement>('code');
      const actionsEl = block.querySelector<HTMLElement>('.agent-md-code-actions');
      const metaEl = block.querySelector<HTMLElement>('.agent-md-code-meta');
      if (!codeEl || !actionsEl || !metaEl) return;

      const code = codeEl.textContent || '';
      const copyButton = this.createCodeActionButton('copy', 'content_copy', t('agent.codeCopy'));
      copyButton.addEventListener('click', async () => {
        const copied = await copyTextToClipboard(code);
        this.showCodeActionFeedback(
          copyButton,
          copied ? 'check' : 'error',
          copied ? t('agent.codeCopied') : t('agent.codeCopyFailed')
        );
      });
      actionsEl.appendChild(copyButton);

      const command = getTerminalFillCommand(block.dataset.codeLanguage, code);
      if (command && this.getTerminalFillTarget && this.fillTerminalInput) {
        const target = this.getTerminalFillTarget();
        metaEl.textContent = t('agent.codeTarget', { target: target.label });
        metaEl.title = target.label;

        const fillButton = this.createCodeActionButton('fill', 'input', t('agent.codeFill'));
        fillButton.disabled = !target.available;
        fillButton.addEventListener('click', () => {
          const currentTarget = this.getTerminalFillTarget?.();
          const filled = !!currentTarget?.available && !!this.fillTerminalInput?.(command);
          this.showCodeActionFeedback(
            fillButton,
            filled ? 'check' : 'error',
            filled ? t('agent.codeFilled') : t('agent.codeFillFailed')
          );
        });
        actionsEl.appendChild(fillButton);
      }

      block.dataset.actionsReady = 'true';
    });
  }

  private refreshCodeBlockActions(): void {
    this.panelEl?.querySelectorAll<HTMLElement>('.agent-md-code-block').forEach((block) => {
      const copyButton = block.querySelector<HTMLButtonElement>('[data-code-action="copy"]');
      if (copyButton) this.setCodeActionButton(copyButton, 'content_copy', t('agent.codeCopy'));

      const fillButton = block.querySelector<HTMLButtonElement>('[data-code-action="fill"]');
      if (fillButton) {
        this.setCodeActionButton(fillButton, 'input', t('agent.codeFill'));
        const target = this.getTerminalFillTarget?.();
        fillButton.disabled = !target?.available;
        const metaEl = block.querySelector<HTMLElement>('.agent-md-code-meta');
        if (metaEl && target) {
          metaEl.textContent = t('agent.codeTarget', { target: target.label });
          metaEl.title = target.label;
        }
      }
    });
  }

  private createCodeActionButton(
    action: 'copy' | 'fill',
    icon: string,
    label: string
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agent-md-code-action';
    button.dataset.codeAction = action;
    this.setCodeActionButton(button, icon, label);
    return button;
  }

  private setCodeActionButton(button: HTMLButtonElement, icon: string, label: string): void {
    button.replaceChildren();
    const iconEl = document.createElement('span');
    iconEl.className = 'material-symbols-outlined';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = icon;
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    button.append(iconEl, labelEl);
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  private showCodeActionFeedback(button: HTMLButtonElement, icon: string, label: string): void {
    this.setCodeActionButton(button, icon, label);
    window.setTimeout(() => {
      if (!button.isConnected) return;
      const isFillButton = button.dataset.codeAction === 'fill';
      this.setCodeActionButton(
        button,
        isFillButton ? 'input' : 'content_copy',
        isFillButton ? t('agent.codeFill') : t('agent.codeCopy')
      );
    }, 1600);
  }

  private scrollToBottom(): void {
    if (this.messagesEl) {
      requestAnimationFrame(() => {
        this.messagesEl!.scrollTop = this.messagesEl!.scrollHeight;
      });
    }
  }

  private renderResumeChip(): void {
    const chipsContainer = this.panelEl?.querySelector('#agent-quick-chips');
    if (!chipsContainer || chipsContainer.querySelector('#agent-resume-task-chip')) return;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.id = 'agent-resume-task-chip';
    chip.className =
      'agent-quick-chip shrink-0 text-[11px] px-2.5 py-0.5 rounded border border-warning/60 hover:border-warning text-warning hover:text-primary transition-colors cursor-pointer flex items-center gap-1 bg-warning/10 font-medium';
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    chip.innerHTML = `
      <span class="material-symbols-outlined text-[13px]">play_circle</span>
      <span data-i18n="agent.resumeInterruptedTask">${escapeHtml(t('agent.resumeInterruptedTask'))}</span>
    `;
    chip.addEventListener('click', () => {
      chip.remove();
      this.sendMessage(t('agent.resumePrompt'));
    });
    chipsContainer.prepend(chip);
  }

  private removeResumeChip(): void {
    this.panelEl?.querySelector('#agent-resume-task-chip')?.remove();
  }

  private loadSessionDraft(): void {
    if (!this.serverId || !this.messagesEl) return;
    try {
      const raw = localStorage.getItem(`cloudssh_agent_draft_${this.serverId}`);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (!draft || !Array.isArray(draft.messages) || draft.messages.length === 0) return;
      // 仅恢复 30 分钟内的中断会话；已完成或过期会话立即清理，避免与云端提炼记忆重复
      if (
        !draft.wasInterrupted ||
        Date.now() - Number(draft.updatedAt || 0) > SESSION_DRAFT_TTL_MS
      ) {
        localStorage.removeItem(`cloudssh_agent_draft_${this.serverId}`);
        return;
      }
      this.sessionMessages = [...draft.messages];
      this.messagesEl.innerHTML = '';
      for (const m of this.sessionMessages) {
        this.appendMessage(m.role, m.content, { hasTerminalSelection: m.hasTerminalSelection });
      }
      this.renderResumeChip();
    } catch {
      /* ignore corrupted draft */
    }
  }

  private saveSessionDraft(isInterrupted: boolean): void {
    if (!this.serverId) return;
    // 任务正常完成或无消息时，立即删除本地暂存草稿，由云端记忆（WorkLog & Knowledge）全权接管
    if (!isInterrupted || this.sessionMessages.length === 0) {
      localStorage.removeItem(`cloudssh_agent_draft_${this.serverId}`);
      return;
    }
    try {
      const draft = {
        serverId: this.serverId,
        updatedAt: Date.now(),
        messages: this.sessionMessages.slice(-20),
        wasInterrupted: true,
      };
      localStorage.setItem(`cloudssh_agent_draft_${this.serverId}`, JSON.stringify(draft));
    } catch {
      /* ignore */
    }
  }

  private clearSessionDraft(): void {
    if (this.serverId) {
      localStorage.removeItem(`cloudssh_agent_draft_${this.serverId}`);
    }
    this.removeResumeChip();
  }

  dispose(): void {
    this.rejectPendingConfirmation(false);
    this.localeCleanup?.();
    this.localeCleanup = null;
    this.pendingTerminalSelection = null;
    this.panelEl?.remove();
    this.panelEl = null;
    this.messagesEl = null;
    this.contextEl = null;
    this.inputEl = null;
    this.sendBtn = null;
    this.memoryDrawerEl = null;
    this.memoryTabWorkLogBtn = null;
    this.memoryTabKnowledgeBtn = null;
    this.memoryContentEl = null;
    this.memoryCountEl = null;
    this.memoryAddBtn = null;
    this.memoryAddFormContainerEl = null;
    this.memoryBatchBtn = null;
    this.memoryBatchBarEl = null;
    this.memorySelectedCountEl = null;
    this.memoryBatchCancelBtn = null;
    this.memoryBatchDeleteBtn = null;
    this.isVisible = false;
    document.body.classList.remove('agent-panel-open');
  }

  // ==================== Server Unified Memory Management ====================

  toggleMemoryDrawer(): void {
    if (this.isMemoryDrawerOpen) {
      this.closeMemoryDrawer();
    } else {
      this.openMemoryDrawer();
    }
  }

  openMemoryDrawer(): void {
    this.isMemoryDrawerOpen = true;
    if (this.memoryDrawerEl) {
      this.memoryDrawerEl.classList.remove('hidden');
    }
    void this.fetchServerMemory();
  }

  closeMemoryDrawer(): void {
    this.isMemoryDrawerOpen = false;
    if (this.memoryDrawerEl) {
      this.memoryDrawerEl.classList.add('hidden');
    }
    this.exitBatchMode();
    this.closeAddKnowledgeForm();
  }

  switchMemoryTab(tab: 'workLog' | 'knowledge'): void {
    this.activeMemoryTab = tab;
    this.exitBatchMode();
    if (this.memoryTabWorkLogBtn && this.memoryTabKnowledgeBtn) {
      if (tab === 'workLog') {
        this.memoryTabWorkLogBtn.className =
          'flex-1 py-1.5 text-center font-medium border-b-2 border-[var(--accent)] text-[var(--accent)] transition-colors cursor-pointer';
        this.memoryTabKnowledgeBtn.className =
          'flex-1 py-1.5 text-center font-medium border-b-2 border-transparent text-muted hover:text-primary transition-colors cursor-pointer';
        this.memoryAddBtn?.classList.add('hidden');
        this.memoryBatchBtn?.classList.add('hidden');
      } else {
        this.memoryTabWorkLogBtn.className =
          'flex-1 py-1.5 text-center font-medium border-b-2 border-transparent text-muted hover:text-primary transition-colors cursor-pointer';
        this.memoryTabKnowledgeBtn.className =
          'flex-1 py-1.5 text-center font-medium border-b-2 border-[var(--accent)] text-[var(--accent)] transition-colors cursor-pointer';
        this.memoryAddBtn?.classList.remove('hidden');
        if (this.unifiedMemory.knowledge.length > 0 && this.serverId && this.isLoggedIn) {
          this.memoryBatchBtn?.classList.remove('hidden');
        } else {
          this.memoryBatchBtn?.classList.add('hidden');
        }
      }
    }
    this.closeAddKnowledgeForm();
    this.renderMemoryContent();
  }

  toggleBatchMode(): void {
    if (this.isBatchMode) {
      this.exitBatchMode();
    } else {
      this.enterBatchMode();
    }
  }

  private enterBatchMode(): void {
    this.isBatchMode = true;
    this.selectedKnowledgeIds.clear();
    this.memoryBatchBarEl?.classList.remove('hidden');
    const textEl = this.panelEl?.querySelector('#agent-memory-batch-btn-text');
    if (textEl) textEl.textContent = t('agent.batchCancel');
    this.updateBatchBar();
    this.renderMemoryContent();
  }

  exitBatchMode(): void {
    if (!this.isBatchMode) return;
    this.isBatchMode = false;
    this.selectedKnowledgeIds.clear();
    this.memoryBatchBarEl?.classList.add('hidden');
    const textEl = this.panelEl?.querySelector('#agent-memory-batch-btn-text');
    if (textEl) textEl.textContent = t('agent.batchManage');
    this.renderMemoryContent();
  }

  private updateBatchBar(): void {
    if (this.memorySelectedCountEl) {
      this.memorySelectedCountEl.textContent = t('agent.selectedCount', {
        count: this.selectedKnowledgeIds.size,
      });
    }
    if (this.memoryBatchDeleteBtn) {
      this.memoryBatchDeleteBtn.disabled = this.selectedKnowledgeIds.size === 0;
    }
  }

  private async handleBatchDelete(): Promise<void> {
    if (this.selectedKnowledgeIds.size === 0 || !this.serverId) return;
    const count = this.selectedKnowledgeIds.size;
    const ok = await confirmAction({
      title: t('agent.batchDelete'),
      message: t('agent.batchDeleteConfirm', { count }),
      variant: 'danger',
    });
    if (!ok) return;

    try {
      const ids = Array.from(this.selectedKnowledgeIds);
      const res = await fetch(`/api/servers/${this.serverId}/knowledge/batch`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (res.ok) {
        notify(t('agent.batchDeleteSuccess', { count }), { variant: 'success' });
        this.exitBatchMode();
        void this.fetchServerMemory();
      } else {
        const err = await res.json().catch(() => ({ error: 'Failed to delete' }));
        notify((err as any).error || 'Failed to delete', { variant: 'danger' });
      }
    } catch {
      notify('Failed to delete', { variant: 'danger' });
    }
  }

  private groupKnowledgeByDate(items: ServerKnowledgeItem[]): Array<{
    key: 'today' | 'yesterday' | 'older';
    label: string;
    items: ServerKnowledgeItem[];
  }> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

    const todayItems: ServerKnowledgeItem[] = [];
    const yesterdayItems: ServerKnowledgeItem[] = [];
    const olderItems: ServerKnowledgeItem[] = [];

    for (const item of items) {
      const ts = item.updated_at || item.created_at;
      if (ts >= todayStart) {
        todayItems.push(item);
      } else if (ts >= yesterdayStart) {
        yesterdayItems.push(item);
      } else {
        olderItems.push(item);
      }
    }

    const groups: Array<{
      key: 'today' | 'yesterday' | 'older';
      label: string;
      items: ServerKnowledgeItem[];
    }> = [];
    if (todayItems.length > 0) {
      groups.push({ key: 'today', label: t('agent.dateGroupToday'), items: todayItems });
    }
    if (yesterdayItems.length > 0) {
      groups.push({ key: 'yesterday', label: t('agent.dateGroupYesterday'), items: yesterdayItems });
    }
    if (olderItems.length > 0) {
      groups.push({ key: 'older', label: t('agent.dateGroupOlder'), items: olderItems });
    }
    return groups;
  }

  private async fetchServerMemory(): Promise<void> {
    if (!this.serverId) {
      this.unifiedMemory = { workLogs: [], knowledge: [] };
      this.renderMemoryContent();
      return;
    }
    try {
      const res = await fetch(`/api/servers/${this.serverId}/memory`);
      if (res.ok) {
        this.unifiedMemory = (await res.json()) as UnifiedServerMemory;
      } else {
        this.unifiedMemory = { workLogs: [], knowledge: [] };
      }
    } catch {
      this.unifiedMemory = { workLogs: [], knowledge: [] };
    }
    this.renderMemoryContent();
  }

  private renderMemoryContent(): void {
    if (!this.memoryContentEl) return;
    const locale = getLocale() === 'en-US' ? 'en-US' : 'zh-CN';

    if (this.memoryCountEl) {
      if (this.activeMemoryTab === 'workLog') {
        this.memoryCountEl.textContent = this.serverId
          ? `(${this.unifiedMemory.workLogs.length})`
          : '';
      } else {
        this.memoryCountEl.textContent = this.serverId
          ? `(${this.unifiedMemory.knowledge.length})`
          : '';
      }
    }

    if (!this.serverId) {
      // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
      this.memoryContentEl.innerHTML = `
        <div class="p-4 text-center text-muted text-xs">
          ${t('agent.memoryDirectNotice')}
        </div>
      `;
      return;
    }

    const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    if (this.activeMemoryTab === 'workLog') {
      if (this.unifiedMemory.workLogs.length === 0) {
        // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
        this.memoryContentEl.innerHTML = `
          <div class="p-4 text-center text-muted text-xs">
            ${t('agent.workLogEmpty')}
          </div>
        `;
        return;
      }

      const logsHtml = this.unifiedMemory.workLogs
        .map((log) => {
          const timeStr = formatTimestampWithRelative(log.created_at, Date.now(), locale, userTz);
          return `
            <div class="agent-memory-card p-2.5 rounded border border-[var(--border)] bg-[var(--bg-elevated)] flex flex-col gap-1.5" data-log-id="${log.id}">
              <div class="flex items-center justify-between text-[11px]">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="font-bold text-primary truncate" title="${escapeHtml(log.title)}">${escapeHtml(log.title)}</span>
                  <span class="text-[10px] text-muted font-code shrink-0">${escapeHtml(timeStr)}</span>
                </div>
                <button type="button" class="agent-log-delete-btn text-muted hover:text-error transition-colors p-0.5 cursor-pointer shrink-0" data-id="${log.id}" title="${t('common.delete')}">
                  <span class="material-symbols-outlined text-[15px]">delete</span>
                </button>
              </div>
              <div class="agent-log-summary text-[11px] text-muted leading-relaxed cursor-pointer hover:text-text transition-colors select-text" title="${escapeHtml(log.summary)}">${escapeHtml(log.summary)}</div>
            </div>
          `;
        })
        .join('');

      // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
      this.memoryContentEl.innerHTML = logsHtml;

      this.memoryContentEl.querySelectorAll<HTMLElement>('.agent-log-summary').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          el.classList.toggle('expanded');
        });
      });

      this.memoryContentEl.querySelectorAll<HTMLButtonElement>('.agent-log-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const logId = Number(btn.dataset.id);
          if (!logId || !this.serverId) return;
          const ok = await confirmAction({
            title: t('common.delete'),
            message: t('agent.memoryDeleteConfirm'),
            variant: 'danger',
          });
          if (!ok) return;

          try {
            const res = await fetch(`/api/servers/${this.serverId}/work-logs/${logId}`, {
              method: 'DELETE',
            });
            if (res.ok) {
              notify(t('agent.memoryDeleted'), { variant: 'success' });
              void this.fetchServerMemory();
            }
          } catch {
            /* ignore */
          }
        });
      });
      return;
    }

    // Knowledge Tab
    if (this.unifiedMemory.knowledge.length === 0) {
      this.memoryBatchBtn?.classList.add('hidden');
      this.exitBatchMode();
      // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
      this.memoryContentEl.innerHTML = `
        <div class="p-4 text-center text-muted text-xs">
          ${t('agent.knowledgeEmpty')}
        </div>
      `;
      return;
    }

    if (this.serverId && this.isLoggedIn) {
      this.memoryBatchBtn?.classList.remove('hidden');
    }

    const catBadges: Record<string, { label: string; tagClass: string }> = {
      credential: {
        label: t('agent.categoryCredential'),
        tagClass: 'bg-amber-500/15 text-amber-400',
      },
      config: {
        label: t('agent.categoryConfig'),
        tagClass: 'bg-[var(--accent)]/15 text-[var(--accent)]',
      },
      rule: {
        label: t('agent.categoryRule'),
        tagClass: 'bg-[var(--accent-secondary)]/15 text-[var(--accent-secondary)]',
      },
      note: {
        label: t('agent.categoryNote'),
        tagClass: 'bg-emerald-500/15 text-emerald-400',
      },
    };

    const groups = this.groupKnowledgeByDate(this.unifiedMemory.knowledge);
    const groupsHtml = groups
      .map((g) => {
        const isCollapsed = this.collapsedDateGroups.has(g.key);
        const isAllGroupSelected =
          g.items.length > 0 && g.items.every((item) => this.selectedKnowledgeIds.has(item.id));

        const itemsHtml = g.items
          .map((k) => {
            const meta = catBadges[k.category] || catBadges.note;
            const isSecret = k.category === 'credential' || isSensitiveKeyOrValue(k.key, k.value);
            const isRevealed = this.revealedSecretIds.has(k.id);
            const displayValue = isSecret && !isRevealed ? '••••••••••••••••' : k.value;
            const isSelected = this.selectedKnowledgeIds.has(k.id);

            return `
              <div class="agent-knowledge-item group px-3 py-2 flex items-center justify-between gap-2 text-[12px] hover:bg-[var(--bg-hover)]/40 transition-colors select-text" data-knowledge-id="${k.id}">
                <div class="flex items-center gap-2 min-w-0 flex-1">
                  ${
                    this.isBatchMode
                      ? `<input type="checkbox" class="agent-knowledge-check rounded cursor-pointer shrink-0 accent-[var(--accent)]" data-id="${k.id}" ${isSelected ? 'checked' : ''} />`
                      : ''
                  }
                  <span class="px-1.5 py-0.5 rounded text-[10px] font-medium tracking-wide uppercase shrink-0 ${meta.tagClass}">${escapeHtml(meta.label)}</span>
                  <span class="font-mono font-semibold text-primary shrink-0 select-all">${escapeHtml(k.key)}:</span>
                  <span class="font-mono text-muted group-hover:text-primary transition-colors truncate select-all flex-1 min-w-0" title="${escapeHtml(k.value)}">${escapeHtml(displayValue)}</span>
                </div>
                <div class="flex items-center gap-0.5 shrink-0">
                  ${
                    isSecret
                      ? `
                    <button type="button" class="agent-secret-toggle-btn text-muted hover:text-primary transition-colors p-1 rounded hover:bg-[var(--bg-hover)] cursor-pointer flex items-center justify-center" data-id="${k.id}" title="${isRevealed ? t('agent.hideSecret') : t('agent.revealSecret')}">
                      <span class="material-symbols-outlined text-[15px]">${isRevealed ? 'visibility_off' : 'visibility'}</span>
                    </button>
                  `
                      : ''
                  }
                  <button type="button" class="agent-knowledge-copy-btn text-muted hover:text-primary transition-colors p-1 rounded hover:bg-[var(--bg-hover)] cursor-pointer flex items-center justify-center" data-value="${escapeHtml(k.value)}" title="${t('agent.codeCopy')}">
                    <span class="material-symbols-outlined text-[15px]">content_copy</span>
                  </button>
                  ${
                    !this.isBatchMode
                      ? `
                    <button type="button" class="agent-knowledge-delete-btn text-muted hover:text-error transition-colors p-1 rounded hover:bg-[var(--bg-hover)] cursor-pointer flex items-center justify-center" data-id="${k.id}" title="${t('common.delete')}">
                      <span class="material-symbols-outlined text-[15px]">delete</span>
                    </button>
                  `
                      : ''
                  }
                </div>
              </div>
            `;
          })
          .join('');

        return `
          <div class="agent-knowledge-group border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--bg-elevated)]/30" data-group-key="${g.key}">
            <div class="agent-knowledge-group-header flex items-center justify-between px-3 py-1.5 bg-[var(--bg-elevated)]/70 cursor-pointer select-none hover:bg-[var(--bg-hover)]/40 transition-colors" data-group="${g.key}">
              <div class="flex items-center gap-1.5 text-xs font-semibold text-primary">
                <span class="material-symbols-outlined text-[16px] transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}">expand_more</span>
                <span>${escapeHtml(g.label)}</span>
                <span class="text-[11px] font-normal text-muted">(${g.items.length})</span>
              </div>
              ${
                this.isBatchMode
                  ? `
                <button type="button" class="agent-group-select-all text-[11px] text-[var(--accent)] hover:underline cursor-pointer" data-group="${g.key}">
                  ${isAllGroupSelected ? t('agent.deselectGroup') : t('agent.selectGroup')}
                </button>
              `
                  : ''
              }
            </div>
            <div class="agent-knowledge-group-items divide-y divide-[var(--border)]/30 ${isCollapsed ? 'hidden' : ''}">
              ${itemsHtml}
            </div>
          </div>
        `;
      })
      .join('');

    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    this.memoryContentEl.innerHTML = groupsHtml;

    this.memoryContentEl.querySelectorAll<HTMLElement>('.agent-knowledge-group-header').forEach((hdr) => {
      hdr.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.agent-group-select-all')) return;
        const groupKey = hdr.dataset.group;
        if (!groupKey) return;
        if (this.collapsedDateGroups.has(groupKey)) {
          this.collapsedDateGroups.delete(groupKey);
        } else {
          this.collapsedDateGroups.add(groupKey);
        }
        this.renderMemoryContent();
      });
    });

    this.memoryContentEl.querySelectorAll<HTMLButtonElement>('.agent-group-select-all').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const groupKey = btn.dataset.group;
        const group = groups.find((g) => g.key === groupKey);
        if (!group) return;
        const allSelected = group.items.every((k) => this.selectedKnowledgeIds.has(k.id));
        if (allSelected) {
          for (const k of group.items) this.selectedKnowledgeIds.delete(k.id);
        } else {
          for (const k of group.items) this.selectedKnowledgeIds.add(k.id);
        }
        this.updateBatchBar();
        this.renderMemoryContent();
      });
    });

    this.memoryContentEl.querySelectorAll<HTMLInputElement>('.agent-knowledge-check').forEach((chk) => {
      chk.addEventListener('change', (e) => {
        e.stopPropagation();
        const kId = Number(chk.dataset.id);
        if (chk.checked) {
          this.selectedKnowledgeIds.add(kId);
        } else {
          this.selectedKnowledgeIds.delete(kId);
        }
        this.updateBatchBar();
      });
    });

    this.memoryContentEl.querySelectorAll<HTMLButtonElement>('.agent-secret-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kId = Number(btn.dataset.id);
        if (this.revealedSecretIds.has(kId)) {
          this.revealedSecretIds.delete(kId);
        } else {
          this.revealedSecretIds.add(kId);
        }
        this.renderMemoryContent();
      });
    });

    this.memoryContentEl.querySelectorAll<HTMLButtonElement>('.agent-knowledge-copy-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const val = btn.dataset.value || '';
        await copyTextToClipboard(val);
        notify(t('agent.copySuccess'), { variant: 'success' });
      });
    });

    this.memoryContentEl.querySelectorAll<HTMLButtonElement>('.agent-knowledge-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const kId = Number(btn.dataset.id);
        if (!kId || !this.serverId) return;
        const ok = await confirmAction({
          title: t('common.delete'),
          message: t('agent.memoryDeleteConfirm'),
          variant: 'danger',
        });
        if (!ok) return;

        try {
          const res = await fetch(`/api/servers/${this.serverId}/knowledge/${kId}`, {
            method: 'DELETE',
          });
          if (res.ok) {
            notify(t('agent.memoryDeleted'), { variant: 'success' });
            void this.fetchServerMemory();
          }
        } catch {
          /* ignore */
        }
      });
    });
  }

  toggleAddKnowledgeForm(): void {
    if (!this.memoryAddFormContainerEl) return;
    if (this.memoryAddFormContainerEl.classList.contains('hidden')) {
      this.openAddKnowledgeForm();
    } else {
      this.closeAddKnowledgeForm();
    }
  }

  openAddKnowledgeForm(): void {
    if (!this.memoryAddFormContainerEl) return;
    this.memoryAddFormContainerEl.classList.remove('hidden');

    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    this.memoryAddFormContainerEl.innerHTML = `
      <form id="agent-add-knowledge-form" class="space-y-2">
        <div class="flex gap-2">
          <select id="agent-knowledge-category" class="terminal-input text-xs py-1 px-2 rounded border border-[var(--border)] bg-[var(--bg)] text-primary">
            <option value="credential">${t('agent.categoryCredential')}</option>
            <option value="config">${t('agent.categoryConfig')}</option>
            <option value="rule">${t('agent.categoryRule')}</option>
            <option value="note" selected>${t('agent.categoryNote')}</option>
          </select>
          <input id="agent-knowledge-key" type="text" placeholder="${t('agent.knowledgeKey')}" class="terminal-input flex-1 text-xs py-1 px-2 rounded border border-[var(--border)] bg-[var(--bg)] font-code text-primary" required maxlength="64" />
        </div>
        <div>
          <textarea id="agent-knowledge-value" rows="2" placeholder="${t('agent.knowledgeValue')}" class="terminal-input w-full text-xs py-1 px-2 rounded border border-[var(--border)] bg-[var(--bg)] font-code resize-none text-primary" required maxlength="512"></textarea>
        </div>
        <div class="flex justify-end gap-2">
          <button type="button" id="agent-knowledge-cancel-btn" class="px-2 py-0.5 text-xs text-muted hover:text-primary cursor-pointer">${t('agent.memoryCancel')}</button>
          <button type="submit" id="agent-knowledge-submit-btn" class="cyber-button px-3 py-0.5 text-xs font-bold text-white bg-[var(--accent)] cursor-pointer">${t('agent.memorySave')}</button>
        </div>
      </form>
    `;

    const form = this.memoryAddFormContainerEl.querySelector<HTMLFormElement>('#agent-add-knowledge-form');
    const cancelBtn = this.memoryAddFormContainerEl.querySelector<HTMLButtonElement>('#agent-knowledge-cancel-btn');
    cancelBtn?.addEventListener('click', () => this.closeAddKnowledgeForm());

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleSaveKnowledge();
    });

    const keyInput = this.memoryAddFormContainerEl.querySelector<HTMLInputElement>('#agent-knowledge-key');
    keyInput?.focus();
  }

  closeAddKnowledgeForm(): void {
    if (!this.memoryAddFormContainerEl) return;
    this.memoryAddFormContainerEl.classList.add('hidden');
    this.memoryAddFormContainerEl.replaceChildren();
  }

  private async handleSaveKnowledge(): Promise<void> {
    if (!this.serverId || !this.memoryAddFormContainerEl) return;
    const catSelect = this.memoryAddFormContainerEl.querySelector<HTMLSelectElement>('#agent-knowledge-category');
    const keyInput = this.memoryAddFormContainerEl.querySelector<HTMLInputElement>('#agent-knowledge-key');
    const valInput = this.memoryAddFormContainerEl.querySelector<HTMLTextAreaElement>('#agent-knowledge-value');

    const category = catSelect?.value || 'note';
    const key = keyInput?.value || '';
    const value = valInput?.value || '';

    const normalized = normalizeKnowledgeInput({ category, key, value });
    if (!normalized.ok) return;

    try {
      const res = await fetch(`/api/servers/${this.serverId}/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalized.value),
      });

      if (res.ok) {
        notify(t('agent.memorySaved'), { variant: 'success' });
        this.closeAddKnowledgeForm();
        void this.fetchServerMemory();
      }
    } catch {
      /* ignore */
    }
  }
}
