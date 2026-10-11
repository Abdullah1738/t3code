import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
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

interface HarnessOptions {
  readonly subagentStatus?: string;
  readonly pendingBackgroundTasks?: number;
  readonly archived?: boolean;
  readonly detachDies?: boolean;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const calls: Array<string> = [];
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
      subagents: options.subagentStatus === undefined ? [] : [{ status: options.subagentStatus }],
      providerThreads: [
        {
          id: "provider-thread-active",
          pendingBackgroundTasks: Array.from(
            { length: options.pendingBackgroundTasks ?? 0 },
            (_, index) => ({ id: `task-${index}` }),
          ),
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
  const layer = ContextResetService.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords,
        sendToThread,
        dispatch,
      } as unknown as Partial<ThreadManagementService.ThreadManagementService["Service"]>),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { calls, sent, layer };
};

const reset = (scope: McpInvocationContext.McpInvocationScope) =>
  Effect.gen(function* () {
    const service = yield* ContextResetService.ContextResetService;
    return yield* service.reset(scope, { note: "resume note" });
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
      expect(harness.calls).toEqual([]);
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
