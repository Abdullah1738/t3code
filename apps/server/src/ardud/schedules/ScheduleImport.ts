import {
  ArdudScheduleImportRequest,
  ArdudScheduleImportResult,
  ARDUD_SCHEDULE_IMPORT_PATH,
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  ScheduledTaskId,
  type ArdudScheduleImportItem,
  type ArdudScheduleImportOutcome,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { onceRunInPast } from "./onceTasks.ts";

const encodeResult = Schema.encodeUnknownEffect(ArdudScheduleImportResult);

export function importedTaskId(source: string, sourceId: string): ScheduledTaskId {
  return ScheduledTaskId.make(`scheduled-task:${source}:${sourceId}`);
}

const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
  }
});

const importOne = Effect.fn("ArdudScheduleImport.importOne")(function* (input: {
  readonly source: string;
  readonly dryRun: boolean;
  readonly item: ArdudScheduleImportItem;
  readonly existing: ReadonlyMap<string, ScheduledTask>;
}) {
  const { item, dryRun } = input;
  const projects = yield* ProjectService.ProjectService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const taskId = importedTaskId(input.source, item.sourceId);
  const existingTask = input.existing.get(taskId);
  const now = yield* DateTime.now;

  // A one-time run already in the past cannot be enabled; keep the record, off.
  const pastOnce = item.enabled && onceRunInPast(item.schedule, now);
  const enabled = item.enabled && !pastOnce;
  const note = pastOnce ? "One-time run is in the past; imported disabled." : null;

  const found = yield* projects.getByWorkspaceRoot(item.workspaceRoot);
  const base = {
    sourceId: item.sourceId,
    title: item.title,
    taskId,
    workspaceRoot: item.workspaceRoot,
    enabled,
  };

  if (dryRun) {
    const next =
      enabled && item.schedule.type !== "webhook" ? nextScheduledRunAt(item.schedule, now) : null;
    return {
      ...base,
      projectId: Option.isSome(found) ? found.value.id : null,
      projectAction: Option.isSome(found) ? "existing" : "would_create",
      taskAction: existingTask ? "would_update" : "would_create",
      nextRunAt: next ? DateTime.formatIso(DateTime.toUtc(next)) : null,
      note,
    } satisfies ArdudScheduleImportOutcome;
  }

  let projectId: ProjectId;
  let projectAction: ArdudScheduleImportOutcome["projectAction"] = "existing";
  if (Option.isSome(found)) {
    projectId = found.value.id;
  } else {
    const created = yield* projects.bootstrap({
      commandId: CommandId.make(`ardud-schedule-import:project:${yield* crypto.randomUUIDv4}`),
      projectId: ProjectId.make(yield* crypto.randomUUIDv4),
      title: path.basename(item.workspaceRoot) || "project",
      workspaceRoot: item.workspaceRoot,
    });
    projectId = created.project.id;
    projectAction = created.created ? "created" : "existing";
  }

  const { task } = yield* scheduledTasks.upsert({
    id: taskId,
    title: item.title,
    prompt: item.prompt,
    enabled,
    schedule: item.schedule,
    projectId,
    // A fresh thread per run, in the project checkout, like OpenChamber.
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: item.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "server",
  });
  return {
    ...base,
    enabled: task.enabled,
    projectId,
    projectAction,
    taskAction: existingTask ? "updated" : "created",
    nextRunAt: task.nextRunAt,
    note,
  } satisfies ArdudScheduleImportOutcome;
});

export const runScheduleImport = Effect.fn("ArdudScheduleImport.run")(function* (
  request: ArdudScheduleImportRequest,
) {
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const { tasks } = yield* scheduledTasks.list();
  const existing = new Map(tasks.map((task) => [task.id as string, task]));
  const outcomes = yield* Effect.forEach(
    request.items,
    (item) =>
      importOne({ source: request.source, dryRun: request.dryRun, item, existing }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            sourceId: item.sourceId,
            title: item.title,
            taskId: importedTaskId(request.source, item.sourceId),
            workspaceRoot: item.workspaceRoot,
            projectId: null,
            projectAction: "existing",
            taskAction: "failed",
            enabled: false,
            nextRunAt: null,
            note: error instanceof Error ? error.message : String(error),
          } satisfies ArdudScheduleImportOutcome),
        ),
      ),
    { concurrency: 1 },
  );
  return { dryRun: request.dryRun, outcomes };
});

export const scheduleImportRouteLayer = HttpRouter.add(
  "POST",
  ARDUD_SCHEDULE_IMPORT_PATH,
  Effect.gen(function* () {
    yield* authenticate;
    const request = yield* HttpServerRequest.schemaBodyJson(ArdudScheduleImportRequest).pipe(
      Effect.mapError((cause) => ({ _tag: "BadRequest" as const, message: String(cause) })),
    );
    const result = yield* runScheduleImport(request);
    return yield* HttpServerResponse.json(yield* encodeResult(result));
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      BadRequest: (error) =>
        Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
    }),
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.text(error instanceof Error ? error.message : String(error), {
          status: 500,
        }),
      ),
    ),
  ),
);
