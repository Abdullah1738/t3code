import { useAtomMount } from "@effect/atom-react";
import {
  buildIMessageChatRows,
  imessageRowsAtLevel,
  groupIMessageThreads,
  imessageThreadInput,
  sortIMessageChats,
  sortIMessageThreadsByCreation,
  type IMessageChatRowOptions,
} from "@t3tools/client-runtime/ardud/imessage";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  EMPTY_THREAD_HISTORY_META,
  type ThreadHistoryMeta,
} from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { useAtomValueWhileVisible } from "../../features/home/home-route-visibility";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { imessageTimelineEntries } from "./imessageTimeline";

const EMPTY_HISTORY_ATOM = Atom.make<ThreadHistoryMeta>(EMPTY_THREAD_HISTORY_META).pipe(
  Atom.withLabel("mobile-imessage-history:empty"),
);

/** Every iMessage chat, owner first, from all thread shells (archived ones included). */
export function useIMessageChats(threads: ReadonlyArray<EnvironmentThreadShell>) {
  return useMemo(
    () => sortIMessageChats(groupIMessageThreads(threads.map(imessageThreadInput))),
    [threads],
  );
}

/**
 * One chat's threads, oldest first, or an empty list when the chat has none yet.
 * Native-stack keeps rendering the chat under a pushed thread, so while it is
 * hidden every hook here holds its last values.
 */
export function useIMessageChatThreads(slug: string, visible: boolean) {
  const threads = useAtomValueWhileVisible(environmentThreadShells.threadShellsAtom, visible);
  const chats = useIMessageChats(threads);
  const chat = chats.find((candidate) => candidate.slug === slug);
  const chatThreads = useMemo(() => {
    if (!chat) return [];
    const byId = new Map(threads.map((thread) => [thread.id as string, thread]));
    return sortIMessageThreadsByCreation(
      chat.threadIds.flatMap((id) => {
        const thread = byId.get(id);
        return thread ? [thread] : [];
      }),
    );
  }, [chat, threads]);
  return { chat, threads: chatThreads };
}

export function threadRef(thread: EnvironmentThreadShell): ScopedThreadRef {
  return { environmentId: thread.environmentId, threadId: thread.id };
}

export function useThreadHistoryMeta(
  ref: ScopedThreadRef | null,
  visible: boolean,
): ThreadHistoryMeta {
  return useAtomValueWhileVisible(
    ref === null ? EMPTY_HISTORY_ATOM : environmentThreadDetails.historyAtom(ref),
    visible,
  );
}

/** One bounded page per press; the loader ignores presses while a page is in flight. */
export function useLoadEarlierHistory() {
  const load = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  return useCallback(
    (thread: EnvironmentThreadShell) => {
      void load({ environmentId: thread.environmentId, input: { threadId: thread.id } });
    },
    [load],
  );
}

/** The chat rows of one session. */
export function useIMessageThreadRows(
  thread: EnvironmentThreadShell,
  options: Omit<IMessageChatRowOptions, "activeRunId">,
  visible: boolean,
) {
  const ref = threadRef(thread);
  const itemsAtom = environmentThreadDetails.visibleTurnItemsAtom(ref);
  // The session stays subscribed while hidden so coming back shows it live, not a reload.
  useAtomMount(environmentThreadDetails.stateAtom(ref));
  const visibleTurnItems = useAtomValueWhileVisible(itemsAtom, visible);
  const status = useAtomValueWhileVisible(environmentThreadDetails.statusAtom(ref), visible);
  const error = useAtomValueWhileVisible(environmentThreadDetails.errorAtom(ref), visible);
  const activeRunId = threadRuntimeIsActive(thread.runtime)
    ? (thread.runtime?.activeRunId ?? null)
    : null;
  const { previousDayKey, namedSenders } = options;
  // The phone shows the conversation plus system lines and other agents' prompts; each
  // turn's notes and steps open in place under its chip.
  const rows = useMemo(
    () =>
      imessageRowsAtLevel(
        buildIMessageChatRows(imessageTimelineEntries(visibleTurnItems), {
          previousDayKey,
          namedSenders,
          activeRunId,
        }).rows,
        "system",
      ),
    [visibleTurnItems, previousDayKey, namedSenders, activeRunId],
  );
  return { rows, status, error };
}
