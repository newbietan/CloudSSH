import { ALLOWED_LOCATION_HINTS } from '../types';

/**
 * 自动推断 SSH 目标服务器对应的 Cloudflare DO locationHint。
 *
 * 该函数仅在 **保存服务器** 时被调用一次，结果持久化入 `servers.inferred_hint` 列；
 * 后续连接时直接读 DB，**不再运行时查询 ipapi.co**，零延迟、零外部依赖。
 *
 * fetch 带 `cf.cacheEverything + cacheTtl` 让 Cloudflare 边缘缓存 ipapi 响应 24h，
 * 同 colo 内对同 host 的重复保存（如编辑时）只打一次源 API。
 * 失败时返回 undefined（连接时退化为无 hint = Auto = Cloudflare 默认调度）。
 */

// 国家代码 → locationHint 映射表
// US/CA 按经度细分东西海岸（见 refineForUsCanada，以 -100° 经线为界）
const COUNTRY_TO_HINT: Record<string, string> = {
  // North America (US/CA 走 refineForUsCanada 细分)
  'US': 'wnam', 'CA': 'wnam', 'MX': 'wnam',
  // South America
  'BR': 'sam', 'AR': 'sam', 'CL': 'sam', 'CO': 'sam', 'PE': 'sam',
  'VE': 'sam', 'EC': 'sam', 'BO': 'sam', 'PY': 'sam', 'UY': 'sam',
  // Europe West
  'GB': 'weur', 'FR': 'weur', 'DE': 'weur', 'NL': 'weur', 'ES': 'weur',
  'IT': 'weur', 'PT': 'weur', 'BE': 'weur', 'IE': 'weur', 'CH': 'weur', 'AT': 'weur',
  'LU': 'weur', 'MC': 'weur',
  // Europe East
  'PL': 'eeur', 'RU': 'eeur', 'CZ': 'eeur', 'UA': 'eeur', 'RO': 'eeur',
  'TR': 'eeur', 'GR': 'eeur', 'HU': 'eeur', 'SE': 'eeur', 'FI': 'eeur',
  'NO': 'eeur', 'DK': 'eeur', 'SK': 'eeur', 'BG': 'eeur', 'HR': 'eeur',
  'RS': 'eeur', 'LT': 'eeur', 'LV': 'eeur', 'EE': 'eeur', 'SI': 'eeur',
  // Asia-Pacific (default)
  'IN': 'apac', 'SG': 'apac', 'TH': 'apac', 'VN': 'apac', 'ID': 'apac',
  'PH': 'apac', 'MY': 'apac', 'KH': 'apac', 'LA': 'apac', 'MM': 'apac',
  'BD': 'apac', 'LK': 'apac', 'NP': 'apac',
  // Asia-Pacific Northeast
  'CN': 'apac-ne', 'JP': 'apac-ne', 'KR': 'apac-ne', 'TW': 'apac-ne', 'HK': 'apac-ne',
  // Asia-Pacific Southeast (暂并入 apac；可细化时单独取出)
  // Oceania
  'AU': 'oc', 'NZ': 'oc',
  // Africa
  'ZA': 'afr', 'NG': 'afr', 'EG': 'afr', 'KE': 'afr', 'MA': 'afr',
  'GH': 'afr', 'ET': 'afr', 'TZ': 'afr', 'UG': 'afr', 'TN': 'afr', 'DZ': 'afr',
  // Middle East
  'SA': 'me', 'AE': 'me', 'IL': 'me', 'IR': 'me', 'QA': 'me', 'KW': 'me',
  'BH': 'me', 'OM': 'me', 'JO': 'me', 'IQ': 'me', 'LB': 'me',
};

// US/CA 按经度切东西海岸：-100° 经线以西为 wnam，以东为 enam
function refineForUsCanada(country: string, lon: number): string {
  if (country === 'US' || country === 'CA') {
    return lon < -100 ? 'wnam' : 'enam';
  }
  return COUNTRY_TO_HINT[country] || 'wnam';
}

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_LOCATION_HINTS);

/**
 * 推断 host 对应的 Cloudflare DO locationHint。
 *
 * @param host SSH 服务器的主机名或 IP（IPv4/IPv6/域名均可，ipapi.co 自行解析）
 * @returns locationHint 字符串（如 'apac-ne'），或失败时 undefined
 */
export async function inferLocationHint(host: string): Promise<string | undefined> {
  if (!host) return undefined;

  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(host)}/json/`, {
      cf: { cacheTtl: 86400, cacheEverything: true }, // CF 边缘缓存 24h
    });
    if (!res.ok) return undefined;

    const data = await res.json<{
      country?: string;
      longitude?: number;
      latitude?: number;
      error?: boolean;
      reason?: string;
      reserved?: boolean;
    }>();

    // reserved IP / 私网 IP / 失败响应
    if (data.error || data.reserved) return undefined;

    if (!data.country || !COUNTRY_TO_HINT[data.country]) {
      // 国家未命中映射表：用经纬度做粗略 fallback
      if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
        return fallbackByLatLon(data.latitude, data.longitude);
      }
      return undefined;
    }

    // US/CA 用经度切东西海岸；其他国家直接取映射值
    const hint = (data.longitude !== undefined)
      ? refineForUsCanada(data.country, data.longitude)
      : COUNTRY_TO_HINT[data.country];

    // 白名单兜底过滤
    return ALLOWED_SET.has(hint) ? hint : undefined;
  } catch {
    // 网络异常、限流（429）、DNS 失败 → 静默退化为 Auto
    return undefined;
  }
}

/**
 * 国家未命中映射表时的 fallback：按经度做粗略分块。
 * 参考 Cloudflare locationHint 的地理边界：
 *   美洲（经度 < -30）→ wnam/enam（再按 -100 切）
 *   欧洲/非洲（-30 ≤ 经度 < 60）→ weur
 *   中东/中亚（60 ≤ 经度 < 90）→ me
 *   亚洲/大洋洲（经度 ≥ 90）→ apac
 * 纬度仅用于判定大洋洲（lat < -10）。
 */
function fallbackByLatLon(lat: number, lon: number): string | undefined {
  if (lat < -10 && lon > 110) return 'oc';         // 大洋洲
  if (lon < -100) return 'wnam';                    // 美西/北美西
  if (lon < -30) return 'enam';                      // 美东/南美
  if (lon < 60) return 'weur';                       // 欧洲西部（粗略）
  if (lon < 90) return 'me';                         // 中东/中亚
  if (lon < 140) return 'apac-ne';                  // 东亚
  return 'apac';                                     // 亚太其他
}
