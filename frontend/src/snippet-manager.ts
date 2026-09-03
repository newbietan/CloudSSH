/**
 * 命令片段管理面板（issue #90）。
 *
 * - 登录用户走 /api/snippets 云端存储；匿名用户降级 localStorage。
 * - 默认动作“填入终端”不附加回车，由用户在命令行确认后再执行；
 *   “填入并执行”才会在填入后追加一个回车。
 * - 片段是用户个人数据：一次性分享会话（sharedSessionMode）中不展示入口。
 */
import { copyTextToClipboard } from './clipboard';
import { t } from './i18n';
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

const MODAL_ID = 'snippet-manager-modal';

/**
 * 纯函数：根据搜索关键词过滤命令片段（名称或命令模糊匹配）。
 */
export function filterSnippets(snippets: CommandSnippet[], query: string): CommandSnippet[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return snippets;
  return snippets.filter(
    (s) => s.name.toLowerCase().includes(trimmed) || s.command.toLowerCase().includes(trimmed)
  );
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
  private snippets: CommandSnippet[] = [];
  private editingId: string | null = null;
  private busy = false;
  private searchQuery = '';

  constructor(private readonly deps: SnippetManagerDeps) {}

  private get store(): SnippetStore {
    return this.deps.isAuthenticated() ? new RemoteSnippetStore() : new LocalSnippetStore();
  }

  async open(): Promise<void> {
    this.ensureModal();
    const modal = document.getElementById(MODAL_ID);
    modal?.classList.remove('hidden');
    modal?.classList.add('flex');
    this.updateHint();
    await this.reload();
    document.getElementById('snippet-name-input')?.focus();
  }

  close(): void {
    const modal = document.getElementById(MODAL_ID);
    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
    this.searchQuery = '';
    const searchInput = document.getElementById('snippet-search-input') as HTMLInputElement | null;
    if (searchInput) searchInput.value = '';
    this.resetForm();
  }

  // ==================== 数据加载 ====================

  private async reload(): Promise<void> {
    const listEl = document.getElementById('snippet-list');
    try {
      this.snippets = await this.store.list();
      this.renderList();
    } catch {
      if (listEl) listEl.textContent = t('snippets.loadFailed');
      notify(t('snippets.loadFailed'), { variant: 'danger' });
    }
  }

  // ==================== 渲染 ====================

  private ensureModal(): void {
    if (document.getElementById(MODAL_ID)) return;
    const modal = createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'responsive-modal hidden fixed inset-0 z-[120] items-center justify-center';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const overlay = createElement('div', 'modal-overlay absolute inset-0');
    overlay.dataset.snippetClose = '';
    modal.appendChild(overlay);

    const panel = createElement(
      'div',
      'responsive-modal-panel cyber-box p-6 shadow-2xl relative z-10 w-full max-w-2xl mx-4 max-h-[85vh] overflow-y-auto custom-scrollbar'
    );
    modal.appendChild(panel);

    // 头部：标题 + 匿名提示 + 关闭按钮
    const header = createElement(
      'div',
      'flex items-center justify-between mb-5 pb-4 border-b border-dim'
    );
    const titleBlock = createElement('div');
    titleBlock.appendChild(
      createElement('h2', 'text-sm font-bold text-primary', t('snippets.title'))
    );
    const hint = createElement('p', 'text-xs text-muted mt-1 hidden', t('snippets.anonymousHint'));
    hint.id = 'snippet-manager-hint';
    titleBlock.appendChild(hint);
    header.appendChild(titleBlock);
    const closeButton = createElement('button', 'text-muted hover:text-primary');
    closeButton.type = 'button';
    closeButton.dataset.snippetClose = '';
    closeButton.setAttribute('aria-label', t('common.close'));
    closeButton.appendChild(createElement('span', 'material-symbols-outlined', 'close'));
    header.appendChild(closeButton);
    panel.appendChild(header);

    // 表单：名称 + 命令 + 保存/取消
    const form = createElement('form', 'mb-6 space-y-3');
    form.id = 'snippet-form';
    form.autocomplete = 'off';

    const nameLabel = createElement('label', 'text-xs text-muted block', t('snippets.nameLabel'));
    nameLabel.htmlFor = 'snippet-name-input';
    const nameInput = createElement('input', 'terminal-input w-full mt-1');
    nameInput.id = 'snippet-name-input';
    nameInput.maxLength = 50;
    nameInput.placeholder = t('snippets.namePlaceholder');
    nameLabel.appendChild(nameInput);
    form.appendChild(nameLabel);

    const commandLabel = createElement(
      'label',
      'text-xs text-muted block',
      t('snippets.commandLabel')
    );
    commandLabel.htmlFor = 'snippet-command-input';
    const commandInput = createElement('textarea', 'terminal-input w-full mt-1 font-code');
    commandInput.id = 'snippet-command-input';
    commandInput.rows = 3;
    commandInput.maxLength = 2000;
    commandInput.placeholder = t('snippets.commandPlaceholder');
    commandLabel.appendChild(commandInput);
    form.appendChild(commandLabel);

    const actions = createElement('div', 'flex items-center gap-3');
    const saveButton = createElement(
      'button',
      'cyber-button text-primary px-4 py-2 text-xs font-bold flex items-center gap-2'
    );
    saveButton.type = 'submit';
    saveButton.id = 'snippet-save-btn';
    saveButton.appendChild(createIcon('save'));
    const saveLabel = createElement('span', undefined, t('snippets.add'));
    saveLabel.dataset.snippetSaveLabel = '';
    saveButton.appendChild(saveLabel);
    actions.appendChild(saveButton);

    const cancelEditButton = createElement(
      'button',
      'cyber-button px-4 py-2 text-xs text-muted hidden',
      t('common.cancel')
    );
    cancelEditButton.type = 'button';
    cancelEditButton.id = 'snippet-cancel-edit-btn';
    actions.appendChild(cancelEditButton);
    form.appendChild(actions);
    panel.appendChild(form);

    // 列表区：标题 + 计数 + 搜索框 + 列表容器
    const listSection = createElement('div', 'pt-4 border-t border-dim');
    const listHeader = createElement('div', 'flex items-center justify-between mb-2');
    listHeader.appendChild(
      createElement('h3', 'text-xs font-bold text-primary', t('snippets.title'))
    );
    const count = createElement('span', 'text-[11px] text-muted');
    count.id = 'snippet-count';
    listHeader.appendChild(count);
    listSection.appendChild(listHeader);

    const searchInput = createElement('input', 'terminal-input w-full text-xs px-2.5 py-1 mb-3');
    searchInput.id = 'snippet-search-input';
    searchInput.type = 'search';
    searchInput.placeholder = t('snippets.searchPlaceholder');
    listSection.appendChild(searchInput);

    const list = createElement('div', 'space-y-2');
    list.id = 'snippet-list';
    listSection.appendChild(list);
    panel.appendChild(listSection);

    document.body.appendChild(modal);

    modal.querySelectorAll('[data-snippet-close]').forEach((element) => {
      element.addEventListener('click', () => this.close());
    });
    modal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
    });
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.renderList();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.save();
    });
    cancelEditButton.addEventListener('click', () => this.resetForm());
    list.addEventListener('click', (event) => {
      void this.handleListClick(event);
    });
  }

  private updateHint(): void {
    const hint = document.getElementById('snippet-manager-hint');
    if (!hint) return;
    hint.classList.toggle('hidden', this.deps.isAuthenticated());
  }

  private renderList(): void {
    const listEl = document.getElementById('snippet-list');
    const countEl = document.getElementById('snippet-count');
    if (!listEl) return;
    listEl.textContent = '';

    const filtered = filterSnippets(this.snippets, this.searchQuery);

    if (countEl) {
      if (this.searchQuery.trim()) {
        countEl.textContent = t('snippets.filteredCount', {
          filtered: filtered.length,
          total: this.snippets.length,
        });
      } else {
        countEl.textContent =
          this.snippets.length > 0 ? t('snippets.count', { count: this.snippets.length }) : '';
      }
    }

    if (this.snippets.length === 0) {
      listEl.appendChild(createElement('p', 'text-xs text-muted', t('snippets.empty')));
      return;
    }

    if (filtered.length === 0) {
      listEl.appendChild(createElement('p', 'text-xs text-muted', t('snippets.noMatches')));
      return;
    }

    for (const snippet of filtered) {
      listEl.appendChild(this.buildItem(snippet));
    }
  }

  private buildItem(snippet: CommandSnippet): HTMLElement {
    const row = createElement('div', 'border border-dim p-3 flex items-start gap-3');
    row.dataset.snippetId = snippet.id;

    // 主体按钮：点击填入终端（不自动执行）
    const body = createElement('button', 'flex-1 min-w-0 text-left cursor-pointer');
    body.type = 'button';
    body.dataset.action = 'insert';
    body.title = t('snippets.insert');
    body.appendChild(createElement('div', 'text-xs font-bold text-primary truncate', snippet.name));
    const command = createElement(
      'div',
      'text-[11px] text-muted font-code mt-1 overflow-hidden',
      snippet.command
    );
    command.style.whiteSpace = 'pre-wrap';
    command.style.maxHeight = '3.2em';
    body.appendChild(command);
    row.appendChild(body);

    row.appendChild(this.buildActionButton('copy', 'content_copy', t('common.copy')));
    row.appendChild(
      this.buildActionButton('insert_and_run', 'play_arrow', t('snippets.insertAndRun'))
    );
    row.appendChild(this.buildActionButton('edit', 'edit', t('common.edit')));
    row.appendChild(this.buildActionButton('delete', 'delete', t('common.delete')));
    return row;
  }

  private buildActionButton(action: string, icon: string, label: string): HTMLButtonElement {
    const button = createElement('button', 'text-muted hover:text-primary p-1 shrink-0');
    button.type = 'button';
    button.dataset.action = action;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.appendChild(createIcon(icon));
    return button;
  }

  // ==================== 交互 ====================

  private async handleListClick(event: Event): Promise<void> {
    const target = event.target as HTMLElement | null;
    const actionEl = target?.closest<HTMLElement>('[data-action]');
    if (!actionEl) return;
    const row = actionEl.closest<HTMLElement>('[data-snippet-id]');
    const snippet = this.snippets.find((item) => item.id === row?.dataset.snippetId);
    if (!snippet) return;

    const action = actionEl.dataset.action;
    if (action === 'insert') await this.insertSnippet(snippet, false);
    else if (action === 'insert_and_run') await this.insertSnippet(snippet, true);
    else if (action === 'copy') void this.copySnippet(snippet);
    else if (action === 'edit') this.startEdit(snippet);
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
      const values: Record<string, string> = {};
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
          // 用户取消输入参数，中止本次填入
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

  private startEdit(snippet: CommandSnippet): void {
    this.editingId = snippet.id;
    const nameInput = document.getElementById('snippet-name-input') as HTMLInputElement | null;
    const commandInput = document.getElementById(
      'snippet-command-input'
    ) as HTMLTextAreaElement | null;
    if (nameInput) nameInput.value = snippet.name;
    if (commandInput) commandInput.value = snippet.command;
    const saveLabel = document.querySelector('[data-snippet-save-label]');
    if (saveLabel) saveLabel.textContent = t('snippets.editing');
    document.getElementById('snippet-cancel-edit-btn')?.classList.remove('hidden');
    nameInput?.focus();
  }

  private resetForm(): void {
    this.editingId = null;
    const nameInput = document.getElementById('snippet-name-input') as HTMLInputElement | null;
    const commandInput = document.getElementById(
      'snippet-command-input'
    ) as HTMLTextAreaElement | null;
    if (nameInput) nameInput.value = '';
    if (commandInput) commandInput.value = '';
    const saveLabel = document.querySelector('[data-snippet-save-label]');
    if (saveLabel) saveLabel.textContent = t('snippets.add');
    document.getElementById('snippet-cancel-edit-btn')?.classList.add('hidden');
  }

  private async save(): Promise<void> {
    if (this.busy) return;
    const nameInput = document.getElementById('snippet-name-input') as HTMLInputElement | null;
    const commandInput = document.getElementById(
      'snippet-command-input'
    ) as HTMLTextAreaElement | null;
    const saveBtn = document.getElementById('snippet-save-btn') as HTMLButtonElement | null;
    if (!nameInput || !commandInput) return;

    this.busy = true;
    if (saveBtn) saveBtn.disabled = true;
    try {
      if (this.editingId) {
        await this.store.update(this.editingId, nameInput.value, commandInput.value);
      } else {
        await this.store.create(nameInput.value, commandInput.value);
      }
      notify(t('snippets.saved'), { variant: 'success' });
      this.resetForm();
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
