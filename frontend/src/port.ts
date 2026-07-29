export function parsePort(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;

  const port = Number(normalized);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
