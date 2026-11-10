import type { KanbanCard, KanbanMessage } from "@t3tools/contracts";

export const ownerAnswerWorkload = "owner-writes-v3";
export const ownerAnswerSamples = 40;
export type OwnerAnswerRoute = "worker" | "evaluator" | "fallback" | "launch";

// Each request consumes a different open ask. Re-picking a closed choice can
// otherwise time an idempotent delivery retry instead of an owner answer.
export function ownerAnswerCases() {
  return Array.from({ length: ownerAnswerSamples }, (_, sample) => {
    const route = (["worker", "evaluator", "fallback", "launch"] as const)[sample % 4]!;
    const kind = Math.floor(sample / 4) % 2 === 0 ? "text" : "pick";
    const cardId = `synthetic-owner-answer-${sample}`;
    return {
      sample,
      route,
      kind,
      cardId,
      discussionId: `${cardId}-discussion`,
      askId: kind === "pick" ? "q2" : "q1",
      seq: kind === "pick" ? 22 : 21,
      marker: `Synthetic owner answer ${sample}:`,
      askerThreadId:
        route === "worker"
          ? "synthetic-thread-20"
          : route === "evaluator"
            ? "synthetic-thread-21"
            : route === "fallback"
              ? "synthetic-thread-22"
              : "synthetic-thread-19",
      recipientThreadId:
        route === "worker"
          ? "synthetic-thread-20"
          : route === "launch"
            ? null
            : "synthetic-thread-21",
    };
  });
}
export type OwnerAnswerCase = ReturnType<typeof ownerAnswerCases>[number];

export function mockAnswerDelivery(
  raw: string,
  samples: ReadonlyArray<Pick<OwnerAnswerCase, "sample" | "marker">> = ownerAnswerCases(),
) {
  // A concurrent append may leave the final record incomplete until the next poll.
  const prompts = raw
    .split("\n")
    .slice(0, -1)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((request) => request.method === "session/prompt");
  const missing = samples.filter(
    (sample) =>
      !prompts.some((request) => JSON.stringify(request.params?.prompt).includes(sample.marker)),
  );
  return {
    observed: samples.length - missing.length,
    missing: missing.map((sample) => sample.sample),
  };
}

export function ownerAnswerRequest(sample: OwnerAnswerCase) {
  return {
    path: `/api/ardud/kanban/discussions/${sample.discussionId}/answer`,
    body: {
      seq: sample.seq,
      blockId: sample.askId,
      choice: sample.kind === "text" ? [] : ["o2"],
      text: sample.kind === "text" ? `${sample.marker} Continue with the scoped change.` : null,
    },
  };
}

export function assertOpenOwnerAsk(
  sample: OwnerAnswerCase,
  card: KanbanCard,
  message: KanbanMessage,
) {
  const ask = card.asks.find((ask) => ask.id === sample.askId);
  if (
    card.id !== sample.cardId ||
    card.discussionId !== sample.discussionId ||
    !ask ||
    ask.closedAt !== null ||
    ask.seq !== sample.seq ||
    ask.by._tag === "owner" ||
    !("threadId" in ask.by) ||
    ask.by.threadId !== sample.askerThreadId ||
    message.discussionId !== sample.discussionId ||
    message.seq !== sample.seq ||
    message.answers.length !== 0
  )
    throw new Error(`Owner-answer sample ${sample.sample} does not reference a fresh open ask`);
  if (
    !message.blocks.some(
      (block) =>
        block._tag === "choice" &&
        block.id === sample.askId &&
        block.style === "pick" &&
        block.options.some((option) => option.id === "o2"),
    )
  )
    throw new Error(`Owner-answer sample ${sample.sample} choice/sequence mismatch`);
}

export function assertClosedOwnerAsk(
  sample: OwnerAnswerCase,
  card: KanbanCard,
  message: KanbanMessage,
) {
  const ask = card.asks.find((ask) => ask.id === sample.askId);
  if (!ask || ask.seq !== sample.seq || ask.closedAt === null)
    throw new Error(`Owner-answer sample ${sample.sample} did not close its ask`);
  const answer = message.answers.find(
    (answer) => answer.blockId === sample.askId && answer.by._tag === "owner",
  );
  const expected = ownerAnswerRequest(sample).body;
  if (
    message.discussionId !== sample.discussionId ||
    message.seq !== sample.seq ||
    !answer ||
    answer.choice.length !== expected.choice.length ||
    answer.choice.some((id, index) => id !== expected.choice[index]) ||
    answer.text !== expected.text ||
    (sample.kind === "pick" && card.asks.find((ask) => ask.id === "q1")?.closedAt !== null)
  )
    throw new Error(`Owner-answer sample ${sample.sample} answered the wrong ask, option or text`);
}
