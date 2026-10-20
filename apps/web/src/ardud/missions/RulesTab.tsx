import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";

import type { MissionId, Rule, RuleChangeRequest, SubMission } from "@t3tools/contracts";
import {
  actorName,
  actorNames,
  auditTitle,
  CHANGE_REQUEST_STATUS_LABEL,
  editReadingInput,
  formatDayLabel,
  formatTimeOfDay,
  quoteAuthor,
  ruleAckList,
  ruleBookView,
  ruleFacts,
  ruleLabel,
  ruleList,
  ruleUses,
  scopeShort,
  whenLabel,
  type ActorNames,
  type RuleListItem,
  type RuleRow,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { DESK_ROW, DeskChip, Figure, FoldRow, PageLine } from "./deskParts";
import { submitMissionInput } from "./missionActions";
import { PairActionForm, TextActionForm } from "./MissionForms";
import {
  missionsSource,
  useMasterRoleId,
  useMissionLanes,
  useMissionRoles,
  useMissionRuleBook,
} from "./missionsStore";
import { addRule, editRule, resolveRuleChange, toggleRuleRetired } from "./operationCommands";
import { AskMasterForm } from "./sections/SectionShell";
import { useTimelineWindow } from "./useMissionFeeds";

// Rules tab, Desk layout: audit cards, the list of rules next to the open
// rule. The owner's quote is never edited in place; the master's reading,
// scope and activation are. Acks, uses and problems come from client-runtime
// (rulesViewModel).

const LIST_SHOWN = 9;

const stamp = (atIso: string) => `${formatDayLabel(atIso)} ${formatTimeOfDay(atIso)}`;

interface RulesContext {
  readonly missionId: MissionId;
  readonly masterRoleId: string | null;
  readonly subMissions: ReadonlyArray<SubMission>;
  readonly names: ActorNames;
  readonly nowMs: number;
}

export function RulesTab(props: {
  missionId: MissionId;
  subMissions: ReadonlyArray<SubMission>;
  nowMs: number;
}) {
  const book = useMissionRuleBook(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  const lanes = useMissionLanes(props.missionId);
  const roles = useMissionRoles(props.missionId);
  const wide = useMediaQuery({ min: "lg" });
  const names = useMemo(() => actorNames(lanes ?? [], roles?.roles ?? []), [lanes, roles]);
  const view = useMemo(
    () => (book ? ruleBookView(book, masterRoleId, props.subMissions) : null),
    [book, masterRoleId, props.subMissions],
  );
  const list = useMemo(
    () => (view ? ruleList(view, props.subMissions) : []),
    [view, props.subMissions],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  if (!book || !view) return <p className="text-sm text-(--m-muted)">Loading rules…</p>;

  const context: RulesContext = {
    missionId: props.missionId,
    masterRoleId,
    subMissions: props.subMissions,
    names,
    nowMs: props.nowMs,
  };
  const rows = [...view.active, ...view.retired];
  // On a wide screen a rule is always open: the first one until the owner picks.
  const openId = picked ?? (wide ? (list[0]?.row.rule.id ?? null) : null);
  const open = rows.find((row) => row.rule.id === openId) ?? null;
  const shown = showAll ? list : list.slice(0, LIST_SHOWN);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageLine
        actions={
          <Button size="sm" variant="outline" onClick={() => setAdding((on) => !on)}>
            New rule
          </Button>
        }
      >
        <Figure>{view.active.length}</Figure> active
        {view.retired.length > 0 ? (
          <>
            , <Figure>{view.retired.length}</Figure> retired
          </>
        ) : null}
      </PageLine>
      {adding ? (
        <div className="flex flex-col gap-2 rounded-3xl bg-(--m-surface) p-4 sm:p-5">
          <h2 className="text-sm font-semibold">New rule</h2>
          <PairActionForm
            firstLabel="Title"
            secondLabel="The rule, in your words"
            submitLabel="Add rule"
            onSubmit={async (title, quote) => {
              const done = await addRule(props.missionId, title, quote);
              if (done) setAdding(false);
              return done;
            }}
          />
        </div>
      ) : null}
      {book.audit.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {book.audit.map((finding) => (
            <li
              key={finding.id}
              className="flex items-center gap-3 rounded-2xl bg-(--m-surface) px-5 py-4"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="text-sm font-semibold">{auditTitle(finding, book.rules)}</p>
                <p className="text-xs text-(--m-muted)">
                  {`Audit by ${actorName(finding.foundBy, masterRoleId, names)}, ${whenLabel(finding.at, props.nowMs)}`}
                </p>
              </div>
              {finding.ruleIds[0] ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ms-auto"
                  onClick={() => setPicked(finding.ruleIds[0] ?? null)}
                >
                  Review
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <nav
          aria-label="Rules"
          className={cn("flex min-w-0 flex-col", picked !== null && "max-lg:hidden")}
        >
          <h2 className="px-3 pt-3.5 pb-1.5 text-xs text-(--m-muted)">Relied on most recently</h2>
          <ul className="flex flex-col">
            {shown.map((item) => (
              <RuleListRow
                key={item.row.rule.id}
                item={item}
                active={item.row.rule.id === openId}
                nowMs={props.nowMs}
                onPick={() => setPicked(item.row.rule.id)}
              />
            ))}
          </ul>
          <FoldRow
            hidden={list.length - shown.length}
            onShow={() => setShowAll(true)}
            label={`${list.length - shown.length} more active`}
          />
          {view.retired.length > 0 ? (
            <>
              <button
                type="button"
                aria-expanded={showRetired}
                onClick={() => setShowRetired((on) => !on)}
                className="mt-3 flex h-9 items-center justify-between rounded-xl px-3 text-xs text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset"
              >
                Retired
                <span className="tabular-nums">{view.retired.length}</span>
              </button>
              {showRetired ? (
                <ul className="flex flex-col">
                  {view.retired.map((row) => (
                    <li
                      key={row.rule.id}
                      className={cn("flex items-center gap-3 px-3 py-2 text-sm", DESK_ROW)}
                    >
                      <button
                        type="button"
                        onClick={() => setPicked(row.rule.id)}
                        className="min-w-0 truncate text-start text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset"
                      >
                        {row.rule.title}
                      </button>
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        className="ms-auto"
                        onClick={() => void toggleRuleRetired(row.rule)}
                      >
                        Restore
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </nav>
        {open ? (
          <div className="flex min-w-0 flex-col gap-3">
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="self-start rounded-full text-sm text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset lg:hidden"
            >
              All rules
            </button>
            <RuleRecord key={open.rule.id} row={open} rules={book.rules} context={context} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RuleListRow(props: {
  item: RuleListItem;
  active: boolean;
  nowMs: number;
  onPick: () => void;
}) {
  const { row, lastRelied, line, problem } = props.item;
  return (
    <li>
      <button
        type="button"
        aria-current={props.active ? "true" : undefined}
        onClick={props.onPick}
        className={cn(
          "grid w-full grid-cols-[34px_minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-xl px-3 py-2.5 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset",
          props.active ? "bg-(--m-active)" : "hover:bg-(--m-surface)",
        )}
      >
        <span className="text-(--m-muted) tabular-nums">{row.rule.number ?? ""}</span>
        <span className="min-w-0 truncate font-medium">{row.rule.title}</span>
        <span className="text-xs text-(--m-muted) tabular-nums">
          {lastRelied ? whenLabel(lastRelied, props.nowMs) : ""}
        </span>
        <span
          className={cn(
            "col-start-2 col-end-4 min-w-0 truncate text-xs",
            problem ? "text-(--m-warning)" : "text-(--m-muted)",
          )}
        >
          {problem ?? line}
        </span>
      </button>
    </li>
  );
}

type RuleEdit = "quote" | "reading" | "activation" | "ask" | null;

function RuleRecord(props: { row: RuleRow; rules: ReadonlyArray<Rule>; context: RulesContext }) {
  const { row, context } = props;
  const { rule } = row;
  const [editing, setEditing] = useState<RuleEdit>(null);
  const toggle = (next: Exclude<RuleEdit, null>) =>
    setEditing((current) => (current === next ? null : next));
  const timeline = useTimelineWindow(context.missionId);
  const uses = ruleUses(timeline?.events ?? [], rule.id, context.masterRoleId, context.names);
  const acks = ruleAckList(rule, context.masterRoleId, context.names);
  const facts = ruleFacts(row, context.nowMs, context.subMissions);
  return (
    <section
      aria-label={rule.title}
      className="flex min-w-0 flex-col gap-5 rounded-3xl bg-(--m-surface) px-5 pt-5 pb-6 sm:px-7 sm:pt-6 sm:pb-7"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <DeskChip>{ruleLabel(rule)}</DeskChip>
          <span className="text-xs text-(--m-muted) tabular-nums">
            {`made ${stamp(rule.createdAt)}, applies to ${scopeShort(rule.scope, context.subMissions).toLowerCase()}`}
          </span>
          {rule.status === "retired" ? (
            <span className="text-xs text-(--m-muted)">Retired</span>
          ) : null}
        </div>
        <h2 className="text-2xl font-normal tracking-tight">{rule.title}</h2>
      </div>

      <figure className="flex max-w-prose flex-col gap-1.5">
        <blockquote className="text-base leading-relaxed">{rule.quote}</blockquote>
        <figcaption className="text-xs text-(--m-muted) tabular-nums">
          {`${quoteAuthor(rule, context.masterRoleId)}, ${stamp(rule.quotedAt)}`}
          {row.changedBy.quote ? `, ${row.changedBy.quote}` : ""}
        </figcaption>
      </figure>

      <div className="flex max-w-prose flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3">
          <h3 className="text-sm font-semibold">The master's reading</h3>
          {row.changedBy.masterReading ? (
            <span className="text-xs text-(--m-muted)">{row.changedBy.masterReading}</span>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={() => toggle("reading")}>
            Edit
          </Button>
        </div>
        {rule.masterReading.trim() ? (
          <p className="text-sm leading-relaxed">{rule.masterReading}</p>
        ) : null}
        {editing === "reading" ? (
          <TextActionForm
            label="The master's reading"
            initial={rule.masterReading}
            submitLabel="Save reading"
            onSubmit={async (reading) => {
              const done = await submitMissionInput(
                editReadingInput(rule, reading),
                (input) => missionsSource.upsertRule(input),
                "Couldn't save the reading",
              );
              if (done) setEditing(null);
              return done;
            }}
          />
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-t border-(--m-rule) pt-4 sm:grid-cols-4">
        {facts.map((fact) => (
          <div key={fact.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-(--m-muted)">{fact.label}</dt>
            <dd className="text-sm tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>

      {acks ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{acks.line}</h3>
          <ul className="flex flex-wrap gap-1.5">
            {acks.chips.map((chip) => (
              <li key={chip.key}>
                <DeskChip>
                  {chip.name}
                  <span className="ms-1.5 font-normal text-(--m-muted) tabular-nums">
                    {whenLabel(chip.at, context.nowMs)}
                  </span>
                </DeskChip>
              </li>
            ))}
          </ul>
          {acks.missing.length > 0 ? (
            <p className="text-xs text-(--m-warning)">{`Waiting on ${acks.missing.join(", ")}`}</p>
          ) : null}
        </div>
      ) : null}

      {row.changeRequests.open.map((request) => (
        <ChangeRequestItem key={request.id} request={request} />
      ))}
      {row.suggestions.map((suggestion) => (
        <div key={suggestion.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="min-w-0">{suggestion.title}</span>
          <Button
            size="xs"
            variant="outline"
            render={
              <Link
                to="/missions/inbox"
                search={{
                  mission: context.missionId,
                  tab: "suggestions",
                  ...(suggestion.acceptor === "master" ? { route: "master" as const } : {}),
                }}
              />
            }
          >
            Decide
          </Button>
        </div>
      ))}

      {uses.length > 0 ? (
        <div className="flex flex-col">
          <h3 className="pb-1.5 text-sm font-semibold">Relied on</h3>
          <ul className="flex flex-col">
            {uses.slice(0, 6).map((use) => (
              <li
                key={use.key}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2.5 text-sm",
                  DESK_ROW,
                )}
              >
                <span className="min-w-0">{use.summary}</span>
                <span className="text-xs text-(--m-muted) tabular-nums">
                  {whenLabel(use.at, context.nowMs)}
                </span>
                <span
                  className={cn(
                    "col-span-2 text-xs",
                    use.broken ? "text-(--m-negative)" : "text-(--m-muted)",
                  )}
                >
                  {use.broken ? `Broken by ${use.by}` : use.by}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {row.changeRequests.resolved.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-(--m-muted)">
          {row.changeRequests.resolved.map((request) => (
            <li key={request.id}>
              {`${CHANGE_REQUEST_STATUS_LABEL[request.status]}: ${request.request}`}
              {request.masterResponse ? ` (${request.masterResponse})` : ""}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => toggle("quote")}>
          Edit wording
        </Button>
        <Button size="sm" variant="outline" onClick={() => toggle("activation")}>
          Edit when
        </Button>
        <Button size="sm" variant="ghost-muted" onClick={() => void toggleRuleRetired(rule)}>
          {rule.status === "active" ? "Retire" : "Restore"}
        </Button>
        <Button size="sm" variant="ghost-muted" onClick={() => toggle("ask")}>
          Ask the master
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
          submitLabel="Save"
          onSubmit={async (activation) => {
            const done = await editRule(rule, { activation });
            if (done) setEditing(null);
            return done;
          }}
        />
      ) : null}
      {editing === "ask" ? (
        <AskMasterForm
          missionId={context.missionId}
          title={rule.number === null ? rule.title : `${ruleLabel(rule)}: ${rule.title}`}
          kind="change"
          onDone={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function ChangeRequestItem(props: { request: RuleChangeRequest }) {
  const { request } = props;
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-(--m-raised) px-4 py-3.5">
      <p className="text-sm">
        <span className="font-semibold">Change requested. </span>
        {request.request}
      </p>
      {request.proposedQuote ? (
        <p className="text-sm text-(--m-muted)">{request.proposedQuote}</p>
      ) : null}
      <TextActionForm
        label="Response"
        placeholder="Response (needed to decline)"
        submitLabel="Apply"
        onSubmit={(response) => resolveRuleChange(request.id, "apply", response)}
      />
      <TextActionForm
        label="Why decline it?"
        placeholder="Why decline it?"
        submitLabel="Decline"
        onSubmit={(response) => resolveRuleChange(request.id, "decline", response)}
      />
    </div>
  );
}
