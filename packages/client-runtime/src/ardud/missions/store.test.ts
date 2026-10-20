import { describe, expect, it } from "vite-plus/test";

import { createSnapshotStore } from "./store.ts";

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
      () => clock,
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
});
