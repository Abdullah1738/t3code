import { Link, useMatchRoute, useParams, useSearch } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CircleHelpIcon, InboxIcon, MessageCircleIcon } from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";

import { askQueueFigures, askRowFigure } from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanBoardSummary } from "@t3tools/contracts";

import { CollapsibleSectionHeader } from "../../components/ui/collapsible-section-header";
import { SidebarGroup, useSidebar } from "../../components/ui/sidebar";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { BoardIcon } from "./boardIcon";
import { NewBoardDialog } from "./NewBoardDialog";
import { useBoards } from "./kanbanStore";
import { askKey, useAskStore, watchAsks } from "./needsYou/askStore";
import { Count } from "./parts";
import { BOARD_VIEW_LABELS, BOARD_VIEWS, type BoardView } from "./search";
import { useNowMs } from "./useNowMs";
import "./tokens.css";
import "./kanban.css";

const SIDEBAR_STATE_KEY = "t3code:ardud-boards:sidebar";
const SidebarState = Schema.Struct({ collapsed: Schema.Boolean });
const INITIAL_STATE = { collapsed: false };

const rowClassName =
  "flex h-8 min-w-0 items-center gap-2 rounded-lg px-2.5 text-sm text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11";

function rowState(isActive: boolean) {
  return isActive ? "bg-sidebar-row-active font-medium" : "hover:bg-sidebar-row-hover";
}

/** Boards above the thread list; the open board lists its pages under it. */
export function BoardsSidebarGroup() {
  const boards = useBoards();
  const [state, setState] = useLocalStorage(SIDEBAR_STATE_KEY, INITIAL_STATE, SidebarState);
  const activeBoardId = useParams({
    strict: false,
    select: (params) => (typeof params.boardId === "string" ? params.boardId : null),
  });
  const { isMobile, setOpenMobile } = useSidebar();
  const onNavigate = () => {
    if (isMobile) setOpenMobile(false);
  };

  const live = (boards ?? []).filter((summary) => summary.board.archivedAt === null);
  const [creating, setCreating] = useState(false);
  const expanded = !state.collapsed;

  // The group stays visible with no boards so "+ New board" is always reachable.
  return (
    <SidebarGroup aria-label="Boards">
      <div className="mx-0.5 flex h-8 items-center gap-1">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            expanded={expanded}
            onClick={() => setState((current) => ({ ...current, collapsed: !current.collapsed }))}
          >
            Boards
          </CollapsibleSectionHeader>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md px-2 py-1 text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover"
        >
          + New board
        </button>
        <NewBoardDialog open={creating} onOpenChange={setCreating} />
      </div>
      {live.length > 0 ? <NeedsYouRow onNavigate={onNavigate} /> : null}
      {expanded && live.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pb-3.5">
          {live.map((summary) => (
            <BoardRow
              key={summary.board.id}
              summary={summary}
              open={summary.board.id === activeBoardId}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : null}
    </SidebarGroup>
  );
}

/** Every ask that waits on him, across boards, with how many there are. */
function NeedsYouRow(props: { onNavigate: () => void }) {
  const active = useMatchRoute()({ to: "/needs-you" }) !== false;
  const count = useAskStore((state) => {
    let owed = 0;
    for (const entry of state.feed?.open ?? []) {
      if (
        entry.waitsOn === "owner" &&
        !entry.expired &&
        !entry.snoozed &&
        entry.ask.respond?.ack !== true &&
        state.hidden[askKey(entry)] === undefined
      ) {
        owed += 1;
      }
    }
    return owed;
  });
  useEffect(() => watchAsks(false), []);
  // No badge means "nothing to answer": only for a read that said so (`askRowFigure`).
  // Each part is selected by itself so the selectors stay stable.
  const feed = useAskStore((state) => state.feed);
  const status = useAskStore((state) => state.status);
  const error = useAskStore((state) => state.error);
  const nowMs = useNowMs();
  const shown = askRowFigure(askQueueFigures({ feed, status, error }), count, nowMs);
  return (
    <Link
      to="/needs-you"
      search={{}}
      onClick={props.onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(rowClassName, "mb-0.5", rowState(active))}
    >
      <InboxIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">Needs you</span>
      {shown.note !== null ? (
        <span
          className="shrink-0 text-xs text-sidebar-muted-foreground"
          // With a badge beside it, the badge's label says all of it.
          aria-label={shown.count === null ? shown.label : undefined}
          aria-hidden={shown.count === null ? undefined : true}
        >
          {shown.note}
        </span>
      ) : null}
      <Count count={shown.count ?? 0} tone="warn" label={shown.label} />
    </Link>
  );
}

/** Icon and count for one pending kind; zero renders nothing. */
function BoardBadge(props: { icon: ReactNode; count: number; label: string; tone?: "warn" }) {
  if (props.count <= 0) return null;
  return (
    <span
      role="img"
      aria-label={props.label}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-2xs font-semibold tabular-nums",
        props.tone === "warn" ? "text-(--m-warning)" : "text-sidebar-muted-foreground",
      )}
    >
      {props.icon}
      <span aria-hidden>{props.count}</span>
    </span>
  );
}

const BoardRow = memo(function BoardRow(props: {
  summary: KanbanBoardSummary;
  open: boolean;
  onNavigate: () => void;
}) {
  const { open } = props;
  const { board, needsOwner, unread } = props.summary;
  const view = useSearch({
    strict: false,
    select: (search) => (typeof search.view === "string" ? (search.view as BoardView) : "board"),
  });

  return (
    <li className="flex flex-col gap-0.5">
      <Link
        to="/boards/$boardId"
        params={{ boardId: board.id }}
        search={{}}
        onClick={props.onNavigate}
        className={cn(
          rowClassName,
          open ? "font-medium hover:bg-sidebar-row-hover" : rowState(false),
        )}
      >
        <BoardIcon board={board} className="text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{board.name}</span>
        <BoardBadge
          icon={<MessageCircleIcon aria-hidden className="size-3" />}
          count={unread}
          label={`${unread} unread messages`}
        />
        <BoardBadge
          icon={<CircleHelpIcon aria-hidden className="size-3" />}
          count={needsOwner}
          label={`${needsOwner} questions for you`}
          tone="warn"
        />
      </Link>
      {open
        ? BOARD_VIEWS.map((entry) => {
            const active = view === entry;
            return (
              <Link
                key={entry}
                to="/boards/$boardId"
                params={{ boardId: board.id }}
                search={entry === "board" ? {} : { view: entry }}
                onClick={props.onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  rowClassName,
                  "ps-8.5",
                  active
                    ? rowState(true)
                    : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{BOARD_VIEW_LABELS[entry]}</span>
                {entry === "discussions" ? (
                  <Count count={unread} label={`${unread} unread`} />
                ) : null}
              </Link>
            );
          })
        : null}
    </li>
  );
});
