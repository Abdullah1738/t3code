import { askDiscussion, type KanbanBoardState } from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem } from "@t3tools/contracts";

import { Composer, Message } from "../Chat";
import { askAsker, replyOnAsk } from "./askStore";

const NO_CARDS: KanbanBoardState["cards"] = new Map();

/**
 * The talk under one ask, in the board's own message and composer parts. A
 * reply does not answer the ask: it hands the turn to its agent.
 */
export function AskDiscussion(props: {
  entry: KanbanAskFeedItem;
  /** The ask waits on its agent after his reply. */
  waiting: boolean;
  /** He asked to reply: the composer shows even with nothing said yet. */
  open: boolean;
  onOpenCard: (cardId: string) => void;
}) {
  const { entry } = props;
  const messages = askDiscussion(entry);
  if (messages.length === 0 && !props.open && !props.waiting) return null;
  return (
    <section aria-label="Discussion" data-ny-discussion className="flex min-w-0 flex-col gap-3">
      <h3 className="flex items-baseline gap-2 text-base font-semibold">
        Discussion
        {messages.length > 0 ? (
          <span className="text-sm font-normal text-(--m-muted) tabular-nums">
            {messages.length}
          </span>
        ) : null}
      </h3>
      {messages.length > 0 ? (
        <div className="flex flex-col gap-3">
          {messages.map((message) => (
            <Message
              key={message.seq}
              boardId={entry.boardId}
              message={message}
              cards={NO_CARDS}
              seen={undefined}
              onOpenCard={props.onOpenCard}
            />
          ))}
        </div>
      ) : null}
      {props.waiting ? (
        <p role="status" className="text-sm text-(--m-muted)">
          Waiting on {askAsker(entry)}.
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Composer
          placeholder="Ask the agent anything"
          attachments
          onSend={(blocks) => replyOnAsk(entry, blocks)}
        />
        <p className="-mt-2.5 text-xs text-(--m-muted)">Replying doesn't answer the ask.</p>
      </div>
    </section>
  );
}
