import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { backgroundWorkOf, KanbanThreads, layer, viewStateOf } from "./threads.ts";

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

it.effect("a keyed send passes stable command and message ids to thread management", () =>
  Effect.gen(function* () {
    const sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
    const threadId = ThreadId.make("thread-wake");
    const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({ projectId: ProjectId.make("project-1"), deletedAt: null } as never),
      sendToThread: (input) =>
        Effect.sync(() => {
          sent.push(input);
          return {} as never;
        }),
    });
    yield* Effect.gen(function* () {
      const threads = yield* KanbanThreads;
      yield* threads.send({ threadId, text: "Back", key: "wake:abc" });
      yield* threads.send({ threadId, text: "Back", key: "wake:abc" });
      yield* threads.send({ threadId, text: "Unkeyed" });
      yield* threads.send({ threadId, text: "Unkeyed" });
      expect(sent[0]?.commandId).toBe("kanban:send:wake:abc");
      expect(sent[0]?.messageId).toBe("kanban:wake:abc");
      expect(sent[1]?.commandId).toBe(sent[0]?.commandId);
      expect(sent[1]?.messageId).toBe(sent[0]?.messageId);
      expect(sent[2]?.commandId).not.toBe(sent[3]?.commandId);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(management),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        ),
      ),
    );
  }),
);
