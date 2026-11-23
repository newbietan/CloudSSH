import { localizedElement, t } from './i18n';
import { isEncryptedPrivateKey, PrivateKeyUnlockError, unlockPrivateKey } from './private-key-unlock';
import { confirmAction, notify, requestText } from './ui-feedback';

/** Shared local file picker. Selecting a key populates the draft; it never connects, uploads or saves. */
export function bindPrivateKeyFile(
  container: HTMLElement, textarea: HTMLTextAreaElement, inputId: string, signal?: AbortSignal,
): () => void {
  const input = document.createElement('input');
  input.id = inputId;
  input.type = 'file'; // No accept filter: OpenSSH filenames include id_ed25519.
  input.className = 'peer sr-only';
  const label = document.createElement('label');
  label.htmlFor = inputId;
  label.className = 'text-[11px] text-muted hover:text-primary cursor-pointer flex items-center gap-1 border border-dim px-2 py-1 hover:border-[var(--accent)] peer-focus-visible:outline';
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined text-sm';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'upload_file';
  label.append(icon, localizedElement('span', 'auth.chooseKeyFile'));
  const filename = document.createElement('span');
  filename.className = 'text-[10px] text-muted truncate';
  filename.setAttribute('role', 'status');
  container.replaceChildren(input, label, filename);

  let generation = 0;
  const reset = () => {
    generation++;
    input.value = '';
    filename.textContent = '';
    textarea.setCustomValidity('');
  };
  textarea.addEventListener('input', reset, { signal });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    reset(); // Permit choosing the same file twice, or replacing a slow read.
    const active = generation;
    const current = () => generation === active && !signal?.aborted && container.contains(input) && textarea.isConnected;
    if (file.size > 128 * 1024) {
      textarea.setCustomValidity(t('auth.keyFileTooLarge'));
      notify(t('auth.keyFileTooLarge'), { variant: 'danger' });
      return;
    }
    // Do not submit the previous key while its replacement is still being read.
    textarea.setCustomValidity(t('auth.keyFileReading'));
    try {
      const content = await file.text();
      if (!current()) return;
      textarea.value = content;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      filename.textContent = file.name;
    } catch {
      if (!current()) return;
      textarea.setCustomValidity(t('auth.readKeyFailed'));
      notify(t('auth.readKeyFailed'), { title: t('auth.readKeyTitle'), variant: 'danger' });
    }
  }, { signal });
  return reset;
}

/** Explicit local unlock; saving an unlocked key requires separate informed consent. */
export async function preparePrivateKey(
  text: string,
  persist: boolean
): Promise<{ key: string; unlocked: boolean } | null> {
  let passphrase: string | null = null;
  try {
    if (!isEncryptedPrivateKey(text)) return { key: text, unlocked: false };
    if (persist) {
      const approved = await confirmAction({
        title: t('auth.keyUnlockTitle'),
        message: t('auth.keyUnlockSaveWarning'),
        variant: 'warning',
      });
      if (!approved) return null;
    }
    passphrase = await requestText({
      title: t('auth.keyUnlockTitle'), message: t('auth.keyUnlockHint'),
      label: t('auth.keyPassphrase'), inputType: 'password', required: false, maxLength: 1024,
    });
    if (passphrase === null) return null;
    notify(t('auth.keyUnlocking'), { variant: 'info', duration: 1200 });
    // Give the browser a paint before bounded bcrypt work begins.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return { key: await unlockPrivateKey(text, passphrase), unlocked: true };
  } catch (error) {
    const reason = error instanceof PrivateKeyUnlockError ? error.reason : 'invalid';
    notify(t(reason === 'unsupported' ? 'auth.keyUnlockUnsupported'
      : reason === 'budget' ? 'auth.keyUnlockBudget' : 'auth.keyUnlockError'), { variant: 'danger' });
    return null;
  } finally {
    // Strings cannot be reliably zeroized by JavaScript; do not retain them in any application state.
    passphrase = null;
  }
}
