import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CheckCheckIcon,
  CheckIcon,
  CircleHelpIcon,
  FolderIcon,
  GitBranchIcon,
  PlusIcon,
  ShieldCheckIcon,
  Undo2Icon,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  formatBoardAge,
  groupBoardLanes,
  settleBoardTasks,
  statusLabel,
} from "@t3tools/client-runtime/ardud/board";
import { sortScopedProjectsForSidebar } from "../../components/Sidebar.logic";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProjects, useThreadShells } from "../../state/entities";
import { cn } from "../../lib/utils";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { Spinner } from "../../components/ui/spinner";
import { toastManager } from "../../components/ui/toast";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { boardActions, subscribeBoard, useBoardStore, type BoardEntry } from "./boardClient";
import { useBoardEnvironmentId } from "./boardEnvironment";
import { errorMessage, undoToast } from "./boardToasts";

type Lane = BoardEntry["state"];

const LANES: ReadonlyArray<{ lane: Lane; title: string; short: string; empty: string }> = [
  { lane: "running", title: "Running", short: "Running", empty: "No threads running." },
  {
    lane: "waiting",
    title: "Waiting for review",
    short: "Review",
    empty: "Nothing waiting for review.",
  },
  { lane: "backlog", title: "Backlog", short: "Later", empty: "Nothing saved for later." },
  { lane: "scheduled", title: "Scheduled", short: "Auto", empty: "No scheduled threads." },
];

const PAGE_SIZE = 50;
/** Starts a draft thread in the most recently active project. */
function BoardNewThreadButton() {
  const projects = useProjects();
  const threads = useThreadShells();
  const handleNewThread = useNewThreadHandler();
  const project = useMemo(
    () => sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null,
    [projects, threads],
  );
  if (project === null) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() => {
        void handleNewThread(scopeProjectRef(project.environmentId, project.id)).catch(
          (error: unknown) =>
            toastManager.add({
              type: "error",
              title: "Could not start a thread",
              description: errorMessage(error),
            }),
        );
      }}
    >
      <PlusIcon />
      New thread
      <span className="sr-only"> in {project.title}</span>
    </Button>
  );
}

/** The fork's session board: every project's threads in four lanes. */
export function BoardPage() {
  useEffect(() => subscribeBoard(), []);
  const entries = useBoardStore((state) => state.entries);
  const connection = useBoardStore((state) => state.connection);
  const error = useBoardStore((state) => state.error);
  const syncError = useBoardStore((state) => state.syncError);
  const revision = useBoardStore((state) => state.revision);
  const [selectedLane, setSelectedLane] = useState<Lane>("waiting");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [clearing, setClearing] = useState<Lane | null>(null);

  const byLane = useMemo(() => groupBoardLanes(entries.values()), [entries]);

  const withBusy = async (key: string, task: () => Promise<unknown>) => {
    if (busy.has(key)) return;
    setBusy((current) => new Set(current).add(key));
    try {
      await task();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const complete = (entry: BoardEntry, destination: "review" | "backlog") =>
    withBusy(entry.threadId, async () => {
      try {
        await (destination === "backlog"
          ? boardActions.backlog(entry)
          : boardActions.review(entry));
        undoToast(
          destination === "backlog" ? "Moved to backlog" : "Marked complete",
          entry.title || "Untitled thread",
          () => boardActions.restore(entry),
        );
      } catch (error) {
        toastManager.add({
          type: "error",
          title:
            destination === "backlog" ? "Could not move to backlog" : "Could not mark complete",
          description: errorMessage(error),
        });
      }
    });

  const returnToReview = (entry: BoardEntry) =>
    withBusy(entry.threadId, async () => {
      try {
        await boardActions.restore(entry);
        toastManager.add({ type: "success", title: "Returned to review" });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not return to review",
          description: errorMessage(error),
        });
      }
    });

  // Quick clear: completes exactly the cards on screen, never whatever lands after.
  const clearLane = async (lane: "waiting" | "scheduled") => {
    const targets = byLane[lane].filter((entry) => !busy.has(entry.threadId));
    if (targets.length === 0 || clearing !== null) return;
    setClearing(lane);
    try {
      const result = await boardActions.clear(lane, targets);
      const cleared = new Set<string>(result.cleared);
      const restorable = targets.filter((entry) => cleared.has(entry.threadId));
      const skipped = result.skipped.length;
      const description =
        skipped > 0 ? `${skipped} skipped because they changed or are still running.` : "";
      if (restorable.length === 0) {
        toastManager.add({ type: "error", title: "Nothing was cleared", description });
        return;
      }
      undoToast(`Cleared ${restorable.length}`, description, async () => {
        const ok = await settleBoardTasks(restorable, (entry) => boardActions.restore(entry));
        if (!ok) throw new Error("Some cards could not be restored.");
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not clear the lane",
        description: errorMessage(error),
      });
    } finally {
      setClearing(null);
    }
  };

  const banner = error ?? syncError;
  const loading = revision < 0 && connection !== "offline";

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="@container/board flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Board breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Board</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          {connection !== "live" && !loading ? (
            <Badge variant="warning" size="sm">
              {connection === "offline" ? "Offline" : "Reconnecting"}
            </Badge>
          ) : null}
          <BoardNewThreadButton />
        </WorkspacePageHeader>

        <div className="px-4 pb-2 @[60rem]/board:hidden">
          <ToggleGroup
            aria-label="Board lane"
            variant="segmented"
            className="w-full"
            value={[selectedLane]}
            onValueChange={(next) => {
              const value = next[0] as Lane | undefined;
              if (value) setSelectedLane(value);
            }}
          >
            {LANES.map(({ lane, title, short }) => (
              <Toggle key={lane} value={lane} aria-label={title} className="min-w-0 flex-1">
                <span className="truncate">{short}</span>
                <span className="text-muted-foreground tabular-nums">{byLane[lane].length}</span>
              </Toggle>
            ))}
          </ToggleGroup>
        </div>

        {banner ? (
          <p
            role="alert"
            className="mx-4 mb-2 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs"
          >
            {banner}
          </p>
        ) : null}

        <ScrollArea className="min-h-0 flex-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Spinner size="sm" /> Loading the board
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 px-4 pt-2 pb-12 @[60rem]/board:grid-cols-2 @[90rem]/board:grid-cols-4">
              {LANES.map(({ lane, title, empty }) => (
                <BoardLane
                  key={lane}
                  lane={lane}
                  title={title}
                  empty={empty}
                  entries={byLane[lane]}
                  hidden={selectedLane !== lane}
                  busy={busy}
                  clearing={clearing === lane}
                  onClear={
                    lane === "waiting" || lane === "scheduled" ? () => void clearLane(lane) : null
                  }
                  onComplete={(entry) => void complete(entry, "review")}
                  onBacklog={(entry) => void complete(entry, "backlog")}
                  onRestore={(entry) => void returnToReview(entry)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function BoardLane(props: {
  lane: Lane;
  title: string;
  empty: string;
  entries: ReadonlyArray<BoardEntry>;
  hidden: boolean;
  busy: ReadonlySet<string>;
  clearing: boolean;
  onClear: (() => void) | null;
  onComplete: (entry: BoardEntry) => void;
  onBacklog: (entry: BoardEntry) => void;
  onRestore: (entry: BoardEntry) => void;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const headingRef = useRef<HTMLHeadingElement>(null);
  return (
    <section
      aria-labelledby={`board-lane-${props.lane}`}
      className={cn("min-w-0", props.hidden && "hidden @[60rem]/board:block")}
    >
      <div className="mb-3 flex items-center gap-2">
        <h2
          id={`board-lane-${props.lane}`}
          ref={headingRef}
          tabIndex={-1}
          className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium"
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              props.lane === "running"
                ? "bg-primary"
                : props.lane === "waiting"
                  ? "bg-info"
                  : "bg-muted-foreground/50",
            )}
          />
          <span className="truncate">{props.title}</span>
          <span className="ms-auto text-xs text-muted-foreground tabular-nums">
            {props.entries.length}
          </span>
        </h2>
        {props.onClear !== null && props.entries.length > 0 ? (
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={`Clear all ${Math.min(props.entries.length, 500)} cards in ${props.title}`}
            disabled={props.clearing}
            onClick={props.onClear}
          >
            {props.clearing ? <Spinner size="xs" /> : <CheckCheckIcon />}
            Clear all
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        {props.entries.slice(0, limit).map((entry) => (
          <BoardCard
            key={entry.threadId}
            entry={entry}
            busy={props.busy.has(entry.threadId) || (props.clearing && entry.state === props.lane)}
            onComplete={props.onComplete}
            onBacklog={props.onBacklog}
            onRestore={props.onRestore}
          />
        ))}
        {props.entries.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
            {props.empty}
          </p>
        ) : null}
        {props.entries.length > limit ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLimit((current) => current + PAGE_SIZE)}
          >
            Show more
          </Button>
        ) : null}
      </div>
    </section>
  );
}

const BoardCard = memo(function BoardCard(props: {
  entry: BoardEntry;
  busy: boolean;
  onComplete: (entry: BoardEntry) => void;
  onBacklog: (entry: BoardEntry) => void;
  onRestore: (entry: BoardEntry) => void;
}) {
  const { entry, busy } = props;
  const navigate = useNavigate();
  const environmentId = useBoardEnvironmentId();
  const projects = useProjects();
  const project = projects.find(
    (candidate) => candidate.id === entry.projectId && candidate.environmentId === environmentId,
  );
  const title = entry.title.trim() || "Untitled thread";
  const projectLabel = project?.title ?? "Unknown project";
  const open = () => {
    if (environmentId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: entry.threadId },
    });
  };
  const attention = entry.attention;
  const actions: Array<{ label: string; icon: React.ReactNode; run: () => void }> =
    entry.state === "waiting"
      ? [
          {
            label: `Move ${title} to backlog`,
            icon: <ArchiveIcon />,
            run: () => props.onBacklog(entry),
          },
          {
            label: `Mark ${title} complete`,
            icon: <CheckIcon />,
            run: () => props.onComplete(entry),
          },
        ]
      : entry.state === "backlog"
        ? [
            {
              label: `Return ${title} to review`,
              icon: <Undo2Icon />,
              run: () => props.onRestore(entry),
            },
            {
              label: `Mark ${title} complete`,
              icon: <CheckIcon />,
              run: () => props.onComplete(entry),
            },
          ]
        : entry.state === "scheduled"
          ? [
              {
                label: `Mark ${title} complete`,
                icon: <CheckIcon />,
                run: () => props.onComplete(entry),
              },
            ]
          : [];

  return (
    <div className="group/card relative overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={open}
        className={cn(
          "flex w-full min-w-0 flex-col gap-1.5 p-3 text-left outline-hidden hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          actions.length === 2 && "pr-20",
          actions.length === 1 && "pr-11",
        )}
      >
        <span className="line-clamp-3 text-sm font-medium [overflow-wrap:anywhere]">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {entry.branch ? (
            <GitBranchIcon className="size-3.5 shrink-0" />
          ) : (
            <FolderIcon className="size-3.5 shrink-0" />
          )}
          <span className="truncate">
            {projectLabel}
            {entry.branch ? ` / ${entry.branch}` : ""}
          </span>
        </span>
        {entry.model ? (
          <span className="truncate text-xs text-muted-foreground">{entry.model}</span>
        ) : null}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{statusLabel(entry)}</span>
          {entry.updatedAt > 0 ? (
            <time dateTime={new Date(entry.updatedAt).toISOString()}>
              {formatBoardAge(entry.updatedAt)}
            </time>
          ) : null}
        </span>
        {attention ? (
          <Badge variant="warning" size="sm" className="w-fit">
            {attention.kind === "question" ? <CircleHelpIcon /> : <ShieldCheckIcon />}
            {attention.kind === "question" ? "Question" : "Approval"}
            {attention.count > 1 ? ` (${attention.count})` : ""}
          </Badge>
        ) : null}
      </button>
      {actions.length > 0 ? (
        <div className="absolute top-2 right-2 flex opacity-60 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100">
          {actions.map((action) => (
            <Tooltip key={action.label}>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={action.label}
                    aria-busy={busy}
                    disabled={busy}
                    onClick={action.run}
                  >
                    {busy ? <Spinner size="sm" /> : action.icon}
                  </Button>
                }
              />
              <TooltipPopup side="top">{action.label}</TooltipPopup>
            </Tooltip>
          ))}
        </div>
      ) : null}
    </div>
  );
});
