import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * A paged shell load's pages as the server sent them, kept outside the client's memory by a
 * ShellLoadJournal.
 */
export interface StoredShellLoad {
  /** The loader's progress key: environment, base URL, server build and row options. */
  readonly key: string;
  /** Names one load. Only that load writes its pages and record. */
  readonly loadId: string;
  /** The cursor the last stored page returned. */
  readonly nextAfter: string;
  readonly updatedAt: number;
  /** Page bodies in load order, from the load's first page. */
  readonly bodies: ReadonlyArray<string>;
}

export interface ShellLoadPageEntry {
  readonly key: string;
  readonly loadId: string;
  /** 0 for the load's first page. */
  readonly index: number;
  readonly body: string;
  readonly nextAfter: string;
  readonly updatedAt: number;
}

/**
 * ardud: keeps a paged shell load's pages on disk, so a client that dies mid-load (a
 * renderer out of memory, a reload) goes on from its last page instead of page one. Each page
 * is one small write; nothing rewrites the whole list. Optional: without it, progress lives in
 * memory only (mobile today). Implementations never fail: a lost journal only means the next
 * load starts over.
 *
 * Windows sharing one store never write each other's keys: every load writes only under its
 * own load id, and a load that resumes another's pages copies them under a new id first. So
 * no write depends on a check another window could change in between.
 */
export class ShellLoadJournal extends Context.Service<
  ShellLoadJournal,
  {
    /** The most recently written load with every page in place. */
    readonly read: (environmentId: EnvironmentId) => Effect.Effect<Option.Option<StoredShellLoad>>;
    readonly append: (
      environmentId: EnvironmentId,
      entry: ShellLoadPageEntry,
    ) => Effect.Effect<void>;
    /** Drops one load's pages and record. */
    readonly clear: (environmentId: EnvironmentId, loadId: string) => Effect.Effect<void>;
    /** Drops every load last written before `before` (epoch ms), such as one a crash left. */
    readonly sweep: (environmentId: EnvironmentId, before: number) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/ardud/shellLoadJournal") {}

/** A string store the journal sits on; the web client passes its IndexedDB shell store. */
export interface ShellLoadKeyValue<E> {
  readonly get: (key: string) => Effect.Effect<unknown, E>;
  readonly put: (key: string, value: string) => Effect.Effect<void, E>;
  /** Keys from `from` to `to`, both included. */
  readonly keys: (from: string, to: string) => Effect.Effect<ReadonlyArray<string>, E>;
  /** Removes every key from `from` to `to`, both included. */
  readonly removeRange: (from: string, to: string) => Effect.Effect<void, E>;
}

const JOURNAL_VERSION = 2 as const;
const RECORD_SUFFIX = "record";

/**
 * Every journal key of an environment starts with this. It sorts after the environment's own
 * shell key and, since environment ids hold no NUL, never equals another environment's key.
 */
export function shellLoadKeyPrefix(environmentId: EnvironmentId): string {
  return `${environmentId}\u0000shell-load\u0000`;
}

const loadPrefix = (environmentId: EnvironmentId, loadId: string) =>
  `${shellLoadKeyPrefix(environmentId)}${loadId}\u0000`;

export function shellLoadPageKey(
  environmentId: EnvironmentId,
  loadId: string,
  index: number,
): string {
  return `${loadPrefix(environmentId, loadId)}${String(index).padStart(6, "0")}`;
}

export function shellLoadRecordKey(environmentId: EnvironmentId, loadId: string): string {
  return `${loadPrefix(environmentId, loadId)}${RECORD_SUFFIX}`;
}

const JournalRecord = Schema.Struct({
  version: Schema.Literal(JOURNAL_VERSION),
  key: Schema.String,
  loadId: Schema.String,
  pages: Schema.Int.check(Schema.isGreaterThan(0)),
  nextAfter: Schema.String,
  updatedAt: Schema.Number,
});
type JournalRecord = typeof JournalRecord.Type;
const JournalRecordJson = Schema.fromJsonString(JournalRecord);
const decodeRecord = Schema.decodeUnknownEffect(JournalRecordJson);
const encodeRecord = Schema.encodeEffect(JournalRecordJson);

export function makeKeyValueShellLoadJournal<E>(
  store: ShellLoadKeyValue<E>,
): ShellLoadJournal["Service"] {
  const quietly = <A, X>(operation: string, effect: Effect.Effect<A, X>, fallback: A) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Shell load journal operation failed.").pipe(
          Effect.annotateLogs({ operation, cause: String(cause) }),
          Effect.as(fallback),
        ),
      ),
    );
  // An id with a NUL could reach into another environment's keys: keep no journal for it.
  const usable = (environmentId: EnvironmentId) => !environmentId.includes("\u0000");
  const removeLoad = (environmentId: EnvironmentId, loadId: string) => {
    const prefix = loadPrefix(environmentId, loadId);
    return store.removeRange(prefix, `${prefix}\uffff`);
  };
  const records = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
    const prefix = shellLoadKeyPrefix(environmentId);
    const keys = yield* store.keys(prefix, `${prefix}\uffff`);
    const found: JournalRecord[] = [];
    for (const key of keys) {
      if (!key.endsWith(`\u0000${RECORD_SUFFIX}`)) continue;
      const record = yield* store
        .get(key)
        .pipe(Effect.flatMap((raw) => decodeRecord(raw).pipe(Effect.option)));
      if (Option.isSome(record)) found.push(record.value);
    }
    return found.toSorted((a, b) => b.updatedAt - a.updatedAt);
  });
  return ShellLoadJournal.of({
    read: (environmentId) =>
      !usable(environmentId)
        ? Effect.succeed(Option.none())
        : quietly(
            "read",
            Effect.gen(function* () {
              for (const record of yield* records(environmentId)) {
                const bodies: string[] = [];
                for (let index = 0; index < record.pages; index++) {
                  const body = yield* store.get(
                    shellLoadPageKey(environmentId, record.loadId, index),
                  );
                  if (typeof body !== "string") break;
                  bodies.push(body);
                }
                // A record whose pages are not all there was cut short: try an older load.
                if (bodies.length !== record.pages) continue;
                return Option.some<StoredShellLoad>({
                  key: record.key,
                  loadId: record.loadId,
                  nextAfter: record.nextAfter,
                  updatedAt: record.updatedAt,
                  bodies,
                });
              }
              return Option.none<StoredShellLoad>();
            }),
            Option.none<StoredShellLoad>(),
          ),
    append: (environmentId, entry) =>
      !usable(environmentId)
        ? Effect.void
        : quietly(
            "append",
            Effect.gen(function* () {
              yield* store.put(
                shellLoadPageKey(environmentId, entry.loadId, entry.index),
                entry.body,
              );
              // The record names a page only after that page is written.
              const record: JournalRecord = {
                version: JOURNAL_VERSION,
                key: entry.key,
                loadId: entry.loadId,
                pages: entry.index + 1,
                nextAfter: entry.nextAfter,
                updatedAt: entry.updatedAt,
              };
              yield* store.put(
                shellLoadRecordKey(environmentId, entry.loadId),
                yield* encodeRecord(record),
              );
            }),
            undefined,
          ),
    clear: (environmentId, loadId) =>
      !usable(environmentId)
        ? Effect.void
        : quietly("clear", removeLoad(environmentId, loadId), undefined),
    sweep: (environmentId, before) =>
      !usable(environmentId)
        ? Effect.void
        : quietly(
            "sweep",
            Effect.gen(function* () {
              for (const record of yield* records(environmentId)) {
                if (record.updatedAt < before) yield* removeLoad(environmentId, record.loadId);
              }
            }),
            undefined,
          ),
  });
}
