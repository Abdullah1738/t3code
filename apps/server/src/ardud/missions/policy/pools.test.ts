import {
  MissionId,
  type MissionActor,
  type MissionError,
  type PoolHoldId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  type HoldEntry,
  admitQueue,
  expireHolds,
  inUse,
  mergeEntries,
  newPool,
  queueOrder,
  queuePosition,
  reconcileHold,
  releaseHold,
  renewHold,
  sampleUsage,
  setCapacity,
  takeHold,
} from "./pools.ts";

const crpko = MissionId.make("crpko");
const juno = MissionId.make("juno");
const side = MissionId.make("side");
const lane: MissionActor = { _tag: "system", component: "test" };

const T0 = "2026-10-17T10:00:00.000Z";
const at = (minutes: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(T0), { minutes }));

const devEnv = () =>
  newPool(
    {
      id: "crpko-dev-env",
      name: "Crpko dev env",
      unit: "slot",
      capacity: 1,
      scope: { _tag: "mission", missionId: crpko },
      kind: "lease",
      backend: "native",
    },
    T0,
  );

const slots = (capacity: number, priority = [crpko, juno, side]) =>
  newPool(
    {
      id: "mac-slots",
      name: "Mac local slots",
      unit: "slot",
      capacity,
      scope: { _tag: "global" },
      kind: "lease",
      backend: "native",
      priority,
    },
    T0,
  );

const errorCode = (run: () => unknown): MissionError["code"] | "none" => {
  try {
    run();
    return "none";
  } catch (error) {
    return (error as MissionError).code;
  }
};

const take = (
  pool: ReturnType<typeof devEnv>,
  entries: ReadonlyArray<HoldEntry>,
  missionId: MissionId,
  now: string,
  extra: { amount?: number; queue?: boolean; ttlSeconds?: number } = {},
) =>
  takeHold(
    pool,
    entries,
    {
      missionId,
      holder: lane,
      purpose: "deploy wave",
      ttlSeconds: extra.ttlSeconds ?? 3600,
      amount: extra.amount,
      queue: extra.queue,
    },
    now,
  );

describe("pools", () => {
  it("defaults: native pools are enforced, observers are advisory and read-only", () => {
    expect(devEnv().enforcement).toBe("enforced");
    const claude = newPool(
      {
        id: "claude",
        name: "Claude pool",
        unit: "account",
        capacity: 20,
        scope: { _tag: "global" },
        kind: "observed",
        backend: "9router",
      },
      T0,
    );
    expect(claude.enforcement).toBe("advisory");
    expect(
      errorCode(() =>
        newPool(
          {
            id: "x",
            name: "x",
            unit: "slot",
            capacity: 1,
            scope: { _tag: "global" },
            kind: "lease",
            backend: "coord-claim",
            enforcement: "enforced",
          },
          T0,
        ),
      ),
    ).toBe("invalid");
    expect(errorCode(() => take(claude, [], crpko, T0))).toBe("invalid");
  });

  it("issues positive fences that only grow, and refuses a wrong fence", () => {
    const pool = devEnv();
    const first = take(pool, [], crpko, T0).entry;
    expect(first.hold.fence).toBe(1);
    const released = releaseHold(
      pool,
      [first],
      { holdId: first.hold.id, fence: 1, note: "ok" },
      at(5),
    );
    const entries = mergeEntries([first], [released.entry]);
    const second = take(pool, entries, crpko, at(6)).entry;
    expect(second.hold.fence).toBe(2);

    const all = mergeEntries(entries, [second]);
    expect(
      errorCode(() =>
        releaseHold(pool, all, { holdId: second.hold.id, fence: 1, note: "" }, at(7)),
      ),
    ).toBe("fence-mismatch");
    expect(
      errorCode(() => renewHold(all, { holdId: second.hold.id, fence: 3, ttlSeconds: 60 }, at(7))),
    ).toBe("fence-mismatch");
    expect(
      errorCode(() => releaseHold(pool, all, { holdId: first.hold.id, fence: 1, note: "" }, at(7))),
    ).toBe("conflict");
  });

  it("scopes a mission pool to its mission: Juno never touches the Crpko dev env", () => {
    expect(errorCode(() => take(devEnv(), [], juno, T0))).toBe("forbidden");
  });

  it("refuses or queues when full, and admits the queue by mission priority", () => {
    const pool = slots(1);
    const holding = take(pool, [], side, T0).entry;
    expect(errorCode(() => take(pool, [holding], crpko, at(1)))).toBe("pool-full");

    let entries: ReadonlyArray<HoldEntry> = [holding];
    const sideQueued = take(pool, entries, side, at(1), { queue: true }).entry;
    entries = mergeEntries(entries, [sideQueued]);
    const junoQueued = take(pool, entries, juno, at(2), { queue: true }).entry;
    entries = mergeEntries(entries, [junoQueued]);
    const crpkoQueued = take(pool, entries, crpko, at(3), { queue: true }).entry;
    entries = mergeEntries(entries, [crpkoQueued]);
    expect(sideQueued.hold.status).toBe("queued");
    expect(sideQueued.hold.leaseExpiresAt).toBeNull();

    expect(queueOrder(pool, entries).map(({ hold }) => hold.missionId)).toEqual([
      crpko,
      juno,
      side,
    ]);
    expect(queuePosition(pool, entries, junoQueued.hold.id)).toBe(2);

    const released = releaseHold(
      pool,
      entries,
      { holdId: holding.hold.id, fence: holding.hold.fence, note: "done" },
      at(10),
    );
    expect(released.admitted.map(({ hold }) => hold.missionId)).toEqual([crpko]);
    const admitted = released.admitted[0]!.hold;
    expect(admitted.status).toBe("active");
    expect(admitted.takenAt).toBe(at(10));
    expect(admitted.leaseExpiresAt).toBe(at(70));
  });

  it("does not let a new request jump a queued one that ranks ahead", () => {
    const pool = slots(2);
    const big = take(pool, [], side, T0).entry;
    let entries: ReadonlyArray<HoldEntry> = [big];
    const queued = take(pool, entries, crpko, at(1), { amount: 2, queue: true }).entry;
    entries = mergeEntries(entries, [queued]);
    expect(queued.hold.status).toBe("queued");
    // One slot is free, but crpko's 2-slot request is queued ahead of juno.
    expect(errorCode(() => take(pool, entries, juno, at(2)))).toBe("pool-full");
    // A queued request blocks the line; nothing smaller sneaks past it.
    expect(admitQueue(pool, entries, at(3))).toEqual([]);
  });

  it("turns an expired lease into reconcile-required and never frees it silently", () => {
    const pool = devEnv();
    const held = take(pool, [], crpko, T0, { ttlSeconds: 600 }).entry;
    expect(expireHolds([held], at(9))).toEqual([]);
    const expired = expireHolds([held], at(10));
    expect(expired.map(({ hold }) => hold.status)).toEqual(["reconcile-required"]);
    const entries = mergeEntries([held], expired);

    expect(inUse(pool, entries)).toBe(1);
    expect(errorCode(() => take(pool, entries, crpko, at(11)))).toBe("pool-full");
    expect(
      errorCode(() =>
        releaseHold(pool, entries, { holdId: held.hold.id, fence: 1, note: "" }, at(11)),
      ),
    ).toBe("conflict");
    expect(
      errorCode(() =>
        renewHold(entries, { holdId: held.hold.id, fence: 1, ttlSeconds: 60 }, at(11)),
      ),
    ).toBe("conflict");
    // An active lease that ran out but was not swept yet is still not releasable.
    expect(
      errorCode(() =>
        releaseHold(pool, [held], { holdId: held.hold.id, fence: 1, note: "" }, at(11)),
      ),
    ).toBe("conflict");

    expect(
      errorCode(() =>
        reconcileHold(
          pool,
          entries,
          { holdId: held.hold.id, fence: 1, outcome: "done", evidence: " " },
          at(12),
        ),
      ),
    ).toBe("invalid");
    const reconciled = reconcileHold(
      pool,
      entries,
      { holdId: held.hold.id, fence: 1, outcome: "rolled-back", evidence: "run 123 rolled back" },
      at(12),
    );
    expect(reconciled.entry.hold.status).toBe("expired");
    expect(reconciled.entry.hold.releaseNote).toBe("reconciled rolled-back: run 123 rolled back");
    expect(inUse(pool, mergeEntries(entries, [reconciled.entry]))).toBe(0);
  });

  it("renews a running lease", () => {
    const pool = devEnv();
    const held = take(pool, [], crpko, T0, { ttlSeconds: 600 }).entry;
    const renewed = renewHold([held], { holdId: held.hold.id, fence: 1, ttlSeconds: 1800 }, at(5));
    expect(renewed.hold.leaseExpiresAt).toBe(at(35));
  });

  it("changes capacity mid-hold without evicting anyone", () => {
    const pool = slots(2);
    const a = take(pool, [], crpko, T0).entry;
    const b = take(pool, [a], juno, T0).entry;
    let entries = mergeEntries([a], [b]);
    const lowered = setCapacity(pool, entries, 1, at(1));
    expect(lowered.overBy).toBe(1);
    expect(entries.every(({ hold }) => hold.status === "active")).toBe(true);
    expect(errorCode(() => take(lowered.pool, entries, crpko, at(2)))).toBe("pool-full");

    const queued = take(lowered.pool, entries, side, at(2), { queue: true }).entry;
    entries = mergeEntries(entries, [queued]);
    const raised = setCapacity(lowered.pool, entries, 3, at(3));
    expect(raised.admitted.map(({ hold }) => hold.missionId)).toEqual([side]);
    expect(raised.overBy).toBe(0);
  });

  it("never refuses a capacity change on scope or locks", () => {
    const global = slots(2);
    expect(setCapacity(global, [], 3, T0).pool.capacity).toBe(3);
    const locked = { ...devEnv(), lockedFields: ["capacity"] };
    expect(setCapacity(locked, [], 2, T0).pool.capacity).toBe(2);
  });

  it("counts observed usage and advisory holds without refusing", () => {
    const review = newPool(
      {
        id: "crpko-review",
        name: "Crpko review capacity",
        unit: "review",
        capacity: 2,
        scope: { _tag: "mission", missionId: crpko },
        kind: "budget",
        backend: "crw-config",
      },
      T0,
    );
    const sampled = sampleUsage(review, {
      used: 2,
      window: "day",
      resetsAt: at(600),
      runOutAt: null,
      sampledAt: at(1),
    });
    const result = take(sampled, [], crpko, at(2));
    expect(result.overCapacity).toBe(true);
    expect(result.entry.hold.status).toBe("active");
    expect(inUse(sampled, [result.entry])).toBe(3);
    expect(errorCode(() => sampleUsage(devEnv(), sampled.usage))).toBe("invalid");
  });

  it("withdraws a queued hold", () => {
    const pool = slots(1);
    const held = take(pool, [], crpko, T0).entry;
    const queued = take(pool, [held], juno, at(1), { queue: true }).entry;
    const entries = mergeEntries([held], [queued]);
    const withdrawn = releaseHold(
      pool,
      entries,
      { holdId: queued.hold.id as PoolHoldId, fence: queued.hold.fence, note: "not needed" },
      at(2),
    );
    expect(withdrawn.entry.hold.status).toBe("released");
    expect(queueOrder(pool, mergeEntries(entries, [withdrawn.entry]))).toEqual([]);
  });
});
