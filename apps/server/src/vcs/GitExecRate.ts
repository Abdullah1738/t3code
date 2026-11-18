import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as Analytics from "../ardud/analytics/Analytics.ts";

export class GitExecRate extends Context.Service<
  GitExecRate,
  {
    readonly record: (input: {
      readonly operation: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }) => Effect.Effect<void>;
  }
>()("t3/vcs/GitExecRate") {}

// Only the command name is retained. Option values can contain paths or credentials.
function subcommand(args: readonly string[]) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) {
      i++;
    } else if (!arg.startsWith("-")) {
      return /^[a-z][a-z0-9-]{0,40}$/.test(arg) ? arg : "other";
    }
  }
  return "unknown";
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const cwdHashes = new Map<string, string>();
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  let startedAt = yield* Clock.currentTimeMillis;
  let total = 0;
  let maxPerSecond = 0;
  let second = -1;
  let secondCount = 0;
  const cwds = new Set<string>();
  const keys = new Map<
    string,
    { operation: string; subcommand: string; cwdHash: string; count: number }
  >();
  let overflow = 0;

  // Already inside a process span; avoid another span for each counter increment.
  const record = Effect.fnUntraced(function* (input: {
    readonly operation: string;
    readonly args: readonly string[];
    readonly cwd: string;
  }) {
    let cwdHash = cwdHashes.get(input.cwd);
    if (cwdHash === undefined) {
      const bytes = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(input.cwd))
        .pipe(Effect.orElseSucceed(() => new Uint8Array(8)));
      cwdHash = Array.from(bytes.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
      if (cwdHashes.size >= 8192) cwdHashes.clear();
      cwdHashes.set(input.cwd, cwdHash);
    }
    const now = yield* Clock.currentTimeMillis;
    const operation = /^[a-zA-Z0-9_.:/#@%+-]{1,160}$/.test(input.operation)
      ? input.operation
      : "other";
    const command = subcommand(input.args);
    const key = `${operation}\0${command}\0${cwdHash}`;
    total++;
    // The window bounds these sets; cap cardinality even if callers supply arbitrary workspaces.
    if (cwds.size < 8192) cwds.add(cwdHash);
    const bucket = Math.floor(now / 1000);
    secondCount = bucket === second ? secondCount + 1 : 1;
    second = bucket;
    maxPerSecond = Math.max(maxPerSecond, secondCount);
    const entry = keys.get(key);
    if (entry) entry.count++;
    else if (keys.size < 8192) keys.set(key, { operation, subcommand: command, cwdHash, count: 1 });
    else overflow++;
  });

  const flush = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const props = {
      total,
      distinctCwds: cwds.size,
      maxPerSecond,
      windowMs: now - startedAt,
      overflow,
      top: [...keys.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    };
    total = maxPerSecond = secondCount = overflow = 0;
    second = -1;
    cwds.clear();
    keys.clear();
    startedAt = now;
    if (analytics._tag === "Some") {
      yield* analytics.value
        .record({
          kind: "vcs.git_exec_rate",
          ts: DateTime.formatIso(DateTime.makeUnsafe(now)),
          surface: "server",
          route: "vcs",
          props,
        })
        .pipe(Effect.catchCause(() => Effect.void));
    } else {
      yield* Effect.logInfo("vcs.git_exec_rate", props);
    }
  });
  yield* flush.pipe(
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.delay("1 minute"),
    Effect.forkScoped,
  );
  return GitExecRate.of({ record });
});

export const layer = Layer.effect(GitExecRate, make);
