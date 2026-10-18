import type { MissionActor, MissionEventId, MissionId } from "@t3tools/contracts";
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
import { portfolioView, reorderPortfolioInput } from "./portfolioViewModel.ts";
import type { MissionTimelineEvent, PortfolioSnapshot } from "./source.ts";
import {
  actorChoices,
  consequences,
  EMPTY_TIMELINE_FILTER,
  filterTimeline,
  kindChoices,
  kindGroup,
  lineage,
  successions,
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
    expect(rule104?.consequenceCount).toBe(2);
    expect(rows.find((row) => row.event.id === "ev-10212")?.causeSummary).toMatch(/rule 104/i);

    const looped = { ...byId(events, "ev-10141"), causedBy: "ev-10142" as MissionEventId };
    const withLoop = events.map((event) => (event.id === looped.id ? looped : event));
    expect(lineage(byId(withLoop, "ev-10142"), withLoop).map((event) => event.id)).toEqual([
      "ev-10141",
      "ev-10142",
    ]);
    timeline.close();
  });

  it("pulls out lane successions and logs a hand-off from the lanes tab", async () => {
    const missions = source();
    const timeline = live<ReadonlyArray<MissionTimelineEvent>>((l) =>
      missions.subscribeTimeline(CRPKO, l),
    );
    expect(successions(timeline.value, MASTER).map((entry) => entry.who)).toEqual([
      "cell-risk6",
      "cell-risk",
      "cell-risk5",
    ]);
    await missions.handOffLane({
      laneId: "lane-cell-bal" as never,
      note: "655K prompt; #773 r6 is running, resume from the stop step",
    });
    const latest = successions(timeline.value, MASTER)[0];
    expect(latest?.who).toBe("cell-bal");
    expect(latest?.event.actor._tag).toBe("owner");
    timeline.close();
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
});
