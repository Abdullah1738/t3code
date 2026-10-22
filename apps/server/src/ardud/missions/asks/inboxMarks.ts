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
  InboxComment,
  InboxItemKind,
  InboxItemRef,
  InboxMark,
  InboxSnooze,
  MissionId,
  MissionProvenance,
  Suggestion,
} from "@t3tools/contracts";
import { approverOf, isOwnerProvenance, MissionError } from "@t3tools/contracts";
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

/** Items the master decides rather than the owner. */
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

// A note the owner gives with a decision is a comment on the item: it goes to
// whoever acts on the decision and stays on the item, and never opens a
// discussion.

const NOTE_LIMIT = 4000;

/** The owner's note given with a decision, or null when there is none. */
export const decisionNoteOf = (
  note: string | undefined,
  provenance: MissionProvenance,
): Effect.Effect<string | null, MissionError> => {
  const body = note?.trim() ?? "";
  if (body === "") return Effect.succeed(null);
  if (!isOwnerProvenance(provenance)) {
    return Effect.fail(
      new MissionError({
        code: "forbidden",
        detail: "Only the owner leaves a note with a decision; post yours to the room.",
      }),
    );
  }
  if (body.length > NOTE_LIMIT) {
    return Effect.fail(
      new MissionError({ code: "invalid", detail: `A note is at most ${NOTE_LIMIT} characters.` }),
    );
  }
  return Effect.succeed(body);
};

/** The item's mark with one more comment. */
export const withComment = (
  existing: Option.Option<InboxMark>,
  subject: InboxItemRef,
  missionId: MissionId | null,
  comment: InboxComment,
): InboxMark => {
  const mark = Option.getOrElse(existing, () => emptyMark(subject, missionId, comment.at));
  return { ...mark, comments: [...mark.comments, comment], updatedAt: comment.at };
};

/** Every comment the owner left on the item, oldest first. */
export const commentsOn = (
  store: Store,
  subject: InboxItemRef,
): Effect.Effect<ReadonlyArray<InboxComment>, MissionError> =>
  Effect.map(store.get("inbox-mark", markIdOf(subject)), (mark) =>
    Option.match(mark, { onNone: () => [], onSome: (found) => found.comments }),
  );

export const commentLines = (comments: ReadonlyArray<InboxComment>): string =>
  comments.map((comment) => `- ${comment.body}`).join("\n");

/**
 * The rewrite note a system writer gets when the owner approved its draft with
 * comments: it rewrites and resubmits, since it can only post text as given.
 */
export const applyCommentsNote = (comments: ReadonlyArray<InboxComment>): string =>
  ["Approved once these comments from the owner are applied:", commentLines(comments)].join("\n");

export type WithComments<R> = R & { readonly comments?: ReadonlyArray<InboxComment> };

/**
 * Records with the owner's comments on them (only those that have any), so a
 * read shows them after the item has left his inbox.
 */
export const attachComments = Effect.fn("inboxMarks.attachComments")(function* <
  R extends { readonly id: string; readonly missionId: MissionId | null },
>(
  store: Store,
  kind: InboxItemKind,
  records: ReadonlyArray<R>,
): Effect.fn.Return<ReadonlyArray<WithComments<R>>, MissionError> {
  if (records.length === 0) return records;
  const missions = new Set(records.map((record) => record.missionId));
  const [only] = missions;
  const marks =
    missions.size === 1 && only !== null && only !== undefined
      ? yield* store.listAllInMission("inbox-mark", only)
      : yield* store.listAll("inbox-mark");
  const byId = new Map(
    marks.filter((mark) => mark.comments.length > 0).map((mark) => [mark.id, mark.comments]),
  );
  if (byId.size === 0) return records;
  return records.map((record) => {
    const comments = byId.get(markIdOf({ kind, id: record.id }));
    return comments === undefined ? record : { ...record, comments };
  });
});
