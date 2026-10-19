import {
  approverOf,
  type Approval,
  type ApprovalRoute,
  type ApprovalRouteMatch,
  type Approver,
  type Draft,
  type DraftChannel,
  type MissionId,
  type MissionLink,
  type SetApprovalRoutingInput,
} from "@t3tools/contracts";

import type { ApprovalRoutingTable, RerouteRecordInput } from "./source.ts";

// Approval routing: every draft and approval gets an approver (owner or
// master) when it is created, from the mission's routing table. The first
// matching row wins and no match goes to the owner, the same rule the server
// applies. The owner and the master edit the table the same way, and the
// owner can always decide anything, whoever it is routed to.

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

export const APPROVER_LABEL: Record<Approver, string> = { owner: "you", master: "master" };

const sameText = (left: string, right: string | null) =>
  right !== null && left.trim().toLowerCase() === right.trim().toLowerCase();

const GITHUB_PULL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\//i;
const PR_KEY = /^([\w.-]+\/[\w.-]+)#\d+$/;

/** `owner/repo` from the first pull-request link: a label like `owner/repo#12`, or a GitHub URL. */
export function approvalRepository(approval: { readonly links: ReadonlyArray<MissionLink> }) {
  for (const link of approval.links) {
    if (link.kind !== "pull-request") continue;
    const fromLabel = PR_KEY.exec(link.label)?.[1];
    if (fromLabel !== undefined) return fromLabel;
    const fromUrl = link.url === null ? undefined : GITHUB_PULL.exec(link.url)?.[1];
    if (fromUrl !== undefined) return fromUrl;
  }
  return null;
}

function matches(
  match: ApprovalRouteMatch,
  subject:
    | { readonly kind: "draft"; readonly draft: Pick<Draft, "audience" | "channel"> }
    | { readonly kind: "approval"; readonly approval: Pick<Approval, "kind" | "links"> },
): boolean {
  if (match._tag === "approval") {
    if (subject.kind !== "approval") return false;
    if (match.kind !== undefined && match.kind !== subject.approval.kind) return false;
    return (
      match.repository === undefined ||
      sameText(match.repository, approvalRepository(subject.approval))
    );
  }
  if (subject.kind !== "draft") return false;
  const { draft } = subject;
  if (match.channel !== undefined && match.channel !== draft.channel) return false;
  if (match.audience !== undefined && !sameText(match.audience, draft.audience)) return false;
  return match.person === undefined || sameText(match.person, draft.audience);
}

export interface RouteHit {
  readonly approver: Approver;
  /** The row that matched, `null` when none did and the record went to the owner. */
  readonly routeId: string | null;
}

const hit = (row: ApprovalRoute | undefined): RouteHit =>
  row === undefined
    ? { approver: "owner", routeId: null }
    : { approver: row.approver, routeId: row.id };

/** The approver for a new draft: the first matching row, or the owner. */
export function routeDraft(
  table: { readonly routes: ReadonlyArray<ApprovalRoute> } | null,
  draft: Pick<Draft, "audience" | "channel">,
): RouteHit {
  return hit(table?.routes.find((row) => matches(row.match, { kind: "draft", draft })));
}

/** The approver for a new approval: the first matching row, or the owner. */
export function routeApproval(
  table: { readonly routes: ReadonlyArray<ApprovalRoute> } | null,
  approval: Pick<Approval, "kind" | "links">,
): RouteHit {
  return hit(table?.routes.find((row) => matches(row.match, { kind: "approval", approval })));
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

/** "drafts to Pavan on Cliq", "merge approvals in owner/repo", "all approvals". */
export function routeMatchLabel(match: ApprovalRouteMatch): string {
  if (match._tag === "approval") {
    const kind = match.kind === undefined ? "approvals" : `${match.kind} approvals`;
    const scope = match.repository === undefined ? "" : ` in ${match.repository}`;
    return match.kind === undefined && match.repository === undefined
      ? "all approvals"
      : `${kind}${scope}`;
  }
  const to = match.person ?? match.audience;
  const parts = [
    to === undefined ? null : `to ${to}`,
    match.channel === undefined ? null : `on ${DRAFT_CHANNEL_NAME[match.channel]}`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "all drafts" : `drafts ${parts.join(" ")}`;
}

/** The reason a record was moved to its inbox, when someone moved it. */
export function routeLine(record: Pick<Draft, "routeNote">): string | null {
  const note = record.routeNote?.trim();
  return note ? note : null;
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

export function routedTo<T extends { readonly approver?: Approver | undefined }>(
  records: ReadonlyArray<T>,
  filter: InboxRouteFilter,
): T[] {
  return records.filter((record) => approverOf(record) === filter);
}

/** Suggestions land in their acceptor's inbox; the master may decide any of them. */
export function suggestionsFor<T extends { readonly acceptor: Approver }>(
  suggestions: ReadonlyArray<T>,
  filter: InboxRouteFilter,
): T[] {
  return suggestions.filter((suggestion) => suggestion.acceptor === filter);
}

/** "Waiting on you" or "Waiting on master. You can still decide it." */
export function decideLine(record: { readonly approver?: Approver | undefined }): string {
  return approverOf(record) === "owner"
    ? "Waiting on you"
    : "Waiting on master. You can still decide it.";
}

/** Builds a move to the other inbox. The reason is required and kept on the record. */
export function rerouteRecordInput(
  kind: RerouteRecordInput["kind"],
  record: { readonly id: string; readonly approver?: Approver | undefined },
  to: Approver,
  reason: string,
): Result<RerouteRecordInput> {
  const why = reason.trim();
  if (why === "") return err("Say why it should move.");
  if (approverOf(record) === to) return err(`It is already routed to ${APPROVER_LABEL[to]}.`);
  return ok({ kind, id: record.id, approver: to, reason: why });
}

// --- Table editing -----------------------------------------------------------

export interface RoutingRow {
  readonly id: string;
  readonly label: string;
  readonly approver: Approver;
}

/** A mission with no table yet: everything goes to the owner until the first row. */
export function emptyRoutingTable(missionId: MissionId): ApprovalRoutingTable {
  return { missionId, routes: [], updatedAt: "", changes: [] };
}

/** Rows in the order they apply; the first match wins. */
export function routingRows(table: Pick<ApprovalRoutingTable, "routes">): RoutingRow[] {
  return table.routes.map((row) => ({
    id: row.id,
    label: routeMatchLabel(row.match),
    approver: row.approver,
  }));
}

const lower = (value: string | undefined) => value?.trim().toLowerCase() ?? "";

/** One key per thing a row can match, so two rows never fight over it. */
export function routeMatchKey(match: ApprovalRouteMatch): string {
  return match._tag === "approval"
    ? `approval|${match.kind ?? ""}|${lower(match.repository)}`
    : `draft|${match.channel ?? ""}|${lower(match.audience)}|${lower(match.person)}`;
}

const isNarrow = (match: ApprovalRouteMatch) =>
  match._tag === "approval" ? match.repository !== undefined : match.person !== undefined;

function normalizeMatch(match: ApprovalRouteMatch): Result<ApprovalRouteMatch> {
  if (match._tag === "approval") {
    if (match.repository === undefined) return ok(match);
    const repository = match.repository.trim();
    return repository
      ? ok({ ...match, repository })
      : err<ApprovalRouteMatch>("Name the repository.");
  }
  if (match.person === undefined) return ok(match);
  const person = match.person.trim();
  return person ? ok({ ...match, person }) : err<ApprovalRouteMatch>("Name the person.");
}

const routingInput = (
  table: Pick<ApprovalRoutingTable, "missionId">,
  routes: ReadonlyArray<ApprovalRoute>,
): SetApprovalRoutingInput => ({ missionId: table.missionId, routes: [...routes] });

/**
 * Sets the approver for one match: changes the row that already matches it, or
 * adds one. A row for a person or a repository goes first so it beats the
 * broader rows; any other new row goes last.
 */
export function setRouteInput(
  table: Pick<ApprovalRoutingTable, "missionId" | "routes">,
  match: ApprovalRouteMatch,
  approver: Approver,
  newId: () => string,
): Result<SetApprovalRoutingInput> {
  const normalized = normalizeMatch(match);
  if (!normalized.ok) return normalized;
  const key = routeMatchKey(normalized.value);
  const index = table.routes.findIndex((row) => routeMatchKey(row.match) === key);
  if (index >= 0) {
    return ok(
      routingInput(
        table,
        table.routes.map((row, i) => (i === index ? { ...row, approver } : row)),
      ),
    );
  }
  const row: ApprovalRoute = { id: newId(), match: normalized.value, approver };
  return ok(
    routingInput(
      table,
      isNarrow(normalized.value) ? [row, ...table.routes] : [...table.routes, row],
    ),
  );
}

/** Flips one row to the other approver. */
export function flipRouteInput(
  table: Pick<ApprovalRoutingTable, "missionId" | "routes">,
  routeId: string,
): Result<SetApprovalRoutingInput> {
  if (!table.routes.some((row) => row.id === routeId)) return err("That row is not in the table.");
  return ok(
    routingInput(
      table,
      table.routes.map((row) =>
        row.id === routeId
          ? { ...row, approver: row.approver === "owner" ? "master" : "owner" }
          : row,
      ),
    ),
  );
}

/** Removes a row; records it would have matched fall back to the next row or the owner. */
export function removeRouteInput(
  table: Pick<ApprovalRoutingTable, "missionId" | "routes">,
  routeId: string,
): Result<SetApprovalRoutingInput> {
  const routes = table.routes.filter((row) => row.id !== routeId);
  if (routes.length === table.routes.length) return err("That row is not in the table.");
  return ok(routingInput(table, routes));
}

/** Re-routes a list as a table change would, for a preview only; existing records never move. */
export function previewRouting(
  table: { readonly routes: ReadonlyArray<ApprovalRoute> },
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

/** Pending records newest first, for the routing screen's preview list. */
export function pendingRouted(
  drafts: ReadonlyArray<Draft>,
  approvals: ReadonlyArray<Approval>,
): ReadonlyArray<
  | { readonly kind: "draft"; readonly record: Draft }
  | { readonly kind: "approval"; readonly record: Approval }
> {
  return [
    ...drafts.map((record) => ({ kind: "draft" as const, record })),
    ...approvals.map((record) => ({ kind: "approval" as const, record })),
  ].sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt));
}
