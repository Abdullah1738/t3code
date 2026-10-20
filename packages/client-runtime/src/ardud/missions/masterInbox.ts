// Joins the owner's inbox with the master's queue (`missions.asks.subscribeMasterInbox`)
// so one snapshot holds every pending draft, approval and suggestion, whichever
// inbox it is routed to.

import {
  MISSIONS_ASKS_WS_METHODS as ASKS,
  type MissionId,
  type MissionInbox,
  type MissionMasterInbox,
} from "@t3tools/contracts";

import type { MissionsTransport } from "./rpcSource.ts";
import type { Listener, MissionInboxSnapshot, MissionsSource, Unsubscribe } from "./source.ts";

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

/** The master's queue for one inbox scope (`null` reads every mission). */
export type MasterInboxFeed = (
  missionId: MissionId | null,
  listener: Listener<MissionMasterInbox>,
) => Unsubscribe;

/** The master's queue over the missions transport. */
export function masterInboxFeed(transport: MissionsTransport): MasterInboxFeed {
  // The transport types its stream tags from the source's own list, which
  // does not read the master queue; the call itself is an ordinary stream.
  const streams = transport as unknown as {
    stream(
      tag: typeof ASKS.subscribeMasterInbox,
      input: { readonly missionId: MissionId | null },
      onValue: Listener<MissionMasterInbox>,
    ): Unsubscribe;
  };
  return (missionId, listener) =>
    streams.stream(ASKS.subscribeMasterInbox, { missionId }, listener);
}

/** `source` with the master's queue joined into every inbox snapshot it sends. */
export function withMasterInboxFeed(
  source: MissionsSource,
  masterFeed: MasterInboxFeed,
): MissionsSource {
  return {
    ...source,
    subscribeInbox(missionId, listener) {
      let inbox: MissionInbox | undefined;
      let master: MissionMasterInbox | undefined;
      const push = () => {
        if (inbox !== undefined) listener(withMasterInbox(inbox, master));
      };
      const stopInbox = source.subscribeInbox(missionId, (value) => {
        inbox = value;
        push();
      });
      const stopMaster = masterFeed(missionId, (value) => {
        master = value;
        push();
      });
      return () => {
        stopInbox();
        stopMaster();
      };
    },
  };
}
