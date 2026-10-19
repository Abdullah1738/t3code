import { canonicalOwnerChat, inboundOccurredAt, normalizeInbound, ownerChatGuid, type CatchUpEvent, type NormalizedInbound } from "./photon.ts";
import { seenOwnPoll } from "./poll-match.ts";
import type { PollRecord, Store } from "./store.ts";

type PollEvent = Extract<CatchUpEvent, { type: "poll.changed" }>;

/** Only owner votes on polls this bridge registered become inbound rows; everything else is ignored. */
function pollVote(store: Store, event: PollEvent, owner: string): { input: NormalizedInbound; occurredAt?: number } | undefined {
  const { delta } = event;
  if ((delta.type !== "voted" && delta.type !== "unvoted") || event.isFromMe !== false
    || (event.actor !== undefined && event.actor.address !== owner)
    || typeof event.pollMessageGuid !== "string" || !event.pollMessageGuid) return;
  const poll = store.get<PollRecord>(`poll:${event.pollMessageGuid}`);
  if (!poll) return;
  const option = poll.options.find(entry => entry.optionIdentifier === delta.optionIdentifier);
  if (!option) return;
  const text = delta.type === "voted"
    ? `Voted for "${option.text}" in the poll "${poll.title}"`
    : `Removed vote for "${option.text}" in the poll "${poll.title}"`;
  const at = event.occurredAt instanceof Date ? event.occurredAt.getTime() : NaN;
  return {
    input: {
      id: `poll-vote:${event.pollMessageGuid}:${event.sequence}`, text, attachments: [], isAudioMessage: false,
      poll: { guid: event.pollMessageGuid, optionIdentifier: option.optionIdentifier, optionText: option.text,
        vote: delta.type, operationId: poll.operationId },
      // The bridge wrote this text from the vote; it is never the owner's typed words.
      source: "composed",
    },
    ...(Number.isFinite(at) ? { occurredAt: at } : {}),
  };
}

export function ingest(store: Store, event: CatchUpEvent, owner: string, enabled: boolean): boolean {
  const cutoff = store.get<number>("bootstrapCutoff");
  if (cutoff === undefined) throw new Error("Missing fixed bootstrap cutoff");
  if (event.type === "catchup.complete") {
    store.db.transaction(() => {
      store.set("photonCursor", Math.max(store.get<number>("photonCursor") ?? 0, event.headSequence));
      store.set("bootstrapped", true);
    }).immediate();
    return false;
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) throw new Error("Invalid event cursor");
  const cursor = store.get<number>("photonCursor");
  if (cursor !== undefined && event.sequence <= cursor) return false;
  return store.db.transaction(() => {
    let accepted = false;
    if (enabled && ownerChatGuid(event.chatGuid, owner) && event.type === "poll.changed" && event.isFromMe === true
      && event.delta.type === "created" && typeof event.pollMessageGuid === "string" && event.pollMessageGuid) {
      seenOwnPoll(store, event.pollMessageGuid, event.delta.options);
    }
    if (enabled && ownerChatGuid(event.chatGuid, owner)) {
      const vote = event.type === "poll.changed" ? pollVote(store, event, owner) : undefined;
      const input = vote?.input ?? normalizeInbound(event, owner, event.chatGuid);
      if (input) {
        const historical = !store.get<boolean>("bootstrapped");
        const occurredAt = vote ? vote.occurredAt : inboundOccurredAt(event);
        if (historical && occurredAt === undefined) throw new Error("Cannot classify historical event time");
        if (!historical || occurredAt! >= cutoff) {
          const canonical = canonicalOwnerChat(event.chatGuid, owner);
          const previous = store.get<string>("chatGuid");
          if (previous && canonicalOwnerChat(previous, owner) !== canonical) throw new Error("Chat identity changed");
          store.set("chatGuid", canonical);
          store.set("paired", true);
          accepted = store.acceptInbound(input.id, { ...input, receivedAt: Date.now() });
        }
      }
    }
    store.set("photonCursor", event.sequence);
    return accepted;
  }).immediate();
}
