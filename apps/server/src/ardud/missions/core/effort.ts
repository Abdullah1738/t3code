import type { Lane, Share, SubMission } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Attention ledger, actual side: the share of lane-thread running time each
 * sub-mission got over the trailing window, read from the orchestration run
 * projection (read-only). Cached per mission like health; a failed read
 * leaves `actualEffort` unknown rather than failing the overview.
 */

export const EFFORT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EFFORT_TTL_MS = 60_000;

/** Runs without `completed_at` in these states are still using time. */
const OPEN_RUN_STATES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

interface RunRow {
  readonly thread_id: string;
  readonly status: string;
  readonly requested_at: string;
  readonly completed_at: string | null;
}

/** Milliseconds of each run inside the window, summed per thread. */
export const runTimeByThread = (
  rows: ReadonlyArray<RunRow>,
  windowStart: number,
  now: number,
): ReadonlyMap<string, number> => {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const start = Date.parse(row.requested_at);
    const end =
      row.completed_at !== null
        ? Date.parse(row.completed_at)
        : OPEN_RUN_STATES.has(row.status)
          ? now
          : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const spent = Math.max(0, Math.min(end, now) - Math.max(start, windowStart));
    if (spent > 0) totals.set(row.thread_id, (totals.get(row.thread_id) ?? 0) + spent);
  }
  return totals;
};

/** Each sub-mission's share of the lanes' running time; null when no lane ran. */
export const effortShares = (
  lanes: ReadonlyArray<Pick<Lane, "subMissionId" | "threadId">>,
  byThread: ReadonlyMap<string, number>,
): ReadonlyMap<string, Share> | null => {
  const bySubMission = new Map<string, number>();
  let total = 0;
  for (const lane of lanes) {
    if (lane.subMissionId === null || lane.threadId === null) continue;
    const spent = byThread.get(lane.threadId) ?? 0;
    total += spent;
    bySubMission.set(lane.subMissionId, (bySubMission.get(lane.subMissionId) ?? 0) + spent);
  }
  if (total === 0) return null;
  return new Map(
    [...bySubMission].map(([id, spent]) => [id, Math.round((spent / total) * 1000) / 1000]),
  );
};

export const makeEffort = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cache = new Map<
    string,
    { readonly at: number; readonly shares: ReadonlyMap<string, Share> | null }
  >();

  const read = (threadIds: ReadonlyArray<string>, windowStart: number, now: number) =>
    threadIds.length === 0
      ? Effect.succeed(new Map<string, number>())
      : sql<RunRow>`
          SELECT thread_id, status, requested_at, completed_at
          FROM orchestration_v2_projection_runs
          WHERE thread_id IN ${sql.in(threadIds)}
            AND (completed_at IS NULL OR completed_at >= ${DateTime.formatIso(DateTime.makeUnsafe(windowStart))})
        `.pipe(Effect.map((rows) => runTimeByThread(rows, windowStart, now)));

  /** Sub-missions with `actualEffort` filled from lane activity (cached). */
  const withActualEffort = (
    missionId: string,
    subMissions: ReadonlyArray<SubMission>,
    lanes: ReadonlyArray<Lane>,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = cache.get(missionId);
      let shares =
        cached !== undefined && now - cached.at < EFFORT_TTL_MS ? cached.shares : undefined;
      if (shares === undefined) {
        const threadIds = [
          ...new Set(lanes.flatMap((lane) => (lane.threadId === null ? [] : [lane.threadId]))),
        ];
        const byThread = yield* read(threadIds, now - EFFORT_WINDOW_MS, now).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("missions: lane effort read failed", cause).pipe(Effect.as(null)),
          ),
        );
        shares = byThread === null ? null : effortShares(lanes, byThread);
        cache.set(missionId, { at: now, shares });
      }
      const known = shares;
      return known === null
        ? subMissions
        : subMissions.map((subMission) => ({
            ...subMission,
            actualEffort: known.get(subMission.id) ?? 0,
          }));
    });

  return { withActualEffort };
});

export type MissionEffort = Effect.Success<typeof makeEffort>;
