import { useState } from "react";

import type { Approver, DraftChannel, MissionId } from "@t3tools/contracts";
import {
  APPROVER_LABEL,
  changeIndex,
  DRAFT_CHANNEL_LABEL,
  DRAFT_CHANNELS,
  emptyRoutingTable,
  lastChangedLine,
  routingRows,
  type ApprovalRoutingTable,
  type RoutingRow,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { MutedLines, PickForm, TextActionForm } from "./MissionForms";
import { MissionSection } from "./MissionSection";
import { useApprovalRouting, useMasterRoleId } from "./missionsStore";
import { flipRoute, removeRoute, setRoute } from "./operationCommands";

// Approval routing table. The owner and the master edit it the same way; it
// decides whose inbox new drafts and approvals land in and never moves records
// that already exist. First matching row wins, no match comes to the owner.

const other = (approver: Approver): Approver => (approver === "owner" ? "master" : "owner");

export function RoutingPanel(props: { missionId: MissionId }) {
  const table = useApprovalRouting(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  if (table === undefined) return null;
  const current = table ?? emptyRoutingTable(props.missionId);
  const lookup = changeIndex(current.changes);
  const ref = { kind: "mission" as const, id: current.missionId };
  return (
    <MissionSection
      title="Routing"
      caption={lastChangedLine(lookup(ref, "rules"), masterRoleId) ?? undefined}
    >
      {current.routes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {routingRows(current).map((row) => (
            <RoutingRuleItem
              key={row.id}
              row={row}
              table={current}
              changedBy={lastChangedLine(lookup(ref, row.id), masterRoleId)}
            />
          ))}
        </ul>
      ) : null}
      <AddRouteForms table={current} />
    </MissionSection>
  );
}

function RoutingRuleItem(props: {
  row: RoutingRow;
  table: ApprovalRoutingTable;
  changedBy: string | null;
}) {
  const { row, table } = props;
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground">
          {row.label} go to {APPROVER_LABEL[row.approver]}
        </span>
        <Button size="xs" variant="ghost" onClick={() => void flipRoute(table, row.id)}>
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
          label="Name"
          submitLabel="Add"
          onSubmit={(person) => setRoute(table, { _tag: "draft", person }, approver)}
        />
      ) : null}
      {kind === "repo" ? (
        <TextActionForm
          label="Repository"
          submitLabel="Add"
          onSubmit={(repository) => setRoute(table, { _tag: "approval", repository }, approver)}
        />
      ) : null}
      {kind === "channel" ? (
        <PickForm
          label="Channel"
          options={DRAFT_CHANNELS.map((channel) => ({
            value: channel,
            label: DRAFT_CHANNEL_LABEL[channel],
          }))}
          submitLabel="Add"
          onSubmit={(channel) =>
            setRoute(table, { _tag: "draft", channel: channel as DraftChannel }, approver)
          }
        />
      ) : null}
      {kind === "kind" ? (
        <PickForm
          label="Approval kind"
          options={APPROVAL_KINDS.map((value) => ({ value, label: value }))}
          submitLabel="Add"
          onSubmit={(value) =>
            setRoute(
              table,
              { _tag: "approval", kind: value as (typeof APPROVAL_KINDS)[number] },
              approver,
            )
          }
        />
      ) : null}
    </div>
  );
}
