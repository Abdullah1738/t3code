import * as Effect from "effect/Effect";

interface VersionedJsonRow {
  readonly json: string;
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

export const makeDecodeCache = <R extends VersionedJsonRow, A, E>(
  name: string,
  decode: (json: string) => Effect.Effect<A, E>,
  key: (row: R) => string,
  readCounters: Effect.Effect<Record<string, DecodeCounts>>,
) => {
  const values = new Map<string, { version: number; value: A; boardId?: string }>();
  const counts = { hits: 0, misses: 0, evictions: 0 };
  const drop = (id: string) => {
    if (values.delete(id)) counts.evictions++;
  };
  return {
    name,
    stats: () => ({ ...counts, entries: values.size }),
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
    decode: (row: R, read: typeof counts, shared = true) =>
      Effect.suspend(() => {
        const id = key(row);
        if (!shared) return decode(row.json);
        const entry = values.get(id);
        if (entry?.version === row.cache_version) {
          counts.hits++;
          read.hits++;
          return Effect.succeed(entry.value);
        }
        counts.misses++;
        read.misses++;
        return decode(row.json).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              if (process.env.VITEST) freeze(value);
              values.set(id, {
                version: row.cache_version,
                value,
                ...("board_id" in row ? { boardId: String(row.board_id) } : {}),
              });
            }),
          ),
        );
      }),
  };
};
