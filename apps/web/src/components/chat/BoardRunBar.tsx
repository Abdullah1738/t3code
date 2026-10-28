import { LayoutGridIcon } from "lucide-react";

import { Button } from "../ui/button";

/**
 * A board drives this thread, so the owner reads it but cannot send. Same slot
 * and shape as the provider-subagent bar; the board's Threads view and its card
 * are the place to act on the run.
 */
export function BoardRunBar(props: {
  readonly boardName: string;
  readonly onOpenBoard: (() => void) | null;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-3xl py-2 ps-5 pe-2 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <LayoutGridIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground">
          Run by the {props.boardName} board · view only
        </span>
      </span>
      {props.onOpenBoard ? (
        <Button size="sm" variant="ghost" className="ms-auto" onClick={props.onOpenBoard}>
          Open board
        </Button>
      ) : null}
    </div>
  );
}
