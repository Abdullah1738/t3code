import type { MissionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applySectionChange,
  askSectionChangeInput,
  defaultLayout,
  pinnedStrip,
  sectionMoves,
  setAsideSections,
  visibleSections,
  type MissionLayout,
  type SectionChange,
} from "./sections.ts";

const MISSION = "crpko-engineering" as MissionId;
const at = "2026-10-17T08:33:00.000Z";

let nextId = 1;
function change(layout: MissionLayout, key: string, next: SectionChange, ownerWaiting = 0) {
  const result = applySectionChange(layout, key, next, {
    id: `change-${nextId++}`,
    at,
    by: "owner",
    ownerWaiting,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const keys = (layout: MissionLayout, region: "main" | "rail") =>
  visibleSections(layout, region).map((s) => s.key);

describe("section list", () => {
  it("starts from the recommended list with Your requests in the main column", () => {
    const layout = defaultLayout(MISSION);
    expect(keys(layout, "main")).toEqual(["your-requests", "sub-missions", "since-last-looked"]);
    expect(keys(layout, "rail")).toEqual(["needs-you", "path-to-milestone", "with-the-master"]);
  });

  it("moves within and across columns and logs each move", () => {
    let layout = defaultLayout(MISSION);
    layout = change(layout, "since-last-looked", { type: "move", region: "main", index: 0 });
    expect(keys(layout, "main")).toEqual(["since-last-looked", "your-requests", "sub-missions"]);
    layout = change(layout, "with-the-master", { type: "move", region: "main", index: 1 });
    expect(keys(layout, "main")).toEqual([
      "since-last-looked",
      "with-the-master",
      "your-requests",
      "sub-missions",
    ]);
    expect(keys(layout, "rail")).toEqual(["needs-you", "path-to-milestone"]);
    expect(layout.changes.map((c) => c.summary)).toEqual([
      "Moved With the master to the main column",
      "Moved Since you last looked up",
    ]);
    expect(sectionMoves(layout, "sub-missions")).toEqual({ up: 2, down: null, other: "rail" });
  });

  it("hides and restores, and a change that changes nothing is not logged", () => {
    let layout = change(defaultLayout(MISSION), "path-to-milestone", { type: "hide" });
    expect(keys(layout, "rail")).toEqual(["needs-you", "with-the-master"]);
    expect(setAsideSections(layout).map((s) => s.key)).toEqual(["path-to-milestone"]);
    const same = change(layout, "path-to-milestone", { type: "hide" });
    expect(same).toBe(layout);
    layout = change(layout, "path-to-milestone", { type: "restore" });
    expect(keys(layout, "rail")).toEqual(["needs-you", "path-to-milestone", "with-the-master"]);
    expect(layout.changes[0]).toMatchObject({ by: "owner", summary: "Restored Path to milestone" });
    expect(layout.entries.find((s) => s.key === "path-to-milestone")?.changedBy).toBe("owner");
  });

  it("keeps Needs you reachable: it hides but never removes", () => {
    const layout = defaultLayout(MISSION);
    const removed = applySectionChange(
      layout,
      "needs-you",
      { type: "remove" },
      {
        id: "x",
        at,
        by: "owner",
      },
    );
    expect(removed.ok).toBe(false);
    const hidden = change(layout, "needs-you", { type: "hide" }, 7);
    expect(hidden.changes[0]?.summary).toBe("Hid Needs you; 7 waiting items pinned under the head");
  });

  it("pins what waits on the owner when its section is not shown", () => {
    let layout = defaultLayout(MISSION);
    expect(pinnedStrip(layout, { ownerWaiting: 3, requestsUnread: 1 })).toEqual({
      needsYou: false,
      requests: false,
    });
    layout = change(layout, "needs-you", { type: "hide" }, 3);
    layout = change(layout, "your-requests", { type: "remove" });
    expect(pinnedStrip(layout, { ownerWaiting: 3, requestsUnread: 1 })).toEqual({
      needsYou: true,
      requests: true,
    });
    expect(pinnedStrip(layout, { ownerWaiting: 0, requestsUnread: 0 })).toEqual({
      needsYou: false,
      requests: false,
    });
  });

  it("refuses to move a hidden section and asks for words before asking the master", () => {
    const layout = change(defaultLayout(MISSION), "sub-missions", { type: "hide" });
    const moved = applySectionChange(
      layout,
      "sub-missions",
      { type: "move", region: "rail", index: 0 },
      { id: "x", at, by: "owner" },
    );
    expect(moved.ok).toBe(false);
    const section = layout.entries[0]!;
    expect(askSectionChangeInput(MISSION, section, "  ").ok).toBe(false);
    const ask = askSectionChangeInput(MISSION, section, "Only show unread ones");
    expect(ask).toEqual({
      ok: true,
      value: {
        missionId: MISSION,
        kind: "owner-question",
        origin: null,
        question: "Change the Your requests section: Only show unread ones",
      },
    });
  });
});
