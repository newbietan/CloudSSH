// Agent panel UI — right sidebar for AI Agent interaction

import { marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

// Configure marked once at module load: GFM enabled, custom renderer for theme-aware styling
marked.use({
  gfm: true,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const safeLang = lang && lang.trim()
        ? `<div class="agent-md-lang">${escapeHtml(lang.trim())}</div>`
        : '';
      return `${safeLang}<pre class="agent-md-pre"><code>${escapeHtml(text)}</code></pre>`;
    },
    codespan({ text }: Tokens.Codespan) {
      return `<code class="agent-md-inline-code">${text}</code>`;
    },
    link({ href, title, text }: Tokens.Link) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer" class="agent-md-link">${text}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${href}"${titleAttr} alt="${escapeHtml(text)}" class="agent-md-img" loading="lazy">`;
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
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLElement | null = null;
  private isVisible: boolean = false;
  private isAgentRunning: boolean = false;
  private wsSend: ((data: string) => void) | null = null;
  private onLayoutChange?: () => void;
  private streamingEl: HTMLElement | null = null;
  private streamingText: string = '';

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
    this.panelEl.className = 'w-[560px] shrink-0 border-l border-[var(--border)] flex flex-col bg-[var(--bg)] overflow-hidden';
    this.panelEl.style.display = 'none';

    this.panelEl.innerHTML = `
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] bg-[var(--bg-elevated)]">
        <span class="text-xs font-bold tracking-[0.1em] text-[var(--accent-secondary)]">AI_AGENT</span>
        <button id="agent-close-btn" class="text-muted hover:text-primary transition-colors cursor-pointer">
          <span class="material-symbols-outlined" style="font-size:18px;">close</span>
        </button>
      </div>
      <div id="agent-messages" class="flex-1 overflow-y-auto px-4 py-3 space-y-3 custom-scrollbar text-[13px]"></div>
      <div class="px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-elevated)]">
        <div class="flex gap-2.5 items-end">
          <textarea id="agent-input" placeholder="描述你想做的事... (Enter 发送, Shift+Enter 换行)"
            rows="1"
            class="terminal-input flex-1 text-[13px] resize-none overflow-y-auto"
            style="max-height: 140px; line-height: 1.5; padding: 8px 12px; border-radius: 8px;"
            autocomplete="off"></textarea>
          <button id="agent-send-btn" class="agent-send-btn shrink-0" title="Send (Enter)">
            <span class="material-symbols-outlined" style="font-size:20px;">arrow_upward</span>
          </button>
        </div>
      </div>
    `;

    this.parentEl.appendChild(this.panelEl);
    this.messagesEl = this.panelEl.querySelector('#agent-messages');
    this.inputEl = this.panelEl.querySelector('#agent-input') as HTMLTextAreaElement;
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

    this.inputEl?.addEventListener('input', () => {
      const el = this.inputEl!;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 140) + 'px';
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
    }
  }

  private handleSend(): void {
    const text = this.inputEl?.value.trim();
    if (!text) return;
    if (this.isAgentRunning) return;

    // Reset streaming state
    this.streamingEl = null;
    this.streamingText = '';

    this.addUserMessage(text);
    this.inputEl!.value = '';
    this.inputEl!.style.height = 'auto';
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
    el.className = 'agent-thinking flex items-center gap-2 opacity-80 text-[12px]';
    el.innerHTML = `
      <span class="material-symbols-outlined text-[16px]" style="color:var(--agent-agent-color);font-variation-settings:'FILL' 1;">smart_toy</span>
      <span style="color:var(--agent-agent-color);">Thinking${iteration > 0 ? ` (${iteration})` : ''}...</span>
      <span class="inline-flex gap-0.5">
        <span class="w-1 h-1 rounded-full bg-[var(--agent-agent-color)] animate-bounce" style="animation-delay:0ms;"></span>
        <span class="w-1 h-1 rounded-full bg-[var(--agent-agent-color)] animate-bounce" style="animation-delay:150ms;"></span>
        <span class="w-1 h-1 rounded-full bg-[var(--agent-agent-color)] animate-bounce" style="animation-delay:300ms;"></span>
      </span>
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

  private handleStreamChunk(content: string): void {
    this.removeThinkingIndicator();

    // First chunk: create the streaming message element
    if (!this.streamingEl) {
      this.streamingText = '';
      const el = document.createElement('div');
      el.className = 'agent-message agent-response';

      const themeColor = 'var(--agent-agent-color)';
      const roleIcon = `<span class="material-symbols-outlined text-[14px]" style="color:${themeColor};font-variation-settings:'FILL' 1;">smart_toy</span>`;

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
        tmp.innerHTML = this.renderMarkdown(content || this.streamingText);
        const inner = tmp.querySelector('.agent-md-content');
        contentEl.innerHTML = inner ? inner.innerHTML : (content || this.streamingText);
      }
      this.streamingEl = null;
      this.streamingText = '';
    } else {
      // Fallback: no streaming element (e.g., empty response)
      this.addAgentResponse(content);
    }
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
      <div class="text-[12px] mb-1 font-code bg-black/20 p-1 rounded">$ ${escapeHtml(command)}</div>
      <div class="text-[11px] text-[var(--on-surface-variant)] mb-2">${escapeHtml(reason)}</div>
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

    const isUser = role === 'user';
    const isAgent = role === 'response';
    const isExecuting = role === 'executing';
    const isError = role === 'error';

    const themeColor = isUser ? 'var(--agent-user-color)'
      : isAgent ? 'var(--agent-agent-color)'
      : isError ? 'var(--error)'
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
      renderedContent = this.renderMarkdown(content);
    } else if (isUser) {
      renderedContent = `<div style="color:${themeColor};white-space:pre-wrap;word-break:break-word;">${escapeHtml(content)}</div>`;
    } else if (isExecuting) {
      renderedContent = `<div class="font-code text-[11px]" style="color:${themeColor};white-space:pre-wrap;word-break:break-all;">${escapeHtml(content)}</div>`;
    } else {
      renderedContent = `<div style="color:${themeColor};word-break:break-word;">${escapeHtml(content)}</div>`;
    }

    // User messages: bubble on right. Agent/others: full width on left.
    if (isUser) {
      el.innerHTML = `
        <div class="flex justify-end">
          <div class="max-w-[85%] px-3 py-2 rounded-lg" style="background: color-mix(in srgb, ${themeColor} 12%, transparent); border: 1px solid color-mix(in srgb, ${themeColor} 30%, transparent);">
            <div class="flex gap-2 items-start">
              <div class="flex-1 min-w-0 text-[13px]">${renderedContent}</div>
              <div class="shrink-0 mt-0.5">${roleIcon}</div>
            </div>
          </div>
        </div>
      `;
    } else {
      el.innerHTML = `
        <div class="flex gap-2 items-start">
          <div class="shrink-0 mt-0.5">${roleIcon}</div>
          <div class="flex-1 min-w-0 text-[13px]">${renderedContent}</div>
        </div>
      `;
    }

    this.messagesEl?.appendChild(el);
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
      ADD_ATTR: ['target', 'rel', 'class', 'loading'],
      ALLOW_UNKNOWN_PROTOCOLS: false,
      USE_PROFILES: { html: true },
    });
    return `<div class="agent-md-content">${clean}</div>`;
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
