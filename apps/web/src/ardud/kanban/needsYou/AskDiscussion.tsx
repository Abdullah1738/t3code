import {
  askDiscussion,
  askReplyProblem,
  askThread,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
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
  /** He may reply: the composer shows even with nothing said yet. */
  open: boolean;
  /** Inside its own sheet (a phone): it fills the sheet and brings no heading. */
  sheet?: boolean;
  onOpenCard: (cardId: string) => void;
}) {
  const { entry } = props;
  // What was said counts; older versions of the ask sit between, folded away.
  const messages = askDiscussion(entry);
  const thread = askThread(entry);
  // A reply over a limit is told here, beside the composer that still holds it.
  const [problem, setProblem] = useState<string | null>(null);
  if (!props.sheet && thread.length === 0 && !props.open && !props.waiting) return null;
  const talk = (
    <>
      {thread.length > 0 ? (
        <div className="flex flex-col gap-3">
          {thread.map(({ message, earlier }) =>
            earlier ? (
              <details key={message.seq} className="group rounded-xl ring-1 ring-(--m-rule)">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3.5 py-2 text-sm text-(--m-muted) outline-none hover:bg-(--m-surface) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
                  <ChevronRightIcon
                    aria-hidden
                    className="size-4 shrink-0 transition-transform duration-150 group-open:rotate-90"
                  />
                  Earlier version
                </summary>
                {/* What it asked then, to read: its buttons no longer answer anything. */}
                <div inert className="border-t border-(--m-rule) px-3.5 py-3 opacity-80">
                  <Message
                    boardId={entry.boardId}
                    message={message}
                    cards={NO_CARDS}
                    seen={undefined}
                    onOpenCard={props.onOpenCard}
                  />
                </div>
              </details>
            ) : (
              <Message
                key={message.seq}
                boardId={entry.boardId}
                message={message}
                cards={NO_CARDS}
                seen={undefined}
                onOpenCard={props.onOpenCard}
              />
            ),
          )}
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
        <span className="text-sm font-normal text-(--m-muted) tabular-nums">
          {messages.length > 0 ? messages.length : "no messages yet"}
        </span>
      </h3>
      {talk}
      {composer}
    </section>
  );
}
