import type { KanbanCard } from "@t3tools/contracts";

/**
 * The card a drawer shows.
 *
 * The board feed's copy of a card is live but trimmed: no description or prompt,
 * the wake note only as "pending", long titles, questions, asks and subtask
 * texts cut short and subtask notes left out. The card read on its own has all
 * of it but can be a moment behind the feed. So: the newer of the two for
 * everything that changes as the board works, and the long texts always from
 * the full read.
 *
 * `loaded` is false until the full card has arrived. A drawer must not show a
 * missing description as "no description" before then.
 */
export function drawerCard(
  feed: KanbanCard,
  full: KanbanCard | undefined,
): { readonly card: KanbanCard; readonly loaded: boolean } {
  if (full === undefined || full.id !== feed.id) return { card: feed, loaded: false };
  if (full.updatedAt >= feed.updatedAt) return { card: full, loaded: true };
  // The feed is ahead: keep its state, put back the texts it trimmed.
  const whole = (short: string, long: string) => (long.startsWith(short) ? long : short);
  const subtasks = new Map(full.subtasks.map((subtask) => [subtask.id, subtask]));
  const asks = new Map(full.asks.map((ask) => [ask.id, ask]));
  return {
    loaded: true,
    card: {
      ...feed,
      title: whole(feed.title, full.title),
      description: full.description,
      prompt: full.prompt,
      wakeNote: feed.wakeNote === "pending" ? (full.wakeNote ?? feed.wakeNote) : feed.wakeNote,
      question:
        feed.question === null || full.question === null
          ? feed.question
          : whole(feed.question, full.question),
      stalled:
        feed.stalled === null || full.stalled === null
          ? feed.stalled
          : { ...feed.stalled, reason: whole(feed.stalled.reason, full.stalled.reason) },
      subtasks: feed.subtasks.map((subtask) => {
        const known = subtasks.get(subtask.id);
        return known === undefined
          ? subtask
          : {
              ...subtask,
              text: whole(subtask.text, known.text),
              note: subtask.note ?? known.note,
            };
      }),
      asks: feed.asks.map((ask) => {
        const known = asks.get(ask.id);
        return known === undefined ? ask : { ...ask, text: whole(ask.text, known.text) };
      }),
    },
  };
}
