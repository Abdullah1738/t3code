export const isOpenCodeSessionId = (id) => typeof id === 'string' && /^ses_[A-Za-z0-9]+$/.test(id);

// The old ses_ alias can survive a provider switch. An explicit native binding
// or selection always wins over that alias, even before a new native ID exists.
export function openCodeSession(thread) {
  if (!thread) return null;
  const driver = thread.native?.driver ?? thread.driver;
  const instance = thread.model?.instanceId ?? thread.providerInstanceId;
  if (['claudeAgent', 'codex', 'codex-cu'].includes(instance)) return null;
  if (driver && driver !== 'opencode') return null;
  if (instance && instance !== 'opencode' && instance !== thread.native?.providerInstanceId) return null;
  if (!driver && instance !== 'opencode') return null;
  const id = thread.native?.nativeId ?? thread.nativeSessionId;
  return isOpenCodeSessionId(id) ? id : null;
}

export function parseCutoverStatus(body) {
  const value = body?.cutover;
  if (body?.ok !== true || !value || typeof value.active !== 'boolean' || typeof value.completed !== 'boolean'
    || !Array.isArray(value.claimedThreadIds) || !value.claimedThreadIds.every((id) => typeof id === 'string')
    || (value.claimedRunIds !== undefined && (!Array.isArray(value.claimedRunIds)
      || !value.claimedRunIds.every((id) => typeof id === 'string')))
    || (value.claimedRuns !== undefined && (!Array.isArray(value.claimedRuns)
      || !value.claimedRuns.every((claim) => typeof claim?.threadId === 'string' && typeof claim.runId === 'string')))) {
    throw new Error('invalid harness-cutover status; recovery is held');
  }
  return value;
}

// Completed claims are run-scoped, never a permanent ban on recovering a
// thread. Run IDs remain reserved even if an item failed after claiming it.
export function cutoverOwns(cutover, threadId, runIds = []) {
  if (cutover.active && cutover.claimedThreadIds.includes(threadId)) return true;
  const claimed = new Set([...(cutover.claimedRunIds ?? []), ...(cutover.claimedRuns ?? [])
    .filter((claim) => claim.threadId === threadId).map((claim) => claim.runId)]);
  return runIds.some((id) => claimed.has(id));
}

export async function recoveryOwned(io, threadId, runIds = []) {
  return cutoverOwns(await io.harnessCutoverStatus(), threadId, runIds);
}
