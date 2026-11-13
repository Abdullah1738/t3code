import type { SqliteClientConfig } from "@t3tools/shared/nodeSqliteClient";

/**
 * ardud: reader lane layout for the statev2 and boards databases.
 *
 * Interactive views (`foregroundReads`) get their own reader slots; every
 * other read stays on the default reader (the background lane). Overrides:
 *
 * - `ROBOB_STATEV2_FOREGROUND_READERS` / `ROBOB_BOARDS_FOREGROUND_READERS`:
 *   foreground slots, 0-4. `0` is the rollback: foreground reads use the
 *   single default reader again, exactly as before lanes.
 * - `ROBOB_STATEV2_BACKGROUND_READERS` / `ROBOB_BOARDS_BACKGROUND_READERS`:
 *   background slots, 1-4 (default 1, the single default reader). A second
 *   slot keeps one long background listing from stalling provider ingest.
 * - `ROBOB_READER_QUEUE_FOREGROUND` / `ROBOB_READER_QUEUE_BACKGROUND`:
 *   reads queued or running per lane before new ones fail with
 *   "Reader lane admission queue full".
 */
export interface ReaderLaneDefaults {
  readonly env: "ROBOB_STATEV2_FOREGROUND_READERS" | "ROBOB_BOARDS_FOREGROUND_READERS";
  readonly backgroundEnv: "ROBOB_STATEV2_BACKGROUND_READERS" | "ROBOB_BOARDS_BACKGROUND_READERS";
  readonly foregroundSlots: number;
  /** PRAGMA cache_size for each foreground slot, in KiB. */
  readonly foregroundCacheKiB: number;
  readonly maxResultBytes: { readonly foreground: number; readonly background: number };
}

const MiB = 1024 * 1024;

export const STATEV2_READER_LANES: ReaderLaneDefaults = {
  env: "ROBOB_STATEV2_FOREGROUND_READERS",
  backgroundEnv: "ROBOB_STATEV2_BACKGROUND_READERS",
  foregroundSlots: 2,
  foregroundCacheKiB: 32 * 1024,
  maxResultBytes: { foreground: 256 * MiB, background: 1024 * MiB },
};

export const BOARDS_READER_LANES: ReaderLaneDefaults = {
  env: "ROBOB_BOARDS_FOREGROUND_READERS",
  backgroundEnv: "ROBOB_BOARDS_BACKGROUND_READERS",
  foregroundSlots: 1,
  foregroundCacheKiB: 16 * 1024,
  maxResultBytes: { foreground: 256 * MiB, background: 1024 * MiB },
};

const integer = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

export const readerLaneOptions = (
  defaults: ReaderLaneDefaults,
  env: NodeJS.ProcessEnv = process.env,
): Pick<
  SqliteClientConfig,
  | "foregroundReaderSlots"
  | "backgroundReaderSlots"
  | "foregroundReaderInitializationSql"
  | "readerQueueLimits"
  | "readerMaxResultBytes"
> => ({
  foregroundReaderSlots: integer(env, defaults.env, defaults.foregroundSlots, 0, 4),
  backgroundReaderSlots: integer(env, defaults.backgroundEnv, 1, 1, 4),
  foregroundReaderInitializationSql: [`PRAGMA cache_size = -${defaults.foregroundCacheKiB}`],
  readerQueueLimits: {
    foreground: integer(env, "ROBOB_READER_QUEUE_FOREGROUND", 128, 1, 10_000),
    background: integer(env, "ROBOB_READER_QUEUE_BACKGROUND", 1024, 1, 100_000),
  },
  readerMaxResultBytes: defaults.maxResultBytes,
});
