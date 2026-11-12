import {
  EMPTY_NEEDS_YOU_FILTER,
  askFieldKind,
  askKeyAction,
  askBatchTitle,
  askRefusal,
  needsYouBatchKey,
  needsYouFiltered,
  needsYouFocusOrder,
  needsYouFromFeed,
  needsYouKinds,
  needsYouNextFocus,
  needsYouSections,
  needsYouStep,
  type NeedsYouEntry,
  type NeedsYouFilter,
  type NeedsYouItem,
  type NeedsYouMark,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  kanbanAskChanges,
  kanbanAskResponse,
  type EnvironmentId,
  type KanbanAskFeedItem,
} from "@t3tools/contracts";
import { HistoryIcon, KeyboardIcon, ListIcon, ShapesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SidebarInset } from "../../../components/ui/sidebar";
import { WorkspacePageHeader } from "../../../components/WorkspacePageHeader";
import { isElectron } from "../../../env";
import { useStableCallback } from "../../../hooks/useStableCallback";
import { cn } from "../../../lib/utils";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import { useEnvironmentSessionState } from "../../../state/session";
import { CardDrawer, noteDrawerOpener } from "../CardDrawer";
import { useBoardState, useBoards } from "../kanbanStore";
import { KanbanLinksProvider } from "../links";
import { useNowMs } from "../useNowMs";
import { AllClear } from "./AllClear";
import { AskReader, askTurn, type AskReaderHandle } from "./AskReader";
import { AskToastView } from "./AskToast";
import {
  askKey,
  flushAskSends,
  noteOwnerStanding,
  noteAskFocus,
  refreshAsks,
  undoAskSend,
  useAskStore,
  watchAsks,
} from "./askStore";
import { BatchView } from "./BatchView";
import { HistoryView } from "./HistoryView";
import { QueueRail } from "./QueueRail";
import { ReferenceView } from "./ReferenceView";
import { useSingleKeys } from "./keysPref";
import { patchNeedsYouSearch, type NeedsYouSearch, type NeedsYouView } from "./search";
import { ShortcutsSheet } from "./ShortcutsSheet";
import { Bar, Btn, FilterChip, IconBtn, Layer, linkClass, usePageLayout } from "./ui";
import "../tokens.css";
import "../kanban.css";
import "./needsYou.css";

const NO_MARKS: Readonly<Record<string, NeedsYouMark>> = {};

const VIEW_TITLES: Record<NeedsYouView, string> = {
  queue: "Needs you",
  history: "History",
  reference: "What an ask can be",
};

type Focused =
  | { readonly _tag: "ask"; readonly entry: KanbanAskFeedItem; readonly item: NeedsYouItem }
  | {
      readonly _tag: "batch";
      readonly key: string;
      readonly batch: Extract<NeedsYouEntry, { _tag: "batch" }>;
      readonly entries: ReadonlyArray<KanbanAskFeedItem>;
    }
  | null;

const textLike = (target: HTMLElement): boolean => {
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  if (target.tagName !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "range", "file"].includes(type);
};

/** Every ask that waits on him, across boards, answered without opening a card. */
export function NeedsYouPage(props: {
  search: NeedsYouSearch;
  onSearch: (next: NeedsYouSearch, options?: { readonly replace?: boolean }) => void;
}) {
  const { search, onSearch } = props;
  const view: NeedsYouView = search.view ?? "queue";
  const setView = (next: NeedsYouView) =>
    onSearch(patchNeedsYouSearch(search, { view: next === "queue" ? undefined : next }));
  const status = useAskStore((state) => state.status);
  const error = useAskStore((state) => state.error);
  const feed = useAskStore((state) => state.feed);
  const marks = useAskStore((state) => state.marks) ?? NO_MARKS;
  const hiddenMap = useAskStore((state) => state.hidden);
  const boards = useBoards();
  const nowMs = useNowMs();
  const sheetRef = useRef<HTMLDivElement>(null);
  const layout = usePageLayout(sheetRef);
  const readerRef = useRef<AskReaderHandle | null>(null);

  const [local, setLocal] = useState<Omit<NeedsYouFilter, "boardId">>({
    kind: null,
    holds: false,
    query: "",
  });
  const [openBatches, setOpenBatches] = useState<ReadonlySet<string>>(new Set());
  const [queueOpen, setQueueOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [card, setCard] = useState<{ boardId: string; cardId: string } | null>(null);

  useEffect(() => watchAsks(true), []);
  const environmentId = usePrimaryEnvironmentId();
  // A held answer goes out when he leaves the page or closes the tab.
  useEffect(() => {
    const leave = () => flushAskSends(true);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      flushAskSends(false);
    };
  }, []);

  // The React Compiler keeps these for as long as the feed and the minute stand,
  // so the queue is ranked once per feed, not once per render.
  const open = feed?.open ?? [];
  const byKey = new Map<string, KanbanAskFeedItem>(open.map((entry) => [askKey(entry), entry]));
  const needsYou = needsYouFromFeed(open, nowMs);
  const boardNames = new Map<string, string>(open.map((entry) => [entry.boardId, entry.boardName]));
  const filter: NeedsYouFilter = { ...local, boardId: search.board ?? null };
  const filtered = needsYouFiltered(filter);
  const hidden = new Set(Object.keys(hiddenMap));
  const sections = needsYouSections(
    needsYou,
    filter,
    boardNames,
    new Map(Object.entries(marks)),
    hidden,
  );
  // An ask whose answer is on its way no longer counts.
  const owed = needsYou.items.filter((item) => !hidden.has(item.key));
  const order = needsYouFocusOrder(sections, openBatches);
  const focusKey =
    search.ask !== undefined && order.includes(search.ask)
      ? search.ask
      : needsYouNextFocus(sections, openBatches);

  let focused: Focused = null;
  if (focusKey !== null) {
    const entry = byKey.get(focusKey);
    const item =
      entry &&
      [
        ...needsYou.items,
        ...needsYou.expired,
        ...needsYou.waitingOnAgent,
        ...needsYou.withEvaluator,
        ...needsYou.snoozed,
        ...needsYou.notices,
      ].find((candidate) => candidate.key === focusKey);
    if (entry && item) focused = { _tag: "ask", entry, item };
    else {
      for (const section of sections) {
        for (const candidate of section.entries) {
          if (candidate._tag === "batch" && needsYouBatchKey(candidate) === focusKey) {
            focused = {
              _tag: "batch",
              key: focusKey,
              batch: candidate,
              entries: candidate.items.flatMap((entry) => byKey.get(entry.key) ?? []),
            };
          }
        }
      }
    }
  }
  const openAskKey = focused?._tag === "ask" ? focusKey : null;
  useEffect(() => {
    noteAskFocus(openAskKey);
    return () => noteAskFocus(null);
  }, [openAskKey]);

  const focusOn = (key: string | null, replace = true) => {
    onSearch(patchNeedsYouSearch(search, { ask: key ?? undefined, view: undefined }), {
      replace: replace && view === "queue",
    });
  };
  const pickRow = (key: string) => {
    // An ask inside a folded batch is shown by unfolding its batch.
    for (const entry of needsYou.entries) {
      if (entry._tag === "batch" && entry.items.some((item) => item.key === key)) {
        setOpenBatches((current) => new Set(current).add(needsYouBatchKey(entry)));
      }
    }
    focusOn(key, false);
    setQueueOpen(false);
  };
  const setBoard = (boardId: string | null) =>
    onSearch(patchNeedsYouSearch(search, { board: boardId ?? undefined, ask: undefined }), {
      replace: true,
    });
  const clearFilter = () => {
    setLocal({ kind: EMPTY_NEEDS_YOU_FILTER.kind, holds: false, query: "" });
    if (search.board !== undefined) setBoard(null);
  };
  const undo = () => {
    const key = undoAskSend();
    if (key !== null) focusOn(key);
  };
  const openCard = (entry: KanbanAskFeedItem) => {
    noteDrawerOpener();
    setCard({ boardId: entry.boardId, cardId: entry.cardId });
  };

  const singleKeys = useSingleKeys((state) => state.on);
  const onKey = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const typing = target !== null && textLike(target);
    const letter = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
    // He turned one-letter shortcuts off: only arrows, Enter and Escape act.
    if (letter && !singleKeys && !typing) return;
    const arrow = event.key === "ArrowUp" || event.key === "ArrowDown";
    // Arrows belong to the control in focus: an option group, a player, a list of rows.
    if (arrow && target?.closest("[role=radiogroup], [role=group], video, audio, [data-ny-rows]")) {
      return;
    }
    const layerOpen =
      card !== null ||
      queueOpen ||
      shortcutsOpen ||
      document.querySelector("[role=dialog]") !== null;
    if (view !== "queue") {
      // Off the queue only the keys that make sense anywhere act.
      if (typing || layerOpen || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "?") setShortcutsOpen(true);
      else if (event.key === "Escape") setView("queue");
      else if (event.key.toLowerCase() === "z") undo();
      else return;
      event.preventDefault();
      return;
    }
    const ask = focused?._tag === "ask" ? focused : null;
    const response = ask ? kanbanAskResponse(ask.entry.ask) : null;
    const turn = ask ? askTurn(ask.entry, ask.item) : null;
    const action = askKeyAction(event, {
      typing,
      onControl:
        target?.closest("button, a, summary, [role=button], [role=radio], [role=checkbox]") != null,
      layerOpen,
      answerable:
        focused?._tag === "batch" || (ask !== null && (turn === "owner" || turn === "agent")),
      single: ask !== null,
      options: response?.choose
        ? response.choose.options.length +
          (!response.choose.multi && response.verdict === null ? 1 : 0)
        : focused?._tag === "batch"
          ? 9
          : 0,
      changes: ask ? kanbanAskChanges(ask.entry.ask).length : 0,
      editable:
        response !== null &&
        (response.edit === "draft" ||
          response.fields.some((field) => {
            const kind = askFieldKind(field);
            return kind === "text" || kind === "longtext";
          })),
      refusable: focused?._tag === "batch" || (response !== null && askRefusal(response) !== null),
    });
    if (action === null) return;
    // A held key must not answer one ask after another.
    if (event.repeat && action._tag !== "move") return;
    switch (action._tag) {
      case "close":
        // Escape leaves a text box; a sheet closes itself.
        if (typing && !layerOpen) {
          target?.blur();
          event.preventDefault();
        }
        return;
      case "shortcuts":
        setShortcutsOpen((current) => !current);
        break;
      case "search":
        if (layout === "phone") setQueueOpen(true);
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLInputElement>("[data-ny-search]");
          input?.focus();
          input?.select();
        });
        break;
      case "move":
        focusOn(needsYouStep(order, focusKey, action.delta));
        break;
      case "undo":
        undo();
        break;
      case "card":
        if (ask) openCard(ask.entry);
        break;
      default:
        readerRef.current?.act(action);
    }
    event.preventDefault();
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const boardChips = [...boardNames]
    .map(([id, name]) => ({
      id,
      name,
      count: owed.filter((item) => item.boardId === id).length,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const railProps = {
    status,
    sections,
    focusKey,
    onFocus: pickRow,
    openBatches,
    onToggleBatch: (key: string) =>
      setOpenBatches((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    filter,
    onFilter: (patch: Partial<NeedsYouFilter>) => {
      const { boardId, ...rest } = patch;
      if (Object.keys(rest).length > 0) setLocal((current) => ({ ...current, ...rest }));
      if (boardId !== undefined) setBoard(boardId);
    },
    filtered,
    onClearFilter: clearFilter,
    kinds: needsYouKinds(needsYou),
    boardNames,
    oneBoard: search.board !== undefined || boardNames.size <= 1,
    marks,
    nowMs,
    onShortcuts: () => setShortcutsOpen(true),
  };
  const boardOf = (boardId: string) =>
    boards?.find((summary) => summary.board.id === boardId)?.board;
  const waiting = needsYou.counts.agent + needsYou.counts.evaluator;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div
        data-ny
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--m-surface) text-(--m-text)"
      >
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          inert={card !== null}
          className="relative gap-3 bg-(--m-surface)"
        >
          <h1
            className={cn(
              "font-semibold",
              view === "queue" ? "shrink-0" : "min-w-0 shrink truncate",
            )}
          >
            {VIEW_TITLES[view]}
          </h1>
          <p className="flex min-w-0 shrink-0 items-baseline gap-3 text-sm">
            {feed && view === "queue" ? (
              <>
                <span className="font-medium tabular-nums">
                  {owed.length}
                  <span className="max-sm:sr-only"> to answer</span>
                </span>
                {waiting > 0 || needsYou.counts.snoozed > 0 ? (
                  <span className="text-(--m-muted) tabular-nums max-md:hidden">
                    {[
                      waiting > 0 ? `${waiting} waiting on agents` : null,
                      needsYou.counts.snoozed > 0 ? `${needsYou.counts.snoozed} snoozed` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
              </>
            ) : null}
          </p>
          <span className="min-w-0 flex-1" />
          {view !== "queue" ? (
            // A phone has room for the page's name or the way back spelled out, not both.
            <Btn size="sm" onClick={() => setView("queue")} className="shrink-0">
              {layout === "phone" ? (
                <>
                  Back<span className="sr-only"> to Needs you</span>
                </>
              ) : (
                "Needs you"
              )}
              <span className={cn("tabular-nums", layout === "phone" && "sr-only")}>
                {owed.length}
              </span>
            </Btn>
          ) : layout === "phone" ? (
            <Btn size="sm" onClick={() => setQueueOpen(true)}>
              <ListIcon aria-hidden />
              Queue
            </Btn>
          ) : boardChips.length > 1 ? (
            <div
              role="group"
              aria-label="Board"
              className="flex min-w-0 shrink gap-1 overflow-x-auto [scrollbar-width:none]"
            >
              <FilterChip pressed={search.board === undefined} onClick={() => setBoard(null)}>
                All <span className="tabular-nums">{owed.length}</span>
              </FilterChip>
              {boardChips.map((chip) => (
                <FilterChip
                  key={chip.id}
                  pressed={search.board === chip.id}
                  onClick={() => setBoard(search.board === chip.id ? null : chip.id)}
                >
                  {chip.name} <span className="tabular-nums">{chip.count}</span>
                </FilterChip>
              ))}
            </div>
          ) : null}
          <div className="flex shrink-0 items-center">
            <IconBtn
              label="History"
              aria-pressed={view === "history"}
              onClick={() => setView(view === "history" ? "queue" : "history")}
              className={cn(
                "aria-pressed:bg-(--m-chip) aria-pressed:text-(--m-text)",
                layout === "phone" && view === "history" && "hidden",
              )}
            >
              <HistoryIcon />
            </IconBtn>
            <IconBtn
              label="What an ask can be"
              aria-pressed={view === "reference"}
              onClick={() => setView(view === "reference" ? "queue" : "reference")}
              className={cn(
                "aria-pressed:bg-(--m-chip) aria-pressed:text-(--m-text)",
                layout === "phone" && view === "reference" && "hidden",
              )}
            >
              <ShapesIcon />
            </IconBtn>
            <IconBtn
              label="Keyboard shortcuts"
              onClick={() => setShortcutsOpen(true)}
              className={cn("pointer-coarse:hidden", layout === "phone" && "hidden")}
            >
              <KeyboardIcon />
            </IconBtn>
          </div>
        </WorkspacePageHeader>

        <div
          ref={sheetRef}
          className="relative mx-2 mb-2 flex min-h-0 flex-1 overflow-hidden rounded-2xl bg-(--m-ground) ring-1 ring-(--m-rule)"
        >
          {layout === "phone" || view !== "queue" ? null : (
            <nav
              aria-label="Asks"
              inert={card !== null}
              className={cn(
                "flex min-h-0 shrink-0 flex-col border-e border-(--m-rule)",
                layout === "desktop" ? "w-[320px]" : "w-[272px]",
              )}
            >
              <QueueRail {...railProps} />
            </nav>
          )}
          <section
            aria-label={view === "queue" ? "Ask" : VIEW_TITLES[view]}
            inert={card !== null}
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {view === "history" ? (
              <HistoryView
                layout={layout}
                nowMs={nowMs}
                toAnswer={owed.length}
                waiting={waiting}
                onBack={() => setView("queue")}
                onUndo={undo}
                onOpenCard={openCard}
              />
            ) : view === "reference" ? (
              <ReferenceView
                layout={layout}
                onBack={() => setView("queue")}
                onOpenAsk={(key) => focusOn(key, false)}
                onOpenCard={openCard}
              />
            ) : focused?._tag === "ask" ? (
              <AskReader
                key={focusKey}
                entry={focused.entry}
                item={focused.item}
                board={boardOf(focused.entry.boardId)}
                layout={layout}
                nowMs={nowMs}
                handle={readerRef}
                onLeave={() => focusOn(null)}
                onOpenCard={() => openCard((focused as { entry: KanbanAskFeedItem }).entry)}
                onOpenLinkedCard={(cardId) => {
                  noteDrawerOpener();
                  setCard({
                    boardId: (focused as { entry: KanbanAskFeedItem }).entry.boardId,
                    cardId,
                  });
                }}
              />
            ) : focused?._tag === "batch" ? (
              <BatchView
                key={focused.key}
                batchKey={focused.key}
                title={askBatchTitle(focused.entries.map((entry) => entry.kind))}
                boardName={boardNames.get(focused.batch.boardId) ?? ""}
                entries={focused.entries}
                layout={layout}
                nowMs={nowMs}
                handle={readerRef}
                onLeave={() => focusOn(null)}
                onOpenAsk={pickRow}
              />
            ) : status === "loading" || status === "idle" ? (
              <ReaderSkeleton />
            ) : status === "error" ? (
              <Empty
                alert
                title="Couldn't load asks."
                detail={error ?? undefined}
                action={<Btn onClick={() => void refreshAsks()}>Retry</Btn>}
              />
            ) : filtered ? (
              <Empty
                title="No asks match."
                action={
                  <button type="button" onClick={clearFilter} className={linkClass}>
                    Clear filters
                  </button>
                }
              />
            ) : (
              <AllClear
                nowMs={nowMs}
                waiting={waiting}
                snoozed={needsYou.counts.snoozed}
                onHistory={() => setView("history")}
              />
            )}
            <AskToastView
              onUndo={undo}
              onView={(key) => focusOn(key)}
              bottom={focused && view === "queue" ? 76 : 20}
            />
          </section>

          {card ? (
            <CardPeek
              boardId={card.boardId}
              cardId={card.cardId}
              onOpenCard={(cardId) => setCard({ boardId: card.boardId, cardId })}
              onClose={() => setCard(null)}
            />
          ) : null}
        </div>
      </div>

      {environmentId === null ? null : <OwnerStanding environmentId={environmentId} />}
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <Layer
        open={queueOpen && layout === "phone"}
        onClose={() => setQueueOpen(false)}
        title="Queue"
        meta={`${owed.length} to answer`}
        side="bottom"
        tall
        bodyClassName="flex min-h-0 flex-col p-0"
      >
        {boardChips.length > 1 ? (
          <div
            role="group"
            aria-label="Board"
            className="flex shrink-0 gap-1 overflow-x-auto px-3 pt-3 [scrollbar-width:none]"
          >
            <FilterChip pressed={search.board === undefined} onClick={() => setBoard(null)}>
              All <span className="tabular-nums">{owed.length}</span>
            </FilterChip>
            {boardChips.map((chip) => (
              <FilterChip
                key={chip.id}
                pressed={search.board === chip.id}
                onClick={() => setBoard(search.board === chip.id ? null : chip.id)}
              >
                {chip.name} <span className="tabular-nums">{chip.count}</span>
              </FilterChip>
            ))}
          </div>
        ) : null}
        <QueueRail {...railProps} inSheet />
      </Layer>
    </SidebarInset>
  );
}

/**
 * Tells the page whether this session is the owner's, from the session state
 * the app already holds. A session that is not shows the pairing notice before
 * he answers anything.
 */
function OwnerStanding(props: { environmentId: EnvironmentId }) {
  const session = useEnvironmentSessionState(props.environmentId).data;
  const owner = session?.authenticated ? session.owner : undefined;
  useEffect(() => noteOwnerStanding(owner), [owner]);
  return null;
}

/** The card behind an ask, opened in place; its board is read only when asked for. */
function CardPeek(props: {
  boardId: string;
  cardId: string;
  onOpenCard: (cardId: string) => void;
  onClose: () => void;
}) {
  const state = useBoardState(props.boardId);
  if (state === undefined) return null;
  return (
    <KanbanLinksProvider boardId={props.boardId}>
      <CardDrawer
        boardId={props.boardId}
        cardId={props.cardId}
        state={state}
        steps={null}
        onStepCard={() => undefined}
        onClose={props.onClose}
        onOpenCard={props.onOpenCard}
      />
    </KanbanLinksProvider>
  );
}

function Empty(props: {
  title: string;
  detail?: string | undefined;
  action?: React.ReactNode;
  /** A failure: read out when it appears. */
  alert?: boolean;
}) {
  return (
    <div
      role={props.alert ? "alert" : undefined}
      className="flex min-h-0 flex-1 flex-col items-start gap-2 px-7 pt-8 max-sm:px-4"
    >
      <p className="text-lg font-semibold">{props.title}</p>
      {props.detail ? <p className="text-sm text-(--m-muted)">{props.detail}</p> : null}
      {props.action ? <div className="mt-1">{props.action}</div> : null}
    </div>
  );
}

function ReaderSkeleton() {
  return (
    <div className="flex max-w-[620px] flex-col gap-4 px-7 pt-7 max-sm:px-4">
      <p role="status" className="sr-only">
        Loading…
      </p>
      <Bar className="h-3 w-48" />
      <Bar className="h-6 w-4/5" />
      <Bar className="h-3.5" />
      <Bar className="h-3.5 w-11/12" />
      <Bar className="mt-3 h-28 rounded-xl" />
    </div>
  );
}
