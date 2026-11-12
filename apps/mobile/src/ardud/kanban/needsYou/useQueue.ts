import {
  askKey,
  needsYouBatchKey,
  needsYouFromFeed,
  type NeedsYou,
  type NeedsYouItem,
  type NeedsYouMark,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem } from "@t3tools/contracts";

import { useAsk } from "./askStore";
import { needsYouItemsByKey } from "./logic";

const NO_OPEN: ReadonlyArray<KanbanAskFeedItem> = [];

export interface QueueData {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly error: string | null;
  /** Whether a feed has been read at all. */
  readonly read: boolean;
  readonly open: ReadonlyArray<KanbanAskFeedItem>;
  readonly entries: ReadonlyMap<string, KanbanAskFeedItem>;
  readonly needsYou: NeedsYou;
  readonly items: ReadonlyMap<string, NeedsYouItem>;
  readonly boardNames: ReadonlyMap<string, string>;
  readonly marks: Readonly<Record<string, NeedsYouMark>>;
  /** Asks whose answer is held or on its way: they no longer count. */
  readonly hidden: ReadonlySet<string>;
  /** Every batch unfolded, for stepping from ask to ask. */
  readonly allBatches: ReadonlySet<string>;
}

/** The open asks as every Needs-you screen reads them: ranked the way the web page ranks them. */
export function useQueue(nowMs: number): QueueData {
  const status = useAsk((state) => state.status);
  const error = useAsk((state) => state.error);
  const feed = useAsk((state) => state.feed);
  const marks = useAsk((state) => state.marks);
  const hiddenMap = useAsk((state) => state.hidden);
  const open = feed?.open ?? NO_OPEN;
  const needsYou = needsYouFromFeed(open, nowMs);
  return {
    status,
    error,
    read: feed !== null,
    open,
    entries: new Map(open.map((entry) => [askKey(entry), entry])),
    needsYou,
    items: needsYouItemsByKey(needsYou),
    boardNames: new Map(open.map((entry) => [entry.boardId, entry.boardName])),
    marks,
    hidden: new Set(Object.keys(hiddenMap)),
    allBatches: new Set(
      needsYou.entries.flatMap((entry) =>
        entry._tag === "batch" ? [needsYouBatchKey(entry)] : [],
      ),
    ),
  };
}
