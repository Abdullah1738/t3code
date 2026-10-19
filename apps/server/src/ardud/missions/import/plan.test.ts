import { LaneId, MissionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { ImportPlan } from "./mapping.ts";
import { parsePlan, readPlanFile, type MissionPlan } from "./plan.ts";

const LANES = [
  "crpko:lane:cell-tc",
  "crpko:lane:cell-tc2",
  "crpko:lane:backfill:latency-budgets",
  "crpko:lane:retired:old-qa-threads",
];

// Only the mission id and the lane ids matter to parsing.
const importPlan = {
  missionId: MissionId.make("crpko"),
  core: { lanes: LANES.map((id) => ({ id: LaneId.make(id), name: `name of ${id}` })) },
} as unknown as ImportPlan;

const PLAN = `{
  "mission": "crpko",
  "subMissions": [
    {
      "key": "arch-wave",
      "title": "Architecture wave delivery",
      "intent": "Land the wave",
      "milestones": [
        { "key": "arch-wave-done", "title": "Wave delivered", "due": "2026-10-19T18:00:00+04:00" },
        { "key": "arch-wave-review", "title": "Wave reviewed" }
      ],
      "lanes": ["cell-tc", "crpko:lane:cell-tc2"]
    },
    {
      "key": "pr-factory",
      "title": "PR factory",
      "fillIdleCapacity": true,
      "lanes": ["backfill:latency-budgets"]
    }
  ],
  "unplaced": [{ "lane": "retired:old-qa-threads", "reason": "retired before the plan" }]
}
`;

const parsed = (text: string = PLAN): MissionPlan => {
  const result = parsePlan(text, "plan.json", importPlan);
  if (result._tag !== "ok") throw new Error(result.errors.join("\n"));
  return result.plan;
};

const errorsOf = (text: string) => {
  const result = parsePlan(text, "plan.json", importPlan);
  return result._tag === "invalid" ? result.errors : [];
};

describe("parsePlan", () => {
  it("reads sub-missions, milestones and placements, with due dates in UTC", () => {
    const p = parsed();
    expect(p.subMissions).toEqual([
      {
        id: "crpko:sub:arch-wave",
        title: "Architecture wave delivery",
        intent: "Land the wave",
        fillIdleCapacity: false,
      },
      { id: "crpko:sub:pr-factory", title: "PR factory", intent: "", fillIdleCapacity: true },
    ]);
    expect(p.milestones).toEqual([
      {
        id: "crpko:milestone:arch-wave-done",
        subMissionId: "crpko:sub:arch-wave",
        title: "Wave delivered",
        targetAt: "2026-10-19T14:00:00.000Z",
      },
      {
        id: "crpko:milestone:arch-wave-review",
        subMissionId: "crpko:sub:arch-wave",
        title: "Wave reviewed",
        targetAt: null,
      },
    ]);
    expect(p.placements.map((x) => [x.laneId, x.subMissionId])).toEqual([
      ["crpko:lane:cell-tc", "crpko:sub:arch-wave"],
      ["crpko:lane:cell-tc2", "crpko:sub:arch-wave"],
      ["crpko:lane:backfill:latency-budgets", "crpko:sub:pr-factory"],
    ]);
    expect(p.unplaced).toEqual([
      { laneId: "crpko:lane:retired:old-qa-threads", reason: "retired before the plan" },
    ]);
    expect(p.missing).toEqual([]);
  });

  it("lists lanes the plan leaves out", () => {
    const p = parsed(PLAN.replace(', "crpko:lane:cell-tc2"', ""));
    expect(p.missing).toEqual(["crpko:lane:cell-tc2"]);
  });

  it("names the line of every problem, all at once", () => {
    const bad = `{
  "mission": "juno",
  "subMissions": [
    {
      "key": "Arch Wave",
      "title": "  ",
      "colour": "red",
      "milestones": [
        { "key": "m1", "title": "Day only", "due": "2026-10-19" },
        { "key": "m1", "title": "No such day", "due": "2026-02-30T10:00:00Z" }
      ],
      "lanes": ["cell-tc", "cell-nope", "crpko:lane:cell-tc"]
    },
    { "title": "No key" }
  ],
  "unplaced": [{ "lane": "cell-tc2" }]
}`;
    expect(errorsOf(bad)).toEqual([
      'plan.json:2: mission: plan is for "juno", the import is for "crpko"',
      'plan.json:5: subMissions[0].key: "Arch Wave" is not a key (lowercase letters, digits and dashes)',
      "plan.json:6: subMissions[0].title: needs non-blank text without surrounding spaces",
      "plan.json:7: subMissions[0].colour: unknown field (known: key, title, intent, fillIdleCapacity, milestones, lanes, notes)",
      'plan.json:9: subMissions[0].milestones[0].due: "2026-10-19" is not a date and time with an offset, e.g. 2026-10-19T18:00:00+04:00',
      'plan.json:10: subMissions[0].milestones[1].key: key "m1" is used twice',
      'plan.json:10: subMissions[0].milestones[1].due: "2026-02-30T10:00:00Z" is not a date and time with an offset, e.g. 2026-10-19T18:00:00+04:00',
      'plan.json:12: subMissions[0].lanes[1]: unknown lane "cell-nope": not one of the 4 lanes this import plans',
      'plan.json:12: subMissions[0].lanes[2]: lane "crpko:lane:cell-tc" is already listed at line 12',
      'plan.json:14: subMissions[1]: missing "key"',
      'plan.json:16: unplaced[0]: missing "reason"',
    ]);
  });

  it("reports a syntax error with its line", () => {
    expect(errorsOf('{\n  "subMissions": [\n    { key: "a" }\n  ]\n}')).toEqual([
      "plan.json:3: expected a quoted key",
    ]);
    expect(errorsOf('{\n  "subMissions": [],\n  "subMissions": []\n}')).toEqual([
      'plan.json:3: duplicate key "subMissions"',
    ]);
    expect(errorsOf("")).toEqual(["plan.json:1: unexpected end of file"]);
    expect(errorsOf('{\n  "subMissions": [],\n}')).toEqual(["plan.json:2: trailing comma"]);
    expect(errorsOf('{\n  "subMissions": [],\n  "notes": "a\tb"\n}')).toEqual([
      "plan.json:3: control character or bad escape in string",
    ]);
    expect(errorsOf("[".repeat(20_000))).toEqual(["plan.json:1: nested too deeply"]);
  });

  it("takes a byte-order mark", () => {
    expect(parsed(`\uFEFF${PLAN}`).subMissions).toHaveLength(2);
  });

  it("wants a real time of day and a real offset", () => {
    for (const due of ["2026-10-19T24:00:00Z", "2026-10-19T10:00:00+15:00", "2026-10-19T10:60Z"])
      expect(errorsOf(PLAN.replace("2026-10-19T18:00:00+04:00", due))).toEqual([
        `plan.json:9: subMissions[0].milestones[0].due: "${due}" is not a date and time with an offset, e.g. 2026-10-19T18:00:00+04:00`,
      ]);
  });

  it("reports a plan file it can't read as a problem", () => {
    const result = readPlanFile("/nonexistent/plan.json", importPlan);
    expect(result._tag === "invalid" ? result.errors : []).toEqual([
      expect.stringMatching(/^\/nonexistent\/plan\.json: can't read the plan: ENOENT/),
    ]);
  });
});
