import { describe, expect, it } from "vite-plus/test";

import { BOARDS_READER_LANES, readerLaneOptions, STATEV2_READER_LANES } from "./readerLanes.ts";

describe("readerLaneOptions", () => {
  it("defaults: two statev2 foreground slots, one boards slot, bounded queues and results", () => {
    const statev2 = readerLaneOptions(STATEV2_READER_LANES, {});
    expect(statev2.foregroundReaderSlots).toBe(2);
    expect(statev2.readerQueueLimits).toEqual({ foreground: 128, background: 1024 });
    expect(statev2.foregroundReaderInitializationSql).toEqual(["PRAGMA cache_size = -32768"]);
    expect(statev2.readerMaxResultBytes).toEqual({
      foreground: 256 * 1024 * 1024,
      background: 1024 * 1024 * 1024,
    });
    expect(readerLaneOptions(BOARDS_READER_LANES, {}).foregroundReaderSlots).toBe(1);
  });

  it("0 restores the single shared reader; overrides are bounded", () => {
    expect(
      readerLaneOptions(STATEV2_READER_LANES, { ROBOB_STATEV2_FOREGROUND_READERS: "0" })
        .foregroundReaderSlots,
    ).toBe(0);
    expect(
      readerLaneOptions(BOARDS_READER_LANES, { ROBOB_BOARDS_FOREGROUND_READERS: "0" })
        .foregroundReaderSlots,
    ).toBe(0);
    expect(
      readerLaneOptions(STATEV2_READER_LANES, { ROBOB_STATEV2_FOREGROUND_READERS: "9" })
        .foregroundReaderSlots,
    ).toBe(2);
    expect(
      readerLaneOptions(STATEV2_READER_LANES, { ROBOB_STATEV2_FOREGROUND_READERS: "x" })
        .foregroundReaderSlots,
    ).toBe(2);
    expect(
      readerLaneOptions(STATEV2_READER_LANES, {
        ROBOB_READER_QUEUE_FOREGROUND: "64",
        ROBOB_READER_QUEUE_BACKGROUND: "0",
      }).readerQueueLimits,
    ).toEqual({ foreground: 64, background: 1024 });
  });
});
