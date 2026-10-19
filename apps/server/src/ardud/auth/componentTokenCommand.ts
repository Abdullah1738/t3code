import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import { COMPONENTS, issueComponentSession, listComponentSessions } from "./components.ts";

const withAuth = <A, E, R>(
  flags: CliAuthLocationFlags,
  quiet: boolean,
  run: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* run.pipe(
      Effect.provide(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(
            Layer.succeed(References.MinimumLogLevel, quiet ? "Error" : config.logLevel),
          ),
        ),
      ),
    );
  });

const encodePretty = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown, { space: 2 }),
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const issueCommand = Command.make("issue", {
  ...authLocationFlags,
  component: Argument.String("component").pipe(
    Argument.withDescription(`One of: ${Object.keys(COMPONENTS).join(", ")}.`),
  ),
  ttl: Flag.String("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("TTL, for example `90d`. Defaults to 365 days."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Issue a component's own bearer token: its scopes only, and the server knows which component calls.",
  ),
  Command.withHandler((flags) =>
    withAuth(
      flags,
      true,
      Effect.gen(function* () {
        const issued = yield* issueComponentSession({
          component: flags.component,
          ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
        });
        const expiresAt = DateTime.formatIso(issued.expiresAt);
        yield* Console.log(
          flags.json
            ? yield* encodePretty({
                component: flags.component,
                sessionId: issued.sessionId,
                token: issued.token,
                scopes: issued.scopes,
                expiresAt,
              })
            : [
                `component: ${flags.component}`,
                `session: ${issued.sessionId}`,
                `scopes: ${issued.scopes.join(", ")}`,
                `expires: ${expiresAt}`,
                `token: ${issued.token}`,
              ].join("\n"),
        );
      }),
    ),
  ),
);

const listCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List active component tokens without revealing them."),
  Command.withHandler((flags) =>
    withAuth(
      flags,
      flags.json,
      Effect.gen(function* () {
        const sessions = yield* listComponentSessions;
        const rows = sessions.map((session) => ({
          component: session.component,
          sessionId: session.sessionId,
          scopes: session.scopes,
          expiresAt: DateTime.formatIso(session.expiresAt),
          lastConnectedAt:
            session.lastConnectedAt === null ? null : DateTime.formatIso(session.lastConnectedAt),
        }));
        yield* Console.log(
          flags.json
            ? yield* encodePretty(rows)
            : rows.length === 0
              ? "No component tokens."
              : rows
                  .map(
                    (row) =>
                      `${row.component}  ${row.sessionId}  ${row.scopes.join(",")}  expires ${row.expiresAt}  last ${row.lastConnectedAt ?? "never"}`,
                  )
                  .join("\n"),
        );
      }),
    ),
  ),
);

/**
 * `t3 ardud component-token issue|list`. Revoke with `t3 auth session revoke`.
 */
export const componentTokenCommand = Command.make("component-token").pipe(
  Command.withDescription("Named credentials for Robob's own components."),
  Command.withSubcommands([issueCommand, listCommand]),
);
