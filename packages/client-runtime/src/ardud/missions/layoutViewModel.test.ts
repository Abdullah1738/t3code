import type { MissionId, ViewRegion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import {
  layoutGroups,
  pageTabs,
  resolveMissionLayout,
  viewDropRequest,
  viewDropTarget,
  viewSectionMoves,
} from "./layoutViewModel.ts";
import type { MissionViewsState } from "./source.ts";
import { viewSectionRequest } from "./views/layout.ts";

const CRPKO = "crpko-engineering" as MissionId;
const now = () => Date.parse(FIXTURE_NOW) + 60_000;

function views() {
  const source = createFixtureMissionsSource({ now });
  let state: MissionViewsState | null = null;
  source.subscribeViews(CRPKO, (next) => {
    state = next;
  });
  const current = (): MissionViewsState => {
    if (state === null) throw new Error("no views state");
    return state;
  };
  const change = async (key: string, edit: Parameters<typeof viewSectionRequest>[2]) => {
    const request = viewSectionRequest(current().snapshot, key, edit);
    if (request === null) throw new Error(`no request for ${key}`);
    await source.changeView(request);
  };
  return { current, change };
}

const keys = (entries: ReadonlyArray<{ readonly key: string }>) => entries.map((e) => e.key);

describe("mission layout", () => {
  it("starts from the starter layout with Your requests leading the main column", () => {
    const { current } = views();
    const layout = resolveMissionLayout(current().snapshot);
    expect(keys(layout.main)).toEqual(["your-requests", "sub-missions", "since-last-looked"]);
    expect(keys(layout.rail)).toEqual(["needs-you", "path-to-milestone", "with-the-master"]);
    expect(layout.tabs.map((tab) => tab.tab)).toContain("views");
  });

  it("moves, hides and renames through the views record and logs each change", async () => {
    const { current, change } = views();
    const before = resolveMissionLayout(current().snapshot);
    const moves = viewSectionMoves(before, "sub-missions");
    expect(moves.up).toEqual({ type: "move", region: "main", index: 0 });
    expect(moves.acrossLabel).toBe("To Board rail");

    await change("sub-missions", moves.up!);
    expect(keys(resolveMissionLayout(current().snapshot).main)).toEqual([
      "sub-missions",
      "your-requests",
      "since-last-looked",
    ]);

    const across = viewSectionMoves(resolveMissionLayout(current().snapshot), "sub-missions");
    await change("sub-missions", across.across!);
    expect(keys(resolveMissionLayout(current().snapshot).rail).at(-1)).toBe("sub-missions");

    await change("needs-you", { type: "hide" });
    await change("since-last-looked", { type: "rename", title: "Overnight" });
    const after = resolveMissionLayout(current().snapshot, { ownerWaiting: 3 });
    expect(after.pinned.needsYou).toBe(true);
    expect(after.main.find((entry) => entry.key === "since-last-looked")?.title).toBe("Overnight");
    expect(current().changes.map((entry) => entry.summary)).toEqual([
      "The owner renamed Since you last looked to Overnight",
      "The owner hid Needs you",
      "The owner moved Sub-missions to rail",
      "The owner moved Sub-missions",
    ]);
  });

  it("brings a removed built-in back at its starter place", async () => {
    const { current, change } = views();
    await change("with-the-master", { type: "remove" });
    const removed = resolveMissionLayout(current().snapshot);
    expect(keys(removed.rail)).not.toContain("with-the-master");
    const rail = layoutGroups(current().snapshot, removed).find((group) => group.region === "rail");
    expect(rail?.rows.at(-1)).toMatchObject({ key: "with-the-master", type: "section" });

    await change("with-the-master", { type: "restore" });
    expect(keys(resolveMissionLayout(current().snapshot).rail)).toContain("with-the-master");
  });

  it("groups every entry by region and leaves empty groups out", () => {
    const { current } = views();
    const groups = layoutGroups(current().snapshot, resolveMissionLayout(current().snapshot));
    expect(groups.map((group) => group.label)).toEqual([
      "Board main",
      "Board rail",
      "Header",
      "Tabs",
    ]);
    expect(groups.at(-1)?.rows).toHaveLength(11);
  });

  it("turns a drop into one layout move, within a region and across", async () => {
    const source = createFixtureMissionsSource({ now });
    let state: MissionViewsState | null = null;
    source.subscribeViews(CRPKO, (next) => {
      state = next;
    });
    const snapshot = () => {
      if (state === null) throw new Error("no views state");
      return (state as MissionViewsState).snapshot;
    };
    const drop = async (key: string, region: ViewRegion, before: string | null) => {
      const request = viewDropRequest(snapshot(), key, region, before);
      if (request === null) throw new Error(`no move for ${key}`);
      await source.changeView(request);
    };

    expect(viewDropRequest(snapshot(), "since-last-looked", "main", "your-requests")).toEqual({
      method: "editLayout",
      input: {
        missionId: CRPKO,
        ops: [{ _tag: "move", key: "since-last-looked", region: "main", index: 0 }],
        expectedVersion: snapshot().layout.version,
      },
    });
    await drop("since-last-looked", "main", "your-requests");
    expect(keys(resolveMissionLayout(snapshot()).main)).toEqual([
      "since-last-looked",
      "your-requests",
      "sub-missions",
    ]);

    await drop("your-requests", "main", null);
    expect(keys(resolveMissionLayout(snapshot()).main)).toEqual([
      "since-last-looked",
      "sub-missions",
      "your-requests",
    ]);

    await drop("needs-you", "main", "sub-missions");
    expect(keys(resolveMissionLayout(snapshot()).main)).toEqual([
      "since-last-looked",
      "needs-you",
      "sub-missions",
      "your-requests",
    ]);
    expect(keys(resolveMissionLayout(snapshot()).rail)).toEqual([
      "path-to-milestone",
      "with-the-master",
    ]);

    // Dragged down onto a tile it lands after it; up, before it; elsewhere, before it.
    const groups = layoutGroups(snapshot(), resolveMissionLayout(snapshot()));
    const over = (key: string) => ({ region: "main" as const, key });
    expect(viewDropTarget(groups, "since-last-looked", over("needs-you"))).toEqual({
      region: "main",
      before: "sub-missions",
    });
    expect(viewDropTarget(groups, "your-requests", over("needs-you"))).toEqual({
      region: "main",
      before: "needs-you",
    });
    expect(viewDropTarget(groups, "path-to-milestone", over("needs-you"))).toEqual({
      region: "main",
      before: "needs-you",
    });

    // Dropping where it already sits, or a tab among sections, sends nothing.
    expect(viewDropRequest(snapshot(), "needs-you", "main", "sub-missions")).toBeNull();
    expect(viewDropRequest(snapshot(), "tab-rooms", "main", null)).toBeNull();
    expect(viewDropRequest(snapshot(), "needs-you", "tabs", null)).toBeNull();
  });

  it("builds the tab row from the layout, keeping the open tab and Views reachable", async () => {
    const labels = { overview: "Board", rooms: "Rooms", timeline: "Timeline", views: "Views" };
    const { current, change } = views();
    const row = () => pageTabs(resolveMissionLayout(current().snapshot), labels, "overview");
    expect(row().map((tab) => tab.title)).toEqual(["Board", "Rooms", "Timeline", "Views"]);

    await change("tab-rooms", { type: "rename", title: "Channels" });
    await change("tab-timeline", { type: "hide" });
    await change("tab-views", { type: "hide" });
    expect(row().map((tab) => tab.title)).toEqual(["Board", "Channels", "Views"]);
    expect(
      pageTabs(resolveMissionLayout(current().snapshot), labels, "timeline").map((tab) => tab.tab),
    ).toEqual(["overview", "rooms", "timeline", "views"]);
  });
});
