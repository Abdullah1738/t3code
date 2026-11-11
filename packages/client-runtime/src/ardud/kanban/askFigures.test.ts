import type { KanbanAskFeed, KanbanAskFeedItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  askFiguresAsOf,
  askHistoryFigures,
  askListEmptyLine,
  askQueueFigures,
  askRowFigure,
} from "./askFigures.ts";

const READ_AT = "2026-11-11T17:42:00.000";
const NOW = Date.parse("2026-11-11T18:00:00.000");
const feed = { at: READ_AT, open: [], closed: [] } as unknown as KanbanAskFeed;
const NONE: ReadonlyArray<KanbanAskFeedItem> = [];
const OFFLINE = "Not connected to Robob.";

/** The store before anything was read. */
const fresh = {
  feed: null,
  status: "idle",
  error: null,
  closed: null,
  closedStatus: "idle",
  closedAt: null,
  closedError: null,
} as const;

describe("askQueueFigures", () => {
  it("are unknown, with nothing failed, until the first read comes back", () => {
    expect(askQueueFigures(fresh)).toEqual({ state: "unknown", failed: false, error: null });
    expect(askQueueFigures({ ...fresh, status: "loading" })).toEqual({
      state: "unknown",
      failed: false,
      error: null,
    });
  });

  it("are unknown and failed when the first read failed or there is no connection", () => {
    expect(askQueueFigures({ ...fresh, status: "error", error: OFFLINE })).toEqual({
      state: "unknown",
      failed: true,
      error: OFFLINE,
    });
    expect(askQueueFigures({ ...fresh, status: "error" })).toEqual({
      state: "unknown",
      failed: true,
      error: "Couldn't load asks.",
    });
    // Retry is out again after a failure: still nothing to show a number from.
    expect(askQueueFigures({ ...fresh, status: "loading", error: OFFLINE }).state).toBe("unknown");
  });

  it("are known once read, zero included", () => {
    expect(askQueueFigures({ feed, status: "ready", error: null })).toEqual({ state: "known" });
  });

  it("are stale, with the time they were read, when a later read fails", () => {
    expect(askQueueFigures({ feed, status: "ready", error: OFFLINE })).toEqual({
      state: "stale",
      readAt: READ_AT,
      error: OFFLINE,
    });
  });
});

describe("askHistoryFigures", () => {
  const queueRead = { feed, status: "ready", error: null } as const;
  const historyRead = {
    ...queueRead,
    closed: NONE,
    closedStatus: "ready",
    closedAt: READ_AT,
    closedError: null,
  } as const;

  it("are unknown while the first read of History is out, whatever the queue holds", () => {
    expect(askHistoryFigures(fresh)).toEqual({ state: "unknown", failed: false, error: null });
    for (const closedStatus of ["idle", "loading"] as const) {
      expect(askHistoryFigures({ ...fresh, ...queueRead, closedStatus })).toEqual({
        state: "unknown",
        failed: false,
        error: null,
      });
    }
  });

  it("are unknown and failed when History's read failed and nothing is held", () => {
    expect(
      askHistoryFigures({
        ...fresh,
        ...queueRead,
        closedStatus: "error",
        closedError: "Robob failed.",
      }),
    ).toEqual({ state: "unknown", failed: true, error: "Robob failed." });
    expect(askHistoryFigures({ ...fresh, ...queueRead, closedStatus: "error" })).toEqual({
      state: "unknown",
      failed: true,
      error: "Couldn't load History.",
    });
  });

  it("are unknown and failed with no connection: never a loading state that can't end", () => {
    // The first launch with no server: the queue's read failed, History's never started.
    expect(askHistoryFigures({ ...fresh, status: "error", error: OFFLINE })).toEqual({
      state: "unknown",
      failed: true,
      error: OFFLINE,
    });
    // The store leaves History "idle" when it is not connected: that is not "loading" here.
    expect(
      askHistoryFigures({ ...fresh, status: "error", error: OFFLINE, closedError: OFFLINE }),
    ).toEqual({ state: "unknown", failed: true, error: OFFLINE });
    // The queue was read once and the connection is gone since: History can't be read either.
    expect(askHistoryFigures({ ...fresh, feed, status: "ready", error: OFFLINE })).toEqual({
      state: "unknown",
      failed: true,
      error: OFFLINE,
    });
  });

  it("are known when both reads are, zero included", () => {
    expect(askHistoryFigures(historyRead)).toEqual({ state: "known" });
  });

  it("are stale, with the time History was read, when it can't be read again", () => {
    expect(askHistoryFigures({ ...historyRead, closedError: "Robob failed." })).toEqual({
      state: "stale",
      readAt: READ_AT,
      error: "Robob failed.",
    });
    // The queue can't be reached: what History holds is not current either.
    const earlier = "2026-11-11T16:00:00.000";
    expect(askHistoryFigures({ ...historyRead, closedAt: earlier, error: OFFLINE })).toEqual({
      state: "stale",
      readAt: earlier,
      error: OFFLINE,
    });
  });
});

describe("askFiguresAsOf", () => {
  it("names the time held figures were read, and nothing for current or unknown ones", () => {
    expect(askFiguresAsOf({ state: "stale", readAt: READ_AT, error: OFFLINE }, NOW)).toBe(
      "as of 17:42",
    );
    expect(
      askFiguresAsOf({ state: "stale", readAt: "2026-11-10T09:05:00.000", error: OFFLINE }, NOW),
    ).toBe("as of yesterday 09:05");
    expect(askFiguresAsOf({ state: "stale", readAt: "", error: OFFLINE }, NOW)).toBe(
      "as of the last read",
    );
    expect(askFiguresAsOf({ state: "known" }, NOW)).toBeNull();
    expect(askFiguresAsOf({ state: "unknown", failed: false, error: null }, NOW)).toBeNull();
    expect(askFiguresAsOf({ state: "unknown", failed: true, error: OFFLINE }, NOW)).toBeNull();
  });
});

describe("the count on a Needs-you row", () => {
  const LOADING = { state: "unknown", failed: false, error: null } as const;
  const FAILED = { state: "unknown", failed: true, error: OFFLINE } as const;
  const KNOWN = { state: "known" } as const;
  const STALE = { state: "stale", readAt: READ_AT, error: OFFLINE } as const;

  it("does not look like a known zero while the first read is out", () => {
    // The count passed in is what an empty store adds up to: it must not decide anything.
    expect(askRowFigure(LOADING, 0, NOW)).toEqual({
      count: null,
      note: "…",
      label: "Loading asks",
    });
  });

  it("says Not loaded after a failed first read", () => {
    expect(askRowFigure(FAILED, 0, NOW)).toEqual({
      count: null,
      note: "Not loaded",
      label: "Asks not loaded",
    });
  });

  it("shows a known count, and nothing at all for a known zero", () => {
    expect(askRowFigure(KNOWN, 3, NOW)).toEqual({
      count: 3,
      note: null,
      label: "3 asks to answer",
    });
    expect(askRowFigure(KNOWN, 1, NOW).label).toBe("1 ask to answer");
    expect(askRowFigure(KNOWN, 0, NOW)).toEqual({
      count: null,
      note: null,
      label: "0 asks to answer",
    });
  });

  it("marks a held count with the time it was read, a held zero too", () => {
    expect(askRowFigure(STALE, 3, NOW)).toEqual({
      count: 3,
      note: "as of 17:42",
      label: "3 asks to answer, as of 17:42, may be out of date",
    });
    expect(askRowFigure(STALE, 0, NOW)).toEqual({
      count: null,
      note: "as of 17:42",
      label: "0 asks to answer, as of 17:42, may be out of date",
    });
  });
});

describe("what an empty list of asks says", () => {
  it("nothing while the first read is out", () => {
    expect(askListEmptyLine({ state: "unknown", failed: false, error: null }, NOW)).toBeNull();
  });

  it("that the asks couldn't be loaded after a failed first read, never No asks", () => {
    expect(askListEmptyLine({ state: "unknown", failed: true, error: OFFLINE }, NOW)).toBe(
      "Couldn't load asks",
    );
  });

  it("No asks for a read that came back, with its time when it is held", () => {
    expect(askListEmptyLine({ state: "known" }, NOW)).toBe("No asks");
    expect(askListEmptyLine({ state: "stale", readAt: READ_AT, error: OFFLINE }, NOW)).toBe(
      "No asks, as of 17:42",
    );
  });
});
