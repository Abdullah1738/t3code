import {
  ArchiveIcon,
  ChevronDownIcon,
  ListFilterIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import {
  activeGoals,
  type GroupBy,
  type KanbanBoardState,
  type SettledFilter,
} from "@t3tools/client-runtime/ardud/kanban";

import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../components/ui/menu";
import { SidebarInset } from "../../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { useNowMs } from "./useNowMs";
import { BoardColumns } from "./BoardColumns";
import { BoardIcon } from "./boardIcon";
import { CardDrawer, noteDrawerOpener } from "./CardDrawer";
import { DiscussionsView, NEW_DISCUSSION } from "./DiscussionsView";
import { GoalsList, GoalView } from "./GoalsView";
import { kanban, kanbanErrorMessage, useBoardState, useFeed } from "./kanbanStore";
import { KanbanLinksProvider } from "./links";
import { Seg } from "./parts";
import { BOARD_VIEW_LABELS, type BoardSearch } from "./search";
import { SettingsView } from "./SettingsView";
import { AutomationsView, WikiView } from "./SideViews";
import "./tokens.css";
import "./kanban.css";

/** Keys set to undefined are dropped from the URL. */
type SearchPatch = { readonly [K in keyof BoardSearch]?: BoardSearch[K] | undefined };

const GROUP_OPTIONS: ReadonlyArray<{ value: GroupBy; label: string }> = [
  { value: "stage", label: "Stage" },
  { value: "goal", label: "Goal" },
  { value: "similar", label: "Similar" },
  { value: "project", label: "Project" },
  { value: "model", label: "Model" },
];

export function BoardPage(props: {
  boardId: string;
  search: BoardSearch;
  onSearch: (next: BoardSearch) => void;
}) {
  const { boardId, search, onSearch } = props;
  const state = useBoardState(boardId);
  const feed = useFeed(kanban.board(boardId));
  const view = search.view ?? "board";
  const nowMs = useNowMs();
  const [query, setQuery] = useState("");
  const [settled, setSettled] = useState<SettledFilter>("hide");

  const go = (patch: SearchPatch) => {
    const next: Record<string, unknown> = { ...search, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    onSearch(next as BoardSearch);
  };
  const openCard = (card: string) => {
    noteDrawerOpener();
    go({ card });
  };
  const openGoal = (goal: string) => go({ view: "goals", goal, card: undefined });
  const closeCard = () => go({ card: undefined });
  // The page behind an open drawer is out of reach, but only while one shows:
  // a stale ?card= for a card this board doesn't have leaves the page usable.
  const drawerOpen = search.card !== undefined && state?.cards.has(search.card) === true;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--m-surface) text-(--m-text)">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          inert={drawerOpen}
          className="relative gap-4 bg-(--m-surface)"
        >
          <WorkspaceBreadcrumb ariaLabel="Board" className="min-w-0 shrink overflow-hidden">
            <WorkspaceBreadcrumbItem className="min-w-0 shrink">
              <button
                type="button"
                onClick={() => onSearch({})}
                className="max-w-full min-w-0 rounded font-semibold text-(--m-text) outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {state ? <BoardIcon board={state.board} className="text-(--m-muted)" /> : null}
                  <WorkspaceBreadcrumbText>{state?.board.name ?? "Board"}</WorkspaceBreadcrumbText>
                </span>
              </button>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator className="max-md:hidden" />
            <WorkspaceBreadcrumbItem current className="max-md:hidden">
              <WorkspaceBreadcrumbText>
                {view === "goals" && search.goal && state
                  ? (state.goals.get(search.goal)?.name ?? BOARD_VIEW_LABELS.goals)
                  : BOARD_VIEW_LABELS[view]}
              </WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {view === "board" && state ? (
            <BoardControls
              state={state}
              search={search}
              go={go}
              query={query}
              onQuery={setQuery}
              settled={settled}
              onSettled={setSettled}
            />
          ) : (
            <span className="flex-1" />
          )}
          <button
            type="button"
            onClick={() => go({ view: "discussions", discussion: NEW_DISCUSSION, card: undefined })}
            className="inline-flex h-8.5 shrink-0 items-center gap-1.5 rounded-full bg-(--m-accent) ps-3 pe-3.5 text-sm font-medium text-(--m-accent-ink) max-md:px-2.25 outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-text)"
          >
            <PlusIcon className="size-4" aria-hidden />
            <span className="max-md:sr-only">New</span>
          </button>
        </WorkspacePageHeader>
        <main className="relative mx-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-(--m-ground) ps-5 pt-4.5 ring-1 ring-(--m-rule)">
          <KanbanLinksProvider boardId={boardId}>
            {state === undefined ? (
              feed.failure ? (
                <div className="flex flex-col items-start gap-3 pe-5">
                  <p className="font-medium">Couldn't load the board.</p>
                  <p className="text-sm text-(--m-muted)">
                    {kanbanErrorMessage(feed.failure.error)}
                  </p>
                  <button
                    type="button"
                    onClick={feed.retry}
                    className="h-8 rounded-full bg-(--m-chip) px-3.5 text-sm font-medium outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
                  >
                    Retry
                  </button>
                </div>
              ) : null
            ) : (
              <div inert={drawerOpen} className="flex min-h-0 flex-1 flex-col">
                {feed.failure ? (
                  <div
                    role="status"
                    className="me-5 mb-3 flex items-center gap-3 rounded-xl bg-(--m-warnband) px-3.5 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      Not live. {kanbanErrorMessage(feed.failure.error)}
                    </span>
                    <button
                      type="button"
                      onClick={feed.retry}
                      className="h-7 shrink-0 rounded-full bg-(--m-chip) px-3 font-medium outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
                <BoardBody
                  boardId={boardId}
                  state={state}
                  search={search}
                  query={query}
                  settled={settled}
                  nowMs={nowMs}
                  go={go}
                  openCard={openCard}
                  openGoal={openGoal}
                />
              </div>
            )}
            {state && search.card ? (
              <CardDrawer
                key={search.card}
                boardId={boardId}
                cardId={search.card}
                state={state}
                onClose={closeCard}
                onOpenCard={openCard}
              />
            ) : null}
          </KanbanLinksProvider>
        </main>
      </div>
    </SidebarInset>
  );
}

function BoardBody(props: {
  boardId: string;
  state: KanbanBoardState;
  search: BoardSearch;
  query: string;
  settled: SettledFilter;
  nowMs: number;
  go: (patch: SearchPatch) => void;
  openCard: (cardId: string) => void;
  openGoal: (goalId: string) => void;
}) {
  const { state, search, nowMs, go } = props;
  const query = props.query.trim();
  const filter = {
    ...(search.only ? { goalId: search.only } : {}),
    ...(query ? { query } : {}),
    settled: props.settled,
  };
  switch (search.view ?? "board") {
    case "board":
      return (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <BoardColumns
            boardId={props.boardId}
            state={state}
            nowMs={nowMs}
            group={search.group ?? "stage"}
            filter={filter}
            selectedCardId={search.card}
            onOpenCard={props.openCard}
            onOpenGoal={props.openGoal}
          />
        </div>
      );
    case "goals":
      return (
        <div className="min-h-0 flex-1 overflow-y-auto pe-5">
          {search.goal ? (
            <GoalView
              state={state}
              goalId={search.goal}
              nowMs={nowMs}
              onOpenCard={props.openCard}
            />
          ) : (
            <GoalsList state={state} onOpenGoal={props.openGoal} />
          )}
        </div>
      );
    case "discussions":
      return (
        <DiscussionsView
          boardId={props.boardId}
          state={state}
          nowMs={nowMs}
          discussionId={search.discussion}
          onOpenDiscussion={(discussion) => go({ discussion })}
          onOpenCard={props.openCard}
        />
      );
    case "automations":
    case "scripts":
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pe-5">
          <AutomationsView
            boardId={props.boardId}
            nowMs={nowMs}
            tab={search.view === "scripts" ? "scripts" : "automations"}
            onTab={(view) => go({ view })}
          />
        </div>
      );
    case "wiki":
      return (
        <div className="flex min-h-0 flex-1 flex-col pe-5">
          <WikiView boardId={props.boardId} nowMs={nowMs} />
        </div>
      );
    case "settings":
      return (
        <div className="min-h-0 flex-1 overflow-y-auto pe-5">
          <SettingsView state={state} />
        </div>
      );
  }
}

function BoardControls(props: {
  state: KanbanBoardState;
  search: BoardSearch;
  go: (patch: SearchPatch) => void;
  query: string;
  onQuery: (query: string) => void;
  settled: SettledFilter;
  onSettled: (settled: SettledFilter) => void;
}) {
  const narrow = useMediaQuery("max-md");
  const goals = activeGoals(props.state);
  const only = props.search.only ? props.state.goals.get(props.search.only) : undefined;
  const group = props.search.group ?? "stage";
  const setGroup = (next: GroupBy) => props.go({ group: next === "stage" ? undefined : next });
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {narrow ? (
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="Group by"
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-(--m-chip) ps-3 pe-2 text-sm font-medium outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
              />
            }
          >
            {GROUP_OPTIONS.find((option) => option.value === group)?.label}
            <ChevronDownIcon className="size-3.5 text-(--m-muted)" aria-hidden />
          </MenuTrigger>
          <MenuPopup align="start" side="bottom">
            <MenuRadioGroup value={group} onValueChange={(value) => setGroup(value as GroupBy)}>
              {GROUP_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      ) : (
        <Seg label="Group by" value={group} options={GROUP_OPTIONS} onChange={setGroup} />
      )}
      {goals.length > 0 ? (
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  "inline-flex h-8 max-w-48 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
                  only
                    ? "bg-(--m-text) text-(--m-ground)"
                    : "bg-(--m-chip) text-(--m-text) hover:bg-(--m-active)",
                )}
              />
            }
          >
            <ListFilterIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate max-md:sr-only">{only?.name ?? "Filter"}</span>
          </MenuTrigger>
          <MenuPopup align="start" side="bottom">
            <MenuRadioGroup
              value={props.search.only ?? ""}
              onValueChange={(value) => props.go({ only: value ? String(value) : undefined })}
            >
              <MenuRadioItem value="">All goals</MenuRadioItem>
              {goals.map((entry) => (
                <MenuRadioItem key={entry.goal.id} value={entry.goal.id}>
                  {entry.goal.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Settled cards"
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
                props.settled !== "hide"
                  ? "bg-(--m-text) text-(--m-ground)"
                  : "bg-(--m-chip) text-(--m-text) hover:bg-(--m-active)",
              )}
            />
          }
        >
          <ArchiveIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="max-md:sr-only">
            {props.settled === "only" ? "Settled only" : "Settled"}
          </span>
        </MenuTrigger>
        <MenuPopup align="start" side="bottom">
          <MenuRadioGroup
            value={props.settled}
            onValueChange={(value) => props.onSettled(value as SettledFilter)}
          >
            <MenuRadioItem value="hide">Hide settled</MenuRadioItem>
            <MenuRadioItem value="include">Show settled</MenuRadioItem>
            <MenuRadioItem value="only">Only settled</MenuRadioItem>
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      <span className="flex-1" />
      <QueryField value={props.query} onChange={props.onQuery} />
    </div>
  );
}

function QueryField(props: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(props.value.length > 0);
  if (!open) {
    return (
      <button
        type="button"
        aria-label="Search cards"
        onClick={() => setOpen(true)}
        className="grid size-8 shrink-0 place-items-center rounded-full text-(--m-muted) outline-none hover:bg-(--m-chip) hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
      >
        <SearchIcon className="size-4" />
      </button>
    );
  }
  return (
    <div className="flex h-8 w-56 min-w-0 shrink items-center gap-2 rounded-full bg-(--m-chip) ps-3 pe-1">
      <SearchIcon className="size-4 shrink-0 text-(--m-muted)" aria-hidden />
      <input
        autoFocus
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onChange("");
            setOpen(false);
          }
        }}
        placeholder="Search cards"
        aria-label="Search cards"
        className="min-w-0 flex-1 bg-transparent text-sm text-(--m-text) outline-none placeholder:text-(--m-muted)"
      />
      <button
        type="button"
        aria-label="Clear search"
        onClick={() => {
          props.onChange("");
          setOpen(false);
        }}
        className="grid size-6 place-items-center rounded-full text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
