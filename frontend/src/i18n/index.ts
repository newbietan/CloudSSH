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

function syncLanguageSelectors(): void {
  document.querySelectorAll<HTMLSelectElement>('[data-language-select]').forEach((select) => {
    select.value = currentLocale;
    select.setAttribute('aria-label', t('language.label'));
    select.title = t('language.label');
  });
}

export function mountLanguageSwitchers(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-language-switcher]').forEach((container) => {
    if (container.querySelector('[data-language-select]')) return;
    const select = document.createElement('select');
    select.dataset.languageSelect = '';
    select.className = 'language-selector';
    select.innerHTML = `
      <option value="zh-CN">${zhCN['language.zhCN']}</option>
      <option value="en-US">${enUS['language.enUS']}</option>
    `;
    select.addEventListener('change', () => setLocale(select.value as Locale));
    container.appendChild(select);
  });
  syncLanguageSelectors();
}

export function setLocale(locale: Locale, options: { persist?: boolean } = {}): void {
  currentLocale = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    translateDocument();
    syncLanguageSelectors();
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
