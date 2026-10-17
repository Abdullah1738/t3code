import type { MissionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { inboxRouteParams, missionsRouteState } from "./routeParams";

describe("missions route params", () => {
  it("opens on the inbox and leaves the inbox tab to the data", () => {
    expect(missionsRouteState(undefined)).toEqual({
      tab: "inbox",
      inboxTab: null,
      missionId: null,
    });
  });

  it("ignores unknown values from deep links", () => {
    expect(missionsRouteState({ tab: "settings", inboxTab: "later", missionId: "  " })).toEqual({
      tab: "inbox",
      inboxTab: null,
      missionId: null,
    });
  });

  it("round-trips an inbox link for one mission and tab", () => {
    const params = inboxRouteParams("crpko-engineering" as MissionId, "approve");
    expect(missionsRouteState(params)).toEqual({
      tab: "inbox",
      inboxTab: "approve",
      missionId: "crpko-engineering",
    });
  });
});
