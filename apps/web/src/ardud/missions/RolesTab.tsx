import { Fragment, useMemo, useState } from "react";

import type { MissionId, Role } from "@t3tools/contracts";
import {
  formatRelative,
  formatTimeOfDay,
  poolRows,
  recoveryView,
  reviewPolicyView,
  roleModelChoices,
  roleRegistryView,
  type ModelChoice,
  type PoolRow,
  type RoleRow,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { MetaRow } from "./cards/chips";
import { MutedLines, PickForm, TextActionForm } from "./MissionForms";
import { MissionSection } from "./MissionSection";
import {
  useMasterRoleId,
  useMissionList,
  useMissionPools,
  useMissionRecovery,
  useMissionReviewPolicy,
  useMissionRoles,
} from "./missionsStore";
import { setCriticalityGuide, setPoolCapacity, setRoleModel } from "./operationCommands";

// Roles tab, placeholder presentation: the role registry, the review policy,
// pools and restart recovery. Everything shown is computed in client-runtime
// (rolesViewModel, poolsViewModel). The owner and the master edit the same way.

export function RolesTab(props: { missionId: MissionId; nowMs: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <RoleRegistry missionId={props.missionId} nowMs={props.nowMs} />
      <ReviewPolicySection missionId={props.missionId} nowMs={props.nowMs} />
      <PoolsSection missionId={props.missionId} nowMs={props.nowMs} />
      <RecoverySection missionId={props.missionId} />
    </div>
  );
}

function RoleRegistry(props: { missionId: MissionId; nowMs: number }) {
  const roles = useMissionRoles(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  const view = useMemo(
    () => (roles ? roleRegistryView(roles, masterRoleId) : null),
    [roles, masterRoleId],
  );
  const choices = useMemo(() => (roles ? roleModelChoices(roles.roles) : []), [roles]);
  if (!view) return <p className="text-sm text-muted-foreground">Loading roles…</p>;
  return (
    <MissionSection
      title="Roles"
      caption={
        <MetaRow>
          <span>{`${view.rows.length} roles`}</span>
          <span>{view.modelMix}</span>
          {view.pendingModelChanges > 0 ? (
            <span>{`${view.pendingModelChanges} model changes pending`}</span>
          ) : null}
          {view.driftCount > 0 ? (
            <span className="text-warning-foreground">{`${view.driftCount} drifting`}</span>
          ) : null}
        </MetaRow>
      }
    >
      <ul className="flex flex-col divide-y divide-border/60">
        {view.rows.map((row) => (
          <RoleItem key={row.role.id} row={row} choices={choices} nowMs={props.nowMs} />
        ))}
      </ul>
    </MissionSection>
  );
}

function RoleItem(props: { row: RoleRow; choices: ReadonlyArray<ModelChoice>; nowMs: number }) {
  const { row } = props;
  const [changing, setChanging] = useState(false);
  return (
    <li className="flex flex-col gap-1 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-foreground">{row.role.name}</span>
        <span className="text-muted-foreground">{row.kindLabel}</span>
        <span className="text-muted-foreground">{row.model}</span>
        {row.role.writesPublicText ? (
          <span className="text-muted-foreground">writes public text</span>
        ) : null}
      </div>
      <MutedLines
        lines={[
          row.pendingLine,
          row.modelChangedBy ? `Model ${row.modelChangedBy}` : null,
          row.holders.length > 0
            ? `Held by ${row.holders.map((binding) => binding.threadId).join(", ")}`
            : "No thread holds it",
          row.past.length > 0
            ? `Held before by ${row.past.length} ${row.past.length === 1 ? "thread" : "threads"}, last ended ${formatRelative(row.past[0]?.endedAt ?? "", props.nowMs)}`
            : null,
          ...row.drift.map(
            (drift) => `${drift.threadId} runs ${drift.observed}, expected ${drift.expected}`,
          ),
        ]}
      />
      <Button
        size="xs"
        variant="ghost"
        className="self-start"
        onClick={() => setChanging(!changing)}
      >
        Change model
      </Button>
      {changing ? (
        <ModelChangeForm
          role={row.role}
          choices={props.choices}
          onDone={() => setChanging(false)}
        />
      ) : null}
    </li>
  );
}

function ModelChangeForm(props: {
  role: Role;
  choices: ReadonlyArray<ModelChoice>;
  onDone: () => void;
}) {
  const [pick, setPick] = useState<ModelChoice | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <PickForm
        label="Model"
        options={props.choices.map((choice) => ({ value: choice.key, label: choice.label }))}
        submitLabel="Pick"
        onSubmit={async (key) => {
          setPick(props.choices.find((choice) => choice.key === key) ?? null);
          return true;
        }}
      />
      {pick ? (
        <TextActionForm
          label={`Why switch to ${pick.label}? Applies on its next turn.`}
          submitLabel="Change model"
          onSubmit={async (reason) => {
            const done = await setRoleModel(props.role, pick.selection, reason);
            if (done) props.onDone();
            return done;
          }}
        />
      ) : null}
    </div>
  );
}

function ReviewPolicySection(props: { missionId: MissionId; nowMs: number }) {
  const snapshot = useMissionReviewPolicy(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  const view = useMemo(
    () => (snapshot ? reviewPolicyView(snapshot, masterRoleId) : null),
    [snapshot, masterRoleId],
  );
  const [editing, setEditing] = useState(false);
  if (snapshot === undefined) return null;
  if (!view) {
    return (
      <MissionSection title="Review policy">
        <p className="text-sm text-muted-foreground">No review policy for this mission yet.</p>
      </MissionSection>
    );
  }
  const ladders = [...view.normal, ...view.critical, ...view.custom];
  return (
    <MissionSection
      title="Review policy"
      caption={
        <MetaRow>
          <span className="tabular-nums">{`v${view.policy.version}`}</span>
          <span>{`judged by ${view.judgedBy}`}</span>
          {view.changedBy ? <span>{view.changedBy}</span> : null}
        </MetaRow>
      }
    >
      <ul className="flex flex-col gap-1 text-sm">
        {ladders.map((ladder) => (
          <li key={ladder.ladder.id}>
            <span className="font-medium text-foreground">{ladder.ladder.name}</span>{" "}
            <span className="text-muted-foreground">({ladder.appliesLine})</span>:{" "}
            {ladder.stagesLine}
          </li>
        ))}
      </ul>
      <MutedLines lines={view.policy.commonRules.map((rule) => `Every round: ${rule}`)} />
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">Criticality guide</span>
        <p className="whitespace-pre-wrap text-foreground">{view.policy.guide.text}</p>
        <MutedLines
          lines={[view.guideBy, ...view.triggers.map((trigger) => `Always critical: ${trigger}`)]}
        />
        <Button
          size="xs"
          variant="ghost"
          className="self-start"
          onClick={() => setEditing(!editing)}
        >
          Edit guide
        </Button>
        {editing ? (
          <TextActionForm
            label="What counts as critical"
            initial={view.policy.guide.text}
            submitLabel="Save guide"
            onSubmit={async (text) => {
              const done = await setCriticalityGuide(props.missionId, text);
              if (done) setEditing(false);
              return done;
            }}
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">Recent verdicts</span>
        <MutedLines
          lines={view.verdicts.map(
            (row) =>
              `${row.line}: ${row.verdict.reason} (${row.by}, ${formatRelative(row.verdict.createdAt, props.nowMs)})`,
          )}
        />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">Recent review rounds</span>
        <MutedLines
          lines={view.reviews.map(
            (row) =>
              `${row.review.pullRequest.repository}#${row.review.pullRequest.number}: ${row.line} (${formatRelative(row.review.createdAt, props.nowMs)})`,
          )}
        />
      </div>
    </MissionSection>
  );
}

function PoolsSection(props: { missionId: MissionId; nowMs: number }) {
  const pools = useMissionPools(props.missionId);
  const list = useMissionList();
  const masterRoleId = useMasterRoleId(props.missionId);
  const rows = useMemo(() => {
    if (!pools) return null;
    const titles = new Map(
      (list?.missions ?? []).map((mission) => [mission.id as string, mission.title]),
    );
    return poolRows(pools, masterRoleId, titles);
  }, [pools, list, masterRoleId]);
  if (!rows) return null;
  return (
    <MissionSection title="Pools">
      <ul className="flex flex-col divide-y divide-border/60">
        {rows.map((row) => (
          <PoolItem key={row.pool.id} row={row} nowMs={props.nowMs} />
        ))}
      </ul>
    </MissionSection>
  );
}

function PoolItem(props: { row: PoolRow; nowMs: number }) {
  const { row } = props;
  const [editing, setEditing] = useState(false);
  const holdLine = (entry: PoolRow["holders"][number]) =>
    `${entry.holder} (fence ${entry.fence}${entry.needsReconcile ? ", needs reconcile" : ""}): ${entry.hold.purpose}${
      entry.hold.leaseExpiresAt ? `, lease to ${formatTimeOfDay(entry.hold.leaseExpiresAt)}` : ""
    }`;
  return (
    <li className="flex flex-col gap-1 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-foreground">{row.pool.name}</span>
        <span className="text-muted-foreground">
          <MetaRow>
            <span className="tabular-nums">{row.usageLine}</span>
            <span>{row.pressure}</span>
            <span>{row.enforcementLabel}</span>
          </MetaRow>
        </span>
      </div>
      <MutedLines
        lines={[
          row.pressureReason,
          row.scopeLine,
          row.pool.usage.runOutAt
            ? `Runs out around ${formatTimeOfDay(row.pool.usage.runOutAt)}`
            : null,
          row.capacityChangedBy ? `Capacity ${row.capacityChangedBy}` : null,
          ...row.holders.map((entry) => `Held by ${holdLine(entry)}`),
          ...row.queue.map((entry, index) => `Queue ${index + 1}: ${holdLine(entry)}`),
        ]}
      />
      <Button size="xs" variant="ghost" className="self-start" onClick={() => setEditing(!editing)}>
        Change capacity
      </Button>
      {editing ? (
        <CapacityForm
          poolId={row.pool.id}
          capacity={row.pool.capacity}
          onDone={() => setEditing(false)}
        />
      ) : null}
    </li>
  );
}

function CapacityForm(props: {
  poolId: PoolRow["pool"]["id"];
  capacity: number;
  onDone: () => void;
}) {
  const [capacity, setCapacity] = useState(String(props.capacity));
  return (
    <TextActionForm
      label="Why change it?"
      submitLabel="Set capacity"
      onSubmit={async (reason) => {
        const done = await setPoolCapacity(props.poolId, capacity, reason);
        if (done) props.onDone();
        return done;
      }}
    >
      <Input
        size="sm"
        aria-label="New capacity"
        className="w-20"
        inputMode="decimal"
        value={capacity}
        onChange={(event) => setCapacity(event.target.value)}
      />
    </TextActionForm>
  );
}

// The newest restart (incidents arrive newest first): when it was down, then
// who resumed, was reconciled, only told, skipped or is still waiting.
function RecoverySection(props: { missionId: MissionId }) {
  const incidents = useMissionRecovery(props.missionId);
  const latest = incidents?.[0];
  if (!latest) return null;
  const view = recoveryView(latest);
  return (
    <MissionSection
      title="Last restart"
      accessory={<span className="text-xs text-(--m-muted) tabular-nums">{view.dayLabel}</span>}
    >
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm tabular-nums">
        <dt className="text-(--m-muted)">Down</dt>
        <dd>{view.downLine}</dd>
        {view.groups.map((group) => (
          <Fragment key={group.label}>
            <dt className={group.label === "Waiting" ? "text-(--m-warning)" : "text-(--m-muted)"}>
              {group.label}
            </dt>
            <dd>{group.names.join(", ")}</dd>
          </Fragment>
        ))}
      </dl>
    </MissionSection>
  );
}
