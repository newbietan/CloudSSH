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
  // Asia-Pacific (通用亚太，Cloudflare 建议优先使用 apac 而非 apac-ne/apac-se)
  'IN': 'apac', 'SG': 'apac', 'TH': 'apac', 'VN': 'apac', 'ID': 'apac',
  'PH': 'apac', 'MY': 'apac', 'KH': 'apac', 'LA': 'apac', 'MM': 'apac',
  'BD': 'apac', 'LK': 'apac', 'NP': 'apac',
  // 亚太东北（使用 apac 确保 DO 节点可用性）
  'CN': 'apac', 'JP': 'apac', 'KR': 'apac', 'TW': 'apac', 'HK': 'apac',
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
 * 推断结果，包含 hint 和调试信息
 */
export interface InferResult {
  hint: string | undefined;
  debug: string[];
}

/**
 * 推断 host 对应的 Cloudflare DO locationHint。
 *
 * @param host SSH 服务器的主机名或 IP（IPv4/IPv6/域名均可，ipapi.co 自行解析）
 * @returns InferResult 包含 hint 和调试日志
 */
export async function inferLocationHint(host: string): Promise<InferResult> {
  const debug: string[] = [];
  debug.push(`[IP-GEO] 开始推断 host=${host}`);

  if (!host) {
    debug.push(`[IP-GEO] host 为空，跳过`);
    return { hint: undefined, debug };
  }

  try {
    // 使用 ipinfo.io（免费 50k/月，比 ipapi.co 的 1k/天更宽松）
    const url = `https://ipinfo.io/${encodeURIComponent(host)}/json`;
    debug.push(`[IP-GEO] 请求 ipinfo.io: ${url}`);
    const res = await fetch(url, {
      cf: { cacheTtl: 86400, cacheEverything: true }, // CF 边缘缓存 24h
    });
    debug.push(`[IP-GEO] ipinfo.io 响应状态: ${res.status}, CF-Cache-Status: ${res.headers.get('cf-cache-status') || 'N/A'}`);

    if (!res.ok) {
      debug.push(`[IP-GEO] ipinfo.io 请求失败: HTTP ${res.status}`);
      return { hint: undefined, debug };
    }

    const data = await res.json<{
      country?: string;
      loc?: string; // 格式: "lat,lon"
      bogon?: boolean;
    }>();

    // bogon = 私网/保留 IP
    if (data.bogon) {
      debug.push(`[IP-GEO] IP 被识别为 bogon（私网/保留），跳过`);
      return { hint: undefined, debug };
    }

    // 解析经纬度
    let latitude: number | undefined;
    let longitude: number | undefined;
    if (data.loc && typeof data.loc === 'string') {
      const parts = data.loc.split(',');
      if (parts.length === 2) {
        latitude = parseFloat(parts[0]);
        longitude = parseFloat(parts[1]);
      }
    }

    debug.push(`[IP-GEO] ipinfo.io 返回: country=${data.country}, loc=${data.loc}, bogon=${data.bogon}`);

    if (!data.country) {
      debug.push(`[IP-GEO] 无国家信息，尝试经纬度 fallback`);
      if (typeof latitude === 'number' && typeof longitude === 'number') {
        const hint = fallbackByLatLon(latitude, longitude);
        debug.push(`[IP-GEO] 经纬度 fallback 结果: ${hint}`);
        return { hint, debug };
      }
      debug.push(`[IP-GEO] 无经纬度信息，无法推断`);
      return { hint: undefined, debug };
    }

    if (!COUNTRY_TO_HINT[data.country]) {
      debug.push(`[IP-GEO] 国家 ${data.country} 不在映射表中，尝试经纬度 fallback`);
      if (typeof longitude === 'number') {
        const hint = fallbackByLatLon(latitude ?? 0, longitude);
        debug.push(`[IP-GEO] 经纬度 fallback 结果: ${hint}`);
        return { hint, debug };
      }
      debug.push(`[IP-GEO] 无经纬度信息，无法推断`);
      return { hint: undefined, debug };
    }

    // US/CA 用经度切东西海岸；其他国家直接取映射值
    const hint = (longitude !== undefined)
      ? refineForUsCanada(data.country, longitude)
      : COUNTRY_TO_HINT[data.country];

    debug.push(`[IP-GEO] 国家 ${data.country} 映射为: ${hint}`);

    // 白名单兜底过滤
    const valid = ALLOWED_SET.has(hint);
    if (!valid) {
      debug.push(`[IP-GEO] ${hint} 不在白名单中，跳过`);
    }
    return { hint: valid ? hint : undefined, debug };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    debug.push(`[IP-GEO] 请求异常: ${errMsg}`);
    // 网络异常、限流（429）、DNS 失败 → 静默退化为 Auto
    return { hint: undefined, debug };
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
  if (lon < 140) return 'apac';                      // 东亚
  return 'apac';                                     // 亚太其他
}
