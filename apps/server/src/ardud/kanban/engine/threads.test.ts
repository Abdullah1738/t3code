import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { RuntimeRequestId } from "@t3tools/contracts";

import { backgroundWorkOf, viewStateOf } from "./threads.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const QUESTION_AT = "2026-10-25T00:10:00.000Z";
const FINISHED_AT = "2026-10-25T00:20:00.000Z";
const SHARED_UPDATED = "2026-10-25T00:50:00.000Z";

const shell = (overrides: Record<string, unknown>) => ({
  pendingRuntimeRequest: null,
  activityRunStatus: null,
  status: "idle" as const,
  updatedAt: at(SHARED_UPDATED),
  latestRunCompletedAt: null,
  ...overrides,
});

const question = (blocking: boolean | undefined) => ({
  id: RuntimeRequestId.make("req-1"),
  kind: "user_input" as const,
  createdAt: at(QUESTION_AT),
  ...(blocking === undefined ? {} : { blocking }),
});

describe("viewStateOf", () => {
  it("a blocking question stops the run: needs-input, quiet from the question", () => {
    const view = viewStateOf(
      shell({ pendingRuntimeRequest: question(true), activityRunStatus: "running" }),
    );
    expect(view.state).toBe("needs-input");
    expect(DateTime.formatIso(view.quietSince)).toBe(QUESTION_AT);
  });

  it("an async question never makes a running worker look quiet", () => {
    const view = viewStateOf(
      shell({
        pendingRuntimeRequest: question(false),
        activityRunStatus: "running",
        latestRunCompletedAt: at(FINISHED_AT),
      }),
    );
    expect(view.state).toBe("running");
    expect(DateTime.formatIso(view.quietSince)).toBe(FINISHED_AT);
  });

  it("an async question on an idle thread counts as no question: idle from the last finished run", () => {
    const view = viewStateOf(
      shell({ pendingRuntimeRequest: question(false), latestRunCompletedAt: at(FINISHED_AT) }),
    );
    expect(view.state).toBe("idle");
    expect(DateTime.formatIso(view.quietSince)).toBe(FINISHED_AT);
  });

  it("idle uses the last finished run, not the shared-session updatedAt", () => {
    const view = viewStateOf(shell({ latestRunCompletedAt: at(FINISHED_AT) }));
    expect(view.state).toBe("idle");
    expect(DateTime.formatIso(view.quietSince)).toBe(FINISHED_AT);
  });

  it("falls back to updatedAt only when no run ever finished", () => {
    const view = viewStateOf(shell({}));
    expect(DateTime.formatIso(view.quietSince)).toBe(SHARED_UPDATED);
  });

  it("an undefined blocking flag (older servers) is a blocking question", () => {
    const view = viewStateOf(shell({ pendingRuntimeRequest: question(undefined) }));
    expect(view.state).toBe("needs-input");
    expect(DateTime.formatIso(view.quietSince)).toBe(QUESTION_AT);
  });
});

describe("backgroundWorkOf", () => {
  it("counts subagents and background tasks, not commands or pull-request watches", () => {
    expect(
      backgroundWorkOf({
        pendingBackgroundTasks: [
          { taskId: "a", kind: "subagent" },
          { taskId: "b", kind: "background_task" },
          { taskId: "c", kind: "command" },
          { taskId: "pull-request-watch:github.com/x/y#1", kind: "monitor" },
        ],
      }),
    ).toBe(2);
  });

  it("is zero for an empty roster", () => {
    expect(backgroundWorkOf({ pendingBackgroundTasks: [] })).toBe(0);
  });

  it("is zero when the roster is missing (older shells)", () => {
    expect(backgroundWorkOf({})).toBe(0);
  });
});
