import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, SendIcon } from "lucide-react";

import type { MissionId } from "@t3tools/contracts";
import {
  ageView,
  groupRequests,
  isRequestUnread,
  REQUEST_STATUS_LABEL,
  requestPreview,
  type MissionLayout,
  type OwnerRequest,
  type OwnerRequestMessage,
  type SectionEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { cn } from "../../../lib/utils";
import { AgeElement, PersonChip, RefChip, StateGlyph, UnreadDot } from "../cards/chips";
import {
  markRequestRead,
  openRequest,
  reopenRequest,
  replyRequest,
  settleRequest,
} from "../missionCommands";
import { SectionCount, SectionShell } from "./SectionShell";

// What the owner asked or told the master: a composer, one row per request,
// and the open request's conversation in place of the list.

export function YourRequestsSection(props: {
  missionId: MissionId;
  layout: MissionLayout;
  section: SectionEntry;
  requests: ReadonlyArray<OwnerRequest> | undefined;
  /** Request opened from the URL (pinned strip, sidebar). */
  openId: string | null;
  sample: boolean;
  nowMs: number;
}) {
  // The URL's request wins whenever it changes; a row click overrides it until then.
  const [picked, setPicked] = useState({ fromUrl: props.openId, id: props.openId });
  const openId = picked.fromUrl === props.openId ? picked.id : props.openId;
  const setOpenId = (id: string | null) => setPicked({ fromUrl: props.openId, id });
  const groups = useMemo(() => groupRequests(props.requests ?? []), [props.requests]);
  const unread = useMemo(
    () => (props.requests ?? []).filter(isRequestUnread).length,
    [props.requests],
  );
  const open = props.requests?.find((request) => request.id === openId) ?? null;
  return (
    <SectionShell
      missionId={props.missionId}
      layout={props.layout}
      section={props.section}
      sample={props.sample}
      meta={<SectionCount count={unread} tone="update" label={`${unread} answered, unread`} />}
    >
      {open ? (
        <RequestThread request={open} nowMs={props.nowMs} onBack={() => setOpenId(null)} />
      ) : (
        <>
          <RequestComposer missionId={props.missionId} onOpened={setOpenId} />
          {groups.open.length > 0 ? (
            <ul aria-label="Open requests" className="flex min-w-0 flex-col">
              {groups.open.map((request) => (
                <RequestRow
                  key={request.id}
                  request={request}
                  nowMs={props.nowMs}
                  onOpen={() => setOpenId(request.id)}
                />
              ))}
            </ul>
          ) : null}
          <SettledFold
            requests={groups.settled}
            nowMs={props.nowMs}
            onOpen={(id) => setOpenId(id)}
          />
        </>
      )}
    </SectionShell>
  );
}

function RequestComposer(props: { missionId: MissionId; onOpened: (id: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    const sent = await openRequest(props.missionId, text);
    setBusy(false);
    if (sent) setText("");
  };
  return (
    <form
      className="flex min-w-0 items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        size="sm"
        aria-label="Ask or tell the master"
        placeholder="Ask or tell the master"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <Button
        type="submit"
        size="icon-sm"
        aria-label="Send to the master"
        disabled={busy || text.trim() === ""}
      >
        <SendIcon aria-hidden />
      </Button>
    </form>
  );
}

const STATUS_GLYPH = {
  waiting: "wait",
  answered: "ok",
  settled: "done",
} as const;

function RequestRow(props: { request: OwnerRequest; nowMs: number; onOpen: () => void }) {
  const { request } = props;
  const unread = isRequestUnread(request);
  const age = ageView(request.updatedAt, props.nowMs);
  return (
    <li className="min-w-0 border-t border-border/60">
      <button
        type="button"
        onClick={props.onOpen}
        className="grid w-full min-w-0 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-sm py-2.5 text-start outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <StateGlyph
          kind={STATUS_GLYPH[request.status]}
          label={REQUEST_STATUS_LABEL[request.status]}
        />
        <span
          className={cn(
            "min-w-0 truncate text-sm",
            unread ? "font-semibold text-foreground" : "font-medium text-foreground",
          )}
        >
          {request.title}
        </span>
        <span className="flex items-center gap-2">
          {unread ? <UnreadDot label="New answer" /> : null}
          {age ? <AgeElement age={age} at={request.updatedAt} /> : null}
        </span>
        <span className="col-start-2 col-end-4 min-w-0 truncate text-xs text-muted-foreground">
          {requestPreview(request)}
        </span>
      </button>
    </li>
  );
}

function SettledFold(props: {
  requests: ReadonlyArray<OwnerRequest>;
  nowMs: number;
  onOpen: (id: string) => void;
}) {
  const [shown, setShown] = useState(false);
  if (props.requests.length === 0) return null;
  if (!shown) {
    return (
      <Button size="xs" variant="ghost-muted" className="self-start" onClick={() => setShown(true)}>
        Settled ({props.requests.length})
      </Button>
    );
  }
  return (
    <ul aria-label="Settled requests" className="flex min-w-0 flex-col opacity-80">
      {props.requests.map((request) => (
        <RequestRow
          key={request.id}
          request={request}
          nowMs={props.nowMs}
          onOpen={() => props.onOpen(request.id)}
        />
      ))}
    </ul>
  );
}

/** The request's conversation with Reply and Settle (Reopen once settled). */
function RequestThread(props: { request: OwnerRequest; nowMs: number; onBack: () => void }) {
  const { request } = props;
  const unread = isRequestUnread(request);
  useEffect(() => {
    if (unread) markRequestRead(request.id);
  }, [unread, request.id]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const settled = request.status === "settled";
  const run = async (action: () => Promise<boolean>, clear = false) => {
    setBusy(true);
    const sent = await action();
    setBusy(false);
    if (sent && clear) setText("");
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Back to requests"
          onClick={props.onBack}
        >
          <ArrowLeftIcon aria-hidden />
        </Button>
        <h3 className="min-w-0 truncate text-sm font-semibold">{request.title}</h3>
        <span className="ms-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <StateGlyph kind={STATUS_GLYPH[request.status]} />
          {REQUEST_STATUS_LABEL[request.status]}
        </span>
      </div>
      <ol aria-label="Conversation" className="flex min-w-0 flex-col gap-3">
        {request.messages.map((message) => (
          <RequestMessage key={message.id} message={message} nowMs={props.nowMs} />
        ))}
      </ol>
      {settled ? null : (
        <Textarea
          size="sm"
          aria-label="Reply to the master"
          placeholder="Reply"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        {settled ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(() => reopenRequest(request.id))}
          >
            Reopen
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              className="min-w-21"
              disabled={busy || text.trim() === ""}
              onClick={() => void run(() => replyRequest(request.id, text), true)}
            >
              Reply
            </Button>
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={busy}
              onClick={() => void run(() => settleRequest(request.id))}
            >
              Settle
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function RequestMessage(props: { message: OwnerRequestMessage; nowMs: number }) {
  const { message } = props;
  const age = ageView(message.at, props.nowMs);
  const owner = message.author === "owner";
  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <PersonChip kind={owner ? "you" : "master"} name={owner ? "You" : "Master"} />
        {age ? (
          <span className="ms-auto">
            <AgeElement age={age} at={message.at} />
          </span>
        ) : null}
      </div>
      <p className="text-sm leading-5.5 text-pretty whitespace-pre-line">{message.text}</p>
      {message.refs.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {message.refs.map((ref) => (
            <RefChip key={`${ref.kind}:${ref.id}`} record={ref} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** Answered requests the owner has not opened, for the header and sidebar counts. */
export function RequestsUnreadLink(props: {
  missionId: MissionId;
  requests: ReadonlyArray<OwnerRequest> | undefined;
}) {
  const first = props.requests?.find(isRequestUnread) ?? null;
  const count = props.requests?.filter(isRequestUnread).length ?? 0;
  if (!first || count === 0) return null;
  return (
    <Link
      to="/missions/$missionId"
      params={{ missionId: props.missionId }}
      search={{ request: first.id }}
      className="inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <UnreadDot />
      <span className="tabular-nums">{count}</span>
      <span>{count === 1 ? "answer" : "answers"}</span>
    </Link>
  );
}
