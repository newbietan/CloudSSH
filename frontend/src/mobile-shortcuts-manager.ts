import {
  buildDefaultMobileShortcuts,
  MAX_MOBILE_SHORTCUTS,
  type MobileShortcutItem,
  normalizeMobileShortcutsPayload,
  PRESET_SHORTCUT_MAP,
  PRESET_SHORTCUTS,
  type PresetShortcutDefinition,
  SHORTCUT_LABEL_MAX_LENGTH,
  SHORTCUT_VALUE_MAX_LENGTH,
} from '../../src/mobile-shortcuts-schema';
import { type TranslationKey, t, translateDocument } from './i18n';
import { notify } from './ui-feedback';

const LOCAL_CACHE_KEY = 'cloudssh_mobile_shortcuts_v1';

type ShortcutsChangeListener = (shortcuts: MobileShortcutItem[]) => void;

export class MobileShortcutsManager {
  private loggedIn = false;
  private activeShortcuts: MobileShortcutItem[] = buildDefaultMobileShortcuts().shortcuts;
  private listeners = new Set<ShortcutsChangeListener>();
  private modalEl: HTMLElement | null = null;
  private savedShortcuts: readonly MobileShortcutItem[] = [];
  private draftShortcuts: MobileShortcutItem[] = [];
  private isSaving = false;

  getShortcuts(): MobileShortcutItem[] {
    return this.activeShortcuts.map((item) => ({ ...item }));
  }

  onChange(listener: ShortcutsChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(): void {
    const snapshot = this.getShortcuts();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  /**
   * 切换登录态：
   * - 登录时先读取本地缓存镜像（0 延迟渲染），随后异步拉取云端配置对齐；
   * - 退出登录或匿名模式时清空本地镜像并恢复默认快捷键。
   */
  setLoggedIn(loggedIn: boolean): void {
    this.loggedIn = loggedIn;
    if (!loggedIn) {
      this.clearLocalCache();
      this.activeShortcuts = buildDefaultMobileShortcuts().shortcuts;
      this.emitChange();
      this.hideModal();
      return;
    }

    const cached = this.readLocalCache();
    if (cached) {
      this.activeShortcuts = cached;
      this.emitChange();
    }
    void this.syncFromCloud();
  }

  async syncFromCloud(): Promise<void> {
    if (!this.loggedIn) return;
    try {
      const res = await fetch('/api/user/mobile-shortcuts', { method: 'GET' });
      if (!res.ok || !this.loggedIn) return;
      const data = (await res.json()) as { shortcuts?: unknown };
      if (!this.loggedIn) return;

      if (data && data.shortcuts === null) {
        this.clearLocalCache();
        this.activeShortcuts = buildDefaultMobileShortcuts().shortcuts;
        this.emitChange();
        return;
      }

      const normalized = normalizeMobileShortcutsPayload(data);
      if (normalized) {
        this.activeShortcuts = normalized.shortcuts;
        this.writeLocalCache(normalized.shortcuts);
        this.emitChange();
      }
    } catch {
      // 弱网或离线时保留本地镜像或默认配置
    }
  }

  showModal(): void {
    if (!this.loggedIn) return;
    this.savedShortcuts = this.getShortcuts();
    this.draftShortcuts = this.getShortcuts();
    if (!this.modalEl) {
      this.createModalDOM();
    }
    this.renderDraftState();
    this.modalEl!.classList.remove('hidden');
  }

  hideModal(): void {
    this.modalEl?.classList.add('hidden');
  }

  private readLocalCache(): MobileShortcutItem[] | null {
    try {
      const raw = localStorage.getItem(LOCAL_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const normalized = normalizeMobileShortcutsPayload(parsed);
      return normalized ? normalized.shortcuts : null;
    } catch {
      return null;
    }
  }

  private writeLocalCache(shortcuts: MobileShortcutItem[]): void {
    try {
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify({ shortcuts }));
    } catch {
      // ignore storage quota errors
    }
  }

  private clearLocalCache(): void {
    try {
      localStorage.removeItem(LOCAL_CACHE_KEY);
    } catch {
      // ignore
    }
  }

  private createModalDOM(): void {
    const modal = document.createElement('div');
    modal.id = 'mobile-shortcuts-modal';
    modal.className =
      'app-modal responsive-modal hidden fixed inset-0 z-[110] flex items-center justify-center';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'mobile-shortcuts-title');

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-overlay absolute inset-0';
    backdrop.addEventListener('click', () => this.hideModal());

    const panel = document.createElement('div');
    panel.className =
      'app-modal__panel app-modal__inset responsive-modal-panel z-10 w-full max-w-lg mx-3 flex flex-col max-h-[88vh]';

    const header = document.createElement('header');
    header.className = 'app-modal__header mb-3';

    const titleEl = document.createElement('h2');
    titleEl.id = 'mobile-shortcuts-title';
    titleEl.className = 'app-modal__title';
    titleEl.dataset.i18n = 'mobileShortcuts.title';
    titleEl.textContent = t('mobileShortcuts.title');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'app-modal__close';
    closeBtn.dataset.i18nAriaLabel = 'common.close';
    closeBtn.setAttribute('aria-label', t('common.close'));
    const closeIcon = document.createElement('span');
    closeIcon.className = 'material-symbols-outlined';
    closeIcon.textContent = 'close';
    closeBtn.appendChild(closeIcon);
    closeBtn.addEventListener('click', () => this.hideModal());

    header.append(titleEl, closeBtn);

    // Scrollable body
    const body = document.createElement('div');
    body.className = 'flex-1 overflow-y-auto custom-scrollbar space-y-4 pr-1 min-h-0';

    // Section 1: Active shortcuts (order + remove)
    const activeSection = document.createElement('div');
    const activeHeader = document.createElement('div');
    activeHeader.className = 'flex items-center justify-between mb-2';

    const activeLabel = document.createElement('span');
    activeLabel.className = 'text-xs font-bold text-on-surface';
    activeLabel.dataset.i18n = 'mobileShortcuts.activeSection';
    activeLabel.textContent = t('mobileShortcuts.activeSection');

    const countBadge = document.createElement('span');
    countBadge.id = 'mobile-shortcuts-count';
    countBadge.className = 'text-[11px] text-muted font-mono';

    activeHeader.append(activeLabel, countBadge);

    const activeHint = document.createElement('p');
    activeHint.className = 'text-[11px] text-muted mb-2';
    activeHint.dataset.i18n = 'mobileShortcuts.activeHint';
    activeHint.textContent = t('mobileShortcuts.activeHint');

    const activeList = document.createElement('div');
    activeList.id = 'mobile-shortcuts-active-list';
    activeList.className = 'mobile-shortcuts-active-list';

    activeSection.append(activeHeader, activeHint, activeList);

    // Section 2: Presets pool
    const presetSection = document.createElement('div');
    const presetTitle = document.createElement('div');
    presetTitle.className = 'text-xs font-bold text-on-surface mb-2';
    presetTitle.dataset.i18n = 'mobileShortcuts.presetSection';
    presetTitle.textContent = t('mobileShortcuts.presetSection');

    const presetContainer = document.createElement('div');
    presetContainer.id = 'mobile-shortcuts-presets';
    presetContainer.className = 'space-y-3';

    presetSection.append(presetTitle, presetContainer);

    // Section 3: Add custom key
    const customSection = document.createElement('div');
    customSection.className = 'pt-2 border-t border-dim';

    const customTitle = document.createElement('div');
    customTitle.className = 'text-xs font-bold text-on-surface mb-2';
    customTitle.dataset.i18n = 'mobileShortcuts.customSection';
    customTitle.textContent = t('mobileShortcuts.customSection');

    const customRow = document.createElement('div');
    customRow.className = 'flex items-center gap-2';

    const customLabelInput = document.createElement('input');
    customLabelInput.id = 'mobile-shortcut-custom-label';
    customLabelInput.type = 'text';
    customLabelInput.maxLength = SHORTCUT_LABEL_MAX_LENGTH;
    customLabelInput.className = 'terminal-input !w-24 shrink-0 text-[11px] font-mono';
    customLabelInput.dataset.i18nPlaceholder = 'mobileShortcuts.customLabelPlaceholder';
    customLabelInput.placeholder = t('mobileShortcuts.customLabelPlaceholder');

    const customValueInput = document.createElement('input');
    customValueInput.id = 'mobile-shortcut-custom-value';
    customValueInput.type = 'text';
    customValueInput.maxLength = SHORTCUT_VALUE_MAX_LENGTH;
    customValueInput.className = 'terminal-input flex-1 min-w-0 text-[11px] font-mono';
    customValueInput.dataset.i18nPlaceholder = 'mobileShortcuts.customValuePlaceholder';
    customValueInput.placeholder = t('mobileShortcuts.customValuePlaceholder');

    const addCustomBtn = document.createElement('button');
    addCustomBtn.type = 'button';
    addCustomBtn.className = 'cyber-button text-xs px-3 py-2 shrink-0';
    addCustomBtn.dataset.i18n = 'mobileShortcuts.addCustom';
    addCustomBtn.textContent = t('mobileShortcuts.addCustom');
    addCustomBtn.addEventListener('click', () => {
      this.handleAddCustom(customLabelInput, customValueInput);
    });

    customRow.append(customLabelInput, customValueInput, addCustomBtn);
    customSection.append(customTitle, customRow);

    body.append(activeSection, presetSection, customSection);

    // Footer
    const footer = document.createElement('div');
    footer.className =
      'flex items-center justify-between gap-2 pt-3 mt-3 border-t border-dim shrink-0';

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'cyber-button text-xs px-3 py-2 text-muted hover:text-on-surface';
    resetBtn.dataset.i18n = 'mobileShortcuts.resetDefault';
    resetBtn.textContent = t('mobileShortcuts.resetDefault');
    resetBtn.addEventListener('click', () => {
      void this.handleResetDefault();
    });

    const rightActions = document.createElement('div');
    rightActions.className = 'flex items-center gap-2';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'cyber-button text-xs px-3 py-2';
    cancelBtn.dataset.i18n = 'common.cancel';
    cancelBtn.textContent = t('common.cancel');
    cancelBtn.addEventListener('click', () => this.hideModal());

    const saveBtn = document.createElement('button');
    saveBtn.id = 'mobile-shortcuts-save-btn';
    saveBtn.type = 'button';
    saveBtn.className = 'cyber-button cyber-button-primary text-xs px-4 py-2 font-bold';
    saveBtn.dataset.i18n = 'common.save';
    saveBtn.textContent = t('common.save');
    saveBtn.addEventListener('click', () => {
      void this.handleSaveDraft();
    });

    rightActions.append(cancelBtn, saveBtn);
    footer.append(resetBtn, rightActions);

    panel.append(header, body, footer);
    modal.append(backdrop, panel);
    document.body.appendChild(modal);
    this.modalEl = modal;
    translateDocument(modal);
  }

  private renderDraftState(): void {
    if (!this.modalEl) return;

    const countEl = this.modalEl.querySelector('#mobile-shortcuts-count');
    if (countEl) {
      countEl.textContent = `${this.draftShortcuts.length} / ${MAX_MOBILE_SHORTCUTS}`;
    }

    // 1. Render active list
    const activeListEl = this.modalEl.querySelector('#mobile-shortcuts-active-list');
    if (activeListEl) {
      activeListEl.replaceChildren();
      this.draftShortcuts.forEach((item, index) => {
        const chip = document.createElement('div');
        chip.className = 'mobile-shortcut-active-chip';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'mobile-shortcut-chip-label';
        const preset = PRESET_SHORTCUT_MAP.get(item.id);
        if (preset?.icon) {
          const iconSpan = document.createElement('span');
          iconSpan.className = 'material-symbols-outlined text-[15px]';
          iconSpan.setAttribute('aria-hidden', 'true');
          iconSpan.textContent = preset.icon;
          labelSpan.appendChild(iconSpan);
        } else {
          labelSpan.textContent = item.label || preset?.label || item.id;
        }

        const controls = document.createElement('div');
        controls.className = 'mobile-shortcut-chip-controls';

        // Move left/up
        const leftBtn = document.createElement('button');
        leftBtn.type = 'button';
        leftBtn.className = 'mobile-shortcut-chip-btn';
        leftBtn.disabled = index === 0;
        leftBtn.title = t('mobileShortcuts.moveLeft');
        leftBtn.setAttribute('aria-label', t('mobileShortcuts.moveLeft'));
        leftBtn.textContent = '←';
        leftBtn.addEventListener('click', () => {
          if (index > 0) {
            const temp = this.draftShortcuts[index - 1];
            this.draftShortcuts[index - 1] = this.draftShortcuts[index];
            this.draftShortcuts[index] = temp;
            this.renderDraftState();
          }
        });

        // Move right/down
        const rightBtn = document.createElement('button');
        rightBtn.type = 'button';
        rightBtn.className = 'mobile-shortcut-chip-btn';
        rightBtn.disabled = index === this.draftShortcuts.length - 1;
        rightBtn.title = t('mobileShortcuts.moveRight');
        rightBtn.setAttribute('aria-label', t('mobileShortcuts.moveRight'));
        rightBtn.textContent = '→';
        rightBtn.addEventListener('click', () => {
          if (index < this.draftShortcuts.length - 1) {
            const temp = this.draftShortcuts[index + 1];
            this.draftShortcuts[index + 1] = this.draftShortcuts[index];
            this.draftShortcuts[index] = temp;
            this.renderDraftState();
          }
        });

        // Remove
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'mobile-shortcut-chip-btn is-danger';
        removeBtn.disabled = this.draftShortcuts.length <= 1;
        removeBtn.title = t('common.delete');
        removeBtn.setAttribute('aria-label', t('common.delete'));
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
          if (this.draftShortcuts.length <= 1) return;
          this.draftShortcuts.splice(index, 1);
          this.renderDraftState();
        });

        controls.append(leftBtn, rightBtn, removeBtn);
        chip.append(labelSpan, controls);
        activeListEl.appendChild(chip);
      });
    }

    // 2. Render presets pool grouped by category
    const presetsEl = this.modalEl.querySelector('#mobile-shortcuts-presets');
    if (presetsEl) {
      presetsEl.replaceChildren();
      const activeIds = new Set(this.draftShortcuts.map((s) => s.id));

      const categories: ReadonlyArray<{
        key: PresetShortcutDefinition['category'];
        i18nKey: TranslationKey;
      }> = [
        { key: 'modifier', i18nKey: 'mobileShortcuts.catModifier' },
        { key: 'edit', i18nKey: 'mobileShortcuts.catEdit' },
        { key: 'nav', i18nKey: 'mobileShortcuts.catNav' },
        { key: 'fn', i18nKey: 'mobileShortcuts.catFn' },
        { key: 'symbol', i18nKey: 'mobileShortcuts.catSymbol' },
        { key: 'action', i18nKey: 'mobileShortcuts.catAction' },
      ];

      for (const cat of categories) {
        const groupItems = PRESET_SHORTCUTS.filter((p) => p.category === cat.key);
        if (groupItems.length === 0) continue;

        const groupWrap = document.createElement('div');
        const groupTitle = document.createElement('div');
        groupTitle.className = 'text-[11px] text-muted mb-1.5 font-semibold';
        groupTitle.textContent = t(cat.i18nKey);

        const groupGrid = document.createElement('div');
        groupGrid.className = 'flex flex-wrap gap-1.5';

        for (const preset of groupItems) {
          const isSelected = activeIds.has(preset.id);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `mobile-shortcut-preset-btn ${isSelected ? 'is-selected' : ''}`;
          btn.setAttribute('aria-pressed', String(isSelected));
          btn.dataset.presetId = preset.id;

          if (preset.icon) {
            const iconSpan = document.createElement('span');
            iconSpan.className = 'material-symbols-outlined text-[15px]';
            iconSpan.setAttribute('aria-hidden', 'true');
            iconSpan.textContent = preset.icon;
            btn.appendChild(iconSpan);
          } else {
            btn.textContent = preset.label;
          }

          btn.addEventListener('click', () => {
            this.togglePresetInDraft(preset);
          });

          groupGrid.appendChild(btn);
        }

        groupWrap.append(groupTitle, groupGrid);
        presetsEl.appendChild(groupWrap);
      }
    }
    this.syncSaveButton();
  }

  private hasDraftChanges(): boolean {
    // Order is part of the toolbar configuration; uncommitted custom-input text is not.
    return this.draftShortcuts.length !== this.savedShortcuts.length || this.draftShortcuts.some((item, index) => {
      const saved = this.savedShortcuts[index];
      return item.id !== saved.id || item.label !== saved.label || item.type !== saved.type || item.value !== saved.value;
    });
  }

  private syncSaveButton(): void {
    const save = this.modalEl?.querySelector<HTMLButtonElement>('#mobile-shortcuts-save-btn');
    if (save) save.disabled = this.isSaving || !this.hasDraftChanges();
  }

  private togglePresetInDraft(preset: PresetShortcutDefinition): void {
    const idx = this.draftShortcuts.findIndex((item) => item.id === preset.id);
    if (idx === -1) {
      if (this.draftShortcuts.length >= MAX_MOBILE_SHORTCUTS) {
        notify(t('mobileShortcuts.maxCountError', { max: MAX_MOBILE_SHORTCUTS }), {
          variant: 'warning',
        });
        return;
      }
      const itemToPush: MobileShortcutItem = {
        id: preset.id,
        label: preset.label,
        type: preset.type,
      };
      if (preset.value) {
        itemToPush.value = preset.value;
      }
      this.draftShortcuts.push(itemToPush);
    } else {
      if (this.draftShortcuts.length <= 1) {
        notify(t('mobileShortcuts.minOneError'), { variant: 'warning' });
        return;
      }
      this.draftShortcuts.splice(idx, 1);
    }
    this.renderDraftState();
  }

  private handleAddCustom(labelInput: HTMLInputElement, valueInput: HTMLInputElement): void {
    const label = labelInput.value.trim();
    const value = valueInput.value;

    if (!label || !value) {
      notify(t('mobileShortcuts.customRequired'), { variant: 'warning' });
      return;
    }
    if ([...label].length > SHORTCUT_LABEL_MAX_LENGTH) {
      notify(t('mobileShortcuts.customRequired'), { variant: 'warning' });
      return;
    }
    if ([...value].length > SHORTCUT_VALUE_MAX_LENGTH) {
      notify(t('mobileShortcuts.customRequired'), { variant: 'warning' });
      return;
    }
    if (this.draftShortcuts.length >= MAX_MOBILE_SHORTCUTS) {
      notify(t('mobileShortcuts.maxCountError', { max: MAX_MOBILE_SHORTCUTS }), {
        variant: 'warning',
      });
      return;
    }

    const customId = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.draftShortcuts.push({
      id: customId,
      label,
      type: 'text',
      value,
    });

    labelInput.value = '';
    valueInput.value = '';
    this.renderDraftState();
  }

  private async handleSaveDraft(): Promise<void> {
    if (!this.loggedIn || this.isSaving || !this.hasDraftChanges()) return;
    const normalized = normalizeMobileShortcutsPayload({ shortcuts: this.draftShortcuts });
    if (!normalized) {
      notify(t('mobileShortcuts.saveFailed'), { variant: 'danger' });
      return;
    }

    this.isSaving = true;
    this.syncSaveButton();

    try {
      const res = await fetch('/api/user/mobile-shortcuts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalized),
      });

      if (!res.ok) {
        notify(t('mobileShortcuts.saveFailed'), { variant: 'danger' });
        return;
      }

      if (!this.loggedIn) return;
      this.activeShortcuts = normalized.shortcuts;
      this.savedShortcuts = this.getShortcuts();
      this.writeLocalCache(normalized.shortcuts);
      this.emitChange();
      notify(t('mobileShortcuts.saved'), { variant: 'success' });
      this.hideModal();
    } catch {
      notify(t('mobileShortcuts.saveFailed'), { variant: 'danger' });
    } finally {
      this.isSaving = false;
      this.syncSaveButton();
    }
  }

  private async handleResetDefault(): Promise<void> {
    if (!this.loggedIn || this.isSaving) return;
    this.isSaving = true;
    this.syncSaveButton();

    try {
      const res = await fetch('/api/user/mobile-shortcuts', {
        method: 'DELETE',
      });
      if (!res.ok) {
        notify(t('mobileShortcuts.saveFailed'), { variant: 'danger' });
        return;
      }

      if (!this.loggedIn) return;
      const defaults = buildDefaultMobileShortcuts().shortcuts;
      this.activeShortcuts = defaults;
      this.savedShortcuts = this.getShortcuts();
      this.draftShortcuts = this.getShortcuts();
      this.clearLocalCache();
      this.emitChange();
      this.renderDraftState();
      notify(t('mobileShortcuts.resetSuccess'), { variant: 'success' });
    } catch {
      notify(t('mobileShortcuts.saveFailed'), { variant: 'danger' });
    } finally {
      this.isSaving = false;
      this.syncSaveButton();
    }
  }
}
