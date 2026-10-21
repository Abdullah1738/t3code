import { useState } from "react";

import { groupIMessageThreads, sortIMessageChats } from "@t3tools/client-runtime/ardud/imessage";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { deriveTimelineEntriesFromVisibleTurnItems, type WorkLogEntry } from "../../session-logic";
import {
  WorkLogBlock,
  WorkLogButton,
  WorkLogDetails,
  WorkLogList,
  WorkLogRow,
} from "../../components/chat/WorkLog";
import { useThreadShells, useThreadVisibleTurnItems } from "../../state/entities";
import { cn } from "../../lib/utils";
import { iMessageThreadInput, imessageChatLabel } from "./IMessageSidebarGroup";
import { buildIMessageChatRows, type IMessageChatRow } from "./imessageChatRows";

/**
 * Read-only transcript of one iMessage chat. Each thread's messages come from its
 * own visible turn items; the threads are stitched in date order with dividers.
 */
export function IMessageChatPage(props: { chatSlug: string }) {
  const threads = useThreadShells();
  const chat = sortIMessageChats(groupIMessageThreads(threads.map(iMessageThreadInput))).find(
    (candidate) => candidate.slug === props.chatSlug,
  );
  const label = imessageChatLabel(props.chatSlug);

  if (chat === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-5 py-10">
        <h1 className="text-2xl font-semibold text-foreground">{label}</h1>
        <p className="text-sm text-muted-foreground">No messages in this chat yet.</p>
      </div>
    );
  }

  // Chat summaries carry plain thread id strings, so key the lookup by string too.
  const byId = new Map<string, EnvironmentThreadShell>(
    threads.map((thread) => [thread.id, thread] as const),
  );
  const orderedThreads = [...chat.threadIds]
    .map((id) => byId.get(id))
    .filter((thread): thread is EnvironmentThreadShell => thread !== undefined)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-1 px-4 py-8">
      <header className="mb-4 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{label}</h1>
        <p className="text-sm text-muted-foreground">
          {orderedThreads.length === 1
            ? "1 conversation"
            : `${orderedThreads.length} conversations`}
        </p>
      </header>
      {orderedThreads.map((thread) => (
        <ChatThreadRows key={thread.id} thread={thread} />
      ))}
    </div>
  );
}

/** Subscribes to one thread's visible turn items; threads keep their own loading state. */
function ChatThreadRows(props: { thread: EnvironmentThreadShell }) {
  const { thread } = props;
  const ref: ScopedThreadRef = { environmentId: thread.environmentId, threadId: thread.id };
  const visibleTurnItems = useThreadVisibleTurnItems(ref);
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems,
    optimisticMessages: [],
  });
  const rows = buildIMessageChatRows(entries, null);
  return (
    <>
      {rows.map((row) => (
        <ChatRow key={row.id} row={row} />
      ))}
    </>
  );
}

function ChatRow(props: { row: IMessageChatRow }) {
  const { row } = props;
  switch (row.kind) {
    case "divider":
      return <DayDivider createdAt={row.createdAt} />;
    case "incoming":
      return <Bubble side="incoming" text={row.message.text} at={row.message.createdAt} />;
    case "reply":
      return <Bubble side="reply" text={row.message.text} at={row.message.createdAt} />;
    case "agent":
      return <AgentRow work={row.work} startedAt={row.startedAt} endedAt={row.endedAt} />;
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
function Bubble(props: { side: "incoming" | "reply"; text: string; at: string }) {
  const isReply = props.side === "reply";
  const time = new Date(props.at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className={cn("flex w-full flex-col gap-0.5", isReply ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[78%] rounded-3xl px-3.5 py-2 text-base leading-snug whitespace-pre-wrap break-words",
          isReply ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {props.text}
      </div>
      <time className="px-2 text-2xs text-muted-foreground">{time}</time>
    </div>
  );
}

/** One agent turn: a collapsed row with the step count, expanding to the existing work log. */
function AgentRow(props: {
  work: ReadonlyArray<WorkLogEntry>;
  startedAt: string;
  endedAt: string;
}) {
  const [open, setOpen] = useState(false);
  const seconds = Math.max(
    0,
    Math.round((new Date(props.endedAt).getTime() - new Date(props.startedAt).getTime()) / 1000),
  );
  const summary = `${props.work.length} ${props.work.length === 1 ? "step" : "steps"}${
    seconds > 0 ? `, ${seconds}s` : ""
  }`;
  return (
    <div className="flex w-full flex-col items-end">
      <WorkLogBlock layout="standalone">
        <WorkLogButton
          label={<span>Agent · {summary}</span>}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        />
        {open ? (
          <WorkLogDetails>
            <WorkLogList>
              {props.work.map((entry) => (
                <WorkLogRow key={entry.id} label={entry.label} wrapLabel />
              ))}
            </WorkLogList>
          </WorkLogDetails>
        ) : null}
      </WorkLogBlock>
    </div>
  );
}
