/** Ephemeral same-origin UI notification, never a credential or a grant. The backend enforces deletion. */
export function serverOwnerKey(user: { github_id: number; username: string }): string {
  return `${user.github_id}:${user.username}`;
}

const local = new EventTarget();
const channelName = (owner: string) => `cloudssh:server-removed:${owner}`;

export function notifyServerRemoved(owner: string, id: number): void {
  local.dispatchEvent(new CustomEvent(channelName(owner), { detail: id }));
  try {
    const channel = new BroadcastChannel(channelName(owner));
    channel.postMessage(id);
    channel.close();
  } catch { /* Cross-tab messaging unavailable; reopening the dialog reads live data. */ }
}

export function onServerRemoved(owner: string, signal: AbortSignal, remove: (id: number) => void): void {
  const accept = (id: unknown) => {
    if (!signal.aborted && typeof id === 'number' && Number.isSafeInteger(id) && id > 0) remove(id);
  };
  local.addEventListener(channelName(owner), (event) => accept((event as CustomEvent).detail), { signal });
  try {
    const channel = new BroadcastChannel(channelName(owner));
    channel.onmessage = (event) => accept(event.data);
    signal.addEventListener('abort', () => channel.close(), { once: true });
  } catch { /* Same-window listeners still work. */ }
}
