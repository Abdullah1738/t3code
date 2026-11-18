import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import {
  continuedLaunchRecovery,
  claudeRecoveryResult,
  isAutomaticClaudeRecovery,
  nextLaunchRecovery,
} from "./launchRecovery.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const base = () => ({
  thread: {
    lineage: { relationshipToParent: "subagent" },
    archivedAt: null,
    deletedAt: null,
  } as OrchestrationV2AppThread,
  run: {
    ordinal: 1,
    delegatedTaskId: "child",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-haiku-5-5" },
  } as OrchestrationV2Run,
  failure: {
    class: "provider_error",
    code: "model_not_found",
    category: "model_invalid",
    retryable: null,
    message: "selected model (claude-opus-4-8)",
    claudeAccess: { status: 401, beforeResponse: true, refusalFree: true, refused: false },
  } as OrchestrationV2ProviderFailure,
  driver: "claudeAgent",
  automated: false,
  text: "Work",
  jitter: 0.5,
});

describe("launch recovery exclusions", () => {
  it.each([
    "synthetic only",
    "unknown history",
    "refusal fallback",
    "refusal",
    "response received",
    "later turn",
    "other provider",
    "deleted",
    "user relay",
    "other 4xx",
    "mid-task recovery",
  ])("does not replay %s", (shape) => {
    const input = base();
    switch (shape) {
      case "synthetic only":
        input.failure = {
          ...input.failure,
          claudeAccess: { ...input.failure.claudeAccess!, status: null },
        };
        break;
      case "unknown history":
        input.failure = {
          ...input.failure,
          claudeAccess: { ...input.failure.claudeAccess!, refusalFree: false },
        };
        break;
      case "refusal fallback":
        input.failure = {
          ...input.failure,
          claudeAccess: { ...input.failure.claudeAccess!, refusalFree: false, refused: true },
        };
        break;
      case "refusal":
        input.failure = { ...input.failure, category: "content_filter" };
        break;
      case "response received":
        input.failure = {
          ...input.failure,
          claudeAccess: { ...input.failure.claudeAccess!, beforeResponse: false },
        };
        break;
      case "later turn":
        input.run = { ...input.run, ordinal: 2 };
        break;
      case "other provider":
        input.driver = "codex";
        break;
      case "deleted":
        input.thread = {
          ...input.thread,
          deletedAt: {} as NonNullable<OrchestrationV2AppThread["deletedAt"]>,
        };
        break;
      case "user relay":
        input.run = { ...input.run, ordinal: 2 };
        input.text = "Please relay: ready";
        break;
      case "other 4xx":
        input.failure = {
          ...input.failure,
          claudeAccess: { ...input.failure.claudeAccess!, status: 400 },
        };
        break;
      case "mid-task recovery":
        input.run = {
          ...input.run,
          transientRecovery: { firstError: input.failure, since: "2026-11-13T00:00:00Z" },
        };
        break;
    }
    expect(nextLaunchRecovery(input)).toBeUndefined();
  });
  it("retries a watcher wake with its original prompt only once", () => {
    const input = base();
    input.run = { ...input.run, ordinal: 2 };
    input.automated = true;
    input.text = "[Watcher event from a build] Ready";
    const first = nextLaunchRecovery(input)!;
    expect(first.modelSelection).toEqual(input.run.modelSelection);
    expect(first.recovery.delayMs).toBe(30_000);
    input.run = {
      ...input.run,
      launchRecovery: { ...first.recovery, since: "2026-11-13T00:00:00Z" },
    };
    expect(nextLaunchRecovery(input)).toBeUndefined();
  });
  it.each(["Work", "Please relay: ready", "[Watcher event from build] Ready"])(
    "does not open another recovery budget after silent recovery: %s",
    (text) => {
      const input = base();
      input.run = {
        ...input.run,
        delegatedTaskStallRecovery: {
          phase: "first_event",
          lastProgressAt: "2026-11-13T00:00:00Z",
          attemptId: null,
        },
      };
      input.automated = true;
      input.text = text;
      expect(isAutomaticClaudeRecovery("claudeAgent", input.run)).toBe(true);
      expect(nextLaunchRecovery(input)).toBeUndefined();
    },
  );
  it.each(
    ["[Watcher event from build] Ready", "Please relay: ready"].flatMap((text) =>
      [null, 401, 403, 404, 429].flatMap((status) =>
        [false, true].map((retryable) => ({ text, status, retryable })),
      ),
    ),
  )("honors the relay veto for $text/$status/$retryable", ({ text, status, retryable }) => {
    const input = base();
    input.automated = true;
    input.text = text;
    input.failure = {
      ...input.failure,
      category: "transient",
      code: "claude_network_error",
      retryable,
      claudeAccess: { status, beforeResponse: true, refusalFree: true, refused: false },
    };
    expect(nextLaunchRecovery(input)?.recovery.kind).toBe(retryable ? "relay" : undefined);
  });
});

it.each(["none", "older", "current"])(
  "only pending backoff keeps replay permission after restart: %s",
  (nativeTurn) => {
    const input = base();
    const source = {
      ...input.run,
      activeAttemptId: "attempt-current",
      launchRecovery: {
        kind: "model_access" as const,
        replayAllowed: true,
        retriesOnModel: 1,
        attempt: 1,
        delayMs: 30_000,
        since: "2026-11-13T00:00:00Z",
      },
    } as OrchestrationV2Run;
    const turns =
      nativeTurn === "none"
        ? []
        : [
            {
              runAttemptId:
                nativeTurn === "current"
                  ? source.activeAttemptId
                  : ("attempt-older" as OrchestrationV2Run["activeAttemptId"]),
            },
          ];
    const marker = continuedLaunchRecovery(source, turns)!;
    const resumed = { ...source, ordinal: 2, launchRecovery: marker };
    expect(marker.replayAllowed).toBe(nativeTurn !== "current");
    expect(nextLaunchRecovery({ ...input, run: resumed })?.modelSelection.model).toBe(
      nativeTurn === "current" ? undefined : "claude-sonnet-5-5",
    );
    expect(claudeRecoveryResult({ ...resumed, status: "completed" }, "Done").finishedOn).toBe(
      "claude-haiku-5-5",
    );
  },
);
