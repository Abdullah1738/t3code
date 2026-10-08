import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import { readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import { OPENCODE_IMPORT_RUN_PATH } from "./http.ts";

const encodePretty = (value: unknown) =>
  encodeResult(value).pipe(Effect.orElseSucceed(() => String(value)));

const encodeResult = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown, { space: 2 }),
);

class ImportCommandError extends Schema.TaggedError<ImportCommandError>()(
  "ArdudOpenCodeImportCommandError",
  { message: Schema.String },
) {}

/** `t3 ardud opencode-import`: runs one import on this home's running server. */
export const openCodeImportCommand = Command.make("opencode-import", {
  ...projectLocationFlags,
  since: Flag.Int("since").pipe(
    Flag.withDescription("Only sessions updated in the last N days."),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("At most N sessions, newest first."),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Count what would change without changing anything."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show OpenCode sessions as threads in the running T3 server."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtimeState)) {
        return yield* new ImportCommandError({
          message: "No running T3 server found for this home. Start the server first.",
        });
      }
      const origin = runtimeState.value.origin;
      const body = {
        dryRun: flags.dryRun,
        ...(Option.isSome(flags.since) ? { sinceDays: flags.since.value } : {}),
        ...(Option.isSome(flags.limit) ? { limit: flags.limit.value } : {}),
      };
      const result = yield* Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const client = yield* HttpClient.HttpClient;
        return yield* Effect.acquireUseRelease(
          environmentAuth.issueSession({
            scopes: AuthStandardClientScopes,
            label: "t3 ardud opencode-import",
          }),
          (issued) =>
            HttpClientRequest.post(new URL(OPENCODE_IMPORT_RUN_PATH, origin).toString()).pipe(
              HttpClientRequest.bearerToken(issued.token),
              HttpClientRequest.bodyJsonUnsafe(body),
              client.execute,
              Effect.flatMap((response) =>
                response.status === 200
                  ? response.json
                  : response.text.pipe(
                      Effect.flatMap((text) =>
                        Effect.fail(
                          new ImportCommandError({
                            message: `Import failed (${response.status}): ${text}`,
                          }),
                        ),
                      ),
                    ),
              ),
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
      yield* Console.log(yield* encodePretty(result));
    }),
  ),
);
