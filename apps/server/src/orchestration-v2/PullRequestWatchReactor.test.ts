import {
  ProjectId,
  PullRequestOperationError,
  PullRequestUnavailableError,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type PullRequestUnavailableReason,
  type ThreadPullRequestWatch,
  type PullRequestDetail,
  type PullRequestComment,
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
  reads: Pick<PullRequestService.PullRequestService["Service"], "detail" | "activity">,
  initial: Partial<ThreadPullRequestWatch> = {},
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
    ...initial,
  };
  const threadId = ThreadId.make("forgejo-watch");
  const dependencies = Layer.mergeAll(
    Layer.mock(PullRequestService.PullRequestService)({
      watchFingerprint: () => Effect.succeed(null),
      ...reads,
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
  return { reactor, commands, watch: () => watch };
});

const makeFailureHarness = (failure: PullRequestService.PullRequestError) =>
  makeHarness({ detail: () => Effect.fail(failure), activity: () => Effect.fail(failure) });

const OLD_HEAD = "26c6f35d7159c82612104351874d54c27803a1a4";
const NEW_HEAD = "048997af62bdaaf497040824233c8f75202d5209";
const greenDetail = (): PullRequestDetail & {
  headBranchSha: string | null;
  checksHeadSha: string | null;
} => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: ProjectId.make("forgejo-project"),
  projectTitle: "Watch",
  workspaceRoot: "/workspace/watch",
  repository: "acme/web",
  number: 9,
  title: "Watched PR",
  body: "",
  url: "https://github.com/acme/web/pull/9",
  author: null,
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  headSha: OLD_HEAD,
  headBranchSha: NEW_HEAD,
  checksHeadSha: OLD_HEAD,
  baseBranch: "main",
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "lint", status: "success", required: true, description: null, url: null }],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
});

const makeHeadHarness = (initial: Partial<ThreadPullRequestWatch> = {}) => {
  let detail = greenDetail();
  let comments: PullRequestComment[] = [];
  let reads = 0;
  return makeHarness(
    {
      detail: () =>
        Effect.sync(() => {
          reads++;
          return detail;
        }),
      activity: () =>
        Effect.sync(() => ({
          comments,
          commentCount: comments.length,
          commentsTruncated: false,
          reviewThreads: [],
          commits: [],
        })),
    },
    { headSha: OLD_HEAD, ...initial },
  ).pipe(
    Effect.map((harness) => ({
      ...harness,
      setDetail: (next: typeof detail) => {
        detail = next;
      },
      setComments: (next: PullRequestComment[]) => {
        comments = next;
      },
      reads: () => reads,
    })),
  );
};

it.effect.each(["success", "failure"] as const)(
  "holds %s checks while the PR head lags the branch, then reports the new head once",
  (status) =>
    Effect.gen(function* () {
      const harness = yield* makeHeadHarness();
      const stale = greenDetail();
      harness.setDetail({ ...stale, checks: stale.checks.map((check) => ({ ...check, status })) });
      const before = harness.watch();
      yield* harness.reactor.sweep;
      assert.deepStrictEqual(harness.commands, []);
      assert.deepStrictEqual(harness.watch(), before);
      harness.setDetail({ ...stale, headSha: NEW_HEAD, checksHeadSha: NEW_HEAD });
      yield* harness.reactor.sweep;
      assert.strictEqual(harness.reads(), 2);
      assert.strictEqual(harness.commands.length, 1);
      assert.include(harness.commands[0]!.wake?.text ?? "", "passed on 048997a");
      yield* harness.reactor.sweep;
      assert.strictEqual(harness.commands.length, 1);
    }),
);

it.effect("holds a rollup from a different commit even when the branch and PR agree", () =>
  Effect.gen(function* () {
    const harness = yield* makeHeadHarness();
    harness.setDetail({ ...greenDetail(), headBranchSha: OLD_HEAD, checksHeadSha: NEW_HEAD });
    yield* harness.reactor.sweep;
    assert.deepStrictEqual(harness.commands, []);
  }),
);

it.effect("keeps a new required check from growing the reported gate on a settling head", () =>
  Effect.gen(function* () {
    const harness = yield* makeHeadHarness({ passed: true, passedChecks: ["test"] });
    yield* harness.reactor.sweep;
    assert.deepStrictEqual(harness.commands, []);
    assert.deepStrictEqual(harness.watch()?.passedChecks, ["test"]);
  }),
);

it.effect("still reports green checks when the branch ref cannot be read", () =>
  Effect.gen(function* () {
    const harness = yield* makeHeadHarness();
    harness.setDetail({ ...greenDetail(), headBranchSha: null });
    yield* harness.reactor.sweep;
    assert.strictEqual(harness.commands.length, 1);
    assert.include(harness.commands[0]!.wake?.text ?? "", "passed on 26c6f35");
  }),
);

it.effect("reports remarks without recording check state on a settling head", () =>
  Effect.gen(function* () {
    const harness = yield* makeHeadHarness({ headSha: null, passedPending: ["test"] });
    const before = harness.watch()!;
    harness.setComments([
      {
        id: "comment",
        kind: "review-comment",
        author: { login: "reviewer", name: null, avatarUrl: null },
        body: "Please check this",
        createdAt: "2026-11-12T00:01:00.000Z",
        url: "https://github.com/acme/web/pull/9#discussion",
        path: "a.ts",
        reviewState: null,
      },
    ]);
    yield* harness.reactor.sweep;
    assert.strictEqual(harness.commands.length, 1);
    assert.include(harness.commands[0]!.wake?.text ?? "", "new comment");
    assert.notInclude(harness.commands[0]!.wake?.text ?? "", "passed");
    const next = harness.watch()!;
    for (const field of [
      "headSha",
      "failedChecks",
      "passed",
      "passedChecks",
      "passedPending",
    ] as const) {
      assert.deepStrictEqual(next[field], before[field]);
    }
  }),
);

it.effect.each([
  "provider-unsupported",
  "cli-missing",
  "cli-unauthenticated",
] satisfies PullRequestUnavailableReason[])("ends an unavailable watch immediately: %s", (reason) =>
  Effect.gen(function* () {
    const { reactor, commands } = yield* makeFailureHarness(
      new PullRequestUnavailableError({ reason }),
    );
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
    const { reactor, commands } = yield* makeFailureHarness(
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
    const { reactor, commands } = yield* makeFailureHarness(
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
