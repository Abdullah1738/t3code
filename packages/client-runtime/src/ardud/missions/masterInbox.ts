// Joins the owner's inbox with the master's queue (`missions.asks.subscribeMasterInbox`)
// so one snapshot holds every pending draft, approval and suggestion, whichever
// inbox it is routed to. Pure; the source wires the two feeds.

import type { MissionInbox, MissionMasterInbox } from "@t3tools/contracts";

import type { MissionInboxSnapshot } from "./source.ts";

const joinById = <T extends { readonly id: string }>(
  owner: ReadonlyArray<T>,
  master: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  if (master.length === 0) return owner;
  const seen = new Set(owner.map((record) => record.id));
  return [...owner, ...master.filter((record) => !seen.has(record.id))];
};

/**
 * The owner's inbox plus the master's queue. `counts` stay the owner's;
 * `masterCounts` are the server's complete master counts, so they stay right
 * when the master lists are capped. Without a master queue yet, the counts are 0.
 */
export function withMasterInbox(
  inbox: MissionInbox,
  master: MissionMasterInbox | undefined,
): MissionInboxSnapshot {
  if (master === undefined) return { ...inbox, masterCounts: { approve: 0, suggestions: 0 } };
  return {
    ...inbox,
    drafts: joinById(inbox.drafts, master.drafts),
    approvals: joinById(inbox.approvals, master.approvals),
    suggestions: joinById(inbox.suggestions, master.suggestions),
    masterCounts: { approve: master.counts.approve, suggestions: master.counts.suggestions },
  };
}
