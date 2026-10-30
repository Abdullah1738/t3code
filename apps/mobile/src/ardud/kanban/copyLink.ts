import { kanbanCopyLink, type KanbanLinkKind } from "@t3tools/client-runtime/ardud/kanban";
import * as Clipboard from "expo-clipboard";

/** Puts the same link text the web copy button uses on the clipboard. */
export function copyLinkAction(kind: KanbanLinkKind, id: string, label: string) {
  return {
    accessibilityLabel: "Copy link",
    icon: "link" as const,
    onPress: () => {
      void Clipboard.setStringAsync(kanbanCopyLink(kind, id, label));
    },
  };
}
