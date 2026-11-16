import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  NodeId,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  PullRequestOperationError,
  PullRequestUnavailableError,
  SourceControlProviderKind,
  type PullRequestDetail,
  type OrchestrationProjectShell,
  type PullRequestRef,
  type PullRequestReviewGuideResult,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import type { Tool } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as McpDeadline from "../../McpDeadline.ts";
import * as McpCall from "../../../ardud/analytics/McpCall.ts";
import { listThreadPullRequests } from "./handlers.ts";
import * as PullRequestsHandlers from "./handlers.ts";
import { PullRequestLinkFailedError, PullRequestsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeProject(
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:T3Tools/T3Code.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "T3Tools/T3Code",
    owner: "T3Tools",
    name: "T3Code",
  },
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(pullRequests: ReadonlyArray<ThreadPullRequestLink>): PullRequestTestThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  };
}

function makeLink(
  number: number,
  overrides: Partial<ThreadPullRequestLink> & {
    readonly headBranch?: string;
    readonly baseBranch?: string;
  } = {},
): ThreadPullRequestLink {
  const { headBranch, baseBranch, ...rest } = overrides;
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      headBranch === undefined
        ? null
        : {
            state: "open",
            title: `PR ${number}`,
            headBranch,
            baseBranch: baseBranch ?? "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-08-27T00:00:00.000Z",
          },
    stack: null,
    ...rest,
  };
}

const watch = {
  startedAt: "2026-08-20T00:00:00.000Z",
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  passedPending: [],
  remarksThrough: "2026-08-20T00:00:00.000Z",
  remarkIds: [],
  conflicting: false,
  conflictHead: null,
  conflictWokeFor: null,
  wakes: 0,
};

interface HarnessOptions {
  readonly detail?: PullRequestService.PullRequestService["Service"]["detail"];
  readonly callerLayer?: Layer.Layer<ThreadManagement.ThreadManagementService>;
  readonly thread?: PullRequestTestThread | null;
  readonly project?: OrchestrationProjectShell | null;
  readonly reject?: (command: OrchestrationCommand) => string | null;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly dispatch?: Orchestrator.OrchestratorV2Shape["dispatch"];
  readonly getThreadShell?: Orchestrator.OrchestratorV2Shape["getThreadShell"];
  readonly getProjectShell?: () => Effect.Effect<Option.Option<OrchestrationProjectShell>>;
  readonly getGuide?: PullRequestReviewGuideService.PullRequestReviewGuideService["Service"]["get"];
  readonly generate?: (
    input: PullRequestRef,
  ) => Effect.Effect<
    PullRequestReviewGuideResult & { started: boolean },
    PullRequestOperationError
  >;
}

const READABLE_PR: PullRequestDetail = {
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
  headSha: "head-1",
  headBranchSha: "head-1",
  checksHeadSha: "head-1",
  baseBranch: "main",
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "lint", status: "success", required: true, description: null, url: null }],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
};

const NO_GUIDE: PullRequestReviewGuideResult = { guide: null, run: null, currentHeadSha: "head-1" };

const makeHarness = Effect.fn("makePullRequestsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const detailRequests = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const guideRequests = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const thread = options.thread === undefined ? makeThread([]) : options.thread;
  const project = options.project === undefined ? makeProject() : options.project;
  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null)
        return yield* new Orchestrator.OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: rejection,
        });
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1, storedEvents: [] };
    });
  const layerDependencies = Layer.mergeAll(
    Layer.mock(PullRequestService.PullRequestService)({
      detail: (input) =>
        Ref.update(detailRequests, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(options.detail?.(input) ?? Effect.succeed(READABLE_PR)),
        ),
    }),
    Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getShell: options.getProjectShell ?? (() => Effect.succeed(Option.fromNullishOr(project))),
      listShells: () => Effect.succeed(options.projects ?? (project ? [project] : [])),
    }),
    Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({
      get: options.getGuide ?? (() => Effect.succeed(NO_GUIDE)),
      generate: (input) =>
        Ref.update(guideRequests, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(
            options.generate?.(input) ??
              Effect.succeed({
                ...NO_GUIDE,
                run: {
                  _tag: "Running" as const,
                  headSha: "head-1",
                  startedAt: "2026-10-11T00:00:00.000Z",
                },
                started: true,
              }),
          ),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell:
        options.getThreadShell ??
        ((id) => Effect.succeed(id === THREAD_ID && thread ? v2PullRequestThread(thread) : null)),
      dispatch: options.dispatch ?? dispatch,
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
    options.callerLayer ?? McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* PullRequestsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(PullRequestsHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof PullRequestsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests"],
    scope: McpInvocationContext.McpInvocationScope = invocation(capabilities),
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PullRequestsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(layerDependencies),
    );
  return { commands, detailRequests, guideRequests, call };
});

describe("pull request toolkit handlers", () => {
  it.effect("links a delegated caller's PR while the background reader is pinned", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "delegated-pr-caller-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE entries(value INTEGER)`;
        yield* sql`INSERT INTO entries VALUES (1)`;
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT * FROM entries`;
              yield* Deferred.succeed(held, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(SqliteClient.readOnly, SqliteClient.backgroundReads, Effect.forkChild);
        yield* Deferred.await(held);
        let callerReads = 0;
        const harness = yield* makeHarness({
          callerLayer: Layer.mock(ThreadManagement.ThreadManagementService)({
            getCallerRow: (id) =>
              Effect.gen(function* () {
                expect(yield* SqliteClient.ReaderLane).toBe("identity");
                yield* sql
                  .withTransaction(sql`SELECT * FROM entries`)
                  .pipe(SqliteClient.readOnly, Effect.orDie);
                callerReads++;
                return {
                  ...McpToolAccessTestkit.liveThreadShell(id),
                  forkedFrom: { type: "node" as const, nodeId: NodeId.make("delegated-task") },
                };
              }),
            getThreadShell: () => Effect.die("live delegated caller must not load its full shell"),
          }),
        });
        yield* Effect.gen(function* () {
          const result = yield* harness.call("link_pull_request", {
            url: "https://github.com/t3tools/t3code/pull/123",
          });
          expect(result.alreadyLinked).toBe(false);
          expect(yield* Ref.get(harness.commands)).toMatchObject([
            {
              type: "thread.pull-request.link",
              threadId: THREAD_ID,
              number: 123,
            },
          ]);
          expect(callerReads).toBe(1);
          expect(yield* Deferred.isDone(release)).toBe(false);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(holder);
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename: path.join(directory, "state.sqlite"),
            readerWorker: true,
            identityReaderProcess: true,
            foregroundReaderSlots: 1,
            backgroundReaderSlots: 1,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a credential without the pull-requests capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_pull_requests", {}, ["preview"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "pull-requests",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links by URL with source agent on the token's thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
      });
      expect(result).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 123,
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.link",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 123,
          source: "agent",
        },
      ]);
    }),
  );

  it.effect.each(["cli-missing", "cli-unauthenticated", "provider-unsupported"] as const)(
    "watch preflight refuses an unavailable host (%s) without dispatching",
    (reason) =>
      Effect.gen(function* () {
        const thread = makeThread([makeLink(9)]);
        const unavailable = new PullRequestUnavailableError({
          reason,
          provider: SourceControlProviderKind.make("github"),
        });
        const harness = yield* makeHarness({ thread, detail: () => Effect.fail(unavailable) });
        const error = yield* harness
          .call("watch_pull_request", {
            url: "https://github.com/T3Tools/T3Code/pull/9/files",
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "PullRequestWatchUnavailableError",
          host: "github.com",
          reason,
        });
        expect(error.message).toContain(unavailable.message);
        expect(error.message).toContain(
          "The watch was not started; check the PR with your own tools instead.",
        );
        expect(yield* Ref.get(harness.commands)).toEqual([]);
        expect(thread.pullRequests?.[0]?.watch).toBeUndefined();
        expect(yield* Ref.get(harness.detailRequests)).toEqual([
          {
            projectId: PROJECT_ID,
            host: "github.com",
            repository: "t3tools/t3code",
            number: 9,
            allowStale: false,
          },
        ]);
      }),
  );

  it.effect("watch preflight registers despite a transient host read error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        detail: () =>
          Effect.fail(
            new PullRequestOperationError({ operation: "detail", detail: "Rate limited" }),
          ),
      });
      yield* harness.call("watch_pull_request", { repository: "t3tools/t3code", number: 9 });
      expect(yield* Ref.get(harness.detailRequests)).toHaveLength(1);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", watching: true },
      ]);
    }),
  );

  it.effect("watch preflight times out and still dispatches before the operation deadline", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        detail: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const pending = yield* harness
        .call("watch_pull_request", {
          repository: "t3tools/t3code",
          number: 9,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("3 seconds");
      expect(yield* Fiber.join(pending)).toMatchObject({ wasWatching: false });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", watching: true },
      ]);
    }),
  );

  it.effect.each(["ok", "unavailable", "skipped-error", "timeout"] as const)(
    "watch preflight records %s and logs only refusals",
    (outcome) =>
      Effect.gen(function* () {
        const spans: Tracer.NativeSpan[] = [];
        const logs: unknown[] = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const entered = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          detail: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              switch (outcome) {
                case "unavailable":
                  return yield* new PullRequestUnavailableError({ reason: "cli-missing" });
                case "skipped-error":
                  return yield* new PullRequestOperationError({
                    operation: "detail",
                    detail: "Rate limited",
                  });
                case "timeout":
                  return yield* Effect.never;
                case "ok":
                  return READABLE_PR;
              }
            }),
        });
        const pending = yield* harness
          .call("watch_pull_request", { repository: "t3tools/t3code", number: 9 })
          .pipe(
            Effect.result,
            Effect.withTracer(tracer),
            Effect.provide(
              Logger.layer([
                Logger.make(({ message }) => {
                  logs.push(message);
                }),
              ]),
            ),
            Effect.forkChild,
          );
        yield* Deferred.await(entered);
        if (outcome === "timeout") yield* TestClock.adjust("3 seconds");
        yield* Fiber.join(pending);
        expect(
          spans
            .find((span) => span.name === "PullRequestsToolkit.setWatching")
            ?.attributes.get("pullRequest.watch.preflight"),
        ).toBe(outcome);
        expect(logs).toEqual(
          outcome === "unavailable"
            ? [
                [
                  "pull request watch preflight refused",
                  {
                    host: "github.com",
                    repository: "t3tools/t3code",
                    number: 9,
                    reason: "cli-missing",
                    threadId: THREAD_ID,
                  },
                ],
              ]
            : [],
        );
      }),
  );

  it.effect("watching an unlinked pull request links it first", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("watch_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(result).toMatchObject({ number: 9, watching: false, wasWatching: false });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.watch",
          number: 9,
          watching: true,
          link: { url: "https://github.com/t3tools/t3code/pull/9", source: "agent" },
        },
      ]);
    }),
  );

  for (const tool of ["link_pull_request", "unlink_pull_request"] as const) {
    it.effect.each(["thread", "project", "dispatch", "masked dispatch"] as const)(
      `${tool} bounds a stalled $0 and reports whether a write may have started`,
      (stage) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const exited = yield* Deferred.make<void>();
          const blocked = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.ensuring(Deferred.succeed(exited, undefined)),
          );
          const shell = v2PullRequestThread(
            makeThread(tool === "unlink_pull_request" ? [makeLink(9)] : []),
          );
          const harness = yield* makeHarness({
            getThreadShell: () =>
              stage === "thread" ? blocked.pipe(Effect.as(shell)) : Effect.succeed(shell),
            getProjectShell: () =>
              stage === "project"
                ? blocked.pipe(Effect.as(Option.some(makeProject())))
                : Effect.succeed(Option.some(makeProject())),
            dispatch: () =>
              (stage === "masked dispatch" ? Effect.uninterruptible(blocked) : blocked).pipe(
                Effect.as({ sequence: 1, storedEvents: [] }),
              ),
          });
          const callState = McpCall.McpCall.of({
            callerResolved: true,
            callerResolveMs: 0,
            readerLane: "foreground",
            phase: "handler",
            saved: "unknown",
          });
          const pending = yield* harness
            .call(tool, { repository: "t3tools/t3code", number: 9 })
            .pipe(Effect.provideService(McpCall.McpCall, callState), Effect.flip, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust(McpDeadline.OPERATION_TIMEOUT);
          const saved = stage.includes("dispatch") ? "unknown" : false;
          const error = yield* Fiber.join(pending);
          expect(error).toMatchObject({ _tag: "PullRequestToolTimeoutError", tool, saved });
          expect(error.message).toContain("list_thread_pull_requests to check before retrying");
          expect(error.message).toContain("is safe (it is a no-op");
          expect(error.message).toContain(
            saved === false ? "Nothing was saved" : "may have been saved",
          );
          expect(callState).toMatchObject({
            saved,
            phase: stage.includes("dispatch") ? "dispatch" : "handler",
          });
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(exited);
        }),
    );

    it.effect.each(["same thread", "other thread", "oauth"] as const)(
      `${tool} includes an explicit target's $0 access checks in its deadline`,
      (credential) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const target = credential === "same thread" ? THREAD_ID : ThreadId.make("target-thread");
          let permissionReads = 0;
          let handlerReads = 0;
          const blocked = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          const scope =
            credential === "oauth"
              ? {
                  ...invocation(["pull-requests"]),
                  thread: undefined,
                  client: { sessionId: "session", label: "test", access: "full-access" as const },
                }
              : invocation(["pull-requests"]);
          const harness = yield* makeHarness({
            callerLayer: Layer.mock(ThreadManagement.ThreadManagementService)({
              getCallerRow: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
              getThreadShell: () => {
                permissionReads++;
                return blocked;
              },
            }),
            getThreadShell: () => {
              handlerReads++;
              return blocked;
            },
          });
          const pending = yield* harness
            .call(
              tool,
              {
                threadId: target,
                repository: "t3tools/t3code",
                number: 9,
              },
              ["pull-requests"],
              scope,
            )
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust(McpDeadline.OPERATION_TIMEOUT);
          expect(yield* Fiber.join(pending)).toMatchObject({
            _tag: "PullRequestToolTimeoutError",
            tool,
            saved: false,
          });
          expect(permissionReads).toBe(credential === "same thread" ? 0 : 1);
          expect(handlerReads).toBe(credential === "same thread" ? 1 : 0);
          expect(yield* Ref.get(harness.commands)).toEqual([]);
        }),
    );
  }

  it.effect.each(["implicit", "explicit"] as const)(
    "list bounds a stalled thread read with an %s target",
    (target) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          getThreadShell: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const pending = yield* harness
          .call(
            "list_thread_pull_requests",
            target === "explicit" ? { threadId: ThreadId.make("other-thread") } : {},
          )
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust(McpDeadline.OPERATION_TIMEOUT);
        const error = yield* Fiber.join(pending);
        expect(error).toMatchObject({
          _tag: "PullRequestToolTimeoutError",
          tool: "list_thread_pull_requests",
          saved: false,
        });
        expect(error.message).toContain("Server busy, nothing changed; retry shortly");
        expect(yield* Ref.get(harness.commands)).toEqual([]);
      }),
  );

  it.effect.each(["write_pull_request_guides", "read_pull_request_guide"] as const)(
    "%s bounds its caller thread lookup",
    (tool) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          getThreadShell: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const target = { repository: "t3tools/t3code", number: 9 };
        const pending = yield* (
          tool === "write_pull_request_guides"
            ? harness.call(tool, { pullRequests: [target] }).pipe(Effect.asVoid)
            : harness.call(tool, target).pipe(Effect.asVoid)
        ).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust(McpDeadline.OPERATION_TIMEOUT);
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "PullRequestToolTimeoutError",
          tool,
          saved: false,
        });
        expect(yield* Ref.get(harness.guideRequests)).toEqual([]);
      }),
  );

  it.effect("guide reads bound the stored-guide service too", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        getGuide: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const pending = yield* harness
        .call("read_pull_request_guide", {
          repository: "t3tools/t3code",
          number: 9,
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(McpDeadline.OPERATION_TIMEOUT);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "PullRequestToolTimeoutError",
        tool: "read_pull_request_guide",
        saved: false,
      });
    }),
  );

  it.effect.each(["link_pull_request", "unlink_pull_request"] as const)(
    "%s keeps the remaining budget after a target permission read",
    (tool) =>
      Effect.gen(function* () {
        const target = ThreadId.make("target-thread");
        const permissionStarted = yield* Deferred.make<void>();
        const finishPermission = yield* Deferred.make<void>();
        const handlerStarted = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          callerLayer: Layer.mock(ThreadManagement.ThreadManagementService)({
            getCallerRow: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getThreadShell: () =>
              Deferred.succeed(permissionStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishPermission)),
                Effect.as(McpToolAccessTestkit.liveThreadShell(target)),
              ),
          }),
          getThreadShell: () =>
            Deferred.succeed(handlerStarted, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const pending = yield* harness
          .call(tool, {
            threadId: target,
            repository: "t3tools/t3code",
            number: 9,
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(permissionStarted);
        yield* TestClock.adjust("6 seconds");
        yield* Deferred.succeed(finishPermission, undefined);
        yield* Deferred.await(handlerStarted);
        yield* TestClock.adjust("4 seconds");
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "PullRequestToolTimeoutError",
          tool,
          saved: false,
        });
        expect(yield* Ref.get(harness.commands)).toEqual([]);
      }),
  );

  it.effect("guide generation timeout says runs may have started", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        generate: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const pending = yield* harness
        .call("write_pull_request_guides", {
          pullRequests: [{ repository: "t3tools/t3code", number: 9 }],
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(McpDeadline.OPERATION_TIMEOUT);
      const error = yield* Fiber.join(pending);
      expect(error).toMatchObject({
        _tag: "PullRequestToolTimeoutError",
        tool: "write_pull_request_guides",
        saved: "unknown",
      });
      expect(error.message).toContain(
        "read_pull_request_guide for each pull request before retrying",
      );
    }),
  );

  it.effect("re-watching preserves the existing watch without dispatching or reading back", () =>
    Effect.gen(function* () {
      let reads = 0;
      const shell = v2PullRequestThread(makeThread([makeLink(9, { watch })]));
      const harness = yield* makeHarness({
        getThreadShell: () => {
          reads++;
          return reads === 1 ? Effect.succeed(shell) : Effect.die("unexpected read-back");
        },
      });
      expect(
        yield* harness.call("watch_pull_request", {
          url: "https://github.com/T3Tools/T3Code/pull/9/files",
        }),
      ).toMatchObject({ number: 9, watching: true, wasWatching: true, alreadyWatching: true });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
      expect(reads).toBe(1);
      expect(yield* Ref.get(harness.detailRequests)).toEqual([]);
    }),
  );

  it.effect.each(["unlinked", "linked", "dismissed"] as const)(
    "unwatching an unwatched $0 PR does not dispatch",
    (state) =>
      Effect.gen(function* () {
        const links =
          state === "unlinked"
            ? []
            : [
                makeLink(
                  9,
                  state === "dismissed"
                    ? {
                        source: "stack-dismissed",
                        watch,
                      }
                    : {},
                ),
              ];
        const harness = yield* makeHarness({ thread: makeThread(links) });
        expect(
          yield* harness.call("unwatch_pull_request", {
            repository: "t3tools/t3code",
            number: 9,
          }),
        ).toMatchObject({ watching: false, wasWatching: false, alreadyUnwatched: true });
        expect(yield* Ref.get(harness.commands)).toEqual([]);
      }),
  );

  it.effect("watching a dismissed link still dispatches to make it visible", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(9, { source: "stack-dismissed", watch })]),
      });
      yield* harness.call("watch_pull_request", { repository: "t3tools/t3code", number: 9 });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", watching: true },
      ]);
    }),
  );

  for (const tool of ["watch_pull_request", "unwatch_pull_request"] as const) {
    it.effect.each(["thread", "project", "dispatch", "masked dispatch", "result"] as const)(
      `${tool} bounds a stalled $0 with one deadline`,
      (stage) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const exited = yield* Deferred.make<void>();
          const blocked = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.ensuring(Deferred.succeed(exited, undefined)),
          );
          const shell = v2PullRequestThread(
            makeThread(tool === "unwatch_pull_request" ? [makeLink(9, { watch })] : []),
          );
          let reads = 0;
          const harness = yield* makeHarness({
            getThreadShell: () => {
              reads++;
              return stage === "thread" || (stage === "result" && reads === 2)
                ? blocked.pipe(Effect.as(shell))
                : Effect.succeed(shell);
            },
            getProjectShell: () =>
              stage === "project"
                ? blocked.pipe(Effect.as(Option.some(makeProject())))
                : Effect.succeed(Option.some(makeProject())),
            dispatch: () =>
              (stage === "dispatch" || stage === "masked dispatch"
                ? stage === "masked dispatch"
                  ? Effect.uninterruptible(blocked)
                  : blocked
                : Effect.void
              ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
          });
          const pending = yield* harness
            .call(tool, {
              repository: "t3tools/t3code",
              number: 9,
            })
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust(McpDeadline.OPERATION_TIMEOUT);
          const error = yield* Fiber.join(pending);
          const saved = stage === "result" ? true : stage.includes("dispatch") ? "unknown" : false;
          expect(error).toMatchObject({ _tag: "PullRequestWatchTimeoutError", saved });
          expect(error.message).toContain(
            "list_thread_pull_requests to check watching before retrying",
          );
          expect(error.message).toContain("Do not call unwatch_pull_request");
          expect(error.message).toContain(
            saved === true
              ? "was saved"
              : saved === false
                ? "Nothing was saved"
                : "may have been saved",
          );
          // Release masked cleanup only after proving the timeout response did not wait for it.
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(exited);
        }),
    );
  }

  for (const tool of ["watch_pull_request", "unwatch_pull_request"] as const) {
    it.effect.each(["same thread", "other thread", "oauth"] as const)(
      `${tool} bounds an explicit target for $0 credentials`,
      (credential) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const target = credential === "same thread" ? THREAD_ID : ThreadId.make("target-thread");
          let permissionReads = 0;
          let handlerReads = 0;
          const blocked = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          const scope =
            credential === "oauth"
              ? {
                  ...invocation(["pull-requests"]),
                  requestNamespace: "client:session",
                  thread: undefined,
                  client: { sessionId: "session", label: "test", access: "full-access" as const },
                }
              : invocation(["pull-requests"]);
          const harness = yield* makeHarness({
            callerLayer: Layer.mock(ThreadManagement.ThreadManagementService)({
              getCallerRow: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
              getThreadShell: () => {
                permissionReads++;
                return blocked;
              },
            }),
            getThreadShell: () => {
              handlerReads++;
              return blocked;
            },
          });
          const pending = yield* harness
            .call(
              tool,
              {
                threadId: target,
                repository: "t3tools/t3code",
                number: 9,
              },
              ["pull-requests"],
              scope,
            )
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust(McpDeadline.OPERATION_TIMEOUT);
          expect(yield* Fiber.join(pending)).toMatchObject({
            _tag: "PullRequestWatchTimeoutError",
            saved: false,
          });
          expect(permissionReads).toBe(credential === "same thread" ? 0 : 1);
          expect(handlerReads).toBe(credential === "same thread" ? 1 : 0);
          expect(yield* Ref.get(harness.commands)).toEqual([]);
        }),
    );
  }

  it.effect.each(["watch_pull_request", "unwatch_pull_request"] as const)(
    "%s preserves the OAuth write permission check",
    (tool) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const error = yield* harness
          .call(
            tool,
            {
              threadId: THREAD_ID,
              repository: "t3tools/t3code",
              number: 9,
            },
            ["pull-requests"],
            {
              ...invocation(["pull-requests"]),
              thread: undefined,
              client: { sessionId: "session", label: "test", access: "read-only" },
            },
          )
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "capability_denied" });
        expect(yield* Ref.get(harness.commands)).toEqual([]);
      }),
  );

  it.effect.each(["thread", "oauth"] as const)(
    "keeps the remaining budget after a $0 target permission read",
    (credential) =>
      Effect.gen(function* () {
        const target = ThreadId.make("target-thread");
        const permissionStarted = yield* Deferred.make<void>();
        const finishPermission = yield* Deferred.make<void>();
        const handlerStarted = yield* Deferred.make<void>();
        const scope =
          credential === "oauth"
            ? {
                ...invocation(["pull-requests"]),
                thread: undefined,
                client: { sessionId: "session", label: "test", access: "full-access" as const },
              }
            : invocation(["pull-requests"]);
        const harness = yield* makeHarness({
          callerLayer: Layer.mock(ThreadManagement.ThreadManagementService)({
            getCallerRow: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getThreadShell: () =>
              Deferred.succeed(permissionStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishPermission)),
                Effect.as(McpToolAccessTestkit.liveThreadShell(target)),
              ),
          }),
          getThreadShell: () =>
            Deferred.succeed(handlerStarted, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const pending = yield* harness
          .call(
            "watch_pull_request",
            {
              threadId: target,
              repository: "t3tools/t3code",
              number: 9,
            },
            ["pull-requests"],
            scope,
          )
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(permissionStarted);
        yield* TestClock.adjust("6 seconds");
        yield* Deferred.succeed(finishPermission, undefined);
        yield* Deferred.await(handlerStarted);
        yield* TestClock.adjust("4 seconds");
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "PullRequestWatchTimeoutError",
          saved: false,
        });
        expect(yield* Ref.get(harness.commands)).toEqual([]);
      }),
  );

  it.effect("shares one timeout budget between lookup and a never-completing dispatch", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>();
      const finishRead = yield* Deferred.make<void>();
      const dispatchStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        getThreadShell: () =>
          Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishRead)),
            Effect.as(v2PullRequestThread(makeThread([]))),
          ),
        dispatch: () =>
          Deferred.succeed(dispatchStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const pending = yield* harness
        .call("watch_pull_request", {
          repository: "t3tools/t3code",
          number: 9,
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(readStarted);
      yield* TestClock.adjust("6 seconds");
      yield* Deferred.succeed(finishRead, undefined);
      yield* Deferred.await(dispatchStarted);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "PullRequestWatchTimeoutError",
        saved: "unknown",
      });
    }),
  );

  it.effect("refuses to watch a merged pull request and stops an existing watch", () =>
    Effect.gen(function* () {
      const merged = makeLink(1, { headBranch: "done" });
      const harness = yield* makeHarness({
        thread: makeThread([
          {
            ...merged,
            watch,
            snapshot: merged.snapshot && { ...merged.snapshot, state: "merged" },
          },
          makeLink(2, { headBranch: "idle" }),
          makeLink(3, { headBranch: "watched", watch }),
        ]),
      });
      const error = yield* harness
        .call("watch_pull_request", { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestNotOpenError", state: "merged" });
      expect(
        yield* harness.call("unwatch_pull_request", { repository: "t3tools/t3code", number: 3 }),
      ).toMatchObject({ wasWatching: true });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", number: 3, watching: false },
      ]);
    }),
  );

  it.effect("watches a pull request saved as closed, since it may have reopened", () =>
    Effect.gen(function* () {
      const closed = makeLink(1, { headBranch: "closed" });
      const harness = yield* makeHarness({
        thread: makeThread([
          { ...closed, snapshot: closed.snapshot && { ...closed.snapshot, state: "closed" } },
        ]),
      });
      yield* harness.call("watch_pull_request", { repository: "t3tools/t3code", number: 1 });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", number: 1, watching: true },
      ]);
    }),
  );

  it.effect("refuses a watch from a subagent thread, whose parent owns the pull request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: {
          ...makeThread([makeLink(1, { headBranch: "feature", watch })]),
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        },
      });
      const error = yield* harness
        .call("watch_pull_request", { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestWatchFromSubagentError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links by repository and number, defaulting the host to the project's", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_pull_request", {
        repository: "T3Tools/Other",
        number: 7,
      });
      expect(result).toEqual({
        host: "github.com",
        repository: "t3tools/other",
        number: 7,
        url: "https://github.com/t3tools/other/pull/7",
        alreadyLinked: false,
      });
    }),
  );

  it.effect("builds the URL in the project host's own shape", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "gitlab.com/group/sub/project",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@gitlab.com:group/sub/project.git",
          },
          provider: "gitlab",
          displayName: "group/sub/project",
        }),
      });
      const result = yield* harness.call("link_pull_request", {
        repository: "group/sub/project",
        number: 42,
      });
      expect(result.url).toBe("https://gitlab.com/group/sub/project/-/merge_requests/42");
      expect(result.host).toBe("gitlab.com");
    }),
  );

  it.effect("links a numeric Forgejo reference with its remote's web origin and mount path", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "forge.example/git/owner/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "http://forge.example:3000/git/owner/repo.git",
          },
          provider: "forgejo",
          displayName: "git/owner/repo",
        }),
      });
      const result = yield* harness.call("link_pull_request", {
        repository: "git/owner/repo",
        number: 42,
      });
      expect(result).toEqual({
        host: "forge.example:3000",
        repository: "git/owner/repo",
        number: 42,
        url: "http://forge.example:3000/git/owner/repo/pulls/42",
        alreadyLinked: false,
      });
      const other = yield* harness.call("link_pull_request", {
        host: "other.example",
        repository: "owner/repo",
        number: 42,
      });
      expect(other.url).toBe("https://other.example/owner/repo/pull/42");
    }),
  );

  it.effect("links Azure DevOps Server URLs and numeric references without a known provider", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "scm.example.test/tfs/collection/project/_git/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "http://dummy:secret@scm.example.test:8080/tfs/Collection/Project/_git/Repo",
          },
          provider: "unknown",
          displayName: "tfs/collection/project/_git/repo",
        }),
      });
      const generated =
        "http://scm.example.test:8080/tfs/collection/project/_git/repo/pullrequest/124";
      const fromNumber = yield* harness.call("link_pull_request", {
        repository: "tfs/Collection/Project/_git/Repo",
        number: 124,
      });
      expect.soft(fromNumber.url).toBe(generated);

      const supplied = "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/123";
      const fromUrl = yield* harness.call("link_pull_request", { url: supplied });
      expect(fromUrl).toEqual({
        host: "scm.example.test",
        repository: "tfs/collection/project/_git/repo",
        number: 123,
        url: supplied,
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.link", number: 124, url: generated },
        { type: "thread.pull-request.link", number: 123, url: supplied },
      ]);
    }),
  );

  it.effect("rejects a target that names neither a URL nor repository and number", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("link_pull_request", { repository: "x/y" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestTargetIncompleteError" });
      const unknown = yield* harness
        .call("link_pull_request", {
          url: "https://github.com/t3tools/t3code/issues/1?token=private-value",
        })
        .pipe(Effect.flip);
      expect(unknown).toMatchObject({ _tag: "PullRequestUrlInvalidError" });
      expect(unknown.message).not.toContain("private-value");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("treats a duplicate link as alreadyLinked rather than an error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(123)]),
        reject: (command) =>
          command.type === "thread.pull-request.link" ? "already linked" : null,
      });
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/123",
      });
      expect(result.alreadyLinked).toBe(true);
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("unlinks a linked pull request and reports a missing one as wasLinked=false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(5)]),
        reject: (command) =>
          command.type === "thread.pull-request.unlink" && command.number !== 5
            ? "not linked"
            : null,
      });
      const linked = yield* harness.call("unlink_pull_request", {
        repository: "t3tools/t3code",
        number: 5,
      });
      expect(linked).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 5,
        wasLinked: true,
      });
      const missing = yield* harness.call("unlink_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(missing.wasLinked).toBe(false);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.unlink", number: 5 },
      ]);
    }),
  );

  it("reports an older Forgejo link's HTTP port when listing thread links", () => {
    const result = listThreadPullRequests(
      makeThread([
        makeLink(42, {
          host: "forge.example",
          url: "http://forge.example:3000/t3tools/t3code/pulls/42",
        }),
      ]),
    );
    expect(result.pullRequests[0]?.host).toBe("forge.example:3000");
  });

  it.effect("fails cleanly when the token's thread no longer exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ thread: null });
      const error = yield* harness.call("list_thread_pull_requests", {}).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestThreadNotFoundError", threadId: THREAD_ID });
    }),
  );

  it.effect("lists visible links with host state and derived chain order", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([
          makeLink(3, { headBranch: "feat-c", baseBranch: "feat-b", source: "agent" }),
          makeLink(1, { headBranch: "feat-a", baseBranch: "main", source: "created" }),
          makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a", source: "agent" }),
          makeLink(9, { source: "stack-dismissed" }),
          makeLink(10),
        ]),
      });
      const result = yield* harness.call("list_thread_pull_requests", {});
      expect(result.pullRequests.map((entry) => entry.number)).toEqual([3, 1, 2, 10]);
      expect(result.pullRequests[0]).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 3,
        url: "https://github.com/t3tools/t3code/pull/3",
        source: "agent",
        watching: false,
        state: "open",
        title: "PR 3",
        headBranch: "feat-c",
        baseBranch: "feat-b",
        isDraft: false,
        stack: { kind: "derived", position: 3, size: 3 },
      });
      expect(result.pullRequests[3]).toMatchObject({
        number: 10,
        state: null,
        title: null,
        headBranch: null,
        stack: null,
      });
      expect(result.chains).toEqual([
        { kind: "derived", numbers: [1, 2, 3] },
        { kind: "derived", numbers: [10] },
      ]);
    }),
  );
});

describe("listThreadPullRequests", () => {
  it("reports a native stack position for each member", () => {
    const stack = {
      kind: "native" as const,
      id: "stack-1",
      number: 1,
      url: "https://github.com/t3tools/t3code/stack/1",
      base: "main",
      layers: [
        { number: 1, headBranch: "a", state: "open" as const },
        { number: 2, headBranch: "b", state: "open" as const },
      ],
    };
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(2, { stack, source: "stack" }),
        makeLink(1, { stack, source: "created" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [2, { kind: "native", position: 2, size: 2 }],
      [1, { kind: "native", position: 1, size: 2 }],
    ]);
    expect(result.chains).toEqual([{ kind: "native", numbers: [1, 2] }]);
  });

  it("gives pull requests built on the same one the same position", () => {
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(1, { headBranch: "feat-a", baseBranch: "main" }),
        makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a" }),
        makeLink(3, { headBranch: "feat-c", baseBranch: "feat-a" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [1, { kind: "derived", position: 1, size: 3 }],
      [2, { kind: "derived", position: 2, size: 3 }],
      [3, { kind: "derived", position: 2, size: 3 }],
    ]);
    expect(result.chains).toEqual([{ kind: "derived", numbers: [1, 2, 3] }]);
  });
});

describe("pull request guide tools", () => {
  it.effect(
    "writes guides through the project whose checkout is each pull request's repository",
    () =>
      Effect.gen(function* () {
        const other = {
          ...makeProject({
            canonicalKey: "github.com/acme/web",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:acme/web.git",
            },
            provider: SourceControlProviderKind.make("github"),
            displayName: "acme/web",
            owner: "acme",
            name: "web",
          }),
          id: ProjectId.make("project-web"),
        };
        const harness = yield* makeHarness({ projects: [makeProject(), other] });
        const result = yield* harness.call("write_pull_request_guides", {
          pullRequests: [
            { url: "https://github.com/acme/web/pull/7" },
            { repository: "t3tools/t3code", number: 12 },
            { url: "https://github.com/someone/else/pull/1" },
          ],
        });
        expect(
          result.guides.map((guide) => [guide.repository, guide.number, guide.outcome]),
        ).toEqual([
          ["acme/web", 7, "started"],
          ["t3tools/t3code", 12, "started"],
          ["someone/else", 1, "failed"],
        ]);
        expect(result.guides[2]?.detail).toContain("No project in this environment");
        expect(
          (yield* Ref.get(harness.guideRequests)).map((ref) => [ref.projectId, ref.number]),
        ).toEqual([
          ["project-web", 7],
          [PROJECT_ID, 12],
        ]);
      }),
  );

  it.effect("reports a refused run on its own pull request without failing the rest", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        generate: (input) =>
          input.number === 1
            ? Effect.fail(
                new PullRequestOperationError({
                  operation: "generateReviewGuide",
                  detail: "Review guides are off. Turn them on in Settings → Source Control.",
                }),
              )
            : Effect.succeed({
                ...NO_GUIDE,
                run: {
                  _tag: "Running" as const,
                  headSha: "head-1",
                  startedAt: "2026-10-11T00:00:00.000Z",
                },
                started: true,
              }),
      });
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [
          { repository: "t3tools/t3code", number: 1 },
          { repository: "t3tools/t3code", number: 2 },
        ],
      });
      expect(result.guides.map((guide) => [guide.number, guide.outcome, guide.detail])).toEqual([
        [1, "failed", "Review guides are off. Turn them on in Settings → Source Control."],
        [2, "started", null],
      ]);
    }),
  );

  it.effect("reports an unreadable entry on its own and still writes the rest of the batch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [
          { url: "https://example.com/not-a-pull-request" },
          { repository: "t3tools/t3code" },
          { repository: "t3tools/t3code", number: 5 },
        ],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["failed", "failed", "started"]);
      expect(result.guides[0]?.detail).toContain("not a recognised pull request URL");
      expect(result.guides[1]?.detail).toContain("Pass either url");
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.number)).toEqual([5]);
    }),
  );

  it.effect("reports a run the service joined as running, not as a new one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        generate: () =>
          Effect.succeed({
            ...NO_GUIDE,
            run: { _tag: "Running", headSha: "head-1", startedAt: "2026-10-11T00:00:00.000Z" },
            started: false,
          }),
      });
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [{ repository: "t3tools/t3code", number: 4 }],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["running"]);
    }),
  );

  it.effect("finds an Azure DevOps checkout for a pull request named by its full path", () =>
    Effect.gen(function* () {
      const azure = {
        ...makeProject({
          canonicalKey: "dev.azure.com/org/project/_git/web",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://dev.azure.com/org/project/_git/web",
          },
          provider: "azure-devops",
          displayName: "org/project/_git/web",
          owner: "org",
          name: "web",
        }),
        id: ProjectId.make("project-azure"),
      };
      const harness = yield* makeHarness({ projects: [makeProject(), azure] });
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [{ host: "dev.azure.com", repository: "org/project/_git/web", number: 9 }],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["started"]);
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.projectId)).toEqual([
        "project-azure",
      ]);
    }),
  );

  it.effect("reads a stored guide and says when a push left it behind", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("read_pull_request_guide", {
        repository: "t3tools/t3code",
        number: 3,
      });
      expect(result).toMatchObject({ number: 3, guide: null, run: null, stale: false });
    }),
  );
});

it("keeps failure diagnostics as the cause rather than exposing them in the tool message", () => {
  const cause = new Error("database internals");
  const failure = new PullRequestLinkFailedError({ cause });
  expect(failure.message).toBe("Could not link the pull request.");
  expect(failure.cause).toBe(cause);
});
