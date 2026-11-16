import { KanbanCardId, KanbanDiscussionId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { KanbanStoreShape } from "../store/KanbanStore.ts";

export const postRecoveryIdentity = (messageId: string) => {
  const match = /^kanban:post-recovery:([^:]+):(\d+):/.exec(messageId);
  if (!match) return null;
  const seq = Number(match[2]);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  try {
    return { discussionId: KanbanDiscussionId.make(decodeURIComponent(match[1]!)), seq };
  } catch {
    return null;
  }
};
export const postRecoveryKey = (discussionId: string, seq: number, delivery: string) =>
  `post-recovery:${encodeURIComponent(discussionId)}:${seq}:${encodeURIComponent(delivery)}`;

export const postRecoveryPending = Effect.fn("Kanban.postRecoveryPending")(function* (
  store: KanbanStoreShape,
  discussionId: KanbanDiscussionId,
  seq: number,
) {
  const discussion = yield* store.discussion(discussionId);
  if (
    !discussion ||
    discussion.cardId === null ||
    discussion.settledAt !== null ||
    discussion.archivedAt !== null
  )
    return false;
  // A newer post cannot replace this job's retained, still-unread body.
  const waiting = yield* store.ownerWait(discussionId, true, seq);
  if (!waiting || waiting.answered) return false;
  // Admission owns this retained body until delivery. A later message's cumulative
  // read receipt cannot prove that this particular body was delivered.
  return true;
});

export const ownerReplyKey = (discussionId: string, threadId: string, action: string) =>
  `owner-reply:${encodeURIComponent(discussionId)}:${encodeURIComponent(threadId)}:${encodeURIComponent(action)}`;

export const ownerReplyDiscussion = Effect.fn("Kanban.ownerReplyDiscussion")(function* (
  store: KanbanStoreShape,
  messageId: string,
  text: string,
) {
  if (!messageId.startsWith("kanban:wake:owner:")) return null;
  const keyed = /:owner-reply:([^:]+):/.exec(messageId);
  if (keyed) return KanbanDiscussionId.make(decodeURIComponent(keyed[1]!));
  // Wakes queued by an older release still need the delivery check.
  const legacy = /^The owner is waiting for your reply in discussion (disc-[\w-]+)\./.exec(text);
  if (legacy) return KanbanDiscussionId.make(legacy[1]!);
  const scope = /^kanban:wake:owner:((?:card|disc)-[\w-]+):/.exec(messageId)?.[1];
  if (scope?.startsWith("disc-")) return KanbanDiscussionId.make(scope);
  if (scope?.startsWith("card-"))
    return (yield* store.card(KanbanCardId.make(scope)))?.discussionId ?? null;
  return null;
});

export const ownerReplyPending = Effect.fn("Kanban.ownerReplyPending")(function* (
  store: KanbanStoreShape,
  discussionId: KanbanDiscussionId,
  threadId: ThreadId,
) {
  const discussion = yield* store.discussion(discussionId);
  if (!discussion || discussion.settledAt !== null || discussion.archivedAt !== null) return null;
  const participant = discussion.participants.find(
    (p) =>
      (p.actor._tag === "evaluator" || p.actor._tag === "thread") &&
      p.actor.threadId === threadId &&
      p.owes !== null,
  );
  // "nudged" records delivery of a reminder, not a reply to the owner.
  if (!participant) return null;
  const action = yield* store.ownerReply(
    discussionId,
    threadId,
    participant.actor._tag === "evaluator",
  );
  return action?.answered === false ? action.key : null;
});
