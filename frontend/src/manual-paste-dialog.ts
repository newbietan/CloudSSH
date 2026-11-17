import { onLocaleChange, t } from './i18n';

export const MAX_MANUAL_PASTE_CHARS = 64 * 1024;

/** Explicit, ephemeral fallback. Closing/aborting destroys the textarea, never stores its contents. */
export function requestManualPaste(signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'app-dialog terminal-paste-dialog';
    dialog.dataset.variant = 'warning';
    const form = document.createElement('form');
    form.className = 'app-dialog__panel';
    const title = document.createElement('h2');
    title.className = 'app-dialog__title';
    const hint = document.createElement('p');
    hint.className = 'app-dialog__message';
    const textarea = document.createElement('textarea');
    textarea.className = 'app-dialog__input';
    textarea.rows = 5;
    textarea.autocomplete = 'off';
    textarea.autocapitalize = 'off';
    textarea.spellcheck = false;
    const error = document.createElement('p');
    error.className = 'app-dialog__error';
    error.setAttribute('role', 'alert');
    const actions = document.createElement('div');
    actions.className = 'app-dialog__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'app-dialog__button app-dialog__button--cancel';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'app-dialog__button app-dialog__button--confirm';
    submit.disabled = true;
    actions.append(cancel, submit);
    form.append(title, hint, textarea, error, actions);
    dialog.append(form);
    let settled = false;
    let composing = false;
    let tooLarge = false;
    const translate = () => {
      title.textContent = t('terminal.manualPasteTitle');
      dialog.setAttribute('aria-label', title.textContent);
      hint.textContent = t('terminal.manualPasteHint');
      textarea.setAttribute('aria-label', t('terminal.manualPasteText'));
      cancel.textContent = t('common.cancel');
      submit.textContent = t('terminal.manualPasteConfirm');
      error.textContent = tooLarge ? t('terminal.manualPasteTooLarge') : '';
    };
    const cleanupLocale = onLocaleChange(translate);
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      cleanupLocale();
      signal.removeEventListener('abort', abort);
      textarea.value = '';
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const abort = () => finish(null);
    const validate = () => {
      tooLarge = textarea.value.length > MAX_MANUAL_PASTE_CHARS;
      submit.disabled = composing || tooLarge || textarea.value.length === 0;
      error.textContent = tooLarge ? t('terminal.manualPasteTooLarge') : '';
      textarea.setAttribute('aria-invalid', String(tooLarge));
    };
    textarea.addEventListener('input', validate);
    textarea.addEventListener('paste', event => {
      const text = event.clipboardData?.getData('text/plain');
      if (text !== undefined && textarea.value.length - (textarea.selectionEnd - textarea.selectionStart) + text.length > MAX_MANUAL_PASTE_CHARS) {
        event.preventDefault();
        error.textContent = t('terminal.manualPasteTooLarge');
      }
    });
    textarea.addEventListener('compositionstart', () => { composing = true; validate(); });
    textarea.addEventListener('compositionend', () => { composing = false; validate(); });
    textarea.addEventListener('blur', () => { composing = false; validate(); });
    dialog.addEventListener('keydown', event => {
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); finish(null); }
      // Enter in the textarea remains a newline, never an implicit send shortcut.
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!composing) finish(null); });
    dialog.addEventListener('close', () => finish(null));
    cancel.addEventListener('click', () => finish(null));
    form.addEventListener('submit', event => {
      event.preventDefault();
      validate();
      if (!signal.aborted && !submit.disabled) finish(textarea.value);
    });
    signal.addEventListener('abort', abort, { once: true });
    translate();
    document.body.append(dialog);
    dialog.showModal();
    textarea.focus();
  });
}
