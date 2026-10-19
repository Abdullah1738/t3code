import {
  PoolId,
  type CreatePoolInput,
  type MissionError,
  type MissionEventKind,
  type MissionId,
  type MissionMutationResult,
  type MissionProvenance,
  type MissionRecordRef,
  type Pool,
  type PoolHold,
  type PoolsSnapshot,
  type PoolView,
  type ReconcileHoldInput,
  type ReleaseHoldInput,
  type RenewHoldInput,
  type SetPoolCapacityInput,
  type TakeHoldInput,
  type TakeHoldResult,
  type UpdatePoolInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  GLOBAL_TIMELINE,
  POLICY_PROVENANCE,
  attempt,
  eventDraft,
  failWith,
  governingCaller,
  mayGovern,
  nowIso,
  requireMission,
  resolveCaller,
  shortId,
  systemCaller,
  type Caller,
  type PolicyDeps,
} from "./context.ts";
import { poolPressure } from "./governor.ts";
import {
  admitQueue,
  countsAgainstCapacity,
  expireHolds,
  inUse,
  mergeEntries,
  nativeUsage,
  newPool,
  poolCoversMission,
  queueOrder,
  queuePosition,
  reconcileHold as reconcileHoldPure,
  releaseHold as releaseHoldPure,
  renewHold as renewHoldPure,
  sampleUsage,
  setCapacity,
  takeHold as takeHoldPure,
  type HoldEntry,
} from "./pools.ts";
import { sourceBackend, type PoolSource } from "./sources.ts";

const poolRef = (pool: Pool): MissionRecordRef => ({ kind: "pool", id: pool.id, label: pool.name });

const holdRef = (pool: Pool, hold: PoolHold): MissionRecordRef => ({
  kind: "pool-hold",
  id: hold.id,
  label: `${pool.name} #${hold.fence}`,
});

const holdPayload = (hold: PoolHold) => ({
  poolId: hold.poolId,
  holdId: hold.id,
  fence: hold.fence,
  amount: hold.amount,
  status: hold.status,
  leaseExpiresAt: hold.leaseExpiresAt,
});

/** Missions whose timeline shows a pool's own changes. A global pool has none. */
const coveredMissions = (pool: Pool): ReadonlyArray<MissionId> => {
  switch (pool.scope._tag) {
    case "mission":
      return [pool.scope.missionId];
    case "shared":
      return pool.scope.missionIds;
    case "global":
      return [];
  }
};

interface PoolEvent {
  readonly caller: Pick<Caller, "actor" | "provenance">;
  readonly missionId: MissionId;
  readonly kind: MissionEventKind;
  readonly summary: string;
  readonly subject: MissionRecordRef;
  readonly payload: unknown;
}

/**
 * Writes pool state (own tables) with its timeline events. The first event
 * commits together with the writes; the rest are appended after. With no
 * event (a global pool's own change) the writes run alone and seq is 0.
 */
const writeWithEvents = (
  deps: PolicyDeps,
  events: ReadonlyArray<PoolEvent>,
  writes: Effect.Effect<void, MissionError>,
): Effect.Effect<number, MissionError> =>
  Effect.gen(function* () {
    const [first, ...rest] = events;
    if (first === undefined) {
      yield* writes;
      return 0;
    }
    const draft = (event: PoolEvent) =>
      eventDraft(
        event.caller,
        event.missionId,
        event.kind,
        event.summary,
        event.subject,
        event.payload,
      );
    const committed = yield* deps.store.commit({ event: draft(first), alongside: writes });
    for (const event of rest) yield* deps.store.appendEvent(draft(event));
    return committed.seq;
  });

/** Timelines a pool change lands on: each covered mission, or the global timeline. */
const poolTimelines = (pool: Pool): ReadonlyArray<MissionId> => {
  const missions = coveredMissions(pool);
  return missions.length === 0 ? [GLOBAL_TIMELINE] : missions;
};

const poolEvents = (
  caller: Pick<Caller, "actor" | "provenance">,
  pool: Pool,
  kind: MissionEventKind,
  summary: string,
  payload: unknown,
): ReadonlyArray<PoolEvent> =>
  poolTimelines(pool).map((missionId) => ({
    caller,
    missionId,
    kind,
    summary,
    subject: poolRef(pool),
    payload,
  }));

const admittedEvents = (pool: Pool, admitted: ReadonlyArray<HoldEntry>): ReadonlyArray<PoolEvent> =>
  admitted.map(({ hold }) => ({
    caller: systemCaller(POLICY_PROVENANCE),
    missionId: hold.missionId,
    kind: "pool.hold-taken",
    summary: `Queued hold ${hold.id} admitted to ${pool.name}: ${hold.purpose}`,
    subject: holdRef(pool, hold),
    payload: holdPayload(hold),
  }));

const requirePool = (deps: PolicyDeps, poolId: PoolId) =>
  deps.policyStore
    .pool(poolId)
    .pipe(
      Effect.flatMap((pool) =>
        pool === null ? failWith("not-found", `No pool ${poolId}.`) : Effect.succeed(pool),
      ),
    );

const requireHold = (deps: PolicyDeps, holdId: string) =>
  deps.policyStore
    .hold(holdId)
    .pipe(
      Effect.flatMap((entry) =>
        entry === null ? failWith("not-found", `No hold ${holdId}.`) : Effect.succeed(entry),
      ),
    );

/**
 * A pool's open holds after expiring overdue leases. Expiry is written first
 * and on its own: a hold that ran out becomes reconcile-required and keeps
 * counting, whatever the caller does next.
 */
const expireAndLoad = (deps: PolicyDeps, pool: Pool, now: string) =>
  Effect.gen(function* () {
    const entries = yield* deps.policyStore.openHolds(pool.id);
    const expired = expireHolds(entries, now);
    if (expired.length === 0) return entries;
    yield* writeWithEvents(
      deps,
      expired.map(({ hold }) => ({
        caller: systemCaller(POLICY_PROVENANCE),
        missionId: hold.missionId,
        kind: "pool.hold-expired" as const,
        summary: `Hold ${hold.id} on ${pool.name} ran past its lease; it blocks until reconciled`,
        subject: holdRef(pool, hold),
        payload: holdPayload(hold),
      })),
      deps.policyStore.saveHolds(expired),
    );
    return mergeEntries(entries, expired);
  });

/** Includes a closed hold so the pure rules can say why it cannot change. */
const withEntry = (entries: ReadonlyArray<HoldEntry>, entry: HoldEntry) =>
  entries.some(({ hold }) => hold.id === entry.hold.id) ? entries : [...entries, entry];

/** Owner, server components or the master of any mission; pools of every scope. */
const poolGovernor = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  pool: Pool,
  action: string,
) =>
  Effect.gen(function* () {
    const caller = yield* governingCaller(deps, provenance, coveredMissions(pool)[0] ?? null);
    if (!mayGovern(caller)) {
      return yield* failWith("forbidden", `Only the owner or a mission master can ${action}.`);
    }
    return caller;
  });

const liveUsage = (pool: Pool, entries: ReadonlyArray<HoldEntry>, now: string): Pool =>
  pool.backend === "native" ? { ...pool, usage: nativeUsage(entries, now) } : pool;

export interface LivePool {
  readonly pool: Pool;
  readonly entries: ReadonlyArray<HoldEntry>;
}

/** Every pool with its open holds; native usage is computed from the holds. */
export const livePools = (deps: PolicyDeps, now: string) =>
  Effect.gen(function* () {
    const pools = yield* deps.policyStore.pools;
    const live: Array<LivePool> = [];
    for (const pool of pools) {
      const entries = yield* deps.policyStore.openHolds(pool.id);
      live.push({ pool: liveUsage(pool, entries, now), entries });
    }
    return live;
  });

const leasePressure = (pool: Pool, used: number): Pick<PoolView, "pressure" | "pressureReason"> =>
  pool.capacity > 0 && used >= pool.capacity
    ? {
        pressure: "tight",
        pressureReason: `${pool.name} is full: ${used} of ${pool.capacity} ${pool.unit}`,
      }
    : {
        pressure: "ok",
        pressureReason: `${used} of ${pool.capacity} ${pool.unit} in use`,
      };

const poolView = (
  { pool, entries }: LivePool,
  sourceConfigured: boolean,
  now: string,
): PoolView => {
  const used = inUse(pool, entries);
  const running = entries
    .filter(({ hold }) => countsAgainstCapacity(hold))
    .sort((left, right) => left.hold.fence - right.hold.fence)
    .map(({ hold }) => hold);
  const queued = queueOrder(pool, entries).map(({ hold }) => hold);
  const pressure =
    pool.kind === "lease"
      ? leasePressure(pool, used)
      : (() => {
          const reading = poolPressure(pool, now);
          return { pressure: reading.level, pressureReason: reading.reason };
        })();
  return { pool, holds: [...running, ...queued], inUse: used, sourceConfigured, ...pressure };
};

/** Pools with live usage, holds and pressure. With a mission, only pools it can use. */
export const poolsSnapshot = (
  deps: PolicyDeps,
  filter: { readonly missionId?: MissionId | undefined },
): Effect.Effect<PoolsSnapshot, MissionError> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const sources = new Set<string>((yield* deps.policyStore.sources).map((row) => row.poolId));
    const live = yield* livePools(deps, now);
    const missionId = filter.missionId;
    return {
      pools: live
        .filter(({ pool }) => missionId === undefined || poolCoversMission(pool, missionId))
        .map((entry) => poolView(entry, sources.has(entry.pool.id), now)),
      at: now,
    };
  });

export const createPool = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: CreatePoolInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const draft = yield* attempt(() =>
      newPool(
        {
          id: input.poolId ?? shortId("pool"),
          name: input.name,
          unit: input.unit,
          capacity: input.capacity,
          scope: input.scope,
          kind: input.kind,
          backend: input.backend,
          enforcement: input.enforcement,
          priority: input.priority,
        },
        now,
      ),
    );
    for (const missionId of coveredMissions(draft)) yield* requireMission(deps, missionId);
    const caller = yield* poolGovernor(deps, provenance, draft, "create pools");
    if ((yield* deps.policyStore.pool(draft.id)) !== null) {
      return yield* failWith("conflict", `Pool ${draft.id} already exists.`);
    }
    const seq = yield* writeWithEvents(
      deps,
      poolEvents(
        caller,
        draft,
        "pool.created",
        `Pool ${draft.name} created: ${draft.capacity} ${draft.unit}, ${draft.kind}, ${draft.backend}, ${draft.enforcement}`,
        { poolId: draft.id, capacity: draft.capacity, scope: draft.scope },
      ),
      deps.policyStore.savePool(draft),
    );
    return { seq, ref: poolRef(draft) };
  });

/**
 * Changes capacity at any time, for a pool of any scope. Lowering never
 * evicts a running hold; raising admits the queue.
 */
export const setPoolCapacity = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: SetPoolCapacityInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  deps.holdLock.withPermit(
    Effect.gen(function* () {
      const now = yield* nowIso;
      const pool = yield* requirePool(deps, input.poolId);
      const caller = yield* poolGovernor(deps, provenance, pool, "change pool capacity");
      const entries = yield* expireAndLoad(deps, pool, now);
      const reason = input.reason ?? null;
      const changed = yield* attempt(() => setCapacity(pool, entries, input.capacity, now));
      const change = { ...changed, pool: { ...changed.pool, capacityReason: reason } };
      const over = change.overBy > 0 ? `; ${change.overBy} ${pool.unit} over until holds end` : "";
      const why = reason === null ? "" : ` (${reason})`;
      const seq = yield* writeWithEvents(
        deps,
        [
          ...poolEvents(
            caller,
            change.pool,
            "pool.updated",
            `${pool.name} capacity ${pool.capacity} -> ${change.pool.capacity} ${pool.unit}${why}${over}`,
            {
              poolId: pool.id,
              field: "capacity",
              from: pool.capacity,
              to: change.pool.capacity,
              reason,
            },
          ),
          ...admittedEvents(change.pool, change.admitted),
        ],
        Effect.andThen(
          deps.policyStore.savePool(change.pool),
          deps.policyStore.saveHolds(change.admitted),
        ),
      );
      return { seq, ref: poolRef(change.pool) };
    }),
  );

/**
 * Renames a pool, changes its unit or reorders which missions it admits first
 * when contended. A new priority order applies to the queue right away.
 */
export const updatePool = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: UpdatePoolInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  deps.holdLock.withPermit(
    Effect.gen(function* () {
      const now = yield* nowIso;
      const pool = yield* requirePool(deps, input.poolId);
      const caller = yield* poolGovernor(deps, provenance, pool, "change pools");
      const name = input.name?.trim() || pool.name;
      const unit = input.unit?.trim() || pool.unit;
      const priority = input.priority ?? pool.priority;
      const changed = [
        ...(name !== pool.name ? ["name"] : []),
        ...(unit !== pool.unit ? ["unit"] : []),
        ...(priority.join("\u0000") !== pool.priority.join("\u0000") ? ["priority"] : []),
      ];
      if (changed.length === 0) {
        return {
          seq: yield* deps.store.latestSeq(poolTimelines(pool)[0] ?? GLOBAL_TIMELINE),
          ref: poolRef(pool),
        };
      }
      const updated: Pool = { ...pool, name, unit, priority, updatedAt: now };
      const entries = yield* expireAndLoad(deps, updated, now);
      const admitted = admitQueue(updated, entries, now);
      const seq = yield* writeWithEvents(
        deps,
        [
          ...poolEvents(
            caller,
            updated,
            "pool.updated",
            `${pool.name} changed: ${changed.join(", ")}${changed.includes("priority") ? ` (admits ${priority.join(" > ") || "in arrival order"})` : ""}`,
            { poolId: pool.id, fields: changed, name, unit, priority },
          ),
          ...admittedEvents(updated, admitted),
        ],
        Effect.andThen(deps.policyStore.savePool(updated), deps.policyStore.saveHolds(admitted)),
      );
      return { seq, ref: poolRef(updated) };
    }),
  );

/**
 * Takes (or queues for) a hold. The holder is whoever asks: the caller's role
 * in the mission, else its thread. The fence it gets back is what release,
 * renew and reconcile check.
 */
export const takeHold = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: TakeHoldInput,
): Effect.Effect<TakeHoldResult, MissionError> =>
  deps.holdLock.withPermit(
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* requireMission(deps, input.missionId);
      const pool = yield* requirePool(deps, input.poolId);
      const caller = yield* resolveCaller(deps, provenance, input.missionId);
      const entries = yield* expireAndLoad(deps, pool, now);
      const lastFence = yield* deps.policyStore.lastFence(pool.id);
      const result = yield* attempt(() =>
        takeHoldPure(
          pool,
          entries,
          {
            missionId: input.missionId,
            holder: caller.actor,
            amount: input.amount,
            purpose: input.purpose,
            ttlSeconds: input.ttlSeconds,
            queue: input.queue,
            lastFence,
          },
          now,
        ),
      );
      const hold = result.entry.hold;
      const queued = hold.status === "queued";
      const position = queued
        ? queuePosition(pool, mergeEntries(entries, [result.entry]), hold.id)
        : null;
      yield* writeWithEvents(
        deps,
        [
          {
            caller,
            missionId: hold.missionId,
            kind: queued ? "pool.hold-queued" : "pool.hold-taken",
            summary: queued
              ? `Queued for ${pool.name} (position ${position ?? "?"}): ${hold.purpose}`
              : `Took ${hold.amount} ${pool.unit} of ${pool.name} (fence ${hold.fence})${result.overCapacity ? ", over capacity (advisory)" : ""}: ${hold.purpose}`,
            subject: holdRef(pool, hold),
            payload: holdPayload(hold),
          },
        ],
        deps.policyStore.saveHolds([result.entry]),
      );
      return { hold, queuePosition: position, overCapacity: result.overCapacity };
    }),
  );

/** Releases with the hold's fence (also withdraws a queued hold). The queue moves up. */
export const releaseHold = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: ReleaseHoldInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  deps.holdLock.withPermit(
    Effect.gen(function* () {
      const now = yield* nowIso;
      const entry = yield* requireHold(deps, input.holdId);
      const pool = yield* requirePool(deps, entry.hold.poolId);
      const caller = yield* resolveCaller(deps, provenance, entry.hold.missionId);
      const entries = withEntry(yield* expireAndLoad(deps, pool, now), entry);
      const change = yield* attempt(() =>
        releaseHoldPure(
          pool,
          entries,
          { holdId: input.holdId, fence: input.fence, note: input.note },
          now,
        ),
      );
      const hold = change.entry.hold;
      const seq = yield* writeWithEvents(
        deps,
        [
          {
            caller,
            missionId: hold.missionId,
            kind: "pool.hold-released",
            summary: `Released ${pool.name} hold ${hold.id}${input.note.trim() ? `: ${input.note.trim()}` : ""}`,
            subject: holdRef(pool, hold),
            payload: holdPayload(hold),
          },
          ...admittedEvents(pool, change.admitted),
        ],
        deps.policyStore.saveHolds([change.entry, ...change.admitted]),
      );
      return { seq, ref: holdRef(pool, hold) };
    }),
  );

/** Extends a running lease. No timeline event: renewals are routine. */
export const renewHold = (
  deps: PolicyDeps,
  input: RenewHoldInput,
): Effect.Effect<PoolHold, MissionError> =>
  deps.holdLock.withPermit(
    Effect.gen(function* () {
      const now = yield* nowIso;
      const entry = yield* requireHold(deps, input.holdId);
      const pool = yield* requirePool(deps, entry.hold.poolId);
      const entries = withEntry(yield* expireAndLoad(deps, pool, now), entry);
      const renewed = yield* attempt(() =>
        renewHoldPure(
          entries,
          { holdId: input.holdId, fence: input.fence, ttlSeconds: input.ttlSeconds },
          now,
        ),
      );
      yield* deps.policyStore.saveHolds([renewed]);
      return renewed.hold;
    }),
  );

/**
 * Closes a hold whose lease ran out, with evidence of what really happened.
 * Only the owner or the hold mission's master decide that; an expired lease
 * never means a repeat is safe.
 */
export const reconcileHold = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: ReconcileHoldInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  deps.holdLock.withPermit(
    Effect.gen(function* () {
      const now = yield* nowIso;
      const entry = yield* requireHold(deps, input.holdId);
      const pool = yield* requirePool(deps, entry.hold.poolId);
      const caller = yield* resolveCaller(deps, provenance, entry.hold.missionId);
      if (!mayGovern(caller)) {
        return yield* failWith(
          "forbidden",
          "Only the owner or the mission's master can reconcile an expired hold.",
        );
      }
      const entries = withEntry(yield* expireAndLoad(deps, pool, now), entry);
      const change = yield* attempt(() =>
        reconcileHoldPure(
          pool,
          entries,
          {
            holdId: input.holdId,
            fence: input.fence,
            outcome: input.outcome,
            evidence: input.evidence,
          },
          now,
        ),
      );
      const hold = change.entry.hold;
      const seq = yield* writeWithEvents(
        deps,
        [
          {
            caller,
            missionId: hold.missionId,
            kind: "pool.hold-reconciled",
            summary: `Reconciled ${pool.name} hold ${hold.id} as ${input.outcome}: ${input.evidence}`,
            subject: holdRef(pool, hold),
            payload: { ...holdPayload(hold), outcome: input.outcome, evidence: input.evidence },
          },
          ...admittedEvents(pool, change.admitted),
        ],
        deps.policyStore.saveHolds([change.entry, ...change.admitted]),
      );
      return { seq, ref: holdRef(pool, hold) };
    }),
  );

/** Expires overdue leases on every pool. */
export const sweepHolds = (deps: PolicyDeps): Effect.Effect<void, MissionError> =>
  deps.holdLock.withPermit(
    Effect.gen(function* () {
      const now = yield* nowIso;
      for (const pool of yield* deps.policyStore.pools) yield* expireAndLoad(deps, pool, now);
    }),
  );

/**
 * Points an outside-backed pool at the command or file it is sampled from.
 * The owner, server components and any mission master may set it.
 */
export const setPoolSource = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: { readonly poolId: PoolId; readonly source: PoolSource | null },
): Effect.Effect<MissionMutationResult, MissionError> =>
  Effect.gen(function* () {
    const pool = yield* requirePool(deps, input.poolId);
    const caller = yield* poolGovernor(deps, provenance, pool, "configure pool sources");
    if (pool.backend === "native") {
      return yield* failWith("invalid", `${pool.name} is native; its usage comes from its holds.`);
    }
    if (input.source !== null && sourceBackend(input.source) !== pool.backend) {
      return yield* failWith(
        "invalid",
        `A ${input.source._tag} source reads a ${sourceBackend(input.source)} backend, not ${pool.backend}.`,
      );
    }
    const now = yield* nowIso;
    const seq = yield* writeWithEvents(
      deps,
      poolEvents(
        caller,
        pool,
        "pool.updated",
        input.source === null
          ? `${pool.name} no longer sampled`
          : `${pool.name} sampled from ${input.source._tag}`,
        { poolId: pool.id, field: "source", source: input.source?._tag ?? null },
      ),
      deps.policyStore.setSource(pool.id, input.source, now),
    );
    return { seq, ref: poolRef(pool) };
  });

/**
 * Samples every configured outside backend. Read-only: it never writes coord,
 * crw config or 9router. Usage updates write no timeline events. Capacity is
 * never taken from the backend: people set it (the crw review pool is the
 * source of crw's caps in missions mode, so mirroring would loop).
 */
export const sampleObservers = (deps: PolicyDeps): Effect.Effect<number, MissionError> =>
  Effect.gen(function* () {
    let sampled = 0;
    for (const row of yield* deps.policyStore.sources) {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const sample = yield* deps.sampler.sample(row.source, nowMs).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("mission pool sample failed", { poolId: row.poolId, error }),
        ),
        Effect.option,
      );
      if (sample._tag === "None") continue;
      yield* deps.holdLock.withPermit(
        Effect.gen(function* () {
          const pool = yield* deps.policyStore.pool(row.poolId);
          if (pool === null || pool.backend === "native") return;
          const now = yield* nowIso;
          const { used, window, resetsAt, runOutAt } = sample.value;
          const sampledPool = yield* attempt(() =>
            sampleUsage(pool, { used, window, resetsAt, runOutAt, sampledAt: now }),
          );
          yield* deps.policyStore.savePool(sampledPool);
        }),
      );
      sampled += 1;
    }
    return sampled;
  });
