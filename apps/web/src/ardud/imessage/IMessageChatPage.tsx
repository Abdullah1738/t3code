import { memo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, PaperclipIcon, XIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import {
  buildIMessageChatRows,
  formatIMessageDuration,
  groupIMessageThreads,
  IMESSAGE_ROW_LEVELS,
  imessageAgentSummary,
  imessageChatKind,
  imessageChatLabel,
  imessageDayKey,
  imessageEarlierStep,
  imessageRowsAtLevel,
  imessageThreadInput,
  imessageThreadWindowStart,
  sortIMessageThreadsByCreation,
  type IMessageAgentStep,
  type IMessageChatRow,
  type IMessageRowLevel,
  type IMessageSend,
  type IMessageTurn,
} from "@t3tools/client-runtime/ardud/imessage";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { shouldShowLoadEarlierControl } from "@t3tools/client-runtime/state/threads";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { Button } from "../../components/ui/button";
import { Sheet, SheetPopup, SheetTitle } from "../../components/ui/sheet";
import { SidebarInset } from "../../components/ui/sidebar";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useThreadHistory, useThreadShells, useThreadVisibleTurnItems } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { IMessageAvatar } from "./IMessageSidebarGroup";

const LEVEL_KEY = "robob.imessage.rowLevel";
const LevelSchema = Schema.Literals(["conversation", "system", "everything"]);
const LEVEL_LABEL: Record<IMessageRowLevel, string> = {
  conversation: "Conversation",
  system: "+ System",
  everything: "Everything",
};
const LEVEL_HINT: Record<IMessageRowLevel, string> = {
  conversation: "Only what people typed and what was texted back",
  system: "Also watcher events, bridge requests and other agents' messages",
  everything: "Also each agent's own closing note, never texted",
};

interface SelectedTurn {
  readonly threadId: string;
  readonly turnId: string;
}

/**
 * One iMessage chat: the conversation as it happened on the phone, stitched from
 * the chat's threads oldest first, with each agent turn opening in an inspector
 * beside it. Only the newest threads are mounted, since each holds a live subscription.
 */
export function IMessageChatPage(props: { chatSlug: string }) {
  const threads = useThreadShells();
  const chat = groupIMessageThreads(threads.map(imessageThreadInput)).find(
    (candidate) => candidate.slug === props.chatSlug,
  );
  const label = imessageChatLabel(props.chatSlug, chat?.latestTitle);
  const [level, setLevel] = useLocalStorage(LEVEL_KEY, "conversation", LevelSchema);
  const [selected, setSelected] = useState<SelectedTurn | null>(null);
  const narrow = useMediaQuery("max-lg");

  // Chat summaries carry plain thread id strings, so key the lookup by string too.
  const byId = new Map<string, EnvironmentThreadShell>(
    threads.map((thread) => [thread.id, thread] as const),
  );
  const chatThreads = sortIMessageThreadsByCreation(
    (chat?.threadIds ?? [])
      .map((id) => byId.get(id))
      .filter((thread): thread is EnvironmentThreadShell => thread !== undefined),
  );
  const selectedThread = selected === null ? undefined : byId.get(selected.threadId);
  const toggleTurn = (turn: SelectedTurn) =>
    setSelected((current) =>
      current?.threadId === turn.threadId && current.turnId === turn.turnId ? null : turn,
    );

  const inspector =
    selected !== null && selectedThread !== undefined ? (
      <TurnInspector
        key={`${selected.threadId}:${selected.turnId}`}
        thread={selectedThread}
        turnId={selected.turnId}
        onClose={() => setSelected(null)}
      />
    ) : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} reserveNativeControls>
          <WorkspaceBreadcrumb ariaLabel={label} className="overflow-hidden">
            <WorkspaceBreadcrumbItem current>
              <WorkspaceBreadcrumbText>{label}</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <ToggleGroup
            aria-label="What the transcript shows"
            className="ms-auto shrink-0 [-webkit-app-region:no-drag]"
            variant="segmented"
            value={[level]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "conversation" || next === "system" || next === "everything") {
                setLevel(next);
              }
            }}
          >
            {IMESSAGE_ROW_LEVELS.map((option) => (
              <Toggle key={option} value={option} title={LEVEL_HINT[option]}>
                {LEVEL_LABEL[option]}
              </Toggle>
            ))}
          </ToggleGroup>
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1">
          {chatThreads.length === 0 ? (
            <div className="flex flex-1 flex-col items-center gap-2.5 px-4 pt-9 pb-10 text-center">
              <h1 className="sr-only">{label}</h1>
              <IMessageAvatar label={label} size="large" />
              <p className="text-(length:--im-bubble-text) text-muted-foreground">
                No messages yet.
              </p>
            </div>
          ) : (
            // Remount per chat so the window and scroll position start fresh.
            <ChatTranscript
              key={props.chatSlug}
              chatSlug={props.chatSlug}
              label={label}
              threads={chatThreads}
              level={level}
              selected={selected}
              onSelect={toggleTurn}
            />
          )}
          {!narrow && inspector !== null ? (
            <aside
              aria-label="Turn details"
              className="flex w-[380px] shrink-0 flex-col border-s bg-(--im-raised)"
            >
              {inspector}
            </aside>
          ) : null}
        </div>
      </div>
      {narrow ? (
        <Sheet
          open={inspector !== null}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <SheetPopup side="bottom" showCloseButton={false} className="max-h-[85dvh]">
            {inspector}
          </SheetPopup>
        </Sheet>
      ) : null}
    </SidebarInset>
  );
}

function ChatTranscript(props: {
  chatSlug: string;
  label: string;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  level: IMessageRowLevel;
  selected: SelectedTurn | null;
  onSelect: (turn: SelectedTurn) => void;
}) {
  const [openedAt] = useState(() => Date.now());
  const [earlierDays, setEarlierDays] = useState(0);
  const start = imessageThreadWindowStart(props.threads, openedAt, earlierDays);
  const visible = props.threads.slice(start);
  const namedSenders = imessageChatKind(props.chatSlug) !== "owner";
  const oldest = visible[0]!;
  const oldestHistory = useThreadHistory({
    environmentId: oldest.environmentId,
    threadId: oldest.id,
  });
  const loadEarlierHistory = useLoadEarlierHistory();
  const earlierStep = imessageEarlierStep({
    windowStart: start,
    oldestHasMoreHistory: oldestHistory.hasMoreHistory,
  });

  return (
    // column-reverse opens at the bottom and keeps the reader's place when earlier
    // threads are added above, without measuring anything.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col-reverse overflow-y-auto overscroll-y-contain scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-[620px] flex-col px-6 pt-3 pb-6 max-sm:px-3.5 max-sm:pt-1 max-sm:pb-4">
        <h1 className="sr-only">{props.label}</h1>
        {earlierStep !== null || oldestHistory.error !== null ? (
          <ShowEarlier
            loading={earlierStep === "history" && oldestHistory.loading}
            error={oldestHistory.error}
            onShow={
              earlierStep === "history"
                ? () => loadEarlierHistory(oldest)
                : earlierStep === "sessions"
                  ? () => setEarlierDays((days) => days + 1)
                  : null
            }
          />
        ) : null}
        {visible.map((thread, index) => (
          <ChatThreadRows
            key={thread.id}
            thread={thread}
            previousDayKey={index === 0 ? null : imessageDayKey(visible[index - 1]!.updatedAt)}
            namedSenders={namedSenders}
            pagesOwnHistory={index > 0}
            level={props.level}
            selectedTurnId={props.selected?.threadId === thread.id ? props.selected.turnId : null}
            onSelect={props.onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function useLoadEarlierHistory() {
  const load = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  // One bounded page per click; the loader ignores clicks while a page is in flight.
  return (thread: EnvironmentThreadShell) => {
    void load({ environmentId: thread.environmentId, input: { threadId: thread.id } });
  };
}

function ShowEarlier(props: {
  loading: boolean;
  error: string | null;
  onShow: (() => void) | null;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 pt-2 pb-1">
      {props.onShow !== null ? (
        <Button variant="outline" size="sm" disabled={props.loading} onClick={props.onShow}>
          {props.loading ? "Loading…" : "Show earlier"}
        </Button>
      ) : null}
      {props.error !== null ? (
        <p role="status" className="text-center text-xs text-muted-foreground">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** One thread's rows, from its own subscription to its turn items. */
function useThreadRows(
  thread: EnvironmentThreadShell,
  previousDayKey: string | null,
  namedSenders: boolean,
) {
  const ref = { environmentId: thread.environmentId, threadId: thread.id };
  const visibleTurnItems = useThreadVisibleTurnItems(ref);
  const activeRunId = threadRuntimeIsActive(thread.runtime)
    ? (thread.runtime?.activeRunId ?? null)
    : null;
  return buildIMessageChatRows(
    deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems, optimisticMessages: [] }),
    { previousDayKey, namedSenders, activeRunId },
  );
}

const ChatThreadRows = memo(function ChatThreadRows(props: {
  thread: EnvironmentThreadShell;
  previousDayKey: string | null;
  namedSenders: boolean;
  /** The oldest shown session pages through the transcript's top control instead. */
  pagesOwnHistory: boolean;
  level: IMessageRowLevel;
  selectedTurnId: string | null;
  onSelect: (turn: SelectedTurn) => void;
}) {
  const { thread } = props;
  const history = useThreadHistory(
    props.pagesOwnHistory ? { environmentId: thread.environmentId, threadId: thread.id } : null,
  );
  const loadEarlierHistory = useLoadEarlierHistory();
  const { rows } = useThreadRows(thread, props.previousDayKey, props.namedSenders);
  return (
    <>
      {shouldShowLoadEarlierControl(history) ? (
        <ShowEarlier
          loading={history.loading}
          error={history.error}
          onShow={history.hasMoreHistory ? () => loadEarlierHistory(thread) : null}
        />
      ) : null}
      {imessageRowsAtLevel(rows, props.level).map((row) => (
        <ChatRow
          key={row.id}
          row={row}
          selected={row.kind === "agent" && row.turn.id === props.selectedTurnId}
          onSelect={(turnId) => props.onSelect({ threadId: thread.id, turnId })}
        />
      ))}
    </>
  );
});

function ChatRow(props: {
  row: IMessageChatRow;
  selected: boolean;
  onSelect: (turnId: string) => void;
}) {
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
          {formatClock(row.createdAt)}
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
      return <SentBubble send={row.send} />;
    case "event":
      return <EventLine source={row.source} title={row.title} detail={row.detail} />;
    case "injected":
      return <InjectedCard title={row.title} text={row.text} />;
    case "note":
      return (
        <div className="mt-1.5 mb-1 flex max-w-[78%] flex-col items-end self-end">
          <span className="me-1 mb-0.5 text-2xs text-muted-foreground">Agent note, not sent</span>
          <p className="rounded-xl bg-(--im-note) px-3 py-2 text-(length:--im-detail-text) leading-snug whitespace-pre-wrap wrap-anywhere text-(--im-note-ink)">
            {row.text}
          </p>
        </div>
      );
    case "agent":
      return <TurnChip turn={row.turn} selected={props.selected} onSelect={props.onSelect} />;
  }
}

/** Messages' own look: grey incoming bubbles on the left, blue sent ones on the right. */
function Bubble(props: {
  side: "incoming" | "reply";
  text: string;
  sender?: string | null;
  quote?: string | null;
  voice?: boolean;
  dim?: boolean;
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
          props.dim && "opacity-60",
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

/** A text that really went out: its bubble, any file, the chat it went to and its state. */
function SentBubble(props: { send: IMessageSend }) {
  const { send } = props;
  const status =
    send.state === "failed" ? "Send failed" : send.state === "sending" ? "Sending…" : null;
  return (
    <div className="mt-[3px] flex max-w-[78%] flex-col items-end self-end">
      {send.to !== null ? (
        <span className="me-[13px] mt-1.5 mb-0.5 text-xs text-muted-foreground">To {send.to}</span>
      ) : null}
      {send.file !== null ? (
        <span className="mb-[3px] inline-flex max-w-full items-center gap-1.5 rounded-(--im-bubble-radius) bg-(--im-out) px-3.25 py-2 text-(length:--im-detail-text) text-white">
          <PaperclipIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{send.file}</span>
        </span>
      ) : null}
      {send.text.length > 0 ? (
        <div
          className={cn(
            "max-w-full rounded-(--im-bubble-radius) bg-(--im-out) px-3.25 py-2 text-(length:--im-bubble-text) leading-snug whitespace-pre-wrap wrap-anywhere text-white max-sm:text-base",
            send.state !== "sent" && "opacity-60",
          )}
        >
          {send.text}
        </div>
      ) : null}
      {status !== null ? (
        <span
          role="status"
          className={cn(
            "me-1 mt-0.5 text-2xs",
            send.state === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {status}
        </span>
      ) : null}
    </div>
  );
}

/** A watcher event or bridge request: a centred line that opens to its full text. */
function EventLine(props: { source: string; title: string; detail: string | null }) {
  const [open, setOpen] = useState(false);
  const line = (
    <>
      <span className="font-semibold text-foreground">{props.source}</span>
      {props.title.length > 0 ? ` · ${props.title}` : null}
    </>
  );
  return (
    <div className="my-1.5 flex max-w-[85%] flex-col items-center self-center">
      {props.detail === null ? (
        <p className="text-center text-xs leading-snug wrap-anywhere text-muted-foreground">
          {line}
        </p>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="rounded-sm text-center text-xs leading-snug wrap-anywhere text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {line}
        </button>
      )}
      {open && props.detail !== null ? (
        <p className="mt-1.5 max-h-72 w-full overflow-y-auto rounded-lg bg-(--im-raised) px-3 py-2 text-start text-xs whitespace-pre-wrap wrap-anywhere text-(--im-muted) select-text">
          {props.detail}
        </p>
      ) : null}
    </div>
  );
}

/** A prompt another agent put into the chat thread, set apart from what people typed. */
function InjectedCard(props: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  const more = props.text.trim() !== props.title;
  return (
    <div className="my-2 w-[86%] self-center rounded-xl bg-(--im-agent) px-3.5 py-2.5 text-(--im-agent-ink)">
      <p className="text-xs font-semibold">From another agent</p>
      {more ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="mt-0.5 w-full rounded-sm text-start text-(length:--im-detail-text) leading-snug outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <span className={cn("whitespace-pre-wrap wrap-anywhere", !open && "line-clamp-2")}>
            {open ? props.text : props.title}
          </span>
        </button>
      ) : (
        <p className="mt-0.5 text-(length:--im-detail-text) leading-snug wrap-anywhere">
          {props.title}
        </p>
      )}
    </div>
  );
}

/** The chip above a turn's texts; it opens the turn in the inspector. */
function TurnChip(props: {
  turn: IMessageTurn;
  selected: boolean;
  onSelect: (turnId: string) => void;
}) {
  const { turn } = props;
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={() => props.onSelect(turn.id)}
      className={cn(
        "mt-1 inline-flex items-center gap-1.5 self-end rounded-md px-2 pt-1 pb-0.5 text-xs outline-none hover:bg-(--im-raised) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        props.selected ? "bg-(--im-raised) font-semibold text-foreground" : "text-muted-foreground",
      )}
    >
      {turn.outcome === "working" ? (
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-(--im-dot)" />
      ) : turn.errorCount > 0 ? (
        <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
      ) : null}
      {imessageAgentSummary(turn)}
    </button>
  );
}

/** Everything behind one turn, in time order: what came in, the work and texts, the note. */
function TurnInspector(props: {
  thread: EnvironmentThreadShell;
  turnId: string;
  onClose: () => void;
}) {
  const { thread } = props;
  // The inspector reads the thread on its own, so a running turn stays live here.
  const { turns } = useThreadRows(thread, null, false);
  const turn = turns.get(props.turnId);
  const groups: Array<[string, ReadonlyArray<IMessageAgentStep>]> =
    turn === undefined
      ? []
      : [
          ["Came in", turn.steps.filter((step) => step.group === "in")],
          [
            turn.toolMode ? "Work and texts" : "Work",
            turn.steps.filter((step) => step.group === "work"),
          ],
          ["Agent note, not sent", turn.steps.filter((step) => step.group === "note")],
        ];
  const seconds =
    turn === undefined ? 0 : (Date.parse(turn.endedAt) - Date.parse(turn.startedAt)) / 1000;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-2 px-4 pt-3.5 pb-2.5">
        <div className="min-w-0 flex-1">
          <SheetTitleOrHeading>
            {turn === undefined ? "Turn" : `Turn at ${formatClock(turn.startedAt)}`}
          </SheetTitleOrHeading>
          {turn !== undefined ? (
            <p className="mt-0.5 text-xs text-(--im-muted)">
              {[
                turn.outcome === "working" ? "Working" : null,
                seconds > 0 ? formatIMessageDuration(seconds) : null,
                `${turn.sentCount} ${turn.sentCount === 1 ? "text" : "texts"} sent`,
                turn.errorCount > 0
                  ? `${turn.errorCount} ${turn.errorCount === 1 ? "error" : "errors"}`
                  : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        <Button size="icon" variant="ghost" aria-label="Close turn details" onClick={props.onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {turn === undefined ? (
          <p className="text-(length:--im-detail-text) text-(--im-muted)">
            This turn is no longer loaded. Show earlier in the chat to load it again.
          </p>
        ) : (
          groups
            .filter(([, steps]) => steps.length > 0)
            .map(([title, steps]) => (
              <section key={title} className="mt-2 first:mt-0">
                <h3 className="mb-1 text-xs font-semibold text-(--im-muted)">{title}</h3>
                <ul className="flex flex-col">
                  {steps.map((step) => (
                    <InspectorStep key={step.id} step={step} />
                  ))}
                </ul>
              </section>
            ))
        )}
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: thread.environmentId, threadId: thread.id }}
          className="mt-3 inline-flex items-center gap-1.5 text-(length:--im-detail-text) text-(--im-link) underline-offset-2 hover:underline"
        >
          <ExternalLinkIcon aria-hidden className="size-3.5" />
          Open thread
        </Link>
      </div>
    </div>
  );
}

/** The sheet needs its own title for screen readers; the side panel uses a heading. */
function SheetTitleOrHeading(props: { children: ReactNode }) {
  const narrow = useMediaQuery("max-lg");
  return narrow ? (
    <SheetTitle>{props.children}</SheetTitle>
  ) : (
    <h2 className="text-sm font-semibold">{props.children}</h2>
  );
}

function InspectorStep(props: { step: IMessageAgentStep }) {
  const { step } = props;
  const [open, setOpen] = useState(false);
  const send = step.send;
  const meta =
    send !== undefined
      ? send.state === "failed"
        ? "failed"
        : send.state === "sending"
          ? "sending"
          : send.to === null
            ? "sent"
            : `to ${send.to}`
      : step.seconds === null
        ? null
        : formatIMessageDuration(step.seconds);

  const body =
    send !== undefined ? (
      <span
        className={cn(
          "justify-self-start rounded-xl px-2.5 py-1 text-(length:--im-detail-text) leading-snug whitespace-pre-wrap wrap-anywhere text-white",
          send.state === "failed" ? "bg-destructive" : "bg-(--im-out)",
          send.state === "sending" && "opacity-60",
        )}
      >
        {send.file !== null ? (
          <span className="inline-flex items-center gap-1">
            <PaperclipIcon aria-hidden className="size-3" />
            {send.file}
            {send.text.length > 0 ? " · " : null}
          </span>
        ) : null}
        {send.text}
      </span>
    ) : step.group === "note" ? (
      <span className="rounded-lg bg-(--im-note) px-2.5 py-1.5 text-(length:--im-detail-text) leading-snug whitespace-pre-wrap wrap-anywhere text-(--im-note-ink)">
        {step.detail ?? step.text}
      </span>
    ) : (
      <StepText step={step} open={open} onToggle={() => setOpen((value) => !value)} />
    );

  return (
    <li className="grid grid-cols-[58px_minmax(0,1fr)_auto] items-baseline gap-x-2 py-1.5">
      <span className="text-2xs text-(--im-muted) tabular-nums">
        {step.at === null ? null : formatClock(step.at, true)}
      </span>
      <div className="flex min-w-0 flex-col">
        {send === undefined && step.group !== "note" ? (
          <span className={cn("text-2xs", step.error ? "text-destructive" : "text-(--im-muted)")}>
            {step.label}
          </span>
        ) : null}
        {body}
        {open && step.detail !== null && send === undefined && step.group !== "note" ? (
          <p className="mt-1.5 max-h-72 overflow-y-auto rounded-md bg-background px-2.5 py-2 text-xs whitespace-pre-wrap wrap-anywhere text-(--im-muted) select-text">
            {step.detail}
          </p>
        ) : null}
      </div>
      <span
        className={cn(
          "text-2xs tabular-nums",
          step.error ? "text-destructive" : "text-(--im-muted)",
        )}
      >
        {meta}
      </span>
    </li>
  );
}

function StepText(props: { step: IMessageAgentStep; open: boolean; onToggle: () => void }) {
  const { step } = props;
  const text = step.code ? (
    <code className="font-mono text-xs wrap-anywhere">{step.text}</code>
  ) : (
    step.text
  );
  const tone = cn(
    "text-(length:--im-detail-text) leading-snug",
    step.error ? "text-destructive" : "text-foreground",
  );
  if (step.detail === null) return <span className={cn(tone, "wrap-anywhere")}>{text}</span>;
  return (
    <button
      type="button"
      aria-expanded={props.open}
      onClick={props.onToggle}
      className={cn(
        tone,
        "rounded-sm text-start outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
    >
      <span className={cn("wrap-anywhere", !props.open && "line-clamp-2")}>{text}</span>
    </button>
  );
}

function formatClock(iso: string, seconds = false): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}
