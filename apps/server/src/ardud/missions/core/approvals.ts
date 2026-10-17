import {
  approverOf,
  isOwnerProvenance,
  MissionError,
  type Approval,
  type ApprovalId,
  type ApprovalRoute,
  type ApprovalRouteMatch,
  type Approver,
  type CloseStaleApprovalInput,
  type DecideApprovalInput,
  type DraftChannel,
  type Mission,
  type MissionId,
  type MissionLink,
  type MissionProvenance,
  type MissionRecordRef,
  type OpenApprovalInput,
  type RouteApprovalInput,
  type SetApprovalRoutingInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { WriteKit } from "./kit.ts";
import { isMasterOf } from "./master.ts";
import { sameValue } from "./rules.ts";

/**
 * Approvals: a system (crw) opens one per decision and closes it as stale
 * when the head moves or the PR closes. The mission's routing table decides
 * whether the owner or the master is the approver; the owner can always
 * decide, the master only what is routed to it. A stale-closed approval never
 * counts as a decision, and every decision is pinned to its record, whose id
 * carries the head it was asked at, so a decision on an older head never
 * approves a newer one.
 */

/** What an approval or a draft looks like to the routing table. */
export type RouteSubject =
  | {
      readonly _tag: "approval";
      readonly kind: Approval["kind"];
      readonly repository: string | null;
    }
  | {
      readonly _tag: "draft";
      readonly channel: DraftChannel;
      readonly audience: string;
      readonly person: string | null;
    };

const sameText = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();

const matches = (match: ApprovalRouteMatch, subject: RouteSubject): boolean => {
  if (match._tag === "approval") {
    if (subject._tag !== "approval") return false;
    if (match.kind !== undefined && match.kind !== subject.kind) return false;
    return match.repository === undefined || sameText(match.repository, subject.repository);
  }
  if (subject._tag !== "draft") return false;
  if (match.channel !== undefined && match.channel !== subject.channel) return false;
  if (match.audience !== undefined && !sameText(match.audience, subject.audience)) return false;
  return match.person === undefined || sameText(match.person, subject.person);
};

/** First matching row wins; no match means the owner. Asks reuses this for drafts. */
export const routeApprover = (
  routes: ReadonlyArray<ApprovalRoute> | undefined,
  subject: RouteSubject,
): { readonly approver: Approver; readonly routeId: string | null } => {
  const row = (routes ?? []).find((route) => matches(route.match, subject));
  return row === undefined
    ? { approver: "owner", routeId: null }
    : { approver: row.approver, routeId: row.id };
};

const GITHUB_PULL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\//i;
const PR_KEY = /^([\w.-]+\/[\w.-]+)#\d+$/;

/** `owner/repo` from the first pull-request link (label `owner/repo#N` or a GitHub URL). */
export const repositoryOf = (links: ReadonlyArray<MissionLink>): string | null => {
  for (const link of links) {
    if (link.kind !== "pull-request") continue;
    const fromLabel = PR_KEY.exec(link.label)?.[1];
    if (fromLabel !== undefined) return fromLabel;
    const fromUrl = link.url === null ? undefined : GITHUB_PULL.exec(link.url)?.[1];
    if (fromUrl !== undefined) return fromUrl;
  }
  return null;
};

const fail = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const approvalRef = (approval: Approval): MissionRecordRef => ({
  kind: "approval",
  id: approval.id,
  label: approval.title,
});

export const makeApprovalWrites = (kit: WriteKit) => {
  const { store, serial, loadMission, unchanged, commit } = kit;

  const loadApproval = (approvalId: ApprovalId) =>
    Effect.flatMap(store.get("approval", approvalId), (found) =>
      Option.isNone(found)
        ? fail("not-found", `No approval ${approvalId}.`)
        : Effect.succeed(found.value),
    );

  /** The owner, or the mission's master: who edits routing and re-routes. */
  const requireOwnerOrMaster = (
    missionId: MissionId,
    provenance: MissionProvenance,
    action: string,
  ) =>
    Effect.gen(function* () {
      if (isOwnerProvenance(provenance)) return;
      if (yield* isMasterOf(store, missionId, provenance)) return;
      return yield* fail(
        "forbidden",
        `Only the owner or mission ${missionId}'s master can ${action}.`,
      );
    });

  /** Systems open approvals in their own name. */
  const requireRequester = (provenance: MissionProvenance, requestedBy: string) =>
    provenance._tag === "system" && provenance.component === requestedBy
      ? Effect.void
      : fail("forbidden", `Only ${requestedBy} opens or closes its approvals.`);

  const openApproval = (provenance: MissionProvenance, input: OpenApprovalInput) =>
    serial(
      Effect.gen(function* () {
        yield* requireRequester(provenance, input.requestedBy);
        const mission = yield* loadMission(input.missionId);
        const existing = yield* store.get("approval", input.approvalId);
        if (Option.isSome(existing)) {
          const before = existing.value;
          if (before.missionId !== mission.id || before.status !== "pending") {
            return yield* fail(
              "conflict",
              `Approval ${before.id} exists and is ${before.status}; open a new id.`,
            );
          }
          return yield* unchanged(mission.id, approvalRef(before));
        }
        const route = routeApprover(mission.approvalRouting, {
          _tag: "approval",
          kind: input.kind,
          repository: repositoryOf(input.links),
        });
        const now = yield* nowIso;
        const record: Approval = {
          id: input.approvalId,
          missionId: mission.id,
          kind: input.kind,
          title: input.title,
          detail: input.detail,
          requestedBy: input.requestedBy,
          links: input.links,
          status: "pending",
          staleReason: null,
          decidedBy: null,
          decidedAt: null,
          createdAt: now,
          decisionNote: null,
          approver: route.approver,
          routeNote: null,
        };
        return yield* commit(provenance, {
          missionId: mission.id,
          kind: "approval.opened",
          summary: `${input.requestedBy} asks the ${route.approver}: ${record.title}`,
          ref: approvalRef(record),
          upserts: [{ _tag: "approval", record }],
          payload: { approver: route.approver, routeId: route.routeId },
        });
      }),
    );

  const closeStaleApproval = (provenance: MissionProvenance, input: CloseStaleApprovalInput) =>
    serial(
      Effect.gen(function* () {
        const before = yield* loadApproval(input.approvalId);
        if (before.missionId !== input.missionId) {
          return yield* fail(
            "conflict",
            `Approval ${before.id} is not in mission ${input.missionId}.`,
          );
        }
        yield* requireRequester(provenance, before.requestedBy);
        if (before.status === "stale-closed")
          return yield* unchanged(before.missionId, approvalRef(before));
        if (before.status !== "pending") {
          return yield* fail("conflict", `Approval ${before.id} was already ${before.status}.`);
        }
        const record: Approval = {
          ...before,
          status: "stale-closed",
          staleReason: input.reason,
          decidedAt: yield* nowIso,
        };
        return yield* commit(provenance, {
          missionId: before.missionId,
          kind: "approval.stale-closed",
          summary: `Closed as stale: ${record.title} (${input.reason})`,
          ref: approvalRef(record),
          upserts: [{ _tag: "approval", record }],
          payload: { reason: input.reason },
        });
      }),
    );

  const decideApproval = (provenance: MissionProvenance, input: DecideApprovalInput) =>
    serial(
      Effect.gen(function* () {
        const before = yield* loadApproval(input.approvalId);
        if (before.status !== "pending") {
          return yield* fail(
            "conflict",
            before.status === "stale-closed"
              ? `Approval ${before.id} closed as stale (${before.staleReason ?? "no reason"}); it no longer counts.`
              : `Approval ${before.id} was already ${before.status}.`,
          );
        }
        const approver = approverOf(before);
        const allowed =
          isOwnerProvenance(provenance) ||
          (approver === "master" && (yield* isMasterOf(store, before.missionId, provenance)));
        if (!allowed) {
          return yield* fail(
            approver === "owner" ? "provenance-required" : "forbidden",
            approver === "owner"
              ? `Approval ${before.id} is routed to the owner.`
              : `Only the owner or mission ${before.missionId}'s master decides approval ${before.id}.`,
          );
        }
        const record: Approval = {
          ...before,
          status: input.action === "approve" ? "approved" : "rejected",
          decidedBy: provenance,
          decidedAt: yield* nowIso,
          decisionNote: input.note ?? null,
        };
        return yield* commit(provenance, {
          missionId: before.missionId,
          kind: "approval.decided",
          summary: `${input.action === "approve" ? "Approved" : "Rejected"}: ${record.title}`,
          ref: approvalRef(record),
          upserts: [{ _tag: "approval", record }],
          payload: { action: input.action, approver, note: input.note ?? null },
        });
      }),
    );

  const routeApproval = (provenance: MissionProvenance, input: RouteApprovalInput) =>
    serial(
      Effect.gen(function* () {
        const before = yield* loadApproval(input.approvalId);
        yield* requireOwnerOrMaster(before.missionId, provenance, "re-route an approval");
        if (before.status !== "pending") {
          return yield* fail("conflict", `Approval ${before.id} is ${before.status}, not pending.`);
        }
        const from = approverOf(before);
        if (from === input.approver) return yield* unchanged(before.missionId, approvalRef(before));
        const record: Approval = { ...before, approver: input.approver, routeNote: input.reason };
        return yield* commit(provenance, {
          missionId: before.missionId,
          kind: "approval.routed",
          summary: `Routed to the ${input.approver}: ${record.title} (${input.reason})`,
          ref: approvalRef(record),
          upserts: [{ _tag: "approval", record }],
          payload: { approver: input.approver, from, reason: input.reason },
        });
      }),
    );

  const setApprovalRouting = (provenance: MissionProvenance, input: SetApprovalRoutingInput) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* loadMission(input.missionId);
        yield* requireOwnerOrMaster(mission.id, provenance, "change approval routing");
        const ids = new Set(input.routes.map((route) => route.id));
        if (ids.size !== input.routes.length) {
          return yield* fail("invalid", "Approval routing rows need distinct ids.");
        }
        const ref: MissionRecordRef = { kind: "mission", id: mission.id, label: mission.title };
        if (sameValue(mission.approvalRouting ?? [], input.routes)) {
          return yield* unchanged(mission.id, ref);
        }
        const record: Mission = {
          ...mission,
          approvalRouting: input.routes,
          updatedAt: yield* nowIso,
        };
        const toMaster = input.routes.filter((route) => route.approver === "master").length;
        return yield* commit(provenance, {
          missionId: mission.id,
          kind: "approval-routing.updated",
          summary: `Approval routing: ${input.routes.length} rows, ${toMaster} to the master${
            input.reason ? ` (${input.reason})` : ""
          }`,
          ref,
          upserts: [{ _tag: "mission", record }],
          payload: { routes: input.routes, reason: input.reason ?? null },
        });
      }),
    );

  return { openApproval, closeStaleApproval, decideApproval, routeApproval, setApprovalRouting };
};
