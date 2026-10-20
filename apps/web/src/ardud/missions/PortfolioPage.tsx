import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { MissionListItem } from "@t3tools/contracts";
import {
  formatDayLabel,
  formatTimeOfDay,
  healthCounts,
  healthLabel,
  laneTotal,
  portfolioBar,
  missionSlug,
  orderBarDrop,
  portfolioChanges,
  portfolioFacts,
  portfolioPools,
  portfolioSummary,
  portfolioView,
  type PortfolioBar,
  type PortfolioRow,
  type PortfolioSnapshot,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { HealthGlyph, needsYouLabel } from "./cards/chips";
import { DESK_ROW, Figure, PageLine } from "./deskParts";
import { toggleMissionPaused } from "./missionCommands";
import { MissionSection } from "./MissionSection";
import { useMissionList, useMissionOverview, usePortfolio } from "./missionsStore";
import { createMission, reorderPortfolio, revertChange } from "./deskCommands";
import { RevertButton, TextActionForm } from "./MissionForms";
import { movePortfolioMission } from "./operationCommands";
import { useNowMs } from "./useNowMs";
import { OfflineLine } from "./sections/FeedError";
import { useMissionsOffline } from "./useMissionsConnection";

// All missions: the order bar of guaranteed shares, one card per mission in
// priority order, and the shared pools and recent changes beside them. The
// owner and the masters reorder it the same way (portfolioViewModel).

export function PortfolioPage() {
  const snapshot = usePortfolio();
  const list = useMissionList();
  const offline = useMissionsOffline();
  const nowMs = useNowMs();
  const listed = useMemo(
    () => new Map((list?.missions ?? []).map((mission) => [mission.id as string, mission])),
    [list],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--m-ground) text-(--m-text)">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          className="relative bg-(--m-ground)"
        >
          <WorkspaceBreadcrumb ariaLabel="All missions" className="overflow-hidden">
            <WorkspaceBreadcrumbItem current>
              <WorkspaceBreadcrumbText>All missions</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide" className="min-h-full gap-5">
            <h1 className="text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
              All missions
            </h1>
            {!snapshot ? (
              // ardud missions: fix-p3 - offline, say so instead of loading forever
              offline !== null ? (
                <OfflineLine />
              ) : (
                <p className="text-sm text-(--m-muted)">Loading…</p>
              )
            ) : (
              <Portfolio snapshot={snapshot} listed={listed} nowMs={nowMs} />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function Portfolio(props: {
  snapshot: PortfolioSnapshot;
  listed: ReadonlyMap<string, MissionListItem>;
  nowMs: number;
}) {
  // A dropped order shows at once and gives way to the next snapshot.
  const [dropped, setDropped] = useState<{
    base: PortfolioSnapshot["order"];
    order: PortfolioSnapshot["order"];
  } | null>(null);
  const order =
    dropped && dropped.base === props.snapshot.order ? dropped.order : props.snapshot.order;
  const view = useMemo(() => portfolioView({ ...props.snapshot, order }), [props.snapshot, order]);
  const bar = portfolioBar(view);
  const pools = portfolioPools(view);
  const changes = portfolioChanges(props.snapshot);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <PageLine
        actions={
          <Button size="sm" variant="outline" onClick={() => setAdding((on) => !on)}>
            New mission
          </Button>
        }
      >
        {portfolioSummary(bar).map((part) =>
          typeof part === "string" ? part : <Figure key={part.key}>{part.figure}</Figure>,
        )}
      </PageLine>
      {adding ? (
        <div className="flex flex-col gap-2 rounded-3xl bg-(--m-surface) p-4 sm:p-5">
          <h2 className="text-sm font-semibold">New mission</h2>
          <TextActionForm
            label="Mission name"
            submitLabel="Create"
            onSubmit={async (title) => {
              // Slugs aren't on the client; missions made here slug their title.
              const taken = props.snapshot.missions.map((mission) => missionSlug(mission.title));
              const missionId = await createMission(title, taken);
              if (missionId === null) return false;
              setAdding(false);
              void navigate({ to: "/missions/$missionId", params: { missionId } });
              return true;
            }}
          />
        </div>
      ) : null}
      <OrderBar
        bar={bar}
        onDrop={(activeId, overId) => {
          const next = orderBarDrop(order, activeId, overId);
          if (next === null) return;
          const base = props.snapshot.order;
          setDropped({ base, order: next.order });
          void reorderPortfolio(next).then((ok) => {
            if (!ok) setDropped(null);
          });
        }}
      />
      <div className="grid items-start gap-4 lg:grid-cols-12">
        <ol className="flex min-w-0 flex-col gap-4 lg:col-span-8">
          {view.rows.map((row, index) => (
            <li key={row.mission.missionId}>
              <MissionCard
                row={row}
                listed={props.listed.get(row.mission.missionId)}
                order={order}
                above={view.rows[index - 1]?.mission.missionId}
                below={view.rows[index + 1]?.mission.missionId}
              />
            </li>
          ))}
        </ol>
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-4">
          {pools.length > 0 ? (
            <MissionSection title="Pools" caption={String(pools.length)}>
              <ul className="flex flex-col">
                {pools.map((pool) => (
                  <li key={pool.poolId} className={cn(DESK_ROW, "flex flex-col gap-0.5 py-2.5")}>
                    <div className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {pool.label}
                      </span>
                      {pool.runOutAt ? (
                        <span className="shrink-0 text-xs text-(--m-warning) tabular-nums">
                          Runs out {clock(pool.runOutAt, props.nowMs)}
                        </span>
                      ) : null}
                    </div>
                    <span className="truncate text-xs text-(--m-muted) tabular-nums">
                      {pool.line}
                    </span>
                  </li>
                ))}
              </ul>
            </MissionSection>
          ) : null}
          {changes.length > 0 ? (
            <MissionSection title="Changes" caption={String(changes.length)}>
              <ul className="flex flex-col">
                {changes.map((change) => (
                  <li
                    key={change.key}
                    className={cn(
                      DESK_ROW,
                      "grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 py-2.5 text-sm",
                    )}
                  >
                    <span className="text-xs text-(--m-muted) tabular-nums">
                      {clock(change.at, props.nowMs)}
                    </span>
                    <span className="min-w-0">{change.text}</span>
                    <span className="col-start-2 flex items-center gap-2 text-xs text-(--m-muted)">
                      by {change.by}
                      {change.revert ? (
                        <RevertButton
                          label={`Revert ${change.text}`}
                          onRevert={() => revertChange(change.revert!)}
                        />
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </MissionSection>
          ) : null}
        </div>
      </div>
    </>
  );
}

const BAR_TONE = [
  "bg-(--m-bar-1) text-(--m-ground)",
  "bg-(--m-bar-2) text-(--m-ground)",
  "bg-(--m-bar-3) text-(--m-text)",
  "bg-(--m-bar-4) text-(--m-text)",
];

/**
 * Guaranteed shares in priority order, then the free part; a paused mission
 * sits quiet. Each share drags (pointer, or Space and arrow keys) to reorder.
 */
function OrderBar(props: {
  bar: PortfolioBar;
  onDrop: (activeId: string, overId: string | null) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const shares = props.bar.shares;
  const titleOf = (id: string | number) =>
    shares.find((share) => share.missionId === id)?.title ?? String(id);
  const handleDragEnd = (event: DragEndEvent) =>
    props.onDrop(String(event.active.id), event.over ? String(event.over.id) : null);
  return (
    <div className="flex h-10 gap-0.75 overflow-hidden rounded-xl">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
        accessibility={{
          announcements: {
            onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}.`,
            onDragOver: ({ active, over }) =>
              over ? `${titleOf(active.id)} is over ${titleOf(over.id)}.` : undefined,
            onDragEnd: ({ active, over }) =>
              over ? `${titleOf(active.id)} moved to ${titleOf(over.id)}'s place.` : undefined,
            onDragCancel: ({ active }) => `${titleOf(active.id)} stays where it was.`,
          },
        }}
      >
        <SortableContext
          items={shares.map((share) => share.missionId)}
          strategy={horizontalListSortingStrategy}
        >
          <ol aria-label="Priority order" className="contents">
            {shares.map((share, index) => (
              <OrderBarShare
                key={share.missionId}
                id={share.missionId}
                label={share.title}
                share={share.share}
                position={index + 1}
                tone={
                  share.paused
                    ? "bg-(--m-bar-4) text-(--m-muted)"
                    : (BAR_TONE[index % BAR_TONE.length] ?? "")
                }
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {props.bar.free > 0 ? (
        <span
          style={{ flex: `${props.bar.free} 1 0` }}
          className="flex min-w-1 items-center truncate bg-(--m-surface) px-3 text-xs font-medium text-(--m-muted) tabular-nums"
        >
          {props.bar.free >= 0.12 ? `Free ${percent(props.bar.free)}` : null}
        </span>
      ) : null}
    </div>
  );
}

function OrderBarShare(props: {
  id: string;
  label: string;
  share: number;
  position: number;
  tone: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{
        flex: `${props.share} 1 0`,
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn("flex min-w-1", isDragging && "relative z-10")}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${props.label} ${percent(props.share)}, position ${props.position}. Drag to reorder.`}
        className={cn(
          "flex min-w-0 flex-1 cursor-grab touch-pan-y items-center truncate px-3 text-xs font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset active:cursor-grabbing",
          props.tone,
        )}
      >
        {props.share >= 0.12 ? `${props.label} ${percent(props.share)}` : null}
      </button>
    </li>
  );
}

function MissionCard(props: {
  row: PortfolioRow;
  listed: MissionListItem | undefined;
  order: PortfolioSnapshot["order"];
  above: PortfolioSnapshot["order"][number] | undefined;
  below: PortfolioSnapshot["order"][number] | undefined;
}) {
  const { mission } = props.row;
  const overview = useMissionOverview(mission.missionId);
  const paused = mission.status === "paused";
  const listed = props.listed;
  const subs = listed ? healthCounts(listed.subMissions) : [];
  const facts = [
    ...portfolioFacts(props.row),
    ...(listed ? [{ label: "Lanes", value: String(laneTotal(listed.lanes)) }] : []),
  ];
  const bottomLine = overview?.bottomLine.trim();
  return (
    <article
      aria-labelledby={`portfolio-${mission.missionId}`}
      className="flex min-w-0 flex-col gap-3 rounded-3xl bg-(--m-surface) px-4.5 pt-4 pb-4.5 sm:px-6 sm:pt-5 sm:pb-5.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {listed ? (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-(--m-raised) px-2.5 font-medium">
            <HealthGlyph health={listed.health} paused={paused} />
            {paused ? "Paused" : healthLabel(listed.health)}
          </span>
        ) : null}
        <span className="text-(--m-muted)">{mission.tier}</span>
      </div>
      <h2
        id={`portfolio-${mission.missionId}`}
        className={cn(
          "text-xl leading-tight font-medium sm:text-2xl",
          paused && "text-(--m-muted)",
        )}
      >
        <Link
          to="/missions/$missionId"
          params={{ missionId: mission.missionId }}
          className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset"
        >
          {mission.title}
        </Link>
      </h2>
      {bottomLine ? <p className="max-w-prose text-sm">{bottomLine}</p> : null}
      {listed && !paused ? (
        <p className="text-sm">
          {listed.needsYou > 0 ? (
            <span className="font-semibold text-(--m-accent-text)">
              {needsYouLabel(listed.needsYou)}
            </span>
          ) : (
            <span className="text-(--m-muted)">Nothing needs you.</span>
          )}
        </p>
      ) : null}
      {subs.length > 0 ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-(--m-muted) tabular-nums">
          {subs.map((sub) => (
            <span key={sub.health} className="inline-flex items-center gap-1.5">
              <HealthGlyph health={sub.health} />
              {sub.label}
            </span>
          ))}
        </p>
      ) : null}
      <dl className="grid grid-cols-3 gap-x-4 gap-y-3 border-t border-(--m-rule) pt-4 sm:grid-cols-5">
        {facts.map((fact) => (
          <div key={fact.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-(--m-muted)">{fact.label}</dt>
            <dd className="truncate text-lg leading-tight tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          render={<Link to="/missions/$missionId" params={{ missionId: mission.missionId }} />}
        >
          Open
        </Button>
        {mission.status === "active" || paused ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void toggleMissionPaused({
                missionId: mission.missionId,
                title: mission.title,
                paused,
              })
            }
          >
            {paused ? "Resume" : "Pause"}
          </Button>
        ) : null}
        {props.above ? (
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() =>
              props.above && void movePortfolioMission(props.order, mission.missionId, props.above)
            }
          >
            Move up
          </Button>
        ) : null}
        {props.below ? (
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() =>
              props.below && void movePortfolioMission(props.order, mission.missionId, props.below)
            }
          >
            Move down
          </Button>
        ) : null}
      </div>
    </article>
  );
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** A time today, else its day, in the reader's zone. */
function clock(atIso: string, nowMs: number): string {
  return formatDayLabel(atIso) === formatDayLabel(new Date(nowMs).toISOString())
    ? formatTimeOfDay(atIso)
    : formatDayLabel(atIso);
}
