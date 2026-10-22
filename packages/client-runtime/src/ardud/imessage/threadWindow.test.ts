// @effect-diagnostics globalDate:off -- Tests exercise local calendar day boundaries.
import { describe, expect, it } from "vite-plus/test";

import { imessageDayKey, imessageEarlierStep, imessageThreadWindowStart } from "./threadWindow.ts";

// Local wall-clock times, since day boundaries follow the viewer's clock.
const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
const threads = (...times: string[]) => times.map((createdAt) => ({ createdAt }));
const NOW = new Date(2026, 9, 21, 12).getTime();

describe("imessageThreadWindowStart", () => {
  it("keeps the newest two threads when the last day was quiet", () => {
    const list = threads(at(10, 9), at(12, 9), at(15, 9), at(18, 9));
    expect(imessageThreadWindowStart(list, NOW, 0)).toBe(2);
  });

  it("keeps every thread from the last 24 hours when there are more than two", () => {
    const list = threads(at(19, 9), at(20, 13), at(20, 18), at(21, 8), at(21, 11));
    expect(imessageThreadWindowStart(list, NOW, 0)).toBe(1);
  });

  it("adds one whole older day per step", () => {
    const list = threads(at(17, 9), at(18, 9), at(18, 20), at(20, 9), at(21, 9));
    expect(imessageThreadWindowStart(list, NOW, 0)).toBe(3);
    expect(imessageThreadWindowStart(list, NOW, 1)).toBe(1);
    expect(imessageThreadWindowStart(list, NOW, 2)).toBe(0);
    expect(imessageThreadWindowStart(list, NOW, 9)).toBe(0);
  });

  it("handles short and empty chats", () => {
    expect(imessageThreadWindowStart([], NOW, 0)).toBe(0);
    expect(imessageThreadWindowStart(threads(at(1, 9)), NOW, 0)).toBe(0);
  });
});

describe("imessageDayKey", () => {
  it("splits on the local calendar day", () => {
    expect(imessageDayKey(at(20, 23))).not.toBe(imessageDayKey(at(21, 0)));
    expect(imessageDayKey(at(21, 0))).toBe(imessageDayKey(at(21, 23)));
  });
});

describe("imessageEarlierStep", () => {
  it("pages a single long session instead of hiding the control", () => {
    expect(imessageEarlierStep({ windowStart: 0, oldestHasMoreHistory: true })).toBe("history");
  });

  it("pages the oldest shown session before widening to older sessions", () => {
    expect(imessageEarlierStep({ windowStart: 3, oldestHasMoreHistory: true })).toBe("history");
    expect(imessageEarlierStep({ windowStart: 3, oldestHasMoreHistory: false })).toBe("sessions");
  });

  it("offers nothing once every session and turn is shown", () => {
    expect(imessageEarlierStep({ windowStart: 0, oldestHasMoreHistory: false })).toBeNull();
  });
});
