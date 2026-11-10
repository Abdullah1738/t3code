import {
  askDiscussion,
  askReplyProblem,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem } from "@t3tools/contracts";
import { useState } from "react";

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
  /** Inside its own sheet (a phone): it fills the sheet and brings no heading. */
  sheet?: boolean;
  onOpenCard: (cardId: string) => void;
}) {
  const { entry } = props;
  const messages = askDiscussion(entry);
  // A reply over a limit is told here, beside the composer that still holds it.
  const [problem, setProblem] = useState<string | null>(null);
  if (!props.sheet && messages.length === 0 && !props.open && !props.waiting) return null;
  const talk = (
    <>
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
      ) : props.sheet ? (
        <p className="text-sm text-(--m-muted)">Nothing said yet.</p>
      ) : null}
      {props.waiting ? (
        <p role="status" className="text-sm text-(--m-muted)">
          Waiting on {askAsker(entry)}.
        </p>
      ) : null}
    </>
  );
  const composer = (
    <div className="flex flex-col gap-1.5">
      <Composer
        placeholder="Ask the agent anything"
        attachments
        onSend={(blocks) => {
          setProblem(askReplyProblem(blocks));
          return replyOnAsk(entry, blocks);
        }}
      />
      {problem ? (
        <p role="alert" className="-mt-2.5 text-sm text-(--m-negative)">
          {problem}
        </p>
      ) : (
        <p className="-mt-2.5 text-xs text-(--m-muted)">Replying doesn't answer the ask.</p>
      )}
    </div>
  );
  if (props.sheet) {
    return (
      <div data-ny-discussion className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4">
          {talk}
        </div>
        <div className="shrink-0 px-4 pt-1 pb-3">{composer}</div>
      </div>
    );
  }
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
      {talk}
      {composer}
    </section>
  );
}
