import { boardRenameValue } from "@t3tools/client-runtime/ardud/kanban";
import { errorMessage } from "@t3tools/client-runtime/ardud/common";
import type { KanbanBoardId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { kanbanClient } from "./kanbanStore";

export function renameBoard(boardId: KanbanBoardId, name: string): void {
  Dialog.prompt({
    title: "Rename board",
    initialValue: name,
    confirmText: "Rename",
    onConfirm: (value) => {
      const next = boardRenameValue(value, name);
      if (next === null) return;
      void kanbanClient()
        .updateBoard({ boardId, name: next })
        .catch((error) => {
          Dialog.alert("Could not rename", errorMessage(error));
        });
    },
  });
}
