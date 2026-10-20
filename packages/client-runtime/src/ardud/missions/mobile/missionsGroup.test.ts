import type { MissionListSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "../fixture/index.ts";
import { inboxTotal, missionGroupRows } from "./missionsGroup.ts";

function list(): MissionListSnapshot {
  const source = createFixtureMissionsSource({ now: () => Date.parse(FIXTURE_NOW) });
  let value: MissionListSnapshot | undefined;
  source.subscribeList((next) => {
    value = next;
  })();
  if (!value) throw new Error("no list");
  return value;
}

describe("Missions group on the thread list", () => {
  it("gives each live mission one status line and its counts", () => {
    const snapshot = list();
    const rows = missionGroupRows(snapshot);
    const live = snapshot.missions.filter((mission) => mission.status !== "archived");
    expect(rows.map((row) => row.id)).toEqual(live.map((mission) => mission.id));
    for (const row of rows) {
      expect(row.statusLine).not.toContain("·");
      const mission = live.find((item) => item.id === row.id)!;
      if (mission.status === "paused") expect(row.statusLine).toBe("Paused");
      expect(row.needsYou === null).toBe(mission.needsYou === 0);
      expect(row.answered).toBe(mission.requestsAnswered ?? 0);
    }
    expect(inboxTotal(snapshot)).toBe(live.reduce((sum, mission) => sum + mission.needsYou, 0));
  });

  it("reads lanes as one phrase", () => {
    const [mission] = list().missions;
    const base = { ...mission!, status: "active" as const, health: "amber" as const };
    const row = (lanes: typeof base.lanes) =>
      missionGroupRows({ revision: 1, missions: [{ ...base, lanes }] })[0]!.statusLine;
    expect(row({ working: 17, waiting: 7, stuck: 0, idle: 3, parked: 0 })).toBe(
      "At risk. 17 lanes working, 7 waiting",
    );
    expect(row({ working: 0, waiting: 1, stuck: 2, idle: 0, parked: 0 })).toBe(
      "At risk. 1 lane waiting, 2 stuck",
    );
    expect(row({ working: 0, waiting: 0, stuck: 0, idle: 4, parked: 1 })).toBe(
      "At risk. No lanes working",
    );
  });
});
