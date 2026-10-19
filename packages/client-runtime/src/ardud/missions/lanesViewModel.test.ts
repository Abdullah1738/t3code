import type { Lane, MissionId } from "@t3tools/contracts";
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
  laneGroups,
  laneRows,
  mergeLanesInput,
  mergeTargets,
  modelLabel,
  moveLaneInput,
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

  it("puts problems first and folds idle and parked lanes behind one line", () => {
    const { rows } = fixtureRows();
    const groups = laneGroups(rows);
    expect(groups.shown.map((group) => group.status)).toEqual(["stuck", "waiting", "working"]);
    expect(groups.shown[0]?.rows.map((row) => row.lane.name).sort()).toEqual([
      "cell-risk6",
      "cell-triage",
    ]);
    expect(groups.quiet.map((group) => group.status)).toEqual(["idle", "parked"]);
    const quiet = groups.quiet.reduce((sum, group) => sum + group.rows.length, 0);
    expect(groups.quietLine).toBe(
      `${quiet} quiet lanes: ${groups.quiet[0]?.rows.length} idle, ${groups.quiet[1]?.rows.length} parked`,
    );
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
