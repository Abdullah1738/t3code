import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";

import type { MissionId, Rule, RuleChangeRequest, SubMission } from "@t3tools/contracts";
import {
  auditLine,
  CHANGE_REQUEST_STATUS_LABEL,
  formatRelative,
  ruleBookView,
  type RuleRow,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { MetaRow } from "./cards/chips";
import { MutedLines, PairActionForm, TextActionForm } from "./MissionForms";
import { MissionSection } from "./MissionSection";
import { useMasterRoleId, useMissionRuleBook } from "./missionsStore";
import { addRule, editRule, resolveRuleChange, toggleRuleRetired } from "./operationCommands";

// Rules tab, placeholder presentation. The owner and the master edit rules the
// same way; acks, use counts, audit lines and who last changed what come from
// client-runtime (rulesViewModel).

export function RulesTab(props: {
  missionId: MissionId;
  subMissions: ReadonlyArray<SubMission>;
  nowMs: number;
}) {
  const book = useMissionRuleBook(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  const view = useMemo(
    () => (book ? ruleBookView(book, masterRoleId, props.subMissions) : null),
    [book, masterRoleId, props.subMissions],
  );
  const [showRetired, setShowRetired] = useState(false);
  if (!book || !view) return <p className="text-sm text-muted-foreground">Loading rules…</p>;

  const context = {
    rules: book.rules,
    masterRoleId,
    nowMs: props.nowMs,
    missionId: props.missionId,
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-xs text-muted-foreground tabular-nums">
        <MetaRow>
          <span>{`${view.active.length} active`}</span>
          {view.openChangeRequests > 0 ? (
            <span>{`${view.openChangeRequests} open change requests`}</span>
          ) : null}
          {view.auditFindings > 0 ? (
            <span className="text-warning-foreground">{`${view.auditFindings} audit findings`}</span>
          ) : null}
          {view.openSuggestions > 0 ? (
            <span>{`${view.openSuggestions} rule suggestions`}</span>
          ) : null}
        </MetaRow>
      </p>
      <MissionSection title="Active rules">
        <ul className="flex flex-col divide-y divide-border/60">
          {view.active.map((row) => (
            <RuleItem key={row.rule.id} row={row} context={context} />
          ))}
        </ul>
      </MissionSection>
      {view.retired.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            aria-expanded={showRetired}
            onClick={() => setShowRetired((open) => !open)}
          >
            {view.retired.length} retired {view.retired.length === 1 ? "rule" : "rules"}
          </Button>
          {showRetired ? (
            <ul className="flex flex-col divide-y divide-border/60">
              {view.retired.map((row) => (
                <RuleItem key={row.rule.id} row={row} context={context} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <MissionSection title="Add a rule">
        <PairActionForm
          firstLabel="Title"
          secondLabel="The rule, in your words"
          submitLabel="Add rule"
          onSubmit={(title, quote) => addRule(props.missionId, title, quote)}
        />
      </MissionSection>
    </div>
  );
}

interface RuleContext {
  readonly rules: ReadonlyArray<Rule>;
  readonly masterRoleId: string | null;
  readonly nowMs: number;
  readonly missionId: MissionId;
}

type RuleEdit = "quote" | "activation" | null;

function RuleItem(props: { row: RuleRow; context: RuleContext }) {
  const { row, context } = props;
  const { rule } = row;
  const [editing, setEditing] = useState<RuleEdit>(null);
  const toggle = (next: Exclude<RuleEdit, null>) => setEditing(editing === next ? null : next);
  return (
    <li className="flex flex-col gap-1 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-foreground">
          {rule.number !== null ? `${rule.number}. ` : ""}
          {rule.title}
        </span>
        {rule.status === "retired" ? <span className="text-muted-foreground">retired</span> : null}
      </div>
      <blockquote className="border-s-2 border-border ps-2 text-foreground">
        {rule.quote}
      </blockquote>
      <MutedLines
        lines={[
          rule.masterReading ? `Master's reading: ${rule.masterReading}` : null,
          `Scope: ${row.scope}`,
          `Activation: ${row.activation}`,
          row.acks.line
            ? `${row.acks.line}${row.acks.missing.length > 0 ? `; waiting on ${row.acks.missing.join(", ")}` : ""}`
            : null,
          `${row.use}${rule.lastReliedAt ? `, last relied on ${formatRelative(rule.lastReliedAt, context.nowMs)}` : ""}`,
          ...Object.entries(row.changedBy).map(([field, line]) => `${field}: ${line}`),
          ...row.audit.map((finding) =>
            auditLine(finding, rule.id, context.rules, context.masterRoleId),
          ),
        ]}
      />
      {row.suggestions.map((suggestion) => (
        <p key={suggestion.id} className="text-xs text-muted-foreground">
          Suggestion: {suggestion.title}{" "}
          <Link
            to="/missions/inbox"
            search={{
              mission: context.missionId,
              tab: "suggestions",
              ...(suggestion.acceptor === "master" ? { route: "master" as const } : {}),
            }}
            className="underline"
          >
            decide in the inbox
          </Link>
        </p>
      ))}
      {row.changeRequests.open.map((request) => (
        <ChangeRequestItem key={request.id} request={request} />
      ))}
      {row.changeRequests.resolved.length > 0 ? (
        <MutedLines
          lines={row.changeRequests.resolved.map(
            (request) =>
              `${CHANGE_REQUEST_STATUS_LABEL[request.status]}: ${request.request}${
                request.masterResponse ? ` (${request.masterResponse})` : ""
              }`,
          )}
        />
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Button size="xs" variant="ghost" onClick={() => toggle("quote")}>
          Edit wording
        </Button>
        <Button size="xs" variant="ghost" onClick={() => toggle("activation")}>
          Edit activation
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void toggleRuleRetired(rule)}>
          {rule.status === "active" ? "Retire" : "Bring back"}
        </Button>
      </div>
      {editing === "quote" ? (
        <TextActionForm
          label="Wording"
          initial={rule.quote}
          submitLabel="Save wording"
          onSubmit={async (quote) => {
            const done = await editRule(rule, { quote });
            if (done) setEditing(null);
            return done;
          }}
        />
      ) : null}
      {editing === "activation" ? (
        <TextActionForm
          label="When it applies (empty: always on)"
          initial={rule.activation}
          submitLabel="Save activation"
          onSubmit={async (activation) => {
            const done = await editRule(rule, { activation });
            if (done) setEditing(null);
            return done;
          }}
        />
      ) : null}
    </li>
  );
}

function ChangeRequestItem(props: { request: RuleChangeRequest }) {
  const { request } = props;
  return (
    <div className="flex flex-col gap-1 rounded border border-border/60 p-2">
      <p className="text-xs text-foreground">Change request: {request.request}</p>
      {request.proposedQuote ? (
        <p className="text-xs text-muted-foreground">Proposed wording: {request.proposedQuote}</p>
      ) : null}
      <TextActionForm
        label="Response (needed to decline)"
        submitLabel="Apply"
        onSubmit={(response) => resolveRuleChange(request.id, "apply", response)}
      />
      <TextActionForm
        label="Why decline it?"
        submitLabel="Decline"
        onSubmit={(response) => resolveRuleChange(request.id, "decline", response)}
      />
    </div>
  );
}
