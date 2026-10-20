import type {
  Lane,
  MissionId,
  ResolveRuleChangeInput,
  Rule,
  RuleChangeRequest,
  RuleChangeRequestId,
  RuleId,
  RuleScope,
  SubMission,
  Suggestion,
  UpsertRuleInput,
} from "@t3tools/contracts";

import { changeIndex, lastChangedLine } from "./changeLog.ts";
import { type ActorNames, actorName, whenLabel } from "./roomsViewModel.ts";
import type {
  FieldChange,
  MissionRuleBook,
  MissionTimelineEvent,
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

/** One element per scoped kind ("Sub-missions: Releases", "Lanes: cell-bo"); empty for the whole mission. */
export function scopeParts(
  scope: RuleScope,
  subMissions: ReadonlyArray<Pick<SubMission, "id" | "title">> = [],
): string[] {
  const titles = new Map(subMissions.map((sub) => [sub.id as string, sub.title]));
  return [
    scope.subMissionIds.length > 0
      ? `Sub-missions: ${scope.subMissionIds.map((id) => titles.get(id) ?? id).join(", ")}`
      : null,
    scope.roleKinds.length > 0 ? `Roles: ${scope.roleKinds.join(", ")}` : null,
    scope.laneIds.length > 0 ? `Lanes: ${scope.laneIds.map(laneName).join(", ")}` : null,
  ].filter((part): part is string => part !== null);
}

/** "Whole mission", or "Lanes: cell-bo, cell-fab-svc · Sub-missions: Releases". */
export function scopeLine(
  scope: RuleScope,
  subMissions: ReadonlyArray<Pick<SubMission, "id" | "title">> = [],
): string {
  const parts = scopeParts(scope, subMissions);
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

export const RULE_FIELDS = ["quote", "scope", "activation", "status", "masterReading"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export interface RuleRow {
  readonly rule: Rule;
  readonly acks: RuleAckView;
  readonly scope: string;
  /** The scope as separate elements; empty for the whole mission. */
  readonly scopeParts: ReadonlyArray<string>;
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
      scopeParts: scopeParts(rule.scope, subMissions),
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
  broken: "Broken",
  reading: "Old reading",
  acks: "Old acks",
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

/**
 * Rewrite how the master reads the rule. The owner's quote stays as it is.
 * Saving an unchanged reading confirms it for a reworded rule.
 */
export function editReadingInput(rule: Rule, reading: string): Result<UpsertRuleInput> {
  const masterReading = reading.trim();
  // --- finish-b ---
  const stale = rule.readingVersion !== undefined && rule.readingVersion < rule.version;
  if (masterReading === rule.masterReading.trim() && !stale) {
    return err("The reading is unchanged.");
  }
  return ok({
    ruleId: rule.id,
    missionId: rule.missionId,
    title: rule.title,
    quote: rule.quote,
    masterReading,
  });
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
  return ok({
    requestId: changeRequestId,
    status: action === "apply" ? "applied" : "declined",
    response: trimmed,
  });
}

/** Lanes a scope can name, for the scope picker. Retired lanes are left out. */
export function scopeLaneChoices(lanes: ReadonlyArray<Lane>): Lane[] {
  return lanes
    .filter((lane) => lane.status !== "retired")
    .sort((left, right) => left.name.localeCompare(right.name));
}

// ---------------------------------------------------------------------------
// Desk page

/** "Rule 104", or "Rule" for one without imported numbering. */
export const ruleLabel = (rule: Pick<Rule, "number">) =>
  rule.number === null ? "Rule" : `Rule ${rule.number}`;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** "5 lanes", "Releases, 2 lanes", "All lanes". */
export function scopeShort(
  scope: RuleScope,
  subMissions: ReadonlyArray<Pick<SubMission, "id" | "title">> = [],
): string {
  const titles = new Map(subMissions.map((sub) => [sub.id as string, sub.title]));
  const parts = [
    scope.subMissionIds.length === 1
      ? (titles.get(scope.subMissionIds[0] as string) ?? "1 sub-mission")
      : scope.subMissionIds.length > 1
        ? plural(scope.subMissionIds.length, "sub-mission")
        : null,
    scope.roleKinds.length > 0 ? plural(scope.roleKinds.length, "role kind") : null,
    scope.laneIds.length > 0 ? plural(scope.laneIds.length, "lane") : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "All lanes" : parts.join(", ");
}

const otherRules = (
  finding: RuleAuditFinding,
  fromRuleId: string,
  rules: ReadonlyArray<Pick<Rule, "id" | "number" | "title">>,
) =>
  finding.ruleIds
    .filter((id) => id !== fromRuleId)
    .map((id) => {
      const rule = rules.find((candidate) => candidate.id === id);
      return rule?.number ? `rule ${rule.number}` : (rule?.title ?? id);
    })
    .join(", ");

/** The problem a list row shows in amber, or null: "Conflicts with rule 89." */
export function ruleProblem(
  row: Pick<RuleRow, "rule" | "audit" | "changeRequests" | "suggestions">,
  rules: ReadonlyArray<Pick<Rule, "id" | "number" | "title">>,
): string | null {
  const finding = row.audit[0];
  if (finding && COMPUTED_AUDIT_KINDS.has(finding.kind)) return finding.note;
  if (finding) {
    const others = otherRules(finding, row.rule.id, rules);
    const verb = finding.kind === "conflict" ? "Conflicts with" : "Stale against";
    return others ? `${verb} ${others}.` : `${AUDIT_KIND_LABEL[finding.kind]}.`;
  }
  if (row.changeRequests.open.length > 0) return "Change requested.";
  if (row.suggestions.length > 0) return "Change suggested.";
  return null;
}

export interface RuleListItem {
  readonly row: RuleRow;
  /** When a lane or the master last relied on it, for the right-hand column. */
  readonly lastRelied: string | null;
  /** "5 lanes, 5 of 5 acked. Used twice." */
  readonly line: string;
  readonly problem: string | null;
}

/** Active rules relied on most recently first; never-used ones after, by number. */
export function ruleList(
  view: RuleBookView,
  subMissions: ReadonlyArray<Pick<SubMission, "id" | "title">> = [],
): ReadonlyArray<RuleListItem> {
  const rules = [...view.active, ...view.retired].map((row) => row.rule);
  return [...view.active]
    .sort(
      (left, right) =>
        (right.rule.lastReliedAt ?? "").localeCompare(left.rule.lastReliedAt ?? "") ||
        byNumber(left.rule, right.rule),
    )
    .map((row) => {
      const acked =
        row.acks.line === null
          ? ""
          : `, ${row.acks.acked.length} of ${row.acks.acked.length + row.acks.missing.length} acked`;
      return {
        row,
        lastRelied: row.rule.lastReliedAt,
        line: `${scopeShort(row.rule.scope, subMissions)}${acked}. ${row.use}.`,
        problem: ruleProblem(row, rules),
      };
    });
}

/** "Rule 10 stale against rule 98", the title of an audit card. */
export function auditTitle(
  finding: RuleAuditFinding,
  rules: ReadonlyArray<Pick<Rule, "id" | "number" | "title">>,
): string {
  const [first, ...rest] = finding.ruleIds.map((id) => {
    const rule = rules.find((candidate) => candidate.id === id);
    return rule?.number ? `rule ${rule.number}` : (rule?.title ?? id);
  });
  const head = first ? first.charAt(0).toUpperCase() + first.slice(1) : "A rule";
  if (rest.length === 0) return `${head} ${finding.kind === "conflict" ? "conflicts" : "is stale"}`;
  return `${head} ${finding.kind === "conflict" ? "conflicts with" : "stale against"} ${rest.join(", ")}`;
}

/** Who wrote the quote: "You", "Master", "Imported from STANDING-RULES". */
export function quoteAuthor(rule: Pick<Rule, "provenance">, masterRoleId: string | null): string {
  const provenance = rule.provenance;
  switch (provenance._tag) {
    case "owner-app":
    case "owner-imessage":
      return "You";
    case "agent":
      return provenance.roleId !== null && provenance.roleId === masterRoleId
        ? "Master"
        : "An agent";
    case "system":
      return provenance.component;
    case "import":
      return `Imported from ${provenance.source}`;
  }
}

export interface RuleFact {
  readonly label: string;
  readonly value: string;
}

/** The record's facts row: Scope, Used, When, Last relied on. */
export function ruleFacts(
  row: RuleRow,
  nowMs: number,
  subMissions: ReadonlyArray<Pick<SubMission, "id" | "title">> = [],
  timeZone?: string,
): ReadonlyArray<RuleFact> {
  const facts: RuleFact[] = [
    { label: "Scope", value: scopeShort(row.rule.scope, subMissions) },
    { label: "Used", value: row.use },
    { label: "When", value: row.activation },
  ];
  if (row.rule.lastReliedAt) {
    facts.push({
      label: "Last relied on",
      value: whenLabel(row.rule.lastReliedAt, nowMs, timeZone),
    });
  }
  return facts;
}

export interface RuleAckChip {
  readonly key: string;
  readonly name: string;
  readonly at: string;
}

export interface RuleAckList {
  /** "Acknowledged by 5 of 5", "Acknowledged by 3". */
  readonly line: string;
  readonly chips: ReadonlyArray<RuleAckChip>;
  /** Lanes in scope still to ack the current version. */
  readonly missing: ReadonlyArray<string>;
}

/** Who acked the current version, with names, or null when nobody has to. */
export function ruleAckList(
  rule: Rule,
  masterRoleId: string | null,
  names?: ActorNames,
): RuleAckList | null {
  const current = rule.acks.filter((ack) => ack.version === rule.version);
  const name = (laneId: string) => names?.[`lane:${laneId}`] ?? laneName(laneId);
  const chips = current.map((ack) => ({
    key: `${ack.actor._tag}:${ack.at}:${actorName(ack.actor, masterRoleId, names)}`,
    name: actorName(ack.actor, masterRoleId, names),
    at: ack.at,
  }));
  const scoped = rule.scope.laneIds.length;
  if (scoped === 0 && chips.length === 0) return null;
  const ackedLanes = new Set(
    current.flatMap((ack) => (ack.actor._tag === "lane" ? [ack.actor.laneId as string] : [])),
  );
  return {
    line:
      scoped > 0
        ? `Acknowledged by ${rule.scope.laneIds.filter((id) => ackedLanes.has(id)).length} of ${scoped}`
        : `Acknowledged by ${chips.length}`,
    chips,
    missing: rule.scope.laneIds.filter((id) => !ackedLanes.has(id)).map((id) => name(id)),
  };
}

export interface RuleUse {
  readonly key: string;
  readonly at: string;
  readonly summary: string;
  readonly by: string;
  readonly broken: boolean;
}

/** The loaded timeline's uses of a rule, newest first. */
export function ruleUses(
  events: ReadonlyArray<MissionTimelineEvent>,
  ruleId: string,
  masterRoleId: string | null,
  names?: ActorNames,
): ReadonlyArray<RuleUse> {
  return events
    .filter(
      (event) =>
        (event.kind === "rule.applied" || event.kind === "rule.broken") &&
        event.subject?.kind === "rule" &&
        event.subject.id === ruleId,
    )
    .map((event) => ({
      key: event.id,
      at: event.at,
      summary: event.summary,
      by: actorName(event.actor, masterRoleId, names),
      broken: event.kind === "rule.broken",
    }));
}

// --- finish-b ---

const COMPUTED_AUDIT_KINDS: ReadonlySet<RuleAuditFinding["kind"]> = new Set([
  "broken",
  "reading",
  "acks",
]);

const AUDIT_ACTOR = { _tag: "system", component: "audit" } as const;

const times = (count: number) => (count === 1 ? "once" : `${count} times`);

/**
 * What the live rule records say needs a look, for active rules only:
 * broken at least as often as relied on, reworded since the master's reading,
 * or acked by a lane on an older version and not yet on this one.
 */
export function ruleAudit(rules: ReadonlyArray<Rule>): RuleAuditFinding[] {
  const findings: RuleAuditFinding[] = [];
  for (const rule of rules) {
    if (rule.status !== "active") continue;
    const at = rule.updatedAt;
    if (rule.brokenCount > 0 && rule.brokenCount >= rule.appliedCount) {
      findings.push({
        id: `broken:${rule.id}`,
        kind: "broken",
        ruleIds: [rule.id],
        note:
          rule.appliedCount === 0
            ? `Broken ${times(rule.brokenCount)}, never relied on.`
            : `Broken ${times(rule.brokenCount)}, relied on ${times(rule.appliedCount)}.`,
        foundBy: AUDIT_ACTOR,
        at: rule.lastReliedAt ?? at,
      });
    }
    if (
      rule.masterReading.trim() !== "" &&
      rule.readingVersion !== undefined &&
      rule.readingVersion < rule.version
    ) {
      findings.push({
        id: `reading:${rule.id}`,
        kind: "reading",
        ruleIds: [rule.id],
        note: "Reworded since the master's reading.",
        foundBy: AUDIT_ACTOR,
        at,
      });
    }
    const current = new Set<string>();
    const old = new Set<string>();
    for (const ack of rule.acks) {
      if (ack.actor._tag !== "lane") continue;
      (ack.version === rule.version ? current : old).add(ack.actor.laneId);
    }
    const behind = [...old].filter((laneId) => !current.has(laneId));
    if (behind.length > 0) {
      findings.push({
        id: `acks:${rule.id}`,
        kind: "acks",
        ruleIds: [rule.id],
        note: `${behind.length === 1 ? "1 lane" : `${behind.length} lanes`} acked an older version.`,
        foundBy: AUDIT_ACTOR,
        at,
      });
    }
  }
  return findings;
}

export interface AuditCard {
  readonly key: string;
  /** "Rule 10 stale against rule 98", "3 rules acked on an older version". */
  readonly title: string;
  /** "Rules 10, 98, 104" for a grouped card; null for a scribe or master finding. */
  readonly line: string | null;
  /** The scribe or master finding behind a single card, for its "Audit by" line. */
  readonly finding: RuleAuditFinding | null;
  /** The rule Review opens. */
  readonly ruleId: RuleId | null;
}

const GROUP_TITLE: Record<"broken" | "reading" | "acks", string> = {
  broken: "broken as often as relied on",
  reading: "reworded since the master's reading",
  acks: "acked on an older version",
};

/** Audit cards: one per scribe or master finding, one per computed kind. */
export function auditCards(
  audit: ReadonlyArray<RuleAuditFinding>,
  rules: ReadonlyArray<Pick<Rule, "id" | "number" | "title">>,
): AuditCard[] {
  const name = (id: RuleId) => {
    const rule = rules.find((candidate) => candidate.id === id);
    return rule?.number ? String(rule.number) : (rule?.title ?? id);
  };
  const cards: AuditCard[] = audit
    .filter((finding) => !COMPUTED_AUDIT_KINDS.has(finding.kind))
    .map((finding) => ({
      key: finding.id,
      title: auditTitle(finding, rules),
      line: null,
      finding,
      ruleId: finding.ruleIds[0] ?? null,
    }));
  for (const kind of ["broken", "reading", "acks"] as const) {
    const ruleIds = audit
      .filter((finding) => finding.kind === kind)
      .flatMap((finding) => finding.ruleIds);
    const first = ruleIds[0];
    if (first === undefined) continue;
    cards.push({
      key: kind,
      title:
        ruleIds.length === 1
          ? `Rule ${name(first)} ${GROUP_TITLE[kind]}`
          : `${ruleIds.length} rules ${GROUP_TITLE[kind]}`,
      line: ruleIds.length === 1 ? null : `Rules ${ruleIds.map(name).join(", ")}`,
      finding: null,
      ruleId: first,
    });
  }
  return cards;
}
// --- end finish-b ---
