import { describe, expect, it } from "vite-plus/test";

import {
  committedSlots,
  currentSlots,
  editedSlots,
  failedSlot,
  observeSlots,
  poolSlotsPending,
  poolSlotsVersion,
  sendPoolSlots,
  sentSlots,
  serialSender,
  subscribePoolSlots,
  type SlotWrites,
} from "./slotCount";

describe("committedSlots", () => {
  it("accepts whole counts without an upper cap", () => {
    expect(committedSlots("12", 5, 0)).toBe(12);
    expect(committedSlots(" 0012 ", 5, 0)).toBe(12);
    expect(committedSlots("250", 5, 0)).toBe(250);
  });

  it("keeps the current count for invalid or unchanged input", () => {
    expect(committedSlots("", 5, 0)).toBeNull();
    expect(committedSlots("abc", 5, 0)).toBeNull();
    expect(committedSlots("3.5", 5, 0)).toBeNull();
    expect(committedSlots("-2", 5, 0)).toBeNull();
    expect(committedSlots("99999999999999999999", 5, 0)).toBeNull();
    expect(committedSlots("5", 5, 0)).toBeNull();
  });

  it("clamps to the supplied bounds", () => {
    expect(committedSlots("0", 3, 1)).toBe(1);
    expect(committedSlots("4", 0, 0, 0)).toBeNull();
  });

  it("does not restore an untouched draft after another client changes the pool", () => {
    expect(editedSlots("5", false, 0, 0)).toBeNull();
    expect(editedSlots("5", true, 0, 0)).toBe(5);
    expect(editedSlots("12", true, 0, 0)).toBe(12);
    expect(editedSlots("12", true, 12, 0)).toBeNull();
    expect(editedSlots("abc", true, 0, 0)).toBeNull();
  });

  it("preserves the latest count when the feed acknowledges an earlier write", () => {
    const initial = { feed: 5, sent: [] };
    const first = sentSlots(initial, { id: 1, value: 12 });
    const second = sentSlots(first, { id: 2, value: currentSlots(first) + 1 });
    const intermediate = observeSlots(second, 12);
    expect(currentSlots(intermediate) + 1).toBe(14);
    const third = sentSlots(intermediate, { id: 3, value: 14 });
    expect(currentSlots(observeSlots(third, 13))).toBe(14);
    expect(currentSlots(observeSlots(third, 14))).toBe(14);
  });

  it("retires every write a coalesced feed covers, then follows a real change", () => {
    const sent = [12, 13, 12].reduce(
      (state, value, index) => sentSlots(state, { id: index + 1, value }),
      { feed: 5, sent: [] } as SlotWrites,
    );
    const coalesced = observeSlots(sent, 12);
    expect(coalesced.sent).toEqual([]);
    const remote = observeSlots(coalesced, 13);
    expect(currentSlots(remote)).toBe(13);
    expect(currentSlots(remote) + 1).toBe(14);
  });

  it("adopts an unrelated feed change and removes failed writes", () => {
    const initial = { feed: 5, sent: [] };
    const pending = sentSlots(sentSlots(initial, { id: 1, value: 12 }), {
      id: 2,
      value: 13,
    });
    expect(currentSlots(observeSlots(pending, 7))).toBe(7);
    expect(currentSlots(failedSlot(pending, 2))).toBe(12);
    expect(currentSlots(failedSlot(pending, 1))).toBe(13);
    expect(currentSlots(failedSlot(failedSlot(pending, 1), 2))).toBe(5);
  });
});

describe("serialSender", () => {
  it("saves one count at a time, newest pending wins", async () => {
    const calls: number[] = [];
    const dropped: number[] = [];
    const resolve: Array<(result: boolean | void) => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let state: SlotWrites = { feed: 5, sent: [] };
    const sender = serialSender(
      (value) => {
        calls.push(value);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        return new Promise<boolean | void>((done) => {
          resolve.push((result) => {
            inFlight--;
            done(result);
          });
        });
      },
      (id) => {
        dropped.push(id);
        state = failedSlot(state, id);
      },
    );
    const send = (id: number, value: number) => {
      state = sentSlots(state, { id, value });
      sender(id, value);
    };

    send(1, 12);
    send(2, 13);
    send(3, 14);
    expect(calls).toEqual([12]);
    expect(dropped).toEqual([2]);
    expect(state.sent).toEqual([
      { id: 1, value: 12 },
      { id: 3, value: 14 },
    ]);
    expect(currentSlots(observeSlots(state, 12))).toBe(14);

    resolve[0]!(true);
    await Promise.resolve();
    expect(calls).toEqual([12, 14]);
    expect(maxInFlight).toBe(1);
    resolve[1]!(true);
    await Promise.resolve();
    expect(inFlight).toBe(0);
  });

  it("continues with the queued count after a failed write", async () => {
    const calls: number[] = [];
    const dropped: number[] = [];
    let finishFirst!: (result: boolean) => void;
    let state: SlotWrites = { feed: 5, sent: [] };
    const sender = serialSender(
      (value) => {
        calls.push(value);
        return value === 12 ? new Promise<boolean>((resolve) => (finishFirst = resolve)) : true;
      },
      (id) => {
        dropped.push(id);
        state = failedSlot(state, id);
      },
    );
    state = sentSlots(state, { id: 1, value: 12 });
    sender(1, 12);
    state = sentSlots(state, { id: 2, value: 13 });
    sender(2, 13);
    expect(calls).toEqual([12]);

    finishFirst(false);
    await Promise.resolve();
    expect(calls).toEqual([12, 13]);
    expect(dropped).toEqual([1]);
    expect(state.sent).toEqual([{ id: 2, value: 13 }]);
    await Promise.resolve();
  });

  it("continues after a rejected write", async () => {
    const calls: number[] = [];
    const dropped: number[] = [];
    let rejectFirst!: (error: Error) => void;
    const sender = serialSender(
      (value) => {
        calls.push(value);
        return value === 12
          ? new Promise<boolean>((_resolve, reject) => (rejectFirst = reject))
          : true;
      },
      (id) => dropped.push(id),
    );
    sender(1, 12);
    sender(2, 13);

    rejectFirst(new Error("failed"));
    await Promise.resolve();
    expect(calls).toEqual([12, 13]);
    expect(dropped).toEqual([1]);
    await Promise.resolve();
  });

  it("keeps the newest queued count across Settings remounts", async () => {
    const calls: number[] = [];
    const saved: number[] = [];
    const resolvers: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    let oldView: SlotWrites = { feed: 5, sent: [] };
    let newView: SlotWrites = { feed: 5, sent: [] };
    const write = (value: number) => {
      calls.push(value);
      maxActive = Math.max(maxActive, ++active);
      return new Promise<boolean>((resolve) => {
        resolvers.push(() => {
          saved.push(value);
          active--;
          resolve(true);
        });
      });
    };
    const oldStepper = (id: number, value: number) => {
      oldView = sentSlots(oldView, { id, value });
      sendPoolSlots("board-remount", "pool", value, write, () => {
        oldView = failedSlot(oldView, id);
      });
    };
    const newStepper = (id: number, value: number) => {
      newView = sentSlots(newView, { id, value });
      sendPoolSlots("board-remount", "pool", value, write, () => {
        newView = failedSlot(newView, id);
      });
    };

    oldStepper(1, 12);
    oldStepper(2, 13);
    newStepper(1, 14);
    expect(calls).toEqual([12]);
    expect(oldView.sent).toEqual([{ id: 1, value: 12 }]);
    expect(newView.sent).toEqual([{ id: 1, value: 14 }]);
    resolvers[0]!();
    await Promise.resolve();
    expect(calls).toEqual([12, 14]);
    expect(maxActive).toBe(1);
    resolvers[1]!();
    await Promise.resolve();
    expect(saved).toEqual([12, 14]);
    expect(active).toBe(0);
  });

  it("lets a pause supersede a queued Stepper count", async () => {
    const calls: number[] = [];
    const saved: number[] = [];
    const resolvers: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    let state: SlotWrites = { feed: 5, sent: [] };
    const write = (value: number) => {
      calls.push(value);
      maxActive = Math.max(maxActive, ++active);
      return new Promise<boolean>((resolve) => {
        resolvers.push(() => {
          saved.push(value);
          active--;
          resolve(true);
        });
      });
    };
    const stepper = (id: number, value: number) => {
      state = sentSlots(state, { id, value });
      sendPoolSlots("board-pause", "pool", value, write, () => {
        state = failedSlot(state, id);
      });
    };

    stepper(1, 12);
    stepper(2, 13);
    sendPoolSlots("board-pause", "pool", 0, write);
    expect(calls).toEqual([12]);
    expect(state.sent).toEqual([{ id: 1, value: 12 }]);
    resolvers[0]!();
    await Promise.resolve();
    expect(calls).toEqual([12, 0]);
    expect(maxActive).toBe(1);
    resolvers[1]!();
    await Promise.resolve();
    expect(saved).toEqual([12, 0]);
    expect(active).toBe(0);
  });

  it("keeps level changes blocked until the queued pause has saved", async () => {
    const board = "board-pause-before-level";
    const pool = "high";
    const calls: number[] = [];
    const resolvers: Array<() => void> = [];
    let saved = 5;
    const versions: number[] = [];
    const unsubscribe = subscribePoolSlots(() => versions.push(poolSlotsVersion()));
    const write = (value: number) => {
      calls.push(value);
      return new Promise<boolean>((resolve) => {
        resolvers.push(() => {
          saved = value;
          resolve(true);
        });
      });
    };

    sendPoolSlots(board, pool, 12, write);
    sendPoolSlots(board, pool, 0, write);
    expect(poolSlotsPending(board, pool)).toBe(true);
    expect(poolSlotsPending(board, "another-pool")).toBe(false);
    expect(calls).toEqual([12]);
    expect(versions).toHaveLength(1);

    resolvers[0]!();
    await Promise.resolve();
    expect(poolSlotsPending(board, pool)).toBe(true);
    expect(calls).toEqual([12, 0]);
    expect(versions).toHaveLength(1);

    resolvers[1]!();
    await Promise.resolve();
    expect(poolSlotsPending(board, pool)).toBe(false);
    expect(saved).toBe(0);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toBeGreaterThan(versions[0]!);
    unsubscribe();
  });

  it("keeps independent boards and pools independent", async () => {
    const calls: string[] = [];
    const resolvers: Array<() => void> = [];
    const write = (label: string) => (value: number) => {
      calls.push(`${label}:${value}`);
      return new Promise<boolean>((resolve) => resolvers.push(() => resolve(true)));
    };

    sendPoolSlots("board-a", "pool-a", 12, write("a"));
    sendPoolSlots("board-a", "pool-a", 13, write("a"));
    sendPoolSlots("board-a", "pool-b", 2, write("b"));
    sendPoolSlots("board-b", "pool-a", 3, write("c"));
    expect(calls).toEqual(["a:12", "b:2", "c:3"]);
    resolvers[0]!();
    await Promise.resolve();
    expect(calls).toEqual(["a:12", "b:2", "c:3", "a:13"]);
    resolvers[1]!();
    resolvers[2]!();
    resolvers[3]!();
    await Promise.resolve();
  });

  it("uses the new write callback after a remount", async () => {
    const calls: string[] = [];
    let finishFirst!: () => void;
    sendPoolSlots("board-callback", "pool", 12, (value) => {
      calls.push(`old:${value}`);
      return new Promise<boolean>((resolve) => (finishFirst = () => resolve(true)));
    });
    sendPoolSlots("board-callback", "pool", 13, (value) => {
      calls.push(`new:${value}`);
      return true;
    });
    finishFirst();
    await Promise.resolve();
    expect(calls).toEqual(["old:12", "new:13"]);
    await Promise.resolve();
  });

  it("keeps the newest write when dropping a queued write sends another", async () => {
    const calls: number[] = [];
    const dropped: number[] = [];
    let finishFirst!: () => void;
    const sender = serialSender(
      (value) => {
        calls.push(value);
        return value === 12
          ? new Promise<boolean>((resolve) => (finishFirst = () => resolve(true)))
          : true;
      },
      (id) => {
        dropped.push(id);
        if (id === 2) sender(4, 15);
      },
    );
    sender(1, 12);
    sender(2, 13);
    sender(3, 14);
    expect(dropped).toEqual([2, 3]);
    finishFirst();
    await Promise.resolve();
    expect(calls).toEqual([12, 15]);
    await Promise.resolve();
  });
});
