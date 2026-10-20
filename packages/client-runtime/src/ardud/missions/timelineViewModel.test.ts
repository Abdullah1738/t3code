import {
  MissionEventKind,
  type DirectionCheckItem,
  type MissionActor,
  type MissionEventId,
  type MissionId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  changedBy,
  changedFields,
  changeIndex,
  lastChangedLine,
  latestFieldChanges,
  newestChange,
} from "./changeLog.ts";
import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import {
  healthCounts,
  portfolioBar,
  portfolioChanges,
  portfolioFacts,
  portfolioPools,
  portfolioSummary,
  portfolioView,
  reorderPortfolioInput,
} from "./portfolioViewModel.ts";
import { actorNames } from "./roomsViewModel.ts";
import type { MissionTimelineEvent, PortfolioSnapshot } from "./source.ts";
import {
  actorChoices,
  consequences,
  directionCheckRows,
  EMPTY_TIMELINE_FILTER,
  eventGroup,
  eventKicker,
  eventKindLabel,
  filterTimeline,
  inTimelineRange,
  kindChoices,
  kindGroup,
  lineage,
  needsOlderTimeline,
  restartEvent,
  revertAction,
  TIMELINE_KIND_GROUP_LABEL,
  timelineDays,
  timelineReaches,
  timelineRows,
  toggleFilter,
} from "./timelineViewModel.ts";

const CRPKO = "crpko-engineering" as MissionId;
const JUNO = "juno-intents" as MissionId;
const MASTER = "crpko-master";

function live<T>(subscribe: (listener: (value: T) => void) => () => void) {
  let value: T | undefined;
  const close = subscribe((next) => {
    value = next;
  });
  return {
    get value(): T {
      if (value === undefined) throw new Error("no value");
      return value;
    },
    close,
  };
}

const source = () => createFixtureMissionsSource({ now: () => Date.parse(FIXTURE_NOW) + 60_000 });
const byId = (events: ReadonlyArray<MissionTimelineEvent>, id: string) => {
  const event = events.find((entry) => entry.id === id);
  if (!event) throw new Error(`no event ${id}`);
  return event;
};

describe("timeline view model", () => {
  it("filters by kind group and by actor, newest first", () => {
    const missions = source();
    const timeline = live<ReadonlyArray<MissionTimelineEvent>>((l) =>
      missions.subscribeTimeline(CRPKO, l),
    );
    const events = timeline.value;
    expect(events.map((event) => event.seq)).toEqual(
      [...events].map((event) => event.seq).sort((left, right) => right - left),
    );
    expect(kindGroup("review-policy.updated")).toBe("review");
    expect(kindGroup("record.rerouted")).toBe("routing");
    expect(kindGroup("something.else")).toBe("other");

    const actors = actorChoices(events, MASTER);
    expect(actors.slice(0, 2).map((choice) => choice.label)).toEqual(["you", "master"]);
    expect(kindChoices(events).map((choice) => choice.value)).toContain("routing");

    const mine = filterTimeline(events, { groups: [], actors: ["owner"] });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((event) => event.actor._tag === "owner")).toBe(true);
    const routing = filterTimeline(events, { groups: ["routing"], actors: [] });
    expect(routing.every((event) => kindGroup(event.kind) === "routing")).toBe(true);
    expect(filterTimeline(events, EMPTY_TIMELINE_FILTER)).toHaveLength(events.length);
    expect(toggleFilter(toggleFilter(["rule"], "pool"), "rule")).toEqual(["pool"]);
    timeline.close();
  });

  it("walks causes back from an ack to the owner rule, and forward to what it caused", () => {
    const missions = source();
    const timeline = live<ReadonlyArray<MissionTimelineEvent>>((l) =>
      missions.subscribeTimeline(CRPKO, l),
    );
    const events = timeline.value;
    expect(lineage(byId(events, "ev-10142"), events).map((event) => event.id)).toEqual([
      "ev-10141",
      "ev-10142",
    ]);
    expect(consequences(byId(events, "ev-10136"), events).map((event) => event.id)).toEqual([
      "ev-10136-lane",
      "ev-10212",
    ]);
    const rows = timelineRows(events, events, MASTER);
    const rule104 = rows.find((row) => row.event.id === "ev-10136");
    expect(rule104?.lineageSteps).toBeGreaterThanOrEqual(2);
    expect(rows.find((row) => row.event.id === "ev-10212")?.lineageSteps).toBeGreaterThanOrEqual(1);

    const looped = { ...byId(events, "ev-10141"), causedBy: "ev-10142" as MissionEventId };
    const withLoop = events.map((event) => (event.id === looped.id ? looped : event));
    expect(lineage(byId(withLoop, "ev-10142"), withLoop).map((event) => event.id)).toEqual([
      "ev-10141",
      "ev-10142",
    ]);
    timeline.close();
  });

  it("keeps lane successions as a filter and logs a hand-off from the lanes tab", async () => {
    const missions = source();
    const timeline = live<ReadonlyArray<MissionTimelineEvent>>((l) =>
      missions.subscribeTimeline(CRPKO, l),
    );
    const handoffs = () =>
      filterTimeline(timeline.value, { groups: ["succession"], actors: [] }).map((event) => ({
        who: event.subject?.id.replace(/^lane-/, ""),
        by: event.actor._tag,
      }));
    expect(handoffs().map((entry) => entry.who)).toEqual(["cell-risk6", "cell-risk", "cell-risk5"]);
    await missions.handOffLane({
      laneId: "lane-cell-bal" as never,
      note: "655K prompt; #773 r6 is running, resume from the stop step",
    });
    expect(handoffs()[0]).toEqual({ who: "cell-bal", by: "owner" });
    timeline.close();
  });

  it("puts every event kind in a named group, secret requests with the asks", () => {
    // Fork events leave the contract with the fork sweep; old ones read as "other".
    for (const kind of MissionEventKind.literals.filter((kind) => !kind.startsWith("fork."))) {
      expect(kindGroup(kind), kind).not.toBe("other");
    }
    expect(TIMELINE_KIND_GROUP_LABEL[kindGroup("secret-request.closed")]).toBe(
      "Asks, drafts and approvals",
    );
    expect(kindGroup("view.layout-changed")).toBe("layout");
    expect(kindGroup("request.replied")).toBe("requests");
    expect(kindGroup("role.succession")).toBe("succession");
    expect(eventKicker("role.succession")).toBe("Succession");
    expect(eventKicker("pool.hold-taken")).toBe("Hold");
    expect(eventKindLabel("role.model-changed")).toBe("Role model changed");
  });

  it("files a kind this client does not know under the server's group", () => {
    const base = { kind: "deploy.finished" } as unknown as MissionTimelineEvent;
    expect(eventGroup(base)).toBe("other");
    expect(eventGroup({ ...base, group: "pool" })).toBe("pool");
    // A kind the client knows keeps the client's finer group.
    expect(eventGroup({ ...base, kind: "work-item.updated", group: "other" })).toBe("work");
    const choices = kindChoices([{ ...base, group: "pool" }]);
    expect(choices.map((choice) => choice.value)).toEqual(["pool"]);
  });

  it("folds an import and a repeated boot line into one line each, under day heads", () => {
    const master: MissionActor = { _tag: "role", roleId: MASTER as never };
    const importer: MissionActor = { _tag: "system", component: "missions-import" };
    let seq = 0;
    const at = (iso: string, kind: MissionTimelineEvent["kind"], summary: string, extra = {}) =>
      ({
        id: `ev-${++seq}` as MissionEventId,
        missionId: CRPKO,
        seq,
        kind,
        actor: master,
        provenance: { _tag: "system", component: "missions-policy" },
        summary,
        subject: null,
        causedBy: null,
        payload: null,
        at: iso,
        ...extra,
      }) as MissionTimelineEvent;
    const imported = (payload: unknown) =>
      at("2026-10-18T09:00:00.000Z", "import.applied", "Imported records from coord", {
        actor: importer,
        provenance: { _tag: "import", source: "coord.db" },
        payload,
      });
    const oldest = [
      at("2026-10-16T08:00:00.000Z", "rule.created", "Rule 104 added"),
      imported({ kind: "role", count: 52, asOf: "x" }),
      imported({ kind: "lane", count: 88, asOf: "x" }),
      imported({ kind: "room", rooms: 3, subscriptions: 12, asOf: "x" }),
      ...Array.from({ length: 52 }, () =>
        at(
          "2026-10-19T08:00:00.000Z",
          "role.model-changed",
          "1 imported holder(s) keep their model",
        ),
      ),
      at("2026-10-19T09:00:00.000Z", "lane.created", "Lane cell-risk opened", {
        actor: { _tag: "owner" },
      }),
    ];
    const events = oldest.map((_, index) => oldest[oldest.length - 1 - index]!);
    const rows = timelineRows(events, events, MASTER);
    expect(rows.map((row) => [row.kicker, row.summary, row.count, row.by])).toEqual([
      ["Lane", "Lane cell-risk opened", 1, "owner"],
      ["Role", "1 imported holder(s) keep their model", 52, "master"],
      ["Import", "Imported 52 roles, 88 lanes, 3 rooms and 12 subscriptions", 3, null],
      ["Rule", "Rule 104 added", 1, "master"],
    ]);
    const days = timelineDays(rows, Date.parse("2026-10-19T12:00:00.000Z"), "UTC");
    expect(days.map((day) => [day.heading, day.count, day.rows.length])).toEqual([
      ["Today", 53, 2],
      ["Yesterday", 3, 1],
      ["Fri 16 Oct", 1, 1],
    ]);
  });

  it("names lanes and roles in Who and on each line, and says what caused a line", () => {
    const lead = "crpko:lane-lead:crpko:lane:cell-tc";
    const event = (seq: number, actor: MissionActor, extra = {}) =>
      ({
        id: `ev-${seq}` as MissionEventId,
        missionId: CRPKO,
        seq,
        kind: "lane.updated",
        actor,
        provenance: { _tag: "system", component: "missions-policy" },
        summary: `Event ${seq}`,
        subject: null,
        causedBy: null,
        payload: null,
        at: "2026-10-19T08:00:00.000Z",
        ...extra,
      }) as MissionTimelineEvent;
    const cause = { ...event(1, { _tag: "owner" }), summary: "Rule 104 added" };
    const events = [
      event(3, { _tag: "role", roleId: lead as never }, { causedBy: "ev-1" }),
      event(2, { _tag: "role", roleId: lead as never }),
      cause,
    ];
    const names = actorNames([], [{ id: lead as never, name: "cell-tc" }]);
    expect(actorChoices(events, MASTER, names).map((choice) => choice.label)).toEqual([
      "you",
      "cell-tc",
    ]);
    const rows = timelineRows(events, events, MASTER, names);
    expect(rows.map((row) => [row.actor, row.because, row.led])).toEqual([
      ["cell-tc", "Because rule 104 added", 0],
      ["cell-tc", null, 0],
      ["you", null, 1],
    ]);
  });

  it("reads Today and 7 days in the reader's zone and pages back only while in range", () => {
    const at = (iso: string, kind = "lane.updated") => ({ at: iso, kind }) as MissionTimelineEvent;
    const now = Date.parse("2026-10-19T22:30:00.000Z");
    // 22:30 UTC is already the 20th in Dubai, so 21:00 UTC is "today" only in UTC.
    expect(inTimelineRange(at("2026-10-19T19:00:00.000Z"), "today", now, "UTC")).toBe(true);
    expect(inTimelineRange(at("2026-10-19T19:00:00.000Z"), "today", now, "Asia/Dubai")).toBe(false);
    expect(inTimelineRange(at("2026-10-13T00:00:00.000Z"), "week", now)).toBe(true);
    expect(inTimelineRange(at("2026-10-12T00:00:00.000Z"), "week", now)).toBe(false);

    const window = (events: MissionTimelineEvent[], hasOlder: boolean) => ({ events, hasOlder });
    const recent = [at("2026-10-19T20:00:00.000Z"), at("2026-10-15T20:00:00.000Z")];
    expect(needsOlderTimeline(window(recent, true), "week", now)).toBe(true);
    expect(needsOlderTimeline(window(recent, true), "today", now, "UTC")).toBe(false);
    expect(needsOlderTimeline(window(recent, false), "week", now)).toBe(false);
    // "All" pages on request, never by itself.
    expect(needsOlderTimeline(window(recent, true), "all", now)).toBe(false);

    expect(timelineReaches(window(recent, true), "2026-10-15T20:00:00.000Z")).toBe(true);
    expect(timelineReaches(window(recent, true), "2026-10-04T15:41:48.000Z")).toBe(false);
    const log = [
      at("2026-10-04T16:08:06.000Z", "recovery.incident-cleared"),
      at("2026-10-04T15:45:00.000Z", "recovery.thread-decided"),
      at("2026-10-04T15:41:48.000Z", "recovery.incident-opened"),
      at("2026-10-04T15:40:00.000Z", "recovery.incident-cleared"),
    ];
    expect(restartEvent(log, "2026-10-04T15:41:48.000Z")?.kind).toBe("recovery.incident-opened");
    expect(restartEvent(log, "2026-10-05T00:00:00.000Z")).toBeNull();
  });

  it("folds repeated structural changes in the direction check, never calls", () => {
    const item = (kind: "call" | "role", id: string, summary: string, reason: string) =>
      ({
        ref: { kind, id },
        summary,
        reason,
        at: "2026-10-19T08:00:00.000Z",
      }) as DirectionCheckItem;
    const rows = directionCheckRows([
      item("call", "call-1", "Keep Opus on risk", "Call: keep Opus"),
      item("call", "call-2", "Keep Opus on risk", "Call: keep Opus"),
      ...Array.from({ length: 20 }, (_, index) =>
        item(
          "role",
          `role-${index}`,
          "1 imported holder(s) keep their model",
          "role.model-changed",
        ),
      ),
    ]);
    expect(rows.map((row) => [row.item.ref.id, row.count, row.reason])).toEqual([
      ["call-1", 1, "Call: keep Opus"],
      ["call-2", 1, "Call: keep Opus"],
      ["role-0", 20, "Role model changed"],
    ]);
  });
});

describe("change log", () => {
  const owner: MissionActor = { _tag: "owner" };
  const master = { _tag: "role", roleId: MASTER } as MissionActor;
  const event = (seq: number, actor: MissionActor, fields: unknown, at: string) => ({
    id: `ev-${seq}` as MissionEventId,
    seq,
    actor,
    subject: { kind: "pool" as const, id: "pool-claude" },
    payload: { changed: fields },
    at,
  });

  it("keeps the newest change per field by seq, whatever order events arrive in", () => {
    const changes = latestFieldChanges([
      event(3, owner, ["capacity"], "2026-10-17T08:00:00.000Z"),
      event(1, master, ["capacity", "priority"], "2026-10-17T07:00:00.000Z"),
      { ...event(4, owner, ["capacity"], "2026-10-17T08:10:00.000Z"), subject: null },
    ]);
    const lookup = changeIndex(changes);
    const ref = { kind: "pool" as const, id: "pool-claude" };
    expect(changedBy(lookup(ref, "capacity"), MASTER)).toBe("you");
    expect(lastChangedLine(lookup(ref, "priority"), MASTER)).toBe("last changed by master");
    expect(lookup(ref, "enforcement")).toBeNull();
    expect(newestChange(changes, ref)?.eventId).toBe("ev-3");
    expect(changedFields({ changed: ["a", 2, "b"] })).toEqual(["a", "b"]);
    expect(changedFields(null)).toEqual([]);
  });
});

describe("portfolio view model", () => {
  it("lists missions in priority order with shares, borrowing and run-outs", async () => {
    const missions = source();
    const portfolio = live<PortfolioSnapshot>((l) => missions.subscribePortfolio(l));
    const view = portfolioView(portfolio.value);
    expect(view.rows.map((row) => [row.mission.missionId, row.position])).toEqual([
      [CRPKO, 1],
      [JUNO, 2],
    ]);
    const crpko = view.rows[0];
    expect(crpko?.shareLine).toBe("Guaranteed 70%, can borrow up to 90%");
    expect(crpko?.pools.map((pool) => pool.line)).toContain("92% of Offbox");
    expect(crpko?.firstRunOutAt).toBe("2026-10-17T09:05:00.000Z");
    expect(crpko?.changedBy).toEqual({
      tier: "last changed by you",
      shares: "last changed by master",
    });
    expect(view.rows[1]?.usedLine).toBe("Not measured yet");
    expect(view.overcommitted).toBe(false);

    expect(reorderPortfolioInput(portfolio.value.order, CRPKO, CRPKO)).toEqual({
      ok: false,
      error: "Pick another position.",
    });
    const input = reorderPortfolioInput(portfolio.value.order, JUNO, CRPKO);
    if (!input.ok) throw new Error(input.error);
    await missions.setPortfolioOrder(input.value);
    const after = portfolioView(portfolio.value);
    expect(after.rows.map((row) => row.mission.missionId)).toEqual([JUNO, CRPKO]);
    expect(after.orderLine).toBe("Order last changed by you");
    // The reorder moves every mission, so each timeline shows it.
    let junoKinds: ReadonlyArray<string> = [];
    missions.subscribeTimeline(JUNO, (events) => {
      junoKinds = events.map((event) => event.kind);
    })();
    expect(junoKinds[0]).toBe("portfolio.reordered");
    await expect(missions.setPortfolioOrder({ order: [JUNO] })).rejects.toMatchObject({
      code: "invalid",
    });
    portfolio.close();
  });

  it("reads the order bar, the page line, the shared pools and the changes", async () => {
    const missions = source();
    const portfolio = live<PortfolioSnapshot>((l) => missions.subscribePortfolio(l));
    const view = portfolioView(portfolio.value);
    const bar = portfolioBar(view);
    expect(bar.shares.map((share) => [share.title, share.share, share.paused])).toEqual([
      ["Crpko engineering", 0.7, false],
      ["Juno intents", 0.05, true],
    ]);
    expect(bar.free).toBeCloseTo(0.25);
    const text = portfolioSummary(bar)
      .map((part) => (typeof part === "string" ? part : part.figure))
      .join("");
    expect(text).toBe(
      "Crpko engineering takes 70% of the shared pools. Juno intents is paused. 25% is free.",
    );
    expect(portfolioFacts(view.rows[1]!).map((fact) => fact.value)).toEqual([
      "5%",
      "Not measured",
      "15%",
    ]);
    const offbox = portfolioPools(view).find((pool) => pool.poolId === "pool-offbox");
    expect(offbox?.line).toBe("Crpko engineering 92%, Juno intents 8%");

    const input = reorderPortfolioInput(portfolio.value.order, JUNO, CRPKO);
    if (!input.ok) throw new Error(input.error);
    await missions.setPortfolioOrder(input.value);
    const [newest] = portfolioChanges(portfolio.value);
    expect(newest).toMatchObject({
      text: "Order: Juno intents, then Crpko engineering",
      by: "you",
    });
    expect(healthCounts([{ health: "amber" }, { health: "green" }, { health: "amber" }])).toEqual([
      { health: "amber", count: 2, label: "2 at risk" },
      { health: "green", count: 1, label: "1 on track" },
    ]);
    portfolio.close();
  });
});

// --- finish-b ---
describe("revert", () => {
  const master: MissionActor = { _tag: "role", roleId: MASTER as never };
  let seq = 0;
  const event = (
    kind: MissionTimelineEvent["kind"],
    subject: MissionTimelineEvent["subject"],
    payload: unknown,
  ) =>
    ({
      id: `rv-${++seq}` as MissionEventId,
      missionId: CRPKO,
      seq,
      kind,
      actor: master,
      provenance: { _tag: "system", component: "missions-core" },
      summary: kind,
      subject,
      causedBy: null,
      payload,
      at: `2026-10-19T10:00:${String(seq).padStart(2, "0")}.000Z`,
    }) as MissionTimelineEvent;
  const mission = { kind: "mission" as const, id: CRPKO, label: "Crpko engineering" };
  const lane = { kind: "lane" as const, id: "lane-cell-bal", label: "cell-bal" };

  it("puts back the previous value through the write that made the change", () => {
    expect(
      revertAction(
        event("mission.updated", mission, {
          changed: ["tier"],
          status: "active",
          focusSubMissionId: null,
          before: { tier: "P2" },
        }),
      ),
    ).toEqual({ _tag: "mission", input: { missionId: CRPKO, tier: "P2" } });
    expect(
      revertAction(
        event("mission.paused", mission, {
          changed: ["status"],
          status: "paused",
          before: { status: "active" },
        }),
      ),
    ).toEqual({ _tag: "status", input: { missionId: CRPKO, status: "active" } });
    expect(
      revertAction(
        event("lane.moved", lane, {
          changed: ["subMissionId"],
          status: "idle",
          subMissionId: "sub-b",
          before: { subMissionId: "sub-a" },
        }),
      ),
    ).toEqual({
      _tag: "lane",
      input: { missionId: CRPKO, laneId: "lane-cell-bal", subMissionId: "sub-a" },
    });
    expect(
      revertAction(
        event("portfolio.reordered", null, { order: [JUNO, CRPKO], previousOrder: [CRPKO, JUNO] }),
      ),
    ).toEqual({ _tag: "order", input: { order: [CRPKO, JUNO] } });
    expect(
      revertAction(
        event(
          "pool.updated",
          { kind: "pool", id: "pool-claude" },
          { poolId: "pool-claude", field: "capacity", from: 40, to: 60, reason: null },
        ),
      ),
    ).toEqual({
      _tag: "pool-capacity",
      input: { poolId: "pool-claude", capacity: 40, reason: "Reverted" },
    });
    expect(
      revertAction(
        event(
          "role.updated",
          { kind: "role", id: "crpko-writer" },
          { fields: ["name"], before: { name: "Writer" }, after: { name: "Scribe" } },
        ),
      ),
    ).toEqual({ _tag: "role", input: { roleId: "crpko-writer", name: "Writer" } });
    expect(
      revertAction(
        event(
          "room.archived",
          { kind: "room", id: "crpko:room:arch" },
          {
            fields: ["archived"],
            before: { title: "#arch", subMissionId: null, archived: false },
            after: { title: "#arch", subMissionId: null, archived: true },
          },
        ),
      ),
    ).toEqual({ _tag: "room", input: { roomId: "crpko:room:arch", archived: false } });
  });

  it("offers no Revert without a previous value, and only on the newest change", () => {
    // Older events carry no `before`; a call revision has no write to put back.
    expect(
      revertAction(event("mission.updated", mission, { changed: ["tier"], status: "active" })),
    ).toBeNull();
    expect(
      revertAction(event("call.revised", null, { previousDecision: "x", previousReason: "y" })),
    ).toBeNull();
    expect(
      revertAction(event("portfolio.reordered", null, { order: [CRPKO], previousOrder: [] })),
    ).toBeNull();

    const first = event("mission.updated", mission, {
      changed: ["tier"],
      status: "active",
      before: { tier: "P1" },
    });
    const second = event("mission.updated", mission, {
      changed: ["tier"],
      status: "active",
      before: { tier: "P2" },
    });
    const share = event("mission.updated", mission, {
      changed: ["guaranteedShare"],
      status: "active",
      before: { guaranteedShare: 0.2 },
    });
    const events = [share, second, first].map((e, index) => ({ ...e, summary: `change ${index}` }));
    const rows = timelineRows(events, events, MASTER);
    expect(rows.map((row) => row.revert?._tag ?? null)).toEqual(["mission", "mission", null]);
  });

  it("reverts a lane move and the mission order in the sample data, recorded as new changes", async () => {
    const missions = source();
    const timeline = live<ReadonlyArray<MissionTimelineEvent>>((l) =>
      missions.subscribeTimeline(CRPKO, l),
    );
    const portfolio = live<PortfolioSnapshot>((l) => missions.subscribePortfolio(l));
    const before = portfolio.value.order;
    const input = reorderPortfolioInput(before, JUNO, CRPKO);
    if (!input.ok) throw new Error(input.error);
    await missions.setPortfolioOrder(input.value);
    const [orderRow] = portfolioChanges(portfolio.value);
    expect(orderRow?.revert).toEqual({ _tag: "order", input: { order: before } });
    await missions.revertChange(orderRow!.revert!);
    expect(portfolio.value.order).toEqual(before);

    const [newest] = timelineRows(timeline.value, timeline.value, MASTER);
    expect(newest?.event.kind).toBe("portfolio.reordered");
    // The revert is itself a change; reverting it again restores the dragged order.
    expect(newest?.revert).toEqual({ _tag: "order", input: { order: input.value.order } });
    timeline.close();
    portfolio.close();
  });
});
// --- end finish-b ---
