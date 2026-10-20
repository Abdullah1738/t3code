import type { Lane, LaneId, MissionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import type {
  MissionOverviewSnapshot,
  MissionRolesSnapshot,
  MissionWorkSnapshot,
} from "./source.ts";
import {
  contextView,
  formatTokens,
  laneActions,
  laneBoard,
  laneRows,
  mergeLanesInput,
  mergeTargets,
  modelFamily,
  modelLabel,
  moveLaneInput,
  newLaneInput,
  nudgeLaneInput,
  setLaneParkedInput,
  splitLaneInput,
} from "./lanesViewModel.ts";

const CRPKO = "crpko-engineering" as MissionId;

function read<T>(subscribe: (listener: (value: T) => void) => () => void): T {
  let value: T | undefined;
  subscribe((next) => {
    value = next;
  })();
  if (value === undefined) throw new Error("no value");
  return value;
}

function fixtureRows() {
  const source = createFixtureMissionsSource({ now: () => Date.parse(FIXTURE_NOW) });
  const lanes = read<ReadonlyArray<Lane>>((l) => source.subscribeLanes(CRPKO, l));
  const roles = read<MissionRolesSnapshot>((l) => source.subscribeRoles(CRPKO, l));
  const work = read<MissionWorkSnapshot>((l) => source.subscribeWork(CRPKO, l));
  const overview = read<MissionOverviewSnapshot | null>((l) => source.subscribeOverview(CRPKO, l));
  return {
    lanes,
    rows: laneRows(lanes, {
      roles: roles.roles,
      bindings: roles.bindings,
      workItems: work.items,
      subMissions: overview?.subMissions ?? [],
    }),
  };
}

describe("lane rows", () => {
  it("joins each lane to its lead role, model, context, current item and earlier leads", () => {
    const { rows } = fixtureRows();
    const risk = rows.find((row) => row.lane.name === "cell-risk");
    expect(risk?.model).toBe("opus/claude-opus-5-5 xhigh");
    expect(risk?.subMissionTitle).toBe("Architecture wave delivery");
    expect(risk?.currentItem?.id).toBe("risk68-r4");
    expect(risk?.context?.label).toMatch(/ of 1M \(/);

    const money = rows.find((row) => row.lane.name === "cell-money");
    expect(money?.successions.map((binding) => binding.threadId)).toEqual(["mcp:271cfc0f"]);

    const risk6 = rows.find((row) => row.lane.name === "cell-risk6");
    expect(risk6?.model).toBe("opus/cc/claude-haiku-5-5 xhigh");
    expect(risk6?.pendingModel).toBe("opus/claude-opus-5-5 xhigh");
  });
});

describe("lane board", () => {
  const text = (parts: ReadonlyArray<string | { figure: string }>) =>
    parts.map((part) => (typeof part === "string" ? part : part.figure)).join("");

  const withRetired = () => {
    const { rows } = fixtureRows();
    const first = rows[0]!;
    return [
      ...rows,
      { ...first, lane: { ...first.lane, id: "lane-old" as LaneId, status: "retired" as const } },
    ];
  };

  it("says how many lanes are live and groups by state, longest waits first", () => {
    const rows = withRetired();
    const board = laneBoard(rows, "state");
    const count = (status: string) => rows.filter((row) => row.lane.status === status).length;
    const live = rows.length - count("parked") - count("retired");
    expect(text(board.summary)).toBe(
      `${live} live: ${count("stuck")} stuck, ${count("waiting")} waiting, ${count("working")} working, ${count("idle")} idle. ${count("parked")} parked, ${count("retired")} retired.`,
    );
    expect(board.panels.map((panel) => panel.title)).toEqual([
      "Stuck",
      "Waiting",
      "Working",
      "Idle",
      "Parked and retired",
    ]);
    const waiting = board.panels[1]!.rows.map((row) => row.lane.lastActiveAt ?? "");
    expect(waiting).toEqual([...waiting].sort());
    const parked = board.panels.at(-1)!;
    expect(parked.shown).toBe(2);
    expect(parked.restLabel).toBe(
      `${count("parked") - 2} more parked, ${count("retired")} retired`,
    );
  });

  it("groups by sub-mission in mission order and by who each lane answers to", () => {
    const rows = withRetired();
    const bySub = laneBoard(rows, "sub-mission", ["crpko-e2e-harness", "crpko-arch-wave"]);
    expect(bySub.panels.slice(0, 2).map((panel) => panel.title)).toEqual([
      "Live e2e and harness",
      "Architecture wave delivery",
    ]);
    expect(bySub.panels.at(-1)?.title).toBe("Retired");
    expect(bySub.panels.flatMap((panel) => panel.rows)).toHaveLength(rows.length);

    const byLead = laneBoard(rows, "lead");
    expect(byLead.panels[0]?.title).toBe("Master");
  });

  it("reads the lead a sub-coordinator gives, the resume note and the model family", () => {
    const source = createFixtureMissionsSource({ now: () => Date.parse(FIXTURE_NOW) });
    const lanes = read<ReadonlyArray<Lane>>((l) => source.subscribeLanes(CRPKO, l));
    const roles = read<MissionRolesSnapshot>((l) => source.subscribeRoles(CRPKO, l));
    const risk6 = lanes.find((lane) => lane.name === "cell-risk6")!;
    const lead = roles.roles.find((role) => role.name === "cell-risk")!;
    const [row] = laneRows([risk6], {
      roles: roles.roles,
      bindings: roles.bindings,
      workItems: [],
      subMissions: [{ id: risk6.subMissionId!, title: "Risk", coordinatorRoleId: lead.id }],
    });
    expect(row?.leadName).toBe("cell-risk");

    const money = fixtureRows().rows.find((entry) => entry.lane.name === "cell-money");
    expect(money?.resumeNote).toBe(
      "Rewards lane: CRP-13154 handoff; old thread hit its context limit.",
    );
    expect(modelFamily(risk6 && lead.modelSelection)).toBe("Opus");
    expect(modelFamily({ provider: "x", model: "cc/claude-haiku-5-5" } as never)).toBe("Haiku");
    expect(modelFamily({ provider: "x", model: "gpt-6-astra" } as never)).toBe("gpt-6-astra");
  });
});

describe("context gauge", () => {
  it("formats tokens and grades the fill", () => {
    expect(formatTokens(212_000)).toBe("212K");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_240_000)).toBe("1.2M");
    expect(contextView({ promptTokens: 212_000, limitTokens: 1_000_000, successions: 1 })).toEqual({
      share: 0.212,
      tone: "ok",
      label: "212K of 1M (21%)",
      successionLine: "1 handoff so far",
    });
    expect(contextView({ promptTokens: 350_000, limitTokens: 400_000, successions: 0 })?.tone).toBe(
      "full",
    );
    expect(contextView(null)).toBeNull();
  });

  it("labels a model with its variant", () => {
    expect(modelLabel({ instanceId: "opencode" as never, model: "opus/cx/gpt-6.1-sol" })).toBe(
      "opus/cx/gpt-6.1-sol",
    );
    expect(
      modelLabel({
        instanceId: "opencode" as never,
        model: "opus/cx/gpt-6.1-sol",
        options: [{ id: "variant" as never, value: "xhigh" as never }],
      }),
    ).toBe("opus/cx/gpt-6.1-sol xhigh");
    expect(modelLabel(null)).toBeNull();
  });
});

describe("lane actions", () => {
  const { lanes } = fixtureRows();
  const lane = (name: string) => {
    const found = lanes.find((candidate) => candidate.name === name);
    if (!found) throw new Error(name);
    return found;
  };

  it("offers resume on a parked lane and explains what can't run", () => {
    const parked = laneActions(lane("cell-ws"));
    expect(parked.map((action) => action.id)).toContain("resume");
    expect(parked.find((action) => action.id === "nudge")?.unavailable).toBe(
      "Resume the lane before nudging it.",
    );
    expect(laneActions(lane("cell-tc")).every((action) => action.unavailable === null)).toBe(true);
    const unbound = laneActions(lane("arch-author"));
    expect(unbound.find((action) => action.id === "hand-off")?.unavailable).toBe(
      "No lead thread is bound to this lane.",
    );
  });

  it("builds inputs and refuses empty or pointless ones", () => {
    expect(nudgeLaneInput(lane("cell-tc").id, "  ")).toEqual({
      ok: true,
      value: { laneId: "lane-cell-tc" },
    });
    expect(nudgeLaneInput(lane("cell-tc").id, " check CI ")).toEqual({
      ok: true,
      value: { laneId: "lane-cell-tc", note: "check CI" },
    });
    expect(setLaneParkedInput(lane("cell-tc"), true, " freeze ")).toEqual({
      missionId: CRPKO,
      laneId: "lane-cell-tc",
      parked: true,
      reason: "freeze",
    });
    expect(setLaneParkedInput(lane("cell-ws"), false, "ignored")).toEqual({
      missionId: CRPKO,
      laneId: "lane-cell-ws",
      parked: false,
    });
    expect(moveLaneInput(lane("cell-tc"), lane("cell-tc").subMissionId!).ok).toBe(false);
    expect(splitLaneInput(lane("cell-tc"), "Cell-TC2", "", lanes)).toEqual({
      ok: false,
      error: "There is already a lane called Cell-TC2.",
    });
    expect(mergeTargets(lane("cell-tc"), lanes).some((other) => other.id === "lane-cell-tc")).toBe(
      false,
    );
    expect(mergeLanesInput(lane("cell-tc2"), lane("cell-tc"))).toEqual({
      ok: true,
      value: { missionId: CRPKO, laneId: "lane-cell-tc2", intoLaneId: "lane-cell-tc" },
    });
    const juno = { ...lane("cell-tc"), id: "lane-intents-ops", missionId: "juno-intents" } as Lane;
    expect(mergeLanesInput(lane("cell-tc2"), juno)).toEqual({
      ok: false,
      error: "Lanes merge only within one mission.",
    });
  });
});

describe("new lane", () => {
  it("needs a name and adds the lane to the mission", async () => {
    expect(newLaneInput(CRPKO, "  ")).toEqual({ ok: false, error: "Name the lane." });
    const built = newLaneInput(CRPKO, " Settlement ");
    expect(built).toEqual({ ok: true, value: { missionId: CRPKO, name: "Settlement" } });
    if (!built.ok) return;

    const source = createFixtureMissionsSource({ now: () => Date.parse(FIXTURE_NOW) });
    let lanes: ReadonlyArray<Lane> = [];
    const close = source.subscribeLanes(CRPKO, (next) => {
      lanes = next;
    });
    const before = lanes.length;
    await source.createLane(built.value);
    expect(lanes).toHaveLength(before + 1);
    expect(lanes.at(-1)).toMatchObject({ name: "Settlement", status: "idle", subMissionId: null });
    close();
  });
});
