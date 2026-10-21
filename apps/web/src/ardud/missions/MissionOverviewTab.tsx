import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckIcon, MessagesSquareIcon } from "lucide-react";

import {
  VIEW_BUILTIN_SECTION_TITLES,
  type FeedItem,
  type MissionId,
  type MissionOverview,
  type MissionRecordRef,
} from "@t3tools/contracts";
import {
  ageView,
  clockOrDay,
  criticalPathView,
  directionCheckRows,
  formatCountdown,
  formatDayLabel,
  isDraftFeedItem,
  masterRoutedEntries,
  orderBlockerGroups,
  ownerWaitingEntries,
  refKey,
  refLabel,
  resolveMissionLayout,
  snoozedEntries,
  splitFeed,
  type DirectionCheckRow,
  type MissionInboxSnapshot,
  type MissionOverviewSnapshot,
  type MissionViewsState,
  type OwnerRequest,
  type ResolvedViewLayout,
  type ViewSectionEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { BoardLead, LanesPanel, RestartNotice } from "./BoardPanels";
import { AgeElement, ByMarker, Chip, PersonChip, RefChip, StateGlyph } from "./cards/chips";
import { OpenDiscussions, useCardDiscussion } from "./DiscussPanel";
import { markMissionSeen, reactToCall } from "./missionCommands";
import { useMissionInbox, useMissionViews, useYourRequests } from "./missionsStore";
import { MILESTONE_BADGE_VARIANT, MILESTONE_LABEL } from "./missionTone";
import { PriorityStack } from "./PriorityStack";
import {
  NeedsYouSection,
  OWNER_WAITING_TABS,
  PinnedStrip,
  WithTheMasterSection,
} from "./sections/NeedsYou";
import { CustomSection } from "./sections/CustomSection";
import { FoldButton, LoadingRows, SectionCount, SectionShell } from "./sections/SectionShell";
import {
  RequestThread,
  unreadRequests,
  useRequestOpener,
  YourRequestsSection,
} from "./sections/YourRequests";

/**
 * The mission board: sections from the mission's layout, main column and side
 * column. A hidden section that still holds something for the owner leaves a
 * pinned strip under the head.
 */
export function MissionOverviewTab(props: {
  overview: MissionOverviewSnapshot;
  nowMs: number;
  highlightSubMissionId: string | null;
  openRequestId: string | null;
}) {
  const { overview, nowMs } = props;
  const missionId = overview.mission.id;
  const views = useMissionViews(missionId);
  const inbox = useMissionInbox(missionId);
  const requests = useYourRequests(missionId);
  const waiting = useMemo(() => (inbox ? ownerWaitingEntries(inbox).length : undefined), [inbox]);
  const unread = useMemo(() => unreadRequests(requests), [requests]);
  // The page's own inbox and request counts drive the pinned strip, so it
  // matches what the page shows even between views pushes.
  const layout = useMemo(
    () =>
      views
        ? resolveMissionLayout(views.snapshot, {
            ...(waiting === undefined ? {} : { ownerWaiting: waiting }),
            ...(requests === undefined ? {} : { requestsUnread: unread.length }),
          })
        : null,
    [views, waiting, requests, unread.length],
  );
  // A request opened from a link still opens when its section is hidden.
  const requestsShown =
    layout?.main.some((section) => section.kind === "your-requests") === true ||
    layout?.rail.some((section) => section.kind === "your-requests") === true;
  const looseRequest =
    views !== undefined && !requestsShown
      ? (requests?.find((request) => request.id === props.openRequestId) ?? null)
      : null;
  const openRequest = useRequestOpener(missionId);
  const shown = layout ? discussedOnBoard(layout, inbox, overview, nowMs) : [];

  const context: SectionContext | null =
    views && layout
      ? {
          overview,
          nowMs,
          inbox,
          requests,
          views,
          layout,
          highlightSubMissionId: props.highlightSubMissionId,
          openRequestId: props.openRequestId,
        }
      : null;

  const showFigures =
    layout === null || layout.header.some((entry) => entry.kind === "header-stats");
  // The lanes panel sits under Needs you, or at the top of the rail.
  const rail = context?.layout.rail ?? [];
  const lanesAt = rail.findIndex((section) => section.kind === "needs-you") + 1;
  const railSections: Array<ViewSectionEntry | typeof LANES> = [
    ...rail.slice(0, lanesAt),
    LANES,
    ...rail.slice(lanesAt),
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <RestartNotice missionId={missionId} recovery={overview.recovery} />
      <BoardLead
        overview={overview}
        inbox={inbox}
        requests={requests}
        showFigures={showFigures}
        nowMs={nowMs}
      />
      {context?.layout.pinned.needsYou ? (
        <PinnedStrip
          missionId={missionId}
          views={context.views}
          layout={context.layout}
          kind="needs-you"
          inbox={inbox}
          nowMs={nowMs}
        />
      ) : null}
      {context?.layout.pinned.requests ? (
        <PinnedStrip
          missionId={missionId}
          views={context.views}
          layout={context.layout}
          kind="your-requests"
          requests={unread}
          nowMs={nowMs}
        />
      ) : null}
      {looseRequest ? (
        <section aria-label="Your request" className="flex max-w-160 min-w-0 flex-col">
          <RequestThread
            key={looseRequest.id}
            request={looseRequest}
            nowMs={nowMs}
            onBack={() => openRequest(null)}
            heading="h2"
          />
        </section>
      ) : null}
      {context ? (
        // The side column comes first on narrow screens, so it does in the DOM too.
        <div className="grid min-w-0 gap-4 lg:grid-cols-12">
          <aside
            aria-label="Side column"
            className="flex min-w-0 flex-col gap-4 lg:col-span-5 lg:col-start-8 lg:row-start-1 2xl:col-span-6 2xl:col-start-7"
          >
            {railSections.map((section) =>
              section === LANES ? (
                <LanesPanel
                  key="lanes"
                  missionId={missionId}
                  counts={overview.lanes}
                  nowMs={nowMs}
                />
              ) : (
                <OverviewSection key={section.key} section={section} context={context} />
              ),
            )}
          </aside>
          <div className="flex min-w-0 flex-col gap-4 lg:col-span-7 lg:col-start-1 lg:row-start-1 2xl:col-span-6">
            {inbox ? <OpenDiscussions missionId={missionId} shown={shown} nowMs={nowMs} /> : null}
            {context.layout.main.map((section) => (
              <OverviewSection key={section.key} section={section} context={context} />
            ))}
          </div>
        </div>
      ) : views === null ? null : (
        <LoadingRows />
      )}
    </div>
  );
}

/** Marks where the lanes panel goes in the rail. */
const LANES = "lanes" as const;

/**
 * Records whose card on this board carries its discussion, folded or not.
 * Feed rows carry none, so a feed item still counts as loose.
 */
function discussedOnBoard(
  layout: ResolvedViewLayout,
  inbox: MissionInboxSnapshot | undefined,
  overview: MissionOverviewSnapshot,
  nowMs: number,
): Array<Pick<MissionRecordRef, "kind" | "id">> {
  const visible = new Set([...layout.main, ...layout.rail].map((section) => section.kind));
  const entries = [
    ...(inbox && visible.has("needs-you")
      ? [...ownerWaitingEntries(inbox, nowMs), ...snoozedEntries(inbox, nowMs, OWNER_WAITING_TABS)]
      : []),
    ...(inbox && visible.has("with-the-master") ? masterRoutedEntries(inbox) : []),
  ];
  return [
    ...entries.map((entry) => ({ kind: entry.kind, id: entry.record.id })),
    ...(visible.has("since-last-looked")
      ? directionCheckRows(overview.directionCheck).map((row) => row.item.ref)
      : []),
  ];
}

interface SectionContext {
  readonly overview: MissionOverviewSnapshot;
  readonly nowMs: number;
  readonly inbox: MissionInboxSnapshot | undefined;
  readonly requests: ReadonlyArray<OwnerRequest> | undefined;
  readonly views: MissionViewsState;
  readonly layout: ResolvedViewLayout;
  readonly highlightSubMissionId: string | null;
  readonly openRequestId: string | null;
}

function OverviewSection(props: { section: ViewSectionEntry; context: SectionContext }) {
  const { section, context } = props;
  const missionId = context.overview.mission.id;
  const common = {
    missionId,
    views: context.views,
    layout: context.layout,
    section,
    nowMs: context.nowMs,
  };
  switch (section.kind) {
    case "needs-you":
      return <NeedsYouSection {...common} inbox={context.inbox} />;
    case "with-the-master":
      return <WithTheMasterSection {...common} inbox={context.inbox} />;
    case "your-requests":
      return (
        <YourRequestsSection
          {...common}
          requests={context.requests}
          openId={context.openRequestId}
        />
      );
    case "sub-missions":
      return (
        <SubMissionsSection
          {...common}
          overview={context.overview}
          highlightId={context.highlightSubMissionId}
        />
      );
    case "since-last-looked":
      return <SinceLastLookedSection {...common} overview={context.overview} />;
    case "path-to-milestone":
      return <PathSection {...common} overview={context.overview} />;
    case "custom":
      return <CustomSection {...common} />;
    // The stats row is the board's figures.
    case "header-stats":
      return null;
  }
}

interface SectionProps {
  readonly missionId: MissionId;
  readonly views: MissionViewsState;
  readonly layout: ResolvedViewLayout;
  readonly section: ViewSectionEntry;
  readonly nowMs: number;
}

// ---------------------------------------------------------------------------
// Sub-missions

function SubMissionsSection(
  props: SectionProps & { overview: MissionOverviewSnapshot; highlightId: string | null },
) {
  const { overview } = props;
  if (overview.subMissions.length === 0) return null;
  return (
    <SectionShell
      missionId={props.missionId}
      views={props.views}
      layout={props.layout}
      section={props.section}
      meta={
        <SectionCount
          count={overview.subMissions.length}
          label={`${overview.subMissions.length} sub-missions`}
        />
      }
    >
      <PriorityStack
        mission={overview.mission}
        subMissions={overview.subMissions}
        changes={overview.changes}
        highlightId={props.highlightId}
      />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Since you last looked: the master's calls to check, then the feed

const FEED_KIND_LABEL: Record<FeedItem["kind"], string> = {
  shipped: "shipped",
  decided: "decision",
  blocked: "blocker",
  milestone: "milestone",
  note: "note",
};

const FEED_KIND_TONE: Partial<Record<FeedItem["kind"], "accent" | "negative">> = {
  decided: "accent",
  blocked: "negative",
};

function SinceLastLookedSection(props: SectionProps & { overview: MissionOverviewSnapshot }) {
  const { overview, nowMs } = props;
  const sections = useMemo(
    () => splitFeed(overview.feed, overview.ownerLastLookedAt),
    [overview.feed, overview.ownerLastLookedAt],
  );
  const [open, setOpen] = useState(false);
  const calls = useMemo(
    () => directionCheckRows(overview.directionCheck),
    [overview.directionCheck],
  );
  if (overview.feed.length === 0 && calls.length === 0) return null;
  // Every new row shows in full; only rows he has already seen sit behind the fold.
  const rows = open ? [...sections.fresh, ...sections.earlier] : sections.fresh;
  const hidden = sections.fresh.length + sections.earlier.length - rows.length;
  const looked = overview.ownerLastLookedAt;
  return (
    <SectionShell
      missionId={props.missionId}
      views={props.views}
      layout={props.layout}
      section={props.section}
      meta={
        looked ? (
          <time dateTime={looked} className="text-sm text-(--m-muted) tabular-nums">
            {clockOrDay(looked, nowMs)}
          </time>
        ) : null
      }
      aside={
        sections.fresh.length > 0 || calls.length > 0 ? (
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() => void markMissionSeen(overview.mission.id)}
          >
            Mark seen
          </Button>
        ) : null
      }
    >
      {calls.length > 0 ? (
        <ul aria-label="Calls to check" className="flex min-w-0 flex-col">
          {calls.map((row) => (
            <CallRow
              key={`${refKey(row.item.ref)}-${row.item.at}`}
              row={row}
              missionId={overview.mission.id}
              nowMs={nowMs}
            />
          ))}
        </ul>
      ) : null}
      {rows.length > 0 ? (
        <ul aria-label="Feed" className="mt-1 flex min-w-0 flex-col">
          {rows.map((item) => (
            <FeedRow
              key={`${item.at}-${item.ref ? refKey(item.ref) : item.summary}`}
              item={item}
              missionId={overview.mission.id}
              nowMs={nowMs}
            />
          ))}
        </ul>
      ) : null}
      <FoldButton hidden={hidden} onShow={() => setOpen(true)} />
    </SectionShell>
  );
}

function CallRow(props: { row: DirectionCheckRow; missionId: MissionId; nowMs: number }) {
  const { item, count, reason } = props.row;
  const [busy, setBusy] = useState(false);
  const age = ageView(item.at, props.nowMs);
  // Only calls take "Fine"; structural changes (lanes, roles, rules) are
  // cleared by Mark seen. Discuss is a request about the record either way.
  const isCall = item.ref.kind === "call";
  const discussion = useCardDiscussion(props.missionId, item.ref, props.nowMs);
  const accept = () => {
    setBusy(true);
    void reactToCall(item.ref.id, "ok").then(() => setBusy(false));
  };
  return (
    <li className="grid min-w-0 grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 border-t border-(--m-rule) py-2.5 first:border-t-0 first:pt-0">
      <span className="pt-1">
        <ByMarker by="master" label="The master's call" />
      </span>
      <div className="min-w-0">
        <p className="text-sm text-pretty">
          {item.summary}
          {count > 1 ? (
            <span className="ms-1.5 inline-flex rounded-full bg-(--m-chip) px-1.5 text-xs tabular-nums text-(--m-muted)">
              {count}
              <span className="sr-only"> times</span>
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-xs text-pretty text-(--m-muted)">{reason}</p>
      </div>
      <span className="inline-flex items-center gap-2">
        {discussion.symbol}
        {age ? <AgeElement age={age} at={item.at} /> : null}
      </span>
      <div className="col-start-2 col-end-4 flex items-center gap-1.5">
        {isCall ? (
          <Button variant="ghost-muted" size="sm" disabled={busy} onClick={accept}>
            <CheckIcon aria-hidden />
            Fine
          </Button>
        ) : null}
        {discussion.action ? (
          <Button variant="ghost-muted" size="sm" onClick={discussion.action.onRun}>
            <MessagesSquareIcon aria-hidden />
            {discussion.action.label}
          </Button>
        ) : null}
      </div>
      {discussion.panel ? <div className="col-start-2 col-end-4">{discussion.panel}</div> : null}
    </li>
  );
}

function FeedRow(props: { item: FeedItem; missionId: string; nowMs: number }) {
  const { item } = props;
  return (
    <li className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-px py-2.25 not-first:border-t not-first:border-(--m-rule)">
      <time dateTime={item.at} className="text-xs text-(--m-muted) tabular-nums">
        {clockOrDay(item.at, props.nowMs)}
      </time>
      <span className="min-w-0 text-sm text-pretty wrap-anywhere">{item.summary}</span>
      <span className="row-span-2 self-start">
        <Chip {...(FEED_KIND_TONE[item.kind] ? { tone: FEED_KIND_TONE[item.kind] } : {})}>
          {FEED_KIND_LABEL[item.kind]}
        </Chip>
      </span>
      {isDraftFeedItem(item) ? (
        <Link
          to="/missions/inbox"
          search={{ mission: props.missionId }}
          className="col-start-2 justify-self-start rounded-sm text-xs text-(--m-accent-text) underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          Review draft
        </Link>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Path to the next milestone: the critical path, who holds the rest, milestones

function PathSection(props: SectionProps & { overview: MissionOverviewSnapshot }) {
  const { overview, nowMs } = props;
  const path = useMemo(
    () => criticalPathView(overview.criticalPath, overview.blockers),
    [overview.criticalPath, overview.blockers],
  );
  const holders = useMemo(
    () => orderBlockerGroups(overview.blockers).filter((group) => group.holder._tag !== "owner"),
    [overview.blockers],
  );
  const milestones = useMemo(
    () =>
      [...overview.milestones].sort((left, right) =>
        (left.targetAt ?? "").localeCompare(right.targetAt ?? ""),
      ),
    [overview.milestones],
  );
  if (path.steps.length === 0 && holders.length === 0 && milestones.length === 0) return null;
  const target = milestones.find((milestone) => milestone.targetAt !== null)?.targetAt ?? null;
  // A renamed section keeps its name; the built-in one names the date.
  const renamed = props.section.title !== VIEW_BUILTIN_SECTION_TITLES["path-to-milestone"];
  const heading = !renamed && target ? `Path to ${formatDayLabel(target)}` : undefined;
  return (
    <SectionShell
      missionId={props.missionId}
      views={props.views}
      layout={props.layout}
      section={props.section}
      {...(heading ? { title: heading } : {})}
      meta={
        path.steps.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-(--m-muted) tabular-nums">
            {path.blockedCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-(--m-negative)">
                <StateGlyph kind="bad" />
                {path.blockedCount} blocked
              </span>
            ) : null}
            <span>of {path.steps.length}</span>
          </span>
        ) : null
      }
      aside={
        target ? (
          <span className="text-xs text-(--m-muted) tabular-nums">
            {formatCountdown(target, nowMs)}
          </span>
        ) : null
      }
    >
      {path.steps.length > 0 ? (
        <ol aria-label="Critical path" className="flex min-w-0 flex-col gap-1.5">
          {path.steps.map((step) => (
            <li
              key={refKey(step.ref)}
              className="grid min-w-0 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2"
            >
              <StateGlyph
                kind={step.heldBy ? "bad" : "idle"}
                label={step.heldBy ? "Blocked" : "Not blocked"}
              />
              <span className="min-w-0 truncate text-sm">{refLabel(step.ref)}</span>
              {step.heldBy ? (
                <PersonChip
                  kind={
                    step.heldBy === "you" ? "you" : step.heldBy === "master" ? "master" : "person"
                  }
                  name={step.heldBy === "you" ? "You" : step.heldBy}
                  prefix="Ball with "
                />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {holders.length > 0 ? (
        <ul aria-label="Who holds the ball" className="flex min-w-0 flex-col gap-2">
          {holders.map((group) => (
            <li key={group.holderLabel} className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                <PersonChip kind="person" name={group.holderLabel} prefix="Held by " />
                <span className="text-xs text-(--m-muted) tabular-nums">{group.items.length}</span>
              </div>
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {group.items.map((item) => (
                  <RefChip key={refKey(item)} record={item} />
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {milestones.length > 0 ? <Milestones milestones={milestones} /> : null}
    </SectionShell>
  );
}

function Milestones(props: { milestones: MissionOverview["milestones"] }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button size="xs" variant="ghost-muted" className="self-start" onClick={() => setOpen(true)}>
        Milestones ({props.milestones.length})
      </Button>
    );
  }
  return (
    <ul aria-label="Milestones" className="flex min-w-0 flex-col gap-1.5">
      {props.milestones.map((milestone) => (
        <li key={milestone.id} className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant={MILESTONE_BADGE_VARIANT[milestone.status]} size="sm">
              {MILESTONE_LABEL[milestone.status]}
            </Badge>
            <span className={cn("min-w-0 truncate text-sm")}>{milestone.title}</span>
            {milestone.targetAt ? (
              <span className="ms-auto shrink-0 text-xs text-(--m-muted) tabular-nums">
                {formatDayLabel(milestone.targetAt)}
              </span>
            ) : null}
          </div>
          {milestone.statusNote ? (
            <p className="text-xs text-pretty text-(--m-muted)">{milestone.statusNote}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
