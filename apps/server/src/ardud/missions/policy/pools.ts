/**
 * Generic pools and holds. A hold is a lease on part of a pool, with the same
 * rules as coord claims: a positive fence that only grows per pool, the
 * holder proves the fence on release, and a lease that runs out turns into
 * `reconcile-required`. It keeps counting against capacity until someone
 * reconciles it, because an expired lease never means repeating the work is
 * safe.
 *
 * Only `native` pools are enforced here. Pools backed by coord claims, crw
 * config, 9router or offbox are read-only observers: Robob samples their usage
 * and holds on them are advisory.
 *
 * Pure functions only. `PolicyService` persists the results.
 */
import {
  MissionError,
  type MissionActor,
  type MissionId,
  type Pool,
  type PoolBackend,
  type PoolHold,
  PoolHoldId,
  PoolId,
  type PoolKind,
  type PoolScope,
  type PoolUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** A hold plus the lease length it asked for, which a queued hold needs when it is admitted. */
export interface HoldEntry {
  readonly hold: PoolHold;
  readonly ttlSeconds: number;
}

export interface NewPoolInput {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  readonly capacity: number;
  readonly scope: PoolScope;
  readonly kind: PoolKind;
  readonly backend: PoolBackend;
  readonly enforcement?: Pool["enforcement"];
  readonly priority?: ReadonlyArray<MissionId>;
}

const fail = (code: MissionError["code"], detail: string): never => {
  throw new MissionError({ code, detail });
};

const validCapacity = (capacity: number): boolean => Number.isFinite(capacity) && capacity >= 0;

export function newPool(input: NewPoolInput, now: string): Pool {
  if (!validCapacity(input.capacity)) fail("invalid", "capacity must be a number of at least 0");
  if (input.backend === "native" && input.kind === "observed") {
    fail("invalid", "an observed pool needs an outside backend to read from");
  }
  const enforcement = input.enforcement ?? (input.backend === "native" ? "enforced" : "advisory");
  if (input.backend !== "native" && enforcement === "enforced") {
    fail("invalid", `${input.backend} pools are read-only observers and can only be advisory`);
  }
  if (input.scope._tag === "shared" && input.scope.missionIds.length === 0) {
    fail("invalid", "a shared pool names at least one mission");
  }
  return {
    id: PoolId.make(input.id),
    name: input.name.trim() as Pool["name"],
    unit: input.unit.trim() as Pool["unit"],
    capacity: input.capacity,
    scope: input.scope,
    kind: input.kind,
    backend: input.backend,
    enforcement,
    usage: { used: 0, window: null, resetsAt: null, runOutAt: null, sampledAt: now },
    priority: [...(input.priority ?? [])],
    lockedFields: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function poolCoversMission(pool: Pool, missionId: MissionId): boolean {
  switch (pool.scope._tag) {
    case "global":
      return true;
    case "mission":
      return pool.scope.missionId === missionId;
    case "shared":
      return pool.scope.missionIds.includes(missionId);
  }
}

/** Holds that count against capacity: running ones and ones waiting on a reconcile. */
export const countsAgainstCapacity = (hold: PoolHold): boolean =>
  hold.status === "active" || hold.status === "reconcile-required";

export function heldAmount(entries: ReadonlyArray<HoldEntry>): number {
  return entries.reduce(
    (sum, { hold }) => (countsAgainstCapacity(hold) ? sum + hold.amount : sum),
    0,
  );
}

/**
 * What the pool has in use. Native pools are exactly their holds. Observed
 * backends add advisory holds on top of what the outside system reports.
 */
export function inUse(pool: Pool, entries: ReadonlyArray<HoldEntry>): number {
  const held = heldAmount(entries);
  return pool.backend === "native" ? held : pool.usage.used + held;
}

export function nativeUsage(entries: ReadonlyArray<HoldEntry>, now: string): PoolUsage {
  return {
    used: heldAmount(entries),
    window: null,
    resetsAt: null,
    runOutAt: null,
    sampledAt: now,
  };
}

const priorityIndex = (pool: Pool, missionId: MissionId): number => {
  const index = pool.priority.indexOf(missionId);
  return index === -1 ? pool.priority.length : index;
};

const compareQueued = (pool: Pool) => (left: HoldEntry, right: HoldEntry) =>
  priorityIndex(pool, left.hold.missionId) - priorityIndex(pool, right.hold.missionId) ||
  left.hold.createdAt.localeCompare(right.hold.createdAt) ||
  left.hold.fence - right.hold.fence;

/** Queued holds in admission order: the pool's mission priority, then first come first served. */
export function queueOrder(
  pool: Pool,
  entries: ReadonlyArray<HoldEntry>,
): ReadonlyArray<HoldEntry> {
  return entries.filter(({ hold }) => hold.status === "queued").toSorted(compareQueued(pool));
}

/** 1-based queue position, or null when the hold is not queued. */
export function queuePosition(
  pool: Pool,
  entries: ReadonlyArray<HoldEntry>,
  holdId: PoolHoldId,
): number | null {
  const index = queueOrder(pool, entries).findIndex(({ hold }) => hold.id === holdId);
  return index === -1 ? null : index + 1;
}

export function nextFence(entries: ReadonlyArray<HoldEntry>): number {
  return entries.reduce((max, { hold }) => Math.max(max, hold.fence), 0) + 1;
}

const leaseUntil = (now: string, ttlSeconds: number): string =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { seconds: ttlSeconds }));

const holdLabel = (hold: PoolHold) => `hold ${hold.id} (fence ${hold.fence})`;

export interface TakeRequest {
  readonly missionId: MissionId;
  readonly holder: MissionActor;
  readonly amount?: number | undefined;
  readonly purpose: string;
  readonly ttlSeconds: number;
  readonly queue?: boolean | undefined;
}

export interface TakeResult {
  readonly entry: HoldEntry;
  /** Only advisory pools go over capacity; enforced pools queue or refuse instead. */
  readonly overCapacity: boolean;
}

/**
 * Takes a hold. Run `expireHolds` first so stale leases are already
 * `reconcile-required`. A request never jumps a queued request that ranks
 * ahead of it.
 */
export function takeHold(
  pool: Pool,
  entries: ReadonlyArray<HoldEntry>,
  request: TakeRequest,
  now: string,
): TakeResult {
  if (pool.kind === "observed") {
    fail("invalid", `${pool.name} is read from ${pool.backend}; there is nothing to hold`);
  }
  if (!poolCoversMission(pool, request.missionId)) {
    fail("forbidden", `${pool.name} is not open to mission ${request.missionId}`);
  }
  const amount = request.amount ?? 1;
  if (!Number.isFinite(amount) || amount <= 0) fail("invalid", "amount must be more than 0");
  if (!Number.isInteger(request.ttlSeconds) || request.ttlSeconds <= 0) {
    fail("invalid", "ttlSeconds must be a positive whole number");
  }
  const purpose = request.purpose.trim();
  if (purpose.length === 0) fail("invalid", "a hold needs a purpose");

  const used = inUse(pool, entries);
  const fits = used + amount <= pool.capacity;
  const fence = nextFence(entries);
  const base: PoolHold = {
    id: PoolHoldId.make(`${pool.id}#${fence}`),
    poolId: pool.id,
    missionId: request.missionId,
    holder: request.holder,
    amount,
    purpose,
    fence,
    status: "active",
    leaseExpiresAt: leaseUntil(now, request.ttlSeconds),
    takenAt: now,
    releasedAt: null,
    releaseNote: null,
    createdAt: now,
  };
  const entry = (hold: PoolHold): HoldEntry => ({ hold, ttlSeconds: request.ttlSeconds });

  if (pool.enforcement === "advisory") return { entry: entry(base), overCapacity: !fits };

  if (amount > pool.capacity) {
    fail("pool-full", `${pool.name} has capacity ${pool.capacity}; ${amount} can never fit`);
  }
  const rank = priorityIndex(pool, request.missionId);
  const queuedAhead = queueOrder(pool, entries).some(
    ({ hold }) => priorityIndex(pool, hold.missionId) <= rank,
  );
  if (fits && !queuedAhead) return { entry: entry(base), overCapacity: false };
  if (request.queue) {
    return {
      entry: entry({ ...base, status: "queued", leaseExpiresAt: null, takenAt: null }),
      overCapacity: false,
    };
  }
  const blocked = entries.filter(({ hold }) => hold.status === "reconcile-required").length;
  return fail(
    "pool-full",
    `${pool.name}: ${used} of ${pool.capacity} ${pool.unit} in use` +
      (blocked > 0 ? `, ${blocked} expired hold(s) need a reconcile` : "") +
      (queuedAhead ? ", and requests are queued ahead" : ""),
  );
}

/**
 * Admits queued holds in order while they fit. It stops at the first one
 * that does not fit, so a large request is not starved by smaller ones.
 */
export function admitQueue(
  pool: Pool,
  entries: ReadonlyArray<HoldEntry>,
  now: string,
): ReadonlyArray<HoldEntry> {
  if (pool.enforcement === "advisory") return [];
  let used = inUse(pool, entries);
  const admitted: Array<HoldEntry> = [];
  for (const queued of queueOrder(pool, entries)) {
    if (used + queued.hold.amount > pool.capacity) break;
    used += queued.hold.amount;
    admitted.push({
      ...queued,
      hold: {
        ...queued.hold,
        status: "active",
        takenAt: now,
        leaseExpiresAt: leaseUntil(now, queued.ttlSeconds),
      },
    });
  }
  return admitted;
}

/** Replaces entries by hold id. */
export function mergeEntries(
  entries: ReadonlyArray<HoldEntry>,
  changed: ReadonlyArray<HoldEntry>,
): ReadonlyArray<HoldEntry> {
  const byId = new Map(changed.map((entry) => [entry.hold.id, entry]));
  const merged = entries.map((entry) => byId.get(entry.hold.id) ?? entry);
  const known = new Set(entries.map(({ hold }) => hold.id));
  return [...merged, ...changed.filter(({ hold }) => !known.has(hold.id))];
}

const findEntry = (entries: ReadonlyArray<HoldEntry>, holdId: PoolHoldId): HoldEntry =>
  entries.find(({ hold }) => hold.id === holdId) ?? fail("not-found", `no hold ${holdId}`);

const checkFence = (hold: PoolHold, fence: number): void => {
  if (hold.fence !== fence) {
    fail("fence-mismatch", `${holdLabel(hold)} was given fence ${fence}`);
  }
};

const refuseUnlessOpen = (hold: PoolHold, verb: string): void => {
  if (hold.status === "released" || hold.status === "expired") {
    fail("conflict", `${holdLabel(hold)} is already ${hold.status}`);
  }
  if (hold.status === "reconcile-required") {
    fail(
      "conflict",
      `reconcile-required: the lease on ${holdLabel(hold)} ran out at ${hold.leaseExpiresAt}; ` +
        `reconcile it with an outcome instead of trying to ${verb} it`,
    );
  }
};

export interface HoldChange {
  readonly entry: HoldEntry;
  /** Queued holds that got in because this change freed room. */
  readonly admitted: ReadonlyArray<HoldEntry>;
}

/** Releases a running hold or withdraws a queued one. */
export function releaseHold(
  pool: Pool,
  entries: ReadonlyArray<HoldEntry>,
  input: { readonly holdId: PoolHoldId; readonly fence: number; readonly note: string },
  now: string,
): HoldChange {
  const current = findEntry(entries, input.holdId);
  checkFence(current.hold, input.fence);
  refuseUnlessOpen(current.hold, "release");
  if (current.hold.status === "active" && isLeaseOver(current.hold, now)) {
    fail(
      "conflict",
      `reconcile-required: the lease on ${holdLabel(current.hold)} ran out at ` +
        `${current.hold.leaseExpiresAt}; reconcile it with an outcome instead of releasing it`,
    );
  }
  const entry: HoldEntry = {
    ...current,
    hold: {
      ...current.hold,
      status: "released",
      releasedAt: now,
      releaseNote: input.note.trim() || null,
    },
  };
  return { entry, admitted: admitQueue(pool, mergeEntries(entries, [entry]), now) };
}

const isLeaseOver = (hold: PoolHold, now: string): boolean =>
  hold.leaseExpiresAt !== null && Date.parse(hold.leaseExpiresAt) <= Date.parse(now);

/** Extends a running lease. A lease that already ran out cannot be renewed. */
export function renewHold(
  entries: ReadonlyArray<HoldEntry>,
  input: { readonly holdId: PoolHoldId; readonly fence: number; readonly ttlSeconds: number },
  now: string,
): HoldEntry {
  const current = findEntry(entries, input.holdId);
  checkFence(current.hold, input.fence);
  refuseUnlessOpen(current.hold, "renew");
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
    fail("invalid", "ttlSeconds must be a positive whole number");
  }
  if (current.hold.status === "queued") return { ...current, ttlSeconds: input.ttlSeconds };
  if (isLeaseOver(current.hold, now)) {
    fail(
      "conflict",
      `reconcile-required: the lease on ${holdLabel(current.hold)} ran out at ` +
        `${current.hold.leaseExpiresAt}; it cannot be renewed`,
    );
  }
  return {
    hold: { ...current.hold, leaseExpiresAt: leaseUntil(now, input.ttlSeconds) },
    ttlSeconds: input.ttlSeconds,
  };
}

/** Running holds whose lease ran out become `reconcile-required`. They are never freed here. */
export function expireHolds(
  entries: ReadonlyArray<HoldEntry>,
  now: string,
): ReadonlyArray<HoldEntry> {
  return entries
    .filter(({ hold }) => hold.status === "active" && isLeaseOver(hold, now))
    .map((entry) => ({ ...entry, hold: { ...entry.hold, status: "reconcile-required" } }));
}

export type ReconcileOutcome = "done" | "not-started" | "rolled-back";

/**
 * Closes an expired hold once someone has checked what actually happened.
 * The hold ends as `expired`, and the note keeps the outcome and evidence.
 */
export function reconcileHold(
  pool: Pool,
  entries: ReadonlyArray<HoldEntry>,
  input: {
    readonly holdId: PoolHoldId;
    readonly fence: number;
    readonly outcome: ReconcileOutcome;
    readonly evidence: string;
  },
  now: string,
): HoldChange {
  const current = findEntry(entries, input.holdId);
  checkFence(current.hold, input.fence);
  if (current.hold.status !== "reconcile-required") {
    fail(
      "conflict",
      `${holdLabel(current.hold)} is ${current.hold.status}, not reconcile-required`,
    );
  }
  const evidence = input.evidence.trim();
  if (evidence.length === 0) fail("invalid", "a reconcile needs evidence of what happened");
  const entry: HoldEntry = {
    ...current,
    hold: {
      ...current.hold,
      status: "expired",
      releasedAt: now,
      releaseNote: `reconciled ${input.outcome}: ${evidence}`,
    },
  };
  return { entry, admitted: admitQueue(pool, mergeEntries(entries, [entry]), now) };
}

export interface CapacityChange {
  readonly pool: Pool;
  readonly admitted: ReadonlyArray<HoldEntry>;
  /** How far current use is above the new capacity. Running holds are never evicted. */
  readonly overBy: number;
}

/**
 * Changes capacity at any time. Lowering it never evicts a running hold; new
 * holds simply wait until use drops. Raising it admits the queue.
 */
export function setCapacity(
  pool: Pool,
  entries: ReadonlyArray<HoldEntry>,
  capacity: number,
  options: { readonly byOwner: boolean; readonly now: string },
): CapacityChange {
  if (!validCapacity(capacity)) fail("invalid", "capacity must be a number of at least 0");
  if (!options.byOwner && pool.lockedFields.includes("capacity")) {
    fail("locked", `the owner locked the capacity of ${pool.name}`);
  }
  if (!options.byOwner && pool.scope._tag === "global") {
    fail("forbidden", `${pool.name} is a global pool; only the owner changes its capacity`);
  }
  const next: Pool = { ...pool, capacity, updatedAt: options.now };
  return {
    pool: next,
    admitted: admitQueue(next, entries, options.now),
    overBy: Math.max(0, inUse(next, entries) - capacity),
  };
}

/** Who may change a pool's capacity: the owner always, a master only inside its missions. */
export function mayChangeCapacity(
  pool: Pool,
  actor: { readonly byOwner: boolean; readonly masterOf: ReadonlyArray<MissionId> },
): boolean {
  if (actor.byOwner) return true;
  if (pool.lockedFields.includes("capacity")) return false;
  switch (pool.scope._tag) {
    case "global":
      return false;
    case "mission":
      return actor.masterOf.includes(pool.scope.missionId);
    case "shared":
      return pool.scope.missionIds.some((missionId) => actor.masterOf.includes(missionId));
  }
}

/** Masters create pools for their own mission only. Shared and global pools are owner-made. */
export function mayCreatePool(
  scope: PoolScope,
  actor: { readonly byOwner: boolean; readonly masterOf: ReadonlyArray<MissionId> },
): boolean {
  if (actor.byOwner) return true;
  return scope._tag === "mission" && actor.masterOf.includes(scope.missionId);
}

/** Records a usage sample from an outside backend. Native pools derive usage from holds instead. */
export function sampleUsage(pool: Pool, usage: PoolUsage): Pool {
  if (pool.backend === "native") {
    fail("invalid", `${pool.name} is native; its usage comes from its holds`);
  }
  return { ...pool, usage, updatedAt: usage.sampledAt };
}
