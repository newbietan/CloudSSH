/**
 * 管理员密码登录 —— 浏览器内 ADMIN_PASSWORD_HASH 生成器对话框。
 *
 * 面向 Dashboard-only 部署（无本地 Node 工具）的自托管用户：在已部署站点中
 * 输入自定义密码，浏览器本地（WebCrypto PBKDF2）生成可直接粘贴到
 * Cloudflare Dashboard 变量 ADMIN_PASSWORD_HASH 的哈希串。原始密码不离开浏览器。
 * 入口：匿名/GitHub 模式的认证页脚链接（设置/切换场景）+ 密码模式坏哈希错误面板
 * 的"重新生成"链接（修复场景）。改密码路径见 README（置空 → 重设）。
 */
import { t, type TranslationKey } from './i18n';
import { buildAdminPasswordHash, MIN_PASSWORD_LENGTH } from './password-stretch';
import { copyTextToClipboard } from './clipboard';
import { notify } from './ui-feedback';

const DIALOG_ID = 'admin-hash-generator-dialog';

function appendField(
  form: HTMLFormElement,
  labelKey: TranslationKey,
  inputId: string
): HTMLInputElement {
  const label = document.createElement('label');
  label.className = 'auth-challenge-dialog__label';
  label.textContent = t(labelKey);
  label.setAttribute('for', inputId);
  const input = document.createElement('input');
  input.type = 'password';
  input.id = inputId;
  input.className = 'auth-challenge-dialog__input';
  input.autocomplete = 'new-password';
  input.setAttribute('data-i18n-aria-label', labelKey);
  input.setAttribute('aria-label', t(labelKey));
  form.append(label, input);
  return input;
}

/** 打开生成器对话框（单实例：已存在则先销毁重建） */
export function openAdminHashGeneratorDialog(): void {
  document.getElementById(DIALOG_ID)?.remove();

  const dialog = document.createElement('dialog');
  dialog.id = DIALOG_ID;
  dialog.className = 'auth-challenge-dialog';
  dialog.setAttribute('aria-modal', 'true');

  const form = document.createElement('form');
  form.className = 'auth-challenge-dialog__panel';
  form.method = 'dialog';
  form.noValidate = true;

  const accent = document.createElement('div');
  accent.className = 'auth-challenge-dialog__accent';
  accent.setAttribute('aria-hidden', 'true');

  const header = document.createElement('div');
  header.className = 'auth-challenge-dialog__header';
  const icon = document.createElement('span');
  icon.className = 'auth-challenge-dialog__icon material-symbols-outlined';
  icon.textContent = 'password';
  icon.setAttribute('aria-hidden', 'true');
  const title = document.createElement('h2');
  title.className = 'auth-challenge-dialog__title';
  title.textContent = t('auth.adminHashGenTitle');
  header.append(icon, title);

  const description = document.createElement('div');
  description.className = 'auth-challenge-dialog__description';
  description.textContent = t('auth.adminHashGenHint');

  const passwordInput = appendField(form, 'auth.adminHashGenPassword', 'admin-hash-password');
  const confirmInput = appendField(form, 'auth.adminHashGenConfirm', 'admin-hash-confirm');

  const errorText = document.createElement('div');
  errorText.className = 'auth-challenge-dialog__warning';
  errorText.setAttribute('role', 'alert');
  errorText.style.display = 'none';

  const resultLabel = document.createElement('label');
  resultLabel.className = 'auth-challenge-dialog__label';
  resultLabel.textContent = t('auth.adminHashGenResultLabel');
  resultLabel.setAttribute('for', 'admin-hash-result');
  resultLabel.style.display = 'none';
  const resultInput = document.createElement('input');
  resultInput.type = 'text';
  resultInput.id = 'admin-hash-result';
  resultInput.readOnly = true;
  resultInput.className = 'auth-challenge-dialog__input';
  resultInput.setAttribute('aria-label', t('auth.adminHashGenResultLabel'));
  resultInput.style.display = 'none';
  resultInput.addEventListener('focus', () => resultInput.select());

  const steps = document.createElement('div');
  steps.className = 'admin-hash-gen-steps';
  steps.setAttribute('data-i18n', 'auth.adminHashGenSteps');
  steps.setAttribute('role', 'note');
  steps.textContent = t('auth.adminHashGenSteps');
  steps.style.display = 'none';

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'auth-challenge-dialog__button auth-challenge-dialog__button--submit';
  copyButton.textContent = t('auth.adminHashGenCopy');
  copyButton.style.display = 'none';

  const actions = document.createElement('div');
  actions.className = 'auth-challenge-dialog__actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'auth-challenge-dialog__button auth-challenge-dialog__button--cancel';
  cancelButton.textContent = t('common.close');
  const generateButton = document.createElement('button');
  generateButton.type = 'button';
  generateButton.className = 'auth-challenge-dialog__button auth-challenge-dialog__button--submit';
  generateButton.textContent = t('auth.adminHashGenGenerate');
  actions.append(cancelButton, generateButton);

  form.append(
    accent,
    header,
    description,
    errorText,
    resultLabel,
    resultInput,
    steps,
    copyButton,
    actions
  );
  dialog.appendChild(form);
  document.body.appendChild(dialog);

  const closeDialog = (): void => {
    // 密码字段随 DOM 销毁，不残留内存外展示
    dialog.remove();
  };

  const showError = (message: string): void => {
    errorText.textContent = message;
    errorText.style.display = '';
  };

  let pending = false;
  const generate = async (): Promise<void> => {
    if (pending) return;
    const password = passwordInput.value;
    if (password.length < MIN_PASSWORD_LENGTH) {
      showError(t('auth.adminHashGenTooShort'));
      passwordInput.focus();
      return;
    }
    if (password !== confirmInput.value) {
      showError(t('auth.adminHashGenMismatch'));
      confirmInput.focus();
      return;
    }

    pending = true;
    generateButton.disabled = true;
    errorText.style.display = 'none';
    try {
      // 浏览器本地 PBKDF2（默认 60 万次迭代约需数百毫秒，一次性设置成本可接受）
      const hash = await buildAdminPasswordHash(password);
      resultInput.value = hash;
      resultLabel.style.display = '';
      resultInput.style.display = '';
      steps.style.display = '';
      copyButton.style.display = '';
    } catch {
      showError(t('auth.adminHashGenNetwork'));
    } finally {
      pending = false;
      generateButton.disabled = false;
    }
  };

  const copyResult = async (): Promise<void> => {
    if (!resultInput.value) return;
    const ok = await copyTextToClipboard(resultInput.value);
    if (ok) {
      notify(t('auth.adminHashGenCopied'), { variant: 'success' });
    } else {
      resultInput.select();
    }
  };

  cancelButton.addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeDialog();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void generate();
  });
  generateButton.addEventListener('click', () => void generate());
  copyButton.addEventListener('click', () => void copyResult());

  dialog.showModal();
  passwordInput.focus();
}
