import { StackActions, useNavigation } from "@react-navigation/native";
import type { ThreadId } from "@t3tools/contracts";

import { askParamsFromKey } from "./logic";
import { useAskEnvironmentId } from "./askStore";

export interface NeedsYouNav {
  readonly back: () => void;
  readonly openQueue: () => void;
  /** Opens an ask by its queue key; `replace` swaps the ask on screen for it. */
  readonly openAsk: (key: string, replace?: boolean) => void;
  readonly openBatch: (boardId: string, batchKey: string) => void;
  readonly openDiscussion: (key: string) => void;
  readonly openHistory: () => void;
  readonly openReference: () => void;
  readonly openCard: (boardId: string, cardId: string) => void;
  readonly openThread: (threadId: string) => void;
}

/** The ways between the Needs-you screens, and out of them to a card or a thread. */
export function useNeedsYouNav(): NeedsYouNav {
  const navigation = useNavigation();
  const environmentId = useAskEnvironmentId();
  return {
    back: () => {
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.navigate("NeedsYou");
    },
    openQueue: () => navigation.navigate("NeedsYou"),
    openAsk: (key, replace) => {
      const params = askParamsFromKey(key);
      if (params === null) return;
      navigation.dispatch(
        replace
          ? StackActions.replace("NeedsYouAsk", params)
          : StackActions.push("NeedsYouAsk", params),
      );
    },
    openBatch: (boardId, batchKey) =>
      navigation.dispatch(StackActions.push("NeedsYouBatch", { boardId, batchKey })),
    openDiscussion: (key) => {
      const params = askParamsFromKey(key);
      if (params !== null) navigation.dispatch(StackActions.push("NeedsYouDiscussion", params));
    },
    openHistory: () => navigation.navigate("NeedsYouHistory"),
    openReference: () => navigation.navigate("NeedsYouReference"),
    openCard: (boardId, cardId) =>
      navigation.dispatch(StackActions.push("KanbanRecord", { kind: "card", boardId, id: cardId })),
    openThread: (threadId) => {
      if (environmentId) {
        navigation.navigate("Thread", { environmentId, threadId: threadId as ThreadId });
      }
    },
  };
}
