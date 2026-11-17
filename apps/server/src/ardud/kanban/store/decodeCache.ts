import * as Effect from "effect/Effect";

interface VersionedRow {
  readonly cache_version: number;
}
interface DecodeCounts {
  hits: number;
  misses: number;
  evictions: number;
}

const freeze = (value: unknown): void => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
};

// Bound both small-entity cardinality and large card/discussion histories. The
// source budget is an estimate, not a measurement of the decoded JS heap.
// Leave room for the existing 6,000-card warm working set.
const DEFAULT_LIMITS = { maxEntries: 8_192, maxBytes: 128 * 1024 * 1024 };

export const makeDecodeCache = <R extends VersionedRow, A, E>(
  name: string,
  decode: (json: string) => Effect.Effect<A, E>,
  key: (row: R) => string,
  readCounters: Effect.Effect<Record<string, DecodeCounts>>,
  limits = DEFAULT_LIMITS,
) => {
  const values = new Map<string, { version: number; value: A; bytes: number; boardId?: string }>();
  let sourceBytes = 0;
  const counts = { hits: 0, misses: 0, evictions: 0 };
  const drop = (id: string) => {
    const entry = values.get(id);
    if (entry !== undefined) {
      sourceBytes -= entry.bytes;
      values.delete(id);
      counts.evictions++;
    }
  };
  const lookup = (row: R, read: typeof counts, shared = true) => {
    if (!shared) return undefined;
    const id = key(row);
    const entry = values.get(id);
    if (entry?.version !== row.cache_version) return undefined;
    values.delete(id);
    values.set(id, entry);
    counts.hits++;
    read.hits++;
    return entry;
  };
  return {
    name,
    lookup,
    stats: () => ({ ...counts, entries: values.size, sourceBytes }),
    drop: (id: string) =>
      Effect.flatMap(readCounters, (read) =>
        Effect.sync(() => {
          const before = counts.evictions;
          drop(id);
          (read[name] ??= { hits: 0, misses: 0, evictions: 0 }).evictions +=
            counts.evictions - before;
        }),
      ),
    reconcile: (boardId: string | undefined, ids: ReadonlySet<string>) =>
      Effect.flatMap(readCounters, (read) =>
        Effect.sync(() => {
          const before = counts.evictions;
          for (const [id, entry] of values) {
            if (entry.boardId === boardId && !ids.has(id)) drop(id);
          }
          (read[name] ??= { hits: 0, misses: 0, evictions: 0 }).evictions +=
            counts.evictions - before;
        }),
      ),
    decode: (row: R & { readonly json: string }, read: typeof counts, shared = true) =>
      Effect.suspend(() => {
        const id = key(row);
        if (!shared) return decode(row.json);
        const entry = lookup(row, read, shared);
        if (entry !== undefined) return Effect.succeed(entry.value);
        counts.misses++;
        read.misses++;
        const json = row.json;
        return decode(json).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              if (process.env.VITEST) freeze(value);
              const previous = values.get(id);
              if (previous !== undefined) {
                sourceBytes -= previous.bytes;
                values.delete(id);
              }
              const bytes = json.length * 2;
              if (bytes > limits.maxBytes || limits.maxEntries < 1) return;
              while (values.size >= limits.maxEntries || sourceBytes + bytes > limits.maxBytes) {
                const oldest = values.keys().next();
                if (oldest.done) break;
                const before = counts.evictions;
                drop(oldest.value);
                read.evictions += counts.evictions - before;
              }
              values.set(id, {
                bytes,
                version: row.cache_version,
                value,
                ...("board_id" in row ? { boardId: String(row.board_id) } : {}),
              });
              sourceBytes += bytes;
            }),
          ),
        );
      }),
  };
};
