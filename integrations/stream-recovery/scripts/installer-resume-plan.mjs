#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { harnessCutoverStatus } from '../lib/io.mjs';
import { cutoverOwns, parseCutoverStatus } from '../lib/harness.mjs';

// The installer owns pending.json. This helper only classifies its snapshot;
// an active cutover's entries must remain pending until its durable completion.
export function planInstallerResume(snapshot, cutover) {
  if (!Array.isArray(snapshot?.threads) || !snapshot.threads.every((t) => typeof t?.threadId === 'string')) {
    throw new Error('invalid installer snapshot');
  }
  const plan = { resumeThreadIds: [], cutoverPendingThreadIds: [], cutoverCompletedThreadIds: [], unresolvedThreadIds: [] };
  for (const thread of snapshot.threads) {
    const runId = thread.activeRunId ?? thread.latestRunId;
    if (cutoverOwns(cutover, thread.threadId, [runId])) {
      const target = cutover.completed ? plan.cutoverCompletedThreadIds : plan.cutoverPendingThreadIds;
      target.push(thread.threadId);
    } else if (!runId && cutover.completed && cutover.claimedThreadIds.includes(thread.threadId)) {
      plan.unresolvedThreadIds.push(thread.threadId);
    } else plan.resumeThreadIds.push(thread.threadId);
  }
  return plan;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [snapshotPath, statusPath, ...extra] = process.argv.slice(2);
    if (!snapshotPath || extra.length) throw new Error('usage: installer-resume-plan.mjs SNAPSHOT.json [STATUS.json]');
    const status = statusPath ? parseCutoverStatus(JSON.parse(readFileSync(statusPath, 'utf8'))) : await harnessCutoverStatus();
    console.log(JSON.stringify(planInstallerResume(JSON.parse(readFileSync(snapshotPath, 'utf8')), status)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
