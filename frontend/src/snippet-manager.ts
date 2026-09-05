/**
 * 命令片段管理面板（issue #90, #124）。
 *
 * - 登录用户走 /api/snippets 云端存储；匿名用户降级 localStorage。
 * - UI 重构为对齐 SFTP 面板的右侧滑出抽屉（Slide-over Drawer Panel）。
 * - 支持分类体系（方案 A：全部分类 / 单分类过滤胶囊 / 未分类）。
 * - 默认动作“填入终端”不附加回车，由用户在命令行确认后再执行；
 *   “填入并执行”才会在填入后追加一个回车。
 * - 片段是用户个人数据：一次性分享会话（sharedSessionMode）中不展示入口。
 */
import {
  SNIPPET_CATEGORY_MAX_LENGTH,
  SNIPPET_COMMAND_MAX_LENGTH,
  SNIPPET_MAX_COUNT,
  SNIPPET_NAME_MAX_LENGTH,
} from '../../src/snippet-schema';
import { copyTextToClipboard } from './clipboard';
import { onLocaleChange, t } from './i18n';
import {
  type CommandSnippet,
  LocalSnippetStore,
  RemoteSnippetStore,
  type SnippetStore,
  snippetErrorMessage,
} from './snippet-store';
import {
  extractSnippetVariables,
  resolveSnippetVariables,
} from './snippet-variables';
import type { SSHTerminal } from './terminal';
import { confirmAction, notify, requestText } from './ui-feedback';

export interface SnippetManagerDeps {
  /** 返回当前激活标签页的终端；无激活会话时返回 null。 */
  getTerminal: () => SSHTerminal | null;
  /** 是否已登录（决定云端/本地存储后端）。 */
  isAuthenticated: () => boolean;
}

export const PANEL_ID = 'snippet-panel';
export const BACKDROP_ID = 'snippet-panel-backdrop';

export const CATEGORY_ALL = '';
export const CATEGORY_UNCATEGORIZED = '__UNCATEGORIZED__';

/**
 * 纯函数：根据搜索关键词与分类过滤命令片段（名称、命令或分类模糊匹配）。
 */
export function filterSnippets(
  snippets: CommandSnippet[],
  query: string,
  selectedCategory: string = CATEGORY_ALL
): CommandSnippet[] {
  const trimmedQuery = query.trim().toLowerCase();
  const trimmedCategory = selectedCategory.trim().toLowerCase();

  return snippets.filter((s) => {
    // 1. 分类匹配
    if (trimmedCategory && trimmedCategory !== CATEGORY_ALL.toLowerCase()) {
      const snippetCategory = (s.category || '').trim().toLowerCase();
      if (trimmedCategory === CATEGORY_UNCATEGORIZED.toLowerCase()) {
        if (snippetCategory !== '') return false;
      } else {
        if (snippetCategory !== trimmedCategory) return false;
      }
    }

    // 2. 关键词模糊匹配（名称、命令、分类）
    if (trimmedQuery) {
      const nameMatch = s.name.toLowerCase().includes(trimmedQuery);
      const commandMatch = s.command.toLowerCase().includes(trimmedQuery);
      const categoryMatch = (s.category || '').toLowerCase().includes(trimmedQuery);
      if (!nameMatch && !commandMatch && !categoryMatch) return false;
    }

    return true;
  });
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createIcon(name: string, fontSize = '16px'): HTMLSpanElement {
  const span = createElement('span', 'material-symbols-outlined', name);
  span.style.fontSize = fontSize;
  return span;
}

export class SnippetManager {
  private panelContainer: HTMLElement | null = null;
  private backdropElement: HTMLElement | null = null;
  private snippets: CommandSnippet[] = [];
  private editingId: string | null = null;
  private busy = false;
  private searchQuery = '';
  private selectedCategory = CATEGORY_ALL;
  private visible = false;
  private formExpanded = false;
  private localeCleanup: (() => void) | null = null;
  private readonly keydownHandler = (e: KeyboardEvent): void => {
    if (!this.visible || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  };

  constructor(private readonly deps: SnippetManagerDeps) {
    this.localeCleanup = onLocaleChange(() => {
      if (this.visible) {
        this.updateStorageBadge();
        this.render();
      }
    });
  }

  private get store(): SnippetStore {
    return this.deps.isAuthenticated() ? new RemoteSnippetStore() : new LocalSnippetStore();
  }

  async open(): Promise<void> {
    this.ensureElements();
    if (!this.panelContainer || !this.backdropElement) return;

    this.visible = true;
    this.backdropElement.classList.remove('opacity-0', 'pointer-events-none');
    this.panelContainer.style.transform = 'translateX(0)';

    this.updateStorageBadge();
    await this.reload();

    window.addEventListener('keydown', this.keydownHandler);

    const searchInput = document.getElementById('snippet-search-input') as HTMLInputElement | null;
    searchInput?.focus();
  }

  close(): void {
    if (!this.panelContainer || !this.backdropElement) return;

    window.removeEventListener('keydown', this.keydownHandler);

    this.visible = false;
    this.backdropElement.classList.add('opacity-0', 'pointer-events-none');
    this.panelContainer.style.transform = 'translateX(100%)';

    this.searchQuery = '';
    const searchInput = document.getElementById('snippet-search-input') as HTMLInputElement | null;
    if (searchInput) searchInput.value = '';
    const clearBtn = document.getElementById('snippet-search-clear-btn');
    if (clearBtn) clearBtn.classList.add('hidden');

    this.collapseForm();
  }

  toggle(): void {
    if (this.visible) {
      this.close();
    } else {
      void this.open();
    }
  }

  destroy(): void {
    window.removeEventListener('keydown', this.keydownHandler);
    if (this.localeCleanup) {
      this.localeCleanup();
      this.localeCleanup = null;
    }
    this.panelContainer?.remove();
    this.backdropElement?.remove();
    this.panelContainer = null;
    this.backdropElement = null;
  }

  // ==================== 数据加载 ====================

  private async reload(): Promise<void> {
    const listEl = document.getElementById('snippet-list');
    try {
      this.snippets = await this.store.list();
      this.render();
    } catch {
      if (listEl) listEl.textContent = t('snippets.loadFailed');
      notify(t('snippets.loadFailed'), { variant: 'danger' });
    }
  }

  // ==================== DOM 构建 ====================

  private ensureElements(): void {
    if (this.panelContainer && this.backdropElement) return;

    // 半透明背景遮罩（点击收起）
    const backdrop = createElement(
      'div',
      'fixed inset-0 bg-black/40 z-[95] transition-opacity duration-300 opacity-0 pointer-events-none'
    );
    backdrop.id = BACKDROP_ID;
    backdrop.addEventListener('click', () => this.close());
    this.backdropElement = backdrop;
    document.body.appendChild(backdrop);

    // 抽屉面板（对齐 SFTP 布局与转场动画）
    const panel = createElement(
      'div',
      'fixed top-0 right-0 h-full z-[96] flex flex-col bg-surface border-l border-outline-variant shadow-2xl transition-transform duration-300 ease-in-out text-on-surface'
    );
    panel.id = PANEL_ID;
    panel.style.width = 'min(clamp(440px, 45vw, 680px), 100vw)';
    panel.style.transform = 'translateX(100%)';
    this.panelContainer = panel;

    // 1. Header 栏
    panel.appendChild(this.createHeader());

    // 2. Toolbar 栏
    panel.appendChild(this.createToolbar());

    // 3. Category Chips 分类胶囊栏
    const chipsBar = createElement(
      'div',
      'px-3 py-2 border-b border-outline-variant bg-surface shrink-0 overflow-x-auto no-scrollbar flex items-center gap-1.5 select-none'
    );
    chipsBar.id = 'snippet-category-chips';
    panel.appendChild(chipsBar);

    // 4. 新增 / 编辑表单（折叠容器）
    panel.appendChild(this.createForm());

    // 5. 片段列表区域
    const list = createElement(
      'div',
      'flex-1 overflow-y-auto p-3 space-y-2.5 custom-scrollbar min-h-0'
    );
    list.id = 'snippet-list';
    list.addEventListener('click', (event) => {
      void this.handleListClick(event);
    });
    panel.appendChild(list);

    // 6. 底栏 Footer
    panel.appendChild(this.createFooter());

    // 键盘 Esc 关闭
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.close();
      }
    });

    document.body.appendChild(panel);
  }

  private createHeader(): HTMLElement {
    const header = createElement(
      'div',
      'sftp-panel-header flex items-center justify-between px-4 h-12 border-b border-outline-variant bg-elevated shrink-0'
    );

    const titleBlock = createElement('div', 'flex items-center gap-2 min-w-0');
    const icon = createIcon('code_blocks', '18px');
    icon.className = 'material-symbols-outlined text-primary-container';
    icon.style.fontVariationSettings = "'FILL' 1";
    titleBlock.appendChild(icon);

    const title = createElement(
      'span',
      'text-xs font-bold tracking-[0.1em] text-primary-container truncate',
      t('snippets.title')
    );
    titleBlock.appendChild(title);

    const badge = createElement(
      'span',
      'flex items-center gap-1.5 text-[11px] text-muted select-none'
    );
    badge.id = 'snippet-storage-badge';
    titleBlock.appendChild(badge);
    header.appendChild(titleBlock);

    const closeBtn = createElement(
      'button',
      'hover:opacity-80 transition-opacity cursor-pointer p-1 text-on-surface-variant'
    );
    closeBtn.id = 'snippet-close-btn';
    closeBtn.type = 'button';
    closeBtn.title = t('snippets.close');
    closeBtn.setAttribute('aria-label', t('snippets.close'));
    closeBtn.appendChild(createIcon('close', '18px'));
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);

    return header;
  }

  private createToolbar(): HTMLElement {
    const toolbar = createElement(
      'div',
      'px-3 py-2 border-b border-outline-variant bg-surface flex items-center gap-2 shrink-0'
    );

    // 搜索输入框
    const searchWrapper = createElement(
      'div',
      'flex-1 relative flex items-center min-w-0 h-[30px] rounded border border-outline-variant bg-surface-variant/20 focus-within:border-primary-container'
    );
    const searchIcon = createIcon('search', '15px');
    searchIcon.className =
      'material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none select-none';
    searchWrapper.appendChild(searchIcon);

    const searchInput = createElement(
      'input',
      'w-full h-full bg-transparent text-[12px] outline-none terminal-input border-0 font-ui'
    );
    searchInput.id = 'snippet-search-input';
    searchInput.type = 'search';
    searchInput.placeholder = t('snippets.searchPlaceholder');
    searchInput.style.paddingLeft = '32px';
    searchInput.style.paddingRight = '28px';

    const clearBtn = createElement(
      'button',
      'absolute right-1.5 top-1/2 -translate-y-1/2 text-muted hover:text-primary p-0.5 cursor-pointer hidden'
    );
    clearBtn.id = 'snippet-search-clear-btn';
    clearBtn.type = 'button';
    clearBtn.title = t('common.cancel');
    clearBtn.setAttribute('aria-label', t('common.cancel'));
    clearBtn.appendChild(createIcon('close', '14px'));
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      this.searchQuery = '';
      clearBtn.classList.add('hidden');
      this.renderList();
      searchInput.focus();
    });
    searchWrapper.appendChild(clearBtn);

    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      clearBtn.classList.toggle('hidden', !searchInput.value.trim());
      this.renderList();
    });
    searchWrapper.appendChild(searchInput);
    toolbar.appendChild(searchWrapper);

    // “新建片段” 按钮
    const newBtn = createElement(
      'button',
      'flex items-center gap-1 px-2.5 py-1 h-[30px] text-[11px] font-bold tracking-wider cyber-button text-primary-container shrink-0 cursor-pointer'
    );
    newBtn.id = 'snippet-new-btn';
    newBtn.type = 'button';
    newBtn.appendChild(createIcon('add', '16px'));
    const newBtnLabel = createElement('span', undefined, t('snippets.newSnippet'));
    newBtnLabel.id = 'snippet-new-btn-label';
    newBtn.appendChild(newBtnLabel);
    newBtn.addEventListener('click', () => {
      if (this.formExpanded && this.editingId === null) {
        this.collapseForm();
      } else {
        this.expandForm();
      }
    });
    toolbar.appendChild(newBtn);

    // 刷新按钮
    const refreshBtn = createElement(
      'button',
      'p-1.5 h-[30px] w-[30px] hover:bg-surface-variant rounded transition-colors cursor-pointer text-muted hover:text-primary flex items-center justify-center shrink-0'
    );
    refreshBtn.id = 'snippet-refresh-btn';
    refreshBtn.type = 'button';
    refreshBtn.title = t('sftp.refresh');
    refreshBtn.appendChild(createIcon('refresh', '16px'));
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.classList.add('animate-spin');
      try {
        await this.reload();
      } finally {
        setTimeout(() => refreshBtn.classList.remove('animate-spin'), 300);
      }
    });
    toolbar.appendChild(refreshBtn);

    return toolbar;
  }

  private createForm(): HTMLElement {
    const container = createElement(
      'div',
      'border-b border-outline-variant bg-surface-variant/10 p-3 space-y-2.5 shrink-0 hidden'
    );
    container.id = 'snippet-form-container';

    // 表单标题
    const headerRow = createElement('div', 'flex items-center justify-between');
    const titleBlock = createElement(
      'div',
      'text-xs font-bold text-primary-container flex items-center gap-1.5'
    );
    const formIcon = createIcon('add_box', '16px');
    formIcon.id = 'snippet-form-icon';
    titleBlock.appendChild(formIcon);
    const formTitle = createElement('span', undefined, t('snippets.newSnippet'));
    formTitle.id = 'snippet-form-title';
    titleBlock.appendChild(formTitle);
    headerRow.appendChild(titleBlock);

    const closeFormBtn = createElement(
      'button',
      'text-muted hover:text-primary text-xs cursor-pointer p-0.5'
    );
    closeFormBtn.type = 'button';
    closeFormBtn.title = t('common.cancel');
    closeFormBtn.appendChild(createIcon('close', '14px'));
    closeFormBtn.addEventListener('click', () => this.collapseForm());
    headerRow.appendChild(closeFormBtn);
    container.appendChild(headerRow);

    const form = createElement('form', 'space-y-2.5');
    form.id = 'snippet-form';
    form.autocomplete = 'off';

    // 第一行：名称 + 分类
    const row1 = createElement('div', 'grid grid-cols-1 sm:grid-cols-2 gap-2');

    const nameLabel = createElement('label', 'text-[11px] text-muted block', t('snippets.nameLabel'));
    nameLabel.htmlFor = 'snippet-name-input';
    const nameInput = createElement(
      'input',
      'terminal-input w-full mt-1 text-xs h-[28px] border border-outline-variant bg-surface'
    );
    nameInput.id = 'snippet-name-input';
    nameInput.maxLength = SNIPPET_NAME_MAX_LENGTH;
    nameInput.placeholder = t('snippets.namePlaceholder');
    nameLabel.appendChild(nameInput);
    row1.appendChild(nameLabel);

    const catLabel = createElement(
      'label',
      'text-[11px] text-muted block',
      t('snippets.categoryLabel')
    );
    catLabel.htmlFor = 'snippet-category-input';
    const catInput = createElement(
      'input',
      'terminal-input w-full mt-1 text-xs h-[28px] border border-outline-variant bg-surface'
    );
    catInput.id = 'snippet-category-input';
    catInput.maxLength = SNIPPET_CATEGORY_MAX_LENGTH;
    catInput.placeholder = t('snippets.categoryPlaceholder');
    catInput.setAttribute('list', 'snippet-category-datalist');
    catLabel.appendChild(catInput);

    const datalist = createElement('datalist');
    datalist.id = 'snippet-category-datalist';
    catLabel.appendChild(datalist);
    row1.appendChild(catLabel);
    form.appendChild(row1);

    // 第二行：命令
    const cmdLabel = createElement(
      'label',
      'text-[11px] text-muted block',
      t('snippets.commandLabel')
    );
    cmdLabel.htmlFor = 'snippet-command-input';
    const cmdInput = createElement(
      'textarea',
      'terminal-input w-full mt-1 font-code text-xs border border-outline-variant bg-surface custom-scrollbar'
    );
    cmdInput.id = 'snippet-command-input';
    cmdInput.rows = 3;
    cmdInput.maxLength = SNIPPET_COMMAND_MAX_LENGTH;
    cmdInput.placeholder = t('snippets.commandPlaceholder');
    cmdLabel.appendChild(cmdInput);
    form.appendChild(cmdLabel);

    // 参数占位符说明（使用 [!] 代替 emoji 图标）
    const hint = createElement(
      'p',
      'text-[11px] text-muted opacity-80 select-none leading-relaxed font-ui flex items-center gap-1'
    );
    const hintPrefix = createElement(
      'span',
      'text-primary-container font-code font-bold text-[11px]',
      '[!]'
    );
    hint.appendChild(hintPrefix);
    const hintBody = createElement(
      'span',
      undefined,
      t('snippets.variableHint').replace(/^\[!\]\s*/, '')
    );
    hint.appendChild(hintBody);
    form.appendChild(hint);

    // 操作按钮
    const actions = createElement('div', 'flex items-center justify-end gap-2 pt-1');

    const cancelBtn = createElement(
      'button',
      'cyber-button px-3 py-1 text-xs text-muted cursor-pointer',
      t('common.cancel')
    );
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => this.collapseForm());
    actions.appendChild(cancelBtn);

    const saveBtn = createElement(
      'button',
      'cyber-button text-primary-container px-4 py-1 text-xs font-bold flex items-center gap-1 cursor-pointer'
    );
    saveBtn.type = 'submit';
    saveBtn.id = 'snippet-save-btn';
    saveBtn.appendChild(createIcon('save', '14px'));
    const saveLabel = createElement('span', undefined, t('common.save'));
    saveLabel.id = 'snippet-save-label';
    saveBtn.appendChild(saveLabel);
    actions.appendChild(saveBtn);

    form.appendChild(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.save();
    });
    container.appendChild(form);

    return container;
  }

  private createFooter(): HTMLElement {
    const footer = createElement(
      'div',
      'h-10 border-t border-outline-variant bg-elevated px-4 flex items-center justify-between text-[11px] text-muted shrink-0 select-none'
    );
    const statusText = createElement('span');
    statusText.id = 'snippet-footer-status';
    footer.appendChild(statusText);

    const escHint = createElement('span', 'text-[10px] opacity-60', 'Esc');
    footer.appendChild(escHint);

    return footer;
  }

  // ==================== 状态与提示渲染 ====================

  private updateStorageBadge(): void {
    const badge = document.getElementById('snippet-storage-badge');
    if (!badge) return;
    const isAuth = this.deps.isAuthenticated();
    badge.textContent = '';

    const dot = createElement(
      'span',
      `w-1.5 h-1.5 rounded-full shrink-0 ${
        isAuth ? 'bg-primary-container shadow-[0_0_6px_var(--accent)]' : 'bg-muted/60'
      }`
    );
    const label = createElement(
      'span',
      'text-[11px] text-muted select-none',
      isAuth ? t('snippets.cloudSync') : t('snippets.localStore')
    );
    badge.appendChild(dot);
    badge.appendChild(label);
  }

  private render(): void {
    this.renderCategoryChips();
    this.updateCategorySuggestions();
    this.renderList();
  }

  private updateCategorySuggestions(): void {
    const datalist = document.getElementById('snippet-category-datalist');
    if (!datalist) return;
    datalist.textContent = '';
    const categories = [
      ...new Set(
        this.snippets
          .map((s) => (s.category || '').trim())
          .filter((cat) => cat.length > 0)
      ),
    ].sort((a, b) => a.localeCompare(b));

    for (const cat of categories) {
      const option = createElement('option');
      option.value = cat;
      datalist.appendChild(option);
    }
  }

  private renderCategoryChips(): void {
    const chipsBar = document.getElementById('snippet-category-chips');
    if (!chipsBar) return;
    chipsBar.textContent = '';

    const catCounts = new Map<string, number>();
    let uncategorizedCount = 0;

    for (const snippet of this.snippets) {
      const cat = (snippet.category || '').trim();
      if (!cat) {
        uncategorizedCount++;
      } else {
        catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
      }
    }

    interface ChipItem {
      key: string;
      label: string;
      count: number;
    }

    const chips: ChipItem[] = [
      { key: CATEGORY_ALL, label: t('snippets.allCategories'), count: this.snippets.length },
    ];

    const sortedCats = [...catCounts.keys()].sort((a, b) => a.localeCompare(b));
    for (const cat of sortedCats) {
      chips.push({ key: cat, label: cat, count: catCounts.get(cat) || 0 });
    }

    if (uncategorizedCount > 0) {
      chips.push({
        key: CATEGORY_UNCATEGORIZED,
        label: t('snippets.uncategorized'),
        count: uncategorizedCount,
      });
    }

    for (const chip of chips) {
      const isActive = this.selectedCategory.toLowerCase() === chip.key.toLowerCase();
      const btn = createElement(
        'button',
        `shrink-0 text-[11px] px-2.5 py-0.5 rounded-full border transition-all cursor-pointer flex items-center gap-1.5 ${
          isActive
            ? 'bg-primary-container/20 text-primary-container border-primary-container font-bold shadow-sm'
            : 'border-outline-variant/60 hover:border-primary-container/60 text-muted hover:text-primary bg-surface-variant/20'
        }`
      );
      btn.type = 'button';

      const label = createElement('span', undefined, chip.label);
      btn.appendChild(label);

      const countBadge = createElement(
        'span',
        `text-[10px] px-1 rounded-full ${
          isActive ? 'bg-primary-container text-on-primary font-bold' : 'bg-surface-variant/50 text-muted'
        }`,
        String(chip.count)
      );
      btn.appendChild(countBadge);

      btn.addEventListener('click', () => {
        if (this.selectedCategory !== chip.key) {
          this.selectedCategory = chip.key;
          this.render();
        }
      });
      chipsBar.appendChild(btn);
    }
  }

  private renderList(): void {
    const listEl = document.getElementById('snippet-list');
    const footerStatus = document.getElementById('snippet-footer-status');
    if (!listEl) return;
    listEl.textContent = '';

    const filtered = filterSnippets(this.snippets, this.searchQuery, this.selectedCategory);

    if (footerStatus) {
      footerStatus.textContent = `${t('snippets.statusCount', {
        filtered: filtered.length,
        total: this.snippets.length,
      })} · ${t('snippets.capacity', {
        count: this.snippets.length,
        max: SNIPPET_MAX_COUNT,
      })}`;
    }

    if (this.snippets.length === 0) {
      const emptyBox = createElement(
        'div',
        'flex flex-col items-center justify-center h-48 text-muted space-y-2'
      );
      const icon = createIcon('inbox', '36px');
      icon.className = 'material-symbols-outlined opacity-40';
      emptyBox.appendChild(icon);
      emptyBox.appendChild(createElement('p', 'text-xs', t('snippets.empty')));
      listEl.appendChild(emptyBox);
      return;
    }

    if (filtered.length === 0) {
      const emptyBox = createElement(
        'div',
        'flex flex-col items-center justify-center h-48 text-muted space-y-2'
      );
      const icon = createIcon('search_off', '36px');
      icon.className = 'material-symbols-outlined opacity-40';
      emptyBox.appendChild(icon);
      emptyBox.appendChild(createElement('p', 'text-xs', t('snippets.noMatches')));
      listEl.appendChild(emptyBox);
      return;
    }

    for (const snippet of filtered) {
      listEl.appendChild(this.buildSnippetCard(snippet));
    }
  }

  private buildSnippetCard(snippet: CommandSnippet): HTMLElement {
    const card = createElement(
      'div',
      'border border-outline-variant/70 hover:border-primary-container/80 bg-surface-variant/10 rounded p-3 transition-all space-y-2'
    );
    card.dataset.snippetId = snippet.id;

    // 卡片头部：名称 + 分类徽标 + 动态变量标记 + 操作按钮组
    const headerRow = createElement('div', 'flex items-start justify-between gap-2');

    const infoCol = createElement('div', 'flex-1 min-w-0');
    const nameEl = createElement(
      'div',
      'text-xs font-bold text-primary-container truncate',
      snippet.name
    );
    infoCol.appendChild(nameEl);

    const badges = createElement('div', 'flex items-center gap-2 mt-1 flex-wrap');

    // 分类 Tag（轻量标签元数据展示，避免伪装成可点击按钮）
    if (snippet.category && snippet.category.trim()) {
      const catTag = createElement(
        'span',
        'text-[11px] text-muted/80 flex items-center gap-0.5 select-none'
      );
      const prefix = createElement(
        'span',
        'text-primary-container font-code font-bold text-[11px]',
        '#'
      );
      const name = createElement('span', undefined, snippet.category.trim());
      catTag.appendChild(prefix);
      catTag.appendChild(name);
      badges.appendChild(catTag);
    }

    // 变量标识（文本元数据展示，避免伪装成按钮）
    const variables = extractSnippetVariables(snippet.command);
    if (variables.length > 0) {
      const varTag = createElement(
        'span',
        'text-[11px] text-muted/70 flex items-center gap-1 select-none font-code'
      );
      const varSymbol = createElement(
        'span',
        'text-secondary-container text-[11px]',
        '{ }'
      );
      const varText = createElement(
        'span',
        'font-ui text-[11px]',
        `${t('snippets.hasVariables')} (${variables.map((v) => `{{${v}}}`).join(', ')})`
      );
      varTag.appendChild(varSymbol);
      varTag.appendChild(varText);
      badges.appendChild(varTag);
    }
    infoCol.appendChild(badges);
    headerRow.appendChild(infoCol);

    // 操作按钮组
    const actions = createElement('div', 'flex items-center gap-1 shrink-0');
    actions.appendChild(
      this.buildActionButton('copy', 'content_copy', t('common.copy'), 'hover:text-primary-container')
    );
    actions.appendChild(
      this.buildActionButton('insert', 'input', t('snippets.insert'), 'hover:text-primary-container')
    );
    actions.appendChild(
      this.buildActionButton(
        'insert_and_run',
        'play_arrow',
        t('snippets.insertAndRun'),
        'hover:text-secondary-container'
      )
    );
    actions.appendChild(
      this.buildActionButton('edit', 'edit', t('common.edit'), 'hover:text-primary-container')
    );
    actions.appendChild(
      this.buildActionButton('delete', 'delete', t('common.delete'), 'hover:text-error')
    );
    headerRow.appendChild(actions);
    card.appendChild(headerRow);

    // 命令预览代码框
    const codeBlock = createElement(
      'div',
      'bg-surface-container-lowest border border-outline-variant/40 rounded p-2 text-[11px] font-code text-on-surface-variant break-all overflow-x-auto no-scrollbar max-h-[72px] leading-relaxed select-text',
      snippet.command
    );
    codeBlock.style.whiteSpace = 'pre-wrap';
    card.appendChild(codeBlock);

    return card;
  }

  private buildActionButton(
    action: string,
    icon: string,
    label: string,
    hoverColor = 'hover:text-primary'
  ): HTMLButtonElement {
    const button = createElement(
      'button',
      `text-muted ${hoverColor} p-1 rounded hover:bg-surface-variant/40 transition-colors cursor-pointer shrink-0`
    );
    button.type = 'button';
    button.dataset.action = action;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.appendChild(createIcon(icon, '15px'));
    return button;
  }

  // ==================== 表单折叠与展开 ====================

  private expandForm(snippet?: CommandSnippet): void {
    const container = document.getElementById('snippet-form-container');
    const formTitle = document.getElementById('snippet-form-title');
    const formIcon = document.getElementById('snippet-form-icon');
    const nameInput = document.getElementById('snippet-name-input') as HTMLInputElement | null;
    const catInput = document.getElementById('snippet-category-input') as HTMLInputElement | null;
    const cmdInput = document.getElementById('snippet-command-input') as HTMLTextAreaElement | null;
    const saveLabel = document.getElementById('snippet-save-label');
    const newBtnLabel = document.getElementById('snippet-new-btn-label');

    if (!container) return;

    this.formExpanded = true;
    container.classList.remove('hidden');

    if (snippet) {
      this.editingId = snippet.id;
      if (formTitle) formTitle.textContent = t('snippets.editing');
      if (formIcon) formIcon.textContent = 'edit_note';
      if (saveLabel) saveLabel.textContent = t('common.save');
      if (nameInput) nameInput.value = snippet.name;
      if (catInput) catInput.value = snippet.category || '';
      if (cmdInput) cmdInput.value = snippet.command;
      if (newBtnLabel) newBtnLabel.textContent = t('snippets.newSnippet');
    } else {
      this.editingId = null;
      if (formTitle) formTitle.textContent = t('snippets.newSnippet');
      if (formIcon) formIcon.textContent = 'add_box';
      if (saveLabel) saveLabel.textContent = t('snippets.add');
      if (nameInput) nameInput.value = '';
      if (catInput) {
        catInput.value =
          this.selectedCategory && this.selectedCategory !== CATEGORY_UNCATEGORIZED
            ? this.selectedCategory
            : '';
      }
      if (cmdInput) cmdInput.value = '';
      if (newBtnLabel) newBtnLabel.textContent = t('common.cancel');
    }

    nameInput?.focus();
  }

  private collapseForm(): void {
    const container = document.getElementById('snippet-form-container');
    const newBtnLabel = document.getElementById('snippet-new-btn-label');
    if (container) container.classList.add('hidden');
    if (newBtnLabel) newBtnLabel.textContent = t('snippets.newSnippet');
    this.formExpanded = false;
    this.editingId = null;

    const nameInput = document.getElementById('snippet-name-input') as HTMLInputElement | null;
    const catInput = document.getElementById('snippet-category-input') as HTMLInputElement | null;
    const cmdInput = document.getElementById('snippet-command-input') as HTMLTextAreaElement | null;
    if (nameInput) nameInput.value = '';
    if (catInput) catInput.value = '';
    if (cmdInput) cmdInput.value = '';
  }

  // ==================== 交互动作 ====================

  private async handleListClick(event: Event): Promise<void> {
    const target = event.target as HTMLElement | null;
    const actionEl = target?.closest<HTMLElement>('[data-action]');
    if (!actionEl) return;
    const card = actionEl.closest<HTMLElement>('[data-snippet-id]');
    const snippet = this.snippets.find((item) => item.id === card?.dataset.snippetId);
    if (!snippet) return;

    const action = actionEl.dataset.action;
    if (action === 'insert') await this.insertSnippet(snippet, false);
    else if (action === 'insert_and_run') await this.insertSnippet(snippet, true);
    else if (action === 'copy') void this.copySnippet(snippet);
    else if (action === 'edit') this.expandForm(snippet);
    else if (action === 'delete') await this.deleteSnippet(snippet);
  }

  private async copySnippet(snippet: CommandSnippet): Promise<void> {
    const success = await copyTextToClipboard(snippet.command);
    if (success) {
      notify(t('snippets.copied'), { variant: 'success' });
    } else {
      notify(t('snippets.copyFailed'), { variant: 'danger' });
    }
  }

  private async insertSnippet(snippet: CommandSnippet, run: boolean): Promise<void> {
    const terminal = this.deps.getTerminal();
    if (!terminal) {
      notify(t('snippets.noActiveTerminal'), { variant: 'warning' });
      return;
    }

    let finalCommand = snippet.command;
    const variables = extractSnippetVariables(snippet.command);
    if (variables.length > 0) {
      const values = {} as Record<string, string>;
      for (const varName of variables) {
        const val = await requestText({
          title: t('snippets.variableTitle'),
          message: t('snippets.promptVariable', { name: varName }),
          label: varName,
          placeholder: varName,
          confirmText: t('common.confirm'),
          cancelText: t('common.cancel'),
        });
        if (val === null) {
          // 用户取消参数输入，安全中止
          return;
        }
        values[varName] = val;
      }
      finalCommand = resolveSnippetVariables(snippet.command, values);
    }

    if (!terminal.insertSnippet(finalCommand, run)) {
      notify(t('snippets.insertFailed'), { variant: 'warning' });
      return;
    }
    this.close();
  }

  private async save(): Promise<void> {
    if (this.busy) return;
    const nameInput = document.getElementById('snippet-name-input') as HTMLInputElement | null;
    const catInput = document.getElementById('snippet-category-input') as HTMLInputElement | null;
    const cmdInput = document.getElementById('snippet-command-input') as HTMLTextAreaElement | null;
    const saveBtn = document.getElementById('snippet-save-btn') as HTMLButtonElement | null;
    if (!nameInput || !cmdInput) return;

    const name = nameInput.value;
    const category = catInput?.value ?? '';
    const command = cmdInput.value;

    this.busy = true;
    if (saveBtn) saveBtn.disabled = true;
    try {
      if (this.editingId) {
        await this.store.update(this.editingId, name, command, category);
      } else {
        await this.store.create(name, command, category);
      }
      notify(t('snippets.saved'), { variant: 'success' });
      this.collapseForm();
      await this.reload();
    } catch (err) {
      notify(snippetErrorMessage(err), { variant: 'danger' });
    } finally {
      this.busy = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  private async deleteSnippet(snippet: CommandSnippet): Promise<void> {
    const confirmed = await confirmAction({
      title: t('snippets.deleteTitle'),
      message: t('snippets.deleteMessage', { name: snippet.name }),
      confirmText: t('common.delete'),
    });
    if (!confirmed) return;
    try {
      await this.store.remove(snippet.id);
      notify(t('snippets.deleted'), { variant: 'success' });
      await this.reload();
    } catch (err) {
      notify(snippetErrorMessage(err), { variant: 'danger' });
    }
  }
}
