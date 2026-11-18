// The SDK spawn hook is synchronous: persist ownership before returning the CLI to it.
// @effect-diagnostics nodeBuiltinImport:off -- process identity and crash-safe ownership use host APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";

const Identity = Schema.Struct({
  pid: Schema.Int,
  pgid: Schema.Int,
  startTime: Schema.NonEmptyString,
  commandLine: Schema.NonEmptyString,
});
const Record = Schema.Struct({
  ...Identity.fields,
  providerCommandLine: Schema.NonEmptyString,
  members: Schema.Array(Identity),
  bootId: Schema.NonEmptyString,
  provider: Schema.Literal("claudeAgent"),
  threadId: Schema.String,
  recordedAt: Schema.Number,
  inspectFailures: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
const decodeRecord = Schema.decodeUnknownSync(Record);
const RecordJson = Schema.fromJsonString(Record);
const decodeRecordJson = Schema.decodeUnknownSync(RecordJson);
const encodeRecordJson = Schema.encodeSync(RecordJson);
type ProcessIdentity = typeof Identity.Type;
type ProcessRecord = typeof Record.Type;

export class ProviderProcessRegistry extends Context.Service<
  ProviderProcessRegistry,
  {
    readonly track: (
      pid: number,
      provider: ProcessRecord["provider"],
      threadId: string,
      providerCommandLine: string,
    ) => () => void;
    readonly reap: Effect.Effect<ReadonlyArray<ProcessRecord>>;
  }
>()("t3/ardud/providers/ProviderProcessRegistry") {
  static readonly layerTest = Layer.succeed(ProviderProcessRegistry, {
    track: () => () => {},
    reap: Effect.succeed([]),
  });
}

export interface RegistryHost {
  readonly platform: string;
  readonly bootId: string;
  readonly now: () => number;
  readonly inspect: (pid: number, remainingMs?: () => number) => ProcessIdentity | undefined;
  readonly members: (pgid: number, remainingMs?: () => number) => ReadonlyArray<ProcessIdentity>;
  readonly signal: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly read: () => ReadonlyArray<ProcessRecord>;
  readonly write: (record: ProcessRecord) => void;
  readonly remove: (record: ProcessRecord) => void;
  // Tracking must persist synchronously in the SDK spawn hook; startup I/O can yield.
  readonly cleanupIO?: {
    readonly read: Effect.Effect<ReadonlyArray<ProcessRecord>>;
    readonly write: (record: ProcessRecord) => Effect.Effect<void>;
    readonly remove: (record: ProcessRecord) => Effect.Effect<void>;
  };
  readonly grace: Effect.Effect<void>;
}

export function makeRegistry(host: RegistryHost): ProviderProcessRegistry["Service"] {
  const io = host.cleanupIO ?? {
    read: Effect.sync(host.read),
    write: (record: ProcessRecord) => Effect.sync(() => host.write(record)),
    remove: (record: ProcessRecord) => Effect.sync(() => host.remove(record)),
  };
  const matches = (expected: ProcessIdentity, live: ProcessIdentity | undefined) =>
    live !== undefined &&
    live.pid === expected.pid &&
    live.pgid === expected.pgid &&
    live.startTime === expected.startTime &&
    live.commandLine === expected.commandLine;
  const ownsGroup = (record: ProcessRecord, remainingMs: () => number) => {
    remainingMs();
    const leader = host.inspect(record.pid, remainingMs);
    // The known launch chain execs in place (sh -> systemd-run -> Claude).
    // Its trailing provider invocation stays intact through those transitions.
    const commandMatches =
      leader !== undefined &&
      (leader.commandLine === record.commandLine ||
        leader.commandLine === record.providerCommandLine ||
        leader.commandLine.endsWith(` ${record.providerCommandLine}`));
    return (
      (leader !== undefined &&
        leader.pid === record.pid &&
        leader.pgid === record.pgid &&
        leader.startTime === record.startTime &&
        commandMatches) ||
      record.members.some((member) => {
        remainingMs();
        return (
          member.pgid === record.pgid && matches(member, host.inspect(member.pid, remainingMs))
        );
      })
    );
  };
  const signal = (record: ProcessRecord, signal: "SIGTERM" | "SIGKILL") => {
    try {
      host.signal(record.pgid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  return ProviderProcessRegistry.of({
    track: (pid, provider, threadId, providerCommandLine) => {
      if (host.platform === "win32") return () => {};
      const identity = host.inspect(pid);
      // Never record a shared group (including the backend's own group).
      if (
        identity === undefined ||
        identity.pid !== pid ||
        identity.pid <= 1 ||
        identity.pgid !== pid
      ) {
        throw new Error("Provider process group identity unavailable");
      }
      const record = {
        ...identity,
        providerCommandLine,
        members: [],
        bootId: host.bootId,
        provider,
        threadId,
        recordedAt: host.now(),
      };
      host.write(record);
      return () => {
        try {
          host.remove(record);
        } catch {}
      };
    },
    reap: Effect.suspend(() => {
      if (host.platform === "win32") return Effect.succeed([]);
      const startedAt = host.now();
      const budgetMs = 10_000;
      const stopped: ProcessRecord[] = [];
      let recordsCount = 0;
      let deferredRecords = 0;
      let pendingEscalations = 0;
      let hitBudget = false;
      return Effect.gen(function* () {
        const budgetExceeded = new Error("Previous boot reap budget exhausted");
        const remainingMs = () => {
          const remaining = budgetMs - (host.now() - startedAt);
          if (remaining <= 0) throw budgetExceeded;
          return remaining;
        };
        const uninspectable = Effect.fn("ProviderProcessRegistry.uninspectable")(function* (
          record: ProcessRecord,
          stage: "owns" | "members" | "recheck",
          error: unknown,
        ) {
          const ageMs = Math.max(0, host.now() - record.recordedAt);
          const inspectFailures = (record.inspectFailures ?? 0) + 1;
          const fields = {
            pid: record.pid,
            pgid: record.pgid,
            provider: record.provider,
            threadId: record.threadId,
            bootId: record.bootId,
            ageMs,
            stage,
            error,
            inspectFailures,
          };
          yield* Effect.logWarning("provider.previous-boot-process-uninspectable", fields);
          if (inspectFailures >= 3 || ageMs > 24 * 60 * 60 * 1_000) {
            yield* io.remove(record);
            yield* Effect.logWarning("provider.previous-boot-process-dropped", fields);
            return true;
          } else {
            yield* io.write({ ...record, inspectFailures });
            return false;
          }
        });
        const records = yield* io.read;
        recordsCount = records.length;
        deferredRecords = records.length;
        for (const [index, record] of records.entries()) {
          let retained = record;
          let attempted = false;
          let stage: "owns" | "members" | "recheck" | "persist" | "signal" = "owns";
          try {
            remainingMs();
            if (record.bootId === host.bootId) {
              deferredRecords = records.length - index - 1;
              continue;
            }
            attempted = true;
            deferredRecords = records.length - index;
            if (record.pid <= 1 || record.pgid !== record.pid || !ownsGroup(record, remainingMs)) {
              stage = "persist";
              yield* io.remove(record);
              deferredRecords = records.length - index - 1;
              continue;
            }
            // Persist anchors before TERM, so another backend death during grace is recoverable.
            stage = "members";
            remainingMs();
            const anchored = {
              ...record,
              members: host
                .members(record.pgid, remainingMs)
                .filter((member) => member.pid > 1 && member.pgid === record.pgid),
            };
            // Do not adopt members of a replacement group while taking the snapshot.
            stage = "recheck";
            if (!ownsGroup(record, remainingMs)) {
              stage = "persist";
              yield* io.remove(record);
              deferredRecords = records.length - index - 1;
              continue;
            }
            stage = "persist";
            yield* io.write(anchored);
            retained = anchored;
            stage = "recheck";
            const owned = ownsGroup(anchored, remainingMs);
            remainingMs();
            stage = "signal";
            if (owned && signal(anchored, "SIGTERM")) {
              stopped.push(anchored);
              pendingEscalations = stopped.length;
            } else {
              stage = "persist";
              yield* io.remove(anchored);
            }
          } catch (error) {
            if (error === budgetExceeded || host.now() - startedAt >= budgetMs) {
              hitBudget = true;
              deferredRecords = records.length - index;
              if (attempted && stage !== "persist" && stage !== "signal") {
                if (yield* uninspectable(retained, stage, error)) deferredRecords--;
              }
              break;
            }
            if (stage === "persist" || stage === "signal") {
              yield* Effect.logWarning("provider.previous-boot-reap-failed", {
                pid: record.pid,
                stage,
                error,
              });
            } else {
              yield* uninspectable(retained, stage, error);
            }
          }
          deferredRecords = records.length - index - 1;
        }
        if (stopped.length > 0 && !hitBudget) {
          const remaining = budgetMs - (host.now() - startedAt);
          if (remaining <= 0) hitBudget = true;
          else if (Option.isNone(yield* host.grace.pipe(Effect.timeoutOption(remaining)))) {
            hitBudget = true;
          }
        }
        for (const [index, record] of stopped.entries()) {
          if (hitBudget) {
            pendingEscalations = stopped.length - index;
            break;
          }
          let stage: "recheck" | "signal" | "persist" = "recheck";
          try {
            // A surviving, start-checked member keeps this pgid reserved after leader exit.
            const owned = ownsGroup(record, remainingMs);
            remainingMs();
            stage = "signal";
            if (owned) signal(record, "SIGKILL");
            pendingEscalations = stopped.length - index - 1;
            stage = "persist";
            yield* io.remove(record);
            yield* Effect.logWarning("provider.previous-boot-process-reaped", {
              threadId: record.threadId,
              provider: record.provider,
              pid: record.pid,
              ageMs: Math.max(0, host.now() - record.recordedAt),
              bootId: record.bootId,
            });
          } catch (error) {
            if (error === budgetExceeded || host.now() - startedAt >= budgetMs) {
              hitBudget = true;
              pendingEscalations = stopped.length - index - (stage === "persist" ? 1 : 0);
              if (stage === "recheck" && (yield* uninspectable(record, stage, error))) {
                pendingEscalations--;
              }
              break;
            }
            if (stage === "recheck") yield* uninspectable(record, stage, error);
            else
              yield* Effect.logWarning("provider.previous-boot-reap-failed", {
                pid: record.pid,
                stage,
                error,
              });
          }
          pendingEscalations = stopped.length - index - 1;
        }
        return stopped;
      }).pipe(
        Effect.timeoutOption(budgetMs),
        Effect.flatMap((result) => {
          const records = Option.getOrElse(result, () => stopped);
          return hitBudget || Option.isNone(result)
            ? Effect.logWarning("provider.previous-boot-reap-budget", {
                budgetMs,
                elapsedMs: host.now() - startedAt,
                records: recordsCount,
                deferredRecords,
                stoppedRecords: stopped.length,
                pendingEscalations,
              }).pipe(Effect.as(records))
            : Effect.succeed(records);
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.previous-boot-reap-failed", { cause }).pipe(Effect.as([])),
      ),
      Effect.withSpan("ProviderProcessRegistry.reap"),
    ),
  });
}

// Darwin ps only reports seconds. proc_bsdinfo retains the microseconds needed to
// distinguish PID reuse within the same second. Use the system Python as the FFI
// bridge; an unavailable probe fails closed rather than falling back to ps time.
const DARWIN_START_TIME = `import ctypes,sys,struct
lib = ctypes.CDLL('/usr/lib/libproc.dylib')
buf = ctypes.create_string_buffer(136)
if lib.proc_pidinfo(int(sys.argv[1]), 3, 0, buf, 136) != 136: sys.exit(1)
print('%d:%d' % struct.unpack_from('QQ', buf.raw, 120))`;

function processStartTime(pid: number, platform: string, remainingMs?: () => number): string {
  const timeout = Math.min(2_000, remainingMs?.() ?? 2_000);
  if (platform === "linux") {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
    if (ticks === undefined || !/^\d+$/.test(ticks)) throw new Error("Invalid process start time");
    return `${NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
  }
  return NodeChildProcess.execFileSync(
    "/usr/bin/python3",
    ["-I", "-c", DARWIN_START_TIME, String(pid)],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    },
  ).trim();
}

// ps is queried for one captured PID, never to discover processes by name.
function inspectProcess(
  pid: number,
  platform: string,
  remainingMs?: () => number,
): ProcessIdentity | undefined {
  try {
    const startTime = processStartTime(pid, platform, remainingMs);
    const output = NodeChildProcess.execFileSync(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "pgid=", "-o", "command="],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: Math.min(2_000, remainingMs?.() ?? 2_000),
      },
    ).trim();
    const match = /^(\d+)\s+([\s\S]+)$/.exec(output);
    if (match === null) throw new Error("Invalid process identity");
    // A PID recycled while reading ps must not combine the old command with a new start time.
    if (processStartTime(pid, platform, remainingMs) !== startTime) return undefined;
    return { pid, pgid: Number(match[1]), startTime, commandLine: match[2]! };
  } catch (error) {
    try {
      process.kill(pid, 0);
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code === "ESRCH") return undefined;
      throw probeError;
    }
    throw error;
  }
}

function groupMembers(
  pgid: number,
  platform: string,
  remainingMs?: () => number,
): ReadonlyArray<ProcessIdentity> {
  // Enumerate numeric group membership; never discover targets by a command pattern.
  const output = NodeChildProcess.execFileSync("/bin/ps", ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: Math.min(2_000, remainingMs?.() ?? 2_000),
  });
  return output
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, group] = line.trim().split(/\s+/).map(Number);
      if (pid === undefined || pid <= 1 || group !== pgid) return [];
      const member = inspectProcess(pid, platform, remainingMs);
      return member !== undefined && member.pgid === pgid ? [member] : [];
    });
}

export const layer = Layer.effect(
  ProviderProcessRegistry,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcess.Platform;
    const bootId = NodeCrypto.randomUUID();
    const dir = NodePath.join(config.stateDir, "runtime", "provider-processes");
    const file = (record: ProcessRecord) =>
      NodePath.join(dir, `${record.bootId}-${record.pid}.json`);
    return makeRegistry({
      platform,
      bootId,
      now: Date.now,
      inspect: (pid, remainingMs) => inspectProcess(pid, platform, remainingMs),
      members: (pgid, remainingMs) => groupMembers(pgid, platform, remainingMs),
      signal: (pgid, signal) => process.kill(-pgid, signal),
      grace: Effect.sleep("1 second"),
      cleanupIO: {
        read: Effect.promise(async () => {
          let names: string[];
          try {
            names = await NodeFS.promises.readdir(dir);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
          const records: ProcessRecord[] = [];
          for (const name of names) {
            if (!name.endsWith(".json")) continue;
            const contents = await NodeFS.promises.readFile(NodePath.join(dir, name), "utf8");
            records.push(decodeRecordJson(contents));
          }
          return records;
        }),
        write: (record) =>
          Effect.promise(async () => {
            await NodeFS.promises.mkdir(dir, { recursive: true, mode: 0o700 });
            const target = file(record);
            await NodeFS.promises.writeFile(`${target}.new`, encodeRecordJson(record), {
              mode: 0o600,
              flush: true,
            });
            await NodeFS.promises.rename(`${target}.new`, target);
          }),
        remove: (record) => Effect.promise(() => NodeFS.promises.rm(file(record), { force: true })),
      },
      read: () => {
        if (!NodeFS.existsSync(dir)) return [];
        return NodeFS.readdirSync(dir)
          .filter((name) => name.endsWith(".json"))
          .map((name) =>
            decodeRecord(JSON.parse(NodeFS.readFileSync(NodePath.join(dir, name), "utf8"))),
          );
      },
      write: (record) => {
        NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const target = file(record);
        NodeFS.writeFileSync(`${target}.new`, JSON.stringify(record), { mode: 0o600, flush: true });
        NodeFS.renameSync(`${target}.new`, target);
      },
      remove: (record) => NodeFS.rmSync(file(record), { force: true }),
    });
  }),
);
