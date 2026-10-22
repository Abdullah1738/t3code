import { describe, expect, it, vi } from "vite-plus/test";

import {
  connectionLabel,
  createSnapshotStore,
  feedFailureLines,
  feedOfflineLines,
} from "./store.ts";

describe("snapshot store", () => {
  it("keeps the failure with when it last loaded, and Retry opens the feed again", () => {
    let clock = 1000;
    const opened: Array<{ emit: (value: number) => void; fail: (error: unknown) => void }> = [];
    let closed = 0;
    const store = createSnapshotStore<number>(
      (emit, fail) => {
        opened.push({ emit, fail });
        return () => {
          closed += 1;
        };
      },
      { now: () => clock },
    );
    let changes = 0;
    const stop = store.subscribe(() => {
      changes += 1;
    });
    opened[0]?.emit(1);
    clock = 2000;
    opened[0]?.fail(new Error("gone"));
    expect(store.failure()).toEqual({ error: new Error("gone"), lastLoadedAt: 1000 });
    expect(store.get()).toBe(1);
    expect(closed).toBe(1);
    // A late value from the failed feed is ignored.
    opened[0]?.emit(2);
    expect(store.get()).toBe(1);

    store.retry();
    expect(store.failure()).toBeUndefined();
    expect(opened).toHaveLength(2);
    opened[1]?.emit(3);
    expect(store.get()).toBe(3);
    // First value, the failure, Retry, the new value.
    expect(changes).toBe(4);
    stop();
    expect(closed).toBe(2);
  });

  it("a feed that fails while it opens never stays open", () => {
    let closed = 0;
    const store = createSnapshotStore<number>((_emit, fail) => {
      fail("no server");
      return () => {
        closed += 1;
      };
    });
    const stop = store.subscribe(() => {});
    expect(store.failure()).toEqual({ error: "no server", lastLoadedAt: null });
    expect(closed).toBe(1);
    stop();
    expect(closed).toBe(1);
  });

  it("keeps the source open for the keep-alive after the last reader leaves", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const opened: Array<(value: number) => void> = [];
      let closed = 0;
      const store = createSnapshotStore<number>(
        (emit) => {
          opened.push(emit);
          return () => {
            closed += 1;
          };
        },
        { keepAliveMs: 1000 },
      );
      const first = store.subscribe(() => {});
      opened[0]?.(1);
      first();
      expect(closed).toBe(0);
      // Back within the keep-alive: same subscription, value already there.
      vi.advanceTimersByTime(999);
      const second = store.subscribe(() => {});
      expect(opened).toHaveLength(1);
      expect(store.get()).toBe(1);
      second();
      vi.advanceTimersByTime(1000);
      expect(closed).toBe(1);
      // Past it the next reader opens again and sees the last value meanwhile.
      const third = store.subscribe(() => {});
      expect(opened).toHaveLength(2);
      expect(store.get()).toBe(1);
      third();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a feed that fails while kept open starts fresh for the next reader", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const opened: Array<(error: unknown) => void> = [];
      const store = createSnapshotStore<number>(
        (_emit, fail) => {
          opened.push(fail);
          return () => {};
        },
        { keepAliveMs: 1000 },
      );
      store.subscribe(() => {})();
      opened[0]?.("dropped");
      expect(store.failure()).toBeUndefined();
      const again = store.subscribe(() => {});
      expect(opened).toHaveLength(2);
      again();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says what failed and when it last loaded, with the day once it is not today", () => {
    const now = Date.parse("2026-10-20T10:00:00Z");
    expect(feedFailureLines("the inbox", { lastLoadedAt: null }, now, "UTC")).toEqual({
      title: "Couldn't load the inbox.",
      detail: null,
    });
    expect(
      feedFailureLines(
        "the inbox",
        { lastLoadedAt: Date.parse("2026-10-20T04:53:00Z") },
        now,
        "UTC",
      ).detail,
    ).toBe("Last loaded at 04:53.");
    expect(
      feedFailureLines(
        "the inbox",
        { lastLoadedAt: Date.parse("2026-10-19T22:10:00Z") },
        now,
        "UTC",
      ).detail,
    ).toBe("Last loaded at Mon 19 Oct 22:10.");
  });

  it("says a feed with nothing loaded waits for the server instead of loading forever", () => {
    expect(feedOfflineLines("offline")).toEqual({
      title: "Offline",
      detail: "Loads when the server is back.",
    });
    expect(feedOfflineLines("reconnecting")?.title).toBe("Reconnecting");
    expect(feedOfflineLines("error")?.title).toBe("Offline");
    expect(feedOfflineLines("connecting")).toBeNull();
    expect(feedOfflineLines("connected")).toBeNull();
    expect(feedOfflineLines(null)).toBeNull();
    expect(connectionLabel("connecting")).toBe("Connecting");
    expect(connectionLabel("unsupported")).toBe("Offline");
  });
});
