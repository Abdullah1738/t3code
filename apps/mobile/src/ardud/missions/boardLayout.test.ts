import {
  DEFAULT_STARTER_LAYOUT,
  MissionId,
  RoleId,
  ViewSectionId,
  type MissionViewsSnapshot,
  type ViewLayoutEntry,
  type ViewSection,
} from "@t3tools/contracts";
import { resolveMissionLayout } from "@t3tools/client-runtime/ardud/missions";
import { describe, expect, it } from "vite-plus/test";

import { boardSlots, type BoardSlot } from "./boardLayout";

const T0 = "2026-10-22T08:00:00.000Z";
const missionId = MissionId.make("crpko");

const section = (id: string, title: string): ViewSection => ({
  id: ViewSectionId.make(id),
  missionId,
  definition: {
    key: id,
    title,
    source: { _tag: "refs", refs: [{ kind: "work-item", id: "CRP-1", label: "Cut r004" }] },
    body: [{ _tag: "list", title: "row.title", meta: [], status: null }],
  },
  version: 1,
  changedBy: { _tag: "role", roleId: RoleId.make("role-master") },
  by: "master",
  changedAt: T0,
  changeNote: null,
  catalogVersion: 1,
  status: "active",
  createdAt: T0,
  createdBy: "master",
});

const builtin = (
  kind: Extract<ViewLayoutEntry["section"], { _tag: "builtin" }>["kind"],
  region: ViewLayoutEntry["region"],
  hidden = false,
): ViewLayoutEntry => ({
  key: kind,
  section: { _tag: "builtin", kind },
  region,
  hidden,
  title: null,
});

const custom = (key: string, id: string): ViewLayoutEntry => ({
  key,
  section: { _tag: "custom", sectionId: ViewSectionId.make(id) },
  region: "main",
  hidden: false,
  title: null,
});

const tabs = DEFAULT_STARTER_LAYOUT.layout.entries.filter((entry) => entry.region === "tabs");

// Only what the layout resolves from; the rest of a snapshot plays no part here.
const snapshot = (entries: ReadonlyArray<ViewLayoutEntry>): MissionViewsSnapshot =>
  ({
    missionId,
    layout: {
      missionId,
      layout: { ...DEFAULT_STARTER_LAYOUT.layout, entries: [...entries] },
      version: 4,
      changedBy: { _tag: "owner" },
      by: "owner",
      changedAt: T0,
      changeNote: null,
      seededFrom: 1,
    },
    sections: [
      section("sec-daily", "Latest daily report"),
      section("sec-4h", "Last 8 four-hour updates"),
    ],
    ownerWaiting: 0,
    requestsUnread: 0,
  }) as unknown as MissionViewsSnapshot;

// What crpko's board carries today: two master sections under Your requests
// and Since you last looked hidden.
const crpko = snapshot([
  builtin("header-stats", "header"),
  ...tabs,
  builtin("needs-you", "rail"),
  builtin("your-requests", "main"),
  custom("daily", "sec-daily"),
  custom("four-hour", "sec-4h"),
  builtin("sub-missions", "main"),
  builtin("since-last-looked", "main", true),
  builtin("path-to-milestone", "rail"),
  builtin("with-the-master", "rail"),
]);

const names = (slots: ReadonlyArray<BoardSlot>) =>
  slots.map((slot) => {
    switch (slot.type) {
      case "section":
        return slot.entry.title;
      case "pinned":
        return `pinned ${slot.entry.title}`;
      default:
        return slot.type;
    }
  });

describe("boardSlots", () => {
  it("keeps the current board while views load or when there are none", () => {
    expect(names(boardSlots(null))).toEqual([
      "figures",
      "Needs you",
      "discussions",
      "Your requests",
      "lanes",
      "Since you last looked",
      "Path to milestone",
      "Sub-missions",
      "With the master",
    ]);
  });

  it("follows crpko's layout: customs in place, hidden Since gone", () => {
    expect(names(boardSlots(resolveMissionLayout(crpko, { ownerWaiting: 2 })))).toEqual([
      "figures",
      "Needs you",
      "lanes",
      "discussions",
      "Your requests",
      "Latest daily report",
      "Last 8 four-hour updates",
      "Sub-missions",
      "Path to milestone",
      "With the master",
    ]);
  });

  it("pins hidden Needs you while it holds items, and drops it when empty", () => {
    const hidden = snapshot([
      builtin("header-stats", "header"),
      builtin("needs-you", "rail", true),
      builtin("your-requests", "main"),
      custom("daily", "sec-daily"),
      builtin("path-to-milestone", "rail"),
    ]);
    expect(names(boardSlots(resolveMissionLayout(hidden, { ownerWaiting: 3 })))).toEqual([
      "figures",
      "pinned Needs you",
      "lanes",
      "discussions",
      "Your requests",
      "Latest daily report",
      "Path to milestone",
    ]);
    expect(
      names(boardSlots(resolveMissionLayout(hidden, { ownerWaiting: 0 }))).slice(0, 2),
    ).toEqual(["figures", "lanes"]);
  });

  it("pins unread requests when Your requests is hidden", () => {
    const hidden = snapshot([
      builtin("header-stats", "header"),
      builtin("needs-you", "rail"),
      builtin("your-requests", "main", true),
    ]);
    const slots = boardSlots(resolveMissionLayout(hidden, { requestsUnread: 1 }));
    expect(names(slots)).toEqual([
      "figures",
      "pinned Your requests",
      "Needs you",
      "lanes",
      "discussions",
    ]);
  });

  it("shows the figures only while the stats row is in the header", () => {
    const moved = snapshot([builtin("header-stats", "main"), builtin("needs-you", "rail")]);
    expect(names(boardSlots(resolveMissionLayout(moved)))).toEqual([
      "Needs you",
      "lanes",
      "discussions",
    ]);
    const hidden = snapshot([
      builtin("header-stats", "header", true),
      builtin("needs-you", "rail"),
    ]);
    expect(names(boardSlots(resolveMissionLayout(hidden)))[0]).toBe("Needs you");
  });

  it("keeps renamed titles", () => {
    const renamed = snapshot([
      builtin("header-stats", "header"),
      { ...builtin("your-requests", "main"), title: "Asks" },
      { ...custom("daily", "sec-daily"), title: "Daily" },
    ]);
    expect(names(boardSlots(resolveMissionLayout(renamed)))).toEqual([
      "figures",
      "lanes",
      "discussions",
      "Asks",
      "Daily",
    ]);
  });
});
