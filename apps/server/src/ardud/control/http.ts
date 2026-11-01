/**
 * Local control API for external integrations (iMessage and Telegram bridges,
 * crw, CLIs). Thin wrappers over the services the WebSocket RPC and the T3 MCP
 * tools already use; see README.md next to this file for the contract.
 */
import {
  AttachmentCreateUploadUrlInput,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RunAttemptId,
  RunId,
  RuntimeMode,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { issueAttachmentUploadUrl } from "../../assets/AttachmentUpload.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import { userFacingDispatchErrorMessage } from "../../orchestration-v2/UserFacingErrors.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ControlStore from "./ControlStore.ts";
import * as ExecutionIdentity from "../identity/ExecutionIdentity.ts";
import { archiveIfIdle } from "../archive-if-idle/archiveIfIdle.ts";
import {
  GUIDANCE_MAX_CHARS,
  guidanceContext,
  guidanceFits,
  isBridgeSession,
} from "../imessage/guidance.ts";
import { CONTROL_ACTOR, controlActor, telegramAnswerOwner } from "./actor.ts";
import {
  formatModel,
  lastAssistantText,
  messageSummary,
  modelSelectionFrom,
  parseSince,
  pendingRequestSummary,
  runSummary,
  runsNewestFirst,
  selectionMigrationApplies,
  selectionProblem,
  shellSummary,
  stateFromRuns,
  stateFromShell,
  TERMINAL_RUN_STATUSES,
  type ControlThreadState,
} from "./model.ts";
import { messagePreview, runToolEvidence } from "./evidence.ts";

export const CONTROL_ROUTE_PREFIX = "/api/ardud/control";
const SSE_HEARTBEAT = Duration.seconds(15);
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_WAIT_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Errors and responses
// ---------------------------------------------------------------------------

type ControlErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "internal";

class ControlError extends Data.TaggedError("ControlError")<{
  readonly code: ControlErrorCode;
  readonly message: string;
}> {}

const STATUS: Record<ControlErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

const fail = (code: ControlErrorCode, message: string) => new ControlError({ code, message });

/** A merged selection, or the conflict as a 400: a stale effort is never silently picked. */
const selectionOrFail = (
  result:
    | { readonly kind: "selection"; readonly selection: ModelSelection }
    | { readonly kind: "conflict"; readonly reason: string },
) =>
  result.kind === "selection"
    ? Effect.succeed(result.selection)
    : Effect.fail(fail("invalid_request", result.reason));

const errorDetail = (cause: unknown): string =>
  userFacingDispatchErrorMessage(cause) ?? (cause instanceof Error ? cause.message : String(cause));

// ardud: the reaper retries a conflict later, so only the orchestrator's own
// refusals count as one. Its rejections carry a text cause; a storage or read
// failure carries the failure itself.
const archiveFailureCode = (
  cause:
    | Effect.Error<ReturnType<typeof archiveIfIdle>>
    | ServerRuntimeStartup.ServerRuntimeStartupError,
): ControlErrorCode => {
  switch (cause._tag) {
    case "ServerRuntimeStartupError":
      return "unavailable";
    case "OrchestratorDispatchError":
      return typeof cause.cause === "string" ? "conflict" : "internal";
    case "OrchestratorThreadAlreadyExistsError":
    case "OrchestratorCommandRejectedError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "ThreadManagementProviderInstanceDisabledError":
      return "conflict";
    default:
      return "internal";
  }
};

const NO_STORE = { "cache-control": "no-store" } as const;

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const errorResponse = (error: ControlError) =>
  json({ ok: false, error: { code: error.code, message: error.message } }, STATUS[error.code]);

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type Scope = typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope;

const searchParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
});

const param = (name: string) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const value = params[name];
    if (value === undefined || value.length === 0) {
      return yield* fail("invalid_request", `Missing path parameter ${name}.`);
    }
    // The router already percent-decodes path parameters.
    return value;
  });

const decodeBody = <A>(decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text.pipe(
      Effect.mapError(() => fail("invalid_request", "Unable to read the request body.")),
    );
    const raw =
      text.trim().length === 0
        ? {}
        : yield* decodeJsonText(text).pipe(
            Effect.mapError(() => fail("invalid_request", "The request body is not valid JSON.")),
          );
    return yield* decode(raw).pipe(
      Effect.mapError((error) => fail("invalid_request", error.message)),
    );
  });

const clampInt = (raw: string | null, fallback: number, max: number) => {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
};

const boolParam = (raw: string | null): boolean | undefined =>
  raw === null ? undefined : raw === "" || raw === "1" || raw === "true";

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const OptionalString = Schema.optional(Schema.String);
const ModelOptions = Schema.optional(Schema.Array(ProviderOptionSelection));
const Attachment = Schema.Struct({
  attachmentId: Schema.String,
  type: Schema.optional(Schema.Literals(["image", "file"])),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
});
type Attachment = typeof Attachment.Type;

const CreateThreadBody = Schema.Struct({
  projectId: OptionalString,
  directory: OptionalString,
  scratch: Schema.optional(Schema.Boolean),
  title: OptionalString,
  prompt: OptionalString,
  model: OptionalString,
  variant: Schema.optional(Schema.NullOr(Schema.String)),
  providerInstanceId: OptionalString,
  options: ModelOptions,
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  worktree: Schema.optional(
    Schema.Struct({
      baseRef: Schema.String,
      branch: OptionalString,
      startFromOrigin: Schema.optional(Schema.Boolean),
    }),
  ),
  origin: OptionalString,
  attachments: Schema.optional(Schema.Array(Attachment)),
  clientRequestId: OptionalString,
});

const SendBody = Schema.Struct({
  text: Schema.String,
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  model: OptionalString,
  variant: Schema.optional(Schema.NullOr(Schema.String)),
  providerInstanceId: OptionalString,
  options: ModelOptions,
  attachments: Schema.optional(Schema.Array(Attachment)),
  clientRequestId: OptionalString,
  // The iMessage bridge still sends the relayed message's id; it is accepted and ignored.
  inboundId: OptionalString,
  // The iMessage bridge's channel guidance, kept beside the text instead of inside it.
  guidance: OptionalString,
});

const InterruptBody = Schema.Struct({
  reason: OptionalString,
  clientRequestId: OptionalString,
  expectedRunId: OptionalString,
  expectedAttemptId: OptionalString,
});

const RespondBody = Schema.Struct({
  decision: Schema.optional(
    Schema.Union([ProviderApprovalDecision, Schema.Literals(["approve", "deny", "always"])]),
  ),
  answers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  dismiss: Schema.optional(Schema.Boolean),
  clientRequestId: OptionalString,
  // The iMessage bridge still sends the relayed message's id; it is accepted and ignored.
  inboundId: OptionalString,
});

const OriginBody = Schema.Struct({ origin: Schema.NullOr(Schema.String) });

const SettingsBody = Schema.Struct({
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  model: OptionalString,
  variant: Schema.optional(Schema.NullOr(Schema.String)),
  providerInstanceId: OptionalString,
  options: ModelOptions,
  title: OptionalString,
  archived: Schema.optional(Schema.Boolean),
  settled: Schema.optional(Schema.Boolean),
});

const ArchiveIfIdleBody = Schema.Struct({
  expectedSession: Schema.optional(Schema.String),
});

const UploadBody = Schema.Struct({
  type: Schema.optional(Schema.Literals(["image", "file"])),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
});

const decodeCreateThreadBody = Schema.decodeUnknownEffect(CreateThreadBody);
const decodeSendBody = Schema.decodeUnknownEffect(SendBody);
const decodeInterruptBody = Schema.decodeUnknownEffect(InterruptBody);
const decodeRespondBody = Schema.decodeUnknownEffect(RespondBody);
const decodeOriginBody = Schema.decodeUnknownEffect(OriginBody);
const decodeSettingsBody = Schema.decodeUnknownEffect(SettingsBody);
const decodeArchiveIfIdleBody = Schema.decodeUnknownEffect(ArchiveIfIdleBody);
const decodeUploadBody = Schema.decodeUnknownEffect(UploadBody);
const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);
const decodeUploadInput = Schema.decodeUnknownEffect(AttachmentCreateUploadUrlInput);
const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const toChatAttachments = (attachments: ReadonlyArray<Attachment> | undefined) =>
  (attachments ?? []).map(
    (attachment) =>
      ({
        type: attachment.type ?? (attachment.mimeType.startsWith("image/") ? "image" : "file"),
        id: attachment.attachmentId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      }) as never,
  );

const DECISIONS: Record<string, ProviderApprovalDecision> = {
  approve: "accept",
  deny: "decline",
  always: "acceptForSession",
};

// ---------------------------------------------------------------------------
// Event projection for SSE
// ---------------------------------------------------------------------------

export type ControlEvent =
  | {
      readonly type: "thread.created";
      readonly threadId: string;
      readonly projectId: string;
      readonly title: string;
      readonly parentThreadId: string | null;
    }
  | {
      readonly type: "thread.status";
      readonly threadId: string;
      readonly runId: string;
      readonly status: string;
      readonly state: ControlThreadState;
    }
  | {
      readonly type: "message.completed";
      readonly threadId: string;
      readonly runId: string | null;
      readonly messageId: string;
      readonly role: string;
      readonly text: string;
    }
  | {
      readonly type: "request.opened" | "request.resolved";
      readonly threadId: string;
      readonly requestId: string;
      readonly kind: "approval" | "question";
      readonly requestKind: string;
      readonly status: string;
    }
  | { readonly type: "thread.updated"; readonly threadId: string; readonly change: string };

/** Maps one stored orchestration event onto the small set of events integrations act on. */
export function controlEventFromStored(stored: OrchestrationV2StoredEvent): ControlEvent | null {
  const event = stored.event;
  switch (event.type) {
    case "thread.created":
      return {
        type: "thread.created",
        threadId: event.threadId,
        projectId: event.payload.projectId,
        title: event.payload.title,
        parentThreadId: event.payload.lineage.parentThreadId,
      };
    case "run.created":
    case "run.updated":
      return {
        type: "thread.status",
        threadId: event.threadId,
        runId: event.payload.id,
        status: event.payload.status,
        state: stateFromRuns([event.payload], false).state,
      };
    case "message.updated":
      if (event.payload.streaming || event.payload.role === "system") return null;
      if (event.payload.role === "assistant" && event.payload.text.trim().length === 0) return null;
      return {
        type: "message.completed",
        threadId: event.threadId,
        runId: event.payload.runId,
        messageId: event.payload.id,
        role: event.payload.role,
        text: event.payload.text,
      };
    case "runtime-request.updated":
      return {
        type: event.payload.status === "pending" ? "request.opened" : "request.resolved",
        threadId: event.threadId,
        requestId: event.payload.id,
        kind: event.payload.kind === "user_input" ? "question" : "approval",
        requestKind: event.payload.kind,
        status: event.payload.status,
      };
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.metadata-updated":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "thread.settled":
    case "thread.unsettled":
      return { type: "thread.updated", threadId: event.threadId, change: event.type };
    default:
      return null;
  }
}

const encoder = new TextEncoder();
const encodeEventJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sseFrame = (sequence: number, event: ControlEvent & { readonly origin?: string | null }) =>
  `id: ${sequence}\nevent: ${event.type}\ndata: ${encodeEventJson(event)}\n\n`;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const makeRoutes = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const store = yield* ControlStore.ControlStore;
  const identities = yield* ExecutionIdentity.ExecutionIdentity;
  const crypto = yield* Crypto.Crypto;
  const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const intakeContext = yield* Effect.context<
    | Effect.Services<ReturnType<typeof ThreadMessageIntake.launchThread>>
    | Effect.Services<ReturnType<typeof ThreadMessageIntake.sendToThread>>
    | Effect.Services<ReturnType<typeof ThreadMessageIntake.dispatchCommand>>
  >();
  const uploadContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof issueAttachmentUploadUrl>>>();

  const resolveControlSelection = Effect.fn("ControlApi.resolveSelection")(function* (
    input: Parameters<typeof modelSelectionFrom>[0],
  ) {
    const settings =
      input.settings ??
      (yield* settingsService.getSettings.pipe(
        Effect.mapError((cause) => fail("internal", errorDetail(cause))),
      ));
    const selection = yield* selectionOrFail(modelSelectionFrom({ ...input, settings }));
    if (selectionMigrationApplies(settings)) {
      const catalog = yield* providers.getProviders;
      const problem = selectionProblem(catalog, selection);
      if (problem !== null) return yield* fail("invalid_request", problem);
    } else if (input.options !== undefined) {
      // Explicit native options have no legacy semantics; never silently prefer
      // one duplicate or a conflicting compatibility variant.
      const ids = new Set<string>();
      for (const option of input.options) {
        if (ids.has(option.id)) {
          return yield* fail(
            "invalid_request",
            `Option ${option.id} was specified more than once.`,
          );
        }
        ids.add(option.id);
        if (
          option.id === "variant" &&
          input.variant !== undefined &&
          option.value !== input.variant
        ) {
          return yield* fail("invalid_request", "variant conflicts with the options list.");
        }
        if (
          (option.id === "effort" || option.id === "reasoningEffort") &&
          input.variant !== undefined &&
          option.value !== input.variant
        ) {
          return yield* fail("invalid_request", "variant conflicts with the native effort option.");
        }
      }
      const catalog = yield* providers.getProviders;
      const problem = selectionProblem(catalog, selection);
      if (problem !== null) return yield* fail("invalid_request", problem);
    }
    return selection;
  });

  const authenticate = (scope: Scope) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* auth
        .authenticateHttpRequest(request)
        .pipe(
          Effect.mapError((error) =>
            EnvironmentAuth.isServerAuthCredentialError(error)
              ? fail("unauthorized", "A valid bearer token is required.")
              : fail("internal", "Authentication failed."),
          ),
        );
      if (!session.scopes.includes(scope)) {
        return yield* fail("forbidden", `This token lacks the ${scope} scope.`);
      }
      return session;
    });

  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  const commandIdFor = (operation: string, clientRequestId: string | undefined) =>
    clientRequestId === undefined
      ? uuid.pipe(Effect.map((id) => CommandId.make(`ardud-control:${operation}:${id}`)))
      : Effect.succeed(
          CommandId.make(`ardud-control:${operation}:${encodeURIComponent(clientRequestId)}`),
        );

  const dispatch = (command: OrchestrationV2Command) =>
    startup
      .enqueueCommand(
        ThreadMessageIntake.dispatchCommand(command).pipe(Effect.provide(intakeContext)),
      )
      .pipe(Effect.mapError((cause) => fail("conflict", errorDetail(cause))));

  const getShell = (threadId: string) =>
    threads.getThreadShell(ThreadId.make(threadId)).pipe(
      Effect.mapError((cause) => fail("internal", errorDetail(cause))),
      Effect.flatMap((shell) =>
        shell === null || shell.deletedAt !== null
          ? Effect.fail(fail("not_found", `Thread ${threadId} was not found.`))
          : Effect.succeed(shell),
      ),
    );

  /**
   * Shells for a few known threads, one cheap lookup each. Lists that only
   * want live threads use this instead of building the whole shell snapshot,
   * which grows with every thread ever made.
   */
  const shellsFor = (threadIds: ReadonlyArray<string>, location: "active" | "archive") =>
    Effect.forEach(
      threadIds,
      (threadId) =>
        threads
          .getThreadShell(ThreadId.make(threadId))
          .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause)))),
      { concurrency: 4 },
    ).pipe(
      Effect.map((shells) =>
        shells.filter(
          (shell): shell is OrchestrationV2ThreadShell =>
            shell !== null &&
            shell.deletedAt === null &&
            (shell.archivedAt !== null) === (location === "archive"),
        ),
      ),
    );

  const readRecords = (threadId: string) =>
    threads
      .getThreadRecords(ThreadId.make(threadId), ["runs", "runtimeRequests", "turnItems"], {
        turnItemTypes: ["approval_request", "user_input_request"],
      })
      .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));

  const readMessages = (threadId: string) =>
    threads
      .getThreadRecords(ThreadId.make(threadId), ["messages"])
      .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));

  const summarize = (shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    Effect.gen(function* () {
      const ids = shells.map((shell) => shell.id);
      const [origins, natives, bindings] = yield* Effect.all([
        store.getOrigins(ids),
        store.nativeSessionIds(ids),
        store.nativeBindings(ids),
      ]).pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
      // Children inherit the root's origin.
      const rootIds = shells
        .map((shell) => shell.lineage.rootThreadId)
        .filter((rootId) => !origins.has(rootId));
      const rootOrigins =
        rootIds.length === 0
          ? new Map<string, string>()
          : yield* store
              .getOrigins(rootIds)
              .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
      return shells.map((shell) => ({
        ...shellSummary(shell, {
          origin:
            origins.get(shell.id) ??
            origins.get(shell.lineage.rootThreadId) ??
            rootOrigins.get(shell.lineage.rootThreadId) ??
            null,
          nativeSessionId: natives.get(shell.id) ?? null,
        }),
        native: bindings.get(shell.id) ?? null,
      }));
    });

  const threadDetail = (threadId: string) =>
    Effect.gen(function* () {
      const shell = yield* getShell(threadId);
      const records = yield* readRecords(threadId);
      const pending = records.runtimeRequests.filter((request) => request.status === "pending");
      const { state, run } = stateFromRuns(records.runs, pending.length > 0);
      const [summary] = yield* summarize([shell]);
      return {
        ...summary!,
        state,
        status: run?.status ?? "idle",
        run: run === null ? null : runSummary(run),
        recentRuns: runsNewestFirst(records.runs).slice(0, 5).map(runSummary),
        pendingRequests: pending.map((request) =>
          pendingRequestSummary(request, records.turnItems),
        ),
      };
    });

  // -- projects -------------------------------------------------------------

  const listProjects = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const shells = yield* projects
      .listShells()
      .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
    const scratch = yield* folders.scratchRoot;
    return json({
      ok: true,
      projects: shells.map((project) => ({
        projectId: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        defaultModel:
          project.defaultModelSelection === null
            ? null
            : formatModel(project.defaultModelSelection),
        scratch: Option.isSome(scratch) && project.workspaceRoot === scratch.value,
      })),
    });
  });

  const listModels = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => fail("internal", errorDetail(cause))),
    );
    const list = yield* providers.getProviders;
    return json({
      ok: true,
      defaultModel:
        settings.defaultModelSelection === null
          ? null
          : formatModel(settings.defaultModelSelection),
      defaultRuntimeMode: settings.defaultRuntimeMode,
      providers: list.map((provider) => ({
        instanceId: provider.instanceId,
        driver: provider.driver,
        enabled: provider.enabled,
        status: provider.status,
        models: provider.models.map((model) => ({
          model: model.slug,
          name: model.name,
          optionDescriptors: model.capabilities?.optionDescriptors ?? [],
          variants:
            model.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "variant")
              ?.type === "select"
              ? (
                  model.capabilities.optionDescriptors.find(
                    (descriptor) => descriptor.id === "variant",
                  ) as { options: ReadonlyArray<{ id: string }> }
                ).options.map((option) => option.id)
              : [],
        })),
      })),
    });
  });

  // -- threads --------------------------------------------------------------

  const resolveProject = (body: typeof CreateThreadBody.Type) =>
    Effect.gen(function* () {
      const chosen = [
        body.projectId,
        body.directory,
        body.scratch === true ? "scratch" : undefined,
      ].filter((value) => value !== undefined).length;
      if (chosen > 1) {
        return yield* fail("invalid_request", "Pass only one of projectId, directory or scratch.");
      }
      if (body.projectId !== undefined) {
        const project = yield* projects
          .getById(ProjectId.make(body.projectId))
          .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
        if (Option.isNone(project)) {
          return yield* fail("not_found", `Project ${body.projectId} was not found.`);
        }
        return { projectId: project.value.id, workspaceStrategy: { type: "root" as const } };
      }
      if (body.directory !== undefined) {
        const directory = body.directory.replace(/\/+$/, "") || "/";
        if (!directory.startsWith("/")) {
          return yield* fail("invalid_request", "directory must be an absolute path.");
        }
        // A registered project root runs at its root; a folder inside one runs
        // there as its own worktree; anything else becomes a project of its own.
        const all = yield* projects
          .listShells()
          .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
        const exact = all.find((project) => project.workspaceRoot === directory);
        if (exact !== undefined) {
          return { projectId: exact.id, workspaceStrategy: { type: "root" as const } };
        }
        const parent = all
          .filter((project) => directory.startsWith(`${project.workspaceRoot}/`))
          .toSorted((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0];
        if (parent !== undefined) {
          // Chat folders under a registered root (iMessage, Telegram) are made on demand.
          yield* fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.mapError((cause) => fail("invalid_request", errorDetail(cause))));
          return {
            projectId: parent.id,
            workspaceStrategy: { type: "existing_worktree" as const, worktreePath: directory },
          };
        }
        const id = yield* uuid;
        const created = yield* projects
          .bootstrap({
            commandId: CommandId.make(`ardud-control:project:${id}`),
            projectId: ProjectId.make(id),
            title: directory.slice(directory.lastIndexOf("/") + 1) || directory,
            workspaceRoot: directory,
            createWorkspaceRootIfMissing: true,
          })
          .pipe(Effect.mapError((cause) => fail("conflict", errorDetail(cause))));
        return { projectId: created.project.id, workspaceStrategy: { type: "root" as const } };
      }
      const scratch = yield* folders.ensureScratchProject.pipe(
        Effect.mapError((cause) => fail("unavailable", errorDetail(cause))),
      );
      return { projectId: scratch.projectId, workspaceStrategy: { type: "root" as const } };
    });

  const createThread = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationOperateScope);
    const body = yield* decodeBody(decodeCreateThreadBody);
    const target = yield* resolveProject(body);
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => fail("internal", errorDetail(cause))),
    );
    const projectRow = yield* projects
      .getById(target.projectId)
      .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
    const resolved = resolveProjectSettings(
      settings,
      target.projectId,
      Option.getOrUndefined(projectRow) ?? null,
    ).settings;
    const base: ModelSelection | null = resolved.defaultModelSelection ?? null;
    if (base === null && body.model === undefined) {
      return yield* fail("invalid_request", "No default model is configured; pass model.");
    }
    const modelSelection = yield* resolveControlSelection({
      model: body.model,
      variant: body.variant,
      instanceId: body.providerInstanceId,
      options: body.options,
      base: base ?? ({ instanceId: "opencode", model: body.model! } as ModelSelection),
      settings,
    });
    const commandId = yield* commandIdFor("thread", body.clientRequestId);
    const threadId = ThreadId.make(commandId);
    const prompt = body.prompt?.trim() ?? "";
    const attachments = toChatAttachments(body.attachments);
    const title =
      body.title?.trim() ||
      (prompt.length > 0 ? prompt.split("\n")[0]!.slice(0, 80) : "New thread");
    const launched = yield* startup
      .enqueueCommand(
        ThreadMessageIntake.launchThread({
          commandId,
          threadId,
          projectId: target.projectId,
          title,
          generateTitle: body.title === undefined && prompt.length > 0,
          modelSelection,
          runtimeMode: body.runtimeMode ?? resolved.defaultRuntimeMode,
          interactionMode: body.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy:
            body.worktree === undefined
              ? target.workspaceStrategy
              : {
                  type: "worktree",
                  baseRef: body.worktree.baseRef,
                  ...(body.worktree.branch === undefined ? {} : { branch: body.worktree.branch }),
                  ...(body.worktree.startFromOrigin === undefined
                    ? {}
                    : { startFromOrigin: body.worktree.startFromOrigin }),
                },
          ...(prompt.length === 0 && attachments.length === 0
            ? {}
            : {
                initialMessage: {
                  messageId: MessageId.make(commandId),
                  text: prompt,
                  attachments,
                },
              }),
          // ardud: a bearer token is not the owner typing.
          createdBy: CONTROL_ACTOR,
          creationSource: "server",
        }).pipe(Effect.provide(intakeContext)),
      )
      .pipe(Effect.mapError((cause) => fail("conflict", errorDetail(cause))));
    if (body.origin !== undefined && body.origin.trim().length > 0) {
      yield* store
        .setOrigin(launched.threadId, body.origin.trim())
        .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
    }
    const initialMessageId = MessageId.make(commandId);
    const run = launched.projection.runs.find(
      (candidate) => candidate.userMessageId === initialMessageId,
    );
    return json(
      {
        ok: true,
        threadId: launched.threadId,
        projectId: launched.projection.thread.projectId,
        directory:
          launched.projection.thread.worktreePath ??
          (Option.isSome(projectRow) ? projectRow.value.workspaceRoot : null),
        messageId: run === undefined ? null : run.userMessageId,
        runId: run?.id ?? null,
        status: run?.status ?? "idle",
        model: formatModel(launched.projection.thread.modelSelection),
        runtimeMode: launched.projection.thread.runtimeMode,
        resumed: launched.resumed,
      },
      launched.resumed ? 200 : 201,
    );
  });

  const listThreads = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const params = yield* searchParams;
    const archived = boolParam(params.get("archived")) === true;
    const location = archived ? "archive" : "active";
    const since = parseSince(params.get("updatedSince"));
    const active = boolParam(params.get("active"));
    const projectId = params.get("projectId");
    const states = params.get("state")?.split(",").filter(Boolean);
    const includeSubagents = boolParam(params.get("includeSubagents")) ?? false;
    const ids = params.get("ids")?.split(",").filter(Boolean);
    const parentThreadId = params.get("parentThreadId");
    // Only live threads can be non-idle, so those lists start from the few
    // live ids instead of every thread's shell. The exact filters below
    // still decide.
    const liveOnly = active === true || (states !== undefined && !states.includes("idle"));
    const candidates = liveOnly
      ? yield* shellsFor(
          yield* store
            .liveThreadIds()
            .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause)))),
          location,
        )
      : yield* threads.getShellSnapshot({ location }).pipe(
          Effect.map((snapshot) =>
            location === "archive" ? snapshot.archivedThreads : snapshot.threads,
          ),
          Effect.mapError((cause) => fail("internal", errorDetail(cause))),
        );
    let shells = candidates.filter(
      (shell) =>
        shell.deletedAt === null &&
        (includeSubagents ||
          parentThreadId !== null ||
          shell.lineage.relationshipToParent !== "subagent") &&
        (parentThreadId === null || shell.lineage.parentThreadId === parentThreadId) &&
        (projectId === null || shell.projectId === projectId) &&
        (ids === undefined || ids.includes(shell.id)) &&
        (since === undefined || DateTime.toEpochMillis(shell.updatedAt) > since),
    );
    if (active !== undefined) {
      shells = shells.filter((shell) => (stateFromShell(shell) !== "idle") === active);
    }
    if (states !== undefined) {
      shells = shells.filter((shell) => states.includes(stateFromShell(shell)));
    }
    shells = shells.toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
    let summaries = yield* summarize(shells);
    const origin = params.get("origin");
    if (origin !== null) {
      summaries = summaries.filter((summary) =>
        origin === "none" ? summary.origin === null : summary.origin === origin,
      );
    }
    const limit = clampInt(params.get("limit"), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    return json({
      ok: true,
      total: summaries.length,
      threads: summaries.slice(0, limit),
    });
  });

  const getThread = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const threadId = yield* param("threadId");
    return json({ ok: true, thread: yield* threadDetail(threadId) });
  });

  const byNative = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const nativeId = yield* param("sessionId");
    const driver = (yield* searchParams).get("driver") ?? undefined;
    const threadId = yield* store
      .threadIdForNativeSession(nativeId, driver)
      .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
    if (threadId === null) {
      return yield* fail("not_found", `No thread maps to session ${nativeId}.`);
    }
    return json({ ok: true, nativeSessionId: nativeId, thread: yield* threadDetail(threadId) });
  });

  // Any native id a hook or tool sees, resolved to its Robob execution.
  // Ambiguous and unknown ids come back as a resolution, not an error, so
  // callers can tell "not yet" from "never".
  const identityResolve = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const params = yield* searchParams;
    const nativeId = params.get("nativeId");
    if (nativeId === null || nativeId.length === 0) {
      return yield* fail("invalid_request", "nativeId is required.");
    }
    const driver = params.get("driver");
    const providerInstanceId = params.get("instance");
    const agentId = params.get("agentId");
    const identity = yield* identities
      .resolve({
        nativeId,
        ...(driver === null ? {} : { driver }),
        ...(providerInstanceId === null ? {} : { providerInstanceId }),
        ...(agentId === null ? {} : { agentId }),
      })
      .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
    return json({ ok: true, identity });
  });

  const getMessages = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const threadId = yield* param("threadId");
    yield* getShell(threadId);
    const params = yield* searchParams;
    const records = yield* readMessages(threadId);
    const role = params.get("role");
    const runId = params.get("runId");
    const since = parseSince(params.get("since"));
    const after = params.get("afterMessageId");
    const ordered = records.messages.toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
    const afterIndex = after === null ? -1 : ordered.findIndex((message) => message.id === after);
    const filtered = ordered
      .slice(afterIndex + 1)
      .filter(
        (message) =>
          message.role !== "system" &&
          (role === null || role === "all" || message.role === role) &&
          (runId === null || message.runId === runId) &&
          (since === undefined || DateTime.toEpochMillis(message.updatedAt) > since),
      );
    const limit = clampInt(params.get("limit"), DEFAULT_MESSAGE_LIMIT, 1000);
    const page = boolParam(params.get("all")) === true ? filtered : filtered.slice(-limit);
    const last = lastAssistantText(records.messages, runId);
    const detail = yield* readRecords(threadId);
    const pending = detail.runtimeRequests.some((request) => request.status === "pending");
    const { state, run } = stateFromRuns(detail.runs, pending);
    return json({
      ok: true,
      threadId,
      state,
      status: run?.status ?? "idle",
      runId: run?.id ?? null,
      total: filtered.length,
      messages: page.map(messageSummary),
      lastAssistant: last,
    });
  });

  // A run's own evidence: its status, its assistant messages with their phase, and
  // whether any tool ran. Reads only this run's rows through the projection filter.
  const getRunEvidence = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const threadId = yield* param("threadId");
    const runId = yield* param("runId");
    yield* getShell(threadId);
    const records = yield* threads
      .getThreadRecords(ThreadId.make(threadId), ["runs", "messages", "turnItems"], {
        runIds: [RunId.make(runId)],
        messageRunIds: [RunId.make(runId)],
        turnItemRunIds: [RunId.make(runId)],
      })
      .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
    const run = records.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) {
      return yield* fail("not_found", `Run ${runId} was not found on thread ${threadId}.`);
    }
    const messages = records.messages
      .filter((message) => message.runId === run.id && message.role === "assistant")
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    const evidence = runToolEvidence({
      runStatus: run.status,
      turnItems: records.turnItems.filter((item) => item.runId === run.id),
      itemsComplete: true,
    });
    return json({
      ok: true,
      threadId,
      runId: run.id,
      status: run.status,
      toolEvidence: evidence.toolEvidence,
      complete: evidence.complete,
      messages: messages.map((message) => ({
        id: message.id,
        phase: message.phase,
        text: messagePreview(message),
      })),
    });
  });

  const send = Effect.gen(function* () {
    const session = yield* authenticate(AuthOrchestrationOperateScope);
    const threadId = yield* param("threadId");
    const body = yield* decodeBody(decodeSendBody);
    const shell = yield* getShell(threadId);
    const commandId = yield* commandIdFor(`send:${threadId}`, body.clientRequestId);
    // ardud: channel guidance is framed as the bridge's, so only it may send some.
    if (body.guidance !== undefined && !isBridgeSession(session)) {
      return yield* fail("forbidden", "Only the iMessage bridge sends channel guidance.");
    }
    if (body.guidance !== undefined && !guidanceFits(body.guidance)) {
      return yield* fail(
        "invalid_request",
        `Channel guidance is limited to ${GUIDANCE_MAX_CHARS} characters once encoded.`,
      );
    }
    const context = guidanceContext(body.guidance);
    const hasSelection =
      body.model !== undefined ||
      body.variant !== undefined ||
      body.providerInstanceId !== undefined ||
      body.options !== undefined;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => fail("internal", errorDetail(cause))),
    );
    const modelSelection =
      hasSelection || selectionMigrationApplies(settings)
        ? yield* resolveControlSelection({
            model: body.model,
            variant: body.variant,
            instanceId: body.providerInstanceId,
            options: body.options,
            base: shell.modelSelection,
            settings,
          })
        : undefined;
    const result = yield* startup
      .enqueueCommand(
        ThreadMessageIntake.sendToThread({
          projectId: shell.projectId,
          commandId,
          threadId: shell.id,
          messageId: MessageId.make(commandId),
          text: body.text,
          attachments: toChatAttachments(body.attachments),
          ...(modelSelection === undefined ? {} : { modelSelection }),
          mode: body.mode ?? "auto",
          // ardud: a bearer token is not the owner typing.
          createdBy: CONTROL_ACTOR,
          creationSource: "server",
          ...(context === undefined ? {} : { context }),
        }).pipe(Effect.provide(intakeContext)),
      )
      .pipe(
        Effect.mapError((cause) =>
          isThreadManagementError(cause) && cause._tag === "ThreadManagementThreadNotFoundError"
            ? fail("not_found", cause.message)
            : fail("conflict", errorDetail(cause)),
        ),
      );
    return json({
      ok: true,
      threadId: shell.id,
      messageId: result.message.id,
      runId: result.run.id,
      status: result.run.status,
      delivery: result.delivery,
    });
  });

  const interrupt = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationOperateScope);
    const threadId = yield* param("threadId");
    const body = yield* decodeBody(decodeInterruptBody);
    if (body.expectedAttemptId !== undefined && body.expectedRunId === undefined) {
      return yield* fail("invalid_request", "expectedAttemptId needs expectedRunId");
    }
    const expectedRunId = body.expectedRunId?.trim();
    if (expectedRunId === "") {
      return yield* fail("invalid_request", "expectedRunId must not be empty.");
    }
    const shell = yield* getShell(threadId);
    if (expectedRunId !== undefined) {
      const records = yield* threads
        .getThreadRecords(shell.id, ["runs"])
        .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
      const run = records.runs.find((candidate) => candidate.id === expectedRunId);
      if (
        run !== undefined &&
        !TERMINAL_RUN_STATUSES.has(run.status) &&
        body.expectedAttemptId !== undefined &&
        run.activeAttemptId !== body.expectedAttemptId
      ) {
        return yield* fail(
          "conflict",
          `Run ${expectedRunId} is on attempt ${run.activeAttemptId}, not ${body.expectedAttemptId}.`,
        );
      }
    }
    const result = yield* startup
      .enqueueCommand(
        threads.interruptThread({
          projectId: shell.projectId,
          commandId: yield* commandIdFor(`interrupt:${threadId}`, body.clientRequestId),
          threadId: shell.id,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          ...(expectedRunId === undefined ? {} : { runId: RunId.make(expectedRunId) }),
          ...(body.expectedAttemptId === undefined
            ? {}
            : { attemptId: RunAttemptId.make(body.expectedAttemptId) }),
        }),
      )
      .pipe(Effect.mapError((cause) => fail("conflict", errorDetail(cause))));
    return json({
      ok: true,
      threadId: shell.id,
      interrupted: result.type === "interrupt_requested",
      result: result.type,
      runId: result.type === "no_active_run" ? null : result.run.id,
    });
  });

  const respond = Effect.gen(function* () {
    const session = yield* authenticate(AuthOrchestrationOperateScope);
    const threadId = yield* param("threadId");
    const requestId = yield* param("requestId");
    const body = yield* decodeBody(decodeRespondBody);
    yield* getShell(threadId);
    const records = yield* readRecords(threadId);
    const request = records.runtimeRequests.find((candidate) => candidate.id === requestId);
    if (request === undefined) {
      return yield* fail("not_found", `Request ${requestId} was not found on thread ${threadId}.`);
    }
    const alreadyIs = () => fail("conflict", `Request ${requestId} is already ${request.status}.`);
    if (request.status !== "pending") return yield* alreadyIs();
    const commandId = yield* commandIdFor(`respond:${requestId}`, body.clientRequestId);
    const decision: ProviderApprovalDecision | undefined =
      body.decision === undefined
        ? undefined
        : (DECISIONS[body.decision] ?? (body.decision as ProviderApprovalDecision));
    let command: OrchestrationV2Command;
    if (request.kind === "user_input") {
      if (body.dismiss === true || decision === "decline" || decision === "cancel") {
        command =
          request.responseCapability.type === "message"
            ? {
                type: "thread.user-input.dismiss",
                commandId,
                threadId: ThreadId.make(threadId),
                requestId: RuntimeRequestId.make(requestId),
              }
            : {
                type: "runtime-request.respond",
                commandId,
                threadId: ThreadId.make(threadId),
                requestId: RuntimeRequestId.make(requestId),
                decision: "cancel",
              };
      } else {
        if (body.answers === undefined) {
          return yield* fail("invalid_request", "A question needs answers keyed by question id.");
        }
        command = {
          type: "runtime-request.respond",
          commandId,
          threadId: ThreadId.make(threadId),
          requestId: RuntimeRequestId.make(requestId),
          answers: body.answers,
        };
      }
    } else {
      if (decision === undefined) {
        return yield* fail(
          "invalid_request",
          "An approval needs decision: approve, deny, always, or a t3 decision.",
        );
      }
      command = {
        type: "runtime-request.respond",
        commandId,
        threadId: ThreadId.make(threadId),
        requestId: RuntimeRequestId.make(requestId),
        decision,
      };
    }
    // ardud: an answer the Telegram bridge relays from the owner's chat is the owner's.
    const owner = telegramAnswerOwner(session);
    const decided: OrchestrationV2Command =
      command.type === "runtime-request.respond"
        ? { ...command, createdBy: controlActor(owner) }
        : command;
    const result = yield* dispatch(decided);
    return json({ ok: true, threadId, requestId, sequence: result.sequence });
  });

  const putOrigin = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationOperateScope);
    const threadId = yield* param("threadId");
    const body = yield* decodeBody(decodeOriginBody);
    yield* getShell(threadId);
    const origin = body.origin?.trim() || null;
    yield* store
      .setOrigin(threadId, origin)
      .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
    return json({ ok: true, threadId, origin });
  });

  const patchThread = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationOperateScope);
    const threadId = yield* param("threadId");
    const body = yield* decodeBody(decodeSettingsBody);
    const shell = yield* getShell(threadId);
    const id = ThreadId.make(threadId);
    const next = (operation: string) => commandIdFor(`${operation}:${threadId}`, undefined);
    const hasSelection =
      body.model !== undefined ||
      body.variant !== undefined ||
      body.providerInstanceId !== undefined ||
      body.options !== undefined;
    // Resolve before any other mutation in a multi-field PATCH.
    const modelSelection = hasSelection
      ? yield* resolveControlSelection({
          model: body.model,
          variant: body.variant,
          instanceId: body.providerInstanceId,
          options: body.options,
          base: shell.modelSelection,
        })
      : undefined;
    if (body.runtimeMode !== undefined && body.runtimeMode !== shell.runtimeMode) {
      yield* dispatch({
        type: "thread.runtime-mode.set",
        commandId: yield* next("runtime-mode"),
        threadId: id,
        runtimeMode: body.runtimeMode,
      });
    }
    if (body.interactionMode !== undefined && body.interactionMode !== shell.interactionMode) {
      yield* dispatch({
        type: "thread.interaction-mode.set",
        commandId: yield* next("interaction-mode"),
        threadId: id,
        interactionMode: body.interactionMode,
      });
    }
    if (modelSelection !== undefined) {
      yield* dispatch({
        type:
          modelSelection.instanceId === shell.providerInstanceId
            ? "thread.model-selection.set"
            : "provider.switch",
        commandId: yield* next("model"),
        threadId: id,
        modelSelection,
      });
    }
    if (body.title !== undefined && body.title.trim().length > 0) {
      yield* dispatch({
        type: "thread.metadata.update",
        commandId: yield* next("title"),
        threadId: id,
        title: body.title.trim(),
      });
    }
    if (body.archived !== undefined && body.archived !== (shell.archivedAt !== null)) {
      yield* dispatch({
        type: body.archived ? "thread.archive" : "thread.unarchive",
        commandId: yield* next("archive"),
        threadId: id,
      });
    }
    if (body.settled !== undefined && body.settled !== (shell.settledOverride === "settled")) {
      yield* dispatch(
        body.settled
          ? { type: "thread.settle", commandId: yield* next("settle"), threadId: id }
          : {
              type: "thread.unsettle",
              commandId: yield* next("unsettle"),
              threadId: id,
              reason: "user",
            },
      );
    }
    return json({ ok: true, thread: yield* threadDetail(threadId) });
  });

  // The reaper's switch: the idle check and the archive happen together under
  // the thread's dispatch lock, so a run that lands first wins.
  const archiveThreadIfIdle = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationOperateScope);
    const threadId = yield* param("threadId");
    const body = yield* decodeBody(decodeArchiveIfIdleBody);
    yield* getShell(threadId);
    const expectedSession = body.expectedSession?.trim();
    const result = yield* startup
      .enqueueCommand(
        archiveIfIdle({
          commandId: yield* commandIdFor(`archive-if-idle:${threadId}`, undefined),
          threadId: ThreadId.make(threadId),
          expectedNativeSessionId:
            expectedSession === undefined || expectedSession.length === 0
              ? undefined
              : expectedSession,
        }).pipe(Effect.provideService(ThreadManagementService.ThreadManagementService, threads)),
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const code = archiveFailureCode(cause);
            // A thread deleted after the first read is a 404, not a failure.
            if (code !== "unavailable") yield* getShell(threadId);
            return yield* fail(code, errorDetail(cause));
          }),
        ),
      );
    if (!result.archived) {
      return json(
        {
          ok: false,
          archived: false,
          error: { code: "not_idle", reason: result.reason, message: result.detail },
        },
        STATUS.conflict,
      );
    }
    return json({ ok: true, archived: true, thread: yield* threadDetail(threadId) });
  });

  const wait = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const threadId = yield* param("threadId");
    const params = yield* searchParams;
    const shell = yield* getShell(threadId);
    const timeoutMs = clampInt(params.get("timeoutMs"), 10 * 60 * 1000, MAX_WAIT_MS);
    const runIdParam = params.get("runId");
    // A thread waits until no run is active, or until it asks for input,
    // which a waiting caller has to answer before the run can finish.
    const settled = Effect.gen(function* () {
      const records = yield* readRecords(threadId);
      const pending = records.runtimeRequests.some((request) => request.status === "pending");
      const target =
        runIdParam === null ? undefined : records.runs.find((run) => run.id === runIdParam);
      if (runIdParam !== null && target === undefined) {
        return yield* fail("not_found", `Run ${runIdParam} was not found on thread ${threadId}.`);
      }
      const { state } = stateFromRuns(records.runs, pending);
      const done =
        pending ||
        (target === undefined
          ? state === "idle" || (state === "waiting" && boolParam(params.get("drain")) !== true)
          : TERMINAL_RUN_STATUSES.has(target.status) ||
            (target.status === "waiting" && boolParam(params.get("drain")) !== true));
      return done;
    });
    const waited = yield* Effect.gen(function* () {
      while (!(yield* settled)) {
        yield* Effect.sleep(Duration.millis(500));
      }
    }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));
    const detail = yield* threadDetail(shell.id);
    const records = yield* readMessages(threadId);
    return json({
      ok: true,
      timedOut: Option.isNone(waited),
      thread: detail,
      lastAssistant: lastAssistantText(records.messages, runIdParam ?? detail.run?.runId),
    });
  });

  const upload = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationOperateScope);
    const body = yield* decodeBody(decodeUploadBody);
    const input = yield* decodeUploadInput(
      body.type === "file" ? body : { ...body, type: "image" },
    ).pipe(Effect.mapError((error) => fail("invalid_request", error.message)));
    const issued = yield* issueAttachmentUploadUrl(input).pipe(
      Effect.provide(uploadContext),
      Effect.mapError((cause) => fail("internal", errorDetail(cause))),
    );
    return json({ ok: true, ...issued });
  });

  const health = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const sequence = yield* eventStore
      .latestAgentSequence()
      .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause))));
    return json({
      ok: true,
      status: "healthy",
      sequence,
      time: DateTime.formatIso(yield* DateTime.now),
    });
  });

  /** Every pending approval and question across active threads, oldest first. */
  const listRequests = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const params = yield* searchParams;
    const candidates = yield* shellsFor(
      yield* store
        .pendingRequestThreadIds()
        .pipe(Effect.mapError((cause) => fail("internal", errorDetail(cause)))),
      "active",
    );
    const waiting = candidates.filter((shell) => shell.pendingRuntimeRequest !== null);
    const summaries = yield* summarize(waiting);
    const origin = params.get("origin");
    const rows = yield* Effect.forEach(
      summaries.filter(
        (summary) =>
          origin === null ||
          (origin === "none" ? summary.origin === null : summary.origin === origin),
      ),
      (summary) =>
        readRecords(summary.threadId).pipe(
          Effect.map((records) =>
            records.runtimeRequests
              .filter((request) => request.status === "pending")
              .map((request) => ({
                threadId: summary.threadId,
                title: summary.title,
                origin: summary.origin,
                rootThreadId: summary.rootThreadId,
                ...pendingRequestSummary(request, records.turnItems),
              })),
          ),
        ),
      { concurrency: 4 },
    );
    const requests = rows
      .flat()
      .toSorted((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""));
    return json({ ok: true, requests });
  });

  // -- events ---------------------------------------------------------------

  const events = Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* searchParams;
    const resumeRaw = request.headers["last-event-id"] ?? params.get("after");
    const resume =
      resumeRaw === undefined || resumeRaw === null || resumeRaw === ""
        ? Number.NaN
        : Number(resumeRaw);
    const threadFilter = params.get("threadId");
    const originFilter = params.get("origin");
    const typeFilter = params.get("types")?.split(",").filter(Boolean);
    const originCache = new Map<string, string | null>();
    const originOf = (threadId: string) =>
      originCache.has(threadId)
        ? Effect.succeed(originCache.get(threadId) ?? null)
        : Effect.gen(function* () {
            const own = yield* store.getOrigin(threadId).pipe(Effect.orElseSucceed(() => null));
            let origin = own;
            if (origin === null) {
              const shell = yield* threads
                .getThreadShell(ThreadId.make(threadId))
                .pipe(Effect.orElseSucceed(() => null));
              const rootId = shell?.lineage.rootThreadId;
              if (rootId !== undefined && rootId !== threadId) {
                origin = yield* store.getOrigin(rootId).pipe(Effect.orElseSucceed(() => null));
              }
            }
            // Origin rows can be written after a thread starts; only cache hits.
            if (origin !== null) originCache.set(threadId, origin);
            return origin;
          });

    // Without a cursor the stream starts at the live head instead of replaying history.
    const afterSequence =
      Number.isSafeInteger(resume) && resume >= 0
        ? resume
        : yield* eventStore.latestAgentSequence().pipe(Effect.orElseSucceed(() => 0));
    const source = threads
      .streamStoredEventsFrom({
        afterSequence,
        ...(threadFilter === null ? {} : { threadId: ThreadId.make(threadFilter) }),
      })
      .pipe(
        Stream.mapEffect((stored) =>
          Effect.gen(function* () {
            const event = controlEventFromStored(stored);
            if (event === null) return "";
            if (typeFilter !== undefined && !typeFilter.includes(event.type)) return "";
            const origin = yield* originOf(event.threadId);
            if (originFilter !== null) {
              const matches = originFilter === "none" ? origin === null : origin === originFilter;
              if (!matches) return "";
            }
            return sseFrame(stored.sequence, { ...event, origin });
          }),
        ),
        Stream.filter((frame) => frame.length > 0),
      );
    const hello = Stream.make(
      `retry: 3000\nid: ${afterSequence}\nevent: ready\ndata: {"type":"ready","sequence":${afterSequence}}\n\n`,
    );
    const heartbeats = Stream.tick(SSE_HEARTBEAT).pipe(
      Stream.drop(1),
      Stream.map(() => ": ping\n\n"),
    );
    const body = Stream.concat(hello, Stream.merge(source, heartbeats)).pipe(
      Stream.catchCause(() => Stream.make(`event: error\ndata: {"type":"error"}\n\n`)),
      Stream.map((frame) => encoder.encode(frame)),
    );
    return HttpServerResponse.stream(body, {
      contentType: "text/event-stream",
      headers: {
        // no-transform keeps the global compression middleware from buffering frames.
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  const handle = <R>(
    effect: Effect.Effect<HttpServerResponse.HttpServerResponse, ControlError, R>,
  ) =>
    effect.pipe(
      Effect.catchTags({ ControlError: (error) => Effect.succeed(errorResponse(error)) }),
      Effect.catchCause((cause) =>
        Effect.logWarning("ardud control request failed", { cause }).pipe(
          Effect.as(errorResponse(fail("internal", "Internal error."))),
        ),
      ),
    );

  const p = CONTROL_ROUTE_PREFIX;
  return [
    HttpRouter.route("GET", `${p}/health`, handle(health)),
    HttpRouter.route("GET", `${p}/requests`, handle(listRequests)),
    HttpRouter.route("GET", `${p}/projects`, handle(listProjects)),
    HttpRouter.route("GET", `${p}/models`, handle(listModels)),
    HttpRouter.route("GET", `${p}/threads`, handle(listThreads)),
    HttpRouter.route("POST", `${p}/threads`, handle(createThread)),
    HttpRouter.route("GET", `${p}/threads/by-native/:sessionId`, handle(byNative)),
    HttpRouter.route("GET", `${p}/identity/resolve`, handle(identityResolve)),
    HttpRouter.route("GET", `${p}/threads/:threadId`, handle(getThread)),
    HttpRouter.route("PATCH", `${p}/threads/:threadId`, handle(patchThread)),
    HttpRouter.route("POST", `${p}/threads/:threadId/archive-if-idle`, handle(archiveThreadIfIdle)),
    HttpRouter.route("GET", `${p}/threads/:threadId/messages`, handle(getMessages)),
    HttpRouter.route("GET", `${p}/threads/:threadId/runs/:runId/evidence`, handle(getRunEvidence)),
    HttpRouter.route("GET", `${p}/threads/:threadId/wait`, handle(wait)),
    HttpRouter.route("POST", `${p}/threads/:threadId/send`, handle(send)),
    HttpRouter.route("POST", `${p}/threads/:threadId/interrupt`, handle(interrupt)),
    HttpRouter.route("POST", `${p}/threads/:threadId/requests/:requestId/respond`, handle(respond)),
    HttpRouter.route("PUT", `${p}/threads/:threadId/origin`, handle(putOrigin)),
    HttpRouter.route("POST", `${p}/attachments`, handle(upload)),
    HttpRouter.route("GET", `${p}/events`, handle(events)),
  ] as const;
});

export const controlRouteLayer = HttpRouter.addAll(makeRoutes).pipe(
  Layer.provide(Layer.mergeAll(ControlStore.layer, ExecutionIdentity.layer)),
);
