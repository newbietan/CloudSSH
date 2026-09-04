// Agent panel UI — right sidebar for AI Agent interaction

import DOMPurify from 'dompurify';
import { marked, type Tokens } from 'marked';
import { copyTextToClipboard } from '../clipboard';
import { getLocale, onLocaleChange, t, translateDocument } from '../i18n';
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

  constructor(
    private parentEl: HTMLElement,
    private isLoggedIn: boolean
  ) {}

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
      'shrink-0 border-l border-[var(--border)] flex flex-col bg-[var(--bg)] overflow-hidden h-full';
    this.panelEl.style.width = 'min(clamp(420px, 40vw, 600px), 100%)';
    this.panelEl.style.display = 'none';

    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    this.panelEl.innerHTML = `
      <div class="agent-panel-header flex items-center justify-between px-4 h-12 border-b border-[var(--border)] bg-[var(--bg-elevated)] shrink-0">
        <div class="flex items-center gap-2 min-w-0">
          <span class="material-symbols-outlined text-[var(--accent-secondary)]" style="font-size: 18px; font-variation-settings: 'FILL' 1;">smart_toy</span>
          <span class="text-xs font-bold tracking-[0.1em] text-[var(--accent-secondary)] truncate" data-i18n="agent.title">AI Agent 助手</span>
        </div>
        <button id="agent-close-btn" class="agent-close-button text-muted hover:text-primary transition-colors cursor-pointer p-1" data-i18n-title="agent.backToTerminal" data-i18n-aria-label="agent.backToTerminal" title="返回终端" aria-label="返回终端">
          <span class="agent-mobile-back material-symbols-outlined" style="font-size:18px;" aria-hidden="true">arrow_back</span>
          <span class="agent-mobile-back agent-back-label" data-i18n="agent.backToTerminal">返回终端</span>
          <span class="agent-desktop-close material-symbols-outlined" style="font-size:18px;" aria-hidden="true">close</span>
        </button>
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
    });

    this.parentEl.appendChild(this.panelEl);
    this.messagesEl = this.panelEl.querySelector('#agent-messages');
    this.contextEl = this.panelEl.querySelector('#agent-context');
    this.inputEl = this.panelEl.querySelector('#agent-input') as HTMLTextAreaElement;
    this.sendBtn = this.panelEl.querySelector('#agent-send-btn');
    this.bindEvents();
    this.updateInputState();
  }

  private bindEvents(): void {
    this.panelEl?.querySelector('#agent-close-btn')?.addEventListener('click', () => this.hide());

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
    }
  }

  private handleSend(): void {
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

    this.wsSend?.(
      JSON.stringify({
        type: 'agent_start',
        message: outboundMessage,
        locale: getLocale(),
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
      if (!fillButton) return;
      this.setCodeActionButton(fillButton, 'input', t('agent.codeFill'));

      const target = this.getTerminalFillTarget?.();
      fillButton.disabled = !target?.available;
      const metaEl = block.querySelector<HTMLElement>('.agent-md-code-meta');
      if (metaEl && target) {
        metaEl.textContent = t('agent.codeTarget', { target: target.label });
        metaEl.title = target.label;
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
    this.isVisible = false;
    document.body.classList.remove('agent-panel-open');
  }
}
