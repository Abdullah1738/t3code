/**
 * Runs the iMessage bridge CLI (`integrations/spectrum-bridge/src/cli.ts`,
 * deployed under `~/.local/share/spectrum-bridge`) with an argv array, never
 * through a shell. A service so tests never spawn bun.
 */
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- path joins for the default locations.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../processRunner.ts";

export const BRIDGE_CLI_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface BridgeCliPaths {
  readonly bun: string;
  readonly cli: string;
}

/** `ROBOB_BUN` and `ROBOB_IMESSAGE_BRIDGE_CLI`, else the deployed defaults. */
export const bridgeCliPaths = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): BridgeCliPaths => ({
  bun: env.ROBOB_BUN?.trim() || NodePath.join(home, ".bun", "bin", "bun"),
  cli:
    env.ROBOB_IMESSAGE_BRIDGE_CLI?.trim() ||
    NodePath.join(home, ".local", "share", "spectrum-bridge", "src", "cli.ts"),
});

export interface BridgeCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export class ImessageBridgeCliUnavailable extends Schema.TaggedError<ImessageBridgeCliUnavailable>()(
  "ImessageBridgeCliUnavailable",
  { reason: Schema.String },
) {}

export class ImessageBridgeCli extends Context.Service<
  ImessageBridgeCli,
  {
    /** Runs `<bun> <cli.ts> ...args`. */
    readonly run: (
      args: ReadonlyArray<string>,
    ) => Effect.Effect<BridgeCliResult, ImessageBridgeCliUnavailable>;
  }
>()("t3/ardud/imessage/ImessageBridgeCli") {}

export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  return ImessageBridgeCli.of({
    run: Effect.fn("ImessageBridgeCli.run")(function* (args) {
      const paths = bridgeCliPaths(process.env, NodeOS.homedir());
      return yield* runner
        .run({
          command: paths.bun,
          args: [paths.cli, ...args],
          // The bridge's own folder, so bun reads its package config, not the server's.
          spawnCwd: NodePath.dirname(paths.cli),
          timeout: BRIDGE_CLI_TIMEOUT_MS,
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((output): BridgeCliResult => ({
            stdout: output.stdout,
            stderr: output.stderr,
            exitCode: output.code === null ? null : Number(output.code),
            timedOut: output.timedOut,
          })),
          Effect.mapError(
            (error) =>
              new ImessageBridgeCliUnavailable({
                reason:
                  error._tag === "ProcessSpawnError"
                    ? "Could not start the iMessage bridge CLI."
                    : "The iMessage bridge CLI did not finish cleanly.",
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(ImessageBridgeCli, make).pipe(Layer.provide(ProcessRunner.layer));
