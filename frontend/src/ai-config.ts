// AI Config panel — BYOK settings for LLM API

import { t, translateDocument } from './i18n';

export class AIConfigPanel {
  private modalEl: HTMLElement | null = null;
  private hasConfiguredKey = false;
  private savedBaseUrl = '';
  private loadedModels: string[] = [];
  private isDropdownOpen = false;
  private outsideClickListener: ((e: MouseEvent) => void) | null = null;

  show(): void {
    if (!this.modalEl) this.render();
    this.closeDropdown();
    this.modalEl!.classList.remove('hidden');
    void this.loadConfig();
  }

  hide(): void {
    this.closeDropdown();
    this.modalEl?.classList.add('hidden');
  }

  private render(): void {
    this.modalEl = document.createElement('div');
    this.modalEl.id = 'ai-config-modal';
    this.modalEl.className =
      'responsive-modal hidden fixed inset-0 z-[100] flex items-center justify-center';
    this.modalEl.innerHTML = `
      <div class="modal-overlay absolute inset-0" id="ai-modal-backdrop"></div>
      <div class="responsive-modal-panel cyber-box p-6 shadow-2xl relative z-10 w-full max-w-md mx-4">
        <div class="theme-accent-line absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[var(--accent-secondary)] to-transparent opacity-50"></div>
        <div class="flex items-center justify-between mb-6 pb-4 border-b border-dim">
          <span class="text-xs font-bold tracking-[0.1em] text-[var(--accent-secondary)]" data-i18n="aiConfig.title">AI Agent 设置</span>
          <button id="ai-modal-close-btn" class="panel-close-btn" data-i18n-aria-label="common.close" aria-label="关闭" type="button">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <form id="ai-config-form" class="space-y-4">
          <div>
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" data-i18n="aiConfig.baseUrl">接口地址</label>
            <div class="flex items-center">
              <span class="text-muted mr-2">&gt;</span>
              <input id="ai-base-url" class="terminal-input text-[13px]" placeholder="https://api.openai.com/v1" type="url" required>
            </div>
            <div class="text-[10px] text-muted opacity-60 mt-1" data-i18n="aiConfig.compatibleHint">支持 OpenAI、DeepSeek、通义千问、Kimi、OpenRouter 等兼容接口</div>
          </div>
          <div>
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" data-i18n="aiConfig.apiKey">API 密钥</label>
            <div class="flex items-center">
              <span class="material-symbols-outlined text-muted mr-2" style="font-size:16px;">key</span>
              <input id="ai-api-key" class="terminal-input text-[13px]" placeholder="sk-..." type="password">
            </div>
            <div id="ai-key-hint" class="text-[10px] text-muted opacity-60 mt-1" data-i18n="aiConfig.keyUnchanged">留空表示不修改现有密钥</div>
          </div>
          <div>
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" data-i18n="aiConfig.model">模型</label>
            <div class="flex gap-2 items-center">
              <div class="relative flex-1" id="ai-model-combobox">
                <div class="relative flex items-center">
                  <input
                    id="ai-model"
                    class="terminal-input w-full text-[13px] pr-14 font-mono"
                    placeholder="gpt-4o-mini"
                    type="text"
                    required
                    autocomplete="off"
                    spellcheck="false"
                  >
                  <div class="absolute right-1 flex items-center gap-0.5">
                    <button
                      type="button"
                      id="ai-model-clear-btn"
                      class="hidden p-1 text-muted hover:text-primary transition-colors cursor-pointer rounded"
                      data-i18n-title="aiConfig.clearModel"
                      data-i18n-aria-label="aiConfig.clearModel"
                      title="清空模型"
                      aria-label="清空模型"
                    >
                      <span class="material-symbols-outlined text-[16px] leading-none block">close</span>
                    </button>
                    <button
                      type="button"
                      id="ai-model-dropdown-btn"
                      class="p-1 text-muted hover:text-primary transition-colors cursor-pointer rounded"
                      data-i18n-title="aiConfig.model"
                      data-i18n-aria-label="aiConfig.model"
                      title="模型"
                      aria-label="模型"
                      tabindex="-1"
                    >
                      <span id="ai-model-dropdown-icon" class="material-symbols-outlined text-[18px] leading-none block transition-transform duration-200">expand_more</span>
                    </button>
                  </div>
                </div>
                <div
                  id="ai-model-menu"
                  class="hidden absolute left-0 right-0 top-full mt-1.5 z-50 cyber-box !p-0 bg-[var(--bg-elevated)] border border-outline-variant shadow-2xl max-h-52 overflow-y-auto custom-scrollbar text-xs select-none"
                >
                  <div id="ai-model-options" class="flex flex-col"></div>
                </div>
              </div>
              <button
                type="button"
                id="ai-fetch-models-btn"
                class="cyber-button px-3 py-1.5 text-[11px] font-bold tracking-[0.1em] shrink-0 whitespace-nowrap"
                data-i18n="aiConfig.loadModels"
              >获取模型列表</button>
            </div>
            <div id="ai-fetch-status" class="text-[10px] mt-1 hidden"></div>
          </div>
          <div class="pt-2 space-y-2">
            <div id="ai-config-error" class="text-[var(--error)] text-[11px] hidden"></div>
            <div id="ai-config-success" class="text-[var(--accent)] text-[11px] hidden"></div>
            <button id="ai-save-btn" class="cyber-button w-full py-3 px-4 text-xs font-bold tracking-[0.1em] uppercase flex items-center justify-center gap-2 bg-[var(--accent)] text-[var(--on-accent)]" type="button">
              <span class="material-symbols-outlined" style="font-size:18px;">save</span>
              <span data-i18n="aiConfig.save">保存设置</span>
            </button>
          </div>
        </form>
      </div>
    `;
    translateDocument(this.modalEl);

    document.body.appendChild(this.modalEl);

    this.modalEl.querySelector('#ai-modal-close-btn')?.addEventListener('click', () => this.hide());
    this.modalEl.querySelector('#ai-modal-backdrop')?.addEventListener('click', () => this.hide());
    this.modalEl
      .querySelector('#ai-fetch-models-btn')
      ?.addEventListener('click', () => this.fetchModels());
    this.modalEl.querySelector('#ai-save-btn')?.addEventListener('click', () => this.saveConfig());

    this.setupComboboxEvents();
  }

  private setupComboboxEvents(): void {
    const inputEl = this.modalEl?.querySelector('#ai-model') as HTMLInputElement | null;
    const clearBtn = this.modalEl?.querySelector('#ai-model-clear-btn') as HTMLElement | null;
    const dropdownBtn = this.modalEl?.querySelector('#ai-model-dropdown-btn') as HTMLElement | null;
    const baseUrlEl = this.modalEl?.querySelector('#ai-base-url') as HTMLInputElement | null;

    inputEl?.addEventListener('input', () => {
      this.updateClearButtonVisibility();
      this.clearStatus();
      if (this.loadedModels.length > 0) {
        this.openDropdown(false);
      }
    });

    inputEl?.addEventListener('focus', () => {
      if (!this.isDropdownOpen && this.loadedModels.length > 0) {
        this.openDropdown(true);
      }
    });

    inputEl?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.isDropdownOpen) {
          e.stopPropagation();
          this.closeDropdown();
        }
      } else if (e.key === 'ArrowDown') {
        if (!this.isDropdownOpen && this.loadedModels.length > 0) {
          e.preventDefault();
          this.openDropdown(true);
        }
      }
    });

    clearBtn?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      if (inputEl) {
        inputEl.value = '';
        this.updateClearButtonVisibility();
        this.clearStatus();
        inputEl.focus();
        if (this.loadedModels.length > 0) {
          this.openDropdown(true);
        }
      }
    });

    dropdownBtn?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      if (this.isDropdownOpen) {
        this.closeDropdown();
      } else {
        this.openDropdown(true);
      }
    });

    baseUrlEl?.addEventListener('input', () => {
      // 接口地址发生变更时重置已缓存的模型列表，避免服务商混淆
      this.loadedModels = [];
      this.closeDropdown();
      this.updateKeyHint();
    });

    this.outsideClickListener = (e: MouseEvent) => {
      if (!this.isDropdownOpen || !this.modalEl) return;
      const combobox = this.modalEl.querySelector('#ai-model-combobox');
      if (combobox && !combobox.contains(e.target as Node)) {
        this.closeDropdown();
      }
    };
    document.addEventListener('click', this.outsideClickListener, true);
  }

  private updateKeyHint(): void {
    const baseUrlEl = this.modalEl?.querySelector('#ai-base-url') as HTMLInputElement | null;
    const apiKeyEl = this.modalEl?.querySelector('#ai-api-key') as HTMLInputElement | null;
    const hintEl = this.modalEl?.querySelector('#ai-key-hint');
    if (!hintEl) return;

    const currentBaseUrl = baseUrlEl?.value.trim() || '';
    const hasApiKeyInput = Boolean(apiKeyEl?.value.trim());

    if (this.hasConfiguredKey && this.savedBaseUrl && !hasApiKeyInput) {
      if (!this.isSameBaseUrl(currentBaseUrl, this.savedBaseUrl)) {
        hintEl.textContent = t('aiConfig.urlChangedKeyRequired');
        hintEl.className = 'text-[10px] text-[var(--accent-secondary)] mt-1';
        return;
      }
    }
    hintEl.className = 'text-[10px] text-muted opacity-60 mt-1';
  }

  private isSameBaseUrl(urlA: string, urlB: string): boolean {
    const normalize = (u: string) => {
      let s = u.trim().replace(/\/+$/, '');
      if (s.endsWith('/chat/completions')) {
        s = s.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
      }
      if (s.endsWith('/models')) {
        s = s.slice(0, -'/models'.length).replace(/\/+$/, '');
      }
      return s.toLowerCase();
    };
    return Boolean(urlA && urlB && normalize(urlA) === normalize(urlB));
  }

  private updateClearButtonVisibility(): void {
    const inputEl = this.modalEl?.querySelector('#ai-model') as HTMLInputElement | null;
    const clearBtn = this.modalEl?.querySelector('#ai-model-clear-btn') as HTMLElement | null;
    if (inputEl && clearBtn) {
      if (inputEl.value.trim().length > 0) {
        clearBtn.classList.remove('hidden');
      } else {
        clearBtn.classList.add('hidden');
      }
    }
  }

  private openDropdown(forceFull: boolean = true): void {
    const menuEl = this.modalEl?.querySelector('#ai-model-menu') as HTMLElement | null;
    const iconEl = this.modalEl?.querySelector('#ai-model-dropdown-icon') as HTMLElement | null;
    const inputEl = this.modalEl?.querySelector('#ai-model') as HTMLInputElement | null;
    if (!menuEl || !iconEl) return;

    this.isDropdownOpen = true;
    menuEl.classList.remove('hidden');
    iconEl.classList.add('rotate-180');

    this.renderDropdownOptions(forceFull ? '' : inputEl?.value || '', forceFull);
  }

  private closeDropdown(): void {
    const menuEl = this.modalEl?.querySelector('#ai-model-menu') as HTMLElement | null;
    const iconEl = this.modalEl?.querySelector('#ai-model-dropdown-icon') as HTMLElement | null;
    if (!menuEl || !iconEl) return;

    this.isDropdownOpen = false;
    menuEl.classList.add('hidden');
    iconEl.classList.remove('rotate-180');
  }

  private renderDropdownOptions(filterText: string = '', forceFull: boolean = false): void {
    const container = this.modalEl?.querySelector('#ai-model-options') as HTMLElement | null;
    const inputEl = this.modalEl?.querySelector('#ai-model') as HTMLInputElement | null;
    if (!container) return;

    container.innerHTML = '';

    if (this.loadedModels.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className =
        'px-3 py-3 text-center text-muted text-[11px] cursor-pointer hover:text-primary transition-colors';
      emptyEl.textContent = t('aiConfig.noModelsLoaded');
      emptyEl.addEventListener('click', () => {
        void this.fetchModels();
      });
      container.appendChild(emptyEl);
      return;
    }

    let list = this.loadedModels;
    const trimmed = filterText.trim().toLowerCase();
    if (!forceFull && trimmed) {
      list = this.loadedModels.filter((m) => m.toLowerCase().includes(trimmed));
    }

    if (list.length === 0) {
      const noMatchEl = document.createElement('div');
      noMatchEl.className = 'px-3 py-3 text-center text-muted text-[11px]';
      noMatchEl.textContent = t('aiConfig.noMatchingModels');
      container.appendChild(noMatchEl);
      return;
    }

    const currentVal = inputEl?.value.trim() || '';
    let selectedEl: HTMLElement | null = null;

    for (const modelId of list) {
      const isSelected = modelId === currentVal;
      const itemEl = this.createOptionElement(modelId, isSelected, inputEl);
      if (isSelected) {
        selectedEl = itemEl;
      }
      container.appendChild(itemEl);
    }

    if (selectedEl) {
      requestAnimationFrame(() => {
        selectedEl?.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  private createOptionElement(
    modelId: string,
    isSelected: boolean,
    inputEl: HTMLInputElement | null
  ): HTMLElement {
    const itemEl = document.createElement('div');
    itemEl.className = `flex items-center justify-between px-3 py-2 cursor-pointer transition-colors text-[12px] font-mono select-none ${
      isSelected
        ? 'bg-[var(--accent-bg)] text-primary font-semibold'
        : 'text-on-surface hover:bg-surface-variant hover:text-primary'
    }`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'truncate flex-1';
    nameSpan.textContent = modelId;
    nameSpan.title = modelId;
    itemEl.appendChild(nameSpan);

    if (isSelected) {
      const checkIcon = document.createElement('span');
      checkIcon.className =
        'material-symbols-outlined text-[16px] text-primary ml-2 shrink-0';
      checkIcon.textContent = 'check';
      itemEl.appendChild(checkIcon);
    }

    itemEl.addEventListener('click', () => {
      if (inputEl) {
        inputEl.value = modelId;
        this.updateClearButtonVisibility();
        this.clearStatus();
        inputEl.focus();
      }
      this.closeDropdown();
    });

    return itemEl;
  }

  private clearStatus(): void {
    const errorEl = this.modalEl?.querySelector('#ai-config-error') as HTMLElement | null;
    const successEl = this.modalEl?.querySelector('#ai-config-success') as HTMLElement | null;
    errorEl?.classList.add('hidden');
    successEl?.classList.add('hidden');
  }

  private async loadConfig(): Promise<void> {
    try {
      const res = await fetch('/api/ai/config');
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.configured) {
          const baseUrlEl = this.modalEl?.querySelector('#ai-base-url') as HTMLInputElement;
          const modelEl = this.modalEl?.querySelector('#ai-model') as HTMLInputElement;
          const hintEl = this.modalEl?.querySelector('#ai-key-hint');
          if (baseUrlEl) baseUrlEl.value = data.base_url || '';
          if (modelEl) modelEl.value = data.model || '';
          this.savedBaseUrl = data.base_url || '';
          this.hasConfiguredKey = Boolean(data.api_key_last4);
          if (hintEl && data.api_key_last4) {
            hintEl.textContent = t('aiConfig.currentKey', { last4: data.api_key_last4 });
          }
          this.updateClearButtonVisibility();
        }
      }
    } catch {
      /* AI 配置加载为可选功能，解析失败保持默认即可 */
    }
  }

  private async fetchModels(): Promise<void> {
    const baseUrlEl = this.modalEl?.querySelector('#ai-base-url') as HTMLInputElement;
    const apiKeyEl = this.modalEl?.querySelector('#ai-api-key') as HTMLInputElement;
    const modelEl = this.modalEl?.querySelector('#ai-model') as HTMLInputElement;
    const fetchBtn = this.modalEl?.querySelector('#ai-fetch-models-btn') as HTMLButtonElement;

    const baseUrl = baseUrlEl?.value.trim();
    const apiKey = apiKeyEl?.value.trim();

    if (!baseUrl) {
      this.showFetchStatus(t('aiConfig.required'), true);
      return;
    }

    // 若未填 apiKey 且此前未配置过有效密钥，才强制要求填写
    if (!apiKey && !this.hasConfiguredKey) {
      this.showFetchStatus(t('aiConfig.credentialsRequired'), true);
      return;
    }

    // 若未填 apiKey，但试图向与已保存不同的新地址发起拉取，安全拦截防密钥外带
    if (!apiKey && this.hasConfiguredKey && this.savedBaseUrl) {
      if (!this.isSameBaseUrl(baseUrl, this.savedBaseUrl)) {
        this.showFetchStatus(t('aiConfig.urlChangedKeyRequired'), true);
        return;
      }
    }

    if (fetchBtn) fetchBtn.disabled = true;
    this.showFetchStatus(t('aiConfig.loadingModels'));

    try {
      const body: { base_url: string; api_key?: string } = { base_url: baseUrl };
      if (apiKey) {
        body.api_key = apiKey;
      }

      const res = await fetch('/api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as any;

      if (data.error) {
        this.showFetchStatus(data.error, true);
        return;
      }

      if (data.fallback && data.models?.length === 0) {
        const reason = data.reason ? ` (${data.reason})` : '';
        this.showFetchStatus(t('aiConfig.manualModel', { reason }), false);
        return;
      }

      const models: Array<{ id: string }> = data.models || [];
      const modelIds = models.map((m) => m.id);
      this.loadedModels = modelIds;

      if (modelIds.length > 0) {
        const currentVal = modelEl?.value.trim() || '';
        // 若当前输入框中的模型不在最新拉取的模型列表中，清空以便用户直观选择新模型
        if (currentVal && !modelIds.includes(currentVal)) {
          if (modelEl) modelEl.value = '';
        }
        this.updateClearButtonVisibility();
        this.showFetchStatus(t('aiConfig.modelsLoaded', { count: modelIds.length }), false);
        // 拉取成功后自动展开全量模型下拉菜单，并将焦点移到输入框
        this.openDropdown(true);
        modelEl?.focus();
      } else {
        this.showFetchStatus(t('aiConfig.modelsLoaded', { count: 0 }), false);
      }
    } catch (e) {
      this.showFetchStatus(
        t('aiConfig.loadFailed', {
          message: e instanceof Error ? e.message : t('aiConfig.networkError'),
        }),
        true
      );
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
    const baseUrlEl = this.modalEl?.querySelector('#ai-base-url') as HTMLInputElement | null;
    const apiKeyEl = this.modalEl?.querySelector('#ai-api-key') as HTMLInputElement | null;
    const modelEl = this.modalEl?.querySelector('#ai-model') as HTMLInputElement | null;

    const baseUrl = baseUrlEl?.value.trim() || '';
    const apiKey = apiKeyEl?.value.trim() || '';
    const model = modelEl?.value.trim() || '';

    const errorEl = this.modalEl?.querySelector('#ai-config-error') as HTMLElement;
    const successEl = this.modalEl?.querySelector('#ai-config-success') as HTMLElement;

    errorEl?.classList.add('hidden');
    successEl?.classList.add('hidden');

    if (!baseUrl || !model) {
      if (errorEl) {
        errorEl.textContent = t('aiConfig.required');
        errorEl.classList.remove('hidden');
      }
      return;
    }

    try {
      const body: { base_url: string; model: string; api_key?: string } = {
        base_url: baseUrl,
        model,
      };
      if (apiKey) body.api_key = apiKey;

      const res = await fetch('/api/ai/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        this.hasConfiguredKey = true;
        this.savedBaseUrl = baseUrl;
        if (apiKeyEl) apiKeyEl.value = '';
        if (successEl) {
          successEl.textContent = t('aiConfig.saved');
          successEl.classList.remove('hidden');
        }
        setTimeout(() => this.hide(), 1500);
      } else {
        const data = (await res.json()) as any;
        if (errorEl) {
          errorEl.textContent = data.error || t('feedback.danger');
          errorEl.classList.remove('hidden');
        }
      }
    } catch {
      if (errorEl) {
        errorEl.textContent = t('aiConfig.networkError');
        errorEl.classList.remove('hidden');
      }
    }
  }
}
