import { memo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";

import {
  groupIMessageThreads,
  imessageChatKind,
  imessageDayKey,
  imessageThreadWindowStart,
  sortIMessageThreadsByCreation,
} from "@t3tools/client-runtime/ardud/imessage";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { Button } from "../../components/ui/button";
import { SidebarInset } from "../../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { useThreadShells, useThreadVisibleTurnItems } from "../../state/entities";
import { cn } from "../../lib/utils";
import { IMessageAvatar, iMessageThreadInput, imessageChatLabel } from "./IMessageSidebarGroup";
import {
  buildIMessageChatRows,
  formatIMessageDuration,
  imessageAgentSummary,
  type IMessageAgentStep,
  type IMessageChatRow,
} from "./imessageChatRows";

/**
 * Read-only transcript of one iMessage chat, stitched from its threads oldest first.
 * Only the newest threads are mounted, since each holds a live subscription.
 */
export function IMessageChatPage(props: { chatSlug: string }) {
  const threads = useThreadShells();
  const chat = groupIMessageThreads(threads.map(iMessageThreadInput)).find(
    (candidate) => candidate.slug === props.chatSlug,
  );
  const label = imessageChatLabel(props.chatSlug, chat?.latestTitle);

  // Chat summaries carry plain thread id strings, so key the lookup by string too.
  const byId = new Map<string, EnvironmentThreadShell>(
    threads.map((thread) => [thread.id, thread] as const),
  );
  const chatThreads = sortIMessageThreadsByCreation(
    (chat?.threadIds ?? [])
      .map((id) => byId.get(id))
      .filter((thread): thread is EnvironmentThreadShell => thread !== undefined),
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} reserveNativeControls>
          <WorkspaceBreadcrumb ariaLabel={label} className="overflow-hidden">
            <WorkspaceBreadcrumbItem current>
              <WorkspaceBreadcrumbText>{label}</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {chatThreads.length === 0 ? (
          <div className="flex flex-1 flex-col items-center gap-2.5 px-4 pt-9 pb-10 text-center">
            <h1 className="sr-only">{label}</h1>
            <IMessageAvatar label={label} size="large" />
            <p className="text-(length:--im-bubble-text) text-muted-foreground">No messages yet.</p>
          </div>
        ) : (
          // Remount per chat so the window and scroll position start fresh.
          <ChatTranscript
            key={props.chatSlug}
            chatSlug={props.chatSlug}
            label={label}
            threads={chatThreads}
          />
        )}
      </div>
    </SidebarInset>
  );
}

function ChatTranscript(props: {
  chatSlug: string;
  label: string;
  threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const [openedAt] = useState(() => Date.now());
  const [earlierDays, setEarlierDays] = useState(0);
  const start = imessageThreadWindowStart(props.threads, openedAt, earlierDays);
  const visible = props.threads.slice(start);
  const namedSenders = imessageChatKind(props.chatSlug) !== "owner";

  return (
    // column-reverse opens at the bottom and keeps the reader's place when earlier
    // threads are added above, without measuring anything.
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-y-contain scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-[620px] flex-col px-6 pt-3 pb-6 max-sm:px-3.5 max-sm:pt-1 max-sm:pb-4">
        <h1 className="sr-only">{props.label}</h1>
        {start > 0 ? (
          <div className="flex justify-center pt-2 pb-1">
            <Button variant="outline" size="sm" onClick={() => setEarlierDays((days) => days + 1)}>
              Show earlier
            </Button>
          </div>
        ) : null}
        {visible.map((thread, index) => (
          <ChatThreadRows
            key={thread.id}
            thread={thread}
            previousDayKey={index === 0 ? null : imessageDayKey(visible[index - 1]!.updatedAt)}
            namedSenders={namedSenders}
          />
        ))}
      </div>
    </div>
  );
}

/** Subscribes to one thread's visible turn items; threads keep their own loading state. */
const ChatThreadRows = memo(function ChatThreadRows(props: {
  thread: EnvironmentThreadShell;
  previousDayKey: string | null;
  namedSenders: boolean;
}) {
  const { thread } = props;
  const visibleTurnItems = useThreadVisibleTurnItems({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const activeRunId = threadRuntimeIsActive(thread.runtime)
    ? (thread.runtime?.activeRunId ?? null)
    : null;
  const rows = buildIMessageChatRows(
    deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems, optimisticMessages: [] }),
    { previousDayKey: props.previousDayKey, namedSenders: props.namedSenders, activeRunId },
  );
  return (
    <>
      {rows.map((row) => (
        <ChatRow key={row.id} row={row} thread={thread} />
      ))}
    </>
  );
});

function ChatRow(props: { row: IMessageChatRow; thread: EnvironmentThreadShell }) {
  const { row } = props;
  switch (row.kind) {
    case "divider":
      return (
        <p className="mt-3.5 mb-1.5 text-center text-xs font-medium text-muted-foreground">
          {new Date(row.createdAt).toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </p>
      );
    case "time":
      return (
        <time
          dateTime={row.createdAt}
          className="mt-3.5 mb-1.5 text-center text-2xs text-muted-foreground"
        >
          {new Date(row.createdAt).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}
        </time>
      );
    case "incoming":
      return (
        <Bubble
          side="incoming"
          text={row.voice && row.text.length === 0 ? "Voice message, not transcribed" : row.text}
          sender={row.senderChanged ? row.sender : null}
          quote={row.quote}
          voice={row.voice && row.text.length > 0}
        />
      );
    case "reply":
      return <Bubble side="reply" text={row.text} />;
    case "event":
      return (
        <p className="my-1.5 max-w-[85%] self-center text-center text-xs leading-snug wrap-anywhere text-muted-foreground">
          <span className="font-semibold text-foreground">{row.source}</span>
          {row.title.length > 0 ? ` · ${row.title}` : null}
        </p>
      );
    case "agent":
      return <AgentRow row={row} thread={props.thread} />;
  }
}

/** Messages' own look: grey incoming bubbles on the left, blue sent ones on the right. */
function Bubble(props: {
  side: "incoming" | "reply";
  text: string;
  sender?: string | null;
  quote?: string | null;
  voice?: boolean;
}) {
  const isReply = props.side === "reply";
  return (
    <div
      className={cn(
        "mt-[3px] flex max-w-[78%] flex-col",
        isReply ? "items-end self-end" : "items-start self-start",
      )}
    >
      {props.sender ? (
        <span className="ms-[13px] mt-1.5 mb-0.5 text-xs text-muted-foreground">
          {props.sender}
        </span>
      ) : null}
      {props.quote ? (
        <p className="ms-[13px] mb-0.5 line-clamp-2 text-xs text-muted-foreground">{props.quote}</p>
      ) : null}
      <div
        className={cn(
          "max-w-full rounded-(--im-bubble-radius) px-3.25 py-2 text-(length:--im-bubble-text) leading-snug whitespace-pre-wrap wrap-anywhere max-sm:text-base",
          isReply ? "bg-(--im-out) text-white" : "bg-(--im-in) text-(--im-in-ink)",
        )}
      >
        {props.text}
      </div>
      {props.voice ? (
        <span className="ms-[13px] mt-0.5 text-2xs text-muted-foreground">Voice message</span>
      ) : null}
    </div>
  );
}

/** The chip above a reply; it opens the turn's steps in place, between chip and reply. */
function AgentRow(props: {
  row: Extract<IMessageChatRow, { kind: "agent" }>;
  thread: EnvironmentThreadShell;
}) {
  const { row, thread } = props;
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "mt-1 inline-flex items-center gap-1 self-end rounded-md px-1.5 pt-1 pb-0.5 text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          open ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {imessageAgentSummary(row)}
        <Chevron aria-hidden className="size-3.5" />
      </button>
      {open ? (
        <div className="mt-1 mb-1.5 w-[78%] self-end rounded-xl bg-(--im-raised) px-4 py-3.5 max-sm:w-[92%]">
          {row.steps.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {row.steps.map((step) => (
                <AgentStep key={step.id} step={step} />
              ))}
            </ul>
          ) : null}
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId: thread.environmentId, threadId: thread.id }}
            className={cn(
              "inline-flex items-center gap-1.5 text-(length:--im-detail-text) text-(--im-link) underline-offset-2 hover:underline",
              row.steps.length > 0 && "mt-3",
            )}
          >
            <ExternalLinkIcon aria-hidden className="size-3.5" />
            Open thread
          </Link>
        </div>
      ) : null}
    </>
  );
}

function AgentStep(props: { step: IMessageAgentStep }) {
  const { step } = props;
  const [open, setOpen] = useState(false);
  const text = step.code ? (
    <code className="font-mono text-xs wrap-anywhere">{step.text}</code>
  ) : (
    step.text
  );
  return (
    <li className="grid grid-cols-[112px_minmax(0,1fr)_auto] items-baseline gap-x-2.5 text-(length:--im-detail-text) leading-snug">
      <span className={step.error ? "text-destructive" : "text-(--im-muted)"}>{step.label}</span>
      {step.detail === null ? (
        <span className="text-foreground wrap-anywhere">{text}</span>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="rounded-sm text-start text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <span className={cn("wrap-anywhere", !open && "line-clamp-2")}>{text}</span>
        </button>
      )}
      <span className="text-xs text-(--im-muted) tabular-nums">
        {step.seconds === null ? null : formatIMessageDuration(step.seconds)}
      </span>
      {open && step.detail !== null ? (
        <p className="col-start-2 col-end-4 mt-1.5 max-h-72 overflow-y-auto text-xs whitespace-pre-wrap wrap-anywhere text-(--im-muted) select-text">
          {step.detail}
        </p>
      ) : null}
    </li>
  );
}
