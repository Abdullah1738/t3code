import { StackActions, useNavigation } from "@react-navigation/native";
import type { ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { usePairedEnvironmentId } from "../common/environment";
import type { KanbanRecordKind } from "./logic";

export interface KanbanNav {
  readonly openCard: (cardId: string) => void;
  readonly openGoal: (goalId: string) => void;
  /** null starts a new discussion. */
  readonly openDiscussion: (discussionId: string | null) => void;
  readonly openDiscussions: () => void;
  readonly openThread: (threadId: string) => void;
}

/**
 * Pushes the board's screens; the board id rides along so links restore them.
 * Records push rather than navigate, so a card opened from a card's
 * discussion stacks on top and back returns to the first.
 */
export function useKanbanNav(boardId: string): KanbanNav {
  const navigation = useNavigation();
  const environmentId = usePairedEnvironmentId();
  return useMemo(() => {
    const push = (kind: KanbanRecordKind, id?: string) =>
      navigation.dispatch(StackActions.push("KanbanRecord", { kind, boardId, id }));
    return {
      openCard: (id) => push("card", id),
      openGoal: (id) => push("goal", id),
      openDiscussion: (id) => push("discussion", id ?? undefined),
      openDiscussions: () => push("discussions"),
      openThread: (threadId) => {
        if (environmentId)
          navigation.navigate("Thread", { environmentId, threadId: threadId as ThreadId });
      },
    };
  }, [boardId, environmentId, navigation]);
}
