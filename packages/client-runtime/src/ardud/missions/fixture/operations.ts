// The fixture's operations side: lanes, work, the rule book, roles, review
// policy, pools, recovery, the timeline and the portfolio. Shares the record
// arrays, event log and memo/commit plumbing with `index.ts`; every change is
// one event in the log, made by the owner (the fixture is the owner's client).
import {
  CriticalityVerdict,
  type Lane,
  type Mission,
  type MissionRecordRef,
  type MissionRecoveryState,
  Pool,
  PoolHold,
  type PoolView,
  RecoveryIncident,
  ReviewPolicy,
  ReviewRecord,
  Role,
  RoleBinding,
  type Rule,
  RuleChangeRequest,
  type SubMission,
  type Suggestion,
  WorkItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { latestFieldChanges } from "../changeLog.ts";
import { ROLE_KIND_LABEL } from "../rolesViewModel.ts";
import type {
  Listener,
  MissionPoolsSnapshot,
  MissionReviewSnapshot,
  MissionRolesSnapshot,
  MissionRuleBook,
  MissionTimelineEvent,
  MissionTimelineWindow,
  MissionWorkSnapshot,
  MissionsSource,
  PortfolioSnapshot,
  Unsubscribe,
  WorkQuery,
} from "../source.ts";
import * as data from "./data.ts";
import type { EventLog } from "./eventLog.ts";
import * as ops from "./opsData.ts";
import { RuleAuditSeed } from "./schemas.ts";
import { fail, newestFirst, replace } from "./util.ts";

const decodeRoles = Schema.decodeUnknownSync(Schema.Array(Role));
const decodeBindings = Schema.decodeUnknownSync(Schema.Array(RoleBinding));
const decodeBinding = Schema.decodeUnknownSync(RoleBinding);
const decodePolicies = Schema.decodeUnknownSync(Schema.Array(ReviewPolicy));
const decodePolicy = Schema.decodeUnknownSync(ReviewPolicy);
const decodeVerdicts = Schema.decodeUnknownSync(Schema.Array(CriticalityVerdict));
const decodeReviews = Schema.decodeUnknownSync(Schema.Array(ReviewRecord));
const decodePools = Schema.decodeUnknownSync(Schema.Array(Pool));
const decodeHolds = Schema.decodeUnknownSync(Schema.Array(PoolHold));
const decodeWorkItems = Schema.decodeUnknownSync(Schema.Array(WorkItem));
const decodeChangeRequests = Schema.decodeUnknownSync(Schema.Array(RuleChangeRequest));
const decodeAudit = Schema.decodeUnknownSync(Schema.Array(RuleAuditSeed));
const decodeIncidents = Schema.decodeUnknownSync(Schema.Array(RecoveryIncident));

/** Pool pressure turns tight from this share in use, or when anything queues. */
const POOL_TIGHT_USE = 0.66;

export interface OperationsContext {
  readonly missions: Mission[];
  readonly subMissions: SubMission[];
  readonly lanes: Lane[];
  readonly suggestions: ReadonlyArray<Suggestion>;
  readonly log: EventLog;
  readonly memo: <T>(key: string, compute: () => T) => T;
  readonly commit: () => void;
  readonly watch: <T>(read: () => T, listener: Listener<T>) => Unsubscribe;
  readonly nowIso: () => string;
  readonly localId: (prefix: string) => string;
  readonly missionRules: (missionId: string) => ReadonlyArray<Rule>;
  /** Posts the owner's nudge to the lane's room, addressed to the lane. */
  readonly postNudge: (lane: Lane, note: string) => void;
}

export type OperationsSource = Pick<
  MissionsSource,
  | "subscribeWork"
  | "subscribeRuleBook"
  | "subscribeRoles"
  | "subscribeReviewPolicy"
  | "subscribePools"
  | "subscribeRecovery"
  | "subscribeTimeline"
  | "subscribeTimelineWindow"
  | "loadOlderTimeline"
  | "subscribePortfolio"
  | "resolveRuleChange"
  | "nudgeLane"
  | "handOffLane"
  | "setLaneParked"
  | "moveLane"
  | "splitLane"
  | "mergeLanes"
  | "setRoleModel"
  | "setCriticalityGuide"
  | "setPoolCapacity"
  | "setPortfolioOrder"
  | "createLane"
  | "createRole"
>;

const ref = (kind: MissionRecordRef["kind"], id: string, label?: string): MissionRecordRef =>
  label === undefined ? { kind, id } : { kind, id, label };

/** The pool's holds, live ones first, then the queue in admission order. */
function poolView(pool: Pool, poolHolds: ReadonlyArray<PoolHold>): PoolView {
  const live = poolHolds
    .filter((hold) => hold.status === "active" || hold.status === "reconcile-required")
    .sort((left, right) =>
      (left.takenAt ?? left.createdAt).localeCompare(right.takenAt ?? right.createdAt),
    );
  const queued = poolHolds
    .filter((hold) => hold.status === "queued")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const inUse =
    pool.kind === "lease" ? live.reduce((sum, hold) => sum + hold.amount, 0) : pool.usage.used;
  const left = pool.capacity - inUse;
  const queue = queued.length > 0 ? `, ${queued.length} queued` : "";
  const pressure =
    left <= 0
      ? "exhausted"
      : queued.length > 0 || (pool.capacity > 0 && inUse / pool.capacity >= POOL_TIGHT_USE)
        ? "tight"
        : "ok";
  const pressureReason =
    left <= 0
      ? `All ${pool.capacity} ${pool.unit} in use${queue}`
      : `${Math.round(left * 100) / 100} of ${pool.capacity} ${pool.unit} left${queue}`;
  return {
    pool,
    holds: [...live, ...queued],
    inUse,
    pressure,
    pressureReason,
    sourceConfigured: true,
  };
}

const poolCovers = (pool: Pool, missionId: string) =>
  pool.scope._tag === "global" ||
  (pool.scope._tag === "mission" && pool.scope.missionId === missionId) ||
  (pool.scope._tag === "shared" && pool.scope.missionIds.some((id) => id === missionId));

const sameModel = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export interface Operations {
  readonly source: OperationsSource;
  /** The overview's line for the newest incident still open, as the recovery track reports it. */
  readonly openRecovery: (missionId: string) => MissionRecoveryState | null;
}

export function createOperations(ctx: OperationsContext): Operations {
  const { missions, subMissions, lanes, log, memo, commit, watch, nowIso, localId } = ctx;
  const roles: Role[] = [...decodeRoles(ops.roles)];
  const bindings: RoleBinding[] = [...decodeBindings(ops.bindings)];
  const policies: ReviewPolicy[] = [...decodePolicies([ops.reviewPolicy])];
  const verdicts = decodeVerdicts(ops.verdicts);
  const reviews = decodeReviews(ops.reviews);
  const pools: Pool[] = [...decodePools(ops.pools)];
  const holds = decodeHolds(ops.holds);
  const workItems: WorkItem[] = [...decodeWorkItems(ops.workItems)];
  const changeRequests: RuleChangeRequest[] = [...decodeChangeRequests(ops.changeRequests)];
  const audit = decodeAudit(ops.audit);
  const incidents: ReadonlyArray<RecoveryIncident> = decodeIncidents(ops.recoveryIncidents);
  let portfolioOrder: string[] = [...ops.portfolioOrder];

  /** Latest change per field over the events that match. */
  const changesWhere = (keep: (event: MissionTimelineEvent) => boolean) =>
    latestFieldChanges(log.all().filter(keep));

  const missionOf = (missionId: string) => missions.find((m) => m.id === missionId);
  const findLane = (laneId: string) => lanes.find((l) => l.id === laneId);

  /** Same order and filters as `missions.workItems`: most recently changed first. */
  function work(missionId: string, query: WorkQuery = {}): MissionWorkSnapshot {
    return memo(`work:${missionId}:${JSON.stringify(query)}`, () => {
      const matching = workItems
        .filter(
          (item) =>
            item.missionId === missionId &&
            (query.laneId === undefined || item.laneId === query.laneId) &&
            (query.stages === undefined || query.stages.includes(item.stage)),
        )
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
        );
      const items = query.limit === undefined ? matching : matching.slice(0, query.limit);
      return {
        missionId: missionId as MissionWorkSnapshot["missionId"],
        items,
        total: matching.length,
        hasMore: items.length < matching.length,
      };
    });
  }

  function ruleBook(missionId: string): MissionRuleBook {
    return memo(`rule-book:${missionId}`, () => {
      const rules = ctx.missionRules(missionId);
      const ids = new Set<string>(rules.map((rule) => rule.id));
      return {
        missionId: missionId as MissionRuleBook["missionId"],
        rules,
        changeRequests: newestFirst(changeRequests.filter((request) => ids.has(request.ruleId))),
        audit: audit.filter((finding) => finding.ruleIds.some((id) => ids.has(id))),
        suggestions: ctx.suggestions.filter(
          (s) =>
            s.status === "open" &&
            s.targetKind === "rule" &&
            (s.missionId === null || s.missionId === missionId),
        ),
        changes: changesWhere(
          (event) =>
            event.missionId === missionId &&
            event.subject?.kind === "rule" &&
            ids.has(event.subject.id),
        ),
      };
    });
  }

  function rolesSnapshot(missionId: string): MissionRolesSnapshot {
    return memo(`roles:${missionId}`, () => {
      const missionRoles = roles.filter((role) => role.missionId === missionId);
      const byId = new Map<string, Role>(missionRoles.map((role) => [role.id, role]));
      const missionBindings = bindings
        .filter((binding) => byId.has(binding.roleId))
        .sort((left, right) => right.boundAt.localeCompare(left.boundAt));
      const drift = missionBindings.flatMap((binding) => {
        const role = byId.get(binding.roleId);
        if (!role || binding.endedAt !== null || binding.observedModel === null) return [];
        if (binding.observedModel === role.modelSelection.model) return [];
        return [
          {
            roleId: role.id,
            bindingId: binding.id,
            threadId: binding.threadId,
            expected: role.modelSelection.model,
            observed: binding.observedModel,
          },
        ];
      });
      return {
        missionId: missionId as MissionRolesSnapshot["missionId"],
        roles: missionRoles,
        defaults: [],
        bindings: missionBindings,
        drift,
        changes: changesWhere(
          (event) =>
            event.missionId === missionId &&
            event.subject?.kind === "role" &&
            byId.has(event.subject.id),
        ),
      };
    });
  }

  function reviewSnapshot(missionId: string): MissionReviewSnapshot | null {
    return memo(`review:${missionId}`, () => {
      const policy = policies.find((p) => p.missionId === missionId);
      if (!policy) return null;
      return {
        missionId: policy.missionId,
        policy,
        verdicts: newestFirst(verdicts.filter((v) => v.missionId === missionId)),
        reviews: newestFirst(reviews.filter((r) => r.missionId === missionId)),
        changes: changesWhere(
          (event) => event.missionId === missionId && event.subject?.kind === "review-policy",
        ),
      };
    });
  }

  function poolsSnapshot(missionId: string): MissionPoolsSnapshot {
    return memo(`pools:${missionId}`, () => {
      const covering = pools.filter((pool) => poolCovers(pool, missionId));
      const ids = new Set<string>(covering.map((pool) => pool.id));
      return {
        pools: covering.map((pool) =>
          poolView(
            pool,
            holds.filter((hold) => hold.poolId === pool.id),
          ),
        ),
        // The newest usage sample, so unrelated commits don't change the snapshot.
        at:
          covering.reduce<string | null>(
            (newest, pool) =>
              newest === null || pool.usage.sampledAt > newest ? pool.usage.sampledAt : newest,
            null,
          ) ?? nowIso(),
        changes: changesWhere(
          (event) => event.subject?.kind === "pool" && ids.has(event.subject.id),
        ),
      };
    });
  }

  function recovery(missionId: string): ReadonlyArray<RecoveryIncident> {
    return memo(`recovery:${missionId}`, () =>
      incidents
        .filter((incident) => incident.missionIds.some((id) => id === missionId))
        .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt)),
    );
  }

  function timeline(missionId: string): ReadonlyArray<MissionTimelineEvent> {
    return memo(`timeline:${missionId}`, () =>
      log
        .all()
        .filter((event) => event.missionId === missionId)
        .sort((left, right) => right.seq - left.seq),
    );
  }

  /** The fixture keeps its whole log in memory, so there is never an older page. */
  function timelineWindow(missionId: string): MissionTimelineWindow {
    return memo(`timeline-window:${missionId}`, () => ({
      events: timeline(missionId),
      hasOlder: false,
    }));
  }

  function portfolio(): PortfolioSnapshot {
    return memo("portfolio", () => {
      const live = missions.filter((m) => m.status !== "archived");
      const ordered = [
        ...portfolioOrder.flatMap((id) => live.filter((m) => m.id === id)),
        ...live.filter((m) => !portfolioOrder.includes(m.id)),
      ];
      const reorders = log.all().filter((event) => event.kind === "portfolio.reordered");
      const lastReorder = reorders[reorders.length - 1];
      const missionIds = new Set<string>(ordered.map((m) => m.id));
      return {
        order: ordered.map((m) => m.id),
        missions: ordered.map((mission) => {
          const usage = data.usageShares[mission.id] ?? null;
          return {
            missionId: mission.id,
            title: mission.title,
            status: mission.status,
            tier: mission.tier,
            masterRoleId: mission.masterRoleId,
            guaranteedShare: mission.guaranteedShare,
            borrowCeiling: mission.borrowCeiling,
            // made: the usage share is of the mission's guarantee; scaled to the whole.
            usedShare: usage === null ? null : usage * mission.guaranteedShare,
            pools: (ops.portfolioDraws[mission.id] ?? []).flatMap((draw) => {
              const pool = pools.find((p) => p.id === draw.poolId);
              return pool
                ? [
                    {
                      poolId: pool.id,
                      label: pool.name,
                      unit: pool.unit,
                      share: draw.share,
                      runOutAt: pool.usage.runOutAt,
                    },
                  ]
                : [];
            }),
          };
        }),
        changes: changesWhere(
          (event) => event.subject?.kind === "mission" && missionIds.has(event.subject.id),
        ).filter((change) => ["tier", "guaranteedShare", "borrowCeiling"].includes(change.field)),
        orderChange: lastReorder ? { actor: lastReorder.actor, at: lastReorder.at } : null,
      };
    });
  }

  /** A lane that can take lane actions: it exists and is not retired. */
  function liveLane(laneId: string): Lane | null {
    const lane = findLane(laneId);
    return lane && lane.status !== "retired" ? lane : null;
  }

  const source: OperationsSource = {
    subscribeWork: (missionId, listener, query) => watch(() => work(missionId, query), listener),
    subscribeRuleBook: (missionId, listener) => watch(() => ruleBook(missionId), listener),
    subscribeRoles: (missionId, listener) => watch(() => rolesSnapshot(missionId), listener),
    subscribeReviewPolicy: (missionId, listener) =>
      watch(() => reviewSnapshot(missionId), listener),
    subscribePools: (missionId, listener) => watch(() => poolsSnapshot(missionId), listener),
    subscribeRecovery: (missionId, listener) => watch(() => recovery(missionId), listener),
    subscribeTimeline: (missionId, listener) => watch(() => timeline(missionId), listener),
    subscribeTimelineWindow: (missionId, listener) =>
      watch(() => timelineWindow(missionId), listener),
    loadOlderTimeline: () => Promise.resolve(),
    subscribePortfolio: (listener) => watch(portfolio, listener),

    resolveRuleChange({ requestId, status, response }) {
      const request = changeRequests.find((r) => r.id === requestId);
      if (!request) return fail("not-found", `Change request ${requestId} not found.`);
      if (request.status !== "open") return fail("conflict", "This change request is closed.");
      const action = status === "applied" ? "apply" : "decline";
      const text = response.trim();
      if (action === "decline" && text.length === 0) {
        return fail("invalid", "Say why the change is declined.");
      }
      const at = nowIso();
      replace(changeRequests, {
        ...request,
        status,
        masterResponse: text.length > 0 ? text : null,
        resolvedAt: at,
      });
      for (const missionId of request.missionId !== null
        ? [request.missionId]
        : missions.map((m) => m.id)) {
        log.record({
          missionId,
          kind: "rule.change-resolved",
          subject: ref("rule-change-request", request.id),
          summary: `${action === "apply" ? "Applied" : "Declined"} a change to ${request.ruleId}`,
          payload: { action, ruleId: request.ruleId },
        });
      }
      commit();
      return Promise.resolve();
    },

    nudgeLane({ laneId, note }) {
      const lane = liveLane(laneId);
      if (!lane) return fail("not-found", `Lane ${laneId} not found.`);
      if (lane.status === "parked") return fail("conflict", "Resume the lane before nudging it.");
      const text = note?.trim() ?? "";
      ctx.postNudge(lane, text.length > 0 ? text : "Nudge");
      log.record({
        missionId: lane.missionId,
        kind: "lane.nudged",
        subject: ref("lane", lane.id, lane.name),
        summary: text.length > 0 ? `Nudged ${lane.name}: ${text}` : `Nudged ${lane.name}`,
      });
      commit();
      return Promise.resolve();
    },

    handOffLane({ laneId, note }) {
      const lane = liveLane(laneId);
      if (!lane) return fail("not-found", `Lane ${laneId} not found.`);
      if (lane.leadRoleId === null || lane.threadId === null) {
        return fail("conflict", "This lane has no lead thread to hand off.");
      }
      const handoff = note.trim();
      if (handoff.length === 0)
        return fail("invalid", "Write the handoff note for the new thread.");
      const at = nowIso();
      const current = bindings.find(
        (b) => b.roleId === lane.leadRoleId && b.threadId === lane.threadId && b.endedAt === null,
      );
      if (current) replace(bindings, { ...current, endedAt: at });
      const fresh = decodeBinding({
        id: localId("binding"),
        roleId: lane.leadRoleId,
        threadId: localId("thread"),
        reason: "succession",
        handoffNote: handoff,
        observedModel: null,
        boundAt: at,
        endedAt: null,
      });
      bindings.push(fresh);
      replace(lanes, {
        ...lane,
        threadId: fresh.threadId,
        context: lane.context
          ? { ...lane.context, promptTokens: 0, successions: lane.context.successions + 1 }
          : null,
        updatedAt: at,
      });
      log.record({
        missionId: lane.missionId,
        kind: "role.succession",
        subject: ref("lane", lane.id, lane.name),
        summary: `Handed ${lane.name} to a fresh thread`,
        payload: { roleId: lane.leadRoleId, bindingId: fresh.id, handoffNote: handoff },
      });
      commit();
      return Promise.resolve();
    },

    setLaneParked({ laneId, parked, reason }) {
      const lane = liveLane(laneId);
      if (!lane) return fail("not-found", `Lane ${laneId} not found.`);
      if ((lane.status === "parked") === parked) return Promise.resolve();
      const why = reason?.trim() || null;
      replace(lanes, {
        ...lane,
        status: parked ? "parked" : "idle",
        statusReason: parked ? why : null,
        updatedAt: nowIso(),
      });
      log.record({
        missionId: lane.missionId,
        kind: parked ? "lane.parked" : "lane.resumed",
        subject: ref("lane", lane.id, lane.name),
        summary: parked ? `Parked ${lane.name}${why ? `: ${why}` : ""}` : `Resumed ${lane.name}`,
        payload: { changed: ["status"], status: parked ? "parked" : "idle" },
      });
      commit();
      return Promise.resolve();
    },

    moveLane({ laneId, subMissionId }) {
      const lane = liveLane(laneId);
      if (!lane) return fail("not-found", `Lane ${laneId} not found.`);
      const target = subMissions.find(
        (s) => s.id === subMissionId && s.missionId === lane.missionId,
      );
      if (!target || target.status === "closed") {
        return fail("invalid", "Pick an open sub-mission of this mission.");
      }
      if (lane.subMissionId === subMissionId) return Promise.resolve();
      replace(lanes, { ...lane, subMissionId: target.id, updatedAt: nowIso() });
      log.record({
        missionId: lane.missionId,
        kind: "lane.moved",
        subject: ref("lane", lane.id, lane.name),
        summary: `Moved ${lane.name} to ${target.title}`,
        payload: { changed: ["subMissionId"], subMissionId: target.id },
      });
      commit();
      return Promise.resolve();
    },

    splitLane({ laneId, name, purpose = "" }) {
      const lane = liveLane(laneId);
      if (!lane) return fail("not-found", `Lane ${laneId} not found.`);
      const laneName = name.trim();
      if (laneName.length === 0) return fail("invalid", "Name the new lane.");
      if (
        lanes.some(
          (l) => l.missionId === lane.missionId && l.name.toLowerCase() === laneName.toLowerCase(),
        )
      ) {
        return fail("conflict", `This mission already has a lane named ${laneName}.`);
      }
      const at = nowIso();
      const split: Lane = {
        ...lane,
        id: localId("lane") as Lane["id"],
        name: laneName,
        purpose: purpose.trim(),
        status: "idle",
        statusReason: null,
        leadRoleId: null,
        threadId: null,
        currentItemId: null,
        lastEvidence: null,
        context: null,
        lastActiveAt: null,
        createdAt: at,
        updatedAt: at,
      };
      lanes.push(split);
      log.record({
        missionId: lane.missionId,
        kind: "lane.split",
        subject: ref("lane", lane.id, lane.name),
        summary: `Split ${laneName} out of ${lane.name}`,
        payload: { laneId: split.id },
      });
      commit();
      return Promise.resolve();
    },

    mergeLanes({ laneId, intoLaneId }) {
      const lane = liveLane(laneId);
      const into = liveLane(intoLaneId);
      if (!lane || !into) return fail("not-found", "Both lanes must exist and be live.");
      if (lane.id === into.id || lane.missionId !== into.missionId) {
        return fail("invalid", "Merge a lane into another lane of the same mission.");
      }
      const at = nowIso();
      replace(lanes, {
        ...lane,
        status: "retired",
        statusReason: `Merged into ${into.name}`,
        updatedAt: at,
      });
      for (const item of workItems.filter((w) => w.laneId === lane.id)) {
        replace(workItems, { ...item, laneId: into.id, updatedAt: at });
      }
      log.record({
        missionId: lane.missionId,
        kind: "lane.merged",
        subject: ref("lane", lane.id, lane.name),
        summary: `Merged ${lane.name} into ${into.name}`,
        payload: { intoLaneId: into.id },
      });
      commit();
      return Promise.resolve();
    },

    setRoleModel({ roleId, modelSelection, reason }) {
      const role = roles.find((r) => r.id === roleId);
      if (!role) return fail("not-found", `Role ${roleId} not found.`);
      const why = reason.trim();
      if (why.length === 0) return fail("invalid", "Say why the model changes.");
      const pending = sameModel(modelSelection, role.modelSelection) ? null : modelSelection;
      if (sameModel(pending, role.pendingModelSelection)) return Promise.resolve();
      replace(roles, { ...role, pendingModelSelection: pending, updatedAt: nowIso() });
      log.record({
        missionId: role.missionId,
        kind: "role.model-changed",
        subject: ref("role", role.id, role.name),
        summary: pending
          ? `${role.name} moves to ${modelSelection.model} next turn: ${why}`
          : `${role.name} stays on ${role.modelSelection.model}: ${why}`,
        payload: { changed: ["pendingModelSelection"], model: modelSelection.model },
      });
      commit();
      return Promise.resolve();
    },

    setCriticalityGuide({ missionId, text, hardTriggers }) {
      const policy = policies.find((p) => p.missionId === missionId);
      if (!policy) return fail("not-found", `Mission ${missionId} has no review policy.`);
      const guideText = text.trim();
      if (guideText.length === 0) return fail("invalid", "The guide needs some text.");
      const triggers = hardTriggers ?? policy.guide.hardTriggers;
      if (
        guideText === policy.guide.text &&
        JSON.stringify(triggers) === JSON.stringify(policy.guide.hardTriggers)
      ) {
        return Promise.resolve();
      }
      const at = nowIso();
      const next = decodePolicy({
        ...policy,
        version: policy.version + 1,
        guide: {
          text: guideText,
          hardTriggers: triggers,
          version: policy.guide.version + 1,
          authoredBy: { _tag: "owner" },
          updatedAt: at,
        },
        updatedAt: at,
      });
      policies[policies.indexOf(policy)] = next;
      log.record({
        missionId,
        kind: "review-policy.updated",
        subject: ref("review-policy", missionId, "Review policy"),
        summary: `Criticality guide v${next.guide.version}`,
        payload: { changed: ["guide"], version: next.version },
      });
      commit();
      return Promise.resolve();
    },

    setPoolCapacity({ poolId, capacity, reason }) {
      const pool = pools.find((p) => p.id === poolId);
      if (!pool) return fail("not-found", `Pool ${poolId} not found.`);
      if (!Number.isFinite(capacity) || capacity < 0) {
        return fail("invalid", "Capacity is a number of zero or more.");
      }
      const why = reason.trim();
      if (why.length === 0) return fail("invalid", "Say why the capacity changes.");
      if (capacity === pool.capacity) return Promise.resolve();
      replace(pools, { ...pool, capacity, updatedAt: nowIso() });
      for (const mission of missions.filter((m) => poolCovers(pool, m.id))) {
        log.record({
          missionId: mission.id,
          kind: "pool.updated",
          subject: ref("pool", pool.id, pool.name),
          summary: `${pool.name}: capacity ${pool.capacity} -> ${capacity} ${pool.unit}. ${why}`,
          payload: { changed: ["capacity"], capacity },
        });
      }
      commit();
      return Promise.resolve();
    },

    setPortfolioOrder({ order }) {
      const live = missions.filter((m) => m.status !== "archived").map((m) => m.id as string);
      const next = [...order] as string[];
      const valid =
        next.length === live.length &&
        new Set(next).size === next.length &&
        next.every((id) => live.includes(id));
      if (!valid) return fail("invalid", "The order must list every live mission once.");
      if (next.every((id, index) => portfolio().order[index] === id)) return Promise.resolve();
      portfolioOrder = next;
      const summary = `Mission order: ${next.map((id) => missionOf(id)?.title ?? id).join(", ")}`;
      // Every mission's timeline shows the reorder, since it moves them all.
      for (const missionId of next) {
        log.record({
          missionId,
          kind: "portfolio.reordered",
          subject: null,
          summary,
          payload: { order: next },
        });
      }
      commit();
      return Promise.resolve();
    },

    // --- finish-b ---
    createLane({ missionId, name, subMissionId }) {
      if (!missionOf(missionId)) return fail("not-found", `Mission ${missionId} not found.`);
      const title = name.trim();
      if (title.length === 0) return fail("invalid", "A new lane needs a name.");
      const at = nowIso();
      const lane: Lane = {
        id: localId("lane") as Lane["id"],
        missionId,
        subMissionId: subMissionId ?? null,
        name: title,
        purpose: "",
        status: "idle",
        statusReason: null,
        leadRoleId: null,
        threadId: null,
        currentItemId: null,
        lastEvidence: null,
        context: null,
        lastActiveAt: null,
        createdAt: at,
        updatedAt: at,
      };
      lanes.push(lane);
      log.record({
        missionId,
        kind: "lane.created",
        subject: ref("lane", lane.id, lane.name),
        summary: `Added lane ${lane.name}`,
      });
      commit();
      return Promise.resolve();
    },

    createRole({ missionId, kind, name, description, laneId, modelSelection }) {
      const mission = missionOf(missionId);
      if (!mission) return fail("not-found", `Mission ${missionId} not found.`);
      const model =
        modelSelection ??
        roles.find((r) => r.id === mission.masterRoleId)?.modelSelection ??
        roles.find((r) => r.missionId === missionId)?.modelSelection;
      if (kind === "custom" && (!name?.trim() || !modelSelection)) {
        return fail("invalid", "custom roles need a name and a model");
      }
      if (!model) return fail("invalid", "Pick a model for the role.");
      const at = nowIso();
      const role: Role = {
        id: localId("role") as Role["id"],
        missionId,
        kind,
        name: name?.trim() || ROLE_KIND_LABEL[kind],
        description: description ?? "",
        modelSelection: model,
        pendingModelSelection: null,
        laneId: laneId ?? null,
        writesPublicText: kind !== "reviewer" && kind !== "final-reviewer",
        lockedFields: [],
        createdAt: at,
        updatedAt: at,
      };
      roles.push(role);
      log.record({
        missionId,
        kind: "role.created",
        subject: ref("role", role.id, role.name),
        summary: `Added ${role.name}`,
      });
      commit();
      return Promise.resolve();
    },
    // --- end finish-b ---
  };

  return {
    source,
    openRecovery: (missionId) => {
      const incident = recovery(missionId).find((open) => open.clearedAt === null);
      if (!incident) return null;
      const pending = incident.threads.filter((thread) =>
        ["pending", "held", "failed"].includes(thread.state),
      );
      if (pending.length === 0) return null;
      return {
        incidentId: incident.id,
        cause: incident.cause,
        at: incident.windowEnd,
        // Clients build the line from `cause` and `at` in the reader's zone.
        label: `Recovered from ${incident.cause}`,
        total: incident.threads.length,
        pending: pending.length,
        reconcile: pending.filter(
          (thread) =>
            thread.action === "reconcile-first" ||
            thread.holds.some((hold) => hold.reconcileRequired),
        ).length,
      };
    },
  };
}
