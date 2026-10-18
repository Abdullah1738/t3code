import { useState } from "react";

import type { DraftChannel, MissionId } from "@t3tools/contracts";
import {
  APPROVER_LABEL,
  changeIndex,
  DRAFT_CHANNEL_LABEL,
  DRAFT_CHANNELS,
  lastChangedLine,
  routingRows,
  type ApprovalRoutingTable,
  type Approver,
  type RoutingRow,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { MutedLines, PickForm, TextActionForm } from "./MissionForms";
import { MissionSection } from "./MissionSection";
import { useApprovalRouting, useMasterRoleId } from "./missionsStore";
import { removeRoute, setApprovalRoute, setDraftRoute } from "./operationCommands";

// Approval routing table, placeholder presentation. The owner and the master
// edit it the same way; it decides whose inbox new drafts and approvals land
// in and never moves records that already exist (routingViewModel).

const other = (approver: Approver): Approver => (approver === "owner" ? "master" : "owner");

const emptyTable = (missionId: MissionId): ApprovalRoutingTable => ({
  missionId,
  version: 0,
  draftRules: [],
  approvalRules: [],
  updatedAt: "",
  changes: [],
});

export function RoutingPanel(props: { missionId: MissionId }) {
  const table = useApprovalRouting(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  if (table === undefined) return null;
  if (table === null) {
    // No table yet: adding the first rule creates it (version 0 -> 1).
    return (
      <MissionSection title="Routing">
        <p className="text-sm text-muted-foreground">
          No routing table: every new draft and approval comes to you.
        </p>
        <AddRouteForms table={emptyTable(props.missionId)} />
      </MissionSection>
    );
  }
  const lookup = changeIndex(table.changes);
  const ref = { kind: "mission" as const, id: table.missionId };
  return (
    <MissionSection
      title="Routing"
      caption={`Who new drafts and approvals go to. Anything no rule matches comes to you. ${
        lastChangedLine(lookup(ref, "rules"), masterRoleId) ?? ""
      }`}
    >
      <ul className="flex flex-col gap-1 text-sm">
        {routingRows(table).map((row) => (
          <RoutingRuleItem
            key={row.id}
            row={row}
            table={table}
            changedBy={lastChangedLine(lookup(ref, row.id), masterRoleId)}
          />
        ))}
      </ul>
      <AddRouteForms table={table} />
    </MissionSection>
  );
}

function RoutingRuleItem(props: {
  row: RoutingRow;
  table: ApprovalRoutingTable;
  changedBy: string | null;
}) {
  const { row, table } = props;
  const flip = () => {
    const to = other(row.approver);
    const draft = table.draftRules.find((rule) => rule.id === row.id);
    if (draft) return setDraftRoute(table, draft.match, to);
    const approval = table.approvalRules.find((rule) => rule.id === row.id);
    return approval ? setApprovalRoute(table, approval.match, to) : Promise.resolve(false);
  };
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground">
          {row.label} go to {APPROVER_LABEL[row.approver]}
        </span>
        <Button size="xs" variant="ghost" onClick={() => void flip()}>
          Send to {APPROVER_LABEL[other(row.approver)]}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void removeRoute(table, row.id)}>
          Remove
        </Button>
      </div>
      <MutedLines lines={[props.changedBy]} />
    </li>
  );
}

type AddKind = "person" | "channel" | "repo" | "kind";

const ADD_LABEL: Record<AddKind, string> = {
  person: "Drafts to a person",
  channel: "Drafts on a channel",
  repo: "Approvals in a repo",
  kind: "Approvals of a kind",
};

const APPROVAL_KINDS = ["merge", "deploy", "release", "other"] as const;

function AddRouteForms(props: { table: ApprovalRoutingTable }) {
  const [kind, setKind] = useState<AddKind | null>(null);
  const [approver, setApprover] = useState<Approver>("master");
  const { table } = props;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1 text-sm">
        <span className="me-1 text-muted-foreground">Add a rule</span>
        {(Object.keys(ADD_LABEL) as AddKind[]).map((value) => (
          <Button
            key={value}
            size="xs"
            variant={kind === value ? "secondary" : "ghost"}
            onClick={() => setKind(kind === value ? null : value)}
          >
            {ADD_LABEL[value]}
          </Button>
        ))}
        <Button size="xs" variant="ghost" onClick={() => setApprover(other(approver))}>
          to {APPROVER_LABEL[approver]}
        </Button>
      </div>
      {kind === "person" ? (
        <TextActionForm
          label="First name"
          submitLabel="Add rule"
          onSubmit={(name) => setDraftRoute(table, { _tag: "person", name }, approver)}
        />
      ) : null}
      {kind === "repo" ? (
        <TextActionForm
          label="Repository, e.g. crpko-devops"
          submitLabel="Add rule"
          onSubmit={(repository) => setApprovalRoute(table, { _tag: "repo", repository }, approver)}
        />
      ) : null}
      {kind === "channel" ? (
        <PickForm
          label="Channel"
          options={DRAFT_CHANNELS.map((channel) => ({
            value: channel,
            label: DRAFT_CHANNEL_LABEL[channel],
          }))}
          submitLabel="Add rule"
          onSubmit={(channel) =>
            setDraftRoute(table, { _tag: "channel", channel: channel as DraftChannel }, approver)
          }
        />
      ) : null}
      {kind === "kind" ? (
        <PickForm
          label="Approval kind"
          options={APPROVAL_KINDS.map((value) => ({ value, label: value }))}
          submitLabel="Add rule"
          onSubmit={(value) =>
            setApprovalRoute(
              table,
              { _tag: "kind", kind: value as (typeof APPROVAL_KINDS)[number] },
              approver,
            )
          }
        />
      ) : null}
    </div>
  );
}
