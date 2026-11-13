// @effect-diagnostics nodeBuiltinImport:off -- this low-volume emergency log must survive trace rotation.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ErrorObserver,
  sqliteErrorDetails,
  type SqliteErrorContext,
} from "@t3tools/shared/nodeSqliteErrors";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as ServerConfig from "../config.ts";

const WINDOW_MS = 60_000;
const DEGRADED_MS = 5 * 60_000;
const MAX_KEYS = 128;
const decodeIntegrityMarker = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ unverified: Schema.Literal(true), reason: Schema.optionalKey(Schema.String) }),
  ),
);
const NAMES: Readonly<Record<number, string>> = {
  1: "SQLITE_ERROR",
  2: "SQLITE_INTERNAL",
  3: "SQLITE_PERM",
  4: "SQLITE_ABORT",
  5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED",
  8: "SQLITE_READONLY",
  10: "SQLITE_IOERR",
  11: "SQLITE_CORRUPT",
  13: "SQLITE_FULL",
  14: "SQLITE_CANTOPEN",
  26: "SQLITE_NOTADB",
  7: "SQLITE_NOMEM",
  9: "SQLITE_INTERRUPT",
  12: "SQLITE_NOTFOUND",
  15: "SQLITE_PROTOCOL",
  16: "SQLITE_EMPTY",
  17: "SQLITE_SCHEMA",
  18: "SQLITE_TOOBIG",
  19: "SQLITE_CONSTRAINT",
  20: "SQLITE_MISMATCH",
  21: "SQLITE_MISUSE",
  22: "SQLITE_NOLFS",
  23: "SQLITE_AUTH",
  24: "SQLITE_FORMAT",
  25: "SQLITE_RANGE",
  27: "SQLITE_NOTICE",
  28: "SQLITE_WARNING",
};

interface Incident {
  readonly file: string;
  readonly role: SqliteErrorContext["role"];
  readonly errcode: number;
  readonly primaryName: string;
  firstAt: number;
  lastAt: number;
  count: number;
}
interface LogWindow {
  record: Incident & SqliteErrorContext & { errstr: string | undefined };
  at: number;
  suppressed: number;
}

/** Bounded process-local evidence, independent of whether later SQL succeeds. */
export function createDatabaseMonitor(now: () => number, emit: (line: string) => void) {
  const unverifiedDatabases = new Map<string, { file: string; reason: string }>();
  const markUnverified = (file: string, reason: string) => {
    if (unverifiedDatabases.size < 16) unverifiedDatabases.set(file, { file, reason });
  };
  const observed = new WeakSet<object>();
  const incidents = new Map<string, Incident>();
  const windows = new Map<string, LogWindow>();
  let overflow: Incident | undefined;
  let recentOverflow: Incident | undefined;
  const retainRecent = (row: Incident) => {
    if (
      [10, 11, 26].includes(row.errcode & 0xff) &&
      (!recentOverflow || row.lastAt >= recentOverflow.lastAt)
    )
      recentOverflow = row;
  };
  const output = (window: LogWindow, count: number) =>
    emit(
      JSON.stringify({
        ...window.record,
        time: DateTime.formatIso(DateTime.makeUnsafe(now())),
        count,
      }) + "\n",
    );
  const flush = (closing = false) => {
    for (const [key, window] of windows) {
      if (!closing && now() - window.at < WINDOW_MS) continue;
      if (window.suppressed > 0) {
        output(window, window.suppressed);
        window.at = now();
        window.suppressed = 0;
        if (closing) windows.delete(key);
      } else windows.delete(key);
    }
  };
  const observe = (cause: unknown, context: SqliteErrorContext) => {
    const details = sqliteErrorDetails(cause);
    if (!details) return;
    if (typeof cause === "object" && cause !== null) {
      if (observed.has(cause)) return;
      observed.add(cause);
    }
    const { errcode, errstr } = details;
    const code = errcode & 0xff;
    const key = `${context.file}\0${context.role}\0${errcode}`;
    const at = now();
    const primaryName = NAMES[code] ?? `SQLITE_${code}`;
    const prior = incidents.get(key);
    const incident: Incident = prior ?? {
      file: context.file,
      role: context.role,
      errcode,
      primaryName,
      firstAt: at,
      lastAt: at,
      count: 0,
    };
    incident.lastAt = at;
    incident.count++;
    if (!prior && incidents.size >= MAX_KEYS) {
      // Never evict evidence of unverified primary corruption to make health green.
      const removable = [...incidents].find(([, row]) => !sticky(row));
      if (removable) {
        retainRecent(removable[1]);
        incidents.delete(removable[0]);
      } else {
        overflow = incident;
        retainRecent(incident);
      }
    }
    if (incidents.size < MAX_KEYS || prior) incidents.set(key, incident);
    flush();
    const window = windows.get(key);
    if (window) {
      window.suppressed++;
      window.record = { ...incident, ...context, errstr };
      windows.delete(key);
      windows.set(key, window);
      return;
    }
    if (windows.size >= MAX_KEYS) {
      // Keep memory bounded without discarding evidence from a new file/code.
      // Flush the least-recent window before making room under cardinality pressure.
      const oldest = windows.entries().next().value;
      if (oldest) {
        if (oldest[1].suppressed > 0) output(oldest[1], oldest[1].suppressed);
        windows.delete(oldest[0]);
      }
    }
    const next: LogWindow = { record: { ...incident, ...context, errstr }, at, suppressed: 0 };
    windows.set(key, next);
    output(next, 1);
  };
  const health = () => {
    const rows = [
      ...new Set([
        ...incidents.values(),
        ...(overflow ? [overflow] : []),
        ...(recentOverflow ? [recentOverflow] : []),
      ]),
    ];
    const recent = rows.filter(
      (row) => [10, 11, 26].includes(row.errcode & 0xff) && now() - row.lastAt < DEGRADED_MS,
    );
    const unverified = rows.filter(sticky);
    const status = recent.length
      ? "degraded"
      : unverified.length || unverifiedDatabases.size
        ? "recovered-unverified"
        : "healthy";
    return {
      status,
      unverifiedDatabases: [...unverifiedDatabases.values()],
      databaseErrors: (status === "degraded"
        ? [...new Set([...recent, ...unverified])]
        : unverified
      ).map((row) => ({
        ...row,
        firstAt: DateTime.formatIso(DateTime.makeUnsafe(row.firstAt)),
        lastAt: DateTime.formatIso(DateTime.makeUnsafe(row.lastAt)),
      })),
    };
  };
  return { observe, flush, health, markUnverified };
}

function sticky(row: Incident): boolean {
  return row.role === "primary" && [11, 26].includes(row.errcode & 0xff);
}

export class DatabaseDiagnostics extends Context.Service<
  DatabaseDiagnostics,
  {
    readonly health: Effect.Effect<ReturnType<ReturnType<typeof createDatabaseMonitor>["health"]>>;
  }
>()("t3/persistence/DatabaseDiagnostics") {}

/** Daily bounded files keep a week of DB evidence outside the high-volume trace. */
export const writeDatabaseError = Effect.fn("DatabaseDiagnostics.write")(function* (
  directory: string,
  line: string,
  now: number,
) {
  yield* Effect.tryPromise(async () => {
    await NodeFSP.mkdir(directory, { recursive: true });
    const day = DateTime.formatIso(DateTime.makeUnsafe(now)).slice(0, 10);
    const path = NodePath.join(directory, `db-errors.${day}.ndjson`);
    const size = await NodeFSP.stat(path).then(
      (s) => s.size,
      () => 0,
    );
    if (size + Buffer.byteLength(line) > 1024 * 1024) await NodeFSP.rename(path, `${path}.1`);
    const handle = await NodeFSP.open(path, "a", 0o600);
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const cutoff = DateTime.formatIso(DateTime.makeUnsafe(now - 7 * 86_400_000)).slice(0, 10);
    for (const name of await NodeFSP.readdir(directory)) {
      const match = /^db-errors\.(\d{4}-\d{2}-\d{2})\.ndjson(?:\.1)?$/.exec(name);
      if (match && match[1]! < cutoff) await NodeFSP.unlink(NodePath.join(directory, name));
    }
  }).pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        process.stderr.write(line);
      }),
    ),
    // Scope closure must wait for the native append, fsync and close to finish.
    Effect.uninterruptible,
  );
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();
  const pending: string[] = [];
  const monitor = createDatabaseMonitor(now, (line) => {
    if (pending.length >= MAX_KEYS) process.stderr.write(line);
    else pending.push(line);
  });
  // This sidecar carries an owner's deferred integrity check across releases;
  // it never reads or probes the database itself and has no automatic clearing path.
  yield* Effect.promise(async () => {
    const marker = NodePath.join(config.logsDir, "db-integrity-unverified.json");
    try {
      if ((await NodeFSP.stat(marker)).size > 16_384) throw new Error("oversized integrity marker");
      const value = decodeIntegrityMarker(await NodeFSP.readFile(marker, "utf8"));
      monitor.markUnverified(
        config.dbPath,
        value.reason?.slice(0, 512) ?? "Integrity check deferred",
      );
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      )
        monitor.markUnverified(config.dbPath, "Integrity status marker unreadable");
    }
  });
  const drain = Effect.fn("DatabaseDiagnostics.flush")(function* () {
    monitor.flush();
    while (pending.length) {
      // Keep the record queued until the append is durable, with no interruptible
      // gap between completing it and releasing its queue ownership.
      yield* Effect.uninterruptible(
        Effect.suspend(() =>
          writeDatabaseError(config.logsDir, pending[0]!, now()).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                pending.shift();
              }),
            ),
          ),
        ),
      );
    }
  });
  yield* Effect.addFinalizer(() => {
    monitor.flush(true);
    return drain();
  });
  yield* drain().pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped);
  return Context.make(DatabaseDiagnostics, { health: Effect.sync(monitor.health) }).pipe(
    Context.add(ErrorObserver, monitor.observe),
  );
});

export const layer = Layer.effectContext(make);
