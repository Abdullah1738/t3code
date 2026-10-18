import {
  BlockerGroup,
  FeedItem,
  type MissionActor,
  MissionEventId,
  Milestone,
  RoleId,
  SubMission,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ballHolderLine,
  criticalPathView,
  effortNote,
  feedCountsLine,
  foldLaneCounts,
  formatCountdown,
  formatRelative,
  formatTimeOfDay,
  groupBlockers,
  intendedShareLine,
  intendedTotal,
  laneCountsOf,
  moveInOrder,
  needsYouCounts,
  needsYouLine,
  nextMilestone,
  parseShareInput,
  poolUsageView,
  priorityStack,
  rollUpHealth,
  sortLanesProblemsFirst,
  splitFeed,
  splitQuietLanes,
  totalNeedsYou,
  usageView,
} from "./viewModel.ts";

const decodeSubMission = Schema.decodeUnknownSync(SubMission);
const decodeMilestone = Schema.decodeUnknownSync(Milestone);
const decodeFeedItem = Schema.decodeUnknownSync(FeedItem);
const decodeBlockerGroup = Schema.decodeUnknownSync(BlockerGroup);
const decodeEventId = Schema.decodeUnknownSync(MissionEventId);
const decodeRoleId = Schema.decodeUnknownSync(RoleId);

const T0 = "2026-10-17T08:00:00.000Z";
const NOW = Date.parse("2026-10-17T08:33:00.000Z");

const subMission = (id: string, order: number, overrides: Record<string, unknown> = {}) =>
  decodeSubMission({
    id,
    missionId: "m",
    title: id,
    intent: "",
    order,
    fillIdleCapacity: false,
    status: "active",
    coordinatorRoleId: null,
    intendedEffort: null,
    actualEffort: null,
    health: "green",
    lockedFields: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });

const milestone = (id: string, status: string, targetAt: string | null) =>
  decodeMilestone({
    id,
    missionId: "m",
    subMissionId: "s",
    title: id,
    targetAt,
    status,
    statusNote: null,
    itemIds: [],
    createdAt: T0,
    updatedAt: T0,
  });

describe("lane folding", () => {
  it("folds waiting into working and parked into idle for the sidebar line", () => {
    const counts = { working: 7, waiting: 2, stuck: 2, idle: 2, parked: 1 };
    expect(foldLaneCounts(counts).line).toBe("14 lanes: 9 working, 2 stuck, 3 idle");
  });

  it("keeps every status in full mode and drops empty ones", () => {
    const fold = foldLaneCounts({ working: 3, waiting: 1, stuck: 0, idle: 0, parked: 2 }, "full");
    expect(fold.line).toBe("6 lanes: 3 working, 1 waiting, 2 parked");
    expect(fold.parts.map((part) => part.tone)).toEqual(["working", "waiting", "parked"]);
  });

  it("reads naturally for one lane and for none", () => {
    expect(foldLaneCounts({ working: 0, waiting: 0, stuck: 1, idle: 0, parked: 0 }).line).toBe(
      "1 lane: 1 stuck",
    );
    expect(foldLaneCounts({ working: 0, waiting: 0, stuck: 0, idle: 0, parked: 0 }).line).toBe(
      "0 lanes",
    );
  });

  it("counts lanes by status and leaves retired lanes out", () => {
    const counts = laneCountsOf([
      { status: "working" },
      { status: "working" },
      { status: "retired" },
      { status: "stuck" },
    ]);
    expect(counts).toEqual({ working: 2, waiting: 0, stuck: 1, idle: 0, parked: 0 });
  });

  it("orders lanes problems first, then by latest activity", () => {
    const lanes = sortLanesProblemsFirst([
      { name: "b", status: "working" as const, lastActiveAt: "2026-10-17T08:00:00Z" },
      { name: "c", status: "idle" as const, lastActiveAt: "2026-10-17T08:30:00Z" },
      { name: "a", status: "working" as const, lastActiveAt: "2026-10-17T08:20:00Z" },
      { name: "d", status: "stuck" as const, lastActiveAt: null },
    ]);
    expect(lanes.map((lane) => lane.name)).toEqual(["d", "a", "b", "c"]);
  });

  it("splits quiet lanes from the ones worth showing", () => {
    const { active, quiet } = splitQuietLanes([
      { status: "working" as const },
      { status: "parked" as const },
      { status: "idle" as const },
      { status: "retired" as const },
      { status: "waiting" as const },
    ]);
    expect(active.map((lane) => lane.status)).toEqual(["working", "waiting"]);
    expect(quiet.map((lane) => lane.status)).toEqual(["parked", "idle"]);
  });
});

describe("health and needs-you", () => {
  it("rolls up to the worst known health", () => {
    expect(rollUpHealth(["green", "unknown", "amber"])).toBe("amber");
    expect(rollUpHealth(["green", "red", "amber"])).toBe("red");
    expect(rollUpHealth(["unknown"])).toBe("unknown");
    expect(rollUpHealth([])).toBe("unknown");
  });

  it("counts only what waits on the owner in the badge total", () => {
    const counts = needsYouCounts({
      counts: { decide: 2, approve: 1, knocks: 1, suggestions: 4, fyi: 9 },
    });
    expect(counts.total).toBe(4);
    expect(needsYouLine(counts)).toBe("2 decisions, 1 to approve, 1 knock");
    expect(needsYouLine({ decide: 0, approve: 0, knocks: 0 })).toBeNull();
  });

  it("adds every mission's needs-you count for the inbox row", () => {
    expect(totalNeedsYou([{ needsYou: 8 }, { needsYou: 0 }, { needsYou: 3 }])).toBe(11);
    expect(totalNeedsYou([])).toBe(0);
  });
});

describe("blockers", () => {
  const owner = { _tag: "owner" } as const;
  const master = { _tag: "role", roleId: "master" } as never;
  const arch = { _tag: "role", roleId: "arch" } as never;
  const ref = (id: string) => ({ kind: "work-item" as const, id, label: id });

  it("groups by holder, owner first then the biggest pile, deduping repeats", () => {
    const groups = groupBlockers([
      { holder: arch, holderLabel: "arch", item: ref("a1") },
      { holder: master, holderLabel: "master", item: ref("m1") },
      { holder: master, holderLabel: "master", item: ref("m2") },
      { holder: master, holderLabel: "master", item: ref("m1") },
      { holder: owner, holderLabel: "you", item: ref("o1") },
    ]);
    expect(groups.map((group) => [group.holderLabel, group.items.length])).toEqual([
      ["you", 1],
      ["master", 2],
      ["arch", 1],
    ]);
    expect(ballHolderLine(groups)).toBe("you 1 · master 2 · arch 1");
  });

  it("marks critical-path steps someone holds", () => {
    const blockers = [
      decodeBlockerGroup({ holder: master, holderLabel: "master", items: [ref("deploy")] }),
      decodeBlockerGroup({ holder: owner, holderLabel: "Abdullah", items: [ref("stamp")] }),
    ];
    const view = criticalPathView([ref("review"), ref("deploy"), ref("stamp")], blockers);
    expect(view.steps.map((step) => step.heldBy)).toEqual([null, "master", "you"]);
    expect(view.blockedCount).toBe(2);
  });
});

describe("priority stack", () => {
  it("orders open sub-missions and flags effort that drifts from intent", () => {
    const rows = priorityStack([
      subMission("factory", 5, { intendedEffort: 0.05, actualEffort: 0.19 }),
      subMission("wave", 0, { intendedEffort: 0.5, actualEffort: 0.45 }),
      subMission("closed", 1, { status: "closed" }),
      subMission("support", 3, { intendedEffort: 0.1, actualEffort: 0.01 }),
    ]);
    expect(rows.map((row) => [row.subMission.id, row.position, row.drift])).toEqual([
      ["wave", 1, "even"],
      ["support", 2, "under"],
      ["factory", 3, "over"],
    ]);
    expect(effortNote(rows)).toBe("factory (3rd) took 19% of the effort; the plan is 5%.");
  });

  it("stays quiet when effort follows the order", () => {
    const rows = priorityStack([
      subMission("a", 0, { intendedEffort: 0.6, actualEffort: 0.62 }),
      subMission("b", 1),
    ]);
    expect(rows[1]?.drift).toBe("unknown");
    expect(effortNote(rows)).toBeNull();
  });

  it("moves one id to another's slot", () => {
    expect(moveInOrder(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveInOrder(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveInOrder(["a", "b"], "a", "x")).toEqual(["a", "b"]);
  });
});

describe("milestones", () => {
  it("bundles every milestone due at the next open target", () => {
    const monday = "2026-10-19T05:00:00.000Z";
    const summary = nextMilestone([
      milestone("codec", "done", monday),
      milestone("risk", "at-risk", monday),
      milestone("kafka", "on-track", monday),
      milestone("later", "planned", "2026-11-05T00:00:00.000Z"),
      milestone("past", "done", "2026-10-10T00:00:00.000Z"),
      milestone("undated", "planned", null),
    ]);
    expect(summary?.targetAt).toBe(monday);
    expect(summary?.milestones.map((m) => m.id)).toEqual(["codec", "risk", "kafka"]);
    expect([summary?.atRisk, summary?.done, summary?.total]).toEqual([1, 1, 3]);
  });

  it("returns null when nothing open has a date", () => {
    expect(
      nextMilestone([milestone("done", "done", T0), milestone("x", "planned", null)]),
    ).toBeNull();
  });
});

describe("feed and time", () => {
  const item = (kind: string, at: string) =>
    decodeFeedItem({ kind, summary: `${kind} at ${at}`, ref: null, at });

  it("splits the feed at the owner's last look, newest first", () => {
    const feed = [
      item("shipped", "2026-10-17T04:00:00Z"),
      item("decided", "2026-10-17T07:00:00Z"),
      item("shipped", "2026-10-17T06:00:00Z"),
    ];
    const sections = splitFeed(feed, "2026-10-17T05:06:00Z");
    expect(sections.fresh.map((entry) => entry.at)).toEqual([
      "2026-10-17T07:00:00Z",
      "2026-10-17T06:00:00Z",
    ]);
    expect(sections.earlier).toHaveLength(1);
    expect(splitFeed(feed, null).fresh).toHaveLength(3);
    expect(feedCountsLine(feed)).toBe("2 shipped · 1 decided");
  });

  it("formats countdowns to the minute and flags overdue", () => {
    expect(formatCountdown("2026-10-19T05:00:00Z", NOW)).toBe("1d 20h");
    expect(formatCountdown("2026-10-17T13:45:00Z", NOW)).toBe("5h 12m");
    expect(formatCountdown("2026-10-17T09:15:00Z", NOW)).toBe("42m");
    expect(formatCountdown("2026-10-17T08:33:20Z", NOW)).toBe("due now");
    expect(formatCountdown("2026-10-17T05:33:00Z", NOW)).toBe("overdue 3h 0m");
  });

  it("formats relative times", () => {
    expect(formatRelative("2026-10-17T08:32:30Z", NOW)).toBe("just now");
    expect(formatRelative("2026-10-17T08:00:00Z", NOW)).toBe("33m ago");
    expect(formatRelative("2026-10-17T05:06:00Z", NOW)).toBe("3h ago");
    expect(formatRelative("2026-10-15T08:00:00Z", NOW)).toBe("2d ago");
    expect(formatRelative("2026-10-01T08:00:00Z", NOW, "UTC")).toBe("Thu 1 Oct");
    expect(formatTimeOfDay("2026-10-04T15:41:48Z", "UTC")).toBe("15:41");
    expect(formatTimeOfDay("not a time", "UTC")).toBe("");
  });

  it("describes usage against the guaranteed share", () => {
    expect(usageView(0.94)).toEqual({ label: "94% of its share", tone: "normal" });
    expect(usageView(1.24)).toEqual({ label: "Borrowing: 1.2× its share", tone: "borrowing" });
    expect(usageView(null).tone).toBe("unknown");
  });

  it("shows each pool the mission draws on as one compact entry", () => {
    const sampledAt = "2026-10-17T08:16:00.000Z";
    expect(
      poolUsageView(
        { _tag: "accounts", id: "claude", label: "Claude", usable: 20, total: 30, sampledAt },
        NOW,
      ),
    ).toMatchObject({
      value: "20/30",
      tone: "ok",
      detail: "Claude: 20 of 30 usable (read 17m ago)",
    });
    expect(
      poolUsageView(
        { _tag: "accounts", id: "codex", label: "Codex reviews", usable: 1, total: 6, sampledAt },
        NOW,
      ).tone,
    ).toBe("tight");
    expect(
      poolUsageView(
        {
          _tag: "budget",
          id: "offbox",
          label: "Offbox",
          spent: 61.69,
          cap: 500,
          currency: "USD",
          sampledAt,
        },
        NOW,
      ),
    ).toMatchObject({ value: "$62 of $500", tone: "ok" });
    expect(
      poolUsageView(
        {
          _tag: "lock",
          id: "dev",
          label: "Dev env",
          holder: "lane-cell-devops",
          since: sampledAt,
          sampledAt,
        },
        NOW,
      ),
    ).toMatchObject({ value: "held by cell-devops", tone: "held" });
    expect(
      poolUsageView(
        { _tag: "lock", id: "dev", label: "Dev env", holder: null, since: null, sampledAt },
        NOW,
      ).value,
    ).toBe("free");
  });
});

describe("intended effort", () => {
  const change = (id: string, actor: MissionActor, at: string) => ({
    ref: { kind: "sub-mission" as const, id },
    field: "intendedEffort",
    actor,
    eventId: decodeEventId(`evt-${id}`),
    at,
  });

  it("says who changed the share last from the event log, and ignores locks", () => {
    const rows = priorityStack(
      [
        subMission("mine", 0, { intendedEffort: 0.6 }),
        // A stale owner lock means nothing now: the master changed it last.
        subMission("theirs", 1, { intendedEffort: 0.3, lockedFields: ["intendedEffort"] }),
        subMission("imported", 2, { intendedEffort: 0.05 }),
        subMission("unset", 3),
      ],
      [
        change("mine", { _tag: "owner" }, T0),
        change("theirs", { _tag: "role", roleId: decodeRoleId("crpko-master") }, T0),
        { ...change("mine", { _tag: "owner" }, T0), field: "title" },
      ],
    );
    expect(rows.map((row) => intendedShareLine(row, "crpko-master"))).toEqual([
      "last changed by you",
      "last changed by master",
      "not changed since import",
      "no share set",
    ]);
    expect(intendedTotal(rows)).toEqual({ total: 0.95, label: "95% planned", balanced: false });
  });

  it("names whoever set the share in the drift note", () => {
    const rows = priorityStack(
      [subMission("factory", 0, { intendedEffort: 0.05, actualEffort: 0.19 })],
      [change("factory", { _tag: "owner" }, T0)],
    );
    expect(effortNote(rows, "crpko-master")).toBe(
      "factory (1st) took 19% of the effort; you set 5%.",
    );
  });

  it("reads typed shares as percent, fraction, or empty to clear", () => {
    expect(parseShareInput("40")).toEqual({ ok: true, share: 0.4 });
    expect(parseShareInput(" 12.5% ")).toEqual({ ok: true, share: 0.125 });
    expect(parseShareInput("0.4")).toEqual({ ok: true, share: 0.4 });
    expect(parseShareInput("")).toEqual({ ok: true, share: null });
    expect(parseShareInput("140").ok).toBe(false);
    expect(parseShareInput("lots").ok).toBe(false);
  });
});
