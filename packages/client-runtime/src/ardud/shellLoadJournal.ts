import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * A paged shell load's pages as the server sent them, kept outside the client's memory by a
 * ShellLoadJournal.
 */
export interface StoredShellLoad {
  /** The loader's progress key: environment, base URL, server build and row options. */
  readonly key: string;
  /** Names one load, so pages a different load left behind are never mixed in. */
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
  /** 0 for the load's first page. Page 0 starts a new load and drops any older one. */
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
 */
export class ShellLoadJournal extends Context.Service<
  ShellLoadJournal,
  {
    readonly read: (environmentId: EnvironmentId) => Effect.Effect<Option.Option<StoredShellLoad>>;
    readonly append: (environmentId: EnvironmentId, entry: ShellLoadPageEntry) => Effect.Effect<void>;
    readonly clear: (environmentId: EnvironmentId) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/ardud/shellLoadJournal/ShellLoadJournal") {}

/** A string store the journal sits on; the web client passes its IndexedDB shell store. */
export interface ShellLoadKeyValue<E> {
  readonly get: (key: string) => Effect.Effect<unknown, E>;
  readonly put: (key: string, value: string) => Effect.Effect<void, E>;
  /** Removes every key from `from` to `to`, both included. */
  readonly removeRange: (from: string, to: string) => Effect.Effect<void, E>;
}

const JOURNAL_VERSION = 1;

/** Sorts after the environment's own shell key and never collides with an environment id. */
export function shellLoadRecordKey(environmentId: EnvironmentId): string {
  return `${environmentId}\u0000shell-load`;
}

export function shellLoadPageKey(
  environmentId: EnvironmentId,
  loadId: string,
  index: number,
): string {
  return `${shellLoadRecordKey(environmentId)}\u0000${loadId}\u0000${String(index).padStart(6, "0")}`;
}

interface JournalRecord {
  readonly version: number;
  readonly key: string;
  readonly loadId: string;
  readonly pages: number;
  readonly nextAfter: string;
  readonly updatedAt: number;
}

function parseRecord(raw: unknown): JournalRecord | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.version === JOURNAL_VERSION &&
    typeof record.key === "string" &&
    typeof record.loadId === "string" &&
    typeof record.nextAfter === "string" &&
    typeof record.updatedAt === "number" &&
    Number.isInteger(record.pages) &&
    (record.pages as number) > 0
    ? (record as unknown as JournalRecord)
    : null;
}

export function makeKeyValueShellLoadJournal<E>(
  store: ShellLoadKeyValue<E>,
): ShellLoadJournal["Service"] {
  const quietly = <A>(operation: string, effect: Effect.Effect<A, E>, fallback: A) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Shell load journal operation failed.").pipe(
          Effect.annotateLogs({ operation, cause: String(cause) }),
          Effect.as(fallback),
        ),
      ),
    );
  const removeAll = (environmentId: EnvironmentId) => {
    const prefix = shellLoadRecordKey(environmentId);
    return store.removeRange(prefix, `${prefix}\uffff`);
  };
  return ShellLoadJournal.of({
    read: (environmentId) =>
      quietly(
        "read",
        Effect.gen(function* () {
          const record = parseRecord(yield* store.get(shellLoadRecordKey(environmentId)));
          if (record === null) return Option.none<StoredShellLoad>();
          const bodies: string[] = [];
          for (let index = 0; index < record.pages; index++) {
            const body = yield* store.get(shellLoadPageKey(environmentId, record.loadId, index));
            // A page that never landed: the record is ahead of its pages, so start over.
            if (typeof body !== "string") return Option.none<StoredShellLoad>();
            bodies.push(body);
          }
          return Option.some<StoredShellLoad>({
            key: record.key,
            loadId: record.loadId,
            nextAfter: record.nextAfter,
            updatedAt: record.updatedAt,
            bodies,
          });
        }),
        Option.none<StoredShellLoad>(),
      ),
    append: (environmentId, entry) =>
      quietly(
        "append",
        Effect.gen(function* () {
          if (entry.index === 0) yield* removeAll(environmentId);
          yield* store.put(shellLoadPageKey(environmentId, entry.loadId, entry.index), entry.body);
          // The record names a page only after that page is written.
          const record: JournalRecord = {
            version: JOURNAL_VERSION,
            key: entry.key,
            loadId: entry.loadId,
            pages: entry.index + 1,
            nextAfter: entry.nextAfter,
            updatedAt: entry.updatedAt,
          };
          yield* store.put(shellLoadRecordKey(environmentId), JSON.stringify(record));
        }),
        undefined,
      ),
    clear: (environmentId) => quietly("clear", removeAll(environmentId), undefined),
  });
}
