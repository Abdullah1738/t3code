import type { ArdudBoardEntry, ArdudBoardSnapshot, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  acceptBoardSnapshot,
  applyBoardDelta,
  applyBoardSnapshot,
  createSseParser,
  formatBoardAge,
  groupBoardLanes,
  statusLabel,
  type BoardData,
} from "./board.ts";

const entry = (
  id: string,
  overrides: Partial<Omit<ArdudBoardEntry, "threadId">> = {},
): ArdudBoardEntry => ({
  threadId: id as ThreadId,
  projectId: null,
  title: id,
  state: "waiting",
  status: "idle",
  workRevision: 1,
  updatedAt: 1_000,
  ...overrides,
});

const snapshot = (
  revision: number,
  entries: ReadonlyArray<ArdudBoardEntry>,
  syncError: string | null = null,
): ArdudBoardSnapshot => ({ version: 1, revision, activatedAt: 0, entries, syncError });

const empty: BoardData & { readonly connection: string } = {
  entries: new Map(),
  revision: -1,
  syncError: null,
  connection: "live",
};

describe("board reducer", () => {
  it("replaces state from a snapshot and keeps extra fields", () => {
    const state = applyBoardSnapshot(empty, snapshot(3, [entry("a"), entry("b")], "oops"));
    expect([...state.entries.keys()]).toEqual(["a", "b"]);
    expect(state.revision).toBe(3);
    expect(state.syncError).toBe("oops");
    expect(state.connection).toBe("live");
  });

  it("applies upserts and removals from a delta", () => {
    const base = applyBoardSnapshot(empty, snapshot(3, [entry("a"), entry("b")]));
    const next = applyBoardDelta(base, {
      revision: 4,
      upserts: [entry("a", { state: "backlog" }), entry("c")],
      removed: ["b" as ThreadId],
      syncError: null,
    });
    expect([...next.entries.keys()].toSorted()).toEqual(["a", "c"]);
    expect(next.entries.get("a")?.state).toBe("backlog");
    expect(next.revision).toBe(4);
    expect(base.entries.has("b")).toBe(true);
  });

  it("never moves the revision backwards on a stale delta", () => {
    const base = applyBoardSnapshot(empty, snapshot(5, []));
    const next = applyBoardDelta(base, {
      revision: 4,
      upserts: [],
      removed: [],
      syncError: null,
    });
    expect(next.revision).toBe(5);
  });

  it("accepts action snapshots at or above the current revision only", () => {
    const base = applyBoardSnapshot(empty, snapshot(5, [entry("a")]));
    expect(acceptBoardSnapshot(base, snapshot(4, []))).toBe(base);
    expect(acceptBoardSnapshot(base, snapshot(5, [])).entries.size).toBe(0);
    expect(acceptBoardSnapshot(base, snapshot(6, [entry("b")])).revision).toBe(6);
  });
});

describe("createSseParser", () => {
  const collect = () => {
    const events: Array<[string, string]> = [];
    const parse = createSseParser((event, data) => events.push([event, data]));
    return { events, parse };
  };

  it("emits events split across chunks", () => {
    const { events, parse } = collect();
    parse('event: snapshot\ndata: {"a"');
    parse(":1}\n");
    expect(events).toEqual([]);
    parse("\nevent: delta\ndata: 2\n\n");
    expect(events).toEqual([
      ["snapshot", '{"a":1}'],
      ["delta", "2"],
    ]);
  });

  it("skips keep-alive comments and joins multi-line data", () => {
    const { events, parse } = collect();
    parse(": keep-alive\n\n");
    parse("data: one\ndata: two\n\n: keep-alive\n\n");
    expect(events).toEqual([["message", "one\ntwo"]]);
  });
});

describe("groupBoardLanes", () => {
  it("groups by lane, newest first, ties by thread id", () => {
    const lanes = groupBoardLanes([
      entry("b", { updatedAt: 5 }),
      entry("a", { updatedAt: 5 }),
      entry("c", { updatedAt: 9 }),
      entry("r", { state: "running" }),
      entry("s", { state: "scheduled" }),
    ]);
    expect(lanes.waiting.map((item) => item.threadId)).toEqual(["c", "a", "b"]);
    expect(lanes.running.map((item) => item.threadId)).toEqual(["r"]);
    expect(lanes.scheduled.map((item) => item.threadId)).toEqual(["s"]);
    expect(lanes.backlog).toEqual([]);
  });
});

describe("board labels", () => {
  it("describes the card status", () => {
    expect(statusLabel({ state: "running", status: "working" })).toBe("Working…");
    expect(statusLabel({ state: "waiting", status: "unknown" })).toBe("Checking status…");
    expect(statusLabel({ state: "backlog", status: "deleted" })).toBe("Deleted");
  });

  it("formats age buckets", () => {
    const now = 10 * 86_400_000;
    expect(formatBoardAge(now - 30_000, now)).toBe("just now");
    expect(formatBoardAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatBoardAge(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatBoardAge(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});
