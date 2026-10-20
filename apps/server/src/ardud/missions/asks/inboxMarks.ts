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
  Suggestion,
} from "@t3tools/contracts";
import { approverOf } from "@t3tools/contracts";

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
