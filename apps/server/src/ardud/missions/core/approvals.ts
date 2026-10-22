// @effect-diagnostics nodeBuiltinImport:off - comment ids use node:crypto, like core record ids.
import * as NodeCrypto from "node:crypto";

import {
  approverOf,
  isOwnerProvenance,
  MissionError,
  type AnnotateApprovalInput,
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
  type WorkItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { commentsOn, decisionNoteOf, markIdOf, withComment } from "../asks/inboxMarks.ts";
import { settleDiscussion } from "./conditions.ts";
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

// ardud missions: asks (summary and flag chips on approvals and drafts)
const SUMMARY_MAX = 400;
const FLAG_MAX = 40;
const FLAGS_MAX = 12;

export interface Annotation {
  readonly summary: string | null;
  readonly flags: ReadonlyArray<string>;
}

/**
 * Cleans a summary and flag labels for an approval or draft: trimmed, empty summary is none,
 * flags deduped case-insensitively in the order given. Labels are free text; only their size
 * is checked, since they show as chips.
 */
export const cleanAnnotation = (
  before: Annotation,
  input: {
    readonly summary?: string | null | undefined;
    readonly flags?: ReadonlyArray<string> | undefined;
  },
): Effect.Effect<Annotation, MissionError> => {
  const summary = input.summary === undefined ? before.summary : input.summary?.trim() || null;
  if (summary !== null && summary.length > SUMMARY_MAX) {
    return Effect.fail(
      new MissionError({
        code: "invalid",
        detail: `Keep the summary to one or two lines (at most ${SUMMARY_MAX} characters).`,
      }),
    );
  }
  if (input.flags === undefined) return Effect.succeed({ summary, flags: before.flags });
  const flags: Array<string> = [];
  const seen = new Set<string>();
  for (const raw of input.flags) {
    const flag = raw.trim();
    if (flag.length === 0 || seen.has(flag.toLowerCase())) continue;
    if (flag.length > FLAG_MAX) {
      return Effect.fail(
        new MissionError({
          code: "invalid",
          detail: `Flag "${flag.slice(0, FLAG_MAX)}..." is too long; flags are short labels (at most ${FLAG_MAX} characters).`,
        }),
      );
    }
    seen.add(flag.toLowerCase());
    flags.push(flag);
  }
  if (flags.length > FLAGS_MAX) {
    return Effect.fail(
      new MissionError({ code: "invalid", detail: `At most ${FLAGS_MAX} flags.` }),
    );
  }
  return Effect.succeed({ summary, flags });
};

export const sameAnnotation = (left: Annotation, right: Annotation) =>
  left.summary === right.summary &&
  left.flags.length === right.flags.length &&
  left.flags.every((flag, index) => flag === right.flags[index]);
// ardud missions: end asks

/**
 * The work an approval or draft is about. Missing or null matches no row that
 * names a sub-mission or work item.
 */
interface RouteWork {
  readonly subMissionId?: string | null | undefined;
  readonly workItemId?: string | null | undefined;
}

/** What an approval or a draft looks like to the routing table. */
export type RouteSubject =
  | ({
      readonly _tag: "approval";
      readonly kind: Approval["kind"];
      readonly repository: string | null;
    } & RouteWork)
  | ({
      readonly _tag: "draft";
      readonly channel: DraftChannel;
      readonly audience: string;
      readonly person: string | null;
    } & RouteWork);

const sameText = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();

const matchesWork = (match: RouteWork, subject: RouteWork) =>
  (match.subMissionId === undefined || match.subMissionId === subject.subMissionId) &&
  (match.workItemId === undefined || match.workItemId === subject.workItemId);

const matches = (match: ApprovalRouteMatch, subject: RouteSubject): boolean => {
  if (!matchesWork(match, subject)) return false;
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

const GITHUB_PULL_NUMBER = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i;
const PR_KEY_NUMBER = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/** The first pull-request link that names its repo and number, as a key. */
export const pullRequestOf = (
  links: ReadonlyArray<MissionLink>,
): { readonly repository: string; readonly number: number } | null => {
  for (const link of links) {
    if (link.kind !== "pull-request") continue;
    const found =
      PR_KEY_NUMBER.exec(link.label) ??
      (link.url === null ? null : GITHUB_PULL_NUMBER.exec(link.url));
    if (found?.[1] !== undefined && found[2] !== undefined) {
      return { repository: found[1], number: Number(found[2]) };
    }
  }
  return null;
};

/**
 * The work an approval is about: the mission's work item whose pull request
 * is the approval's PR link. Two items on the same PR name no item; they name
 * the sub-mission only when they share it. No match is no work, so rows that
 * name a sub-mission or item skip it.
 */
export const approvalWork = (
  links: ReadonlyArray<MissionLink>,
  items: ReadonlyArray<WorkItem>,
): { readonly subMissionId: string | null; readonly workItemId: string | null } => {
  const pullRequest = pullRequestOf(links);
  const onPullRequest =
    pullRequest === null
      ? []
      : items.filter(
          (item) =>
            item.pullRequest !== null &&
            item.pullRequest.number === pullRequest.number &&
            sameText(pullRequest.repository, item.pullRequest.repository),
        );
  const subMissions = new Set(onPullRequest.map((item) => item.subMissionId));
  const [only] = onPullRequest;
  return {
    subMissionId: subMissions.size === 1 ? (only?.subMissionId ?? null) : null,
    workItemId: onPullRequest.length === 1 ? (only?.id ?? null) : null,
  };
};

/** Some approval row routes by the work an approval is about. */
const routesByWork = (routes: ReadonlyArray<ApprovalRoute> | undefined) =>
  (routes ?? []).some(
    (route) =>
      route.match._tag === "approval" &&
      (route.match.subMissionId !== undefined || route.match.workItemId !== undefined),
  );

const fail = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const approvalRef = (approval: Approval): MissionRecordRef => ({
  kind: "approval",
  id: approval.id,
  label: approval.title,
});

export const makeApprovalWrites = (kit: WriteKit) => {
  const { store, conditions, serial, loadMission, unchanged, commit } = kit;

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

  /** Rows that name a sub-mission or work item name one in this mission. */
  const requireRoutedWork = (missionId: MissionId, routes: ReadonlyArray<ApprovalRoute>) =>
    Effect.forEach(
      routes,
      (route) =>
        Effect.gen(function* () {
          const { subMissionId, workItemId } = route.match;
          if (subMissionId !== undefined) {
            const found = yield* store.get("sub-mission", subMissionId);
            if (Option.isNone(found) || found.value.missionId !== missionId) {
              return yield* fail(
                "invalid",
                `Route ${route.id}: no sub-mission ${subMissionId} in mission ${missionId}.`,
              );
            }
          }
          if (workItemId !== undefined) {
            const found = yield* store.get("work-item", workItemId);
            if (Option.isNone(found) || found.value.missionId !== missionId) {
              return yield* fail(
                "invalid",
                `Route ${route.id}: no work item ${workItemId} in mission ${missionId}.`,
              );
            }
          }
        }),
      { discard: true },
    );

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
        // Only read the mission's items when a row routes by them.
        const work = routesByWork(mission.approvalRouting)
          ? approvalWork(input.links, yield* store.list("work-item", { missionId: mission.id }))
          : { subMissionId: null, workItemId: null };
        const route = routeApprover(mission.approvalRouting, {
          _tag: "approval",
          kind: input.kind,
          repository: repositoryOf(input.links),
          ...work,
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
          // ardud missions: asks
          ...(yield* cleanAnnotation({ summary: null, flags: [] }, input)),
          ...(input.view === undefined ? {} : { view: input.view }),
        };
        return yield* commit(provenance, {
          missionId: mission.id,
          kind: "approval.opened",
          summary: `${input.requestedBy} asks the ${route.approver}: ${record.title}`,
          ref: approvalRef(record),
          upserts: [{ _tag: "approval", record }],
          payload: {
            approver: route.approver,
            routeId: route.routeId,
            ...(work.subMissionId === null ? {} : { subMissionId: work.subMissionId }),
            ...(work.workItemId === null ? {} : { workItemId: work.workItemId }),
          },
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
        const owner = isOwnerProvenance(provenance);
        const condition = input.onOwnerCondition ?? null;
        if (condition !== null) {
          if (owner) {
            return yield* fail(
              "invalid",
              "The owner decides directly; owner conditions are for the master.",
            );
          }
          if (!(yield* isMasterOf(store, before.missionId, provenance))) {
            return yield* fail(
              "forbidden",
              `Only mission ${before.missionId}'s master decides on the owner's condition.`,
            );
          }
          yield* conditions.verify({ subject: approvalRef(before), condition });
        }
        const allowed =
          owner ||
          condition !== null ||
          (approver === "master" && (yield* isMasterOf(store, before.missionId, provenance)));
        if (!allowed) {
          return yield* fail(
            approver === "owner" ? "provenance-required" : "forbidden",
            approver === "owner"
              ? `Approval ${before.id} is routed to the owner.`
              : `Only the owner or mission ${before.missionId}'s master decides approval ${before.id}.`,
          );
        }
        const decidedAt = yield* nowIso;
        // The owner's note stays on the approval as a comment, saved with the
        // decision. Whoever acts reads decisionNote, so it carries every comment
        // he left on the approval, not only this note.
        const subject = { kind: "approval" as const, id: before.id };
        const noteBody = owner ? ((yield* decisionNoteOf(input.note, provenance)) ?? "") : "";
        const mark =
          noteBody === ""
            ? null
            : withComment(
                yield* store.get("inbox-mark", markIdOf(subject)),
                subject,
                before.missionId,
                {
                  id: `comment-${NodeCrypto.randomUUID()}`,
                  body: noteBody,
                  at: decidedAt,
                },
              );
        const comments = mark?.comments ?? (yield* commentsOn(store, subject));
        const commented = owner && comments.length > 0;
        const masterNote = owner ? "" : (input.note?.trim() ?? "");
        const said = [...comments.map((comment) => comment.body), masterNote].filter(
          (line) => line !== "",
        );
        const decisionNote = said.length > 0 ? said.join("\n") : (input.note ?? null);
        const record: Approval = {
          ...before,
          status: input.action === "approve" ? "approved" : "rejected",
          decidedBy: provenance,
          decidedAt,
          decisionNote,
          ...(condition === null ? {} : { onOwnerCondition: condition }),
        };
        const verb = input.action === "approve" ? "Approved" : "Rejected";
        return yield* commit(provenance, {
          missionId: before.missionId,
          kind: "approval.decided",
          summary:
            condition === null
              ? `${verb}: ${record.title}`
              : `${verb} on the owner's condition: ${record.title}`,
          ref: approvalRef(record),
          upserts: [
            { _tag: "approval", record },
            ...(mark === null ? [] : [{ _tag: "inbox-mark" as const, record: mark }]),
          ],
          payload: {
            action: input.action,
            approver,
            note: input.note ?? null,
            onOwnerCondition: condition,
            ...(mark === null ? {} : { commentId: mark.comments.at(-1)?.id ?? null }),
            ...(commented ? { commented: true } : {}),
          },
        });
      }),
    ).pipe(
      Effect.tap((result) =>
        settleDiscussion(
          conditions,
          result.ref,
          `${input.action === "approve" ? "Approved" : "Rejected"}${
            input.onOwnerCondition === undefined ? "" : " on your condition"
          }${input.note === undefined || input.note.trim() === "" ? "." : `: ${input.note.trim()}`}`,
        ),
      ),
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
        yield* requireRoutedWork(mission.id, input.routes);
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

  // ardud missions: asks
  /** Owner or master: set the summary and flag chips on a pending approval. */
  const annotateApproval = (provenance: MissionProvenance, input: AnnotateApprovalInput) =>
    serial(
      Effect.gen(function* () {
        const before = yield* loadApproval(input.approvalId);
        yield* requireOwnerOrMaster(before.missionId, provenance, "annotate an approval");
        if (before.status !== "pending") {
          return yield* fail("conflict", `Approval ${before.id} is ${before.status}, not pending.`);
        }
        const previous = { summary: before.summary ?? null, flags: before.flags ?? [] };
        const next = yield* cleanAnnotation(previous, input);
        if (sameAnnotation(previous, next)) {
          return yield* unchanged(before.missionId, approvalRef(before));
        }
        const record: Approval = { ...before, summary: next.summary, flags: next.flags };
        const chips = next.flags.length > 0 ? ` [${next.flags.join(", ")}]` : "";
        return yield* commit(provenance, {
          missionId: before.missionId,
          kind: "approval.annotated",
          summary: `Annotated: ${record.title}${chips}`,
          ref: approvalRef(record),
          upserts: [{ _tag: "approval", record }],
          payload: { summary: next.summary, flags: next.flags, previous },
        });
      }),
    );

  return {
    openApproval,
    closeStaleApproval,
    decideApproval,
    routeApproval,
    setApprovalRouting,
    annotateApproval,
  };
};
