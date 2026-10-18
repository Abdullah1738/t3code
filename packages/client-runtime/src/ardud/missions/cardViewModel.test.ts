import type { MissionId, MissionListSnapshot, SubMissionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cardSubMission, draftKicker, draftTitle, noteFlags } from "./cardViewModel.ts";

const MISSION = "crpko-engineering" as MissionId;
const SUB = "sub-release" as SubMissionId;

const list = {
  revision: 1,
  missions: [
    {
      id: MISSION,
      subMissions: [{ id: SUB, title: "Releases and dev environment", order: 2 }],
    },
  ],
} as unknown as MissionListSnapshot;

describe("card wording", () => {
  it("ranks the sub-mission from its order and drops unknown ones", () => {
    expect(cardSubMission(list, MISSION, SUB)).toEqual({
      missionId: MISSION,
      subMissionId: SUB,
      rank: 3,
      title: "Releases and dev environment",
    });
    expect(cardSubMission(list, MISSION, "sub-gone" as SubMissionId)).toBeNull();
    expect(cardSubMission(list, MISSION, null)).toBeNull();
    expect(cardSubMission(undefined, MISSION, SUB)).toBeNull();
  });

  it("titles drafts by summary, else by audience", () => {
    expect(draftTitle({ summary: " Ask for a rebase ", audience: "Dylan" })).toBe(
      "Ask for a rebase",
    );
    expect(draftTitle({ summary: null, audience: "Dylan" })).toBe("To Dylan");
    expect(draftKicker({ requestedBy: "crw" })).toBe("Review feedback");
    expect(draftKicker({})).toBe("Draft");
  });

  it("flags only the loud parts of a note", () => {
    expect(
      noteFlags({ severity: "low", basis: "observed", evidence: "matched", citation: "verified" }),
    ).toEqual([]);
    expect(
      noteFlags({ severity: "high", basis: "claimed", evidence: "missing", citation: "failed" }),
    ).toEqual([
      { label: "High", tone: "warning" },
      { label: "Claimed", tone: "neutral" },
      { label: "No evidence", tone: "warning" },
      { label: "Quote differs", tone: "error" },
    ]);
  });
});
