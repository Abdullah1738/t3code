import type { MissionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { missionRecordState, missionsRouteParams, missionsRouteState } from "./routeParams";

describe("missions route params", () => {
  it("opens on the inbox for every mission", () => {
    expect(missionsRouteState(undefined)).toEqual({
      tab: "inbox",
      missionId: null,
      page: "board",
      inboxTab: null,
    });
  });

  it("ignores unknown values from deep links", () => {
    expect(
      missionsRouteState({ tab: "settings", missionId: "  ", page: "forks", inboxTab: "later" }),
    ).toEqual({ tab: "inbox", missionId: null, page: "board", inboxTab: null });
  });

  it("round-trips a mission page and clears what was picked before", () => {
    const params = missionsRouteParams({
      tab: "missions",
      missionId: "crpko-engineering" as MissionId,
      page: "lanes",
    });
    expect(params).toEqual({
      tab: "missions",
      missionId: "crpko-engineering",
      page: "lanes",
      inboxTab: undefined,
    });
    expect(missionsRouteState(params)).toMatchObject({ tab: "missions", page: "lanes" });
  });

  it("opens records and refuses a request without its mission", () => {
    expect(missionRecordState({ kind: "item", id: "ask:a1" })).toEqual({
      kind: "item",
      id: "ask:a1",
      missionId: null,
    });
    expect(missionRecordState({ kind: "request", id: "r1" })).toBeNull();
    expect(missionRecordState({ kind: "fork", id: "f1", missionId: "m" })).toBeNull();
    expect(missionRecordState({ kind: "room", id: " " })).toBeNull();
  });
});
