// @effect-diagnostics nodeBuiltinImport:off - record ids use node:crypto, like the session board.
import * as NodeCrypto from "node:crypto";

import {
  type AckRuleInput,
  isOwnerProvenance,
  type LaneId,
  MissionError,
  MissionId,
  RuleChangeRequestId,
  RuleId,
  type MissionEventKind,
  type MissionProvenance,
  type MissionRecordRef,
  type RecordRuleUseInput,
  type RequestRuleChangeInput,
  type ResolveRuleChangeInput,
  type Rule,
  type RuleChangeRequest,
  type UpsertRuleInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as AsksService from "../asks/AsksService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { MissionStoreRecord } from "../store/recordIndex.ts";
import { castOf, isMasterAnywhere, isMasterOf } from "./master.ts";
import { actorOf } from "./provenance.ts";
import { sameValue } from "./rules.ts";

/**
 * Owner rules. The owner and the master write, edit and retire them through
 * the same methods (owner rule, 17 Oct 2026: nothing is owner only). Anyone
 * may ask for a change; the owner or the master resolves it. The master records each time it relied on a rule or work broke
 * it. Global rules (no mission) live on the asks global timeline.
 */

type Fx<A> = Effect.Effect<A, MissionError>;

const RULE_SCAN_LIMIT = 5000;
const NO_SCOPE = { subMissionIds: [], roleKinds: [], laneIds: [] } as const;

const fail = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const ruleRef = (rule: Rule): MissionRecordRef => ({
  kind: "rule",
  id: rule.id,
  label: rule.title,
});
const requestRef = (request: RuleChangeRequest): MissionRecordRef => ({
  kind: "rule-change-request",
  id: request.id,
  label: request.request.slice(0, 80),
});

const timelineOf = (missionId: MissionId | null) => missionId ?? AsksService.GLOBAL_TIMELINE;

export class RuleService extends Context.Service<
  RuleService,
  {
    /** A mission's rules plus the global ones, newest first. */
    readonly rules: (missionId: MissionId | null) => Fx<ReadonlyArray<Rule>>;
    readonly changeRequests: (missionId: MissionId | null) => Fx<ReadonlyArray<RuleChangeRequest>>;
    readonly upsertRule: (provenance: MissionProvenance, input: UpsertRuleInput) => Fx<Rule>;
    readonly requestRuleChange: (
      provenance: MissionProvenance,
      input: RequestRuleChangeInput,
    ) => Fx<RuleChangeRequest>;
    readonly resolveRuleChange: (
      provenance: MissionProvenance,
      input: ResolveRuleChangeInput,
    ) => Fx<RuleChangeRequest>;
    readonly recordRuleUse: (provenance: MissionProvenance, input: RecordRuleUseInput) => Fx<Rule>;
    // --- finish-b ---
    /** The calling lane acknowledges the rule's current version. */
    readonly ackRule: (provenance: MissionProvenance, input: AckRuleInput) => Fx<Rule>;
    // --- end finish-b ---
  }
>()("t3/ardud/missions/core/RuleService") {}

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const lock = yield* Semaphore.make(1);
  const serial = <A>(effect: Fx<A>) => lock.withPermit(effect);

  const loadRule = (ruleId: RuleId) =>
    Effect.flatMap(store.get("rule", ruleId), (found) =>
      Option.isSome(found) ? Effect.succeed(found.value) : fail("not-found", `No rule ${ruleId}.`),
    );

  /** The owner, or the master of the rule's mission (any mission's master for global rules). */
  const requireOwnerOrMaster = (
    missionId: MissionId | null,
    provenance: MissionProvenance,
    action: string,
  ) =>
    Effect.gen(function* () {
      if (isOwnerProvenance(provenance)) return;
      const master =
        missionId === null
          ? yield* isMasterAnywhere(store, provenance)
          : yield* isMasterOf(store, missionId, provenance);
      if (master) return;
      return yield* fail(
        "forbidden",
        missionId === null
          ? `Only the owner or a mission's master can ${action}.`
          : `Only the owner or mission ${missionId}'s master can ${action}.`,
      );
    });

  const commit = (
    provenance: MissionProvenance,
    write: {
      readonly missionId: MissionId | null;
      readonly kind: MissionEventKind;
      readonly summary: string;
      readonly ref: MissionRecordRef;
      readonly upserts: ReadonlyArray<MissionStoreRecord>;
      readonly payload?: unknown;
    },
  ) =>
    store
      .commit({
        event: {
          missionId: timelineOf(write.missionId),
          kind: write.kind,
          actor: actorOf(provenance),
          provenance,
          summary: write.summary,
          subject: write.ref,
          payload: write.payload ?? null,
        },
        upserts: write.upserts,
      })
      .pipe(Effect.asVoid);

  const rules = (missionId: MissionId | null) =>
    Effect.gen(function* () {
      const global = yield* store.list("rule", { missionId: null, order: "newest" });
      if (missionId === null) return global;
      const own = yield* store.list("rule", { missionId, order: "newest" });
      return [...own, ...global];
    });

  const changeRequests = (missionId: MissionId | null) =>
    store.list("rule-change-request", { missionId, order: "newest" });

  const nextNumber = (missionId: MissionId | null) =>
    Effect.map(store.list("rule", { missionId, limit: RULE_SCAN_LIMIT }), (existing) => {
      const numbers = existing.flatMap((rule) => (rule.number === null ? [] : [rule.number]));
      return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
    });

  const upsertRule = (provenance: MissionProvenance, input: UpsertRuleInput) =>
    serial(
      Effect.gen(function* () {
        yield* requireOwnerOrMaster(input.missionId, provenance, "write rules");
        if (
          input.missionId !== null &&
          Option.isNone(yield* store.get("mission", input.missionId))
        ) {
          return yield* fail("not-found", `No mission ${input.missionId}.`);
        }
        const now = yield* nowIso;
        const existing =
          input.ruleId === undefined ? Option.none<Rule>() : yield* store.get("rule", input.ruleId);

        if (Option.isNone(existing)) {
          const rule: Rule = {
            id:
              input.ruleId ??
              RuleId.make(`${input.missionId ?? "global"}:rule:${NodeCrypto.randomUUID()}`),
            missionId: input.missionId,
            number: yield* nextNumber(input.missionId),
            title: input.title,
            quote: input.quote,
            quotedAt: now,
            provenance,
            masterReading: input.masterReading ?? "",
            ...(input.masterReading ? { readingVersion: 1 } : {}),
            scope: input.scope ?? NO_SCOPE,
            activation: input.activation ?? "",
            status: input.status ?? "active",
            version: 1,
            acks: [],
            appliedCount: 0,
            brokenCount: 0,
            lastReliedAt: null,
            lockedFields: [],
            createdAt: now,
            updatedAt: now,
          };
          yield* commit(provenance, {
            missionId: rule.missionId,
            kind: "rule.created",
            summary: `Rule: ${rule.title}`,
            ref: ruleRef(rule),
            upserts: [{ _tag: "rule", record: rule }],
          });
          return rule;
        }

        const before = existing.value;
        if (before.missionId !== input.missionId) {
          return yield* fail(
            "conflict",
            `Rule ${before.id} belongs to ${before.missionId ?? "every mission"}; it doesn't move.`,
          );
        }
        const reworded = before.quote !== input.quote;
        const version = reworded ? before.version + 1 : before.version;
        // A reading given with this write is current, even unchanged (the master
        // confirming it still holds). Otherwise it stays on the version it was
        // written for, so the rule audit can call it stale.
        const readingVersion =
          input.masterReading !== undefined && input.masterReading !== ""
            ? version
            : reworded
              ? (before.readingVersion ?? before.version)
              : before.readingVersion;
        const next: Rule = {
          ...before,
          title: input.title,
          quote: input.quote,
          quotedAt: reworded ? now : before.quotedAt,
          // The rule's provenance says whose words the quote is.
          provenance: reworded ? provenance : before.provenance,
          masterReading: input.masterReading ?? before.masterReading,
          scope: input.scope ?? before.scope,
          activation: input.activation ?? before.activation,
          status: input.status ?? before.status,
          version,
          ...(readingVersion === undefined ? {} : { readingVersion }),
          updatedAt: now,
        };
        if (sameValue({ ...next, updatedAt: before.updatedAt }, before)) return before;
        const retired = before.status === "active" && next.status === "retired";
        yield* commit(provenance, {
          missionId: next.missionId,
          kind: retired ? "rule.retired" : "rule.updated",
          summary: `${retired ? "Retired rule" : reworded ? "Reworded rule" : "Updated rule"}: ${next.title}`,
          ref: ruleRef(next),
          upserts: [{ _tag: "rule", record: next }],
          payload: { version: next.version, status: next.status },
        });
        return next;
      }),
    );

  const requestRuleChange = (provenance: MissionProvenance, input: RequestRuleChangeInput) =>
    serial(
      Effect.gen(function* () {
        const rule = yield* loadRule(input.ruleId);
        const now = yield* nowIso;
        const request: RuleChangeRequest = {
          id: RuleChangeRequestId.make(`${rule.id}:change:${NodeCrypto.randomUUID()}`),
          ruleId: rule.id,
          missionId: rule.missionId,
          request: input.request,
          provenance,
          status: "open",
          proposedQuote: null,
          proposedScope: null,
          masterResponse: null,
          createdAt: now,
          resolvedAt: null,
        };
        yield* commit(provenance, {
          missionId: rule.missionId,
          kind: "rule.change-requested",
          summary: `Change asked for rule ${rule.title}: ${input.request}`,
          ref: requestRef(request),
          upserts: [{ _tag: "rule-change-request", record: request }],
          payload: { ruleId: rule.id },
        });
        return request;
      }),
    );

  const resolveRuleChange = (provenance: MissionProvenance, input: ResolveRuleChangeInput) =>
    serial(
      Effect.gen(function* () {
        const found = yield* store.get("rule-change-request", input.requestId);
        if (Option.isNone(found))
          return yield* fail("not-found", `No rule change request ${input.requestId}.`);
        const before = found.value;
        if (before.status !== "open") {
          return yield* fail(
            "conflict",
            `Rule change request ${before.id} is ${before.status}, not open.`,
          );
        }
        const asker = sameValue(actorOf(provenance), actorOf(before.provenance));
        if (!(input.status === "withdrawn" && asker)) {
          yield* requireOwnerOrMaster(before.missionId, provenance, "resolve rule change requests");
        }
        const now = yield* nowIso;
        const next: RuleChangeRequest = {
          ...before,
          status: input.status,
          masterResponse: input.response,
          resolvedAt: now,
        };
        yield* commit(provenance, {
          missionId: next.missionId,
          kind: "rule.change-resolved",
          summary: `Rule change ${input.status}: ${input.response || before.request}`,
          ref: requestRef(next),
          upserts: [{ _tag: "rule-change-request", record: next }],
          payload: { ruleId: next.ruleId, status: input.status },
        });
        return next;
      }),
    );

  const recordRuleUse = (provenance: MissionProvenance, input: RecordRuleUseInput) =>
    serial(
      Effect.gen(function* () {
        const before = yield* loadRule(input.ruleId);
        yield* requireOwnerOrMaster(before.missionId, provenance, "record rule use");
        if (before.status !== "active") {
          return yield* fail("conflict", `Rule ${before.id} is retired.`);
        }
        const now = yield* nowIso;
        const applied = input.outcome === "applied";
        const next: Rule = {
          ...before,
          appliedCount: applied ? before.appliedCount + 1 : before.appliedCount,
          brokenCount: applied ? before.brokenCount : before.brokenCount + 1,
          lastReliedAt: applied ? now : before.lastReliedAt,
          updatedAt: now,
        };
        const note = input.note?.trim() ?? "";
        yield* commit(provenance, {
          missionId: next.missionId,
          kind: applied ? "rule.applied" : "rule.broken",
          summary: `${applied ? "Relied on" : "Broke"} rule ${next.title}${note === "" ? "" : `: ${note}`}`,
          ref: ruleRef(next),
          upserts: [{ _tag: "rule", record: next }],
          payload: { note: note === "" ? null : note },
        });
        return next;
      }),
    );

  // --- finish-b ---
  /** The lanes the calling thread runs in the rule's mission, or in any of its missions for a global rule. */
  const callerLanes = (provenance: MissionProvenance, missionId: MissionId | null) =>
    Effect.gen(function* () {
      if (provenance._tag !== "agent") return [] as ReadonlyArray<LaneId>;
      const missions =
        missionId === null ? yield* store.missionsOfThread(provenance.threadId) : [missionId];
      const lanes: Array<LaneId> = [];
      for (const id of missions) {
        const cast = yield* castOf(store, id);
        for (const lane of cast.lanes) {
          if (lane.threadId === provenance.threadId && lane.status !== "retired") {
            lanes.push(lane.id);
          }
        }
      }
      return lanes;
    });

  const ackRule = (provenance: MissionProvenance, input: AckRuleInput) =>
    serial(
      Effect.gen(function* () {
        const before = yield* loadRule(input.ruleId);
        if (before.status !== "active") {
          return yield* fail("conflict", `Rule ${before.id} is retired.`);
        }
        const lanes = yield* callerLanes(provenance, before.missionId);
        const laneId = lanes[0];
        if (laneId === undefined) {
          return yield* fail("forbidden", "Only a lane acknowledges a rule.");
        }
        const isLane = (ack: Rule["acks"][number]) =>
          ack.actor._tag === "lane" && ack.actor.laneId === laneId;
        if (before.acks.some((ack) => isLane(ack) && ack.version === before.version)) {
          return before;
        }
        const now = yield* nowIso;
        const next: Rule = {
          ...before,
          acks: [
            ...before.acks.filter((ack) => !isLane(ack)),
            { actor: { _tag: "lane", laneId }, version: before.version, at: now },
          ],
          updatedAt: now,
        };
        yield* commit(provenance, {
          missionId: next.missionId,
          kind: "rule.acked",
          summary: `Acked rule ${next.title}`,
          ref: ruleRef(next),
          upserts: [{ _tag: "rule", record: next }],
          payload: { laneId, version: next.version },
        });
        return next;
      }),
    );
  // --- end finish-b ---

  return RuleService.of({
    rules,
    changeRequests,
    upsertRule,
    requestRuleChange,
    resolveRuleChange,
    recordRuleUse,
    ackRule,
  });
});

export const layer = Layer.effect(RuleService, make);
