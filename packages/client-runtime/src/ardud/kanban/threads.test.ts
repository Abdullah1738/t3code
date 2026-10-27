import type { KanbanBoard, KanbanBoardListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardThreadIds, mergeBoardList, withoutBoardThreads } from "./threads.ts";

const board = (id: string, name = id) => ({ id, name }) as unknown as KanbanBoard;
const entry = (
  boardId: string,
  fields: Partial<Omit<KanbanBoardListEntry, "boardId">> = {},
): KanbanBoardListEntry =>
  ({
    boardId,
    board: null,
    needsOwner: 0,
    running: 0,
    unread: 0,
    threadIds: [],
    ...fields,
  }) as never;

describe("board list updates", () => {
  it("keeps the held board and adds new threads once", () => {
    const first = mergeBoardList(undefined, [
      entry("b1", { board: board("b1"), threadIds: ["t1"] as never }),
    ]);
    const next = mergeBoardList(first, [
      entry("b1", { running: 1, threadIds: ["t2"] as never }),
      entry("b2"),
    ]);
    // b2 has no board yet, so it waits for a list that carries one.
    expect(next.map((summary) => [summary.board.name, summary.running, summary.threadIds])).toEqual(
      [["b1", 1, ["t1", "t2"]]],
    );
    // A reconnect's whole list repeats ids already held and renames the board.
    const again = mergeBoardList(next, [
      entry("b1", { board: board("b1", "Renamed"), threadIds: ["t1", "t2"] as never }),
    ]);
    expect(again[0]?.board.name).toBe("Renamed");
    expect(again[0]?.threadIds).toBe(next[0]?.threadIds);
    expect([...boardThreadIds(again)]).toEqual(["t1", "t2"]);
  });

  it("leaves board threads out of thread lists", () => {
    const threads = [{ id: "t1" }, { id: "mine" }];
    expect(withoutBoardThreads(threads, new Set(["t1"]))).toEqual([{ id: "mine" }]);
    expect(withoutBoardThreads(threads, new Set(["other"]))).toBe(threads);
  });
});
