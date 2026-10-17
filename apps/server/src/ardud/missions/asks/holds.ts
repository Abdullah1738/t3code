import type { Ask, AskId, Lane, MissionRecordRef, WorkItem } from "@t3tools/contracts";

import { askRef, asksHolding, waitingOn } from "./askModel.ts";
import { recordKey } from "./shared.ts";

/**
 * How an ask's `blocks` show on the records they hold. Only the listed
 * records wait: a held work item carries the ask in `blockedBy`, a held lane
 * goes `waiting` with "waiting on ask X". Everything else keeps running.
 */

export const WAITING_PREFIX = "waiting on ask ";

export interface HeldRecord {
  readonly ref: MissionRecordRef;
  readonly askIds: ReadonlyArray<AskId>;
  readonly line: string;
}

/** Every record an open ask holds, with the line to show on it. */
export const heldRecords = (asks: ReadonlyArray<Ask>): HeldRecord[] => {
  const seen = new Map<string, MissionRecordRef>();
  for (const ask of asks) {
    if (ask.status !== "open") continue;
    for (const block of ask.blocks) {
      if (!seen.has(recordKey(block))) seen.set(recordKey(block), block);
    }
  }
  return [...seen.values()].map((ref) => ({
    ref,
    askIds: asksHolding(ref, asks).map((ask) => ask.id),
    line: waitingOn(ref, asks) ?? "",
  }));
};

/** The work item with its ask holds recomputed, or null when unchanged. */
export const heldWorkItem = (
  item: WorkItem,
  asks: ReadonlyArray<Ask>,
  now: string,
): WorkItem | null => {
  const holding = asksHolding({ kind: "work-item", id: item.id }, asks).map(askRef);
  const blockedBy = [...item.blockedBy.filter((ref) => ref.kind !== "ask"), ...holding];
  const unchanged =
    blockedBy.length === item.blockedBy.length &&
    blockedBy.every((ref, index) => {
      const before = item.blockedBy[index];
      return before !== undefined && recordKey(before) === recordKey(ref);
    });
  return unchanged ? null : { ...item, blockedBy, updatedAt: now };
};

/**
 * The lane with its ask hold applied, or null when unchanged. A lane already
 * waiting on something else keeps that reason; parked and retired lanes are
 * left alone. Release only undoes a wait this module set.
 */
export const heldLane = (lane: Lane, asks: ReadonlyArray<Ask>, now: string): Lane | null => {
  if (lane.status === "parked" || lane.status === "retired") return null;
  const ours = lane.statusReason?.startsWith(WAITING_PREFIX) ?? false;
  const line = waitingOn({ kind: "lane", id: lane.id }, asks);
  if (line !== null) {
    if (lane.status === "waiting" && (lane.statusReason === line || !ours)) {
      return lane.statusReason === null ? { ...lane, statusReason: line, updatedAt: now } : null;
    }
    return { ...lane, status: "waiting", statusReason: line, updatedAt: now };
  }
  if (lane.status === "waiting" && ours) {
    return { ...lane, status: "idle", statusReason: null, updatedAt: now };
  }
  return null;
};

/**
 * A master's work-item write with ask holds kept: ask refs in `blockedBy`
 * come only from open asks' `blocks`, so the master can neither add nor drop
 * them by hand.
 */
export const keepWorkItemHolds = <
  I extends { readonly blockedBy?: ReadonlyArray<MissionRecordRef> | undefined },
>(
  itemId: WorkItem["id"] | undefined,
  input: I,
  asks: ReadonlyArray<Ask>,
): I => {
  if (input.blockedBy === undefined) return input;
  const holding =
    itemId === undefined ? [] : asksHolding({ kind: "work-item", id: itemId }, asks).map(askRef);
  return {
    ...input,
    blockedBy: [...input.blockedBy.filter((ref) => ref.kind !== "ask"), ...holding],
  };
};

/**
 * Why a master may not change a lane's status right now, or null. A lane an
 * open ask holds keeps waiting until the owner answers; the master can still
 * park or retire it, or withdraw or supersede the ask.
 */
export const laneHoldConflict = (
  laneId: Lane["id"] | undefined,
  change: {
    readonly status?: Lane["status"] | undefined;
    readonly statusReason?: string | null | undefined;
  },
  asks: ReadonlyArray<Ask>,
): string | null => {
  if (laneId === undefined) return null;
  const line = waitingOn({ kind: "lane", id: laneId }, asks);
  if (line === null) return null;
  const status = change.status;
  const reasonChange =
    change.statusReason !== undefined && (status === undefined || status === "waiting");
  if (
    (status !== undefined && status !== "waiting" && status !== "parked" && status !== "retired") ||
    reasonChange
  ) {
    return `Lane ${laneId} is ${line}. It waits until the owner answers; withdraw or supersede the ask to change that.`;
  }
  return null;
};
