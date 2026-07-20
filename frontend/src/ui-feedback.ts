export type FeedbackVariant = 'info' | 'success' | 'warning' | 'danger';

export interface NotificationOptions {
  title?: string;
  variant?: FeedbackVariant;
  duration?: number;
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: FeedbackVariant;
}

export interface PromptOptions extends ConfirmOptions {
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  validate?: (value: string) => string | null;
}

type DialogRequest =
  | {
      kind: 'confirm';
      options: ConfirmOptions;
      resolve: (value: boolean) => void;
      previousFocus: HTMLElement | null;
    }
  | {
      kind: 'prompt';
      options: PromptOptions;
      resolve: (value: string | null) => void;
      previousFocus: HTMLElement | null;
    };

const ICONS: Record<FeedbackVariant, string> = {
  info: 'info',
  success: 'check_circle',
  warning: 'warning',
  danger: 'error',
};

const DEFAULT_TITLES: Record<FeedbackVariant, string> = {
  info: '提示',
  success: '操作成功',
  warning: '请注意',
  danger: '操作失败',
};

let toastContainer: HTMLElement | null = null;

function getToastContainer(): HTMLElement {
  if (toastContainer?.isConnected) return toastContainer;

  toastContainer = document.createElement('div');
  toastContainer.className = 'app-toast-container';
  toastContainer.setAttribute('aria-live', 'polite');
  toastContainer.setAttribute('aria-atomic', 'false');
  document.body.appendChild(toastContainer);
  return toastContainer;
}

/** 显示非阻塞通知；错误会停留更久，鼠标悬停或聚焦时暂停计时。 */
export function notify(message: string, options: NotificationOptions = {}): void {
  const variant = options.variant ?? 'info';
  const duration = options.duration ?? (variant === 'danger' ? 7000 : 4500);
  const container = getToastContainer();
  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.dataset.variant = variant;
  toast.setAttribute('role', variant === 'danger' ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'app-toast__icon material-symbols-outlined';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = ICONS[variant];

  const content = document.createElement('div');
  content.className = 'app-toast__content';

  const title = document.createElement('div');
  title.className = 'app-toast__title';
  title.textContent = options.title ?? DEFAULT_TITLES[variant];

  const body = document.createElement('div');
  body.className = 'app-toast__message';
  body.textContent = message;

  const closeButton = document.createElement('button');
  closeButton.className = 'app-toast__close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '关闭通知');
  closeButton.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">close</span>';

  content.append(title, body);
  toast.append(icon, content, closeButton);
  container.appendChild(toast);

  while (container.children.length > 4) {
    container.firstElementChild?.remove();
  }

  let timeout: number | null = null;
  let removing = false;

  const stopTimer = (): void => {
    if (timeout !== null) {
      window.clearTimeout(timeout);
      timeout = null;
    }
  };
  const dismiss = (): void => {
    if (removing) return;
    removing = true;
    stopTimer();
    toast.classList.add('app-toast--leaving');
    window.setTimeout(() => toast.remove(), 220);
  };
  const startTimer = (): void => {
    if (duration > 0 && !removing) {
      timeout = window.setTimeout(dismiss, duration);
    }
  };

  closeButton.addEventListener('click', dismiss);
  toast.addEventListener('mouseenter', stopTimer);
  toast.addEventListener('mouseleave', startTimer);
  toast.addEventListener('focusin', stopTimer);
  toast.addEventListener('focusout', startTimer);

  requestAnimationFrame(() => toast.classList.add('app-toast--visible'));
  startTimer();
}

class DialogManager {
  private queue: DialogRequest[] = [];
  private active: DialogRequest | null = null;
  private dialog: HTMLDialogElement | null = null;
  private titleEl: HTMLElement | null = null;
  private messageEl: HTMLElement | null = null;
  private iconEl: HTMLElement | null = null;
  private inputGroup: HTMLElement | null = null;
  private inputLabel: HTMLLabelElement | null = null;
  private input: HTMLInputElement | null = null;
  private inputError: HTMLElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;

  enqueueConfirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      this.queue.push({ kind: 'confirm', options, resolve, previousFocus: null });
      this.showNext();
    });
  }

  enqueuePrompt(options: PromptOptions): Promise<string | null> {
    return new Promise((resolve) => {
      this.queue.push({ kind: 'prompt', options, resolve, previousFocus: null });
      this.showNext();
    });
  }

  private ensureDialog(): void {
    if (this.dialog?.isConnected) return;

    const dialog = document.createElement('dialog');
    dialog.className = 'app-dialog';
    dialog.setAttribute('aria-labelledby', 'app-dialog-title');
    dialog.setAttribute('aria-describedby', 'app-dialog-message');
    dialog.innerHTML = `
      <form class="app-dialog__panel" method="dialog" novalidate>
        <div class="app-dialog__accent" aria-hidden="true"></div>
        <div class="app-dialog__header">
          <span class="app-dialog__icon material-symbols-outlined" aria-hidden="true"></span>
          <h2 class="app-dialog__title" id="app-dialog-title"></h2>
        </div>
        <p class="app-dialog__message" id="app-dialog-message"></p>
        <div class="app-dialog__input-group" hidden>
          <label class="app-dialog__label" for="app-dialog-input"></label>
          <input class="app-dialog__input" id="app-dialog-input" type="text" autocomplete="off">
          <div class="app-dialog__error" id="app-dialog-error" role="alert"></div>
        </div>
        <div class="app-dialog__actions">
          <button class="app-dialog__button app-dialog__button--cancel" type="button"></button>
          <button class="app-dialog__button app-dialog__button--confirm" type="submit"></button>
        </div>
      </form>
    `;

    this.dialog = dialog;
    this.titleEl = dialog.querySelector('.app-dialog__title');
    this.messageEl = dialog.querySelector('.app-dialog__message');
    this.iconEl = dialog.querySelector('.app-dialog__icon');
    this.inputGroup = dialog.querySelector('.app-dialog__input-group');
    this.inputLabel = dialog.querySelector('.app-dialog__label');
    this.input = dialog.querySelector('.app-dialog__input');
    this.inputError = dialog.querySelector('.app-dialog__error');
    this.confirmButton = dialog.querySelector('.app-dialog__button--confirm');
    this.cancelButton = dialog.querySelector('.app-dialog__button--cancel');

    dialog.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    this.cancelButton?.addEventListener('click', () => this.cancel());
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.cancel();
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.cancel();
      }
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) this.cancel();
    });
    this.input?.addEventListener('input', () => this.clearInputError());
    this.input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submit();
      }
    });

    document.body.appendChild(dialog);
  }

  private showNext(): void {
    if (this.active || this.queue.length === 0) return;
    this.ensureDialog();

    const request = this.queue.shift()!;
    request.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.active = request;

    const options = request.options;
    const variant = options.variant ?? 'info';
    this.dialog!.dataset.variant = variant;
    this.titleEl!.textContent = options.title ?? (request.kind === 'prompt' ? '请输入' : '确认操作');
    this.messageEl!.textContent = options.message;
    this.iconEl!.textContent = ICONS[variant];
    this.confirmButton!.textContent = options.confirmText ?? '确定';
    this.cancelButton!.textContent = options.cancelText ?? '取消';
    this.clearInputError();

    if (request.kind === 'prompt') {
      this.inputGroup!.hidden = false;
      this.inputLabel!.textContent = request.options.label ?? '输入内容';
      this.input!.value = request.options.defaultValue ?? '';
      this.input!.placeholder = request.options.placeholder ?? '';
      if (request.options.maxLength) {
        this.input!.maxLength = request.options.maxLength;
      } else {
        this.input!.removeAttribute('maxlength');
      }
    } else {
      this.inputGroup!.hidden = true;
      this.input!.value = '';
    }

    this.dialog!.showModal();
    requestAnimationFrame(() => {
      if (request.kind === 'prompt') {
        this.input?.focus();
        this.input?.select();
      } else if (variant === 'danger') {
        this.cancelButton?.focus();
      } else {
        this.confirmButton?.focus();
      }
    });
  }

  private submit(): void {
    if (!this.active) return;

    if (this.active.kind === 'confirm') {
      this.settle(true);
      return;
    }

    const value = this.input?.value ?? '';
    const options = this.active.options;
    let error: string | null = null;
    if ((options.required ?? true) && !value.trim()) {
      error = '请输入内容';
    } else if (options.validate) {
      error = options.validate(value);
    }

    if (error) {
      this.inputError!.textContent = error;
      this.input!.setAttribute('aria-invalid', 'true');
      this.input!.setAttribute('aria-describedby', 'app-dialog-error');
      this.input!.focus();
      return;
    }

    this.settle(value);
  }

  private clearInputError(): void {
    if (!this.input || !this.inputError) return;
    this.inputError.textContent = '';
    this.input.removeAttribute('aria-invalid');
    this.input.removeAttribute('aria-describedby');
  }

  private cancel(): void {
    if (!this.active) return;
    this.settle(this.active.kind === 'confirm' ? false : null);
  }

  private settle(value: boolean | string | null): void {
    const request = this.active;
    if (!request) return;

    this.active = null;
    this.dialog?.close();

    if (request.kind === 'confirm') {
      request.resolve(value === true);
    } else {
      request.resolve(typeof value === 'string' ? value : null);
    }

    if (this.queue.length > 0) {
      queueMicrotask(() => this.showNext());
    } else {
      request.previousFocus?.focus();
    }
  }
}

const dialogManager = new DialogManager();

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return dialogManager.enqueueConfirm(options);
}

export function requestText(options: PromptOptions): Promise<string | null> {
  return dialogManager.enqueuePrompt(options);
}
