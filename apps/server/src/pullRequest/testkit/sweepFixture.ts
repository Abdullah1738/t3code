import {
  ProjectId,
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type PullRequestReviewCapabilities,
  type PullRequestReviewerCapabilities,
} from "@t3tools/contracts";
import type {
  PullRequestProviderApi,
  ProviderChangeRequest,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as PullRequestFilesViewed from "../../persistence/PullRequestFilesViewed.ts";
import * as PullRequestProviderRegistry from "../PullRequestProviderRegistry.ts";
import * as PullRequestReadCache from "../PullRequestReadCache.ts";
import * as PullRequestService from "../PullRequestService.ts";

const FULL_REVIEW: PullRequestReviewCapabilities = {
  inlineComment: true,
  reply: true,
  resolve: true,
  verdicts: ["comment", "approve", "request-changes"],
};

const FULL_REVIEWERS: PullRequestReviewerCapabilities = { request: true, listCandidates: true };

function fakeProvider(
  kind: SourceControlProviderKind,
  overrides: Partial<PullRequestProviderApi> = {},
): PullRequestProviderApi {
  return {
    kind,
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge", "ready", "draft", "close", "reopen"],
      mergeMethods: ["merge"],
      search: true,
      reactions: true,
      review: FULL_REVIEW,
      reviewers: FULL_REVIEWERS,
      edit: { changeRequest: true, comment: true },
    },
    getViewer: () => Effect.succeed("bilal"),
    getViewerPermissions: () =>
      Effect.succeed({
        actions: ["merge", "ready", "draft", "close", "reopen"],
        comment: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"],
        requestReviewers: true,
      }),
    listChangeRequests: () => Effect.succeed({ items: [], truncated: false, continues: true }),
    getChangeRequest: () => Effect.die("unused"),
    getChangeRequestActivity: () => Effect.die("unused"),
    getDiff: () => Effect.die("unused"),
    runAction: () => Effect.void,
    updateChangeRequest: () => Effect.void,
    comment: () => Effect.void,
    updateComment: () => Effect.void,
    submitReview: () => Effect.void,
    replyToThread: () => Effect.void,
    setThreadResolution: () => Effect.void,
    setReaction: () => Effect.void,
    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    setReviewerRequest: () => Effect.void,
    ...(kind === "github" ? { mergeMessageRewrite: (message: string) => message } : {}),
    ...(kind === "azure-devops"
      ? { repositoryKey: ({ canonicalKey }: { readonly canonicalKey: string }) => canonicalKey }
      : {}),
    ...overrides,
  };
}

function changeRequest(number: number, updatedAt: string): ProviderChangeRequest {
  return {
    number,
    title: `Change request ${number}`,
    url: `https://host/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    reviewRequestLogins: [],
    labels: [],
  };
}

function hostedChangeRequest(body: string, additions = 1) {
  return {
    ...changeRequest(1, "2026-07-02T00:00:00Z"),
    body,
    additions,
    changedFiles: 2,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    viewerPermissions: {
      actions: ["merge"] as const,
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"] as const,
      requestReviewers: true,
    },
  };
}

export const makeSweepFixture = Effect.fn("makeSweepFixture")(function* () {
  let listShells = 0;
  let gitSpawns = 0;
  const projects: OrchestrationProjectShell[] = Array.from({ length: 80 }, (_, index) => ({
    id: ProjectId.make(`sweep-${index}`),
    title: `Project ${index}`,
    workspaceRoot: `/repo/${index}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  }));
  const resolver = yield* RepositoryIdentityResolver.make().pipe(
    Effect.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.sync(() => {
            gitSpawns++;
            const cwd = input.args[1]!;
            const nonGit = Number(cwd.split("/").at(-1)) >= 60;
            return {
              stdout: nonGit
                ? ""
                : input.args.includes("remote")
                  ? cwd === "/repo/0"
                    ? "upstream\thttps://github.com/pingdotgg/t3code.git (fetch)\norigin\thttps://github.com/Abdullah1738/robob-mission-control.git (fetch)\n"
                    : `origin\thttps://github.com/acme/repo-${cwd.split("/").at(-1)}.git (fetch)\n`
                  : `${cwd}\n`,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(nonGit ? 1 : 0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
    ),
  );
  const enrich = (project: OrchestrationProjectShell) =>
    resolver
      .resolve(project.workspaceRoot)
      .pipe(Effect.map((repositoryIdentity) => ({ ...project, repositoryIdentity })));
  const provider = fakeProvider(SourceControlProviderKind.make("github"), {
    getChangeRequestSummary: ({ number }) =>
      Effect.succeed(changeRequest(number, "2026-07-02T00:00:00Z")),
    getChangeRequest: ({ number }) =>
      Effect.succeed({
        ...hostedChangeRequest(""),
        number,
        headSha: "head-1",
        headBranchSha: "head-1",
        checksHeadSha: "head-1",
        checks: [{ name: "test", status: "pending", required: true, description: null, url: null }],
      }),
    getChangeRequestStack: () => Effect.succeed(null),
    getChangeRequestActivity: () =>
      Effect.succeed({
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        reviewThreads: [],
        commits: [],
      }),
  });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      listShells: (options) =>
        Effect.sync(() => {
          listShells++;
          return projects.filter((p) => options?.projectIds?.includes(p.id) ?? true);
        }).pipe(Effect.flatMap((rows) => Effect.forEach(rows, enrich, { concurrency: 12 }))),
      getShell: (id) => {
        const project = projects.find((p) => p.id === id);
        return project === undefined
          ? Effect.succeed(Option.none())
          : enrich(project).pipe(Effect.map(Option.some));
      },
    }),
    Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, resolver),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.succeed(
      PullRequestProviderRegistry.PullRequestProviderRegistry,
      PullRequestProviderRegistry.fromProviders([provider]),
    ),
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => undefined,
    }),
    SourceControlRateLimit.layer,
    Layer.mock(PullRequestFilesViewed.PullRequestFilesViewedRepository)({}),
    Layer.mock(PullRequestReadCache.PullRequestReadCache)({
      get: (_key, lookup) => lookup,
      invalidate: () => Effect.void,
    }),
  );
  const service = yield* PullRequestService.make.pipe(Effect.provide(dependencies));
  return {
    service,
    resolver,
    projects,
    counts: () => ({ listShells, gitSpawns }),
    reset: () => {
      listShells = 0;
      gitSpawns = 0;
    },
  };
});
