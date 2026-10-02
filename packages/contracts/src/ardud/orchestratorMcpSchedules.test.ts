import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { OrchestratorMcpScheduleTaskInput } from "../orchestratorMcp.ts";

const decode = Schema.decodeUnknownSync(OrchestratorMcpScheduleTaskInput);

describe("schedule_task MCP input", () => {
  it("accepts cron and once schedules as structured objects", () => {
    expect(
      decode({
        prompt: "Check the deploy.",
        schedule: { type: "cron", expression: "*/2 * * * *", timeZone: "Asia/Dubai" },
      }).schedule,
    ).toEqual({ type: "cron", expression: "*/2 * * * *", timeZone: "Asia/Dubai" });
    expect(
      decode({
        prompt: "Book the ride.",
        schedule: { type: "once", at: "2026-10-05T12:55:00+04:00", timeZone: "Asia/Dubai" },
      }).schedule.type,
    ).toBe("once");
  });

  it("accepts the JSON-string compatibility form", () => {
    expect(
      decode({
        prompt: "Check the deploy.",
        schedule: '{"type":"cron","expression":"0 9 * * 1-5","timeZone":"UTC"}',
      }).schedule,
    ).toEqual({ type: "cron", expression: "0 9 * * 1-5", timeZone: "UTC" });
  });

  it("rejects an invalid cron from an agent", () => {
    expect(() =>
      decode({
        prompt: "Check the deploy.",
        schedule: { type: "cron", expression: "every day", timeZone: "UTC" },
      }),
    ).toThrow();
  });
});
