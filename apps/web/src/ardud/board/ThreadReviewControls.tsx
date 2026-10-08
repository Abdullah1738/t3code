// ardud fork: in-thread review controls. Complete the open thread when it is
// waiting for review, and walk the review queue without going back to the board.
import { useNavigate } from "@tanstack/react-router";
import { formatBoardAge } from "@t3tools/client-runtime/ardud/board";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  ListChecksIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { ButtonGroup } from "../../components/ui/group";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { boardActions, subscribeBoard, useBoardStore, type BoardEntry } from "./boardClient";
import { useBoardEnvironmentId } from "./boardEnvironment";
import { errorMessage, undoToast } from "./boardToasts";

// One in-flight guard per (thread, work revision) so the header button and the
// queue rows can't double-submit the same completion.
const inFlight = new Set<string>();
const inFlightKey = (entry: BoardEntry) => `${entry.threadId}:${entry.workRevision}`;

function useReviewQueue(): ReadonlyArray<BoardEntry> {
  const entries = useBoardStore((state) => state.entries);
  return useMemo(
    () =>
      [...entries.values()]
        .filter((entry) => entry.state === "waiting")
        .toSorted(
          (left, right) =>
            right.updatedAt - left.updatedAt || left.threadId.localeCompare(right.threadId),
        ),
    [entries],
  );
}

function focusComposer() {
  const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  editor?.focus();
}

export function ThreadReviewControls(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  useEffect(() => subscribeBoard(), []);
  const navigate = useNavigate();
  const queue = useReviewQueue();
  // The board only tracks one environment's threads, so a thread from
  // another environment is never "current" even if its id collides.
  const boardEnvironmentId = useBoardEnvironmentId();
  const onBoardEnvironment = props.environmentId === boardEnvironmentId;
  const threadId = onBoardEnvironment ? props.threadId : null;
  const current = useBoardStore((state) =>
    threadId === null ? undefined : state.entries.get(threadId),
  );
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  // Completion is async; follow-ups must act on the thread open when it lands.
  const openThreadRef = useRef(threadId);
  useEffect(() => {
    openThreadRef.current = threadId;
  }, [threadId]);

  const index = queue.findIndex((entry) => entry.threadId === threadId);
  const others = index === -1 ? queue : queue.filter((entry) => entry.threadId !== threadId);

  const go = useCallback(
    (entry: BoardEntry | undefined) => {
      if (!entry || boardEnvironmentId === null) return;
      setOpen(false);
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: boardEnvironmentId, threadId: entry.threadId },
      });
    },
    [navigate, boardEnvironmentId],
  );

  // Previous/next walk the queue relative to this thread. When this thread isn't
  // in review, "next" starts at the newest waiting thread.
  const prev = index > 0 ? queue[index - 1] : undefined;
  const next = index === -1 ? queue[0] : queue[index + 1];

  const complete = useCallback(
    async (entry: BoardEntry, after: "stay" | "next") => {
      const key = inFlightKey(entry);
      if (inFlight.has(key)) return;
      inFlight.add(key);
      setPending((keys) => new Set(keys).add(key));
      const startedOn = openThreadRef.current;
      const title = entry.title.trim() || "Untitled thread";
      // Pick the follow-up before the queue changes under us.
      const position = queue.findIndex((candidate) => candidate.threadId === entry.threadId);
      const following =
        queue[position + 1] ?? (position > 0 ? queue[position - 1] : undefined) ?? undefined;
      try {
        await boardActions.review(entry);
        undoToast("Marked complete", title, () => boardActions.restore(entry));
        if (openThreadRef.current !== startedOn) {
          // The user moved on while this was in flight; don't yank them back.
        } else if (after === "next" && following && following.threadId !== entry.threadId) {
          go(following);
        } else if (entry.threadId === startedOn) {
          focusComposer();
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not mark complete",
          description: errorMessage(error),
        });
      } finally {
        inFlight.delete(key);
        setPending((keys) => {
          const rest = new Set(keys);
          rest.delete(key);
          return rest;
        });
      }
    },
    [go, queue],
  );

  const isWaiting = current?.state === "waiting";
  if (!isWaiting && queue.length === 0) return null;

  const busy = current !== undefined && pending.has(inFlightKey(current));

  return (
    <div className="flex shrink-0 items-center gap-1.5" data-ardud-review-controls>
      {queue.length > 0 ? (
        <ButtonGroup>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label="Previous thread in review"
                  disabled={!prev}
                  onClick={() => go(prev)}
                />
              }
            >
              <ChevronLeftIcon />
            </TooltipTrigger>
            <TooltipPopup>Previous in review</TooltipPopup>
          </Tooltip>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger render={<Button variant="outline" size="xs" />}>
              <ListChecksIcon />
              <span className="tabular-nums">
                {index === -1 ? `${queue.length} in review` : `${index + 1}/${queue.length}`}
              </span>
              <span className="sr-only">review queue</span>
            </PopoverTrigger>
            <PopoverPopup align="end" padding="none" width="md" aria-label="Review queue">
              <ReviewQueueList
                queue={queue}
                currentThreadId={threadId}
                pendingKeys={pending}
                onOpen={go}
                onComplete={(entry) => void complete(entry, "stay")}
              />
            </PopoverPopup>
          </Popover>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label="Next thread in review"
                  disabled={!next}
                  onClick={() => go(next)}
                />
              }
            >
              <ChevronRightIcon />
            </TooltipTrigger>
            <TooltipPopup>Next in review</TooltipPopup>
          </Tooltip>
        </ButtonGroup>
      ) : null}
      {isWaiting && current ? (
        <ButtonGroup>
          <Button
            size="xs"
            variant="default"
            aria-label={`Mark "${current.title.trim() || "Untitled thread"}" complete`}
            disabled={busy}
            onClick={() => void complete(current, "stay")}
          >
            <CheckIcon />
            Complete
          </Button>
          {others.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="default"
                    aria-label="Complete and open the next thread in review"
                    disabled={busy}
                    onClick={() => void complete(current, "next")}
                  />
                }
              >
                <ChevronRightIcon />
              </TooltipTrigger>
              <TooltipPopup>Complete and go to next</TooltipPopup>
            </Tooltip>
          ) : null}
        </ButtonGroup>
      ) : null}
    </div>
  );
}

function ReviewQueueList(props: {
  queue: ReadonlyArray<BoardEntry>;
  currentThreadId: string | null;
  pendingKeys: ReadonlySet<string>;
  onOpen: (entry: BoardEntry) => void;
  onComplete: (entry: BoardEntry) => void;
}) {
  const projects = useProjects();
  return (
    <div className="flex max-h-96 flex-col">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
        <span className="text-xs font-medium">In review</span>
        <span className="text-xs text-muted-foreground tabular-nums">{props.queue.length}</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1">
        {props.queue.map((entry) => {
          const title = entry.title.trim() || "Untitled thread";
          const project = projects.find((candidate) => candidate.id === entry.projectId);
          const active = entry.threadId === props.currentThreadId;
          const busy = props.pendingKeys.has(inFlightKey(entry));
          return (
            <li key={entry.threadId} className="group/row relative">
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => props.onOpen(entry)}
                className={cn(
                  "flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 pr-9 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  active && "bg-accent",
                )}
              >
                <span className="flex w-full min-w-0 items-center gap-1.5 text-sm">
                  <span className="truncate">{title}</span>
                  {entry.attention ? (
                    entry.attention.kind === "question" ? (
                      <CircleHelpIcon
                        aria-label="Has a question"
                        className="size-3.5 shrink-0 text-warning-foreground"
                      />
                    ) : (
                      <ShieldCheckIcon
                        aria-label="Needs approval"
                        className="size-3.5 shrink-0 text-warning-foreground"
                      />
                    )
                  ) : null}
                </span>
                <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="truncate">{project?.title ?? "Unknown project"}</span>
                  {entry.updatedAt > 0 ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="shrink-0 tabular-nums">
                        {formatBoardAge(entry.updatedAt)}
                      </span>
                    </>
                  ) : null}
                </span>
              </button>
              <div className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 has-focus-visible:opacity-100 pointer-coarse:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Mark "${title}" complete`}
                  disabled={busy}
                  onClick={() => props.onComplete(entry)}
                >
                  <CheckIcon />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
