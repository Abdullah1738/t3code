import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ContextResetService from "./ContextResetService.ts";

const threadId = ThreadId.make("thread-context-reset-test");
const projectId = ProjectId.make("project-context-reset-test");

const makeScope = (options: {
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly threadCaller?: boolean;
}): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-context-reset-test"),
  requestNamespace: "provider-session-context-reset-test",
  thread:
    options.threadCaller === false
      ? undefined
      : {
          threadId,
          providerSessionId: "provider-session-context-reset-test",
          providerInstanceId: ProviderInstanceId.make("opencode"),
        },
  client: undefined,
  capabilities: options.capabilities ?? new Set(["orchestration"]),
  issuedAt: 1,
});

interface SubagentFixture {
  readonly id?: string;
  readonly status: string;
  readonly origin?: "provider_native" | "app_owned";
  readonly title?: string | null;
  readonly nativeId?: string | null;
  readonly childThreadId?: string | null;
  readonly providerThreadId?: string | null;
  readonly startedAt?: string;
  readonly driver?: string;
}

interface RosterFixture {
  readonly taskId: string;
  readonly kind?: string;
  readonly description?: string;
  readonly childThreadId?: string;
}

interface HarnessOptions {
  readonly subagentStatus?: string;
  readonly subagents?: ReadonlyArray<SubagentFixture>;
  readonly pendingBackgroundTasks?: number;
  readonly roster?: ReadonlyArray<RosterFixture>;
  readonly archived?: boolean;
  readonly detachDies?: boolean;
  readonly interruptFails?: boolean;
}

const subagentRecord = (fixture: SubagentFixture, index: number) => ({
  id: fixture.id ?? `node:subagent-${index}`,
  status: fixture.status,
  origin: fixture.origin ?? "provider_native",
  driver: fixture.driver ?? "opencode",
  title: fixture.title === undefined ? `Subagent ${index}` : fixture.title,
  nativeTaskRef:
    fixture.nativeId === null
      ? null
      : { driver: "opencode", nativeId: fixture.nativeId ?? `toolu_${index}`, strength: "strong" },
  childThreadId: fixture.childThreadId ?? null,
  providerThreadId: fixture.providerThreadId ?? null,
  startedAt: fixture.startedAt === undefined ? null : DateTime.makeUnsafe(fixture.startedAt),
});

const makeHarness = (options: HarnessOptions = {}) => {
  const calls: Array<string> = [];
  const commandIds: Array<string> = [];
  const sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
  const getThreadRecords = vi.fn(() =>
    Effect.succeed({
      thread: {
        id: threadId,
        projectId,
        archivedAt: options.archived === true ? "2026-10-11T00:00:00.000Z" : null,
        deletedAt: null,
        activeProviderThreadId: "provider-thread-active",
      },
      subagents: [
        ...(options.subagentStatus === undefined ? [] : [{ status: options.subagentStatus }]),
        ...(options.subagents ?? []),
      ].map(subagentRecord),
      providerThreads: [
        {
          id: "provider-thread-active",
          pendingBackgroundTasks: [
            ...Array.from({ length: options.pendingBackgroundTasks ?? 0 }, (_, index) => ({
              taskId: `task-${index}`,
              kind: "command",
            })),
            ...(options.roster ?? []).map((task) => ({ kind: "subagent", ...task })),
          ],
        },
      ],
    }),
  );
  const sendToThread = vi.fn((input: ThreadManagementService.ThreadManagementSendInput) => {
    calls.push("send");
    sent.push(input);
    return Effect.succeed({ delivery: "queued" });
  });
  const dispatch = vi.fn((command: { readonly type: string }) => {
    calls.push(command.type);
    return options.detachDies === true
      ? Effect.die(new Error("detach failed"))
      : Effect.succeed({});
  });
  const stopDelegatedTasks = vi.fn((input: { readonly commandId: string }) => {
    calls.push("stopDelegatedTasks");
    commandIds.push(input.commandId);
    return Effect.void;
  });
  const interruptThread = vi.fn((input: { readonly commandId: string }) => {
    calls.push("interruptThread");
    commandIds.push(input.commandId);
    return options.interruptFails === true
      ? Effect.fail({ _tag: "InterruptFailed", message: "interrupt failed" } as const)
      : Effect.succeed({ type: "no_active_run" });
  });
  const layer = ContextResetService.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords,
        sendToThread,
        dispatch,
        stopDelegatedTasks,
        interruptThread,
      } as unknown as Partial<ThreadManagementService.ThreadManagementService["Service"]>),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { calls, commandIds, sent, layer };
};

const reset = (
  scope: McpInvocationContext.McpInvocationScope,
  options: { readonly cancelBackgroundWork?: boolean } = {},
) =>
  Effect.gen(function* () {
    const service = yield* ContextResetService.ContextResetService;
    return yield* service.reset(scope, { note: "resume note", ...options });
  });

describe("ContextResetService", () => {
  it.effect("queues the note on a fresh provider thread, then ends the current session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* reset(makeScope({}));
      expect(harness.calls).toEqual(["send", "provider-session.detach"]);
      expect(harness.sent[0]).toMatchObject({
        threadId,
        projectId,
        text: "resume note",
        mode: "queue",
        contextReset: true,
        createdBy: "agent",
        creationSource: "mcp",
      });
      expect(result.delivery).toBe("queued");
      expect(result.note).toContain("Context reset scheduled");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("still queues the note when the session cannot be detached", () => {
    const harness = makeHarness({ detachDies: true });
    return Effect.gen(function* () {
      const result = yield* reset(makeScope({}));
      expect(harness.calls).toEqual(["send", "provider-session.detach"]);
      expect(result.note).toContain("could not be ended");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses while a background subagent is running", () => {
    const harness = makeHarness({ subagentStatus: "running" });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(reset(makeScope({})));
      expect(error.code).toBe("invalid_request");
      expect(harness.calls).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses while the provider thread has pending background tasks", () => {
    const harness = makeHarness({ pendingBackgroundTasks: 2 });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(reset(makeScope({})));
      expect(error.code).toBe("invalid_request");
      expect(error.message).toContain("2 running background tasks");
      expect(error.message).toContain("cancelBackgroundWork: true");
      expect(harness.calls).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("names the running work in the refusal and counts a subagent once", () => {
    const harness = makeHarness({
      subagents: [
        {
          status: "running",
          title: "CRP-13347 facts + packet",
          nativeId: "toolu_live",
          childThreadId: "thread:child-live",
        },
      ],
      roster: [
        {
          taskId: "toolu_live",
          description: "CRP-13347 facts + packet",
          childThreadId: "thread:child-live",
        },
      ],
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(reset(makeScope({})));
      expect(error.message).toContain("1 running background task:");
      expect(error.message).toContain('subagent "CRP-13347 facts + packet" (toolu_live)');
      expect(error.message).toContain("cancelBackgroundWork: true");
      expect(harness.calls).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("says where each running child lives and since when, so it doesn't look lost", () => {
    const harness = makeHarness({
      subagents: [
        {
          status: "running",
          title: "Sol r2",
          nativeId: "toolu_sol",
          providerThreadId:
            "provider-thread:provider:opencode:provider-instance:opencode:native-thread:ses_e9b3d2a8fffe0SsrulM4Wva4Yn",
          childThreadId:
            "thread:provider:opencode:provider-instance:opencode:native-thread:ses_e9b3d2a8fffe0SsrulM4Wva4Yn",
          startedAt: "2026-10-22T17:57:30.876Z",
        },
        {
          id: "node:delegated",
          status: "running",
          origin: "app_owned",
          title: "Astra final",
          nativeId: null,
          childThreadId: "thread:delegated-task:astra",
        },
        {
          status: "running",
          driver: "muse",
          title: "Muse helper",
          nativeId: "muse_sub",
          // Muse puts the parent's provider thread here, not the child's.
          providerThreadId:
            "provider-thread:provider:muse:provider-instance:muse:native-thread:ses_parent",
          childThreadId: "thread:muse-child",
        },
        {
          status: "running",
          driver: "claudeAgent",
          title: "Claude task",
          nativeId: "toolu_claude",
          providerThreadId: "provider-thread:provider:claudeAgent:native-thread:toolu_claude",
          childThreadId: "thread:provider:claudeAgent:native-thread:toolu_claude",
        },
        {
          status: "running",
          driver: "cursor",
          title: "Cursor task",
          nativeId: "task_cursor",
          childThreadId: "thread:provider:cursor:native-thread:task_cursor",
        },
      ],
      roster: [{ taskId: "bash-1", kind: "command", description: "offbox run make test" }],
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(reset(makeScope({})));
      expect(error.message).toContain(
        'subagent "Sol r2" (toolu_sol), in session ses_e9b3d2a8fffe0SsrulM4Wva4Yn, running since 2026-10-22T17:57:30Z',
      );
      expect(error.message).toContain(
        'delegated task "Astra final" (node:delegated), in thread thread:delegated-task:astra, still running',
      );
      expect(error.message).toContain(
        'subagent "Muse helper" (muse_sub), in thread thread:muse-child, still running',
      );
      expect(error.message).toContain(
        'subagent "Claude task" (toolu_claude), in thread thread:provider:claudeAgent:native-thread:toolu_claude, still running',
      );
      expect(error.message).toContain(
        'subagent "Cursor task" (task_cursor), in thread thread:provider:cursor:native-thread:task_cursor, still running',
      );
      expect(error.message).not.toContain("ses_parent");
      expect(error.message).toContain('command "offbox run make test" (bash-1), still running');
      expect(error.message).toContain("They are alive, not lost.");
      expect(harness.calls).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ignores roster entries whose subagent already finished", () => {
    const harness = makeHarness({
      subagents: [
        { status: "interrupted", nativeId: "call_old", childThreadId: "thread:child-old" },
        { status: "completed", nativeId: "nested_done", childThreadId: "thread:child-nested" },
      ],
      roster: [
        { taskId: "call_old", childThreadId: "thread:child-old" },
        { taskId: "ses_parent:call_nested", childThreadId: "thread:child-nested" },
      ],
    });
    return Effect.gen(function* () {
      yield* reset(makeScope({}));
      expect(harness.calls).toEqual(["send", "provider-session.detach"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("still counts roster work it has no subagent for", () => {
    const harness = makeHarness({
      roster: [{ taskId: "bash-1", kind: "command", description: "offbox run make test" }],
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(reset(makeScope({})));
      expect(error.message).toContain('command "offbox run make test" (bash-1)');
      expect(harness.calls).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("with cancelBackgroundWork, stops the work, lists it in the note, then resets", () => {
    const harness = makeHarness({
      subagents: [
        { status: "running", title: "Review PR 296", nativeId: "toolu_a" },
        {
          id: "node:delegated",
          status: "running",
          origin: "app_owned",
          title: "Sol review r6",
          nativeId: null,
          childThreadId: "thread:delegated",
        },
      ],
      roster: [{ taskId: "bash-1", kind: "command", description: "offbox run make test" }],
    });
    return Effect.gen(function* () {
      const result = yield* reset(makeScope({}), { cancelBackgroundWork: true });
      expect(harness.calls).toEqual([
        "send",
        "stopDelegatedTasks",
        "interruptThread",
        "provider-session.detach",
      ]);
      const text = harness.sent[0]?.text ?? "";
      expect(text.startsWith("resume note")).toBe(true);
      expect(text).toContain("stopped the background work below");
      expect(text).toContain('- subagent "Review PR 296" (toolu_a)');
      expect(text).toContain('- delegated task "Sol review r6" (node:delegated)');
      expect(text).toContain('- command "offbox run make test" (bash-1)');
      expect(harness.commandIds.every((id) => id.includes("context-reset-stop"))).toBe(true);
      expect(result.note).toContain("Context reset scheduled");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "with cancelBackgroundWork, only stops delegated tasks when that is all there is",
    () => {
      const harness = makeHarness({
        subagents: [
          {
            status: "running",
            origin: "app_owned",
            nativeId: null,
            childThreadId: "thread:delegated",
          },
        ],
      });
      return Effect.gen(function* () {
        yield* reset(makeScope({}), { cancelBackgroundWork: true });
        expect(harness.calls).toEqual(["send", "stopDelegatedTasks", "provider-session.detach"]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "with cancelBackgroundWork and nothing running, resets without stopping anything",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* reset(makeScope({}), { cancelBackgroundWork: true });
        expect(harness.calls).toEqual(["send", "provider-session.detach"]);
        expect(harness.sent[0]?.text).toBe("resume note");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("still resets when stopping the background work fails, and says so", () => {
    const harness = makeHarness({
      subagents: [{ status: "running", nativeId: "toolu_a" }],
      interruptFails: true,
    });
    return Effect.gen(function* () {
      const result = yield* reset(makeScope({}), { cancelBackgroundWork: true });
      expect(harness.calls).toEqual(["send", "interruptThread", "provider-session.detach"]);
      expect(result.note).toContain("could not be stopped");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ignores finished subagents", () => {
    const harness = makeHarness({ subagentStatus: "completed" });
    return Effect.gen(function* () {
      yield* reset(makeScope({}));
      expect(harness.calls).toEqual(["send", "provider-session.detach"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses archived threads", () => {
    const harness = makeHarness({ archived: true });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(reset(makeScope({})));
      expect(error.code).toBe("thread_not_sendable");
      expect(harness.calls).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("needs the orchestration capability and a thread caller", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const denied = yield* Effect.flip(reset(makeScope({ capabilities: new Set(["preview"]) })));
      expect(denied.code).toBe("capability_denied");
      const outside = yield* Effect.flip(reset(makeScope({ threadCaller: false })));
      expect(outside.code).toBe("thread_credential_required");
      expect(harness.calls).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });
});
