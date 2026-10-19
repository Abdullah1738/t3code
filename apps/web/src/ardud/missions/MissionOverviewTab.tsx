import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckIcon, MessagesSquareIcon } from "lucide-react";

import {
  VIEW_BUILTIN_SECTION_TITLES,
  type DirectionCheckItem,
  type FeedItem,
  type MissionId,
  type MissionOverview,
} from "@t3tools/contracts";
import {
  ageView,
  criticalPathView,
  formatCountdown,
  formatDayLabel,
  formatRelative,
  isDraftFeedItem,
  openForkFor,
  orderBlockerGroups,
  ownerWaitingEntries,
  recoveryBanner,
  refKey,
  refLabel,
  resolveMissionLayout,
  splitFeed,
  type MissionInboxSnapshot,
  type MissionOverviewSnapshot,
  type MissionViewsState,
  type OwnerRequest,
  type ResolvedViewLayout,
  type ViewSectionEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/utils";
import { AgeElement, ByMarker, PersonChip, RefChip, StateGlyph } from "./cards/chips";
import { discussRecord, markMissionSeen, reactToCall } from "./missionCommands";
import {
  useMissionForks,
  useMissionInbox,
  useMissionViews,
  useOwnerRequests,
} from "./missionsStore";
import { MILESTONE_BADGE_VARIANT, MILESTONE_LABEL } from "./missionTone";
import { PriorityStack } from "./PriorityStack";
import { NeedsYouSection, PinnedStrip, WithTheMasterSection } from "./sections/NeedsYou";
import { FoldButton, SectionCount, SectionShell } from "./sections/SectionShell";
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
  const requests = useOwnerRequests(missionId);
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

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <RecoveryLine overview={overview} />
      <BottomLine overview={overview} nowMs={nowMs} />
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
        <div className="grid min-w-0 gap-x-10 gap-y-11 lg:grid-cols-[minmax(0,1fr)_340px]">
          <aside
            aria-label="Side column"
            className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(300px,1fr))] content-start gap-x-10 gap-y-11 lg:col-start-2 lg:row-start-1 lg:grid-cols-1"
          >
            {context.layout.rail.map((section) => (
              <OverviewSection key={section.key} section={section} context={context} />
            ))}
          </aside>
          <div className="flex min-w-0 flex-col gap-11 lg:col-start-1 lg:row-start-1">
            {context.layout.main.map((section) => (
              <OverviewSection key={section.key} section={section} context={context} />
            ))}
          </div>
        </div>
      ) : views === null ? null : (
        <div aria-hidden className="flex flex-col gap-3">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      )}
    </div>
  );
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
    // The stats row lives in the mission header; custom sections render once
    // the server answers their queries (views track, later round).
    case "header-stats":
    case "custom":
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

/** Shown while a restart incident still has threads to resume or decide. */
function RecoveryLine(props: { overview: MissionOverviewSnapshot }) {
  const line = recoveryBanner(props.overview.recovery);
  if (!line) return null;
  return (
    <Link
      to="/missions/$missionId"
      params={{ missionId: props.overview.mission.id }}
      search={{ tab: "roles" }}
      className="flex min-w-0 items-center gap-2 rounded-sm text-sm text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <StateGlyph kind="risk" />
      {line}
    </Link>
  );
}

function BottomLine(props: { overview: MissionOverview; nowMs: number }) {
  const { overview } = props;
  if (overview.bottomLine.length === 0) return null;
  const age = overview.bottomLineAt ? ageView(overview.bottomLineAt, props.nowMs) : null;
  return (
    <section aria-label="Bottom line" className="flex min-w-0 items-start gap-2.5">
      <ByMarker by="master" label="The master's bottom line" />
      <p className="min-w-0 flex-1 text-sm leading-5.5 text-pretty">{overview.bottomLine}</p>
      {age && overview.bottomLineAt ? <AgeElement age={age} at={overview.bottomLineAt} /> : null}
    </section>
  );
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

const FEED_GLYPH = {
  shipped: "done",
  decided: "ok",
  blocked: "bad",
  milestone: "risk",
  note: "idle",
} as const;

const FEED_KIND_LABEL: Record<FeedItem["kind"], string> = {
  shipped: "Shipped",
  decided: "Decided",
  blocked: "Blocked",
  milestone: "Milestone",
  note: "Note",
};

/** Feed rows shown before the fold. */
const FIRST_FEED_ROWS = 6;

function SinceLastLookedSection(props: SectionProps & { overview: MissionOverviewSnapshot }) {
  const { overview, nowMs } = props;
  const forks = useMissionForks(overview.mission.id) ?? [];
  const sections = useMemo(
    () => splitFeed(overview.feed, overview.ownerLastLookedAt),
    [overview.feed, overview.ownerLastLookedAt],
  );
  const [open, setOpen] = useState(false);
  const calls = overview.directionCheck;
  if (overview.feed.length === 0 && calls.length === 0) return null;
  const rows = open
    ? [...sections.fresh, ...sections.earlier]
    : sections.fresh.slice(0, FIRST_FEED_ROWS);
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
          <time dateTime={looked} className="text-xs text-muted-foreground tabular-nums">
            {formatRelative(looked, nowMs)}
          </time>
        ) : null
      }
      aside={
        sections.fresh.length > 0 || calls.length > 0 ? (
          <Button
            size="xs"
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
          {calls.map((item) => (
            <CallRow
              key={refKey(item.ref)}
              item={item}
              missionId={overview.mission.id}
              discussing={openForkFor(forks, item.ref) !== null}
              nowMs={nowMs}
            />
          ))}
        </ul>
      ) : null}
      {rows.length > 0 ? (
        <ul aria-label="Feed" className="flex min-w-0 flex-col gap-1.5">
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

function CallRow(props: {
  item: DirectionCheckItem;
  missionId: MissionId;
  discussing: boolean;
  nowMs: number;
}) {
  const { item } = props;
  const [busy, setBusy] = useState(false);
  const age = ageView(item.at, props.nowMs);
  // Only calls take a reaction; structural changes (lanes, roles, rules) are
  // cleared by Mark seen and discussed through a fork about the record.
  const isCall = item.ref.kind === "call";
  const react = (reaction: "ok" | "discuss") => {
    setBusy(true);
    const done = isCall
      ? reactToCall(item.ref.id, reaction)
      : discussRecord(props.missionId, item.ref);
    void done.then(() => setBusy(false));
  };
  return (
    <li className="grid min-w-0 grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 border-t border-border/60 py-2.5 first:border-t-0 first:pt-0">
      <span className="pt-1">
        <ByMarker by="master" label="The master's call" />
      </span>
      <div className="min-w-0">
        <p className="text-sm text-pretty">{item.summary}</p>
        <p className="mt-0.5 text-xs text-pretty text-muted-foreground">{item.reason}</p>
      </div>
      {age ? <AgeElement age={age} at={item.at} /> : null}
      <div className="col-start-2 col-end-4 flex items-center gap-1.5">
        {isCall ? (
          <Button variant="ghost-muted" size="sm" disabled={busy} onClick={() => react("ok")}>
            <CheckIcon aria-hidden />
            Fine
          </Button>
        ) : null}
        <Button
          variant="ghost-muted"
          size="sm"
          disabled={busy || props.discussing}
          onClick={() => react("discuss")}
        >
          <MessagesSquareIcon aria-hidden />
          {props.discussing ? "Discussing" : "Discuss"}
        </Button>
      </div>
    </li>
  );
}

function FeedRow(props: { item: FeedItem; missionId: string; nowMs: number }) {
  const { item } = props;
  return (
    <li className="grid min-w-0 grid-cols-[44px_14px_minmax(0,1fr)] items-baseline gap-x-2">
      <time dateTime={item.at} className="text-xs text-muted-foreground tabular-nums">
        {formatRelative(item.at, props.nowMs)}
      </time>
      <span className="translate-y-0.5">
        <StateGlyph kind={FEED_GLYPH[item.kind]} label={FEED_KIND_LABEL[item.kind]} />
      </span>
      <span className="min-w-0 text-sm text-pretty">
        {item.summary}
        {isDraftFeedItem(item) ? (
          <>
            {" "}
            <Link
              to="/missions/inbox"
              search={{ mission: props.missionId }}
              className="rounded-sm text-xs whitespace-nowrap text-update-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              Review draft
            </Link>
          </>
        ) : null}
      </span>
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
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            {path.blockedCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-error-foreground">
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
          <span className="text-xs text-muted-foreground tabular-nums">
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
                <span className="text-xs text-muted-foreground tabular-nums">
                  {group.items.length}
                </span>
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
              <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatDayLabel(milestone.targetAt)}
              </span>
            ) : null}
          </div>
          {milestone.statusNote ? (
            <p className="text-xs text-pretty text-muted-foreground">{milestone.statusNote}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
