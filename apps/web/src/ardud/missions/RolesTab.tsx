import { Fragment, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";

import type { MissionId, Role, RoleKind, ThreadId } from "@t3tools/contracts";
import {
  poolRows,
  recoveryView,
  reviewerRows,
  reviewPolicyView,
  roleHistory,
  roleModelChoices,
  roleRegistryView,
  roleThreadLine,
  routingRows,
  whenLabel,
  type ModelChoice,
  type PoolRow,
  type RoleRow,
  NEW_ROLE_KINDS,
  ROLE_KIND_LABEL,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { DESK_ROW, DeskChip, FeedErrors, FoldRow, TabActions, TabLoading } from "./deskParts";
import { createRole } from "./deskCommands";
import { PickForm, PickTextForm, TextActionForm } from "./MissionForms";
import { MissionSection } from "./MissionSection";
import {
  useApprovalRouting,
  useMasterRoleId,
  useMissionList,
  useMissionPools,
  useMissionRecovery,
  useMissionReviewPolicy,
  useMissionRoles,
  useMissionRolesFeed,
} from "./missionsStore";
import { setCriticalityGuide, setPoolCapacity, setRoleModel } from "./operationCommands";

// Roles page (Desk): one line of counts, who holds each role and the review
// policy on the wide side; criticality calls, routing, pools and the last
// restart on the narrow side. Every line comes from rolesViewModel and
// poolsViewModel; the owner and the master edit the same way.

const ROLES_SHOWN = 8;
const HISTORY_SHOWN = 3;
const VERDICTS_SHOWN = 5;

export function RolesTab(props: { missionId: MissionId; nowMs: number }) {
  const roles = useMissionRoles(props.missionId);
  const feeds = [useMissionRolesFeed(props.missionId)];
  const masterRoleId = useMasterRoleId(props.missionId);
  const view = useMemo(
    () => (roles ? roleRegistryView(roles, masterRoleId) : null),
    [roles, masterRoleId],
  );
  const [adding, setAdding] = useState(false);
  if (!roles || !view)
    return <TabLoading label="Loading roles…" what="the roles" feeds={feeds} nowMs={props.nowMs} />;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <FeedErrors what="the roles" feeds={feeds} nowMs={props.nowMs} />
      <TabActions>
        <Button size="sm" variant="outline" onClick={() => setAdding((on) => !on)}>
          New role
        </Button>
      </TabActions>
      {adding ? (
        <div className="flex flex-col gap-2 rounded-3xl bg-(--m-surface) p-4 sm:p-5">
          <h2 className="text-sm font-semibold">New role</h2>
          <PickTextForm
            pickLabel="Kind"
            options={NEW_ROLE_KINDS.map((kind) => ({ value: kind, label: ROLE_KIND_LABEL[kind] }))}
            textLabel="Name (optional)"
            submitLabel="Add role"
            onSubmit={async (kind, name) => {
              const done = await createRole(props.missionId, kind as RoleKind, name);
              if (done) setAdding(false);
              return done;
            }}
          />
        </div>
      ) : null}
      <div className="grid min-w-0 gap-4 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-8 [&>*:last-child]:grow">
          <RoleRegistry rows={view.rows} roles={roles.roles} nowMs={props.nowMs} />
          <ReviewPolicySection missionId={props.missionId} roles={roles.roles} />
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-4 [&>*:last-child]:grow">
          <VerdictsSection missionId={props.missionId} nowMs={props.nowMs} />
          <RoutingSection missionId={props.missionId} />
          <PoolsSection missionId={props.missionId} nowMs={props.nowMs} />
          <RecoverySection missionId={props.missionId} />
        </div>
      </div>
    </div>
  );
}

function RoleRegistry(props: {
  rows: ReadonlyArray<RoleRow>;
  roles: ReadonlyArray<Role>;
  nowMs: number;
}) {
  const choices = useMemo(() => roleModelChoices(props.roles), [props.roles]);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const shown = all ? props.rows : props.rows.slice(0, ROLES_SHOWN);
  return (
    <MissionSection title="Who holds each role" caption={String(props.rows.length)}>
      <div className="hidden grid-cols-[minmax(0,1.3fr)_5rem_minmax(0,1fr)_4rem] gap-x-3.5 px-1 pb-1 text-xs text-(--m-muted) sm:grid">
        <span>Role</span>
        <span>Model</span>
        <span>Thread</span>
        <span className="text-end">Threads</span>
      </div>
      <ul className="flex flex-col">
        {shown.map((row) => (
          <RoleItem
            key={row.role.id}
            row={row}
            choices={choices}
            open={open === row.role.id}
            onToggle={() => setOpen(open === row.role.id ? null : row.role.id)}
          />
        ))}
      </ul>
      {all ? null : (
        <FoldRow hidden={props.rows.length - shown.length} onShow={() => setAll(true)} />
      )}
    </MissionSection>
  );
}

function RoleItem(props: {
  row: RoleRow;
  choices: ReadonlyArray<ModelChoice>;
  open: boolean;
  onToggle: () => void;
}) {
  const { row } = props;
  const threads = row.holders.length + row.past.length;
  return (
    <li className={cn(DESK_ROW, props.open && "rounded-xl border-transparent bg-(--m-active)")}>
      <button
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3.5 gap-y-0.5 rounded-xl px-1 py-2.5 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset sm:grid-cols-[minmax(0,1.3fr)_5rem_minmax(0,1fr)_4rem]"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{row.role.name}</span>
          {row.role.description ? (
            <span className="truncate text-xs text-(--m-muted)">{row.role.description}</span>
          ) : null}
        </span>
        <span className="whitespace-nowrap">
          {row.family}
          {row.pendingFamily ? (
            <span className="ms-1.5 text-xs text-(--m-accent-text)">{`to ${row.pendingFamily}`}</span>
          ) : null}
        </span>
        <span
          className={cn(
            "col-span-2 min-w-0 truncate text-xs sm:col-span-1 sm:text-sm",
            row.holders.length > 0 && !row.pendingFamily && !row.threadMissing
              ? "tabular-nums"
              : "text-(--m-muted)",
          )}
        >
          {roleThreadLine(row)}
        </span>
        <span className="hidden text-end text-(--m-muted) tabular-nums sm:inline">{threads}</span>
      </button>
      {props.open ? <RoleDetail row={row} choices={props.choices} /> : null}
    </li>
  );
}

function RoleDetail(props: { row: RoleRow; choices: ReadonlyArray<ModelChoice> }) {
  const { row } = props;
  const environmentId = usePrimaryEnvironmentId();
  const [changing, setChanging] = useState(false);
  const [allHistory, setAllHistory] = useState(false);
  const history = roleHistory(row);
  const shownHistory = allHistory ? history : history.slice(0, HISTORY_SHOWN);
  const holder = row.holders[0];
  return (
    <div className="flex flex-col gap-3 px-1 pb-3 text-sm">
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-(--m-muted)">Kind</dt>
        <dd>{row.kindLabel}</dd>
        <dt className="text-(--m-muted)">Model</dt>
        <dd className="min-w-0 break-words">{row.model}</dd>
        {row.pendingLine ? (
          <>
            <dt className="text-(--m-muted)">Next turn</dt>
            <dd>{row.pendingLine}</dd>
          </>
        ) : null}
        {row.modelChangedBy ? (
          <>
            <dt className="text-(--m-muted)">Changed</dt>
            <dd>{row.modelChangedBy}</dd>
          </>
        ) : null}
        {row.drift.map((drift) => (
          <Fragment key={drift.threadId}>
            <dt className="text-(--m-warning)">Drift</dt>
            <dd>{`${drift.observed}, expected ${drift.expected}`}</dd>
          </Fragment>
        ))}
      </dl>
      {history.length > 1 ? (
        <div className="flex flex-col">
          <ol className="flex flex-col">
            {shownHistory.map((entry) => (
              <li
                key={entry.key}
                className={cn(
                  DESK_ROW,
                  "grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_auto] gap-x-3 py-1.5 text-xs",
                )}
              >
                <span
                  className={cn("truncate", entry.missing ? "text-(--m-muted)" : "tabular-nums")}
                >
                  {entry.code}
                </span>
                <span className="min-w-0 text-(--m-muted)">{entry.note}</span>
                <span className="text-(--m-muted) tabular-nums">{entry.at}</span>
              </li>
            ))}
          </ol>
          {allHistory ? null : (
            <FoldRow
              hidden={history.length - shownHistory.length}
              onShow={() => setAllHistory(true)}
              label={`${history.length - shownHistory.length} earlier threads`}
            />
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {environmentId && holder && !row.threadMissing ? (
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: holder.threadId as ThreadId }}
              />
            }
          >
            Open thread
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => setChanging(!changing)}>
          Change model
        </Button>
      </div>
      {changing ? (
        <ModelChangeForm
          role={row.role}
          choices={props.choices}
          onDone={() => setChanging(false)}
        />
      ) : null}
    </div>
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
          label={`Why switch to ${pick.label}?`}
          placeholder="Why switch"
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

function ReviewPolicySection(props: { missionId: MissionId; roles: ReadonlyArray<Role> }) {
  const snapshot = useMissionReviewPolicy(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  const view = useMemo(
    () => (snapshot ? reviewPolicyView(snapshot, masterRoleId) : null),
    [snapshot, masterRoleId],
  );
  const [editing, setEditing] = useState(false);
  if (!view) return null;
  const ladders = [...view.normal, ...view.critical, ...view.custom];
  const reviewers = reviewerRows(view.policy, props.roles);
  const block = cn(DESK_ROW, "flex flex-col gap-1.5 py-3 first:pt-1");
  return (
    <MissionSection
      title="Review policy"
      caption={`v${view.policy.version}`}
      accessory={
        view.changedBy ? <span className="text-xs text-(--m-muted)">{view.changedBy}</span> : null
      }
    >
      <div className="flex flex-col text-sm">
        {ladders.map((ladder) => (
          <div key={ladder.ladder.id} className={block}>
            <h3 className="font-semibold">{ladder.ladder.name}</h3>
            {ladder.ladder.appliesTo !== "normal" && ladder.appliesLine ? (
              <p className="text-xs text-(--m-muted)">{ladder.appliesLine}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5">
              {ladder.stages.map((stage) => (
                <Fragment key={stage}>
                  {stage === ladder.stages[0] ? null : (
                    <span className="text-xs text-(--m-muted)">then</span>
                  )}
                  <DeskChip>{stage}</DeskChip>
                </Fragment>
              ))}
            </div>
          </div>
        ))}
        {reviewers.length > 0 ? (
          <div className={block}>
            <h3 className="font-semibold">Reviewers</h3>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
              {reviewers.map((row) => (
                <Fragment key={row.stageId}>
                  <dt className="min-w-0 truncate">{row.stage}</dt>
                  <dd className="text-(--m-muted)">
                    {row.family ? `${row.name}, ${row.family}` : row.name}
                  </dd>
                </Fragment>
              ))}
            </dl>
          </div>
        ) : null}
        {view.policy.commonRules.length > 0 ? (
          <div className={block}>
            <h3 className="font-semibold">Always</h3>
            {view.policy.commonRules.map((rule) => (
              <p key={rule} className="text-(--m-muted)">
                {rule}
              </p>
            ))}
          </div>
        ) : null}
        <div className={block}>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">Critical</h3>
            <span className="text-xs text-(--m-muted)">{view.guideBy}</span>
            <Button
              size="xs"
              variant="ghost-muted"
              className="ms-auto"
              onClick={() => setEditing(!editing)}
            >
              Edit
            </Button>
          </div>
          <p className="whitespace-pre-wrap">{view.policy.guide.text}</p>
          {view.triggers.length > 0 ? (
            <p className="text-(--m-muted)">{`Always critical: ${view.triggers.join(", ")}`}</p>
          ) : null}
          <p className="text-xs text-(--m-muted)">{view.judgedBy}</p>
          {editing ? (
            <TextActionForm
              label="What counts as critical"
              initial={view.policy.guide.text}
              submitLabel="Save"
              onSubmit={async (text) => {
                const done = await setCriticalityGuide(props.missionId, text);
                if (done) setEditing(false);
                return done;
              }}
            />
          ) : null}
        </div>
      </div>
    </MissionSection>
  );
}

function VerdictsSection(props: { missionId: MissionId; nowMs: number }) {
  const snapshot = useMissionReviewPolicy(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  const [all, setAll] = useState(false);
  // Newest first, as the server sends them.
  const verdicts = useMemo(
    () => (snapshot ? reviewPolicyView(snapshot, masterRoleId).verdicts : []),
    [snapshot, masterRoleId],
  );
  if (verdicts.length === 0) return null;
  const shown = all ? verdicts : verdicts.slice(0, VERDICTS_SHOWN);
  return (
    <MissionSection title="Criticality calls" caption={String(verdicts.length)}>
      <ul className="flex flex-col text-sm">
        {shown.map((row) => (
          <li
            key={row.verdict.id}
            className={cn(DESK_ROW, "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2.5")}
          >
            <span className="min-w-0 truncate font-medium">{row.ref}</span>
            <span
              className={
                row.verdict.critical ? "font-medium text-(--m-negative)" : "text-(--m-muted)"
              }
            >
              {row.verdict.critical ? "Critical" : "Not critical"}
            </span>
            <span className="col-span-2 text-xs text-(--m-muted)">
              {`${row.verdict.reason} ${whenLabel(row.verdict.createdAt, props.nowMs)}`}
            </span>
          </li>
        ))}
      </ul>
      {all ? null : <FoldRow hidden={verdicts.length - shown.length} onShow={() => setAll(true)} />}
    </MissionSection>
  );
}

function RoutingSection(props: { missionId: MissionId }) {
  const table = useApprovalRouting(props.missionId);
  if (table === undefined) return null;
  const rows = table ? routingRows(table) : [];
  const approver = (value: "owner" | "master") => (value === "owner" ? "You" : "Master");
  return (
    <MissionSection
      title="Routing"
      accessory={
        <Button
          size="xs"
          variant="ghost-muted"
          render={
            <Link to="/missions/inbox" search={{ mission: props.missionId, tab: "approve" }} />
          }
        >
          Edit
        </Button>
      }
    >
      <ul className="flex flex-col text-sm">
        {[
          ...rows.map((row) => ({ key: row.id, label: row.label, to: approver(row.approver) })),
          { key: "rest", label: "Anything else", to: "You" },
        ].map((row) => (
          <li
            key={row.key}
            className={cn(DESK_ROW, "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2")}
          >
            <span className="min-w-0 first-letter:uppercase">{row.label}</span>
            <span className="font-medium">{row.to}</span>
          </li>
        ))}
      </ul>
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
  if (!rows || rows.length === 0) return null;
  return (
    <MissionSection title="Pools" caption={String(rows.length)}>
      <ul className="flex flex-col">
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
  const holds = [...row.holders, ...row.queue];
  return (
    <li className={cn(DESK_ROW, "flex flex-col gap-1.5 py-2.5 text-sm")}>
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="min-w-0 truncate font-medium">{row.pool.name}</span>
        <span className="ms-auto whitespace-nowrap tabular-nums">{row.amountLine}</span>
      </div>
      <div
        role="img"
        aria-label={`${Math.round(row.share * 100)}% in use`}
        className="h-2 overflow-hidden rounded-full bg-(--m-active)"
      >
        <div
          className={cn(
            "h-full rounded-full",
            row.pressure === "ok" ? "bg-(--m-bar-1)" : "bg-(--m-warning)",
          )}
          style={{ width: `${row.share * 100}%` }}
        />
      </div>
      <p className="text-xs text-(--m-muted)">
        {row.ruleLine}
        {row.pool.usage.runOutAt
          ? `. Runs out ${whenLabel(row.pool.usage.runOutAt, props.nowMs)}`
          : ""}
      </p>
      {row.pressure === "ok" ? null : (
        <p className="text-xs text-(--m-warning)">{row.pressureReason}</p>
      )}
      {holds.map((entry) => (
        <p key={entry.hold.id} className="text-xs text-(--m-muted)">
          {`${entry.queued ? "Waiting" : "Held by"} ${entry.holder}: ${entry.hold.purpose}`}
          {entry.needsReconcile ? (
            <span className="text-(--m-warning)"> Needs reconcile.</span>
          ) : null}
        </p>
      ))}
      <Button
        size="xs"
        variant="ghost-muted"
        className="self-start"
        onClick={() => setEditing(!editing)}
      >
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
      placeholder="Why"
      submitLabel="Set"
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
