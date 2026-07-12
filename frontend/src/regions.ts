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
  label: string;
}

export const REGION_OPTIONS: RegionOption[] = [
  { value: '', label: '自动（保存时由系统推断）' },
  { value: 'wnam', label: 'North America — West' },
  { value: 'enam', label: 'North America — East' },
  { value: 'sam', label: 'South America' },
  { value: 'weur', label: 'Europe — West' },
  { value: 'eeur', label: 'Europe — East' },
  { value: 'apac', label: 'Asia-Pacific' },
  { value: 'apac-ne', label: 'Asia-Pacific — Northeast' },
  { value: 'apac-se', label: 'Asia-Pacific — Southeast' },
  { value: 'oc', label: 'Oceania' },
  { value: 'afr', label: 'Africa' },
  { value: 'me', label: 'Middle East' },
];

/**
 * 根据 locationHint 值返回友好标签（用于状态栏、编辑回显等只读场景）。
 */
export function regionLabel(value: string | null | undefined): string {
  if (!value) return '自动';
  return REGION_OPTIONS.find(o => o.value === value)?.label || value;
}

/**
 * 构造一个填充好 option 列表的 `<select>` 元素。
 */
export function populateRegionSelect(
  el: HTMLSelectElement,
  selected: string | null | undefined,
): void {
  el.innerHTML = REGION_OPTIONS.map(o =>
    `<option value="${o.value}" ${o.value === (selected || '') ? 'selected' : ''}>${o.label}</option>`,
  ).join('');
}
