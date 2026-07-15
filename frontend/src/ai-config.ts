// AI Config panel — BYOK settings for LLM API

export class AIConfigPanel {
  private modalEl: HTMLElement | null = null;

  constructor() {}

  async show(): Promise<void> {
    if (this.modalEl) {
      this.modalEl.classList.remove('hidden');
      await this.loadConfig();
      return;
    }

    this.render();
    await this.loadConfig();
  }

  hide(): void {
    this.modalEl?.classList.add('hidden');
  }

  private render(): void {
    this.modalEl = document.createElement('div');
    this.modalEl.id = 'ai-config-modal';
    this.modalEl.className = 'hidden fixed inset-0 z-[100] flex items-center justify-center';
    this.modalEl.innerHTML = `
      <div class="modal-overlay absolute inset-0" id="ai-modal-backdrop"></div>
      <div class="cyber-box p-6 shadow-2xl relative z-10 w-full max-w-md mx-4">
        <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[var(--accent-secondary)] to-transparent opacity-50"></div>
        <div class="flex items-center justify-between mb-6 pb-4 border-b border-dim">
          <span class="text-xs font-bold tracking-[0.1em] text-[var(--accent-secondary)]">AI_AGENT_CONFIG</span>
          <button id="ai-modal-close-btn" class="text-muted hover:text-primary transition-colors cursor-pointer">
            <span class="material-symbols-outlined" style="font-size:20px;">close</span>
          </button>
        </div>
        <form id="ai-config-form" class="space-y-4">
          <div>
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2">BASE_URL</label>
            <div class="flex items-center">
              <span class="text-muted mr-2">&gt;</span>
              <input id="ai-base-url" class="terminal-input text-[13px]" placeholder="https://api.openai.com/v1" type="url" required>
            </div>
            <div class="text-[10px] text-muted opacity-60 mt-1">OpenAI / DeepSeek / 通义千问 / Kimi / OpenRouter 等兼容接口</div>
          </div>
          <div>
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2">API_KEY</label>
            <div class="flex items-center">
              <span class="material-symbols-outlined text-muted mr-2" style="font-size:16px;">key</span>
              <input id="ai-api-key" class="terminal-input text-[13px]" placeholder="sk-..." type="password">
            </div>
            <div id="ai-key-hint" class="text-[10px] text-muted opacity-60 mt-1">留空 = 不修改现有 Key</div>
          </div>
          <div>
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2">MODEL</label>
            <div class="flex gap-2">
              <input id="ai-model" class="terminal-input flex-1 text-[13px]" placeholder="gpt-4o-mini" type="text" required list="ai-model-list">
              <datalist id="ai-model-list"></datalist>
              <button type="button" id="ai-fetch-models-btn" class="cyber-button px-3 py-1 text-[11px] font-bold tracking-[0.1em]">FETCH</button>
            </div>
            <div id="ai-fetch-status" class="text-[10px] mt-1 hidden"></div>
          </div>
          <div class="pt-2 space-y-2">
            <div id="ai-config-error" class="text-[var(--error)] text-[11px] hidden"></div>
            <div id="ai-config-success" class="text-[var(--accent)] text-[11px] hidden"></div>
            <button id="ai-save-btn" class="cyber-button w-full py-3 px-4 text-xs font-bold tracking-[0.1em] uppercase flex items-center justify-center gap-2 bg-[var(--accent)] text-[var(--on-accent)]" type="button">
              <span class="material-symbols-outlined" style="font-size:18px;">save</span>
              SAVE_CONFIG
            </button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(this.modalEl);

    this.modalEl.querySelector('#ai-modal-close-btn')?.addEventListener('click', () => this.hide());
    this.modalEl.querySelector('#ai-modal-backdrop')?.addEventListener('click', () => this.hide());
    this.modalEl.querySelector('#ai-fetch-models-btn')?.addEventListener('click', () => this.fetchModels());
    this.modalEl.querySelector('#ai-save-btn')?.addEventListener('click', () => this.saveConfig());
  }

  private async loadConfig(): Promise<void> {
    try {
      const res = await fetch('/api/ai/config');
      if (res.ok) {
        const data = await res.json() as any;
        if (data.configured) {
          const baseUrlEl = this.modalEl?.querySelector('#ai-base-url') as HTMLInputElement;
          const modelEl = this.modalEl?.querySelector('#ai-model') as HTMLInputElement;
          const hintEl = this.modalEl?.querySelector('#ai-key-hint');
          if (baseUrlEl) baseUrlEl.value = data.base_url || '';
          if (modelEl) modelEl.value = data.model || '';
          if (hintEl && data.api_key_last4) {
            hintEl.textContent = `当前 Key: ****${data.api_key_last4}（留空 = 不修改）`;
          }
        }
      }
    } catch {}
  }

  private async fetchModels(): Promise<void> {
    const baseUrlEl = this.modalEl?.querySelector('#ai-base-url') as HTMLInputElement;
    const apiKeyEl = this.modalEl?.querySelector('#ai-api-key') as HTMLInputElement;
    const statusEl = this.modalEl?.querySelector('#ai-fetch-status') as HTMLElement;
    const modelListEl = this.modalEl?.querySelector('#ai-model-list') as HTMLDataListElement;
    const fetchBtn = this.modalEl?.querySelector('#ai-fetch-models-btn') as HTMLButtonElement;

    const baseUrl = baseUrlEl?.value.trim();
    const apiKey = apiKeyEl?.value.trim();

    if (!baseUrl || !apiKey) {
      this.showFetchStatus('请先填写 Base URL 和 API Key', true);
      return;
    }

    if (fetchBtn) fetchBtn.disabled = true;
    this.showFetchStatus('获取模型列表中...');

    try {
      const res = await fetch('/api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
      });

      const data = await res.json() as any;

      if (data.error) {
        this.showFetchStatus(data.error, true);
        return;
      }

      if (data.fallback && data.models?.length === 0) {
        const reason = data.reason ? ` (${data.reason})` : '';
        this.showFetchStatus(`Provider 不支持自动获取${reason}，请手动输入模型名称`, false);
        return;
      }

      const models: Array<{ id: string }> = data.models || [];
      if (modelListEl) {
        modelListEl.innerHTML = '';
        for (const m of models) {
          const option = document.createElement('option');
          option.value = m.id;
          modelListEl.appendChild(option);
        }
      }
      this.showFetchStatus(`获取到 ${models.length} 个模型`, false);
    } catch (e) {
      this.showFetchStatus('获取失败: ' + (e instanceof Error ? e.message : '网络错误'), true);
    } finally {
      if (fetchBtn) fetchBtn.disabled = false;
    }
  }

  private showFetchStatus(msg: string, isError: boolean = false): void {
    const el = this.modalEl?.querySelector('#ai-fetch-status') as HTMLElement;
    if (el) {
      el.textContent = msg;
      el.className = `text-[10px] mt-1 ${isError ? 'text-[var(--error)]' : 'text-[var(--accent)]'}`;
    }
  }

  private async saveConfig(): Promise<void> {
    const baseUrl = (this.modalEl?.querySelector('#ai-base-url') as HTMLInputElement)?.value.trim();
    const apiKey = (this.modalEl?.querySelector('#ai-api-key') as HTMLInputElement)?.value.trim();
    const model = (this.modalEl?.querySelector('#ai-model') as HTMLInputElement)?.value.trim();

    const errorEl = this.modalEl?.querySelector('#ai-config-error') as HTMLElement;
    const successEl = this.modalEl?.querySelector('#ai-config-success') as HTMLElement;

    errorEl?.classList.add('hidden');
    successEl?.classList.add('hidden');

    if (!baseUrl || !model) {
      if (errorEl) { errorEl.textContent = 'Base URL 和 Model 为必填项'; errorEl.classList.remove('hidden'); }
      return;
    }

    try {
      const body: Record<string, string> = { base_url: baseUrl, model };
      if (apiKey) body.api_key = apiKey;

      const res = await fetch('/api/ai/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        if (successEl) { successEl.textContent = '配置保存成功'; successEl.classList.remove('hidden'); }
        setTimeout(() => this.hide(), 1500);
      } else {
        const data = await res.json() as any;
        if (errorEl) { errorEl.textContent = data.error || '保存失败'; errorEl.classList.remove('hidden'); }
      }
    } catch {
      if (errorEl) { errorEl.textContent = '网络错误'; errorEl.classList.remove('hidden'); }
    }
  }
}
