// @effect-diagnostics globalDate:off - Tests build times on the local calendar.
import type {
  MissionId,
  MissionRoomActivity,
  PoolView,
  ReviewRecord,
  RoomActivityRow,
  RoomId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardActivityInput,
  boardFacts,
  boardFigures,
  boardGreeting,
  clockOrDay,
  dayBinHeight,
  dayLine,
  laneBars,
  reviewBudget,
  startOfLocalDay,
  stuckLanes,
} from "./boardViewModel.ts";
import type { InboxEntry } from "./inboxViewModel.ts";
import type { OwnerRequest } from "./source.ts";

// Every time here is local, so the tests hold in any zone the runner uses.
const local = (hour: number, minute = 0, day = 19) => new Date(2026, 9, day, hour, minute);
const iso = (hour: number, minute = 0, day = 19) => local(hour, minute, day).toISOString();
const NOW = local(10).getTime();
const MISSION = "crpko" as MissionId;

const activity = (
  since: Partial<MissionRoomActivity["since"]>,
  rows: ReadonlyArray<RoomActivityRow> = [],
): MissionRoomActivity => ({
  rows,
  since: { messages: 0, masterDecisions: 0, blockerAuthors: 0, ...since },
});

const row = (roomId: string, bins: RoomActivityRow["bins"]): RoomActivityRow => ({
  roomId: roomId as RoomId,
  total: bins.reduce((sum, bin) => sum + bin.blockers + bin.master + bin.other, 0),
  bins,
});

const budgetPool = (capacity: number, inUse: number, unit = "review") =>
  ({ pool: { kind: "budget", unit, capacity }, inUse }) as unknown as PoolView;

function request(overrides: Partial<OwnerRequest>): OwnerRequest {
  return {
    id: "request",
    missionId: MISSION,
    title: "Request",
    status: "waiting",
    messages: [],
    hasOlder: false,
    links: [],
    subject: null,
    unread: false,
    createdAt: iso(8),
    updatedAt: iso(8),
    settledAt: null,
    ...overrides,
  };
}

const review = (createdAt: string, verdict: ReviewRecord["verdict"]) =>
  ({ createdAt, verdict }) as ReviewRecord;

describe("board lead", () => {
  it("greets by the reading device's hour", () => {
    expect(boardGreeting("Crpko", 3, NOW)).toBe("Morning. Crpko has three holds waiting on you.");
    expect(boardGreeting("Crpko", 1, local(14).getTime())).toBe(
      "Afternoon. Crpko has one hold waiting on you.",
    );
    expect(boardGreeting("Crpko", 12, local(20).getTime())).toBe(
      "Evening. Crpko has 12 holds waiting on you.",
    );
    expect(boardGreeting("Crpko", 0, NOW)).toBe("Morning. Nothing in Crpko waits on you.");
  });

  it("greets the owner by first name when the server knows it", () => {
    expect(boardGreeting("Crpko", 3, NOW, "Abdullah Dudhwala")).toBe(
      "Morning, Abdullah. Crpko has three holds waiting on you.",
    );
    expect(boardGreeting("Crpko", 0, NOW, "  ")).toBe("Morning. Nothing in Crpko waits on you.");
  });

  it("reads today from local midnight and tallies from the look", () => {
    expect(boardActivityInput(iso(8, 30), NOW)).toEqual({
      dayStart: local(0).toISOString(),
      since: iso(8, 30),
    });
    expect(boardActivityInput(null, NOW).since).toBeNull();
  });

  it("states the day, the oldest wait and who posted blockers since the look", () => {
    const waiting = [{ record: { createdAt: iso(8, 0, 8) } }] as unknown as InboxEntry[];
    const facts = boardFacts({
      waiting,
      activity: activity({ messages: 5, blockerAuthors: 2 }),
      ownerLastLookedAt: iso(8),
      nowMs: NOW,
    });
    expect(facts.map((fact) => fact.before + fact.strong + fact.after)).toEqual([
      "Mon 19 Oct",
      "The oldest has waited 11d 2h",
      "2 lanes posted blockers since you looked",
    ]);
    const before = { waiting: [], ownerLastLookedAt: null, nowMs: NOW };
    expect(boardFacts({ ...before, activity: activity({ blockerAuthors: 2 }) })).toHaveLength(1);
    expect(boardFacts({ ...before, ownerLastLookedAt: iso(8), activity: undefined })).toHaveLength(
      1,
    );
  });

  it("builds the four figures from requests, lanes, messages since the look and reviews today", () => {
    const figures = boardFigures({
      requests: [
        request({ id: "a", status: "answered", unread: true }),
        request({ id: "b", status: "answered", unread: false }),
        request({ id: "c", status: "waiting" }),
        request({ id: "d", status: "settled", unread: true }),
      ],
      lanes: { working: 17, stuck: 6, waiting: 30, idle: 20, parked: 6 },
      activity: activity({ messages: 3, masterDecisions: 1 }),
      reviews: [
        review(iso(9), "clear"),
        review(iso(8), "blocked"),
        review(iso(23, 0, 18), "clear"),
      ],
      pools: [],
      ownerLastLookedAt: iso(8, 30),
      nowMs: NOW,
    });
    expect(figures).toEqual([
      {
        key: "requests",
        label: "Your requests",
        value: "1",
        unit: "answered",
        note: { text: "1 waiting on the master", alert: false },
      },
      {
        key: "lanes",
        label: "Lanes working",
        value: "17",
        unit: "of 79",
        note: { text: "6 stuck", alert: true },
      },
      {
        key: "since",
        label: "Since 08:30",
        value: "3",
        unit: "messages",
        note: { text: "1 master decision", alert: false },
      },
      {
        key: "reviews",
        label: "Reviews today",
        value: "2",
        unit: null,
        note: { text: "1 blocked", alert: true },
      },
    ]);
  });

  it("labels the since figure by the look: today before the first, its day when older", () => {
    const base = {
      requests: [],
      lanes: { working: 0, stuck: 0, waiting: 0, idle: 0, parked: 0 },
      reviews: [],
      pools: undefined,
      nowMs: NOW,
    };
    const today = boardFigures({
      ...base,
      activity: activity({ messages: 1 }),
      ownerLastLookedAt: null,
    })[2];
    expect([today?.label, today?.value, today?.unit]).toEqual(["Today", "1", "message"]);
    const older = boardFigures({
      ...base,
      activity: activity({ messages: 189 }),
      ownerLastLookedAt: iso(22, 0, 18),
    })[2];
    expect([older?.label, older?.value]).toEqual(["Since Sun 18 Oct", "189"]);
  });

  it("counts reviews against the daily review budget when the mission has one", () => {
    const base = {
      requests: [],
      lanes: { working: 0, stuck: 0, waiting: 0, idle: 0, parked: 0 },
      activity: undefined,
      reviews: [review(iso(9), "clear")],
      ownerLastLookedAt: null,
      nowMs: NOW,
    };
    const capped = boardFigures({ ...base, pools: [budgetPool(8, 3)] })[3];
    expect([capped?.value, capped?.unit]).toEqual(["3", "of 8"]);
    const plain = boardFigures({ ...base, pools: [budgetPool(100, 40, "USD")] })[3];
    expect([plain?.value, plain?.unit]).toEqual(["1", null]);
    expect(reviewBudget([budgetPool(0, 0)])).toBeNull();
  });
});

describe("day line", () => {
  it("names today's rooms busiest first and totals their blockers and master decisions", () => {
    const titles = new Map([
      ["room-delivery", "delivery"],
      ["room-review", "review"],
    ]);
    const line = dayLine({
      rows: [
        row("room-review", [{ index: 96, blockers: 0, master: 0, other: 1 }]),
        row("room-delivery", [
          { index: 108, blockers: 1, master: 1, other: 7 },
          { index: 109, blockers: 0, master: 0, other: 3 },
        ]),
        row("room-quiet", []),
      ],
      roomTitles: titles,
      nowMs: NOW,
    });
    expect(line.minutes).toBe(600);
    expect(line.totals).toEqual({ messages: 13, masterDecisions: 1, blockers: 1 });
    expect(line.strip).toBe(true);
    expect(line.rows.map((entry) => [entry.name, entry.total])).toEqual([
      ["delivery", 12],
      ["review", 1],
    ]);
    expect(line.rows[0]?.bins[0]).toEqual({ index: 108, blockers: 1, master: 1, other: 7 });
  });

  it("drops the strip on a quiet day and keeps hour marks off the strip's end", () => {
    const quiet = dayLine({
      rows: [row("room-toy", [{ index: 100, blockers: 0, master: 0, other: 2 }])],
      roomTitles: new Map([["room-toy", "toy"]]),
      nowMs: NOW,
    });
    expect(quiet.strip).toBe(false);
    expect(quiet.rows.map((entry) => [entry.name, entry.total])).toEqual([["toy", 2]]);
    // At 10:00 the 06:00 mark sits at 60%; at 06:20 it would hang off the end.
    expect(quiet.hours).toEqual([0, 360]);
    expect(
      dayLine({ rows: [], roomTitles: new Map(), nowMs: local(6, 20).getTime() }).hours,
    ).toEqual([0]);
  });

  it("grows a column from 5px for one message to 24px at eleven", () => {
    expect([0, 1, 6, 11, 40].map(dayBinHeight)).toEqual([0, 5, 14.5, 24, 24]);
  });

  it("starts the day at local midnight", () => {
    expect(startOfLocalDay(NOW)).toBe(local(0).getTime());
  });

  it("names a moment today by its clock time and an earlier one by its day", () => {
    expect(clockOrDay(iso(4, 20), NOW)).toBe("04:20");
    expect(clockOrDay(iso(23, 5, 18), NOW)).toBe("Sun 18 Oct");
  });
});

describe("lanes panel", () => {
  it("shows working, waiting, idle and parked as shares of live lanes", () => {
    expect(laneBars({ working: 2, stuck: 1, waiting: 1, idle: 0, parked: 0 })).toEqual([
      { key: "working", label: "Working", count: 2, share: 0.5 },
      { key: "waiting", label: "Waiting", count: 1, share: 0.25 },
      { key: "idle", label: "Idle", count: 0, share: 0 },
      { key: "parked", label: "Parked", count: 0, share: 0 },
    ]);
  });

  it("lists stuck lanes newest first", () => {
    const lanes = [
      { id: "a", status: "stuck", updatedAt: iso(8) },
      { id: "b", status: "working", updatedAt: iso(9) },
      { id: "c", status: "stuck", updatedAt: iso(9) },
    ] as const;
    expect(stuckLanes(lanes).map((entry) => entry.id)).toEqual(["c", "a"]);
  });
});
