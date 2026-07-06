// Agent panel UI — right sidebar for AI Agent interaction

export class AgentPanel {
  private panelEl: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private sendBtn: HTMLElement | null = null;
  private isVisible: boolean = false;
  private isAgentRunning: boolean = false;
  private wsSend: ((data: string) => void) | null = null;
  private onLayoutChange?: () => void;

  constructor(
    private parentEl: HTMLElement,
    private isLoggedIn: boolean,
  ) {}

  setLayoutChangeHandler(handler: () => void): void {
    this.onLayoutChange = handler;
  }

  setWebSocketSend(fn: (data: string) => void): void {
    this.wsSend = fn;
  }

  render(): void {
    if (this.panelEl) return;

    this.panelEl = document.createElement('div');
    this.panelEl.id = 'agent-panel';
    this.panelEl.className = 'w-80 border-l border-[var(--border)] flex flex-col bg-[var(--bg)] overflow-hidden';
    this.panelEl.style.display = 'none';

    this.panelEl.innerHTML = `
      <div class="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-elevated)]">
        <span class="text-xs font-bold tracking-[0.1em] text-[var(--accent-secondary)]">AI_AGENT</span>
        <button id="agent-close-btn" class="text-muted hover:text-primary transition-colors cursor-pointer">
          <span class="material-symbols-outlined" style="font-size:18px;">close</span>
        </button>
      </div>
      <div id="agent-messages" class="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar text-[13px]"></div>
      <div class="p-3 border-t border-[var(--border)]">
        <div class="flex gap-2">
          <input id="agent-input" type="text" placeholder="描述你想做的事..."
            class="terminal-input flex-1 text-[13px]" autocomplete="off">
          <button id="agent-send-btn" class="cyber-button px-3 py-1 text-[11px] font-bold tracking-[0.1em] uppercase bg-[var(--accent)] text-[var(--on-accent)]" title="Send">
            <span class="material-symbols-outlined" style="font-size:16px;">send</span>
          </button>
        </div>
      </div>
    `;

    this.parentEl.appendChild(this.panelEl);
    this.messagesEl = this.panelEl.querySelector('#agent-messages');
    this.inputEl = this.panelEl.querySelector('#agent-input');
    this.sendBtn = this.panelEl.querySelector('#agent-send-btn');
    this.bindEvents();
  }

  private bindEvents(): void {
    this.panelEl?.querySelector('#agent-close-btn')?.addEventListener('click', () => this.hide());

    this.sendBtn?.addEventListener('click', () => this.handleSend());

    this.inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
  }

  toggle(): void {
    this.isVisible ? this.hide() : this.show();
  }

  show(): void {
    if (!this.isLoggedIn) return;
    this.isVisible = true;
    if (this.panelEl) this.panelEl.style.display = 'flex';
    this.inputEl?.focus();
    // 触发终端重新适配（面板展开后终端区域缩小，需要 refit）
    requestAnimationFrame(() => this.onLayoutChange?.());
  }

  hide(): void {
    this.isVisible = false;
    if (this.panelEl) this.panelEl.style.display = 'none';
    // 触发终端重新适配（面板收起后终端区域恢复，需要 refit）
    requestAnimationFrame(() => this.onLayoutChange?.());
  }

  handleAgentFrame(msg: any): void {
    switch (msg.subType) {
      case 'thinking':
        this.showThinking(msg.iteration);
        break;
      case 'executing':
        this.showExecuting(msg.tool, msg.args);
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
    }
  }

  private handleSend(): void {
    const text = this.inputEl?.value.trim();
    if (!text) return;
    if (this.isAgentRunning) return;

    this.addUserMessage(text);
    this.inputEl!.value = '';
    this.isAgentRunning = true;
    this.updateInputState();

    this.wsSend?.(JSON.stringify({
      type: 'agent_start',
      message: text,
    }));
  }

  private updateInputState(): void {
    if (this.inputEl) {
      this.inputEl.disabled = this.isAgentRunning;
      this.inputEl.placeholder = this.isAgentRunning ? 'Agent 运行中...' : '描述你想做的事...';
    }
    if (this.sendBtn) {
      (this.sendBtn as HTMLButtonElement).disabled = this.isAgentRunning;
    }
  }

  private addUserMessage(text: string): void {
    this.appendMessage('user', text);
  }

  private showThinking(iteration: number): void {
    this.removeThinkingIndicator();
    const el = document.createElement('div');
    el.className = 'agent-thinking flex items-center gap-2 text-[var(--on-surface-variant)] opacity-70 text-[12px]';
    el.innerHTML = `
      <span class="thinking-dot animate-pulse"></span>
      <span>Thinking${iteration > 0 ? ` (${iteration})` : ''}...</span>
    `;
    this.messagesEl?.appendChild(el);
    this.scrollToBottom();
  }

  private removeThinkingIndicator(): void {
    this.messagesEl?.querySelectorAll('.agent-thinking').forEach(el => el.remove());
  }

  private showExecuting(tool: string, args: any): void {
    this.removeThinkingIndicator();
    const cmd = args?.command || '';
    const text = tool === 'execute_command' && cmd
      ? `$ ${cmd}`
      : `${tool}(${JSON.stringify(args || {})})`;
    this.appendMessage('executing', text);
  }

  private addAgentResponse(content: string): void {
    this.removeThinkingIndicator();
    this.appendMessage('response', content);
  }

  private showError(message: string): void {
    this.removeThinkingIndicator();
    this.appendMessage('error', message);
  }

  private showConfirmDialog(command: string, reason: string): void {
    const el = document.createElement('div');
    el.className = 'agent-confirm p-3 rounded border border-[var(--error)] bg-[var(--error-bg)]';
    el.innerHTML = `
      <div class="text-[11px] font-bold text-[var(--error)] mb-1">⚠ 危险操作确认</div>
      <div class="text-[12px] mb-1 font-code bg-black/20 p-1 rounded">$ ${this.escapeHtml(command)}</div>
      <div class="text-[11px] text-[var(--on-surface-variant)] mb-2">${this.escapeHtml(reason)}</div>
      <div class="flex gap-2">
        <button class="agent-confirm-no cyber-button flex-1 py-1 text-[11px] font-bold">取消</button>
        <button class="agent-confirm-yes cyber-button flex-1 py-1 text-[11px] font-bold bg-[var(--error)] text-white">确认执行</button>
      </div>
    `;

    el.querySelector('.agent-confirm-no')?.addEventListener('click', () => {
      this.wsSend?.(JSON.stringify({ type: 'agent_confirm', approved: false, command }));
      el.remove();
    });
    el.querySelector('.agent-confirm-yes')?.addEventListener('click', () => {
      this.wsSend?.(JSON.stringify({ type: 'agent_confirm', approved: true, command }));
      el.remove();
    });

    this.messagesEl?.appendChild(el);
    this.scrollToBottom();
  }

  private appendMessage(role: string, content: string): void {
    const el = document.createElement('div');
    el.className = `agent-message agent-${role}`;

    const roleIcon = {
      user: '<span class="material-symbols-outlined text-[14px] text-[var(--accent)]" style="font-variation-settings:\'FILL\'1;">person</span>',
      response: '<span class="material-symbols-outlined text-[14px] text-[var(--accent-secondary)]" style="font-variation-settings:\'FILL\'1;">smart_toy</span>',
      executing: '<span class="material-symbols-outlined text-[14px] text-[var(--on-surface-variant)]" style="font-variation-settings:\'FILL\'0;">terminal</span>',
      error: '<span class="material-symbols-outlined text-[14px] text-[var(--error)]" style="font-variation-settings:\'FILL\'1;">error</span>',
    }[role] || '';

    const renderedContent = role === 'response'
      ? this.renderMarkdown(content)
      : this.escapeHtml(content);

    el.innerHTML = `
      <div class="flex gap-2 items-start">
        <div class="shrink-0 mt-0.5">${roleIcon}</div>
        <div class="flex-1 min-w-0 ${role === 'executing' ? 'font-code text-[11px] text-[var(--on-surface-variant)]' : ''} ${role === 'error' ? 'text-[var(--error)]' : ''}">${renderedContent}</div>
      </div>
    `;

    this.messagesEl?.appendChild(el);
    this.scrollToBottom();
  }

  private renderMarkdown(text: string): string {
    // Simple markdown: bold, code blocks, inline code, line breaks
    let html = this.escapeHtml(text);
    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="bg-black/30 p-2 rounded text-[11px] font-code my-1 overflow-x-auto"><code>$2</code></pre>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="bg-black/20 px-1 rounded text-[11px]">$1</code>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Headers
    html = html.replace(/^### (.+)$/gm, '<div class="font-bold text-[13px] mt-2 mb-1">$1</div>');
    html = html.replace(/^## (.+)$/gm, '<div class="font-bold text-[14px] mt-2 mb-1">$1</div>');
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    return `<div class="agent-md-content">${html}</div>`;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private scrollToBottom(): void {
    if (this.messagesEl) {
      requestAnimationFrame(() => {
        this.messagesEl!.scrollTop = this.messagesEl!.scrollHeight;
      });
    }
  }

  dispose(): void {
    this.panelEl?.remove();
    this.panelEl = null;
    this.messagesEl = null;
    this.inputEl = null;
    this.sendBtn = null;
    this.isVisible = false;
  }
}
