import { Link } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";

import { Button } from "../ui/button";

/**
 * A board drives this thread, so the owner reads it but cannot send. Same slot
 * and shape as the provider-subagent bar. The link goes back to the card or
 * discussion that owns the run, not just the board root.
 */
export function BoardRunBar(props: {
  readonly boardId: string;
  readonly boardName: string;
  /** The owning record: a card's number/title or a discussion's, or null when unknown. */
  readonly owner: { readonly kind: "card" | "discussion"; readonly id: string; readonly label: string } | null;
}) {
  const { owner } = props;
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-3xl py-2 ps-5 pe-2 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <LayoutGridIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground">
          Run by the {props.boardName} board · view only
        </span>
      </span>
      {owner ? (
        <Button
          size="sm"
          variant="ghost"
          className="ms-auto"
          render={
            <Link
              to="/boards/$boardId"
              params={{ boardId: props.boardId }}
              search={owner.kind === "card" ? { card: owner.id } : { discussion: owner.id }}
            />
          }
        >
          {owner.label}
        </Button>
      ) : null}
    </div>
  );
}
