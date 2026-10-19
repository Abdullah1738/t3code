import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, SendIcon } from "lucide-react";

import type { MissionId } from "@t3tools/contracts";
import {
  ageView,
  groupRequests,
  isRequestUnread,
  REQUEST_STATUS_LABEL,
  requestPreview,
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
  AnyLinkChip,
  PersonChip,
  RefChip,
  StateGlyph,
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
import { SectionCount, SectionShell } from "./SectionShell";

// What the owner asked or told the master: a composer, one row per request,
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
  const open = props.requests?.find((request) => request.id === props.openId) ?? null;
  return (
    <SectionShell
      missionId={props.missionId}
      views={props.views}
      layout={props.layout}
      section={props.section}
      meta={<SectionCount count={unread} tone="update" label={`${unread} answered, unread`} />}
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

export const STATUS_GLYPH = {
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
  // Request links (sidebar, header) can open a thread below the fold on phones.
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
      <div className="flex min-w-0 items-center gap-2">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Back to requests"
          onClick={props.onBack}
        >
          <ArrowLeftIcon aria-hidden />
        </Button>
        <Heading className="min-w-0 truncate text-sm font-semibold">{request.title}</Heading>
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
      {request.links.length > 0 ? (
        <div aria-label="What the master made" className="flex min-w-0 flex-wrap gap-1.5">
          {request.links.map((ref) => (
            <RefChip key={`${ref.kind}:${ref.id}`} record={ref} />
          ))}
        </div>
      ) : null}
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

/** One message of a request; `compact` clamps it to three lines on a card. */
export function RequestMessage(props: {
  message: OwnerRequestMessage;
  nowMs: number;
  compact?: boolean;
}) {
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
      <p
        className={cn(
          "text-sm leading-5.5 text-pretty whitespace-pre-line",
          props.compact && "line-clamp-3",
        )}
      >
        {message.text}
      </p>
      {message.refs.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {message.refs.map((link) => (
            <AnyLinkChip key={`${link.kind}:${link.ref ?? link.url ?? link.label}`} link={link} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** Requests the master answered since the owner last read them. */
export function unreadRequests(requests: ReadonlyArray<OwnerRequest> | undefined) {
  if (!requests) return [];
  return requests.filter(isRequestUnread);
}

/** Answered requests the owner has not opened, for the header count. */
export function RequestsUnreadLink(props: {
  missionId: MissionId;
  requests: ReadonlyArray<OwnerRequest> | undefined;
}) {
  const unread = unreadRequests(props.requests);
  const first = unread[0];
  const count = unread.length;
  if (!first) return null;
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
