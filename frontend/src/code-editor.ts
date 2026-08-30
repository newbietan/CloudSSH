/**
 * SFTP 在线编辑器：CodeMirror 6 模态封装。
 *
 * 设计要点：
 * - 主题通过 CSS 变量（--bg-surface/--text/--accent 等）绑定应用 Theme V3，
 *   语法高亮使用 @lezer/highlight 的 classHighlighter，配色在 style.css 中
 *   以主题变量定义，天然跟随亮/暗/自定义主题。
 * - 编辑器内文本一律为 \n 换行、无 BOM 的规范化内容；BOM/EOL 的还原
 *   由 editor-content.ts 在保存编码时完成。
 * - 保存经 onSave 回调交由 SFTPPanel 执行（mtime 冲突检测 + 现有上传覆盖通道），
 *   本组件只负责 dirty 跟踪与保存触发（Ctrl+S / 按钮）。
 * - 对话框结构与样式遵循 app-dialog / auth-challenge-dialog 的既有设计令牌。
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { classHighlighter } from '@lezer/highlight';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { t, translateDocument } from './i18n';
import type { DecodedContent } from './editor-content';
import { confirmAction, notify } from './ui-feedback';

export interface RemoteEditorOptions {
  filename: string;
  path: string;
  content: DecodedContent;
  /** 只读模式（非 UTF-8 编码文件无法安全回写） */
  readOnly: boolean;
  /** 只读原因提示文案（已翻译） */
  notice?: string;
  /** 执行保存（冲突检测 + 上传），返回 true 表示保存成功 */
  onSave: () => Promise<boolean>;
  /** 编辑器关闭（无论是否保存） */
  onClose: () => void;
}

export interface RemoteEditorHandle {
  isDirty(): boolean;
  getContent(): string;
  markSaved(): void;
  focus(): void;
  close(): void;
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12.5px',
    backgroundColor: 'var(--bg-terminal)',
    color: 'var(--text)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    lineHeight: '1.55',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused > .cm-scroller > .cm-layer.cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    {
      backgroundColor: 'var(--accent-bg)',
    },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    color: 'var(--text-dim)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--bg-elevated)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--text-muted)',
  },
  '.cm-foldGutter span': {
    color: 'var(--text-dim)',
  },
  '.cm-foldGutter span:hover': {
    color: 'var(--accent)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--accent-bg)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--accent-bg)',
    outline: '1px solid var(--accent-secondary)',
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'var(--accent-secondary-light)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  },
  '.cm-panel input, .cm-panel button': {
    background: 'var(--bg-surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--control-radius, 6px)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  },
});

/** 语法高亮配色：全部映射主题变量，跟随亮/暗/自定义主题 */
const highlightTheme = syntaxHighlighting(classHighlighter, { fallback: true });

function languageExtensionFor(filename: string): Extension {
  const name = filename.toLowerCase();
  const dotIndex = name.lastIndexOf('.');
  const ext = dotIndex > 0 ? name.slice(dotIndex + 1) : '';

  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return javascript();
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'json':
      return json();
    case 'yml':
    case 'yaml':
      return yaml();
    case 'py':
      return python();
    case 'md':
    case 'markdown':
      return markdown();
    case 'html':
    case 'htm':
      return html();
    case 'css':
    case 'less':
    case 'scss':
      return css();
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'ksh':
      return StreamLanguage.define(shell);
    case 'conf':
    case 'ini':
    case 'cfg':
    case 'cnf':
    case 'env':
    case 'properties':
      return StreamLanguage.define(properties);
    case 'toml':
      return StreamLanguage.define(toml);
    case 'lua':
      return StreamLanguage.define(lua);
    default:
      if (name === 'dockerfile') return StreamLanguage.define(dockerFile);
      if (name.endsWith('.service') || name.endsWith('.socket') || name.endsWith('.timer')) {
        return StreamLanguage.define(properties);
      }
      return [];
  }
}

/** 自动换行偏好存储键（沿用 cloudssh_ 前缀约定） */
const WRAP_STORAGE_KEY = 'cloudssh_editor_wrap';

/**
 * 自动换行默认值（Issue #113）：触屏/窄屏默认开启——长行（URL、证书串等）
 * 在移动端横向拖动查看是明确痛点；桌面端默认关闭，由用户手动开启。
 * 检测口径与编辑器 16px 字号媒体查询保持一致（pointer: coarse 或 ≤520px）。
 */
function detectDefaultWrap(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 520;
}

function readStoredWrapPreference(): boolean | null {
  try {
    const stored = window.localStorage.getItem(WRAP_STORAGE_KEY);
    if (stored === 'on') return true;
    if (stored === 'off') return false;
  } catch {
    // 隐私模式等存储不可用场景回退设备默认值
  }
  return null;
}

function storeWrapPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(WRAP_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // 同上，忽略持久化失败，仅影响下次打开的默认值
  }
}

class RemoteEditor implements RemoteEditorHandle {
  private readonly dialog: HTMLDialogElement;
  private readonly view: EditorView;
  private readonly options: RemoteEditorOptions;
  private readonly statusEl: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly wrapCompartment = new Compartment();
  private wrapButton: HTMLButtonElement | null = null;
  private wrapEnabled = false;
  private baseline: string;
  private saving = false;
  private closed = false;

  constructor(options: RemoteEditorOptions) {
    this.options = options;
    this.baseline = options.content.text;
    this.wrapEnabled = readStoredWrapPreference() ?? detectDefaultWrap();

    this.dialog = this.buildDialog();
    document.body.appendChild(this.dialog);

    const bodyEl = this.dialog.querySelector('.remote-editor__body') as HTMLElement;
    const titleEl = this.dialog.querySelector('.remote-editor__title') as HTMLElement;
    const pathEl = this.dialog.querySelector('.remote-editor__path') as HTMLElement;
    const noticeEl = this.dialog.querySelector('.remote-editor__notice') as HTMLElement;
    this.statusEl = this.dialog.querySelector('.remote-editor__status') as HTMLElement;
    const closeButton = this.dialog.querySelector('.remote-editor__close') as HTMLButtonElement;
    const discardButton = this.dialog.querySelector(
      '.remote-editor__button--cancel'
    ) as HTMLButtonElement;
    this.saveButton = this.dialog.querySelector(
      '.remote-editor__button--save'
    ) as HTMLButtonElement;
    this.wrapButton = this.dialog.querySelector(
      '.remote-editor__button--wrap'
    ) as HTMLButtonElement;

    titleEl.textContent = options.filename;
    pathEl.textContent = options.path;

    if (options.readOnly) {
      noticeEl.textContent = options.notice ?? '';
      noticeEl.hidden = !noticeEl.textContent;
    }

    discardButton.textContent = t('common.close');
    this.saveButton.textContent = t('common.save');
    this.saveButton.disabled = options.readOnly;
    translateDocument(this.dialog);

    closeButton.addEventListener('click', () => void this.requestClose());
    discardButton.addEventListener('click', () => void this.requestClose());
    this.saveButton.addEventListener('click', () => void this.requestSave());
    this.wrapButton.addEventListener('click', () => this.toggleWrap());
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      void this.requestClose();
    });
    this.dialog.addEventListener('close', () => this.destroy());

    this.view = new EditorView({
      parent: bodyEl,
      state: this.buildState(),
    });

    this.updateStatus();
    this.syncWrapButton();
    this.dialog.showModal();
    this.view.focus();
  }

  private buildDialog(): HTMLDialogElement {
    const dialog = document.createElement('dialog');
    dialog.className = 'remote-editor';
    dialog.setAttribute('aria-label', t('sftp.editorTitle', { name: this.options.filename }));

    // 静态模板，动态内容（文件名/路径）一律 textContent 写入
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    dialog.innerHTML = `
      <div class="remote-editor__panel">
        <div class="remote-editor__header">
          <span class="material-symbols-outlined remote-editor__icon" aria-hidden="true">edit_note</span>
          <div class="remote-editor__titles">
            <h2 class="remote-editor__title"></h2>
            <span class="remote-editor__path"></span>
          </div>
          <button type="button" class="remote-editor__close" data-i18n-title="common.close" aria-label="关闭">
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
        <div class="remote-editor__notice" role="note" hidden></div>
        <div class="remote-editor__body"></div>
        <div class="remote-editor__footer">
          <span class="remote-editor__status"></span>
          <div class="remote-editor__actions">
            <button type="button" class="remote-editor__button remote-editor__button--wrap" data-i18n="sftp.editorWrap" data-i18n-title="sftp.editorWrapTitle" aria-pressed="false"></button>
            <button type="button" class="remote-editor__button remote-editor__button--cancel"></button>
            <button type="button" class="remote-editor__button remote-editor__button--save"></button>
          </div>
        </div>
      </div>
    `;
    return dialog;
  }

  private buildState(): EditorState {
    const extensions: Extension[] = [
      lineNumbers(),
      foldGutter(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      indentOnInput(),
      search({ top: true }),
      highlightSelectionMatches(),
      rectangularSelection(),
      crosshairCursor(),
      highlightTheme,
      editorTheme,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            void this.requestSave();
            return true;
          },
        },
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      languageExtensionFor(this.options.filename),
      this.wrapCompartment.of(this.wrapEnabled ? EditorView.lineWrapping : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) this.updateStatus();
      }),
    ];

    if (this.options.readOnly) {
      extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    }

    return EditorState.create({ doc: this.options.content.text, extensions });
  }

  isDirty(): boolean {
    return this.view.state.doc.toString() !== this.baseline;
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  markSaved(): void {
    this.baseline = this.view.state.doc.toString();
    this.updateStatus();
  }

  focus(): void {
    if (!this.closed) this.view.focus();
  }

  /** 切换自动换行（Issue #113）：Compartment 动态重配置 + 偏好持久化 */
  private toggleWrap(): void {
    this.wrapEnabled = !this.wrapEnabled;
    this.view.dispatch({
      effects: this.wrapCompartment.reconfigure(
        this.wrapEnabled ? EditorView.lineWrapping : []
      ),
    });
    storeWrapPreference(this.wrapEnabled);
    this.syncWrapButton();
    this.view.focus();
  }

  private syncWrapButton(): void {
    this.wrapButton?.setAttribute('aria-pressed', String(this.wrapEnabled));
  }

  /** 立即关闭（不经确认）：面板会话拆除等强制场景使用 */
  close(): void {
    this.destroy();
  }

  private updateStatus(): void {
    if (this.closed) return;
    const encoding =
      this.options.content.encoding === 'gb18030'
        ? t('sftp.editorEncodingGb18030')
        : t('sftp.editorEncodingUtf8');
    const eol = this.options.content.eol === '\r\n' ? 'CRLF' : 'LF';
    const state = this.isDirty() ? t('sftp.editorStatusDirty') : t('sftp.editorStatusSaved');
    this.statusEl.textContent = `${encoding} · ${eol} · ${state}`;
    if (!this.options.readOnly && !this.saving) {
      this.saveButton.disabled = !this.isDirty();
    }
  }

  private async requestSave(): Promise<void> {
    if (this.closed || this.saving || this.options.readOnly) return;
    if (!this.isDirty()) {
      notify(t('sftp.editorNoChanges'));
      return;
    }

    this.saving = true;
    this.saveButton.disabled = true;
    const savedLabel = this.saveButton.textContent;
    this.saveButton.textContent = t('sftp.editorSaving');
    try {
      const ok = await this.options.onSave();
      if (ok) this.baseline = this.view.state.doc.toString();
    } finally {
      this.saving = false;
      this.saveButton.disabled = this.options.readOnly || !this.isDirty();
      this.saveButton.textContent = savedLabel ?? t('common.save');
      this.updateStatus();
    }
  }

  /** 关闭前确认：有未保存修改时经用户确认才丢弃 */
  private async requestClose(): Promise<void> {
    if (this.closed) return;
    if (this.saving) {
      notify(t('sftp.editorSavingWait'));
      return;
    }
    if (this.isDirty() && !this.options.readOnly) {
      const discard = await confirmAction({
        title: t('sftp.editorDirtyTitle'),
        message: t('sftp.editorDirtyMessage', { name: this.options.filename }),
        confirmText: t('sftp.editorDiscard'),
        cancelText: t('common.cancel'),
        variant: 'danger',
      });
      if (!discard) {
        this.focus();
        return;
      }
    }
    this.destroy();
  }

  private destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.view.destroy();
    this.dialog.close();
    this.dialog.remove();
    this.options.onClose();
  }
}

export function openRemoteEditor(options: RemoteEditorOptions): RemoteEditorHandle {
  return new RemoteEditor(options);
}
