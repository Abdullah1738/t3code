import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, SendIcon } from "lucide-react";

import type { MissionId } from "@t3tools/contracts";
import {
  ageView,
  formatRelative,
  groupRequests,
  isRequestUnread,
  lastMasterReply,
  REQUEST_STATUS_LABEL,
  type MissionViewsState,
  type OwnerRequest,
  type OwnerRequestMessage,
  type ResolvedViewLayout,
  type ViewSectionEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { cn } from "../../../lib/utils";
import {
  AgeElement,
  AnsweredMark,
  AnyLinkChip,
  Avatar,
  Chip,
  PersonChip,
  RefChip,
  UnreadDot,
} from "../cards/chips";
import {
  markRequestRead,
  openRequest,
  reopenRequest,
  replyRequest,
  settleRequest,
} from "../missionCommands";
import { useOwnerRequest } from "../missionsStore";
import { FoldButton, LoadingRows, SectionShell } from "./SectionShell";

// What the owner asked or told the master: a compose line, one row per request,
// and the open request's conversation in place of the list.

export function YourRequestsSection(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  section: ViewSectionEntry;
  requests: ReadonlyArray<OwnerRequest> | undefined;
  /** The open request, from the URL's `request` param. */
  openId: string | null;
  nowMs: number;
}) {
  const setOpenId = useRequestOpener(props.missionId);
  const groups = useMemo(() => groupRequests(props.requests ?? []), [props.requests]);
  const unread = useMemo(
    () => (props.requests ?? []).filter(isRequestUnread).length,
    [props.requests],
  );
  const waiting = groups.open.filter((request) => request.status === "waiting").length;
  const open = props.requests?.find((request) => request.id === props.openId) ?? null;
  return (
    <SectionShell
      missionId={props.missionId}
      views={props.views}
      layout={props.layout}
      section={props.section}
      meta={
        <span className="inline-flex items-center gap-3">
          <AnsweredMark count={unread} label={`${unread} answered, unread`} />
          {waiting > 0 ? (
            <span className="text-sm text-(--m-muted) tabular-nums">{waiting} waiting</span>
          ) : null}
        </span>
      }
    >
      {open ? (
        <RequestThread
          key={open.id}
          request={open}
          nowMs={props.nowMs}
          onBack={() => setOpenId(null)}
        />
      ) : (
        <>
          <ComposeLine missionId={props.missionId} onOpened={setOpenId} />
          {props.requests === undefined ? (
            <LoadingRows />
          ) : props.requests.length === 0 ? (
            <p className="pt-1.5 pb-1 text-sm">Nothing asked yet.</p>
          ) : (
            <>
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
        </>
      )}
    </SectionShell>
  );
}

/** The quiet "Ask or tell the master" line; it opens into the composer. */
function ComposeLine(props: { missionId: MissionId; onOpened: (id: string) => void }) {
  const [writing, setWriting] = useState(false);
  if (writing) {
    return (
      <div className="mt-1 mb-2">
        <RequestComposer
          missionId={props.missionId}
          autoFocus
          onOpened={(id) => {
            setWriting(false);
            props.onOpened(id);
          }}
          onCancel={() => setWriting(false)}
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setWriting(true)}
      className="mt-1 mb-2 flex h-9.5 items-center rounded-full bg-(--m-raised) px-4 text-start text-sm text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      Ask or tell the master
    </button>
  );
}

/**
 * Opens a request by putting it in the URL, so every request link (sidebar,
 * header, pinned strip) and the section's own rows share one open state.
 */
export function useRequestOpener(missionId: MissionId) {
  const navigate = useNavigate();
  return useCallback(
    (requestId: string | null) => {
      void navigate({
        to: "/missions/$missionId",
        params: { missionId },
        // Keeps the highlighted sub-mission; the request param lives on the board only.
        search: (prev) => {
          const { request: _closed, tab: _tab, ...rest } = prev;
          return requestId ? { ...rest, request: requestId } : rest;
        },
        resetScroll: false,
      });
    },
    [missionId, navigate],
  );
}

/** Opens a new owner request; every question to the master starts here. */
export function RequestComposer(props: {
  missionId: MissionId;
  onOpened: (id: string) => void;
  autoFocus?: boolean;
  /** Escape, or leaving it empty, closes it. */
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    const created = await openRequest(props.missionId, text);
    setBusy(false);
    if (created) {
      setText("");
      props.onOpened(created.id);
    }
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
        autoFocus={props.autoFocus}
        aria-label="Ask or tell the master"
        placeholder="Ask or tell the master"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
          if (event.key === "Escape" && props.onCancel) {
            event.preventDefault();
            props.onCancel();
          }
        }}
        onBlur={(event) => {
          const next = event.relatedTarget;
          const inForm = next instanceof Node && event.currentTarget.form?.contains(next);
          if (props.onCancel && text.trim() === "" && !inForm) props.onCancel();
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

function RequestRow(props: { request: OwnerRequest; nowMs: number; onOpen: () => void }) {
  const { request } = props;
  const unread = isRequestUnread(request);
  const age = ageView(request.updatedAt, props.nowMs);
  const reply = request.status === "answered" ? lastMasterReply(request) : null;
  return (
    <li className="min-w-0 border-t border-(--m-rule)">
      <button
        type="button"
        onClick={props.onOpen}
        className="grid w-full min-w-0 grid-cols-[14px_minmax(0,1fr)_auto_auto] items-baseline gap-x-3 gap-y-0.5 py-3.25 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="self-center">{unread ? <UnreadDot label="New answer" /> : null}</span>
        <span
          className={cn(
            "min-w-0 text-sm text-(--m-text) max-sm:line-clamp-2 sm:truncate",
            unread && "font-semibold",
          )}
        >
          {request.title}
        </span>
        <span
          className={cn(
            "text-xs whitespace-nowrap",
            unread ? "font-medium text-(--m-accent-text)" : "text-(--m-muted)",
          )}
        >
          {REQUEST_STATUS_LABEL[request.status]}
        </span>
        {age ? <AgeElement age={age} at={request.updatedAt} /> : <span />}
        {reply ? (
          <span className="col-start-2 col-end-5 min-w-0 text-sm text-(--m-muted) max-sm:line-clamp-2 sm:truncate">
            {reply.text.split("\n")[0]}
          </span>
        ) : null}
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
  return (
    <>
      <FoldButton
        hidden={props.requests.length}
        label={`Settled ${props.requests.length}`}
        expanded={shown}
        onShow={() => setShown((value) => !value)}
      />
      {shown && props.requests.length > 0 ? (
        <ul aria-label="Settled requests" className="flex min-w-0 flex-col">
          {props.requests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              nowMs={props.nowMs}
              onOpen={() => props.onOpen(request.id)}
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** The request's conversation with Send and Settle (Reopen once settled). */
export function RequestThread(props: {
  request: OwnerRequest;
  nowMs: number;
  onBack: () => void;
  /** `h2` when the thread stands alone on the board. */
  heading?: "h2" | "h3";
}) {
  // The list carries the newest few messages as summaries; the thread read has them all.
  const request = useOwnerRequest(props.request.missionId, props.request.id) ?? props.request;
  const Heading = props.heading ?? "h3";
  const unread = isRequestUnread(request);
  useEffect(() => {
    if (unread) markRequestRead(request.id);
  }, [unread, request.id]);
  // Request links (sidebar, pinned strip) can open a thread below the fold on phones.
  // Keyed by request id at every call site, so this runs once per opened thread.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.scrollIntoView({ block: "nearest" });
  }, []);
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
    <div ref={root} className="flex min-w-0 scroll-mt-4 flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Back to requests"
          onClick={props.onBack}
        >
          <ArrowLeftIcon aria-hidden />
        </Button>
        <Chip>{REQUEST_STATUS_LABEL[request.status]}</Chip>
      </div>
      <Heading className="max-w-[34ch] text-xl font-normal text-pretty sm:text-2xl">
        {request.title}
      </Heading>
      <ol aria-label="Conversation" className="mt-2 flex max-w-[72ch] min-w-0 flex-col gap-3.5">
        {request.messages.map((message) => (
          <ConversationMessage key={message.id} message={message} nowMs={props.nowMs} />
        ))}
      </ol>
      {request.links.length > 0 ? (
        <div aria-label="What the master made" className="flex min-w-0 flex-wrap gap-2">
          {request.links.map((ref) => (
            <RefChip key={`${ref.kind}:${ref.id}`} record={ref} />
          ))}
        </div>
      ) : null}
      {settled ? null : (
        <div className="mt-2 flex max-w-[72ch] min-w-0 items-end gap-2">
          <Textarea
            size="sm"
            aria-label="Reply to the master"
            placeholder="Reply to the master"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || text.trim() === ""}
            onClick={() => void run(() => replyRequest(request.id, text), true)}
          >
            Send
          </Button>
        </div>
      )}
      <div className="flex min-w-0 items-center gap-1.5 border-t border-(--m-rule) pt-3">
        {settled ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(() => reopenRequest(request.id))}
          >
            Reopen
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(() => settleRequest(request.id, text), true)}
          >
            {text.trim() === "" ? "Settle" : "Settle with note"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** A thread message: the owner's on the right in a bubble, the master's on the left. */
function ConversationMessage(props: { message: OwnerRequestMessage; nowMs: number }) {
  const { message } = props;
  const owner = message.author === "owner";
  return (
    <li className={cn("flex min-w-0 flex-col gap-1.5", owner && "max-w-[60ch] self-end")}>
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 text-xs text-(--m-muted)",
          owner && "justify-end",
        )}
      >
        {owner ? null : <Avatar kind="master" />}
        <span>{owner ? "You" : "Master"}</span>
        <time dateTime={message.at} className="tabular-nums">
          {formatRelative(message.at, props.nowMs)}
        </time>
      </div>
      <p
        className={cn(
          "text-sm text-pretty whitespace-pre-line",
          owner ? "rounded-3xl bg-(--m-raised) px-4 py-3 leading-5.5" : "leading-6",
        )}
      >
        {message.text}
      </p>
      <MessageRefs message={message} />
    </li>
  );
}

function MessageRefs(props: { message: OwnerRequestMessage }) {
  if (props.message.refs.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {props.message.refs.map((link) => (
        <AnyLinkChip key={`${link.kind}:${link.ref ?? link.url ?? link.label}`} link={link} />
      ))}
    </div>
  );
}

/** One message of an item's discussion: who, when, the text. */
export function RequestMessage(props: { message: OwnerRequestMessage; nowMs: number }) {
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
      <MessageRefs message={message} />
    </li>
  );
}

/** Requests the master answered since the owner last read them. */
export function unreadRequests(requests: ReadonlyArray<OwnerRequest> | undefined) {
  if (!requests) return [];
  return requests.filter(isRequestUnread);
}
