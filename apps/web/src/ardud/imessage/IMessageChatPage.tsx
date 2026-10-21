import { memo, useState } from "react";
import { Link } from "@tanstack/react-router";

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
import {
  WorkLogBlock,
  WorkLogButton,
  WorkLogDetails,
  WorkLogList,
} from "../../components/chat/WorkLog";
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
import { iMessageThreadInput, imessageChatLabel } from "./IMessageSidebarGroup";
import {
  buildIMessageChatRows,
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
          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-1 px-5 text-center">
            <h1 className="text-lg font-medium text-foreground">{label}</h1>
            <p className="text-sm text-muted-foreground">No messages yet.</p>
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
  const kind = imessageChatKind(props.chatSlug);

  return (
    // column-reverse opens at the bottom and keeps the reader's place when earlier
    // threads are added above, without measuring anything.
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-y-contain scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-1 px-4 pt-4 pb-8">
        <h1 className="sr-only">{props.label}</h1>
        {start > 0 ? (
          <div className="flex justify-center pb-2">
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
            namedSenders={kind !== "owner"}
            showSenders={kind === "group"}
            chatLabel={props.label}
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
  showSenders: boolean;
  chatLabel: string;
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
        <ChatRow
          key={row.id}
          row={row}
          thread={thread}
          showSender={(sender) =>
            sender !== null && (props.showSenders || sender !== props.chatLabel)
          }
        />
      ))}
    </>
  );
});

function ChatRow(props: {
  row: IMessageChatRow;
  thread: EnvironmentThreadShell;
  showSender: (sender: string | null) => boolean;
}) {
  const { row } = props;
  switch (row.kind) {
    case "divider":
      return <DayDivider createdAt={row.createdAt} />;
    case "incoming":
      return (
        <Bubble
          side="incoming"
          text={row.voice && row.text.length === 0 ? "Voice message, not transcribed" : row.text}
          at={row.createdAt}
          sender={row.senderChanged && props.showSender(row.sender) ? row.sender : null}
          quote={row.quote}
          voice={row.voice}
        />
      );
    case "reply":
      return <Bubble side="reply" text={row.text} at={row.createdAt} />;
    case "event":
      return (
        <p className="mx-auto my-1.5 max-w-full truncate px-6 text-center text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{row.source}</span>
          {row.title.length > 0 ? ` · ${row.title}` : null}
        </p>
      );
    case "agent":
      return <AgentRow row={row} thread={props.thread} />;
  }
}

function DayDivider(props: { createdAt: string }) {
  const label = new Date(props.createdAt).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return <div className="my-4 text-center text-xs font-medium text-muted-foreground">{label}</div>;
}

/**
 * Standard iMessage look: incoming gray on the left, sent blue on the right. Colours
 * come from the app's own tokens so light and dark follow the theme.
 */
function Bubble(props: {
  side: "incoming" | "reply";
  text: string;
  at: string;
  sender?: string | null;
  quote?: string | null;
  voice?: boolean;
}) {
  const isReply = props.side === "reply";
  const time = new Date(props.at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className={cn("flex w-full flex-col gap-0.5", isReply ? "items-end" : "items-start")}>
      {props.sender ? (
        <span className="px-3.5 pt-1 text-xs text-muted-foreground">{props.sender}</span>
      ) : null}
      {props.quote ? (
        <p className="line-clamp-2 max-w-[70%] px-3.5 text-xs text-muted-foreground">
          {props.quote}
        </p>
      ) : null}
      <div
        className={cn(
          "max-w-[78%] rounded-3xl px-3.5 py-2 text-base leading-snug whitespace-pre-wrap break-words",
          isReply ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {props.text}
      </div>
      <time dateTime={props.at} className="px-2 text-2xs text-muted-foreground">
        {props.voice ? `Voice · ${time}` : time}
      </time>
    </div>
  );
}

const OUTCOME_LABEL = { replied: "Agent", "no-reply": "No reply", working: "Working" } as const;

/** One agent turn: a collapsed summary line that expands to every step and hidden frame. */
function AgentRow(props: {
  row: Extract<IMessageChatRow, { kind: "agent" }>;
  thread: EnvironmentThreadShell;
}) {
  const { row, thread } = props;
  const [open, setOpen] = useState(false);
  const seconds = Math.max(
    0,
    Math.round((new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime()) / 1000),
  );
  const steps = row.steps.length;
  const summary = [
    OUTCOME_LABEL[row.outcome],
    steps > 0 ? `${steps} ${steps === 1 ? "step" : "steps"}` : null,
    seconds > 0 ? formatDuration(seconds) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <div className="w-full">
      <WorkLogBlock layout="standalone">
        <WorkLogButton label={summary} aria-expanded={open} onClick={() => setOpen((v) => !v)} />
        {open ? (
          <WorkLogDetails>
            <WorkLogList>
              {row.steps.map((step) => (
                <AgentStep key={step.id} step={step} />
              ))}
            </WorkLogList>
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: thread.environmentId, threadId: thread.id }}
              className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              Open thread
            </Link>
          </WorkLogDetails>
        ) : null}
      </WorkLogBlock>
    </div>
  );
}

function AgentStep(props: { step: IMessageAgentStep }) {
  const { step } = props;
  const [open, setOpen] = useState(false);
  if (step.detail === null) {
    return (
      <p className={cn("py-0.5 text-sm", step.error ? "text-destructive" : "text-secondary-label")}>
        {step.label}
      </p>
    );
  }
  return (
    <>
      <WorkLogButton
        label={<span className={cn(step.error && "text-destructive")}>{step.label}</span>}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open ? (
        <p className="ms-0.5 mb-2 text-xs whitespace-pre-wrap break-words text-muted-foreground select-text">
          {step.detail}
        </p>
      ) : null}
    </>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
