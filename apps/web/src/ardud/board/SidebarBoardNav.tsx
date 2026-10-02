import { Link, useLocation } from "@tanstack/react-router";
import { SquareKanbanIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../../components/ui/sidebar";
import { subscribeBoard, useBoardStore } from "./boardClient";

/** Board counts shown next to the sidebar entry. */
export function useBoardCounts(): {
  readonly running: number;
  readonly waiting: number;
  readonly needsInput: number;
} {
  const entries = useBoardStore((state) => state.entries);
  return useMemo(() => {
    let running = 0;
    let waiting = 0;
    let needsInput = 0;
    for (const entry of entries.values()) {
      if (entry.state === "running") running += 1;
      if (entry.state === "waiting") waiting += 1;
      if (entry.attention) needsInput += 1;
    }
    return { running, waiting, needsInput };
  }, [entries]);
}

/**
 * ardud fork: the session board is the app's home, so it gets the first row of
 * the sidebar with live running / review counts.
 */
export function SidebarBoardNav({ className }: { readonly className?: string }) {
  useEffect(() => subscribeBoard(), []);
  const { running, waiting, needsInput } = useBoardCounts();
  const pathname = useLocation({ select: (location) => location.pathname });
  const active = pathname === "/";
  const { isMobile, setOpenMobile } = useSidebar();

  const summary = [
    running > 0 ? `${running} running` : null,
    waiting > 0 ? `${waiting} waiting for review` : null,
    needsInput > 0 ? `${needsInput} need input` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <SidebarMenu className={className}>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={active}
          aria-label={summary ? `Board, ${summary}` : "Board"}
          render={
            <Link
              to="/"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
              }}
            />
          }
        >
          <SquareKanbanIcon />
          <span className="flex-1 truncate">Board</span>
          {/* The counts are spelled out in the button's aria-label. */}
          <span
            aria-hidden
            className="ml-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums"
          >
            {needsInput > 0 ? (
              <span className="inline-flex items-center gap-1 text-warning-foreground">
                <span className="size-1.5 rounded-full bg-warning" />
                {needsInput}
              </span>
            ) : null}
            {running > 0 ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <span className="size-1.5 rounded-full bg-info" />
                {running}
              </span>
            ) : null}
            {waiting > 0 ? (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary/12 px-1.5 py-px font-medium text-primary">
                {waiting}
              </span>
            ) : null}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
