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
});
const decodeRecord = Schema.decodeUnknownSync(Record);
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
  readonly inspect: (pid: number) => ProcessIdentity | undefined;
  readonly members: (pgid: number) => ReadonlyArray<ProcessIdentity>;
  readonly signal: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly read: () => ReadonlyArray<ProcessRecord>;
  readonly write: (record: ProcessRecord) => void;
  readonly remove: (record: ProcessRecord) => void;
  readonly grace: Effect.Effect<void>;
}

export function makeRegistry(host: RegistryHost): ProviderProcessRegistry["Service"] {
  const matches = (expected: ProcessIdentity, live: ProcessIdentity | undefined) =>
    live !== undefined &&
    live.pid === expected.pid &&
    live.pgid === expected.pgid &&
    live.startTime === expected.startTime &&
    live.commandLine === expected.commandLine;
  const ownsGroup = (record: ProcessRecord) => {
    const leader = host.inspect(record.pid);
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
      record.members.some(
        (member) => member.pgid === record.pgid && matches(member, host.inspect(member.pid)),
      )
    );
  };
  const signal = (record: ProcessRecord, signal: "SIGTERM" | "SIGKILL") => {
    // A surviving, start-checked member keeps this pgid reserved after leader exit.
    if (!ownsGroup(record)) return false;
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
    reap: Effect.gen(function* () {
      if (host.platform === "win32") return [];
      const stopped: ProcessRecord[] = [];
      for (const record of host.read()) {
        if (record.bootId === host.bootId) continue;
        if (record.pid <= 1 || record.pgid !== record.pid || !ownsGroup(record)) {
          host.remove(record);
          continue;
        }
        // Persist anchors before TERM, so another backend death during grace is recoverable.
        const anchored = {
          ...record,
          members: host
            .members(record.pgid)
            .filter((member) => member.pid > 1 && member.pgid === record.pgid),
        };
        // Do not adopt members of a replacement group while taking the snapshot.
        if (!ownsGroup(record)) {
          host.remove(record);
          continue;
        }
        host.write(anchored);
        if (signal(anchored, "SIGTERM")) stopped.push(anchored);
        else host.remove(anchored);
      }
      if (stopped.length > 0) yield* host.grace;
      for (const record of stopped) {
        signal(record, "SIGKILL");
        host.remove(record);
        yield* Effect.logWarning("provider.previous-boot-process-reaped", {
          threadId: record.threadId,
          provider: record.provider,
          pid: record.pid,
          ageMs: Math.max(0, host.now() - record.recordedAt),
          bootId: record.bootId,
        });
      }
      return stopped;
    }).pipe(Effect.withSpan("ProviderProcessRegistry.reap")),
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

function processStartTime(pid: number, platform: string): string {
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
      timeout: 2_000,
    },
  ).trim();
}

// ps is queried for one captured PID, never to discover processes by name.
function inspectProcess(pid: number, platform: string): ProcessIdentity | undefined {
  try {
    const startTime = processStartTime(pid, platform);
    const output = NodeChildProcess.execFileSync(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "pgid=", "-o", "command="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 },
    ).trim();
    const match = /^(\d+)\s+([\s\S]+)$/.exec(output);
    if (match === null) throw new Error("Invalid process identity");
    // A PID recycled while reading ps must not combine the old command with a new start time.
    if (processStartTime(pid, platform) !== startTime) return undefined;
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

function groupMembers(pgid: number, platform: string): ReadonlyArray<ProcessIdentity> {
  // Enumerate numeric group membership; never discover targets by a command pattern.
  const output = NodeChildProcess.execFileSync("/bin/ps", ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
  return output
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, group] = line.trim().split(/\s+/).map(Number);
      if (pid === undefined || pid <= 1 || group !== pgid) return [];
      const member = inspectProcess(pid, platform);
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
      inspect: (pid) => inspectProcess(pid, platform),
      members: (pgid) => groupMembers(pgid, platform),
      signal: (pgid, signal) => process.kill(-pgid, signal),
      grace: Effect.sleep("1 second"),
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
