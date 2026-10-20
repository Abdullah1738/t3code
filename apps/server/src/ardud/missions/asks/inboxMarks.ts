/**
 * The owner's comments and snooze on an inbox item, kept in one record beside
 * the item (`inbox-mark`) so no other writer of the item races it.
 *
 * A snooze holds only while the item stands as it was snoozed, no discussion
 * on it moved since, and its time (if any) has not passed. Reads drop a snooze
 * that no longer holds; nothing rewrites it.
 */
import type {
  Approval,
  Draft,
  InboxItemKind,
  InboxItemRef,
  InboxMark,
  InboxSnooze,
  MissionId,
  MissionError,
  Suggestion,
} from "@t3tools/contracts";
import { approverOf } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as MissionStore from "../store/MissionStore.ts";

export const markIdOf = (ref: InboxItemRef): string => `${ref.kind}:${ref.id}`;

/** A short fingerprint of the item as stored; any change to it changes this. */
export const stampOf = (record: unknown): string => {
  const text = JSON.stringify(record) ?? "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
};

export const emptyMark = (
  subject: InboxItemRef,
  missionId: MissionId | null,
  at: string,
): InboxMark => ({
  id: markIdOf(subject),
  missionId,
  subject: { kind: subject.kind, id: subject.id },
  comments: [],
  snooze: null,
  updatedAt: at,
});

export interface SnoozeState {
  /** The item now, or null when it is gone. */
  readonly record: unknown;
  /** Newest update of a discussion on the item, if any. */
  readonly discussedAt: string | null;
  readonly now: string;
}

export const snoozeHolds = (snooze: InboxSnooze, state: SnoozeState): boolean =>
  state.record !== null &&
  stampOf(state.record) === snooze.stamp &&
  (state.discussedAt === null || state.discussedAt <= snooze.at) &&
  (snooze.until === null || snooze.until > state.now);

type Store = MissionStore.MissionStore["Service"];

/** Newest word in any discussion on the item, or null. */
export const discussedAt = (store: Store, missionId: MissionId, subject: InboxItemRef) =>
  Effect.map(store.listOwnerRequests(missionId, { subject }), (requests) =>
    requests.reduce<string | null>((newest, request) => {
      for (const at of [request.lastOwnerAt, request.lastMasterAt, request.lastReplyAt]) {
        if (at !== null && at !== undefined && (newest === null || at > newest)) newest = at;
      }
      return newest;
    }, null),
  );

/** The mark's snooze and the item now, the snooze null once it stops holding. */
export const liveSnooze = (
  store: Store,
  mark: InboxMark,
  now: string,
): Effect.Effect<{ readonly snooze: InboxSnooze | null; readonly record: unknown }, MissionError> =>
  Effect.gen(function* () {
    const snooze = mark.snooze;
    if (snooze === null) return { snooze, record: null };
    const record = Option.getOrNull(yield* store.get(mark.subject.kind, mark.subject.id));
    const discussed =
      mark.missionId === null ? null : yield* discussedAt(store, mark.missionId, mark.subject);
    return {
      snooze: snoozeHolds(snooze, { record, discussedAt: discussed, now }) ? snooze : null,
      record,
    };
  });

/**
 * Items snoozed right now, by mark id (`kind:id`), so counts of what waits on
 * the owner leave them out until the snooze ends.
 */
export const snoozedNow = (
  store: Store,
  missionId: MissionId | null,
  now: string,
): Effect.Effect<ReadonlyMap<string, SnoozedItem>, MissionError> =>
  Effect.gen(function* () {
    const stored =
      missionId === null
        ? yield* store.listAll("inbox-mark")
        : yield* store.listAllInMission("inbox-mark", missionId);
    const held = new Map<string, SnoozedItem>();
    for (const mark of stored) {
      const live = yield* liveSnooze(store, mark, now);
      if (live.snooze !== null) held.set(mark.id, { kind: mark.subject.kind, record: live.record });
    }
    return held;
  });

export interface SnoozedItem {
  readonly kind: InboxItemKind;
  readonly record: unknown;
}

/** Whether the item, as it stands, sits in the owner's inbox waiting on him. */
export const waitsOnOwner = (kind: InboxItemKind, record: unknown): boolean => {
  const status = (record as { readonly status?: unknown }).status;
  switch (kind) {
    case "ask":
      return status === "open";
    case "draft":
    case "approval":
      return status === "pending" && !isMasterRouted(kind, record);
    case "knock":
      return status === "pending";
    case "suggestion":
      return status === "open" && !isMasterRouted(kind, record);
    default:
      return false;
  }
};

/** Items the master decides: a comment on one knocks the master once. */
export const isMasterRouted = (kind: InboxItemKind, record: unknown): boolean => {
  switch (kind) {
    case "draft":
      return approverOf(record as Pick<Draft, "approver">) === "master";
    case "approval":
      return approverOf(record as Pick<Approval, "approver">) === "master";
    case "suggestion":
      return (record as Pick<Suggestion, "acceptor">).acceptor === "master";
    default:
      return false;
  }
};

/** A line naming the item for the master's room and the event log. */
export const itemLabel = (kind: InboxItemKind, record: unknown): string => {
  const value = record as Record<string, unknown>;
  const text =
    kind === "ask"
      ? value.question
      : kind === "draft"
        ? (value.summary ?? value.text)
        : kind === "suggestion" || kind === "approval"
          ? value.title
          : value.summary;
  return typeof text === "string" && text.trim() !== "" ? text : `${kind} ${String(value.id)}`;
};
