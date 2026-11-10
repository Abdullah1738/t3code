import { describe, expect, it } from "vite-plus/test";

import { ASK_UNDO_MS, createAskSendQueue, heldSecondsLeft } from "./askSendQueue.ts";

function harness() {
  let now = 1_000;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const sent: Array<{ payload: string; leaving: boolean }> = [];
  const changes: Array<string | null> = [];
  const queue = createAskSendQueue<string>({
    now: () => now,
    setTimer: (run, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, run });
      return handle;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
    send: (payload, leaving) => void sent.push({ payload, leaving }),
    onChange: (held) => void changes.push(held?.payload ?? null),
  });
  const advance = (ms: number) => {
    now += ms;
    // A copy: a timer that fires may set another, which must wait for its own time.
    for (const [handle, timer] of Array.from(timers)) {
      if (timer.at <= now) {
        timers.delete(handle);
        timer.run();
      }
    }
  };
  return { queue, sent, changes, advance, timers, now: () => now };
}

describe("createAskSendQueue", () => {
  it("sends a held answer after six seconds", () => {
    const h = harness();
    const held = h.queue.hold("approve q1");
    expect(heldSecondsLeft(held, h.now())).toBe(6);
    h.advance(ASK_UNDO_MS - 1);
    expect(h.sent).toEqual([]);
    expect(heldSecondsLeft(held, h.now())).toBe(1);
    h.advance(1);
    expect(h.sent).toEqual([{ payload: "approve q1", leaving: false }]);
    expect(h.queue.held()).toBeNull();
    expect(h.changes).toEqual(["approve q1", null]);
  });

  it("undo takes the answer back and nothing is sent", () => {
    const h = harness();
    h.queue.hold("approve q1");
    h.advance(3_000);
    expect(h.queue.undo()).toBe("approve q1");
    h.advance(10_000);
    expect(h.sent).toEqual([]);
    expect(h.queue.undo()).toBeNull();
    expect(h.timers.size).toBe(0);
  });

  it("a second answer sends the first at once; only the newest can be undone", () => {
    const h = harness();
    h.queue.hold("approve q1");
    h.advance(2_000);
    h.queue.hold("reject q2");
    expect(h.sent).toEqual([{ payload: "approve q1", leaving: false }]);
    expect(h.queue.undo()).toBe("reject q2");
    h.advance(10_000);
    expect(h.sent).toHaveLength(1);
  });

  it("flushes with `leaving` when the page goes away", () => {
    const h = harness();
    h.queue.hold("approve q1");
    h.queue.flush(true);
    expect(h.sent).toEqual([{ payload: "approve q1", leaving: true }]);
    h.advance(10_000);
    expect(h.sent).toHaveLength(1);
    h.queue.flush(true);
    expect(h.sent).toHaveLength(1);
  });
});
