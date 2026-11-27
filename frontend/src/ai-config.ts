// AI Config panel — BYOK settings for LLM API

import { normalizeAIBaseUrl } from '../../src/ai-endpoint';
import { type AIModelBudgets } from '../../src/ai-model-policy';
import { responseErrorMessage } from './agent/response-errors';
import { t, translateDocument } from './i18n';

export class AIConfigPanel {
  private modalEl: HTMLElement | null = null;
  private hasConfiguredKey = false;
  private savedBaseUrl = '';
  private savedModel: string | null = null;
  private generation = 0;
  private loadingConfig = false;
  private savingConfig = false;
  private loadedModels: Array<{ id: string } & Partial<AIModelBudgets>> = [];
  private isDropdownOpen = false;
  private outsideClickListener: ((e: MouseEvent) => void) | null = null;

  show(): void {
    if (!this.modalEl) this.render();
    const generation = ++this.generation;
    this.setConfigLoading(true);
    this.savingConfig = false;
    this.savedModel = null;
    this.closeDropdown();
    this.clearStatus();
    this.modalEl!.querySelectorAll<HTMLInputElement>('#ai-base-url, #ai-model, #ai-api-key')
      .forEach(input => { input.value = ''; });
    const hint = this.modalEl!.querySelector<HTMLElement>('#ai-key-hint');
    if (hint) delete hint.dataset.last4;
    this.modalEl!.querySelector('#ai-fetch-status')?.classList.add('hidden');
    this.updateKeyHint();
    this.updateClearButtonVisibility();
    this.syncSaveButton();
    this.modalEl!.classList.remove('hidden');
    void this.loadConfig(generation);
  }

  hide(): void {
    this.generation++;
    this.closeDropdown();
    const key = this.modalEl?.querySelector<HTMLInputElement>('#ai-api-key');
    if (key) key.value = '';
    this.modalEl?.classList.add('hidden');
  }

  private render(): void {
    this.modalEl = document.createElement('div');
    this.modalEl.id = 'ai-config-modal';
    this.modalEl.className =
      'app-modal responsive-modal hidden fixed inset-0 z-[100] flex items-center justify-center';
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
    this.modalEl.setAttribute('aria-labelledby', 'ai-modal-title');
    // Static markup and trusted bundled i18n only; user config is assigned through input.value.
    this.modalEl.innerHTML = `
      <div class="modal-overlay absolute inset-0" id="ai-modal-backdrop"></div>
      <div class="app-modal__panel app-modal__inset responsive-modal-panel z-10 w-full max-w-md sm:max-w-lg mx-4">
        <header class="app-modal__header mb-6">
          <h2 id="ai-modal-title" class="app-modal__title" data-i18n="aiConfig.title">AI Agent 设置</h2>
          <button id="ai-modal-close-btn" class="app-modal__close" data-i18n-aria-label="common.close" aria-label="关闭" type="button">
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </header>
        <form id="ai-config-form" class="space-y-4">
          <div>
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" data-i18n="aiConfig.baseUrl">接口地址</label>
            <div class="flex items-center">
              <span class="text-muted mr-2">&gt;</span>
              <input id="ai-base-url" class="terminal-input text-[13px]" placeholder="https://api.openai.com/v1" type="url" required>
            </div>
            <div class="text-[10px] text-muted opacity-70 mt-1.5" data-i18n="aiConfig.compatibleHint">${t('aiConfig.compatibleHint')}</div>
          </div>
          <div>
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" data-i18n="aiConfig.apiKey">API 密钥</label>
            <div class="flex items-center">
              <span class="material-symbols-outlined text-muted mr-2" style="font-size:16px;">key</span>
              <input id="ai-api-key" class="terminal-input text-[13px]" placeholder="sk-..." type="password">
            </div>
            <div id="ai-key-hint" class="hidden"></div>
          </div>
          <div>
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" data-i18n="aiConfig.model">模型</label>
            <div class="flex gap-2 items-center">
              <div class="relative flex-1 min-w-0" id="ai-model-combobox">
                <div class="relative flex items-center">
                  <input
                    id="ai-model"
                    class="terminal-input w-full text-[13px] pr-14 font-mono"
                    placeholder="gpt-6-luna"
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
            <div class="text-[10px] text-muted mt-1" data-i18n="aiConfig.modelDiscoveryHint">${t('aiConfig.modelDiscoveryHint')}</div>
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
    const form = this.modalEl.querySelector('#ai-config-form');
    for (const event of ['input', 'change']) form?.addEventListener(event, () => this.syncSaveButton());
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.saveConfig();
    });

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
        this.syncSaveButton();
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

    this.modalEl?.querySelector('#ai-api-key')?.addEventListener('input', () => this.updateKeyHint());
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
    const hintEl = this.modalEl?.querySelector<HTMLElement>('#ai-key-hint');
    if (!hintEl) return;

    const currentBaseUrl = baseUrlEl?.value.trim() || '';
    const hasApiKeyInput = Boolean(apiKeyEl?.value.trim());

    if (!this.loadingConfig && this.hasConfiguredKey && this.savedBaseUrl && !hasApiKeyInput) {
      if (!this.isSameBaseUrl(currentBaseUrl, this.savedBaseUrl)) {
        hintEl.textContent = t('aiConfig.urlChangedKeyRequired');
        hintEl.className = 'text-[10px] text-[var(--accent-secondary)] mt-1';
        return;
      }
    }
    const last4 = hintEl.dataset.last4;
    hintEl.textContent = last4 ? t('aiConfig.currentKey', { last4 }) : '';
    hintEl.className = last4 ? 'text-[10px] text-muted opacity-60 mt-1' : 'hidden';
  }

  private isSameBaseUrl(urlA: string, urlB: string): boolean {
    try {
      return normalizeAIBaseUrl(urlA) === normalizeAIBaseUrl(urlB);
    } catch {
      return false;
    }
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
      list = this.loadedModels.filter((m) => m.id.toLowerCase().includes(trimmed));
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

    for (const model of list) {
      const isSelected = model.id === currentVal;
      const itemEl = this.createOptionElement(model.id, isSelected, inputEl);
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
        this.syncSaveButton();
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

  private readDraft() {
    const value = (id: string) => this.modalEl?.querySelector<HTMLInputElement>(id)?.value.trim() ?? '';
    return { baseUrl: value('#ai-base-url'), model: value('#ai-model'), apiKey: value('#ai-api-key') };
  }

  private hasChanges({ baseUrl, model, apiKey } = this.readDraft()): boolean {
    return this.savedModel === null || model !== this.savedModel || !!apiKey ||
      !this.isSameBaseUrl(baseUrl, this.savedBaseUrl);
  }

  private syncSaveButton(): void {
    const button = this.modalEl?.querySelector<HTMLButtonElement>('#ai-save-btn');
    if (button) button.disabled = this.loadingConfig || this.savingConfig || !this.hasChanges();
  }

  private setConfigLoading(loading: boolean): void {
    this.loadingConfig = loading;
    this.modalEl?.querySelectorAll<HTMLButtonElement>('#ai-fetch-models-btn, #ai-model-dropdown-btn')
      .forEach(button => { button.disabled = loading; });
    this.syncSaveButton();
  }

  private async loadConfig(generation: number): Promise<void> {
    try {
      const res = await fetch('/api/ai/config', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error('config_load_failed');
      const data = (await res.json()) as any;
      if (generation !== this.generation) return;
      if (!data.configured) {
        this.clearSavedConfig();
        return;
      }
      const baseUrlEl = this.modalEl?.querySelector<HTMLInputElement>('#ai-base-url');
      const modelEl = this.modalEl?.querySelector<HTMLInputElement>('#ai-model');
      const hintEl = this.modalEl?.querySelector<HTMLElement>('#ai-key-hint');
      const baseUrl = data.base_url || '';
      if (!this.isSameBaseUrl(this.savedBaseUrl, baseUrl)) this.loadedModels = [];
      this.savedBaseUrl = baseUrl;
      if (baseUrlEl) baseUrlEl.value = baseUrl;
      if (modelEl) modelEl.value = data.model || '';
      this.savedModel = modelEl?.value.trim() ?? '';
      this.hasConfiguredKey = Boolean(data.api_key_last4);
      if (hintEl) hintEl.dataset.last4 = data.api_key_last4 || '';
      this.updateKeyHint();
      this.updateClearButtonVisibility();
    } catch {
      if (generation === this.generation) this.clearSavedConfig();
    } finally {
      if (generation === this.generation) this.setConfigLoading(false);
    }
  }

  private clearSavedConfig(): void {
    this.savedBaseUrl = '';
    this.savedModel = null;
    this.hasConfiguredKey = false;
    this.loadedModels = [];
    this.updateKeyHint();
  }

  private async fetchModels(): Promise<void> {
    if (this.loadingConfig) return;
    const generation = this.generation;
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

    let root: string;
    try { root = normalizeAIBaseUrl(baseUrl); }
    catch { this.showFetchStatus(responseErrorMessage('responses_address'), true); return; }

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
      const body: { base_url: string; api_key?: string } = { base_url: root };
      if (apiKey) {
        body.api_key = apiKey;
      }

      const res = await fetch('/api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as any;
      if (generation !== this.generation || !this.isSameBaseUrl(this.readDraft().baseUrl, root)) return;

      if (data.error) {
        this.showFetchStatus(data.code ? responseErrorMessage(data.code) : data.error, true);
        return;
      }

      if (data.fallback && data.models?.length === 0) {
        const reason = data.reason ? ` (${data.reason})` : '';
        this.showFetchStatus(t('aiConfig.manualModel', { reason }), false);
        return;
      }

      const models: Array<{ id: string } & Partial<AIModelBudgets>> = data.models || [];
      this.loadedModels = models.filter(model => typeof model.id === 'string' && model.id);
      const modelIds = this.loadedModels.map(model => model.id);

      if (modelIds.length > 0) {
        const currentVal = modelEl?.value.trim() || '';
        // 若当前输入框中的模型不在最新拉取的模型列表中，清空以便用户直观选择新模型
        if (currentVal && !modelIds.includes(currentVal)) {
          if (modelEl) modelEl.value = '';
        }
        this.updateClearButtonVisibility();
        this.syncSaveButton();
        this.showFetchStatus(t('aiConfig.modelsLoaded', { count: modelIds.length }), false);
        // 拉取成功后自动展开全量模型下拉菜单，并将焦点移到输入框
        this.openDropdown(true);
        modelEl?.focus();
      } else {
        this.showFetchStatus(t('aiConfig.modelsLoaded', { count: 0 }), false);
      }
    } catch (e) {
      if (generation === this.generation) this.showFetchStatus(
        t('aiConfig.loadFailed', {
          message: e instanceof Error ? e.message : t('aiConfig.networkError'),
        }),
        true
      );
    } finally {
      if (generation === this.generation && fetchBtn) fetchBtn.disabled = false;
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
    const draft = this.readDraft();
    if (this.loadingConfig || this.savingConfig || !this.hasChanges(draft)) return;
    const generation = this.generation;
    const apiKeyEl = this.modalEl?.querySelector<HTMLInputElement>('#ai-api-key');
    const { model, apiKey } = draft;
    let { baseUrl } = draft;

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

    try { baseUrl = normalizeAIBaseUrl(baseUrl); }
    catch {
      if (errorEl) { errorEl.textContent = responseErrorMessage('responses_address'); errorEl.classList.remove('hidden'); }
      return;
    }
    if (!apiKey && this.hasConfiguredKey && !this.isSameBaseUrl(baseUrl, this.savedBaseUrl)) {
      if (errorEl) { errorEl.textContent = t('aiConfig.urlChangedKeyRequired'); errorEl.classList.remove('hidden'); }
      return;
    }

    const matched = this.loadedModels.find(item => item.id === model);
    this.savingConfig = true;
    this.syncSaveButton();
    try {
      const body: { base_url: string; model: string; api_key?: string;
        provider_context_window?: number; provider_max_output_tokens?: number } = {
        base_url: baseUrl,
        model,
      };
      if (typeof matched?.context_window === 'number') body.provider_context_window = matched.context_window;
      if (typeof matched?.max_output_tokens === 'number') body.provider_max_output_tokens = matched.max_output_tokens;
      if (apiKey) body.api_key = apiKey;

      const res = await fetch('/api/ai/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (generation !== this.generation) return;
      if (res.ok) {
        this.hasConfiguredKey = true;
        this.savedBaseUrl = baseUrl;
        this.savedModel = model;
        if (apiKeyEl?.value.trim() === apiKey) apiKeyEl.value = '';
        this.updateKeyHint();
        if (successEl) {
          successEl.textContent = t('aiConfig.saved');
          successEl.classList.remove('hidden');
        }
        setTimeout(() => { if (generation === this.generation && !this.hasChanges()) this.hide(); }, 1500);
      } else {
        const data = (await res.json()) as any;
        if (generation === this.generation && errorEl) {
          errorEl.textContent = data.code ? responseErrorMessage(data.code) : data.error || t('feedback.danger');
          errorEl.classList.remove('hidden');
        }
      }
    } catch {
      if (generation === this.generation && errorEl) {
        errorEl.textContent = t('aiConfig.networkError');
        errorEl.classList.remove('hidden');
      }
    } finally {
      if (generation === this.generation) {
        this.savingConfig = false;
        this.syncSaveButton();
      }
    }
  }
}
