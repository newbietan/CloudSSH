export type NetworkMetric = 'cf' | 'ws';
export type NetworkQuality = 'good' | 'fair' | 'poor';

const NETWORK_QUALITY_THRESHOLDS: Record<NetworkMetric, { goodMax: number; fairMax: number }> = {
  cf: { goodMax: 100, fairMax: 250 },
  ws: { goodMax: 100, fairMax: 200 },
};

export function getNetworkQuality(latency: number, metric: NetworkMetric): NetworkQuality {
  const thresholds = NETWORK_QUALITY_THRESHOLDS[metric];
  if (latency <= thresholds.goodMax) return 'good';
  if (latency <= thresholds.fairMax) return 'fair';
  return 'poor';
}
