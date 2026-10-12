import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadListV2Items, buildThreadListV2ListItems } from "./threadListV2";
import {
  resolveThreadListSweepItems,
  threadListSweepActionFor,
  threadListSweepSection,
  threadListSweepTargetKey,
} from "./threadListSweep";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-02T00:00:00.000Z";

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return makeThreadShellFixture({ environmentId, ...input });
}

function keyOf(id: string): string {
  return `v2-thread:${environmentId}:${id}`;
}

function buildList(options: { readonly pinA2?: boolean } = {}) {
  const layout = buildThreadListV2Items({
    threads: [
      makeThread({ id: ThreadId.make("pinned"), title: "pinned", pinnedAt: NOW }),
      makeThread({ id: ThreadId.make("a1"), title: "a1", activeOrderKey: "a" }),
      makeThread({
        id: ThreadId.make("a2"),
        title: "a2",
        activeOrderKey: "b",
        ...(options.pinA2 === true ? { pinnedAt: "2026-06-01T00:00:00.000Z" } : {}),
      }),
      makeThread({ id: ThreadId.make("a3"), title: "a3", activeOrderKey: "c" }),
      makeThread({
        id: ThreadId.make("s1"),
        title: "s1",
        settledOverride: "settled",
        settledAt: "2026-06-01T12:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("s2"),
        title: "s2",
        settledOverride: "settled",
        settledAt: "2026-06-01T11:00:00.000Z",
      }),
    ],
    environmentId: null,
    searchQuery: "",
    now: NOW,
  });
  return buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks: [],
    settledCount: layout.settledCount,
    settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
  });
}

type ListItems = ReadonlyArray<{ readonly type: string; readonly key: string }>;

function sectionOf(items: ListItems, key: string): string {
  return threadListSweepSection(
    items,
    items.findIndex((item) => item.key === key),
  )!;
}

function sweptIds(
  items: ListItems,
  originId: string,
  targetKey: string,
  canApply: (id: string) => boolean = () => true,
  originSection: string = sectionOf(items, keyOf(originId)),
): string[] {
  return resolveThreadListSweepItems(
    items,
    { originKey: keyOf(originId), originSection, targetKey },
    (item) => canApply(item.item.thread.id),
  ).map((item) => item.item.thread.id);
}

describe("threadListSweepActionFor", () => {
  it("offers the row's lifecycle action", () => {
    const supported = { settlementSupported: true, snoozeSupported: true };
    expect(threadListSweepActionFor({ variant: "card", snoozed: false, ...supported })).toBe(
      "settle",
    );
    expect(threadListSweepActionFor({ variant: "slim", snoozed: false, ...supported })).toBe(
      "unsettle",
    );
    expect(threadListSweepActionFor({ variant: "slim", snoozed: true, ...supported })).toBe(
      "unsnooze",
    );
  });

  it("offers nothing the server cannot do", () => {
    expect(
      threadListSweepActionFor({
        variant: "card",
        snoozed: false,
        settlementSupported: false,
        snoozeSupported: true,
      }),
    ).toBeNull();
    expect(
      threadListSweepActionFor({
        variant: "slim",
        snoozed: true,
        settlementSupported: true,
        snoozeSupported: false,
      }),
    ).toBeNull();
  });
});

describe("resolveThreadListSweepItems", () => {
  const items = buildList();

  it("covers the rows between origin and target in list order", () => {
    expect(items.map((item) => item.key)).toEqual([
      keyOf("pinned"),
      keyOf("a1"),
      keyOf("a2"),
      keyOf("a3"),
      "v2-settled-shelf",
      keyOf("s1"),
      keyOf("s2"),
    ]);
    expect(sweptIds(items, "a1", keyOf("a2"))).toEqual(["a1", "a2"]);
    expect(sweptIds(items, "a3", keyOf("a2"))).toEqual(["a2", "a3"]);
    expect(sweptIds(items, "a2", keyOf("a2"))).toEqual(["a2"]);
  });

  it("stays in the origin's section", () => {
    expect(sweptIds(items, "a1", keyOf("s2"))).toEqual(["a1", "a2", "a3"]);
    expect(sweptIds(items, "a3", keyOf("pinned"))).toEqual(["a1", "a2", "a3"]);
    expect(sweptIds(items, "s2", keyOf("a1"))).toEqual(["s1", "s2"]);
  });

  it("skips rows the action cannot apply to", () => {
    expect(sweptIds(items, "a1", keyOf("a3"), (id) => id !== "a2")).toEqual(["a1", "a3"]);
  });

  it("sweeps nothing without a thread origin or a known target", () => {
    expect(sweptIds(items, "missing", keyOf("a2"), undefined, "active:unpinned")).toEqual([]);
    expect(sweptIds(items, "a1", "missing")).toEqual([]);
    expect(
      resolveThreadListSweepItems(
        items,
        { originKey: "v2-settled-shelf", originSection: "active:unpinned", targetKey: keyOf("s1") },
        () => true,
      ),
    ).toEqual([]);
  });

  it("drops a row that leaves the section mid-sweep", () => {
    const pinnedMidSweep = buildList({ pinA2: true });
    expect(pinnedMidSweep.map((item) => item.key).slice(0, 4)).toEqual([
      keyOf("a2"),
      keyOf("pinned"),
      keyOf("a1"),
      keyOf("a3"),
    ]);
    expect(
      sweptIds(pinnedMidSweep, "a1", keyOf("a3"), undefined, sectionOf(items, keyOf("a1"))),
    ).toEqual(["a1", "a3"]);
  });

  it("sweeps nothing once the origin itself changes section", () => {
    // a3 started under the working shelf, then stopped working and joined the
    // active rows above it.
    const working = [
      ...items.slice(0, 3),
      { type: "v2-working-shelf", key: "v2-working-shelf" },
      ...items.slice(3),
    ];
    const originSection = sectionOf(working, keyOf("a3"));
    expect(originSection).toBe("v2-working-shelf:unpinned");
    expect(sweptIds(working, "a2", keyOf("a3"))).toEqual(["a2"]);
    expect(sweptIds(items, "a3", keyOf("a1"), undefined, originSection)).toEqual([]);
  });
});

describe("threadListSweepSection", () => {
  it("names the shelf a row sits under and whether it is pinned", () => {
    const items = buildList();
    expect(sectionOf(items, keyOf("pinned"))).toBe("active:pinned");
    expect(sectionOf(items, keyOf("a1"))).toBe("active:unpinned");
    expect(sectionOf(items, keyOf("s1"))).toBe("v2-settled-shelf:unpinned");
    expect(
      threadListSweepSection(
        items,
        items.findIndex((item) => item.key === "v2-settled-shelf"),
      ),
    ).toBeNull();
  });
});

describe("threadListSweepTargetKey", () => {
  const rows = [
    { key: "a", top: 0 },
    { key: "b", top: 50 },
    { key: "c", top: 120 },
  ];

  it("resolves a point to the row at or above it", () => {
    expect(threadListSweepTargetKey(rows, 0)).toBe("a");
    expect(threadListSweepTargetKey(rows, 60)).toBe("b");
    expect(threadListSweepTargetKey(rows, 119)).toBe("b");
    expect(threadListSweepTargetKey(rows, 500)).toBe("c");
  });

  it("resolves a point above the first row to the first row", () => {
    expect(threadListSweepTargetKey(rows, -20)).toBe("a");
    expect(threadListSweepTargetKey([], 10)).toBeNull();
  });
});
