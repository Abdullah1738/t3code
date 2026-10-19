import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { SendIcon } from "lucide-react";

import type { MissionId, MissionRecordRef, OwnerCondition } from "@t3tools/contracts";
import {
  isRequestUnread,
  REQUEST_STATUS_LABEL,
  requestAbout,
  type OwnerRequest,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import type { CardAction } from "./cards/CardFrame";
import { StateGlyph } from "./cards/chips";
import { discussRecord, markRequestRead, replyRequest, settleRequest } from "./missionCommands";
import { useOwnerRequests } from "./missionsStore";
import { RequestMessage, STATUS_GLYPH } from "./sections/YourRequests";

// Discuss on a Needs-you card: an owner request about the record. The card
// shows the open conversation inline; the full thread lives under Your
// requests. The record keeps waiting until someone decides it.

/** Newest messages shown on a card; the rest are one click away. */
const CARD_MESSAGES = 2;

export interface CardDiscussion {
  /** The card's Discuss action ("Discussing" once a request is open). */
  readonly action: CardAction | null;
  /** The inline conversation and composer, or null when there is nothing to show. */
  readonly panel: ReactNode;
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
  const [composing, setComposing] = useState(false);
  if (missionId === null) return { action: null, panel: null };
  const action: CardAction = {
    key: "discuss",
    label: request ? "Discussing" : "Discuss",
    onRun: () => {
      if (request && isRequestUnread(request)) markRequestRead(request.id);
      setComposing((open) => !open);
    },
  };
  const panel =
    request || composing ? (
      <DiscussPanel
        missionId={missionId}
        subject={subject}
        request={request}
        composing={composing}
        onClose={() => setComposing(false)}
        nowMs={nowMs}
      />
    ) : null;
  return { action, panel };
}

function DiscussPanel(props: {
  missionId: MissionId;
  subject: MissionRecordRef;
  request: OwnerRequest | null;
  composing: boolean;
  onClose: () => void;
  nowMs: number;
}) {
  const { request } = props;
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
  // Replying goes to the open request; the first message opens one about the record.
  const send = () =>
    run(
      () =>
        request
          ? replyRequest(request.id, text)
          : discussRecord(props.missionId, props.subject, text),
      false,
    );
  const recent = request ? request.messages.slice(-CARD_MESSAGES) : [];
  return (
    <section
      aria-label="Discussion with the master"
      className="flex min-w-0 flex-col gap-2.5 rounded-lg bg-muted/50 px-3 py-2.5"
    >
      {request ? (
        <>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StateGlyph kind={STATUS_GLYPH[request.status]} />
            <span>{REQUEST_STATUS_LABEL[request.status]}</span>
            <Link
              to="/missions/$missionId"
              params={{ missionId: props.missionId }}
              search={{ request: request.id }}
              className="ms-auto rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              Open
            </Link>
          </div>
          {recent.length > 0 ? (
            <ol aria-label="Latest messages" className="flex min-w-0 flex-col gap-2.5">
              {recent.map((message) => (
                <RequestMessage key={message.id} message={message} nowMs={props.nowMs} compact />
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
      {props.composing ? (
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <Textarea
            size="sm"
            autoFocus
            aria-label={request ? "Reply to the master" : "What to discuss"}
            placeholder={request ? "Reply" : "What do you want to talk through?"}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex min-w-0 items-center gap-1.5">
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={busy || text.trim() === ""}
            >
              <SendIcon aria-hidden />
              {request ? "Reply" : "Send"}
            </Button>
            {request ? (
              <Button
                type="button"
                size="sm"
                variant="ghost-muted"
                disabled={busy}
                onClick={() => void run(() => settleRequest(request.id), true)}
              >
                Settle
              </Button>
            ) : (
              <Button type="button" size="sm" variant="ghost-muted" onClick={props.onClose}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : null}
    </section>
  );
}

/** "Decided by master on your condition", with the owner's words it rests on. */
export function ConditionNote(props: { condition: OwnerCondition }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">Decided by master on your condition</span>
      <blockquote className="text-sm text-pretty">{`\u201c${props.condition.quote}\u201d`}</blockquote>
    </div>
  );
}
