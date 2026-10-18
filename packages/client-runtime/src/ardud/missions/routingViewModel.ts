import type { Approval, Draft, DraftChannel, MissionActor } from "@t3tools/contracts";

import type {
  ApprovalRouteMatch,
  ApprovalRoutingTable,
  Approver,
  DraftRouteMatch,
  RouteReason,
  RouteRule,
  Routed,
  RoutedApproval,
  RoutedDraft,
  SetApprovalRoutingInput,
} from "./source.ts";
import { actorLabel } from "./viewModel.ts";

// Approval routing: every draft and approval goes to an approver (owner or
// master) when it is created. The table is edited by either of them the same
// way. The owner can always decide anything, whoever it is routed to.

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

export const APPROVER_LABEL: Record<Approver, string> = { owner: "you", master: "master" };

const sameName = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/** "owner/repo" or "repo" from a pull-request link label like `crpko-devops#759`. */
export function approvalRepository(approval: Pick<Approval, "links">): string | null {
  for (const link of approval.links) {
    if (link.kind !== "pull-request") continue;
    const ref = link.ref ?? link.label;
    const hash = ref.lastIndexOf("#");
    const repo = hash > 0 ? ref.slice(0, hash) : ref;
    return repo.split("/").at(-1) ?? null;
  }
  return null;
}

/**
 * The approver for a new draft. A person rule beats a channel rule; within a
 * kind, the first matching rule wins; no match goes to the owner.
 */
export function routeDraft(
  table: Pick<ApprovalRoutingTable, "draftRules"> | null,
  draft: Pick<Draft, "audience" | "channel">,
): Routed {
  const rules = table?.draftRules ?? [];
  const person = rules.find(
    (r) => r.match._tag === "person" && sameName(r.match.name, draft.audience),
  );
  const channel = rules.find(
    (r) => r.match._tag === "channel" && r.match.channel === draft.channel,
  );
  const hit = person ?? channel;
  return hit
    ? {
        approver: hit.approver,
        route: { _tag: "rule", ruleId: hit.id, label: draftMatchLabel(hit.match) },
      }
    : { approver: "owner", route: { _tag: "fallback" } };
}

/** The approver for a new approval. A repo rule beats a kind rule; no match goes to the owner. */
export function routeApproval(
  table: Pick<ApprovalRoutingTable, "approvalRules"> | null,
  approval: Pick<Approval, "kind" | "links">,
): Routed {
  const rules = table?.approvalRules ?? [];
  const repository = approvalRepository(approval);
  const repo =
    repository === null
      ? undefined
      : rules.find((r) => r.match._tag === "repo" && sameName(r.match.repository, repository));
  const kind = rules.find((r) => r.match._tag === "kind" && r.match.kind === approval.kind);
  const hit = repo ?? kind;
  return hit
    ? {
        approver: hit.approver,
        route: { _tag: "rule", ruleId: hit.id, label: approvalMatchLabel(hit.match) },
      }
    : { approver: "owner", route: { _tag: "fallback" } };
}

/** Moves one record to the other inbox. The reason is required and kept on the route. */
export function reroute<T extends Routed>(
  record: T,
  to: Approver,
  by: MissionActor,
  reason: string,
  at: string,
): Result<T> {
  const why = reason.trim();
  if (why === "") return err("Say why it should move.");
  if (record.approver === to) return err(`It is already routed to ${APPROVER_LABEL[to]}.`);
  return ok({
    ...record,
    approver: to,
    route: { _tag: "rerouted", from: record.approver, by, reason: why, at },
  });
}

const DRAFT_CHANNEL_NAME: Record<DraftChannel, string> = {
  linear: "Linear",
  github: "GitHub",
  cliq: "Cliq",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  email: "email",
  telegram: "Telegram",
  other: "other channels",
};

export function draftMatchLabel(match: DraftRouteMatch): string {
  return match._tag === "person"
    ? `drafts to ${match.name}`
    : `drafts on ${DRAFT_CHANNEL_NAME[match.channel]}`;
}

export function approvalMatchLabel(match: ApprovalRouteMatch): string {
  return match._tag === "repo" ? `approvals in ${match.repository}` : `${match.kind} approvals`;
}

/** One line on why a record sits in its inbox. */
export function routeLine(routed: Routed, masterRoleId: string | null): string {
  const to = APPROVER_LABEL[routed.approver];
  switch (routed.route._tag) {
    case "rule":
      return `Routed to ${to}: ${routed.route.label}`;
    case "fallback":
      return `Routed to ${to}: no rule matched`;
    case "rerouted":
      return `Moved to ${to} by ${actorLabel(routed.route.by, masterRoleId)}: ${routed.route.reason}`;
  }
}

export function isRerouted(
  route: RouteReason,
): route is Extract<RouteReason, { _tag: "rerouted" }> {
  return route._tag === "rerouted";
}

/** Which inbox the owner is looking at. The default shows what is routed to them. */
export type InboxRouteFilter = "owner" | "master";

export const INBOX_ROUTE_FILTER_LABEL: Record<InboxRouteFilter, string> = {
  owner: "Routed to you",
  master: "Routed to master",
};

export function isInboxRouteFilter(value: unknown): value is InboxRouteFilter {
  return value === "owner" || value === "master";
}

export function routedTo<T extends { readonly approver: Approver }>(
  records: ReadonlyArray<T>,
  filter: InboxRouteFilter,
): T[] {
  return records.filter((record) => record.approver === filter);
}

/** Suggestions land in their acceptor's inbox; the master may decide any of them. */
export function suggestionsFor<T extends { readonly acceptor: Approver }>(
  suggestions: ReadonlyArray<T>,
  filter: InboxRouteFilter,
): T[] {
  return suggestions.filter((suggestion) => suggestion.acceptor === filter);
}

/** "Waiting on you" or "Waiting on master; you can still decide it". */
export function decideLine(routed: Pick<Routed, "approver">): string {
  return routed.approver === "owner"
    ? "Waiting on you"
    : "Waiting on master. You can still decide it.";
}

// --- Table editing -----------------------------------------------------------

export interface RoutingRow {
  readonly id: string;
  readonly kind: "draft" | "approval";
  readonly label: string;
  readonly approver: Approver;
}

/** Table rows in the order they apply: person, channel, repo, kind. */
export function routingRows(table: ApprovalRoutingTable): RoutingRow[] {
  const drafts = [...table.draftRules].sort(
    (left, right) => Number(right.match._tag === "person") - Number(left.match._tag === "person"),
  );
  const approvals = [...table.approvalRules].sort(
    (left, right) => Number(right.match._tag === "repo") - Number(left.match._tag === "repo"),
  );
  return [
    ...drafts.map((rule) => ({
      id: rule.id,
      kind: "draft" as const,
      label: draftMatchLabel(rule.match),
      approver: rule.approver,
    })),
    ...approvals.map((rule) => ({
      id: rule.id,
      kind: "approval" as const,
      label: approvalMatchLabel(rule.match),
      approver: rule.approver,
    })),
  ];
}

const matchKey = (match: DraftRouteMatch | ApprovalRouteMatch) => {
  switch (match._tag) {
    case "channel":
      return `channel:${match.channel}`;
    case "person":
      return `person:${match.name.trim().toLowerCase()}`;
    case "kind":
      return `kind:${match.kind}`;
    case "repo":
      return `repo:${match.repository.trim().toLowerCase()}`;
  }
};

function upsertRule<M extends DraftRouteMatch | ApprovalRouteMatch>(
  rules: ReadonlyArray<RouteRule<M>>,
  match: M,
  approver: Approver,
  newId: () => string,
): RouteRule<M>[] {
  const key = matchKey(match);
  const index = rules.findIndex((rule) => matchKey(rule.match) === key);
  if (index < 0) return [...rules, { id: newId(), match, approver }];
  return rules.map((rule, i) => (i === index ? { ...rule, approver } : rule));
}

/** Builds the edit that sets one draft rule (adds it or changes its approver). */
export function setDraftRouteInput(
  table: ApprovalRoutingTable,
  match: DraftRouteMatch,
  approver: Approver,
  newId: () => string,
): Result<SetApprovalRoutingInput> {
  if (match._tag === "person" && match.name.trim() === "") return err("Name the person.");
  const normalized: DraftRouteMatch =
    match._tag === "person" ? { _tag: "person", name: match.name.trim() } : match;
  return ok({
    missionId: table.missionId,
    expectedVersion: table.version,
    draftRules: upsertRule(table.draftRules, normalized, approver, newId),
    approvalRules: table.approvalRules,
  });
}

/** Builds the edit that sets one approval rule. */
export function setApprovalRouteInput(
  table: ApprovalRoutingTable,
  match: ApprovalRouteMatch,
  approver: Approver,
  newId: () => string,
): Result<SetApprovalRoutingInput> {
  if (match._tag === "repo" && match.repository.trim() === "") return err("Name the repository.");
  const normalized: ApprovalRouteMatch =
    match._tag === "repo" ? { _tag: "repo", repository: match.repository.trim() } : match;
  return ok({
    missionId: table.missionId,
    expectedVersion: table.version,
    draftRules: table.draftRules,
    approvalRules: upsertRule(table.approvalRules, normalized, approver, newId),
  });
}

/** Builds the edit that removes a rule; records it would have matched fall back to the owner. */
export function removeRouteInput(
  table: ApprovalRoutingTable,
  ruleId: string,
): Result<SetApprovalRoutingInput> {
  const draftRules = table.draftRules.filter((rule) => rule.id !== ruleId);
  const approvalRules = table.approvalRules.filter((rule) => rule.id !== ruleId);
  if (
    draftRules.length === table.draftRules.length &&
    approvalRules.length === table.approvalRules.length
  ) {
    return err("That rule is not in the table.");
  }
  return ok({
    missionId: table.missionId,
    expectedVersion: table.version,
    draftRules,
    approvalRules,
  });
}

/** Re-routes a list after a table change would, for a preview only; existing records never move. */
export function previewRouting(
  table: Pick<ApprovalRoutingTable, "draftRules" | "approvalRules">,
  drafts: ReadonlyArray<Pick<Draft, "audience" | "channel">>,
  approvals: ReadonlyArray<Pick<Approval, "kind" | "links">>,
): { readonly owner: number; readonly master: number } {
  const approvers = [
    ...drafts.map((draft) => routeDraft(table, draft).approver),
    ...approvals.map((approval) => routeApproval(table, approval).approver),
  ];
  const owner = approvers.filter((approver) => approver === "owner").length;
  return { owner, master: approvers.length - owner };
}

/** Pending records with their routes, newest first, for the routing screen's preview list. */
export function pendingRouted(
  drafts: ReadonlyArray<RoutedDraft>,
  approvals: ReadonlyArray<RoutedApproval>,
): ReadonlyArray<
  | { readonly kind: "draft"; readonly record: RoutedDraft }
  | { readonly kind: "approval"; readonly record: RoutedApproval }
> {
  return [
    ...drafts.map((record) => ({ kind: "draft" as const, record })),
    ...approvals.map((record) => ({ kind: "approval" as const, record })),
  ].sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt));
}
