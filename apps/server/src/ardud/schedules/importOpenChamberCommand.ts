import * as NodeOS from "node:os";

import {
  ArdudScheduleImportResult,
  ARDUD_SCHEDULE_IMPORT_PATH,
  AuthStandardClientScopes,
  type ArdudScheduleImportItem,
  type ArdudScheduleImportRequest,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import { readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import { componentTokenCommand } from "../auth/componentTokenCommand.ts";
import { openCodeImportCommand } from "../opencode-import/command.ts";
import {
  OpenChamberProjectFile,
  OpenChamberScheduledTask,
  openChamberTaskToImportItem,
  workspaceRootFromFileName,
} from "./openChamberTasks.ts";

const decodeProjectFile = Schema.decodeUnknownOption(Schema.fromJsonString(OpenChamberProjectFile));
const decodeTask = Schema.decodeUnknownOption(OpenChamberScheduledTask);
const decodeResult = Schema.decodeUnknownEffect(ArdudScheduleImportResult);

class ImportError extends Schema.TaggedError<ImportError>()("ArdudScheduleImportError", {
  message: Schema.String,
}) {}

/** Reads OpenChamber project files. Never writes to them. */
const readOpenChamberTasks = Effect.fn("readOpenChamberTasks")(function* (projectsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = (yield* fs.readDirectory(projectsDir)).filter((name) => name.endsWith(".json"));
  const items: ArdudScheduleImportItem[] = [];
  const skipped: string[] = [];
  for (const name of names.toSorted()) {
    const file = decodeProjectFile(yield* fs.readFileString(path.join(projectsDir, name)));
    if (Option.isNone(file)) {
      skipped.push(`${name}: unreadable project file`);
      continue;
    }
    const tasks = file.value.scheduledTasks ?? [];
    if (tasks.length === 0) continue;
    const workspaceRoot = file.value.projectPath ?? workspaceRootFromFileName(name);
    if (!workspaceRoot) {
      skipped.push(`${name}: no workspace path`);
      continue;
    }
    for (const raw of tasks) {
      const task = decodeTask(raw);
      if (Option.isNone(task)) {
        skipped.push(`${name}: unreadable task`);
        continue;
      }
      const item = openChamberTaskToImportItem(task.value, workspaceRoot);
      if ("problem" in item) skipped.push(`${task.value.name}: ${item.problem}`);
      else items.push(item);
    }
  }
  return { items, skipped };
});

export const importOpenChamberSchedulesCommand = Command.make("import-openchamber-schedules", {
  ...projectLocationFlags,
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Show what would be imported without changing anything."),
    Flag.withDefault(false),
  ),
  disableAll: Flag.Boolean("disable-all").pipe(
    Flag.withDescription("Import every task disabled, whatever its OpenChamber state."),
    Flag.withDefault(false),
  ),
  sourceDir: Flag.String("source-dir").pipe(
    Flag.withDescription(
      "OpenChamber projects directory (default ~/.config/openchamber/projects).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Import OpenChamber scheduled tasks into the running T3 server."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const projectsDir = Option.getOrElse(flags.sourceDir, () =>
        path.join(NodeOS.homedir(), ".config", "openchamber", "projects"),
      );
      const { items, skipped } = yield* readOpenChamberTasks(projectsDir);
      const request: ArdudScheduleImportRequest = {
        source: "openchamber",
        dryRun: flags.dryRun,
        items: flags.disableAll ? items.map((item) => ({ ...item, enabled: false })) : items,
      };

      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtimeState)) {
        return yield* new ImportError({
          message: "No running T3 server found for this home. Start the server first.",
        });
      }
      const origin = runtimeState.value.origin;

      const result = yield* Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const client = yield* HttpClient.HttpClient;
        return yield* Effect.acquireUseRelease(
          environmentAuth.issueSession({
            scopes: AuthStandardClientScopes,
            label: "t3 ardud schedule import",
          }),
          (issued) =>
            HttpClientRequest.post(new URL(ARDUD_SCHEDULE_IMPORT_PATH, origin).toString()).pipe(
              HttpClientRequest.bearerToken(issued.token),
              HttpClientRequest.bodyJsonUnsafe(request),
              client.execute,
              Effect.flatMap((response) =>
                response.status === 200
                  ? response.json
                  : response.text.pipe(
                      Effect.flatMap((text) =>
                        Effect.fail(
                          new ImportError({
                            message: `Import failed (${response.status}): ${text}`,
                          }),
                        ),
                      ),
                    ),
              ),
              Effect.flatMap(decodeResult),
            ),
          (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore),
        );
      }).pipe(
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );

      yield* Console.log(
        `${result.dryRun ? "Dry run: " : ""}${result.outcomes.length} task(s) from ${projectsDir}`,
      );
      for (const outcome of result.outcomes) {
        yield* Console.log(
          [
            `- ${outcome.title}`,
            `  task ${outcome.taskId}: ${outcome.taskAction}, ${outcome.enabled ? "enabled" : "disabled"}, next ${outcome.nextRunAt ?? "none"}`,
            `  project ${outcome.projectId ?? "(new)"}: ${outcome.projectAction} (${outcome.workspaceRoot})`,
            ...(outcome.note ? [`  note: ${outcome.note}`] : []),
          ].join("\n"),
        );
      }
      for (const line of skipped) yield* Console.log(`skipped: ${line}`);
    }),
  ),
);

export const ardudCommand = Command.make("ardud").pipe(
  Command.withDescription("Fork-only maintenance commands."),
  Command.withSubcommands([
    importOpenChamberSchedulesCommand,
    openCodeImportCommand,
    componentTokenCommand,
  ]),
);
