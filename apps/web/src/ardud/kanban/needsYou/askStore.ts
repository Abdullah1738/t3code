/**
 * What the Needs-you page knows: the ask feed, what he has typed on each ask,
 * and the answers that are held, on their way, failed or sent. One store for
 * the page and the sidebar count. The logic lives in the shared runtime (the
 * phone runs the same store); this file gives it the web's server calls, a
 * zustand cell so components select from it, and the browser's signals.
 */
import {
  INITIAL_ASK_STATE,
  askFormOf,
  createAskStore,
  type AskState,
} from "@t3tools/client-runtime/ardud/kanban";
import { create } from "zustand";

import { kanban } from "../kanbanStore";
import { askApi } from "./askApi";

export {
  HAND_WORDS_MAX,
  askAsker,
  askKey,
  askNeedsDetail,
  type AskSend,
  type AskSendRef,
  type AskToast,
} from "@t3tools/client-runtime/ardud/kanban";

export const useAskStore = create<AskState>(() => INITIAL_ASK_STATE);

export const formOf = askFormOf;

const store = createAskStore({
  api: askApi,
  cell: {
    getState: useAskStore.getState,
    setState: (patch) => useAskStore.setState(patch),
    subscribe: (listener) => useAskStore.subscribe(listener),
  },
  watch: {
    onBoardsChange: (run) => kanban.boards.subscribe(run),
    onForeground: (run) => {
      const onVisible = () => {
        if (document.visibilityState === "visible") run();
      };
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", run);
      return () => {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", run);
      };
    },
    isForeground: () => document.visibilityState === "visible",
  },
});

export const {
  showAskToast,
  dismissAskToast,
  noteAskFocus,
  refreshAsks,
  loadClosedAsks,
  watchAsks,
  patchAskForm,
  setAskValue,
  setAskChangeView,
  markAskTried,
  seeAsk,
  loadAskDetail,
  noteOwnerStanding,
  noteAskNotOwner,
  flushAskSends,
  answerAsk,
  answerAskBatch,
  handAsks,
  undoAskSend,
  retryAskSend,
  takeBackAsk,
  replyOnAsk,
  snoozeAsks,
  noteAskAnswered,
  noteAskStale,
  resetAskStore,
} = store;
