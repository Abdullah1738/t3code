import { describe, expect, it } from "@effect/vitest";
import { ArdudScheduleImportItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  openChamberSchedule,
  openChamberTaskToImportItem,
  workspaceRootFromFileName,
} from "./openChamberTasks.ts";

describe("OpenChamber task mapping", () => {
  it("decodes the workspace root from the project file name", () => {
    expect(workspaceRootFromFileName("path_L1VzZXJzL2FyZHVk.json")).toBe("/Users/ardud");
    expect(
      workspaceRootFromFileName("path_L1ZvbHVtZXMvRXh0ZXJuYWxTU0QvY3Jwa28tZGV2b3Bz.json"),
    ).toBe("/Volumes/ExternalSSD/crpko-devops");
    expect(workspaceRootFromFileName("settings.json")).toBeNull();
  });

  it("maps cron schedules and their zone", () => {
    expect(
      openChamberSchedule({ kind: "cron", cron: "17 * * * *", timezone: "Asia/Dubai" }),
    ).toEqual({ type: "cron", expression: "17 * * * *", timeZone: "Asia/Dubai" });
  });

  it("maps one-time schedules to an instant with the zone offset", () => {
    expect(
      openChamberSchedule({
        kind: "once",
        date: "2026-10-05",
        time: "12:55",
        timezone: "Asia/Dubai",
      }),
    ).toEqual({ type: "once", at: "2026-10-05T12:55:00+04:00", timeZone: "Asia/Dubai" });
  });

  it("maps model, variant, title and enabled state into a valid import item", () => {
    const item = openChamberTaskToImportItem(
      {
        id: "abc",
        name: "Memory janitor review",
        enabled: false,
        schedule: { kind: "cron", cron: "0 9 * * *", timezone: "Asia/Dubai" },
        execution: {
          prompt: "Review memory.",
          providerID: "opus",
          modelID: "claude-opus-5-5",
          variant: "xhigh",
        },
      },
      "/Users/ardud",
    );
    expect(item).toMatchObject({
      sourceId: "abc",
      title: "Memory janitor review",
      enabled: false,
      workspaceRoot: "/Users/ardud",
      modelSelection: {
        instanceId: "opencode",
        model: "opus/claude-opus-5-5",
        options: [{ id: "variant", value: "xhigh" }],
      },
    });
    expect(() => Schema.decodeUnknownSync(ArdudScheduleImportItem)(item)).not.toThrow();
  });
});
