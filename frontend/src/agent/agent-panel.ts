// Agent panel UI — right sidebar for AI Agent interaction

export class AgentPanel {
  private panelEl: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
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
    this.panelEl.className = 'w-[480px] shrink-0 border-l border-[var(--border)] flex flex-col bg-[var(--bg)] overflow-hidden';
    this.panelEl.style.display = 'none';

    this.panelEl.innerHTML = `
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] bg-[var(--bg-elevated)]">
        <span class="text-xs font-bold tracking-[0.1em] text-[var(--accent-secondary)]">AI_AGENT</span>
        <button id="agent-close-btn" class="text-muted hover:text-primary transition-colors cursor-pointer">
          <span class="material-symbols-outlined" style="font-size:18px;">close</span>
        </button>
      </div>
      <div id="agent-messages" class="flex-1 overflow-y-auto px-4 py-3 space-y-3 custom-scrollbar text-[13px]"></div>
      <div class="px-3 py-2.5 border-t border-[var(--border)] bg-[var(--bg-elevated)]">
        <div class="flex gap-2 items-end">
          <textarea id="agent-input" placeholder="描述你想做的事... (Enter 发送, Shift+Enter 换行)"
            rows="1"
            class="terminal-input flex-1 text-[13px] resize-none overflow-y-auto"
            style="max-height: 140px; line-height: 1.5; padding: 6px 10px;"
            autocomplete="off"></textarea>
          <button id="agent-send-btn" class="cyber-button px-3 py-1.5 text-[11px] font-bold tracking-[0.1em] uppercase bg-[var(--accent)] text-[var(--on-accent)] shrink-0" title="Send (Enter)">
            <span class="material-symbols-outlined" style="font-size:16px;">send</span>
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
      renderedContent = `<div style="color:${themeColor};white-space:pre-wrap;word-break:break-word;">${this.escapeHtml(content)}</div>`;
    } else if (isExecuting) {
      renderedContent = `<div class="font-code text-[11px]" style="color:${themeColor};white-space:pre-wrap;word-break:break-all;">${this.escapeHtml(content)}</div>`;
    } else {
      renderedContent = `<div style="color:${themeColor};word-break:break-word;">${this.escapeHtml(content)}</div>`;
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
    const agentColor = 'var(--agent-agent-color)';
    const codeBlocks: string[] = [];
    const inlineCodes: string[] = [];

    // 1. Extract fenced code blocks so they don't get re-escaped
    let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const langLabel = lang ? `<div class="text-[10px] opacity-60 mb-1 font-code">${this.escapeHtml(lang)}</div>` : '';
      const idx = codeBlocks.length;
      codeBlocks.push(`${langLabel}<pre class="bg-black/30 p-2 rounded text-[11px] font-code overflow-x-auto whitespace-pre-wrap break-words" style="color:${agentColor};"><code>${this.escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
      return `\x00CODEBLOCK${idx}\x00`;
    });

    // 2. Extract inline code
    processed = processed.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code class="bg-black/30 px-1.5 py-0.5 rounded text-[11px] font-code break-all" style="color:${agentColor};">${this.escapeHtml(code)}</code>`);
      return `\x00INLINE${idx}\x00`;
    });

    // 3. Escape remaining HTML
    processed = this.escapeHtml(processed);

    // 4. Process block-level elements (by line)
    const lines = processed.split('\n');
    const out: string[] = [];
    let inList: string | null = null;

    const closeList = () => {
      if (!inList) return;
      out.push(inList === 'ol' ? '</ol>' : '</ul>');
      inList = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Headings (need to decode the escaped # back — escapeHtml doesn't touch #)
      const h6 = line.match(/^######\s+(.+)$/);
      if (h6) { out.push(`<h6 class="font-bold text-[12px] mt-3 mb-1" style="color:${agentColor};">${h6[1]}</h6>`); continue; }
      const h5 = line.match(/^#####\s+(.+)$/);
      if (h5) { out.push(`<h5 class="font-bold text-[12px] mt-3 mb-1" style="color:${agentColor};">${h5[1]}</h5>`); continue; }
      const h4 = line.match(/^####\s+(.+)$/);
      if (h4) { out.push(`<h4 class="font-bold text-[13px] mt-3 mb-1" style="color:${agentColor};">${h4[1]}</h4>`); continue; }
      const h3 = line.match(/^###\s+(.+)$/);
      if (h3) { out.push(`<h3 class="font-bold text-[14px] mt-3 mb-1" style="color:${agentColor};">${h3[1]}</h3>`); continue; }
      const h2 = line.match(/^##\s+(.+)$/);
      if (h2) { out.push(`<h2 class="font-bold text-[15px] mt-3 mb-1" style="color:${agentColor};">${h2[1]}</h2>`); continue; }
      const h1 = line.match(/^#\s+(.+)$/);
      if (h1) { out.push(`<h1 class="font-bold text-[16px] mt-3 mb-1" style="color:${agentColor};">${h1[1]}</h1>`); continue; }

      // Horizontal rule
      if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
        out.push(`<hr class="my-2 border-t border-[var(--border)]">`);
        continue;
      }

      // Blockquote
      if (line.match(/^&gt;\s?(.*)$/)) {
        const quoteContent = line.replace(/^&gt;\s?/, '');
        out.push(`<blockquote class="border-l-2 pl-2 my-1 italic text-[12px]" style="border-color:${agentColor};color:color-mix(in srgb, ${agentColor} 80%, var(--on-surface));">${quoteContent}</blockquote>`);
        continue;
      }

      // GFM Table: detect header row + separator on next line
      if (line.match(/^\|.+\|$/) && i + 1 < lines.length && lines[i + 1].match(/^\|?[\s]*:?[-]+:?[\s]*(\|[\s]*:?[-]+:?[\s]*)*\|?$/)) {
        const headerLine = line;
        const sepLine = lines[i + 1];
        const dataLines: string[] = [];
        let j = i + 2;
        while (j < lines.length && lines[j].match(/^\|.+\|$/)) {
          dataLines.push(lines[j]);
          j++;
        }
        out.push(this.buildTable(headerLine, sepLine, dataLines, agentColor));
        i = j - 1; // will be incremented by loop
        continue;
      }

      // Unordered list item (- or *)
      const ulMatch = line.match(/^[\s]*[-*]\s+(.+)$/);
      if (ulMatch) {
        if (inList !== 'ul') {
          closeList();
          out.push('<ul class="list-disc pl-5 my-1 space-y-0.5">');
          inList = 'ul';
        }
        out.push(`<li>${ulMatch[1]}</li>`);
        continue;
      }

      // Ordered list item
      const olMatch = line.match(/^[\s]*\d+\.\s+(.+)$/);
      if (olMatch) {
        if (inList !== 'ol') {
          closeList();
          out.push('<ol class="list-decimal pl-5 my-1 space-y-0.5">');
          inList = 'ol';
        }
        out.push(`<li>${olMatch[1]}</li>`);
        continue;
      }

      // Close pending list on non-list line
      closeList();

      // Empty line -> paragraph break
      if (line.trim() === '') {
        out.push('<div class="h-2"></div>');
        continue;
      }

      // Regular paragraph
      out.push(`<p class="my-0.5 leading-relaxed">${line}</p>`);
    }

    closeList();

    let html = out.join('\n');

    // 5. Inline formatting (on the already-escaped text)
    html = html.replace(/\*\*(.+?)\*\*/g, `<strong style="color:${agentColor};">$1</strong>`);
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Links: [text](url)  — escapeHtml escaped them as &#91;text&#93;(url) — restore bracket pair
    html = html.replace(/\[(.+?)\]\((.+?)\)/g,
      `<a href="$2" target="_blank" rel="noopener noreferrer" class="underline" style="color:${agentColor};">$1</a>`);

    // 6. Restore inline code and code blocks
    html = html.replace(/\x00INLINE(\d+)\x00/g, (_, i) => inlineCodes[+i]);
    html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[+i]);

    return `<div class="agent-md-content break-words" style="color: ${agentColor};">${html}</div>`;
  }

  private buildTable(headerLine: string, sepLine: string, dataLines: string[], agentColor: string): string {
    const parseCells = (line: string): string[] => {
      // Strip leading/trailing `|`, split by `|`, trim each cell
      const stripped = line.replace(/^\|/, '').replace(/\|$/, '');
      return stripped.split('|').map(c => c.trim());
    };

    const headerCells = parseCells(headerLine);
    const sepCells = parseCells(sepLine);

    // Determine alignment per column
    const aligns: string[] = sepCells.map(cell => {
      const c = cell.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });

    const cellStyle = (i: number) => `text-align:${aligns[i] || 'left'};padding:4px 8px;border-bottom:1px solid var(--border);`;
    const cellContent = (s: string) => {
      let h = this.escapeHtml(s);
      h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      h = h.replace(/`([^`\n]+)`/g, '<code class="bg-black/30 px-1 rounded text-[11px]">$1</code>');
      return h;
    };

    const headRow = '<tr>' + headerCells.map((c, i) =>
      `<th style="${cellStyle(i)}font-weight:bold;color:${agentColor};">${cellContent(c)}</th>`
    ).join('') + '</tr>';

    const bodyRows = dataLines.map(line => {
      const cells = parseCells(line);
      return '<tr>' + cells.map((c, i) =>
        `<td style="${cellStyle(i)}">${cellContent(c)}</td>`
      ).join('') + '</tr>';
    }).join('');

    return `<table class="agent-table w-full text-[12px] my-2" style="border-collapse:collapse;border-top:2px solid ${agentColor};"><thead>${headRow}</thead><tbody>${bodyRows}</tbody></table>`;
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
