import {
  isOwnerProvenance,
  MissionError,
  MissionId,
  type Mission,
  type MissionPortfolio,
  type MissionProvenance,
  type MissionRecordRef,
  type PoolView,
  type PortfolioFieldChange,
  type PortfolioMission,
  type PortfolioPoolDraw,
  type PortfolioSnapshot,
  type SetPortfolioOrderInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { countsAgainstCapacity } from "../policy/pools.ts";
import type * as MissionStore from "../store/MissionStore.ts";
import type { WriteKit } from "./kit.ts";
import { isMasterAnywhere } from "./master.ts";
import { actorOf } from "./provenance.ts";
import { sameValue } from "./rules.ts";

/** The timeline for events that belong to no one mission (rules use it too). */
export const PORTFOLIO_TIMELINE = MissionId.make("missions-global");

const PORTFOLIO_ID = "portfolio";
const LISTED = ["active", "paused", "draining"] as const;
const TIER_RANK = { P0: 0, P1: 1, P2: 2 } as const;
const CHANGED_FIELDS = ["tier", "guaranteedShare", "borrowCeiling"] as const;

/** Pool use the policy service measured; null when no policy runs here. */
export interface PortfolioUsage {
  readonly pools: ReadonlyArray<PoolView>;
  readonly shares: ReadonlyArray<{ readonly missionId: MissionId; readonly dominant: number }>;
}

const portfolioRef: MissionRecordRef = { kind: "portfolio", id: PORTFOLIO_ID, label: "Portfolio" };

const fail = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

const clampShare = (value: number) => Math.min(1, Math.max(0, value));

const byDefaultOrder = (left: Mission, right: Mission) =>
  TIER_RANK[left.tier] - TIER_RANK[right.tier] ||
  right.weight - left.weight ||
  left.title.localeCompare(right.title) ||
  left.id.localeCompare(right.id);

/** Stored order first (listed missions only), then the rest by tier, weight and title. */
export const portfolioOrder = (
  missions: ReadonlyArray<Mission>,
  stored: ReadonlyArray<MissionId>,
): ReadonlyArray<MissionId> => {
  const listed = new Set(missions.map((mission) => mission.id));
  const ordered = [...new Set(stored)].filter((id) => listed.has(id));
  const placed = new Set(ordered);
  const rest = missions
    .filter((mission) => !placed.has(mission.id))
    .toSorted(byDefaultOrder)
    .map((mission) => mission.id);
  return [...ordered, ...rest];
};

const drawsOf = (missionId: MissionId, pools: ReadonlyArray<PoolView>) =>
  pools.flatMap(({ pool, holds }): ReadonlyArray<PortfolioPoolDraw> => {
    if (pool.capacity <= 0) return [];
    const held = holds
      .filter((hold) => hold.missionId === missionId && countsAgainstCapacity(hold))
      .reduce((sum, hold) => sum + hold.amount, 0);
    if (held <= 0) return [];
    return [
      {
        poolId: pool.id,
        label: pool.name,
        unit: pool.unit,
        share: clampShare(held / pool.capacity),
        runOutAt: pool.usage.runOutAt,
      },
    ];
  });

export const makePortfolio = (store: MissionStore.MissionStore["Service"]) => {
  const stored = Effect.map(store.get("portfolio", PORTFOLIO_ID), Option.getOrNull);

  const portfolio = (
    usage: PortfolioUsage | null,
  ): Effect.Effect<PortfolioSnapshot, MissionError> =>
    Effect.gen(function* () {
      const missions = yield* store.listAll("mission", LISTED);
      const record = yield* stored;
      const listed = new Set<string>(missions.map((mission) => mission.id));
      const changes = (yield* store.latestFieldChanges("mission.updated", CHANGED_FIELDS))
        .filter(({ event }) => listed.has(event.missionId))
        .map(({ field, event }): PortfolioFieldChange => ({
          ref: event.subject ?? { kind: "mission", id: event.missionId },
          field,
          actor: event.actor,
          eventId: event.id,
          at: event.at,
        }));
      const shares = new Map(usage?.shares.map((share) => [share.missionId, share.dominant]));
      return {
        order: portfolioOrder(missions, record?.order ?? []),
        missions: missions.map((mission): PortfolioMission => ({
          missionId: mission.id,
          title: mission.title,
          status: mission.status,
          tier: mission.tier,
          masterRoleId: mission.masterRoleId,
          guaranteedShare: mission.guaranteedShare,
          borrowCeiling: mission.borrowCeiling,
          usedShare: usage === null ? null : clampShare(shares.get(mission.id) ?? 0),
          pools: usage === null ? [] : drawsOf(mission.id, usage.pools),
        })),
        changes,
        orderChange: record === null ? null : { actor: record.changedBy, at: record.updatedAt },
      };
    });

  return { portfolio };
};

/** The owner and every master may reorder; the event records who did. */
export const makePortfolioWrites = (kit: WriteKit) => {
  const { store, serial, unchanged, commit } = kit;

  const setPortfolioOrder = (provenance: MissionProvenance, input: SetPortfolioOrderInput) =>
    serial(
      Effect.gen(function* () {
        if (!isOwnerProvenance(provenance) && !(yield* isMasterAnywhere(store, provenance))) {
          return yield* fail(
            "forbidden",
            "Only the owner or a mission's master sets the portfolio order.",
          );
        }
        const seen = new Set<string>();
        const titles: Array<string> = [];
        for (const missionId of input.order) {
          if (seen.has(missionId)) {
            return yield* fail("invalid", `Mission ${missionId} is in the order twice.`);
          }
          seen.add(missionId);
          const mission = Option.getOrNull(yield* store.get("mission", missionId));
          if (mission === null) return yield* fail("not-found", `No mission ${missionId}.`);
          titles.push(mission.title);
        }
        const before = Option.getOrNull(yield* store.get("portfolio", PORTFOLIO_ID));
        const previousOrder = before?.order ?? [];
        if (sameValue(previousOrder, input.order)) {
          return yield* unchanged(PORTFOLIO_TIMELINE, portfolioRef);
        }
        const record: MissionPortfolio = {
          id: PORTFOLIO_ID,
          order: input.order,
          changedBy: actorOf(provenance),
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        return yield* commit(provenance, {
          missionId: PORTFOLIO_TIMELINE,
          kind: "portfolio.reordered",
          summary:
            titles.length === 0
              ? "Portfolio order cleared."
              : `Portfolio order: ${titles.join(", ")}`,
          ref: portfolioRef,
          upserts: [{ _tag: "portfolio", record }],
          payload: { order: input.order, previousOrder },
        });
      }),
    );

  return { setPortfolioOrder };
};
