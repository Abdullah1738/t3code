import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, CheckIcon, MessagesSquareIcon } from "lucide-react";

import type {
  BlockerGroup,
  DirectionCheckItem,
  FeedItem,
  MissionOverview,
} from "@t3tools/contracts";
import {
  ballHolderLine,
  criticalPathView,
  feedCountsLine,
  formatCountdown,
  formatDayLabel,
  formatRelative,
  isDraftFeedItem,
  orderBlockerGroups,
  refKey,
  refLabel,
  sinceLastLookedLabel,
  splitFeed,
} from "@t3tools/client-runtime/ardud/missions";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { runMissionAction } from "./missionActions";
import { missionsSource } from "./missionsStore";
import { MILESTONE_BADGE_VARIANT, MILESTONE_LABEL } from "./missionTone";
import { MissionSection } from "./MissionSection";
import { PriorityStack } from "./PriorityStack";

/** Problems first: bottom line, what blocks, what to re-check, then the queue and the feed. */
export function MissionOverviewTab(props: {
  overview: MissionOverview;
  nowMs: number;
  highlightSubMissionId: string | null;
}) {
  const { overview, nowMs } = props;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <BottomLine overview={overview} nowMs={nowMs} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Blockers groups={overview.blockers} missionId={overview.mission.id} />
        <CriticalPath overview={overview} nowMs={nowMs} />
      </div>
      <DirectionCheck overview={overview} nowMs={nowMs} />
      <PriorityStack
        mission={overview.mission}
        subMissions={overview.subMissions}
        highlightId={props.highlightSubMissionId}
      />
      <Feed overview={overview} nowMs={nowMs} />
    </div>
  );
}

function BottomLine(props: { overview: MissionOverview; nowMs: number }) {
  const { overview } = props;
  if (overview.bottomLine.length === 0) return null;
  return (
    <section
      aria-label="Bottom line"
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/60 bg-muted/40 p-4"
    >
      <p className="text-base leading-relaxed text-pretty text-foreground">{overview.bottomLine}</p>
      {overview.bottomLineAt ? (
        <p className="text-xs text-muted-foreground">
          Master's bottom line, {formatRelative(overview.bottomLineAt, props.nowMs)}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Blockers by ball holder

function Blockers(props: { groups: ReadonlyArray<BlockerGroup>; missionId: string }) {
  const groups = useMemo(() => orderBlockerGroups(props.groups), [props.groups]);
  const line = useMemo(() => ballHolderLine(props.groups), [props.groups]);
  return (
    <MissionSection title="Who holds the ball" caption={groups.length > 0 ? line : undefined}>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is blocked.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((group) => {
            const isOwner = group.holder._tag === "owner";
            return (
              <li key={group.holderLabel} className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "font-medium",
                      isOwner ? "text-warning-foreground" : "text-foreground",
                    )}
                  >
                    {isOwner ? "You" : group.holderLabel}
                  </span>
                  <span className="text-muted-foreground tabular-nums">{group.items.length}</span>
                  {isOwner ? (
                    <Link
                      to="/missions/inbox"
                      search={{ mission: props.missionId }}
                      className="ms-auto flex items-center gap-1 rounded text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      Open inbox
                      <ArrowRightIcon aria-hidden className="size-3" />
                    </Link>
                  ) : null}
                </div>
                <ul className="flex flex-col gap-0.5 border-s border-border ps-3">
                  {group.items.map((item) => (
                    <li key={refKey(item)} className="text-sm text-pretty text-foreground/90">
                      {refLabel(item)}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </MissionSection>
  );
}

// ---------------------------------------------------------------------------
// Critical path and milestones

function CriticalPath(props: { overview: MissionOverview; nowMs: number }) {
  const { overview, nowMs } = props;
  const path = useMemo(
    () => criticalPathView(overview.criticalPath, overview.blockers),
    [overview.criticalPath, overview.blockers],
  );
  const milestones = useMemo(
    () =>
      [...overview.milestones].sort((left, right) =>
        (left.targetAt ?? "").localeCompare(right.targetAt ?? ""),
      ),
    [overview.milestones],
  );
  const target = milestones.find((milestone) => milestone.targetAt !== null)?.targetAt ?? null;
  const title = target ? `Critical path to ${formatDayLabel(target)}` : "Critical path";
  return (
    <MissionSection
      title={title}
      caption={
        path.steps.length === 0
          ? undefined
          : path.blockedCount > 0
            ? `${path.blockedCount} of ${path.steps.length} links blocked`
            : "Nothing blocked"
      }
    >
      {path.steps.length > 0 ? (
        <ol className="flex flex-col">
          {path.steps.map((step, index) => (
            <li key={refKey(step.ref)} className="flex min-w-0 gap-2">
              <span className="flex w-3 shrink-0 flex-col items-center">
                <span
                  aria-hidden
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    step.heldBy ? "bg-destructive" : "bg-foreground/35",
                  )}
                />
                {index < path.steps.length - 1 ? (
                  <span aria-hidden className="w-px flex-1 bg-border" />
                ) : null}
              </span>
              <div className="min-w-0 pb-2">
                <p className="text-sm text-foreground">{refLabel(step.ref)}</p>
                {step.heldBy ? (
                  <p className="text-xs text-destructive-foreground">
                    Blocked, ball with {step.heldBy}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">The master has not mapped a critical path.</p>
      )}
      {milestones.length > 0 ? (
        <details className="group/milestones min-w-0">
          <summary className="cursor-pointer rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            {milestones.length} milestones
            {target ? ` · ${formatCountdown(target, nowMs)} left` : ""}
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {milestones.map((milestone) => (
              <li key={milestone.id} className="flex min-w-0 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant={MILESTONE_BADGE_VARIANT[milestone.status]} size="sm">
                    {MILESTONE_LABEL[milestone.status]}
                  </Badge>
                  <span className="min-w-0 truncate text-sm">{milestone.title}</span>
                </div>
                {milestone.statusNote ? (
                  <p className="ps-1 text-xs text-pretty text-muted-foreground">
                    {milestone.statusNote}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </MissionSection>
  );
}

// ---------------------------------------------------------------------------
// Direction check: calls the master made since the owner last looked

function DirectionCheck(props: { overview: MissionOverview; nowMs: number }) {
  const { overview, nowMs } = props;
  const items = overview.directionCheck;
  return (
    <MissionSection
      title="Direction check"
      caption={`Calls you may want to reverse. ${sinceLastLookedLabel(overview.ownerLastLookedAt, nowMs)}.`}
    >
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No new calls to check.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {items.map((item) => (
            <DirectionCheckRow
              key={refKey(item.ref)}
              item={item}
              missionId={overview.mission.id}
              nowMs={nowMs}
            />
          ))}
        </ul>
      )}
    </MissionSection>
  );
}

function DirectionCheckRow(props: {
  item: DirectionCheckItem;
  missionId: MissionOverview["mission"]["id"];
  nowMs: number;
}) {
  const { item } = props;
  const [busy, setBusy] = useState(false);
  const react = (reaction: "ok" | "discuss") => {
    setBusy(true);
    void runMissionAction(
      missionsSource.reactToCall({
        missionId: props.missionId,
        callId: item.ref.id as Parameters<typeof missionsSource.reactToCall>[0]["callId"],
        reaction,
      }),
      "Could not record your reaction",
    ).then(() => setBusy(false));
  };
  return (
    <li className="flex min-w-0 flex-col gap-2 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{item.summary}</p>
        <p className="mt-0.5 text-xs text-pretty text-muted-foreground">
          {item.reason}{" "}
          <span className="whitespace-nowrap">· {formatRelative(item.at, props.nowMs)}</span>
        </p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => react("ok")}>
          <CheckIcon aria-hidden />
          Fine
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => react("discuss")}>
          <MessagesSquareIcon aria-hidden />
          Discuss
        </Button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Feed since the owner last looked

const FEED_DOT_CLASS: Record<FeedItem["kind"], string> = {
  shipped: "bg-success",
  decided: "bg-info",
  blocked: "bg-destructive",
  milestone: "bg-primary",
  note: "bg-muted-foreground/50",
};

const FEED_KIND_LABEL: Record<FeedItem["kind"], string> = {
  shipped: "Shipped",
  decided: "Decided",
  blocked: "Blocked",
  milestone: "Milestone",
  note: "Note",
};

function Feed(props: { overview: MissionOverview; nowMs: number }) {
  const { overview, nowMs } = props;
  const sections = useMemo(
    () => splitFeed(overview.feed, overview.ownerLastLookedAt),
    [overview.feed, overview.ownerLastLookedAt],
  );
  const [showEarlier, setShowEarlier] = useState(false);
  const caption =
    sections.fresh.length > 0
      ? feedCountsLine(sections.fresh)
      : overview.feed.length > 0
        ? "Nothing new"
        : undefined;
  const markSeen = () =>
    void runMissionAction(
      missionsSource.markMissionSeen({ missionId: overview.mission.id }),
      "Could not mark as seen",
    );
  return (
    <MissionSection
      title={sinceLastLookedLabel(overview.ownerLastLookedAt, nowMs)}
      caption={caption}
      accessory={
        sections.fresh.length > 0 ? (
          <Button variant="ghost" size="xs" onClick={markSeen}>
            Mark seen
          </Button>
        ) : undefined
      }
    >
      {overview.feed.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
      ) : (
        <>
          <FeedList items={sections.fresh} missionId={overview.mission.id} nowMs={nowMs} />
          {sections.earlier.length > 0 ? (
            showEarlier ? (
              <>
                <p className="pt-1 text-xs font-medium text-muted-foreground">Earlier</p>
                <FeedList items={sections.earlier} missionId={overview.mission.id} nowMs={nowMs} />
              </>
            ) : (
              <Button
                variant="ghost-muted"
                size="xs"
                className="self-start"
                onClick={() => setShowEarlier(true)}
              >
                Show {sections.earlier.length} earlier
              </Button>
            )
          ) : null}
        </>
      )}
    </MissionSection>
  );
}

function FeedList(props: { items: ReadonlyArray<FeedItem>; missionId: string; nowMs: number }) {
  if (props.items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      {props.items.map((item) => (
        <li
          key={`${item.at}-${item.ref ? refKey(item.ref) : item.summary}`}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2"
        >
          <span
            role="img"
            aria-label={FEED_KIND_LABEL[item.kind]}
            className={cn("size-1.5 -translate-y-px rounded-full", FEED_DOT_CLASS[item.kind])}
          />
          <span className="text-sm text-pretty text-foreground/90">
            {item.summary}
            {isDraftFeedItem(item) ? (
              <>
                {" "}
                <Link
                  to="/missions/inbox"
                  search={{ mission: props.missionId }}
                  className="rounded text-xs whitespace-nowrap text-warning-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  Review draft
                </Link>
              </>
            ) : null}
          </span>
          <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {formatRelative(item.at, props.nowMs)}
          </span>
        </li>
      ))}
    </ul>
  );
}
