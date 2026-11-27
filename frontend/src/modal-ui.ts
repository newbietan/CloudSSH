import { localizedElement, t, type TranslationKey } from './i18n';

/** Common labelled heading and close control. The caller owns focus and dismissal policy. */
export function createModalHeader(titleId: string, key: TranslationKey, dismiss: () => void) {
  const header = document.createElement('header');
  header.className = 'app-modal__header';
  const title = localizedElement('h2', key);
  title.id = titleId;
  title.className = 'app-modal__title';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'app-modal__close';
  close.dataset.i18nAriaLabel = close.dataset.i18nTitle = 'common.close';
  close.setAttribute('aria-label', t('common.close'));
  close.title = t('common.close');
  close.addEventListener('click', dismiss);
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'close';
  close.append(icon);
  header.append(title, close);
  return { header, title, close };
}
