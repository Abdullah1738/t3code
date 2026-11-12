import {
  ProjectId,
  PullRequestOperationError,
  PullRequestUnavailableError,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type PullRequestUnavailableReason,
  type ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";

type WatchCommand = Extract<
  OrchestrationV2ServerCommand,
  { type: "thread.pull-request-watch.sync" }
>;

const makeHarness = Effect.fn("makeWatchFailureHarness")(function* (
  failure: PullRequestService.PullRequestError,
) {
  const commands: WatchCommand[] = [];
  let watch: ThreadPullRequestWatch | undefined = {
    startedAt: "2026-11-12T00:00:00.000Z",
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    passedPending: [],
    remarksThrough: "2026-11-12T00:00:00.000Z",
    remarkIds: [],
    conflicting: false,
    conflictHead: null,
    conflictWokeFor: null,
    wakes: 0,
  };
  const threadId = ThreadId.make("forgejo-watch");
  const dependencies = Layer.mergeAll(
    Layer.mock(PullRequestService.PullRequestService)({
      watchFingerprint: () => Effect.succeed(null),
      detail: () => Effect.fail(failure),
      activity: () => Effect.fail(failure),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadsWithPullRequests: () =>
        Effect.sync(() => [
          {
            id: threadId,
            projectId: ProjectId.make("forgejo-project"),
            lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
            settledOverride: null,
            settledAt: null,
            pullRequests: [
              {
                host: "forgejo.internal.jingmi.com.tw",
                repository: "abdullah/torssh",
                number: 9,
                url: "https://forgejo.internal.jingmi.com.tw/abdullah/torssh/pulls/9",
                source: "agent" as const,
                linkedAt: "2026-11-12T00:00:00.000Z",
                snapshot: null,
                stack: null,
                ...(watch === undefined ? {} : { watch }),
              },
            ],
          },
        ]),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        Effect.sync(() => {
          assert.strictEqual(command.type, "thread.pull-request-watch.sync");
          if (command.type === "thread.pull-request-watch.sync") {
            commands.push(command);
            watch = command.watch ?? undefined;
          }
          return { sequence: 1, storedEvents: [] };
        }),
    }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(1),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(dependencies));
  return { reactor, commands };
});

it.effect.each([
  "provider-unsupported",
  "cli-missing",
  "cli-unauthenticated",
] satisfies PullRequestUnavailableReason[])("ends an unavailable watch immediately: %s", (reason) =>
  Effect.gen(function* () {
    const { reactor, commands } = yield* makeHarness(new PullRequestUnavailableError({ reason }));
    yield* reactor.sweep;
    assert.strictEqual(commands.length, 1);
    assert.isNull(commands[0]!.watch);
    assert.include(commands[0]!.wake?.text ?? "", reason);
    assert.notInclude(commands[0]!.wake?.text ?? "", "8 times");
    yield* reactor.sweep;
    assert.strictEqual(commands.length, 1);
  }),
);

it.effect("retries transient host failures eight times and reports the last error", () =>
  Effect.gen(function* () {
    const { reactor, commands } = yield* makeHarness(
      new PullRequestOperationError({
        operation: "detail",
        detail: "Host unreachable: connection timed out",
      }),
    );
    for (let attempt = 0; attempt < 7; attempt++) yield* reactor.sweep;
    assert.deepStrictEqual(commands, []);
    yield* reactor.sweep;
    assert.strictEqual(commands.length, 1);
    assert.isNull(commands[0]!.watch);
    assert.include(commands[0]!.wake?.text ?? "", "8");
    assert.include(commands[0]!.wake?.text ?? "", "Host unreachable: connection timed out");
  }),
);

it.effect("keeps rate-limited watches without counting them as failed reads", () =>
  Effect.gen(function* () {
    const { reactor, commands } = yield* makeHarness(
      new PullRequestOperationError({
        operation: "detail",
        detail: "Rate limited",
        cause: new PullRequestProviderError({
          provider: SourceControlProviderKind.make("forgejo"),
          operation: "detail",
          reason: "rate-limited",
          detail: "Rate limited",
        }),
      }),
    );
    for (let attempt = 0; attempt < 9; attempt++) yield* reactor.sweep;
    assert.deepStrictEqual(commands, []);
  }),
);
