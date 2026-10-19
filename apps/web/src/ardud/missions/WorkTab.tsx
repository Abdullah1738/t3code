import { useMemo, useState } from "react";

import type { MissionId, WorkItem } from "@t3tools/contracts";
import {
  ageView,
  OPEN_WORK_STAGES,
  workBoard,
  workFacts,
  type WorkQuery,
  type WorkRow,
} from "@t3tools/client-runtime/ardud/missions";

import { cn } from "../../lib/utils";
import { StateGlyph } from "./cards/chips";
import { DESK_ROW, DeskChip, Figure, FoldRow, PageLine, Segmented } from "./deskParts";
import { MissionSection } from "./MissionSection";
import { useMasterRoleId, useMissionOverview } from "./missionsStore";
import { useWorkFeed } from "./useMissionFeeds";

// Work tab: open work by holder (or stage), the stage strip, chains, the last
// finished items and the deferred register. Grouping lives in workViewModel.

const OPEN_QUERY: WorkQuery = { stages: OPEN_WORK_STAGES };
const DONE_QUERY: WorkQuery = { stages: ["done"], limit: 8 };
const MOVING_SHOWN = 8;
const REGISTER_SHOWN = 8;

type Grouping = "holder" | "stage";
const GROUPINGS = [
  { value: "holder", label: "Holder" },
  { value: "stage", label: "Stage" },
] as const;

export function WorkTab(props: { missionId: MissionId; nowMs: number }) {
  const open = useWorkFeed(props.missionId, OPEN_QUERY);
  const done = useWorkFeed(props.missionId, DONE_QUERY);
  const overview = useMissionOverview(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  const [grouping, setGrouping] = useState<Grouping>("holder");
  const board = useMemo(() => {
    if (!open) return null;
    const titles = new Map(
      (overview?.subMissions ?? []).map((sub) => [sub.id as string, sub.title]),
    );
    return workBoard(open.items, masterRoleId, titles);
  }, [open, overview, masterRoleId]);
  if (!board) return <p className="text-sm text-(--m-muted)">Loading work…</p>;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageLine
        actions={
          <Segmented label="Group by" value={grouping} options={GROUPINGS} onChange={setGrouping} />
        }
      >
        <Figure>{board.open}</Figure> open
        {board.withYou.length > 0 ? (
          <>
            , <Figure>{board.withYou.length}</Figure> with you
          </>
        ) : null}
        {board.blocked.length > 0 ? (
          <>
            , <Figure>{board.blocked.length}</Figure> blocked
          </>
        ) : null}
        .
        {board.register.length > 0 ? (
          <>
            {" "}
            <Figure>{board.register.length}</Figure> in the deferred register.
          </>
        ) : null}
      </PageLine>

      <ol className="grid grid-cols-4 gap-1 sm:grid-cols-7" aria-label="Open work by stage">
        {board.stages.map((stage) => (
          <li
            key={stage.stage}
            className="flex flex-col rounded-lg bg-(--m-surface) px-3.5 pt-3 pb-3.5 sm:rounded-none sm:first:rounded-s-xl sm:last:rounded-e-xl"
          >
            <span className="text-xs text-(--m-muted)">{stage.label}</span>
            <span className="text-2xl leading-tight text-(--m-text) tabular-nums">
              {stage.count}
            </span>
          </li>
        ))}
      </ol>

      <div className="grid min-w-0 gap-4 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-8 [&>*:last-child]:grow">
          {grouping === "holder" ? (
            <>
              <RowPanel title="With you" rows={board.withYou} nowMs={props.nowMs} />
              <RowPanel title="Blocked" rows={board.blocked} nowMs={props.nowMs} />
              <RowPanel
                title="Moving"
                rows={board.moving}
                nowMs={props.nowMs}
                shown={MOVING_SHOWN}
              />
            </>
          ) : (
            board.byStage.map((group) => (
              <RowPanel
                key={group.stage}
                title={group.label}
                rows={group.rows}
                nowMs={props.nowMs}
                shown={MOVING_SHOWN}
                hideStage
              />
            ))
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:col-span-4 [&>*:last-child]:grow">
          {board.chains.length > 0 ? (
            <MissionSection title="Chains" caption={board.chains.length}>
              <ul className="flex flex-col gap-2.5 text-sm">
                {board.chains.map((chain) => (
                  <li key={chain.id} className="flex min-w-0 flex-wrap items-baseline gap-1.5">
                    {chain.name ? (
                      <b className="w-20 shrink-0 truncate font-semibold">{chain.name}</b>
                    ) : null}
                    {chain.steps.map((step, index) => (
                      <span key={step.id} className="inline-flex min-w-0 items-baseline gap-1.5">
                        {index > 0 ? (
                          <span aria-hidden className="text-(--m-muted)">
                            →
                          </span>
                        ) : null}
                        <span className="min-w-0">{step.title}</span>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </MissionSection>
          ) : null}

          {done && done.total > 0 ? (
            <MissionSection title="Done" caption={done.total}>
              <ul className="flex flex-col text-sm">
                {done.items.map((item) => (
                  <DoneRow key={item.id} item={item} nowMs={props.nowMs} />
                ))}
              </ul>
            </MissionSection>
          ) : null}

          {board.register.length > 0 ? <RegisterPanel register={board.register} /> : null}
        </div>
      </div>
    </div>
  );
}

function RowPanel(props: {
  title: string;
  rows: ReadonlyArray<WorkRow>;
  nowMs: number;
  shown?: number;
  hideStage?: boolean;
}) {
  const [all, setAll] = useState(false);
  if (props.rows.length === 0) return null;
  const limit = props.shown ?? props.rows.length;
  const rows = all ? props.rows : props.rows.slice(0, limit);
  return (
    <MissionSection title={props.title} caption={props.rows.length}>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <WorkRowItem
            key={row.item.id}
            row={row}
            nowMs={props.nowMs}
            hideStage={props.hideStage === true}
          />
        ))}
      </ul>
      {all ? null : (
        <FoldRow hidden={props.rows.length - rows.length} onShow={() => setAll(true)} />
      )}
    </MissionSection>
  );
}

function WorkRowItem(props: { row: WorkRow; nowMs: number; hideStage: boolean }) {
  const { row } = props;
  const age = ageView(row.item.updatedAt, props.nowMs);
  return (
    <li
      className={cn(
        "grid grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-x-3.5 gap-y-0.5 py-2.75 text-sm",
        DESK_ROW,
      )}
    >
      <span className="self-center">
        <StateGlyph
          kind={row.glyph}
          label={row.glyph === "risk" ? "With you" : row.glyph === "bad" ? "Blocked" : "Moving"}
        />
      </span>
      <span className="min-w-0 truncate font-medium">{row.item.title}</span>
      <span className="flex items-center justify-end gap-3.5 whitespace-nowrap">
        {props.hideStage ? null : (
          <span className="hidden w-21 text-(--m-muted) sm:inline">{row.stageLabel}</span>
        )}
        {row.holder ? <DeskChip className="max-w-32.5">{row.holder.name}</DeskChip> : null}
        {age ? (
          <time
            dateTime={row.item.updatedAt}
            className="w-16 text-end text-xs text-(--m-muted) tabular-nums"
          >
            {age.label}
          </time>
        ) : null}
      </span>
      {row.reason ? (
        <span className="col-start-2 col-end-4 min-w-0 truncate text-xs text-(--m-muted)">
          {row.reason}
        </span>
      ) : null}
    </li>
  );
}

function DoneRow(props: { item: WorkItem; nowMs: number }) {
  const age = ageView(props.item.updatedAt, props.nowMs);
  const fact = workFacts(props.item)[0];
  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 py-2.5",
        DESK_ROW,
      )}
    >
      <span className="min-w-0 truncate">{props.item.title}</span>
      {age ? (
        <time dateTime={props.item.updatedAt} className="text-xs text-(--m-muted) tabular-nums">
          {age.label}
        </time>
      ) : null}
      {fact ? (
        <span className="col-span-2 min-w-0 truncate text-xs text-(--m-muted)">{fact}</span>
      ) : null}
    </li>
  );
}

function RegisterPanel(props: { register: ReturnType<typeof workBoard>["register"] }) {
  const [all, setAll] = useState(false);
  const rows = all ? props.register : props.register.slice(0, REGISTER_SHOWN);
  return (
    <MissionSection title="Deferred register" caption={props.register.length}>
      <ul className="flex flex-col text-sm">
        {rows.map((entry) => (
          <li
            key={entry.item.id}
            className={cn("grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 gap-y-0.5 py-2.5", DESK_ROW)}
          >
            <span className="text-(--m-muted) tabular-nums">{entry.registerId}</span>
            <span className="min-w-0">{entry.what}</span>
            {entry.trigger ? (
              <span
                className={cn(
                  "col-start-2 min-w-0 text-xs",
                  entry.fired ? "text-(--m-warning)" : "text-(--m-muted)",
                )}
              >
                {entry.fired ? `Fired: ${entry.trigger}` : entry.trigger}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {all ? null : (
        <FoldRow hidden={props.register.length - rows.length} onShow={() => setAll(true)} />
      )}
    </MissionSection>
  );
}
