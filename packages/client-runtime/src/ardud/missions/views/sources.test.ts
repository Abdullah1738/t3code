import {
  MissionId,
  RoleId,
  ViewDataSourceId,
  type ViewHistory,
  type ViewSourceListing,
  type ViewSourceRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  viewSourceCode,
  viewSourceItems,
  viewSourceRunInput,
  viewSourceToggleInput,
} from "./index.ts";

const T0 = "2026-10-19T08:00:00.000Z";
const missionId = MissionId.make("mission-1");

const meta = {
  version: 3,
  changedBy: { _tag: "role", roleId: RoleId.make("role-master") },
  by: "master",
  changedAt: T0,
  changeNote: null,
  catalogVersion: 1,
  status: "active",
  createdAt: T0,
  createdBy: "master",
} as const;

const listing = (id: string, title: string, patch: Partial<ViewSourceListing> = {}) =>
  ({
    id: ViewDataSourceId.make(id),
    missionId,
    title,
    runtime: "bash",
    fields: { result: "enum" },
    refreshMinutes: 15,
    timeoutSeconds: 30,
    enabled: true,
    ...meta,
    ...patch,
  }) as ViewSourceListing;

const run = (id: string, patch: Partial<ViewSourceRun> = {}): ViewSourceRun => ({
  sourceId: ViewDataSourceId.make(id),
  okAt: "2026-10-19T09:30:00.000Z",
  rows: 4,
  ranAt: "2026-10-19T09:30:00.000Z",
  durationMs: 800,
  error: null,
  running: false,
  ...patch,
});

describe("view sources list", () => {
  it("lists active sources by title with their last run", () => {
    const items = viewSourceItems({
      sources: [
        listing("src-pr", "PR queue"),
        listing("src-ci", "CI builds"),
        listing("src-old", "Old", { status: "removed" }),
      ],
      sourceRuns: [run("src-ci"), run("src-old")],
    });
    expect(items.map((item) => [item.title, item.rows, item.ranAt, item.status])).toEqual([
      ["CI builds", 4, "2026-10-19T09:30:00.000Z", null],
      ["PR queue", null, null, null],
    ]);
    expect(items.every((item) => item.canRun)).toBe(true);
  });

  it("marks off, running and failed sources", () => {
    const items = viewSourceItems({
      sources: [
        listing("src-a", "A", { enabled: false }),
        listing("src-b", "B"),
        listing("src-c", "C"),
        listing("src-d", "D"),
      ],
      sourceRuns: [
        run("src-a", { error: "boom" }),
        run("src-b", { running: true, error: "boom" }),
        run("src-c", { error: "exit 1" }),
        run("src-d", { okAt: null, rows: 0, error: "exit 1" }),
      ],
    });
    expect(items.map((item) => [item.title, item.status, item.canRun, item.rows])).toEqual([
      ["A", "off", false, 4],
      ["B", "running", false, 4],
      ["C", "failed", true, 4],
      ["D", "failed", true, null],
    ]);
    expect(items[2]?.error).toBe("exit 1");
  });

  it("builds refresh and toggle inputs against the listed version", () => {
    const [on, off] = viewSourceItems({
      sources: [listing("src-a", "A"), listing("src-b", "B", { enabled: false, version: 5 })],
    });
    expect(viewSourceRunInput(on!)).toEqual({ missionId, sourceId: "src-a" });
    expect(viewSourceToggleInput(on!)).toEqual({
      missionId,
      sourceId: "src-a",
      enabled: false,
      expectedVersion: 3,
    });
    expect(viewSourceToggleInput(off!)).toMatchObject({ enabled: true, expectedVersion: 5 });
  });

  it("reads the listed version's code from history", () => {
    const entry = (version: number, value: unknown) => ({
      ...meta,
      version,
      status: "active" as const,
      value,
    });
    const history: ViewHistory = {
      target: { _tag: "source", id: ViewDataSourceId.make("src-a") },
      entries: [entry(3, { code: "echo new" }), entry(2, { code: "echo old" })],
    };
    expect(viewSourceCode(history, 3)).toBe("echo new");
    expect(viewSourceCode(history, 2)).toBe("echo old");
    expect(viewSourceCode(history, 9)).toBeNull();
    expect(viewSourceCode({ ...history, entries: [entry(3, { code: 4 })] }, 3)).toBeNull();
  });
});
