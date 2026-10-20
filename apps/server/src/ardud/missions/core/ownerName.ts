// @effect-diagnostics nodeBuiltinImport:off - one read-only lookup of the server account's full name at start.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The owner's full name for the board greeting: the server account's full
 * name, read once at start. Null when the machine has none (and in tests).
 */
export const MissionOwnerName = Context.Reference<{ readonly name: string | null }>(
  "t3/ardud/missions/core/MissionOwnerName",
  { defaultValue: () => ({ name: null }) },
);

const run = (binary: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise(
    () =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(binary, [...args], { timeout: 2_000 }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        );
      }),
  );

/** macOS keeps the full name in the account record; Linux in the passwd comment field. */
const readAccountName = Effect.gen(function* () {
  if (process.platform === "darwin") return (yield* run("/usr/bin/id", ["-F"])).trim();
  if (process.platform !== "linux") return "";
  const entry = yield* run("getent", ["passwd", NodeOS.userInfo().username]);
  return (entry.trim().split(":")[4] ?? "").split(",")[0]?.trim() ?? "";
}).pipe(
  Effect.map((name) => (name === "" ? null : name)),
  Effect.orElseSucceed(() => null),
);

export const MissionOwnerNameLive = Layer.effect(
  MissionOwnerName,
  Effect.map(readAccountName, (name) => ({ name })),
);
