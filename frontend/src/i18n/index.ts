import { enUS } from './locales/en-US';
import { zhCN } from './locales/zh-CN';

export type Locale = 'zh-CN' | 'en-US';
export type TranslationKey = keyof typeof zhCN;
export type TranslationParams = Record<string, string | number>;

const STORAGE_KEY = 'cloudssh_locale';
const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};
const listeners = new Set<(locale: Locale) => void>();
let currentLocale: Locale = 'zh-CN';

export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const normalized = value.replace('_', '-').toLowerCase();
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US';
  return null;
}

export function resolveLocale(options: {
  urlLocale?: string | null;
  storedLocale?: string | null;
  browserLocales?: readonly string[];
}): Locale {
  return normalizeLocale(options.urlLocale)
    ?? normalizeLocale(options.storedLocale)
    ?? options.browserLocales?.map(normalizeLocale).find((locale): locale is Locale => locale !== null)
    ?? 'zh-CN';
}

export function t(key: TranslationKey, params: TranslationParams = {}): string {
  const template = dictionaries[currentLocale][key] ?? zhCN[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function getLocale(): Locale {
  return currentLocale;
}

export function translateDocument(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n as TranslationKey);
  });
  const attributeMap = {
    'data-i18n-placeholder': 'placeholder',
    'data-i18n-title': 'title',
    'data-i18n-aria-label': 'aria-label',
  } as const;
  Object.entries(attributeMap).forEach(([dataAttribute, attribute]) => {
    root.querySelectorAll<HTMLElement>(`[${dataAttribute}]`).forEach((element) => {
      const key = element.getAttribute(dataAttribute) as TranslationKey;
      element.setAttribute(attribute, t(key));
    });
  });
}

export function getAlternateLocale(locale: Locale): Locale {
  return locale === 'zh-CN' ? 'en-US' : 'zh-CN';
}

function localeSelfName(locale: Locale): string {
  return locale === 'zh-CN' ? zhCN['language.zhCN'] : enUS['language.enUS'];
}

function syncLanguageSwitchers(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-language-toggle]').forEach((button) => {
    const targetLocale = getAlternateLocale(currentLocale);
    const targetName = localeSelfName(targetLocale);
    button.dataset.targetLocale = targetLocale;
    button.setAttribute('aria-label', t('language.switchTo', { language: targetName }));
    button.title = t('language.switchTo', { language: targetName });
    const label = button.querySelector<HTMLElement>('[data-language-toggle-label]');
    if (label) label.textContent = targetName;
  });
}

export function mountLanguageSwitchers(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-language-switcher]').forEach((container) => {
    if (container.querySelector('[data-language-toggle]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.languageToggle = '';
    button.className = 'language-toggle';
    button.innerHTML = `
      <span class="material-symbols-outlined language-toggle__icon" aria-hidden="true">language</span>
      <span data-language-toggle-label></span>
    `;
    button.addEventListener('click', () => setLocale(getAlternateLocale(currentLocale)));
    container.appendChild(button);
  });
  syncLanguageSwitchers();
}

export function setLocale(locale: Locale, options: { persist?: boolean } = {}): void {
  currentLocale = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    translateDocument();
    syncLanguageSwitchers();
  }
  if (options.persist !== false && typeof localStorage !== 'undefined') {
    try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* storage may be disabled */ }
  }
  listeners.forEach((listener) => listener(locale));
}

export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initI18n(): Locale {
  let storedLocale: string | null = null;
  try { storedLocale = localStorage.getItem(STORAGE_KEY); } catch { /* storage may be disabled */ }
  const locale = resolveLocale({
    urlLocale: new URLSearchParams(window.location.search).get('lang'),
    storedLocale,
    browserLocales: navigator.languages,
  });
  currentLocale = locale;
  document.documentElement.lang = locale;
  mountLanguageSwitchers();
  translateDocument();
  return locale;
}
