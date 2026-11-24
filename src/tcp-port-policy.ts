// Common service ports excluded from user-selected SSH and RDP TCP destinations.
const restricted = new Set([23, 80, 443, 25, 465, 587, 110, 143, 993, 995, 3306, 5432, 6379, 9200, 11211, 27017, 5060]);

export function isRestrictedTcpPort(port: number): boolean {
  return restricted.has(port);
}
