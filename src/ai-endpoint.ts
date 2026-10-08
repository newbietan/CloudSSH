// Responses is the only generation protocol. Keep paths case-sensitive when binding credentials.
export function normalizeAIBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Invalid Responses API address');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid Responses API address');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions') || path.endsWith('/models')) {
    throw new Error('Use an API root or /responses address');
  }
  if (path.endsWith('/responses')) path = path.slice(0, -'/responses'.length);
  return `${url.origin}${path}`;
}
