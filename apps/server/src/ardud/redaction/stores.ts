import * as Reactivity from "effect/reactivity/Reactivity";
import * as Statement from "effect/sql/Statement";
// @effect-diagnostics nodeBuiltinImport:off - Maintenance attaches existing files to the server-owned writer and preserves their modes.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class RedactionStoresError extends Schema.TaggedError<RedactionStoresError>()(
  "RedactionStoresError",
  {},
) {
  override get message() {
    return "Redaction store maintenance did not complete.";
  }
}
export interface RedactionStore {
  readonly db: string;
  readonly path: string;
  readonly label: string;
}
const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new RedactionStoresError({}) });

/** Reserve the existing writer across attachment setup, the content transaction and checkpointing. */
export const withWriter = Effect.fn("ThreadRedaction.withWriter")(
  <A, E, R>(
    writer: SqlClient.SqlClient,
    use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* writer.reserve;
        const sql = yield* SqlClient.make({
          acquirer: Effect.succeed(connection),
          borrower: (f) => f(connection),
          compiler: Statement.makeCompilerSqlite(),
          transactionService: writer.transactionService,
          beginTransaction: "BEGIN IMMEDIATE",
          onCommitFailure: (conn) =>
            conn.executeUnprepared("ROLLBACK", [], undefined).pipe(Effect.asVoid),
          spanAttributes: [],
        }).pipe(Effect.provide(Reactivity.layer));
        return yield* use(sql);
      }),
    ),
);

export const makeStoreCleanup = () => ({
  attached: new Set<string>(),
  modes: new Map<string, number>(),
  syncModes: new Map<string, number>(),
  fullFsync: undefined as number | undefined,
});

export const withStores = Effect.fn("ThreadRedaction.withStores")(
  <A, E, R>(
    sql: SqlClient.SqlClient,
    replicaPath: string,
    use: (stores: readonly RedactionStore[]) => Effect.Effect<A, E, R>,
    state = makeStoreCleanup(),
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const cleanup = Effect.fn("ThreadRedaction.cleanupStores")(function* () {
          for (const [db, mode] of state.syncModes) {
            const restored = yield* sql
              .unsafe(`PRAGMA ${db}.synchronous=${mode}`)
              .pipe(Effect.result);
            if (restored._tag === "Success") state.syncModes.delete(db);
          }
          for (const db of [...state.attached].toReversed()) {
            const detached = yield* sql.unsafe(`DETACH DATABASE ${db}`).pipe(Effect.result);
            if (detached._tag === "Success") {
              state.attached.delete(db);
              state.syncModes.delete(db);
            }
          }
          for (const [file, mode] of state.modes) {
            const restored = yield* io(() => NodeFSP.chmod(file, mode)).pipe(Effect.result);
            if (restored._tag === "Success") state.modes.delete(file);
          }
          if (state.fullFsync !== undefined) {
            const restored = yield* sql
              .unsafe(`PRAGMA fullfsync=${state.fullFsync}`)
              .pipe(Effect.result);
            if (restored._tag === "Success") state.fullFsync = undefined;
          }
          if (
            state.attached.size ||
            state.modes.size ||
            state.syncModes.size ||
            state.fullFsync !== undefined
          )
            return yield* new RedactionStoresError({});
        });
        // Retry unfinished cleanup before inspecting a mode that maintenance itself changed.
        yield* cleanup();
        const operation = Effect.gen(function* () {
          const databases = yield* sql.unsafe<{ name: string; file: string }>(
            "PRAGMA database_list",
          );
          const stores: RedactionStore[] = databases
            .filter((d) => d.name === "main" || d.name === "ardud_archive")
            .map((d) => ({
              db: d.name,
              path: d.file,
              label: d.name === "main" ? "statev2" : "archive",
            }));
          const base = databases.find((d) => d.name === "ardud_base" && d.file);
          const sources = stores.map((s) => s.path).filter(Boolean);
          if (base) sources.push(base.file);
          const add = Effect.fn("ThreadRedaction.attachStore")(function* (
            file: string,
            db: string,
            label: string,
          ) {
            const stat = yield* io(() => NodeFSP.lstat(file));
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
              return yield* new RedactionStoresError({});
            const mode = stat.mode & 0o777;
            state.modes.set(file, mode);
            if (!(mode & 0o200))
              yield* io(() => NodeFSP.chmod(file, mode | 0o200)).pipe(Effect.uninterruptible);
            yield* sql
              .unsafe(`ATTACH DATABASE ? AS ${db}`, [`${NodeURL.pathToFileURL(file).href}?mode=rw`])
              .pipe(
                Effect.tap(() => Effect.sync(() => state.attached.add(db))),
                Effect.uninterruptible,
              );
            const journal = yield* sql.unsafe<{ journal_mode: string }>(
              `PRAGMA ${db}.journal_mode=WAL`,
            );
            if (journal[0]?.journal_mode !== "wal") return yield* new RedactionStoresError({});
            stores.push({ db, path: file, label });
          });
          if (base) yield* add(base.file, "ardud_redaction_base", "base");
          const replica = yield* io(async () => {
            try {
              return await NodeFSP.lstat(replicaPath);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
              throw e;
            }
          });
          if (!replica) {
            for (const suffix of ["-wal", "-journal"]) {
              const orphan = yield* io(async () => {
                try {
                  await NodeFSP.lstat(`${replicaPath}${suffix}`);
                  return true;
                } catch (e) {
                  if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
                  throw e;
                }
              });
              if (orphan) return yield* new RedactionStoresError({});
            }
          }
          if (replica) {
            for (const source of sources) {
              const original = yield* io(() => NodeFSP.stat(source));
              if (replica.dev === original.dev && replica.ino === original.ino)
                return yield* new RedactionStoresError({});
            }
            yield* add(NodePath.resolve(replicaPath), "ardud_redaction_replica", "readonly");
          }
          // macOS needs F_FULLFSYNC to persist the pending marker across power loss.
          yield* Effect.gen(function* () {
            const previous = yield* sql.unsafe<{ fullfsync: number }>("PRAGMA fullfsync");
            state.fullFsync = previous[0]!.fullfsync;
            yield* sql.unsafe("PRAGMA fullfsync=ON");
          }).pipe(Effect.uninterruptible);
          for (const store of stores) {
            const previous = yield* sql.unsafe<{ synchronous: number }>(
              `PRAGMA ${store.db}.synchronous`,
            );
            state.syncModes.set(store.db, previous[0]!.synchronous);
            yield* sql.unsafe(`PRAGMA ${store.db}.synchronous=FULL`);
          }
          return yield* use(stores);
        });
        const result = yield* restore(operation).pipe(Effect.exit);
        yield* cleanup();
        if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
        return result.value;
      }),
    ),
);
