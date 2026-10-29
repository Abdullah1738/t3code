import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_DISCUSSION_SELECTION,
  bulkDiscussionMenu,
  bulkDiscussionTargets,
  selectDiscussionRange,
  toggleDiscussion,
} from "./discussionSelection";

const ids = (selection: { ids: ReadonlySet<string> }) => [...selection.ids].sort();

describe("toggleDiscussion", () => {
  it("adds a discussion and makes it the anchor", () => {
    const next = toggleDiscussion(EMPTY_DISCUSSION_SELECTION, "a");
    expect(ids(next)).toEqual(["a"]);
    expect(next.anchor).toBe("a");
  });

  it("removing one keeps the others and the anchor", () => {
    const first = toggleDiscussion(EMPTY_DISCUSSION_SELECTION, "a");
    const second = toggleDiscussion(first, "b");
    const removed = toggleDiscussion(second, "b");
    expect(ids(removed)).toEqual(["a"]);
    expect(removed.anchor).toBe("b");
  });
});

describe("selectDiscussionRange", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("selects from the anchor down, inclusive", () => {
    const anchored = toggleDiscussion(EMPTY_DISCUSSION_SELECTION, "b");
    const next = selectDiscussionRange(anchored, "d", order, null);
    expect(ids(next)).toEqual(["b", "c", "d"]);
    expect(next.anchor).toBe("b");
  });

  it("selects from the anchor up, inclusive", () => {
    const anchored = toggleDiscussion(EMPTY_DISCUSSION_SELECTION, "d");
    const next = selectDiscussionRange(anchored, "b", order, null);
    expect(ids(next)).toEqual(["b", "c", "d"]);
  });

  it("adds to what was already selected", () => {
    const withA = toggleDiscussion(EMPTY_DISCUSSION_SELECTION, "a");
    const anchored = toggleDiscussion(withA, "c");
    const next = selectDiscussionRange(anchored, "e", order, null);
    expect(ids(next)).toEqual(["a", "c", "d", "e"]);
  });

  it("uses the open discussion as anchor when nothing is selected and keeps it", () => {
    const next = selectDiscussionRange(EMPTY_DISCUSSION_SELECTION, "d", order, "b");
    expect(ids(next)).toEqual(["b", "c", "d"]);
    expect(next.anchor).toBe("b");
  });

  it("adds only the id and makes it the anchor when there is no anchor", () => {
    const next = selectDiscussionRange(EMPTY_DISCUSSION_SELECTION, "d", order, null);
    expect(ids(next)).toEqual(["d"]);
    expect(next.anchor).toBe("d");
  });

  it("adds only the id when the anchor is missing from order", () => {
    const anchored = toggleDiscussion(EMPTY_DISCUSSION_SELECTION, "zzz");
    const next = selectDiscussionRange(anchored, "c", order, null);
    expect(ids(next)).toEqual(["c", "zzz"]);
    expect(next.anchor).toBe("c");
  });

  it("adds only the id when the id is missing from order", () => {
    const anchored = toggleDiscussion(EMPTY_DISCUSSION_SELECTION, "b");
    const next = selectDiscussionRange(anchored, "zzz", order, null);
    expect(ids(next)).toEqual(["b", "zzz"]);
    expect(next.anchor).toBe("zzz");
  });

  it("a second shift-click extends from the same anchor", () => {
    const anchored = toggleDiscussion(EMPTY_DISCUSSION_SELECTION, "b");
    const first = selectDiscussionRange(anchored, "c", order, null);
    const second = selectDiscussionRange(first, "e", order, null);
    expect(ids(second)).toEqual(["b", "c", "d", "e"]);
    expect(second.anchor).toBe("b");
  });
});

describe("bulkDiscussionMenu", () => {
  it("labels items with counts", () => {
    const items = bulkDiscussionMenu(
      [
        { unread: 1, settledAt: null },
        { unread: 2, settledAt: null },
        { unread: 0, settledAt: "2026-10-28T00:00:00.000Z" },
      ],
      { read: true, update: true },
    );
    expect(items.map((item) => item.label)).toEqual([
      "Mark read (2)",
      "Settle (2)",
      "Unsettle (1)",
    ]);
  });

  it("leaves out items with zero count", () => {
    const items = bulkDiscussionMenu([{ unread: 0, settledAt: null }], {
      read: true,
      update: true,
    });
    expect(items.map((item) => item.id)).toEqual(["settle"]);
  });

  it("disables items the permissions don't allow", () => {
    const items = bulkDiscussionMenu(
      [
        { unread: 1, settledAt: null },
        { unread: 0, settledAt: "2026-10-28T00:00:00.000Z" },
      ],
      { read: false, update: false },
    );
    expect(items.map((item) => [item.id, item.disabled])).toEqual([
      ["mark-read", true],
      ["settle", true],
      ["unsettle", true],
    ]);
  });

  it("returns an empty array when there is nothing to do", () => {
    expect(bulkDiscussionMenu([], { read: true, update: true })).toEqual([]);
  });
});

describe("bulkDiscussionTargets", () => {
  const rows = [
    { id: "a", unread: 1, settledAt: null },
    { id: "b", unread: 0, settledAt: null },
    { id: "c", unread: 0, settledAt: "2026-10-28T00:00:00.000Z" },
  ];

  it("mark-read picks unread discussions", () => {
    expect(bulkDiscussionTargets(rows, "mark-read")).toEqual(["a"]);
  });

  it("settle picks unsettled discussions", () => {
    expect(bulkDiscussionTargets(rows, "settle")).toEqual(["a", "b"]);
  });

  it("unsettle picks settled discussions", () => {
    expect(bulkDiscussionTargets(rows, "unsettle")).toEqual(["c"]);
  });
});
