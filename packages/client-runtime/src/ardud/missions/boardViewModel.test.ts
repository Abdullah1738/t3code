// @effect-diagnostics globalDate:off - Tests build times on the local calendar.
import type {
  MissionActor,
  MissionEventId,
  MissionId,
  ReviewRecord,
  RoleId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardFacts,
  boardFigures,
  boardGreeting,
  clockOrDay,
  dayBinHeight,
  dayLine,
  laneBars,
  messageKindOf,
  startOfLocalDay,
  stuckLanes,
} from "./boardViewModel.ts";
import type { InboxEntry } from "./inboxViewModel.ts";
import type { MissionTimelineEvent, OwnerRequest } from "./source.ts";

// Every time here is local, so the tests hold in any zone the runner uses.
const local = (hour: number, minute = 0, day = 19) => new Date(2026, 9, day, hour, minute);
const iso = (hour: number, minute = 0, day = 19) => local(hour, minute, day).toISOString();
const NOW = local(10).getTime();
const MISSION = "crpko" as MissionId;
const MASTER = "role-master" as RoleId;

const master: MissionActor = { _tag: "role", roleId: MASTER };
const lane = (laneId: string): MissionActor => ({ _tag: "lane", laneId }) as MissionActor;

let seq = 0;
function posted(
  kind: string,
  at: string,
  actor: MissionActor,
  roomId = "room-delivery",
): MissionTimelineEvent {
  seq += 1;
  return {
    id: `ev-${seq}` as MissionEventId,
    missionId: MISSION,
    seq,
    kind: "message.posted",
    actor,
    provenance: { _tag: "system", component: "missions-router" },
    summary: `${kind} in Delivery: something`,
    subject: null,
    causedBy: null,
    payload: { roomId, seq, deliveries: 1 },
    at,
  } as MissionTimelineEvent;
}

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

  it("reads message kinds from posted events only", () => {
    expect(messageKindOf(posted("blocker", iso(9), lane("a")))).toBe("blocker");
    expect(messageKindOf({ ...posted("decision", iso(9), master), kind: "lane.moved" })).toBeNull();
  });

  it("states the day, the oldest wait and who posted blockers since the look", () => {
    const waiting = [{ record: { createdAt: iso(8, 0, 8) } }] as unknown as InboxEntry[];
    const events = [
      posted("blocker", iso(9), lane("a")),
      posted("blocker", iso(9, 30), lane("a")),
      posted("blocker", iso(9, 40), lane("b")),
      posted("blocker", iso(7), lane("c")),
      posted("status", iso(9, 50), lane("d")),
    ];
    const facts = boardFacts({ waiting, events, ownerLastLookedAt: iso(8), nowMs: NOW });
    expect(facts.map((fact) => fact.before + fact.strong + fact.after)).toEqual([
      "Mon 19 Oct",
      "The oldest has waited 11d 2h",
      "2 lanes posted blockers since you looked",
    ]);
    expect(boardFacts({ waiting: [], events, ownerLastLookedAt: null, nowMs: NOW })).toHaveLength(
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
      events: [
        posted("decision", iso(9), master),
        posted("decision", iso(9, 5), lane("a")),
        posted("status", iso(9, 10), lane("a")),
        posted("decision", iso(7), master),
      ],
      reviews: [
        review(iso(9), "clear"),
        review(iso(8), "blocked"),
        review(iso(23, 0, 18), "clear"),
      ],
      masterRoleId: MASTER,
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

  it("counts from local midnight before the first look, and names an older look by its day", () => {
    const base = {
      requests: [],
      lanes: { working: 0, stuck: 0, waiting: 0, idle: 0, parked: 0 },
      events: [posted("status", iso(1), lane("a")), posted("status", iso(23, 0, 18), lane("a"))],
      reviews: [],
      masterRoleId: MASTER,
      nowMs: NOW,
    };
    const today = boardFigures({ ...base, ownerLastLookedAt: null })[2];
    expect([today?.label, today?.value, today?.unit]).toEqual(["Today", "1", "message"]);
    const older = boardFigures({ ...base, ownerLastLookedAt: iso(22, 0, 18) })[2];
    expect([older?.label, older?.value]).toEqual(["Since Sun 18 Oct", "2"]);
  });
});

describe("day line", () => {
  it("bins today's room messages in 5-minute columns and stacks blockers, master decisions, the rest", () => {
    const titles = new Map([
      ["room-delivery", "delivery"],
      ["room-review", "review"],
    ]);
    const line = dayLine({
      events: [
        posted("blocker", iso(9, 1), lane("a")),
        posted("decision", iso(9, 2), master),
        posted("status", iso(9, 4), lane("a")),
        posted("decision", iso(9, 6), lane("b")),
        posted("status", iso(8), lane("a"), "room-review"),
        posted("status", iso(23, 0, 18), lane("a")),
        { ...posted("status", iso(9), lane("a")), kind: "lane.moved" },
      ],
      roomTitles: titles,
      masterRoleId: MASTER,
      ownerLastLookedAt: iso(8, 30),
      nowMs: NOW,
    });
    expect(line.minutes).toBe(600);
    expect(line.lookedMinute).toBe(510);
    expect(line.hours).toEqual([0, 360]);
    expect(line.totals).toEqual({ messages: 5, masterDecisions: 1, blockers: 1 });
    expect(line.rows.map((row) => [row.name, row.total])).toEqual([
      ["delivery", 4],
      ["review", 1],
    ]);
    expect(line.rows[0]?.bins).toEqual([
      { index: 108, blockers: 1, master: 1, other: 1 },
      { index: 109, blockers: 0, master: 0, other: 1 },
    ]);
  });

  it("puts a look from before today at the start of the axis", () => {
    const input = { events: [], roomTitles: new Map(), masterRoleId: null, nowMs: NOW };
    const line = dayLine({ ...input, ownerLastLookedAt: iso(22, 0, 18) });
    expect(line.lookedMinute).toBe(0);
    expect(line.rows).toEqual([]);
    expect(dayLine({ ...input, ownerLastLookedAt: null }).lookedMinute).toBeNull();
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
