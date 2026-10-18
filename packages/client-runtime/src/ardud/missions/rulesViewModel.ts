import type {
  Lane,
  MissionId,
  Rule,
  RuleChangeRequest,
  RuleChangeRequestId,
  RuleScope,
  SubMission,
  Suggestion,
  UpsertRuleInput,
} from "@t3tools/contracts";

import { changeIndex, lastChangedLine } from "./changeLog.ts";
import type {
  FieldChange,
  MissionRuleBook,
  ResolveRuleChangeInput,
  RuleAuditFinding,
} from "./source.ts";
import { actorLabel } from "./viewModel.ts";

// Rules tab: each rule with the owner's quote, the master's reading, scope,
// activation, per-lane acks, use counts, change requests and audit findings.
// The owner and the master edit rules the same way; the screen says who
// changed each part last.

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

export interface RuleAckView {
  /** Lanes in scope that acked the current version. */
  readonly acked: ReadonlyArray<string>;
  /** Lanes in scope that have not acked it yet. */
  readonly missing: ReadonlyArray<string>;
  /** "5 of 5 lanes acked", "3 of 8 lanes acked", or null for a mission-wide rule. */
  readonly line: string | null;
}

const laneName = (laneId: string) => laneId.replace(/^lane-/, "");

/** Acks are counted per lane in the rule's lane scope, for the rule's current version. */
export function ruleAcks(rule: Rule): RuleAckView {
  const current = new Set(
    rule.acks
      .filter((ack) => ack.version === rule.version && ack.actor._tag === "lane")
      .map((ack) => (ack.actor._tag === "lane" ? (ack.actor.laneId as string) : "")),
  );
  if (rule.scope.laneIds.length === 0) {
    return { acked: [...current].map(laneName), missing: [], line: null };
  }
  const acked = rule.scope.laneIds.filter((id) => current.has(id)).map(laneName);
  const missing = rule.scope.laneIds.filter((id) => !current.has(id)).map(laneName);
  return {
    acked,
    missing,
    line: `${acked.length} of ${rule.scope.laneIds.length} ${rule.scope.laneIds.length === 1 ? "lane" : "lanes"} acked`,
  };
}

/** "Whole mission", or "Lanes: cell-bo, cell-fab-svc · Sub-missions: Releases". */
export function scopeLine(
  scope: RuleScope,
  subMissions: ReadonlyArray<Pick<SubMission, "id" | "title">> = [],
): string {
  const titles = new Map(subMissions.map((sub) => [sub.id as string, sub.title]));
  const parts = [
    scope.subMissionIds.length > 0
      ? `Sub-missions: ${scope.subMissionIds.map((id) => titles.get(id) ?? id).join(", ")}`
      : null,
    scope.roleKinds.length > 0 ? `Roles: ${scope.roleKinds.join(", ")}` : null,
    scope.laneIds.length > 0 ? `Lanes: ${scope.laneIds.map(laneName).join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Whole mission" : parts.join(" · ");
}

export function activationLine(rule: Pick<Rule, "activation">): string {
  return rule.activation.trim() || "Always on";
}

/** "Used 149 times, broken twice", "Not used yet". */
export function useLine(rule: Pick<Rule, "appliedCount" | "brokenCount">): string {
  const times = (count: number) =>
    count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
  if (rule.appliedCount === 0 && rule.brokenCount === 0) return "Not used yet";
  const used = rule.appliedCount > 0 ? `Used ${times(rule.appliedCount)}` : "Never used";
  return rule.brokenCount > 0 ? `${used}, broken ${times(rule.brokenCount)}` : used;
}

export const RULE_FIELDS = ["quote", "scope", "activation", "status"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export interface RuleRow {
  readonly rule: Rule;
  readonly acks: RuleAckView;
  readonly scope: string;
  readonly activation: string;
  readonly use: string;
  readonly changeRequests: {
    readonly open: ReadonlyArray<RuleChangeRequest>;
    readonly resolved: ReadonlyArray<RuleChangeRequest>;
  };
  readonly audit: ReadonlyArray<RuleAuditFinding>;
  readonly suggestions: ReadonlyArray<Suggestion>;
  /** "last changed by you" per field that has a recorded change. */
  readonly changedBy: Partial<Record<RuleField, string>>;
}

export interface RuleBookView {
  /** Active rules: open change requests or audit findings first, then by number. */
  readonly active: ReadonlyArray<RuleRow>;
  readonly retired: ReadonlyArray<RuleRow>;
  /** Mission-level counts for the tab header. */
  readonly openChangeRequests: number;
  readonly auditFindings: number;
  readonly openSuggestions: number;
}

const byNumber = (left: Rule, right: Rule) =>
  (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER) ||
  left.title.localeCompare(right.title);

function fieldChanges(
  rule: Rule,
  lookup: (ref: { kind: "rule"; id: string }, field: string) => FieldChange | null,
  masterRoleId: string | null,
) {
  const changedBy: Partial<Record<RuleField, string>> = {};
  for (const field of RULE_FIELDS) {
    const line = lastChangedLine(lookup({ kind: "rule", id: rule.id }, field), masterRoleId);
    if (line) changedBy[field] = line;
  }
  return changedBy;
}

export function ruleBookView(
  book: MissionRuleBook,
  masterRoleId: string | null,
  subMissions: ReadonlyArray<Pick<SubMission, "id" | "title">> = [],
): RuleBookView {
  const lookup = changeIndex(book.changes);
  const rows = [...book.rules].sort(byNumber).map((rule): RuleRow => {
    const requests = book.changeRequests.filter((request) => request.ruleId === rule.id);
    return {
      rule,
      acks: ruleAcks(rule),
      scope: scopeLine(rule.scope, subMissions),
      activation: activationLine(rule),
      use: useLine(rule),
      changeRequests: {
        open: requests.filter((request) => request.status === "open"),
        resolved: requests.filter((request) => request.status !== "open"),
      },
      audit: book.audit.filter((finding) => finding.ruleIds.includes(rule.id)),
      suggestions: book.suggestions.filter(
        (suggestion) => suggestion.target?.kind === "rule" && suggestion.target.id === rule.id,
      ),
      changedBy: fieldChanges(rule, lookup, masterRoleId),
    };
  });
  const needsLook = (row: RuleRow) =>
    row.changeRequests.open.length > 0 || row.audit.length > 0 || row.suggestions.length > 0;
  const active = rows.filter((row) => row.rule.status === "active");
  return {
    active: [...active.filter(needsLook), ...active.filter((row) => !needsLook(row))],
    retired: rows.filter((row) => row.rule.status === "retired"),
    openChangeRequests: book.changeRequests.filter((request) => request.status === "open").length,
    auditFindings: book.audit.length,
    openSuggestions: book.suggestions.length,
  };
}

export const CHANGE_REQUEST_STATUS_LABEL: Record<RuleChangeRequest["status"], string> = {
  open: "Open",
  applied: "Applied",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

export const AUDIT_KIND_LABEL: Record<RuleAuditFinding["kind"], string> = {
  conflict: "Conflict",
  stale: "Stale",
};

/** "Conflict with rule 89: ..." for a finding seen from one of its rules. */
export function auditLine(
  finding: RuleAuditFinding,
  fromRuleId: string,
  rules: ReadonlyArray<Pick<Rule, "id" | "number" | "title">>,
  masterRoleId: string | null,
): string {
  const others = finding.ruleIds
    .filter((id) => id !== fromRuleId)
    .map((id) => {
      const rule = rules.find((candidate) => candidate.id === id);
      return rule?.number ? `rule ${rule.number}` : (rule?.title ?? id);
    });
  const head =
    others.length > 0
      ? `${AUDIT_KIND_LABEL[finding.kind]} with ${others.join(", ")}`
      : AUDIT_KIND_LABEL[finding.kind];
  return `${head}: ${finding.note} (${actorLabel(finding.foundBy, masterRoleId)})`;
}

/** Edit any part of an existing rule. Unchanged fields stay as they are. */
export function editRuleInput(
  rule: Rule,
  edit: {
    readonly title?: string;
    readonly quote?: string;
    readonly scope?: RuleScope;
    readonly activation?: string;
  },
): Result<UpsertRuleInput> {
  const title = (edit.title ?? rule.title).trim();
  const quote = (edit.quote ?? rule.quote).trim();
  if (!title) return err("A rule needs a title.");
  if (!quote) return err("A rule needs its wording.");
  return ok({
    ruleId: rule.id,
    missionId: rule.missionId,
    title,
    quote,
    scope: edit.scope ?? rule.scope,
    activation: (edit.activation ?? rule.activation).trim(),
    status: rule.status,
  });
}

export function newRuleInput(
  missionId: MissionId | null,
  title: string,
  quote: string,
): Result<UpsertRuleInput> {
  if (!title.trim()) return err("A rule needs a title.");
  if (!quote.trim()) return err("A rule needs its wording.");
  return ok({ missionId, title: title.trim(), quote: quote.trim() });
}

/** Retire an active rule, or bring a retired one back. */
export function setRuleStatusInput(rule: Rule): UpsertRuleInput {
  return {
    ruleId: rule.id,
    missionId: rule.missionId,
    title: rule.title,
    quote: rule.quote,
    status: rule.status === "active" ? "retired" : "active",
  };
}

export function resolveRuleChangeInput(
  changeRequestId: RuleChangeRequestId,
  action: "apply" | "decline",
  response: string,
): Result<ResolveRuleChangeInput> {
  const trimmed = response.trim();
  if (action === "decline" && !trimmed) return err("Say why the change is declined.");
  return ok({ changeRequestId, action, response: trimmed });
}

/** Lanes a scope can name, for the scope picker. Retired lanes are left out. */
export function scopeLaneChoices(lanes: ReadonlyArray<Lane>): Lane[] {
  return lanes
    .filter((lane) => lane.status !== "retired")
    .sort((left, right) => left.name.localeCompare(right.name));
}
