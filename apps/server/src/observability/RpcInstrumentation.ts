import { interruptionProps } from "./analyticsInterruption.ts";
import { actionIdAttributes } from "../ardud/observability/actionCorrelation.ts";
import {
  // ardud: missions board
  KANBAN_AGGREGATES,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type WsRpcGroup,
} from "@t3tools/contracts";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSchema from "effect/rpc/RpcSchema";
import type * as RpcSerialization from "effect/rpc/RpcSerialization";

import * as Analytics from "../ardud/analytics/Analytics.ts";
import { rpcRequestDuration, rpcRequestsTotal, withMetrics } from "./Metrics.ts";

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

/**
 * Trace queries and dashboards group by these labels, so they keep their historical values
 * even where they differ from the method prefix.
 */
const RPC_AGGREGATES = {
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: "orchestrationV2",
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: "orchestration",
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: "orchestration",
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: "orchestration",
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: "orchestration",
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: "orchestration",
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: "orchestration",
  [ORCHESTRATION_V2_WS_METHODS.searchThread]: "orchestration",
  [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: "orchestration",
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: "orchestration",
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: "orchestrationV2",
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: "orchestration",
  [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: "orchestration",
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: "orchestrationV2",
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: "orchestrationV2",
  [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: "orchestrationV2",
  [WS_METHODS.projectsMutate]: "orchestration",
  [WS_METHODS.serverProbe]: "server",
  [WS_METHODS.analyticsIngest]: "analytics",
  [WS_METHODS.serverGetConfig]: "server",
  [WS_METHODS.serverRefreshProviders]: "server",
  [WS_METHODS.serverUpdateProvider]: "server",
  [WS_METHODS.providerAuthStart]: "provider",
  [WS_METHODS.providerConsumeResetCredit]: "provider",
  [WS_METHODS.providerAuthComplete]: "provider",
  [WS_METHODS.chatGptReconnectProfile]: "provider",
  [WS_METHODS.chatGptImportProfile]: "provider",
  [WS_METHODS.chatGptHandoffSubscribe]: "provider",
  [WS_METHODS.codexAuthCallbackSubscribe]: "provider",
  [WS_METHODS.providerAuthRespond]: "provider",
  [WS_METHODS.providerAuthCancel]: "provider",
  [WS_METHODS.providerAuthLogout]: "provider",
  [WS_METHODS.providerAuthSubscribe]: "provider",
  [WS_METHODS.providerInstallStart]: "provider",
  [WS_METHODS.providerInstallCancel]: "provider",
  [WS_METHODS.providerInstallSubscribe]: "provider",
  [WS_METHODS.providerInstallRemove]: "provider",
  [WS_METHODS.serverUpdateServer]: "server",
  [WS_METHODS.serverUpdateServerWithProgress]: "server",
  [WS_METHODS.serverCommitDesktopUpdate]: "server",
  [WS_METHODS.serverUpsertKeybinding]: "server",
  [WS_METHODS.serverRemoveKeybinding]: "server",
  [WS_METHODS.serverRunStorageCleanup]: "server",
  [WS_METHODS.serverGetStorageCleanupReport]: "server",
  [WS_METHODS.serverGetDatabaseStorage]: "server",
  [WS_METHODS.serverGetSettings]: "server",
  [WS_METHODS.serverUpdateSettings]: "server",
  [WS_METHODS.serverSearchAcpRegistry]: "server",
  [WS_METHODS.serverPrepareAcpRegistryAgent]: "server",
  [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: "server",
  [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: "server",
  [WS_METHODS.serverListAcpRegistrySessions]: "server",
  [WS_METHODS.serverImportAcpRegistrySession]: "server",
  [WS_METHODS.serverDeleteAcpRegistrySession]: "server",
  [WS_METHODS.serverListAcpRegistryProviders]: "server",
  [WS_METHODS.serverSetAcpRegistryProvider]: "server",
  [WS_METHODS.serverDisableAcpRegistryProvider]: "server",
  [WS_METHODS.serverLogoutAcpRegistry]: "server",
  [WS_METHODS.serverDiscoverSourceControl]: "server",
  [WS_METHODS.serverGetTraceDiagnostics]: "server",
  [WS_METHODS.serverGetProcessDiagnostics]: "server",
  [WS_METHODS.serverGetHostResources]: "server",
  [WS_METHODS.serverGetProcessResourceHistory]: "server",
  [WS_METHODS.serverGetResourceTelemetryHistory]: "server",
  [WS_METHODS.serverRetryResourceTelemetry]: "server",
  [WS_METHODS.serverCheckOtlpEndpoint]: "server",
  [WS_METHODS.serverGetUsageSummary]: "server",
  [WS_METHODS.serverRefreshUsageRates]: "server",
  [WS_METHODS.serverSignalProcess]: "server",
  [WS_METHODS.serverReportClientActivity]: "server",
  [WS_METHODS.serverReportHostPowerState]: "server",
  [WS_METHODS.serverGetBackgroundPolicy]: "server",
  [WS_METHODS.scheduledTasksList]: "scheduledTasks",
  [WS_METHODS.scheduledTasksSubscribe]: "scheduledTasks",
  [WS_METHODS.scheduledTasksUpsert]: "scheduledTasks",
  [WS_METHODS.scheduledTasksSetEnabled]: "scheduledTasks",
  [WS_METHODS.scheduledTasksDelete]: "scheduledTasks",
  [WS_METHODS.scheduledTasksRunNow]: "scheduledTasks",
  [WS_METHODS.scheduledTasksRotateWebhookToken]: "scheduledTasks",
  [WS_METHODS.scheduledTasksListWebhookDeliveries]: "scheduledTasks",
  [WS_METHODS.scheduledTasksGetWebhookDelivery]: "scheduledTasks",
  [WS_METHODS.secretsAnswerRequest]: "secrets",
  [WS_METHODS.secretsAnswerAsk]: "secrets",
  [WS_METHODS.cloudGetRelayClientStatus]: "cloud",
  [WS_METHODS.cloudInstallRelayClient]: "cloud",
  [WS_METHODS.pullRequestsList]: "pull-requests",
  [WS_METHODS.pullRequestsListStats]: "pull-requests",
  [WS_METHODS.pullRequestsSummary]: "pull-requests",
  [WS_METHODS.pullRequestsRouting]: "pull-requests",
  [WS_METHODS.pullRequestsRoutingIdentity]: "pull-requests",
  [WS_METHODS.pullRequestsStack]: "pull-requests",
  [WS_METHODS.pullRequestsLinkedThreads]: "pull-requests",
  [WS_METHODS.pullRequestsDetail]: "pull-requests",
  [WS_METHODS.pullRequestsPreview]: "pull-requests",
  [WS_METHODS.pullRequestsChecks]: "pull-requests",
  [WS_METHODS.pullRequestsActivity]: "pull-requests",
  [WS_METHODS.pullRequestsReviewGuide]: "pull-requests",
  [WS_METHODS.pullRequestsGenerateReviewGuide]: "pull-requests",
  [WS_METHODS.pullRequestsThreadComments]: "pull-requests",
  [WS_METHODS.pullRequestsDiffFileContents]: "pull-requests",
  [WS_METHODS.pullRequestsFilesViewed]: "pull-requests",
  [WS_METHODS.pullRequestsRunAction]: "pull-requests",
  [WS_METHODS.pullRequestsUpdate]: "pull-requests",
  [WS_METHODS.pullRequestsComment]: "pull-requests",
  [WS_METHODS.pullRequestsUpdateComment]: "pull-requests",
  [WS_METHODS.pullRequestsSubmitReview]: "pull-requests",
  [WS_METHODS.pullRequestsReplyToThread]: "pull-requests",
  [WS_METHODS.pullRequestsSetThreadResolution]: "pull-requests",
  [WS_METHODS.pullRequestsSetReaction]: "pull-requests",
  [WS_METHODS.pullRequestsSetFilesViewed]: "pull-requests",
  [WS_METHODS.pullRequestsInvalidate]: "pull-requests",
  [WS_METHODS.pullRequestsReportState]: "pull-requests",
  [WS_METHODS.pullRequestsSubscribeRefreshes]: "pull-requests",
  [WS_METHODS.pullRequestsReviewerCandidates]: "pull-requests",
  [WS_METHODS.pullRequestsRequestReviewers]: "pull-requests",
  [WS_METHODS.pullRequestsLabelCandidates]: "pull-requests",
  [WS_METHODS.pullRequestsSetLabels]: "pull-requests",
  [WS_METHODS.sourceControlLookupRepository]: "source-control",
  [WS_METHODS.sourceControlCloneRepository]: "source-control",
  [WS_METHODS.sourceControlPublishRepository]: "source-control",
  [WS_METHODS.projectCloneStart]: "source-control",
  [WS_METHODS.projectCloneCancel]: "source-control",
  [WS_METHODS.projectCloneRetry]: "source-control",
  [WS_METHODS.subscribeProjectClones]: "source-control",
  [WS_METHODS.projectsListEntries]: "workspace",
  [WS_METHODS.projectsReadFile]: "workspace",
  [WS_METHODS.projectsSearchContents]: "workspace",
  [WS_METHODS.projectsSearchEntries]: "workspace",
  [WS_METHODS.projectsWriteFile]: "workspace",
  [WS_METHODS.projectsEnsureScratch]: "orchestration",
  [WS_METHODS.projectsCreateNew]: "orchestration",
  [WS_METHODS.shellOpenInEditor]: "workspace",
  [WS_METHODS.filesystemBrowse]: "workspace",
  [WS_METHODS.filesystemGetMetadata]: "workspace",
  [WS_METHODS.agentSessionsScan]: "workspace",
  [WS_METHODS.agentSessionsImport]: "workspace",
  [WS_METHODS.assetsCreateUrl]: "workspace",
  [WS_METHODS.assetsPersistChatAttachments]: "orchestration",
  [WS_METHODS.attachmentsCreateUploadUrl]: "workspace",
  [WS_METHODS.attachmentsDelete]: "workspace",
  [WS_METHODS.providerUploadFeedback]: "provider",
  [WS_METHODS.mcpAppsCallTool]: "provider",
  [WS_METHODS.mcpAppsToolInfo]: "provider",
  [WS_METHODS.mcpAppsUpdateModelContext]: "provider",
  [WS_METHODS.mcpAppsReadResource]: "provider",
  [WS_METHODS.subscribeVcsStatus]: "vcs",
  [WS_METHODS.subscribeWorktreeSetup]: "vcs",
  [WS_METHODS.worktreeSetupCancel]: "vcs",
  [WS_METHODS.subscribeResourceTelemetry]: "server",
  [WS_METHODS.vcsRefreshStatus]: "vcs",
  [WS_METHODS.vcsPull]: "git",
  [WS_METHODS.gitRunStackedAction]: "vcs",
  [WS_METHODS.gitResolvePullRequest]: "git",
  [WS_METHODS.gitPreparePullRequestThread]: "git",
  [WS_METHODS.vcsListRefs]: "vcs",
  [WS_METHODS.vcsCreateWorktree]: "vcs",
  [WS_METHODS.vcsRemoveWorktree]: "vcs",
  [WS_METHODS.vcsCreateRef]: "vcs",
  [WS_METHODS.vcsSwitchRef]: "vcs",
  [WS_METHODS.vcsInit]: "vcs",
  [WS_METHODS.reviewGetDiffPreview]: "review",
  [WS_METHODS.reviewGetDiffFileContents]: "review",
  [WS_METHODS.terminalOpen]: "terminal",
  [WS_METHODS.terminalAttach]: "terminal",
  [WS_METHODS.terminalObserve]: "terminal",
  [WS_METHODS.terminalWrite]: "terminal",
  [WS_METHODS.terminalResize]: "terminal",
  [WS_METHODS.terminalClear]: "terminal",
  [WS_METHODS.terminalRestart]: "terminal",
  [WS_METHODS.terminalClose]: "terminal",
  [WS_METHODS.subscribeTerminalEvents]: "terminal",
  [WS_METHODS.subscribeTerminalMetadata]: "terminal",
  [WS_METHODS.previewOpen]: "preview",
  [WS_METHODS.previewNavigate]: "preview",
  [WS_METHODS.previewResize]: "preview",
  [WS_METHODS.previewAdjust]: "preview",
  [WS_METHODS.previewRefresh]: "preview",
  [WS_METHODS.previewClose]: "preview",
  [WS_METHODS.previewList]: "preview",
  [WS_METHODS.previewClearProfile]: "preview",
  [WS_METHODS.previewReportProfiles]: "preview",
  [WS_METHODS.previewReportStatus]: "preview",
  [WS_METHODS.subscribePreviewEvents]: "preview",
  [WS_METHODS.subscribeDiscoveredLocalServers]: "preview",
  [WS_METHODS.deviceConfigure]: "device",
  [WS_METHODS.deviceTestHost]: "device",
  [WS_METHODS.deviceList]: "device",
  [WS_METHODS.deviceOpen]: "device",
  [WS_METHODS.deviceClose]: "device",
  [WS_METHODS.deviceShutdown]: "device",
  [WS_METHODS.deviceDetail]: "device",
  [WS_METHODS.deviceAction]: "device",
  [WS_METHODS.subscribeDeviceState]: "device",
  [WS_METHODS.subscribeServerConfig]: "server",
  [WS_METHODS.subscribeServerLifecycle]: "server",
  [WS_METHODS.subscribeAuthAccess]: "auth",
  [WS_METHODS.subscribeBackgroundPolicy]: "server",
  // ardud: missions board
  ...KANBAN_AGGREGATES,
} as const satisfies Readonly<Record<WsRpcMethod, string>>;

const RPC_SPAN_PREFIX = "ws.rpc";
const DEFAULT_RPC_SPAN_ATTRIBUTES = {
  "rpc.transport": "websocket",
  "rpc.system": "effect-rpc",
} as const;
const RPC_METHODS_WITH_TRACING_DISABLED: ReadonlySet<string> = new Set([
  WS_METHODS.serverGetTraceDiagnostics,
  WS_METHODS.serverGetProcessDiagnostics,
  WS_METHODS.serverGetProcessResourceHistory,
  WS_METHODS.serverSignalProcess,
]);

/**
 * `ws.ts` adds it to the server's group after `RpcScopeAuthorization`, so it wraps
 * authorization and also records rejected calls.
 */
export class RpcInstrumentation extends RpcMiddleware.Service<RpcInstrumentation>()(
  "t3/server/RpcInstrumentation",
) {}

export const AnalyticsOriginKind = Context.Reference<"owner" | "component" | "unknown">(
  "t3/observability/AnalyticsOriginKind",
  { defaultValue: () => "unknown" },
);

const recordingAnalytics = Context.Reference("t3/observability/RecordingAnalytics", {
  defaultValue: () => false,
});

export const safeAnalyticsLabel = (value: string, fallback: string): string =>
  value.length <= 160 && /^[a-zA-Z0-9_.:/#@%+-]*$/.test(value) ? value : fallback;

export const analyticsErrorTag = (cause: Cause.Cause<unknown>): string => {
  for (const reason of cause.reasons) {
    if (reason._tag === "Interrupt") continue;
    const error = reason._tag === "Fail" ? reason.error : reason.defect;
    if (typeof error === "object" && error !== null && "_tag" in error) {
      const tag = error._tag;
      if (typeof tag === "string" && /^[A-Z][a-zA-Z0-9]{0,79}Error$/.test(tag)) return tag;
    }
  }
  return Cause.hasDies(cause) ? "Defect" : Cause.hasInterrupts(cause) ? "Interrupted" : "Failure";
};

// Observation shares the request span and must never replace its exit, including defects.
export const recordServerAnalytics = (
  analytics: Analytics.Analytics["Service"],
  event: AnalyticsEvent,
) =>
  Effect.suspend(() => analytics.record(event)).pipe(
    Effect.provideService(recordingAnalytics, true),
    Effect.catchCause(() => Effect.void),
  );

/** Measures the already encoded envelope. The transport owns the callback's runtime. */
export const rpcAnalyticsSerialization = (
  serialization: RpcSerialization.RpcSerialization["Service"],
  record: (method: string, bytes: number) => void,
): RpcSerialization.RpcSerialization["Service"] => ({
  ...serialization,
  makeUnsafe: () => {
    const parser = serialization.makeUnsafe();
    const pending = new Map<string | number, { method: string; bytes: number }>();
    const report = (entry: { method: string; bytes: number }) => {
      try {
        record(entry.method, entry.bytes);
      } catch {
        /* Observers cannot change transport state. */
      }
    };
    return {
      decode: (data) => {
        const messages = parser.decode(data);
        for (const message of messages) {
          if (typeof message !== "object" || message === null || !("_tag" in message)) continue;
          if (
            message._tag === "Request" &&
            "id" in message &&
            "tag" in message &&
            (typeof message.id === "string" || typeof message.id === "number") &&
            typeof message.tag === "string" &&
            Object.hasOwn(RPC_AGGREGATES, message.tag) &&
            message.tag !== WS_METHODS.analyticsIngest
          ) {
            if (!pending.has(message.id) && pending.size >= 4096) {
              const oldest = pending.keys().next().value;
              if (oldest !== undefined) pending.delete(oldest);
            }
            pending.set(message.id, { method: message.tag, bytes: 0 });
          } else if (
            message._tag === "Interrupt" &&
            "requestId" in message &&
            (typeof message.requestId === "string" || typeof message.requestId === "number")
          ) {
            const entry = pending.get(message.requestId);
            pending.delete(message.requestId);
            if (entry !== undefined) report(entry);
          }
        }
        return messages;
      },
      encode: (response) => {
        const encoded = parser.encode(response);
        try {
          if (
            typeof response !== "object" ||
            response === null ||
            !("requestId" in response) ||
            !("_tag" in response) ||
            (typeof response.requestId !== "string" && typeof response.requestId !== "number")
          )
            return encoded;
          const entry = pending.get(response.requestId);
          if (entry !== undefined) {
            if (encoded !== undefined)
              entry.bytes = Math.min(
                Number.MAX_SAFE_INTEGER,
                entry.bytes +
                  (typeof encoded === "string"
                    ? Buffer.byteLength(encoded, "utf8")
                    : encoded.byteLength),
              );
            if (response._tag === "Exit") {
              pending.delete(response.requestId);
              report(entry);
            }
          }
        } catch {
          // Metadata observers cannot change a response or interrupt its stream.
        }
        return encoded;
      },
    };
  },
});

/** Captures unhandled defects; expected failures and log events have separate owners. */
export const layerServerAnalyticsErrors = Layer.unwrap(
  Effect.gen(function* () {
    const analytics = yield* Effect.serviceOption(Analytics.Analytics);
    if (Option.isNone(analytics)) return Layer.empty;
    const capture = (
      kind: string,
      cause: Cause.Cause<unknown>,
      fiber: import("effect/Fiber").Fiber<unknown, unknown>,
    ) => {
      if (fiber.getRef(recordingAnalytics)) return;
      const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
      const event: AnalyticsEvent = {
        ts: DateTime.formatIso(
          DateTime.makeUnsafe(fiber.getRef(Clock.Clock).currentTimeMillisUnsafe()),
        ),
        kind,
        surface: "server",
        route: "server",
        props: {
          errorTag: analyticsErrorTag(cause),
          ...interruptionProps(cause),
          span: span?._tag === "Span" ? safeAnalyticsLabel(span.name, "unknown") : "unknown",
          originKind: fiber.getRef(AnalyticsOriginKind),
        },
      };
      Effect.runForkWith(fiber.context)(recordServerAnalytics(analytics.value, event));
    };
    return ErrorReporter.layer(
      [
        {
          [ErrorReporter.TypeId]: ErrorReporter.TypeId,
          report: ({ cause, fiber }) => {
            const defects = cause.reasons.filter(
              (reason) => reason._tag === "Die" && !ErrorReporter.isIgnored(reason.defect),
            );
            if (defects.length > 0) capture("server.error", Cause.fromReasons(defects), fiber);
          },
        },
      ],
      { mergeWithExisting: true },
    );
  }),
);

export const rpcInstrumentationLayer = Layer.succeed(RpcInstrumentation)((
  effect,
  { rpc, headers, payload },
) => {
  const method = rpc._tag;
  const observed =
    method === WS_METHODS.analyticsIngest
      ? effect
      : Effect.gen(function* () {
          const analytics = yield* Effect.serviceOption(Analytics.Analytics);
          if (Option.isNone(analytics)) return yield* effect;
          const clock = yield* Clock.Clock;
          const started = clock.monotonicTimeNanosUnsafe();
          const originKind = yield* AnalyticsOriginKind;
          const entityIds: Partial<
            Record<"boardId" | "cardId" | "discussionId" | "threadId", string>
          > = {};
          if (typeof payload === "object" && payload !== null) {
            for (const key of ["boardId", "cardId", "discussionId", "threadId"] as const) {
              const descriptor = Object.getOwnPropertyDescriptor(payload, key);
              const value: unknown =
                descriptor && "value" in descriptor ? descriptor.value : undefined;
              if (typeof value === "string" && /^[a-zA-Z0-9_.:/#@%+-]{1,512}$/.test(value))
                entityIds[key] = value;
            }
          }
          return yield* effect.pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                yield* recordServerAnalytics(analytics.value, {
                  ts: DateTime.formatIso(yield* DateTime.now),
                  kind: "rpc.request",
                  ...entityIds,
                  surface: "server",
                  route: method,
                  durationMs: Math.max(0, Number(clock.monotonicTimeNanosUnsafe() - started) / 1e6),
                  props: {
                    method,
                    phase: RpcSchema.isStreamSchema(rpc.successSchema)
                      ? "stream-lifetime"
                      : "unary",
                    span: `${RPC_SPAN_PREFIX}.${method}`,
                    originKind,
                    ...(Exit.isFailure(exit)
                      ? {
                          errorTag: analyticsErrorTag(exit.cause),
                          ...interruptionProps(exit.cause),
                        }
                      : {}),
                  },
                });
              }),
            ),
          );
        });
  const measured = observed.pipe(
    withMetrics({ counter: rpcRequestsTotal, timer: rpcRequestDuration, attributes: { method } }),
    // ardud: WS RPCs come from the owner's clients (shell, thread, board and
    // discussion views, their actions): their reads use the foreground reader lane.
    NodeSqliteClient.foregroundReads,
  );

  if (RPC_METHODS_WITH_TRACING_DISABLED.has(method)) {
    return measured.pipe(Effect.provideService(References.TracerEnabled, false));
  }
  return measured.pipe(
    Effect.withSpan(`${RPC_SPAN_PREFIX}.${method}`, {
      attributes: {
        ...DEFAULT_RPC_SPAN_ATTRIBUTES,
        "rpc.method": method,
        ...actionIdAttributes(headers["x-robob-action-id"]),
        "rpc.aggregate": RPC_AGGREGATES[method as WsRpcMethod],
      },
    }),
  );
});
