// Server IDs (and user.id) are local to a UserDBDO. Only the stable GitHub ID
// distinguishes accounts; -1 is the separate local administrator identity.
const DRAFT_PREFIX = 'cloudssh_agent_draft_';

function userDraftPrefix(githubId: number | null | undefined): string | null {
  if (
    typeof githubId !== 'number' ||
    !Number.isSafeInteger(githubId) ||
    (githubId <= 0 && githubId !== -1)
  ) {
    return null;
  }
  return `${DRAFT_PREFIX}${githubId}_`;
}

/** Missing identity disables persistence, rather than falling back to an unscoped key. */
export function agentSessionDraftKey(
  githubId: number | null | undefined,
  serverId: number | undefined
): string | null {
  const prefix = userDraftPrefix(githubId);
  if (!prefix || typeof serverId !== 'number' || !Number.isSafeInteger(serverId) || serverId <= 0) {
    return null;
  }
  return `${prefix}${serverId}`;
}

function removeDrafts(matches: (key: string) => boolean): void {
  try {
    // Walk backwards because removeItem changes subsequent key indices.
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key && matches(key)) localStorage.removeItem(key);
    }
  } catch {
    // Storage can be unavailable in private browsing; login/logout must still work.
  }
}

/** Old drafts have no verifiable owner. Delete them, never migrate them to whoever logs in next. */
export function clearLegacyAgentSessionDrafts(): void {
  removeDrafts((key) => /^cloudssh_agent_draft_\d+$/.test(key));
}

/** Logout removes this account's drafts across every server, without touching other accounts. */
export function clearUserAgentSessionDrafts(githubId: number | null | undefined): void {
  const prefix = userDraftPrefix(githubId);
  if (prefix) removeDrafts((key) => key.startsWith(prefix));
}
