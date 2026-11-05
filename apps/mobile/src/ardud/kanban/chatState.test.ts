import { describe, expect, it, vi } from "vite-plus/test";

import {
  completeChoiceDraft,
  createEarlierPageLoader,
  createHistoryGesture,
  createRowStateStore,
  followingNewest,
  invertedAnswerOffset,
  nearHistoryEnd,
  newestFirst,
  type ChoiceDraft,
} from "./chatState";

describe("discussion pages", () => {
  it("requires a gesture for each page and cannot reload from layout or momentum", () => {
    const gesture = createHistoryGesture();
    expect(gesture.consume()).toBe(false);
    gesture.begin(false);
    expect(gesture.isActive()).toBe(true);
    expect(gesture.consume()).toBe(false);
    gesture.end();
    expect(gesture.isActive()).toBe(false);
    expect(gesture.consume()).toBe(false);
    gesture.begin(true);
    expect(gesture.consume()).toBe(false);
    gesture.end();
    expect(gesture.consume()).toBe(true);
    gesture.scroll(100, 200);
    expect(gesture.consume()).toBe(false);
    gesture.begin(false);
    gesture.scroll(100, 50);
    gesture.end();
    expect(gesture.consume()).toBe(false);
    gesture.begin(false);
    gesture.scroll(50, 200);
    gesture.end();
    expect(gesture.consume()).toBe(true);
    gesture.begin(false);
    gesture.scroll(200, 100);
    gesture.end();
    expect(gesture.consume()).toBe(false);
    gesture.begin(true);
    gesture.cancel();
    expect(gesture.consume()).toBe(false);
    gesture.begin(false);
    gesture.scroll(300, 50);
    gesture.scroll(50, 120);
    gesture.end();
    expect(gesture.consume()).toBe(true);
    expect(gesture.consume()).toBe(false);
  });

  it("keeps the newest at index zero without mutating the store, across earlier and live pages", () => {
    const newestPage = [{ seq: 3 }, { seq: 4 }, { seq: 5 }];
    expect(newestFirst(newestPage).map((message) => message.seq)).toEqual([5, 4, 3]);
    const withEarlierAndLive = [{ seq: 1 }, { seq: 2 }, ...newestPage, { seq: 6 }];
    expect(newestFirst(withEarlierAndLive).map((message) => message.seq)).toEqual([
      6, 5, 4, 3, 2, 1,
    ]);
    expect(newestPage.map((message) => message.seq)).toEqual([3, 4, 5]);
    expect(newestFirst(undefined)).toEqual([]);
  });

  it.each([
    [-10, false, false],
    [0, false, true],
    [4, false, true],
    [5, false, false],
    [0, true, false],
    [200, false, false],
  ])(
    "only follows incoming messages at rest at the newest edge",
    (offset, dragging, following) => {
      expect(followingNewest(offset, dragging)).toBe(following);
    },
  );

  it.each([
    [500, 40, 460],
    [30, 90, 0],
    [100, 0, 100],
  ])(
    "reveals an answer below the keyboard in the inverted list (%i - %i)",
    (offset, overflow, expected) => {
      expect(invertedAnswerOffset(offset, overflow)).toBe(expected);
    },
  );

  it.each([
    [0, 300, 600, true],
    [0, 1200, 600, false],
    [420, 1200, 600, true],
    [419, 1200, 600, false],
  ])(
    "detects a drag ending near the inverted history edge",
    (offset, content, viewport, near) => {
      expect(nearHistoryEnd(offset, content, viewport)).toBe(near);
    },
  );

  it("requests each cursor once, ignores duplicate end events and stops at the first page", async () => {
    let resolve!: (value: boolean) => void;
    const read = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise<boolean>((done) => (resolve = done)))
      .mockResolvedValue(true);
    const load = createEarlierPageLoader(read);
    const first = load(101);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await load(101)).toBe(false);
    expect(await load(51)).toBe(false);
    resolve(true);
    expect(await first).toBe(true);
    expect(await load(101)).toBe(false);
    expect(await load(51)).toBe(true);
    expect(await load(1)).toBe(false);
    expect(await load(undefined)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not loop after an error or no-progress response, but allows a deliberate retry", async () => {
    const read = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const load = createEarlierPageLoader(read);
    await expect(load(51)).rejects.toThrow("offline");
    expect(await load(51)).toBe(false);
    expect(await load(51, true)).toBe(false);
    expect(await load(51)).toBe(false);
    expect(await load(51, true)).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("bounds automatic loads when successive pages contain just one message", async () => {
    let oldest = 4;
    const read = vi.fn(async () => {
      oldest -= 1;
      return true;
    });
    const load = createEarlierPageLoader(read);
    // A page can be short because the server also caps bytes, not just the count.
    expect(await load(oldest)).toBe(true);
    expect(await load(oldest)).toBe(true);
    expect(await load(oldest)).toBe(true);
    expect(oldest).toBe(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(await load(oldest)).toBe(false);
  });
});

describe("virtualized row state", () => {
  it("keeps a choice draft through unmount and a failed send without updating other rows", () => {
    const store = createRowStateStore<{ text: string; sent: boolean; pending: boolean }>();
    const changed = vi.fn();
    const otherChanged = vi.fn();
    const unsubscribe = store.subscribe("1:pick", changed);
    store.subscribe("2:pick", otherChanged);
    store.set("1:pick", { text: "typed", sent: false, pending: false });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(otherChanged).not.toHaveBeenCalled();
    unsubscribe();
    store.set("1:pick", { text: "typed", sent: true, pending: true });
    expect(store.get("1:pick")).toEqual({ text: "typed", sent: true, pending: true });
    store.set("1:pick", { text: "typed", sent: false, pending: false });
    expect(store.get("1:pick")).toEqual({ text: "typed", sent: false, pending: false });
    expect(store.get("2:pick")).toBeNull();
    store.set("1:pick", null);
    expect(store.get("1:pick")).toBeNull();
  });

  it("ignores an older answer's completion after a newer vote starts", () => {
    const store = createRowStateStore<ChoiceDraft>();
    const first = { choice: ["a"], text: "", against: null, sent: true, pending: true };
    const second = { choice: ["b"], text: "", against: "ack-a", sent: true, pending: true };
    store.set("1:poll", first);
    store.set("1:poll", second);
    completeChoiceDraft(store, "1:poll", first, true, false);
    expect(store.get("1:poll")).toBe(second);
    completeChoiceDraft(store, "1:poll", second, true, false);
    expect(store.get("1:poll")).toEqual({ ...second, pending: false });
  });

  it("allows another vote after the first completed despite an early server update", () => {
    const store = createRowStateStore<ChoiceDraft>();
    const first = { choice: ["a"], text: "", against: null, sent: true, pending: true };
    store.set("1:poll", first);
    completeChoiceDraft(store, "1:poll", first, true, false);
    expect(store.get("1:poll")?.pending).toBe(false);
  });

  it.each([
    [false, false, null],
    [false, true, { sent: false, pending: false }],
    [true, false, { sent: true, pending: false }],
  ])("settles a choice attempt (ok=%s, keepOnFailure=%s)", (ok, keep, expected) => {
    const store = createRowStateStore<ChoiceDraft>();
    const attempt = { choice: ["a"], text: "words", against: null, sent: true, pending: true };
    store.set("1:pick", attempt);
    completeChoiceDraft(store, "1:pick", attempt, ok, keep);
    if (expected === null) expect(store.get("1:pick")).toBeNull();
    else expect(store.get("1:pick")).toMatchObject(expected);
  });

  it("restores expanded pages and collapsed blocks independently when rows remount", () => {
    const expanded = createRowStateStore<boolean>();
    expanded.set("10:0", true);
    expanded.set("10:1", false);
    expect(expanded.get("10:0")).toBe(true);
    expect(expanded.get("10:1")).toBe(false);
    expect(expanded.get("11:0")).toBeNull();
  });
});
