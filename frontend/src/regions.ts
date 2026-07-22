import { t, type TranslationKey } from './i18n';

/**
 * DO locationHint 区域选项共享数据。
 *
 * `value` 直接对应 Cloudflare DO 的 locationHint 值。
 * `value = ''` 表示 "Auto"（不留 hint，由 Cloudflare 默认调度；
 *   保存服务器时 user-db 会通过 ipapi.co 自动推断并持久化 hint）。
 *
 * 参考: https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
export interface RegionOption {
  value: string;
  labelKey: TranslationKey;
}

export const REGION_OPTIONS: RegionOption[] = [
  { value: '', labelKey: 'region.auto' },
  { value: 'wnam', labelKey: 'region.wnam' },
  { value: 'enam', labelKey: 'region.enam' },
  { value: 'sam', labelKey: 'region.sam' },
  { value: 'weur', labelKey: 'region.weur' },
  { value: 'eeur', labelKey: 'region.eeur' },
  { value: 'apac', labelKey: 'region.apac' },
  { value: 'apac-ne', labelKey: 'region.apacNe' },
  { value: 'apac-se', labelKey: 'region.apacSe' },
  { value: 'oc', labelKey: 'region.oc' },
  { value: 'afr', labelKey: 'region.afr' },
  { value: 'me', labelKey: 'region.me' },
];

/**
 * 根据 locationHint 值返回友好标签（用于状态栏、编辑回显等只读场景）。
 */
export function regionLabel(value: string | null | undefined): string {
  if (!value) return t('region.autoShort');
  const option = REGION_OPTIONS.find(o => o.value === value);
  return option ? t(option.labelKey) : value;
}

/**
 * 构造一个填充好 option 列表的 `<select>` 元素。
 */
export function populateRegionSelect(
  el: HTMLSelectElement,
  selected: string | null | undefined,
): void {
  el.innerHTML = REGION_OPTIONS.map(o =>
    `<option value="${o.value}" ${o.value === (selected || '') ? 'selected' : ''}>${t(o.labelKey)}</option>`,
  ).join('');
}
