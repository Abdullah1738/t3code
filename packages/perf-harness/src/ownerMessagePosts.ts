import type { KanbanCard, KanbanMessage } from "@t3tools/contracts";
import { ownerAnswerCases } from "./ownerAnswers.ts";

export const ownerMessagePostSamples = 40;
export function ownerMessagePostCases() {
  return ownerAnswerCases().map((sample) => {
    const cardId = `synthetic-owner-post-${sample.sample}`;
    return {
      ...sample,
      kind: "post" as const,
      cardId,
      discussionId: `${cardId}-discussion`,
      askId: "q1",
      seq: 21,
      postedSeq: 22,
      question: `Synthetic question for owner post ${sample.sample}: May this change proceed?`,
      marker: `Synthetic owner post ${sample.sample}:`,
    };
  });
}
export type OwnerMessagePostCase = ReturnType<typeof ownerMessagePostCases>[number];

export function ownerMessagePostInput(sample: OwnerMessagePostCase) {
  return {
    blocks: [{ _tag: "md" as const, text: `${sample.marker} Continue with the scoped change.` }],
  };
}

export function assertOpenOwnerPost(
  sample: OwnerMessagePostCase,
  card: KanbanCard,
  message: KanbanMessage,
) {
  const ask = card.asks.find((ask) => ask.id === sample.askId);
  const asker = sample.route === "worker" || sample.route === "fallback" ? "thread" : "evaluator";
  if (
    card.id !== sample.cardId ||
    card.discussionId !== sample.discussionId ||
    card.asks.length !== 1 ||
    !ask ||
    ask.closedAt !== null ||
    ask.seq !== sample.seq ||
    ask.text !== sample.question ||
    ask.by._tag !== asker ||
    !("threadId" in ask.by) ||
    ask.by.threadId !== sample.askerThreadId ||
    message.discussionId !== sample.discussionId ||
    message.seq !== sample.seq ||
    message.answers.length !== 0 ||
    message.author._tag !== asker ||
    !("threadId" in message.author) ||
    message.author.threadId !== sample.askerThreadId ||
    message.blocks.length !== 1 ||
    message.blocks[0]?._tag !== "md" ||
    message.blocks[0].text !== sample.question
  )
    throw new Error(`Owner-post sample ${sample.sample} does not reference a fresh open ask`);
}

export function assertPersistedOwnerPost(sample: OwnerMessagePostCase, message: KanbanMessage) {
  const expected = ownerMessagePostInput(sample).blocks[0]!.text;
  if (
    message.discussionId !== sample.discussionId ||
    message.seq !== sample.postedSeq ||
    message.author._tag !== "owner" ||
    message.blocks.length !== 1 ||
    message.blocks[0]?._tag !== "md" ||
    message.blocks[0].text !== expected
  )
    throw new Error(
      `Owner-post sample ${sample.sample} has the wrong persisted sequence, author or text`,
    );
}

export function assertClosedOwnerPost(sample: OwnerMessagePostCase, card: KanbanCard) {
  if (
    card.id !== sample.cardId ||
    card.discussionId !== sample.discussionId ||
    card.asks.length !== 1 ||
    card.asks.some(
      (ask) => ask.id !== sample.askId || ask.seq !== sample.seq || ask.closedAt === null,
    )
  )
    throw new Error(`Owner-post sample ${sample.sample} did not close its original ask`);
}
