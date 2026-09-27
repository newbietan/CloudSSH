/**
 * CloudSSH 自定义主题管理模块（多套主题本地/云端存储、状态管理与管理弹窗 UI）
 */

import {
  type ImportedThemeData,
  MAX_CUSTOM_THEMES,
  THEME_MAX_BYTES,
  applyImportedTheme,
  normalizeImportedTheme,
} from './theme';
import { t } from './i18n';
import { confirmAction, notify } from './ui-feedback';

export interface CustomThemeItem {
  id: string;
  name: string;
  data: ImportedThemeData;
  createdAt: number;
}

const STORAGE_KEY_CUSTOM_THEMES = 'cloudssh_custom_themes';
const STORAGE_KEY_ACTIVE_CUSTOM_ID = 'cloudssh_active_custom_theme_id';
const STORAGE_KEY_LEGACY_THEME = 'cloudssh_imported_theme';

type StoreListener = () => void;

export class CustomThemeStore {
  private themes: CustomThemeItem[] = [];
  private activeId: string | null = null;
  private listeners: Set<StoreListener> = new Set();
  private isLoggedIn = false;

  constructor() {
    this.loadFromLocalStorage();
  }

  public setLoggedIn(loggedIn: boolean): void {
    this.isLoggedIn = loggedIn;
  }

  public subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // ignore
      }
    });
  }

  public getThemes(): CustomThemeItem[] {
    return [...this.themes];
  }

  public hasThemes(): boolean {
    return this.themes.length > 0;
  }

  public getActiveId(): string | null {
    return this.activeId;
  }

  public getActiveTheme(): CustomThemeItem | null {
    if (!this.activeId) return this.themes[0] ?? null;
    return this.themes.find((t) => t.id === this.activeId) ?? this.themes[0] ?? null;
  }

  private loadFromLocalStorage(): void {
    const rawThemes = localStorage.getItem(STORAGE_KEY_CUSTOM_THEMES);
    const activeId = localStorage.getItem(STORAGE_KEY_ACTIVE_CUSTOM_ID);

    if (rawThemes) {
      try {
        const parsed = JSON.parse(rawThemes);
        if (Array.isArray(parsed)) {
          const list: CustomThemeItem[] = [];
          for (const item of parsed) {
            if (!item || typeof item !== 'object') continue;
            const normalized = normalizeImportedTheme(item.data);
            if (!normalized) continue;
            list.push({
              id: String(item.id || `cth_${Date.now()}`),
              name: String(item.name || normalized.name || t('theme.custom')),
              data: normalized,
              createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
            });
            if (list.length >= MAX_CUSTOM_THEMES) break;
          }
          this.themes = list;
          this.activeId =
            activeId && list.some((t) => t.id === activeId)
              ? activeId
              : list.length > 0
                ? list[0].id
                : null;
          return;
        }
      } catch {
        // ignore malformed local storage
      }
    }

    // 历史单主题数据平滑向后兼容迁移
    const legacyRaw = localStorage.getItem(STORAGE_KEY_LEGACY_THEME);
    if (legacyRaw) {
      try {
        const legacyData = normalizeImportedTheme(JSON.parse(legacyRaw));
        if (legacyData) {
          const legacyItem: CustomThemeItem = {
            id: 'legacy',
            name: legacyData.name || t('theme.custom'),
            data: legacyData,
            createdAt: Date.now(),
          };
          this.themes = [legacyItem];
          this.activeId = 'legacy';
          this.persistToLocalStorage();
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY_LEGACY_THEME);
      }
    }
  }

  private persistToLocalStorage(): void {
    localStorage.setItem(STORAGE_KEY_CUSTOM_THEMES, JSON.stringify(this.themes));
    if (this.activeId) {
      localStorage.setItem(STORAGE_KEY_ACTIVE_CUSTOM_ID, this.activeId);
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_CUSTOM_ID);
    }

    // 同时将当前活跃主题写入 cloudssh_imported_theme 以供旧模块或断网时使用
    const activeTheme = this.getActiveTheme();
    if (activeTheme) {
      localStorage.setItem(STORAGE_KEY_LEGACY_THEME, JSON.stringify(activeTheme.data));
    } else {
      localStorage.removeItem(STORAGE_KEY_LEGACY_THEME);
    }
  }

  public async addTheme(name: string, data: ImportedThemeData): Promise<CustomThemeItem> {
    if (this.themes.length >= MAX_CUSTOM_THEMES) {
      throw new Error(t('theme.maxReached'));
    }

    const uniqueId = `cth_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const finalName = name.trim().slice(0, 80) || data.name || t('theme.custom');
    const newItem: CustomThemeItem = {
      id: uniqueId,
      name: finalName,
      data,
      createdAt: Date.now(),
    };

    // 新增置顶
    this.themes.unshift(newItem);
    this.activeId = uniqueId;
    this.persistToLocalStorage();
    this.notifyListeners();

    if (this.isLoggedIn) {
      void this.syncToCloud();
    }

    return newItem;
  }

  public async selectTheme(id: string): Promise<boolean> {
    const target = this.themes.find((t) => t.id === id);
    if (!target) return false;

    this.activeId = id;
    this.persistToLocalStorage();
    applyImportedTheme(target.data);
    this.notifyListeners();

    if (this.isLoggedIn) {
      void this.syncToCloud();
    }

    return true;
  }

  public async removeTheme(id: string): Promise<{ remainingCount: number; newActiveId: string | null }> {
    const index = this.themes.findIndex((t) => t.id === id);
    if (index === -1) {
      return { remainingCount: this.themes.length, newActiveId: this.activeId };
    }

    this.themes.splice(index, 1);
    if (this.activeId === id) {
      this.activeId = this.themes.length > 0 ? this.themes[0].id : null;
      if (this.activeId) {
        const nextTheme = this.getActiveTheme();
        if (nextTheme) {
          applyImportedTheme(nextTheme.data);
        }
      }
    }

    this.persistToLocalStorage();
    this.notifyListeners();

    if (this.isLoggedIn) {
      void this.deleteFromCloud(id);
    }

    return { remainingCount: this.themes.length, newActiveId: this.activeId };
  }

  public async syncToCloud(): Promise<boolean> {
    if (!this.isLoggedIn) return false;
    try {
      const payload = {
        active_id: this.activeId,
        themes: this.themes.map((t) => ({
          id: t.id,
          name: t.name,
          data: t.data,
          createdAt: t.createdAt,
        })),
      };
      const response = await fetch('/api/user/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  public async deleteFromCloud(themeId?: string): Promise<boolean> {
    if (!this.isLoggedIn) return false;
    try {
      const url = themeId
        ? `/api/user/theme?id=${encodeURIComponent(themeId)}`
        : '/api/user/theme';
      const response = await fetch(url, { method: 'DELETE' });
      return response.ok;
    } catch {
      return false;
    }
  }

  public async fetchFromCloud(): Promise<boolean> {
    if (!this.isLoggedIn) return false;
    try {
      const response = await fetch('/api/user/theme');
      if (!response.ok) return false;
      const result = (await response.json()) as {
        themes?: Array<{ id: string; name: string; data: unknown; createdAt: number }>;
        activeId?: string | null;
        theme?: unknown;
      };

      if (Array.isArray(result.themes) && result.themes.length > 0) {
        const list: CustomThemeItem[] = [];
        for (const item of result.themes) {
          const normalized = normalizeImportedTheme(item.data);
          if (!normalized) continue;
          list.push({
            id: String(item.id),
            name: String(item.name || normalized.name || t('theme.custom')),
            data: normalized,
            createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
          });
          if (list.length >= MAX_CUSTOM_THEMES) break;
        }
        if (list.length > 0) {
          this.themes = list;
          this.activeId =
            result.activeId && list.some((t) => t.id === result.activeId)
              ? result.activeId
              : list[0].id;
          this.persistToLocalStorage();
          this.notifyListeners();
          return true;
        }
      } else if (result.theme) {
        // 单主题兜底
        const normalized = normalizeImportedTheme(result.theme);
        if (normalized) {
          const item: CustomThemeItem = {
            id: 'legacy',
            name: normalized.name || t('theme.custom'),
            data: normalized,
            createdAt: Date.now(),
          };
          this.themes = [item];
          this.activeId = 'legacy';
          this.persistToLocalStorage();
          this.notifyListeners();
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}

export const customThemeStore = new CustomThemeStore();

/**
 * 从主题数据中安全提取 3~4 个主要预览色块
 */
export function extractThemeColorSwatches(data: ImportedThemeData): string[] {
  const swatches: string[] = [];
  const ui = data.ui || {};
  const term = data.terminal || {};

  const candidates = [
    ui['--accent'] || term.cursor || term.brightGreen || '#00ff66',
    ui['--bg'] || term.background || '#121212',
    ui['--bg-surface'] || ui['--bg-elevated'] || term.selectionBackground || '#242424',
    ui['--accent-secondary'] || ui['--text'] || term.foreground || '#ffffff',
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      swatches.push(c.trim());
    }
  }

  return swatches.slice(0, 4);
}

/**
 * 自定义主题管理与上传弹窗组件
 */
export class CustomThemeModal {
  private modalEl: HTMLElement | null = null;
  private listContainer: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private dropzoneEl: HTMLElement | null = null;
  private onAppliedCallback?: (theme: CustomThemeItem) => void;
  private onClosedCallback?: () => void;
  private unsubscribeStore?: () => void;
  private previousActiveElement: HTMLElement | null = null;

  constructor() {
    this.render();
  }

  private render(): void {
    if (this.modalEl) return;

    this.modalEl = document.createElement('div');
    this.modalEl.id = 'custom-theme-modal';
    this.modalEl.className =
      'responsive-modal hidden fixed inset-0 z-[100] flex items-center justify-center';
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
    this.modalEl.setAttribute('aria-labelledby', 'custom-theme-modal-title');

    // 遮罩
    const backdrop = document.createElement('div');
    backdrop.id = 'custom-theme-modal-backdrop';
    backdrop.className = 'modal-overlay absolute inset-0';
    this.modalEl.appendChild(backdrop);

    // 主面板
    const panel = document.createElement('div');
    panel.className =
      'responsive-modal-panel cyber-box p-6 shadow-2xl relative z-10 w-full max-w-lg mx-4 flex flex-col max-h-[90vh]';

    // 顶部强调线
    const accentLine = document.createElement('div');
    accentLine.className =
      'theme-accent-line absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent opacity-50';
    panel.appendChild(accentLine);

    // 头部
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between mb-4 pb-3 border-b border-dim shrink-0';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'flex items-center gap-2';

    const titleIcon = document.createElement('span');
    titleIcon.className = 'material-symbols-outlined text-[var(--accent)] text-lg';
    titleIcon.textContent = 'palette';
    titleGroup.appendChild(titleIcon);

    const titleText = document.createElement('span');
    titleText.id = 'custom-theme-modal-title';
    titleText.className = 'text-sm font-bold tracking-[0.08em] text-[var(--accent)]';
    titleText.textContent = t('theme.manageTitle');
    titleGroup.appendChild(titleText);
    header.appendChild(titleGroup);

    const closeBtn = document.createElement('button');
    closeBtn.id = 'custom-theme-modal-close-btn';
    closeBtn.type = 'button';
    closeBtn.className = 'panel-close-btn';
    closeBtn.title = t('common.close');
    closeBtn.setAttribute('aria-label', t('common.close'));

    const closeIcon = document.createElement('span');
    closeIcon.className = 'material-symbols-outlined text-base';
    closeIcon.textContent = 'close';
    closeBtn.appendChild(closeIcon);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // 描述文案
    const desc = document.createElement('p');
    desc.className = 'text-xs text-muted mb-4 shrink-0';
    desc.textContent = t('theme.manageDesc');
    panel.appendChild(desc);

    // 滚动内容区
    const bodyScroll = document.createElement('div');
    bodyScroll.className = 'overflow-y-auto space-y-4 pr-1 flex-1 custom-theme-modal-body';

    // 列表容器
    this.listContainer = document.createElement('div');
    this.listContainer.id = 'custom-theme-items-container';
    this.listContainer.className = 'space-y-2';
    bodyScroll.appendChild(this.listContainer);

    // 拖拽上传区
    this.dropzoneEl = document.createElement('div');
    this.dropzoneEl.id = 'custom-theme-dropzone';
    this.dropzoneEl.className =
      'custom-theme-dropzone border-2 border-dashed border-dim hover:border-[var(--accent)] rounded-lg p-5 flex flex-col items-center justify-center text-center cursor-pointer transition-colors bg-surface-variant/40 hover:bg-surface-variant/70';

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.id = 'custom-theme-file-input';
    this.fileInput.accept = '.json';
    this.fileInput.className = 'hidden';
    this.dropzoneEl.appendChild(this.fileInput);

    const uploadIcon = document.createElement('span');
    uploadIcon.className = 'material-symbols-outlined text-2xl text-[var(--accent)] mb-1';
    uploadIcon.textContent = 'upload_file';
    this.dropzoneEl.appendChild(uploadIcon);

    const uploadTitle = document.createElement('span');
    uploadTitle.className = 'text-xs font-medium text-on-surface mb-0.5';
    uploadTitle.textContent = t('theme.uploadArea');
    this.dropzoneEl.appendChild(uploadTitle);

    const uploadHint = document.createElement('span');
    uploadHint.className = 'text-[11px] text-muted opacity-80';
    uploadHint.textContent = t('theme.uploadHint');
    this.dropzoneEl.appendChild(uploadHint);

    bodyScroll.appendChild(this.dropzoneEl);
    panel.appendChild(bodyScroll);

    // 底栏
    const footer = document.createElement('div');
    footer.className = 'flex items-center justify-between mt-4 pt-3 border-t border-dim shrink-0';

    const editorLink = document.createElement('a');
    editorLink.href = 'https://newbietan.github.io/CloudSSH/theme-editor/';
    editorLink.target = '_blank';
    editorLink.rel = 'noopener noreferrer';
    editorLink.className =
      'text-xs text-[var(--accent)] hover:underline flex items-center gap-1 opacity-90 hover:opacity-100';

    const linkIcon = document.createElement('span');
    linkIcon.className = 'material-symbols-outlined text-sm';
    linkIcon.textContent = 'open_in_new';
    editorLink.appendChild(linkIcon);

    const linkText = document.createElement('span');
    linkText.textContent = t('theme.openEditor');
    editorLink.appendChild(linkText);
    footer.appendChild(editorLink);

    const doneBtn = document.createElement('button');
    doneBtn.id = 'custom-theme-modal-done-btn';
    doneBtn.type = 'button';
    doneBtn.className = 'terminal-btn-primary px-4 py-1.5 text-xs rounded font-medium cursor-pointer';
    doneBtn.textContent = t('common.close');
    footer.appendChild(doneBtn);

    panel.appendChild(footer);
    this.modalEl.appendChild(panel);
    document.body.appendChild(this.modalEl);

    this.bindEvents(backdrop, closeBtn, doneBtn);
  }

  private bindEvents(
    backdrop: HTMLElement,
    closeBtn: HTMLButtonElement,
    doneBtn: HTMLButtonElement
  ): void {
    if (!this.modalEl) return;

    const handleClose = () => this.close();
    closeBtn.addEventListener('click', handleClose);
    doneBtn.addEventListener('click', handleClose);
    backdrop.addEventListener('click', handleClose);

    // 拖拽与点击上传
    if (this.dropzoneEl && this.fileInput) {
      this.dropzoneEl.addEventListener('click', () => {
        this.fileInput?.click();
      });

      this.dropzoneEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.dropzoneEl?.classList.add('border-[var(--accent)]', 'bg-surface-variant');
      });

      this.dropzoneEl.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.dropzoneEl?.classList.remove('border-[var(--accent)]', 'bg-surface-variant');
      });

      this.dropzoneEl.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.dropzoneEl?.classList.remove('border-[var(--accent)]', 'bg-surface-variant');
        const file = e.dataTransfer?.files?.[0];
        if (file) void this.handleFileUpload(file);
      });

      this.fileInput.addEventListener('change', (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) void this.handleFileUpload(file);
        if (this.fileInput) this.fileInput.value = '';
      });
    }

    // 键盘 Escape
    this.modalEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
  }

  private async handleFileUpload(file: File): Promise<void> {
    if (file.size > THEME_MAX_BYTES) {
      notify(t('theme.importFailed'), { title: t('theme.importTitle'), variant: 'danger' });
      return;
    }

    try {
      const text = await file.text();
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(text);
      } catch {
        notify(t('theme.invalidJson'), { title: t('theme.importTitle'), variant: 'danger' });
        return;
      }

      const normalized = normalizeImportedTheme(rawJson);
      if (!normalized) {
        notify(t('theme.importFailed'), { title: t('theme.importTitle'), variant: 'danger' });
        return;
      }

      // 文件名作为默认主题名（去掉 .json 扩展名）
      const baseFileName = file.name.replace(/\.[^/.]+$/, '').trim();
      const themeName = normalized.name || baseFileName || t('theme.custom');

      const newItem = await customThemeStore.addTheme(themeName, normalized);
      await customThemeStore.selectTheme(newItem.id);

      notify(t('theme.importSuccess'), { variant: 'success' });
      this.refreshList();

      if (this.onAppliedCallback) {
        this.onAppliedCallback(newItem);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('theme.importFailed');
      notify(msg, { title: t('theme.importTitle'), variant: 'danger' });
    }
  }

  public show(options?: {
    onApplied?: (theme: CustomThemeItem) => void;
    onClosed?: () => void;
  }): void {
    if (!this.modalEl) this.render();
    this.onAppliedCallback = options?.onApplied;
    this.onClosedCallback = options?.onClosed;
    this.previousActiveElement = document.activeElement as HTMLElement | null;

    this.refreshList();
    this.modalEl!.classList.remove('hidden');

    this.unsubscribeStore = customThemeStore.subscribe(() => {
      this.refreshList();
    });

    const closeBtn = this.modalEl!.querySelector<HTMLElement>('#custom-theme-modal-close-btn');
    closeBtn?.focus();
  }

  public close(): void {
    if (!this.modalEl || this.modalEl.classList.contains('hidden')) return;
    this.modalEl.classList.add('hidden');

    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = undefined;
    }

    if (this.previousActiveElement) {
      try {
        this.previousActiveElement.focus();
      } catch {
        // ignore
      }
      this.previousActiveElement = null;
    }

    if (this.onClosedCallback) {
      const cb = this.onClosedCallback;
      this.onClosedCallback = undefined;
      cb();
    }
  }

  public refreshList(): void {
    if (!this.listContainer) return;
    this.listContainer.replaceChildren();

    const themes = customThemeStore.getThemes();
    const activeId = customThemeStore.getActiveId();

    if (themes.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className =
        'p-4 rounded border border-dim text-center text-xs text-muted bg-surface/50';
      emptyDiv.textContent = t('theme.emptyList');
      this.listContainer.appendChild(emptyDiv);
      return;
    }

    for (const item of themes) {
      const isActive = item.id === activeId;
      const card = document.createElement('div');
      card.className = `flex items-center justify-between p-3 rounded-lg border transition-colors ${
        isActive
          ? 'border-[var(--accent)] bg-surface-variant/80'
          : 'border-dim bg-surface/60 hover:bg-surface-variant/40'
      }`;

      // 左侧信息与色块
      const leftPart = document.createElement('div');
      leftPart.className = 'flex items-center gap-3 min-w-0';

      // 色块预览条
      const swatchesContainer = document.createElement('div');
      swatchesContainer.className = 'flex items-center -space-x-1 shrink-0';
      const colors = extractThemeColorSwatches(item.data);
      for (const color of colors) {
        const dot = document.createElement('span');
        dot.className =
          'w-3.5 h-3.5 rounded-full border border-black/30 shadow-sm inline-block shrink-0';
        dot.style.backgroundColor = color;
        swatchesContainer.appendChild(dot);
      }
      leftPart.appendChild(swatchesContainer);

      // 名称与激活徽章
      const infoContainer = document.createElement('div');
      infoContainer.className = 'flex items-center gap-2 min-w-0';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'text-xs font-semibold text-on-surface truncate';
      nameSpan.textContent = item.name;
      nameSpan.title = item.name;
      infoContainer.appendChild(nameSpan);

      if (isActive) {
        const badge = document.createElement('span');
        badge.className =
          'px-1.5 py-0.5 text-[10px] font-bold rounded bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40 shrink-0';
        badge.textContent = t('theme.activeBadge');
        infoContainer.appendChild(badge);
      }
      leftPart.appendChild(infoContainer);

      // 右侧操作按钮
      const actionsPart = document.createElement('div');
      actionsPart.className = 'flex items-center gap-2 shrink-0 ml-2';

      if (!isActive) {
        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className =
          'text-xs px-2.5 py-1 rounded bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/30 hover:border-[var(--accent)]/60 cursor-pointer font-medium transition-colors';
        applyBtn.textContent = t('theme.applyAction');
        applyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await customThemeStore.selectTheme(item.id);
          this.refreshList();
          if (this.onAppliedCallback) {
            this.onAppliedCallback(item);
          }
        });
        actionsPart.appendChild(applyBtn);
      }

      // 删除按钮
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className =
        'p-1 text-muted hover:text-[var(--error)] rounded hover:bg-surface-variant transition-colors cursor-pointer flex items-center justify-center';
      deleteBtn.title = t('theme.deleteAction');
      deleteBtn.setAttribute('aria-label', `${t('theme.deleteAction')}: ${item.name}`);

      const deleteIcon = document.createElement('span');
      deleteIcon.className = 'material-symbols-outlined text-base';
      deleteIcon.textContent = 'delete';
      deleteBtn.appendChild(deleteIcon);

      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await confirmAction({
          title: t('theme.deleteAction'),
          message: t('theme.deleteConfirm', { name: item.name }),
          confirmText: t('theme.deleteAction'),
          cancelText: t('common.cancel'),
          variant: 'danger',
        });
        if (!confirmed) return;

        const { remainingCount, newActiveId } = await customThemeStore.removeTheme(item.id);
        notify(t('theme.deleteSuccess'), { variant: 'success' });
        this.refreshList();

        if (remainingCount > 0 && newActiveId) {
          const nextActive = customThemeStore.getActiveTheme();
          if (nextActive && this.onAppliedCallback) {
            this.onAppliedCallback(nextActive);
          }
        } else if (remainingCount === 0) {
          // 全部删除完，通知外部回退
          if (this.onAppliedCallback) {
            // 传空或由外部回退到默认
          }
        }
      });
      actionsPart.appendChild(deleteBtn);

      card.appendChild(leftPart);
      card.appendChild(actionsPart);
      this.listContainer.appendChild(card);
    }
  }
}

export const customThemeModal = new CustomThemeModal();
