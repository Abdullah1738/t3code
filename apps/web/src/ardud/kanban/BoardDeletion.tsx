import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { KANBAN_WS_METHODS, type KanbanBoard } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { kanban, runAction, useBoards, useKanbanPermission } from "./kanbanStore";

export function DeleteBoard(props: { board: KanbanBoard }) {
  const navigate = useNavigate();
  const boards = useBoards();
  const canEdit = useKanbanPermission(KANBAN_WS_METHODS.boardUpdate);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (busy || !canEdit || name !== props.board.name) return;
    setBusy(true);
    const saved = await runAction("Couldn't delete board", () =>
      kanban.updateBoard({ boardId: props.board.id, archived: true }),
    );
    setBusy(false);
    if (!saved) return;
    setOpen(false);
    const next = boards?.find(
      (entry) => entry.board.id !== props.board.id && entry.board.archivedAt === null,
    );
    if (next)
      await navigate({ to: "/boards/$boardId", params: { boardId: next.board.id }, search: {} });
    else await navigate({ to: "/" });
  };
  return (
    <>
      <Button
        variant="destructive"
        disabled={!canEdit}
        onClick={() => {
          setName("");
          setOpen(true);
        }}
      >
        Delete board
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Delete board</DialogTitle>
            <DialogDescription>
              Stops its threads and hides it. You can restore it from Deleted boards.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="flex flex-col gap-2 text-sm">
              <span className="break-words">Type {props.board.name} to confirm</span>
              <Input
                name="board-name"
                spellCheck={false}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
                autoComplete="off"
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={busy || !canEdit || name !== props.board.name}
              onClick={() => void remove()}
            >
              {busy ? "Deleting…" : "Delete board"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function DeletedBoards() {
  const boards = useBoards();
  const canEdit = useKanbanPermission(KANBAN_WS_METHODS.boardUpdate);
  const [pending, setPending] = useState<string | null>(null);
  const deleted = boards?.filter((entry) => entry.board.archivedAt !== null) ?? [];
  const restore = async (board: KanbanBoard) => {
    if (pending !== null || !canEdit) return;
    setPending(board.id);
    await runAction("Couldn't restore board", () =>
      kanban.updateBoard({ boardId: board.id, archived: false }),
    );
    setPending(null);
  };
  return deleted.length === 0 ? (
    <p className="text-sm text-muted-foreground">No deleted boards.</p>
  ) : (
    <ul className="flex flex-col gap-2">
      {deleted.map(({ board }) => (
        <li key={board.id} className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-sm">{board.name}</span>
          <Button
            variant="outline"
            disabled={!canEdit || pending !== null}
            aria-label={`Restore ${board.name}`}
            onClick={() => void restore(board)}
          >
            {pending === board.id ? "Restoring…" : "Restore"}
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function DeletedBoardsDialog() {
  const [open, setOpen] = useState(false);
  const boards = useBoards();
  if (!boards?.some((entry) => entry.board.archivedAt !== null)) return null;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Deleted boards
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Deleted boards</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <DeletedBoards />
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
