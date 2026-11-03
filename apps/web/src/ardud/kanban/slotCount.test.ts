import { describe, expect, it } from "vite-plus/test";

import {
  committedSlots,
  currentSlots,
  editedSlots,
  failedSlot,
  observeSlots,
  sentSlots,
  serialSender,
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
});
