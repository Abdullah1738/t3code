import { useEffect, useState, type ReactNode } from "react";
import { SendIcon } from "lucide-react";

import type { MissionId, MissionRecordRef, OwnerCondition } from "@t3tools/contracts";
import {
  ageView,
  discussionUnread,
  isRequestUnread,
  requestAbout,
  requestPreview,
  type OwnerRequest,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import type { CardAction } from "./cards/CardFrame";
import { AgeElement, Avatar, DiscussionSymbol } from "./cards/chips";
import { discussRecord, markRequestRead, replyRequest, settleRequest } from "./missionCommands";
import { useOwnerRequest, useOwnerRequests } from "./missionsStore";
import { RequestMessage } from "./sections/YourRequests";

// Discuss on a card: an owner request about the record, kept on the record
// (owner, 19 Oct: "Discussions stay on the item"). Closed, the card shows the
// latest line and an unread mark; open, the whole conversation and a reply box
// sit right above the card's decisions. It never shows under Your requests.

export interface CardDiscussion {
  /** The card's Discuss action ("Discussing" once a request is open). */
  readonly action: CardAction | null;
  /** The discussion on the card, or null when there is nothing to show. */
  readonly panel: ReactNode;
  /** The discussion symbol with its unread count, once a discussion exists. */
  readonly symbol: ReactNode;
}

/**
 * Discuss for one record. `missionId` is null for records outside any mission
 * (a global suggestion): they have no master to discuss with.
 */
export function useCardDiscussion(
  missionId: MissionId | null,
  subject: MissionRecordRef,
  nowMs: number,
): CardDiscussion {
  const requests = useOwnerRequests(missionId);
  const request = requests ? requestAbout(requests, subject) : null;
  const [open, setOpen] = useState(false);
  if (missionId === null) return { action: null, panel: null, symbol: null };
  const action: CardAction = {
    key: "discuss",
    label: request ? "Discussing" : "Discuss",
    onRun: () => setOpen((value) => !value),
  };
  let panel: ReactNode = null;
  if (request && open) {
    panel = (
      <DiscussionThread
        key={request.id}
        request={request}
        onClose={() => setOpen(false)}
        nowMs={nowMs}
      />
    );
  } else if (request) {
    panel = <DiscussionLine request={request} onOpen={() => setOpen(true)} nowMs={nowMs} />;
  } else if (open) {
    panel = (
      <DiscussionComposer
        onSend={(text) => discussRecord(missionId, subject, text)}
        onClose={() => setOpen(false)}
      />
    );
  }
  const symbol = request ? <DiscussionSymbol unread={discussionUnread(request)} /> : null;
  return { action, panel, symbol };
}

const PANEL_CLASS =
  "flex max-w-[72ch] min-w-0 flex-col gap-2.5 rounded-xl bg-(--m-raised) px-3.5 py-3";

/** Closed: a raised strip with the latest reply; opens the conversation. */
function DiscussionLine(props: { request: OwnerRequest; onOpen: () => void; nowMs: number }) {
  const { request } = props;
  const last = request.messages.at(-1);
  const age = last ? ageView(last.at, props.nowMs) : null;
  const count = request.messages.length;
  return (
    <button
      type="button"
      aria-label="Open the discussion"
      onClick={props.onOpen}
      className="grid max-w-[72ch] min-w-0 grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-xl bg-(--m-raised) px-3.5 py-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="row-span-2 self-start">
        <Avatar kind="master" />
      </span>
      <span className="flex min-w-0 items-baseline gap-2 text-xs text-(--m-muted)">
        <span className="text-sm font-semibold text-(--m-text)">Discussion</span>
        <span className="tabular-nums">
          {count}
          {request.hasOlder ? "+" : ""} {count === 1 && !request.hasOlder ? "message" : "messages"}
        </span>
        {age && last ? <AgeElement age={age} at={last.at} /> : null}
      </span>
      <span className="text-sm font-medium text-(--m-accent-text)">Open</span>
      <span className="col-span-2 line-clamp-2 text-sm text-pretty text-(--m-text)">
        {requestPreview(request)}
      </span>
    </button>
  );
}

/** Open: the whole conversation with full bodies, a reply box and Settle. */
function DiscussionThread(props: { request: OwnerRequest; onClose: () => void; nowMs: number }) {
  const request = useOwnerRequest(props.request.missionId, props.request.id) ?? props.request;
  const unread = isRequestUnread(request);
  useEffect(() => {
    if (unread) markRequestRead(request.id);
  }, [unread, request.id]);
  return (
    <section aria-label="Discussion with the master" className={PANEL_CLASS}>
      <ol aria-label="Conversation" className="flex min-w-0 flex-col gap-2.5">
        {request.messages.map((message) => (
          <RequestMessage key={message.id} message={message} nowMs={props.nowMs} />
        ))}
      </ol>
      <DiscussionComposer
        reply
        onSend={(text) => replyRequest(request.id, text)}
        onSettle={(note) => settleRequest(request.id, note)}
        onClose={props.onClose}
      />
    </section>
  );
}

function DiscussionComposer(props: {
  /** Replying in an open discussion rather than starting one. */
  reply?: boolean;
  onSend: (text: string) => Promise<boolean>;
  /** Settles with the box's text, when any, as the closing note. */
  onSettle?: (note: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<boolean>, close: boolean) => {
    setBusy(true);
    const sent = await action();
    setBusy(false);
    if (!sent) return;
    setText("");
    if (close) props.onClose();
  };
  const send = () => {
    if (text.trim() !== "") void run(() => props.onSend(text), false);
  };
  const form = (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Textarea
        size="sm"
        autoFocus
        aria-label={props.reply ? "Reply to the master" : "What to discuss"}
        placeholder={props.reply ? "Reply" : "What do you want to talk through?"}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="flex min-w-0 items-center gap-1.5">
        <Button type="submit" size="sm" variant="secondary" disabled={busy || text.trim() === ""}>
          <SendIcon aria-hidden />
          {props.reply ? "Reply" : "Send"}
        </Button>
        {props.onSettle ? (
          <Button
            type="button"
            size="sm"
            variant="ghost-muted"
            disabled={busy}
            onClick={() => {
              const settle = props.onSettle;
              if (settle) void run(() => settle(text), true);
            }}
          >
            {text.trim() === "" ? "Settle" : "Settle with note"}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost-muted" onClick={props.onClose}>
          {props.reply ? "Close" : "Cancel"}
        </Button>
      </div>
    </form>
  );
  // A reply sits inside the thread's panel; a first message gets its own.
  return props.reply ? (
    form
  ) : (
    <section aria-label="Discuss with the master" className={PANEL_CLASS}>
      {form}
    </section>
  );
}

/** "Decided by master on your condition", with the owner's words it rests on. */
export function ConditionNote(props: { condition: OwnerCondition }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-(--m-muted)">Decided by master on your condition</span>
      <blockquote className="text-sm text-pretty">{`\u201c${props.condition.quote}\u201d`}</blockquote>
    </div>
  );
}
