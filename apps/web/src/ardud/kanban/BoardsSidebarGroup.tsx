import { Link, useParams, useSearch } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { memo } from "react";

import { totalUnread } from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanBoard } from "@t3tools/contracts";

import { CollapsibleSectionHeader } from "../../components/ui/collapsible-section-header";
import { SidebarGroup, useSidebar } from "../../components/ui/sidebar";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { useBoards, useBoardState } from "./kanbanStore";
import { Count } from "./parts";
import { BOARD_VIEW_LABELS, BOARD_VIEWS, type BoardView } from "./search";
import "../missions/missions.css";
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

  const live = (boards ?? []).filter((board) => board.archivedAt === null);
  if (live.length === 0) return null;
  const expanded = !state.collapsed;

  return (
    <SidebarGroup aria-label="Boards">
      <div className="mx-0.5 h-8">
        <CollapsibleSectionHeader
          expanded={expanded}
          onClick={() => setState((current) => ({ ...current, collapsed: !current.collapsed }))}
        >
          Boards
        </CollapsibleSectionHeader>
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-0.5 pb-3.5">
          {live.map((board) => (
            <BoardRow
              key={board.id}
              board={board}
              open={board.id === activeBoardId}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : null}
    </SidebarGroup>
  );
}

const BoardRow = memo(function BoardRow(props: {
  board: KanbanBoard;
  open: boolean;
  onNavigate: () => void;
}) {
  const { board, open } = props;
  // Each row keeps its board's feed open for the counts: one subscription and
  // one discussion list per board, no message reads.
  const state = useBoardState(board.id);
  const view = useSearch({
    strict: false,
    select: (search) => (typeof search.view === "string" ? (search.view as BoardView) : "board"),
  });
  const needsOwner = state
    ? [...state.cards.values()].filter((card) => card.stage === "needs_owner" && !card.settledAt)
        .length
    : 0;
  const unread = state ? totalUnread(state) : 0;

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
        <span className="min-w-0 flex-1 truncate">{board.name}</span>
        <Count count={needsOwner} tone="warn" label={`${needsOwner} need you`} />
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
                  "ps-6.5",
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
