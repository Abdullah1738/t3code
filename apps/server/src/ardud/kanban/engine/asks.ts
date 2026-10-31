/** A card's questions for the owner: blocking ones hold it in Needs Owner, async ones don't. */
import {
  kanbanOpenAsks,
  type KanbanActor,
  type KanbanBlock,
  type KanbanCard,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";

/** Ids are never reused, so an answer to an old ask can't land on a new one. */
export const nextAskId = (card: Pick<KanbanCard, "asks">) => `q${card.asks.length + 1}`;

export const addAsk = (
  card: KanbanCard,
  text: string,
  blocking: boolean,
  by: KanbanActor,
  at: string,
): KanbanCard => ({
  ...card,
  asks: [...card.asks, { id: nextAskId(card), text, blocking, by, at, seq: null, closedAt: null }],
});

export const findOpenAsk = (card: KanbanCard, askId: string) =>
  kanbanOpenAsks(card).find((ask) => ask.id === askId);

/** Closes the open asks that match (all by default). */
export const closeAsks = (
  card: KanbanCard,
  at: string,
  which: (ask: KanbanOwnerAsk) => boolean = () => true,
): KanbanCard =>
  card.asks.some((ask) => ask.closedAt === null && which(ask))
    ? {
        ...card,
        asks: card.asks.map((ask) =>
          ask.closedAt === null && which(ask) ? { ...ask, closedAt: at } : ask,
        ),
      }
    : card;

export const updateAsk = (
  card: KanbanCard,
  askId: string,
  patch: Partial<Pick<KanbanOwnerAsk, "blocking" | "seq">>,
): KanbanCard => ({
  ...card,
  asks: card.asks.map((ask) => (ask.id === askId ? { ...ask, ...patch } : ask)),
});

/** The newest open blocking ask: whoever asked it gets the owner's answer. */
export const openBlockingAsk = (card: KanbanCard) =>
  kanbanOpenAsks(card).findLast((ask) => ask.blocking);

/** A plain question, or a pick (its block id is the ask id) when it has options; multi lets the owner tick several. */
export const askBlocks = (
  ask: KanbanOwnerAsk,
  options: ReadonlyArray<string>,
  multi = false,
): ReadonlyArray<KanbanBlock> => {
  const labels = options.map((option) => option.trim()).filter((option) => option.length > 0);
  return labels.length > 0
    ? [
        {
          _tag: "choice",
          id: ask.id,
          style: "pick",
          question: ask.text,
          options: labels.map((label, index) => ({ id: `o${index + 1}`, label })),
          multi,
        },
      ]
    : [{ _tag: "md", text: ask.text }];
};

/** For an evaluator passing on an answer whose asker can't hear it any more. */
export const passOnText = (card: KanbanCard, ask: KanbanOwnerAsk, answer: string) =>
  `This answers question ${ask.id} on card #${card.number} ("${ask.text}"), asked by a thread that has moved on. Act on it or pass it on (card_edit, card_thread):\n\n${answer}`;

export const droppedText = (card: KanbanCard, ask: KanbanOwnerAsk, byOwner: boolean) =>
  `Question ${ask.id} on card #${card.number} ("${ask.text}") was dropped${byOwner ? " by the owner" : ""}. Go on without it.`;
