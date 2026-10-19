import { useMemo, useState } from "react";
import { EyeOffIcon, LockIcon, PinIcon, Trash2Icon } from "lucide-react";

import type { MissionId } from "@t3tools/contracts";
import {
  formatRelative,
  ownerWaitingEntries,
  SECTION_REGION_LABEL,
  sectionTitle,
  type LayoutChange,
  type MissionLayout,
  type SectionEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/utils";
import { APPROVER_NAME, ByMarker, PersonChip } from "./cards/chips";
import { SampleMark } from "./MissionSection";
import { isSampleFeed, useMissionInbox, useMissionLayout } from "./missionsStore";
import { AskMasterForm, FoldButton, SectionMenu } from "./sections/SectionShell";

/** Changes shown before the fold. */
const FIRST_CHANGES = 6;

/** Name, Where, Changed, By, menu; phones fold to two lines. */
const ROW_GRID =
  "grid min-w-0 items-center gap-x-4 grid-cols-[minmax(0,1fr)_auto_1.75rem] sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_5.5rem_7rem_1.75rem]";

/**
 * The mission's layout as one table: every section, where it sits, when it
 * last changed and who changed it. Hidden and removed sections stay in the
 * table with Show or Restore in their menu. On day one every row is built in.
 */
export function ViewsTab(props: { missionId: MissionId; nowMs: number }) {
  const layout = useMissionLayout(props.missionId);
  const inbox = useMissionInbox(props.missionId);
  const waiting = useMemo(() => (inbox ? ownerWaitingEntries(inbox).length : 0), [inbox]);
  if (!layout) {
    return (
      <div aria-hidden className="flex flex-col gap-3">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  }
  const rows = [
    ...layout.entries.filter((entry) => entry.region === "main"),
    ...layout.entries.filter((entry) => entry.region === "rail"),
  ];
  return (
    <div className="flex max-w-190 min-w-0 flex-col gap-10">
      <section aria-labelledby="views-sections" className="flex min-w-0 flex-col gap-2.5">
        <div className="flex min-h-7 items-center gap-2.5">
          <h2 id="views-sections" className="text-sm font-semibold">
            Sections
          </h2>
          {isSampleFeed("sections") ? <SampleMark /> : null}
        </div>
        <div role="table" aria-labelledby="views-sections" className="flex min-w-0 flex-col">
          <div
            role="row"
            className={cn(ROW_GRID, "hidden h-7 text-xs text-muted-foreground sm:grid")}
          >
            <span role="columnheader">Name</span>
            <span role="columnheader">Where</span>
            <span role="columnheader">Changed</span>
            <span role="columnheader">By</span>
            <span role="columnheader">
              <span className="sr-only">Menu</span>
            </span>
          </div>
          {rows.map((section) => (
            <SectionRow
              key={section.key}
              missionId={props.missionId}
              layout={layout}
              section={section}
              pinned={section.kind === "needs-you" && section.hidden ? waiting : 0}
              nowMs={props.nowMs}
            />
          ))}
        </div>
      </section>
      {layout.changes.length > 0 ? (
        <ChangeLog changes={layout.changes} nowMs={props.nowMs} />
      ) : null}
    </div>
  );
}

function SectionRow(props: {
  missionId: MissionId;
  layout: MissionLayout;
  section: SectionEntry;
  /** Items pinned under the head while Needs you is hidden. */
  pinned: number;
  nowMs: number;
}) {
  const { section } = props;
  const [asking, setAsking] = useState(false);
  const setAside = section.hidden || section.removed;
  return (
    <>
      <div
        role="row"
        className={cn(
          ROW_GRID,
          "border-t border-border/60 max-sm:gap-y-0.5 max-sm:py-2.5 sm:min-h-12",
        )}
      >
        <span
          role="cell"
          className={cn(
            "min-w-0 truncate text-sm max-sm:col-start-1 max-sm:row-start-1",
            setAside ? "text-muted-foreground" : "font-medium",
          )}
        >
          {sectionTitle(section)}
        </span>
        <span
          role="cell"
          className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground max-sm:col-start-1 max-sm:row-start-2 max-sm:text-xs"
        >
          <span className="truncate">{SECTION_REGION_LABEL[section.region]}</span>
          <SetAsideTag section={section} pinned={props.pinned} />
        </span>
        <span
          role="cell"
          className="text-xs text-muted-foreground tabular-nums max-sm:col-start-2 max-sm:row-start-2 max-sm:justify-self-end"
        >
          {section.changedAt ? (
            <time dateTime={section.changedAt}>
              {formatRelative(section.changedAt, props.nowMs)}
            </time>
          ) : null}
        </span>
        <span
          role="cell"
          className="flex min-w-0 max-sm:col-start-2 max-sm:row-start-1 max-sm:justify-self-end"
        >
          {section.changedBy ? (
            <PersonChip
              kind={section.changedBy === "owner" ? "you" : "master"}
              name={APPROVER_NAME[section.changedBy]}
            />
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <LockIcon aria-hidden className="size-3.5" />
              Built in
            </span>
          )}
        </span>
        <span
          role="cell"
          className="flex justify-end max-sm:col-start-3 max-sm:row-span-2 max-sm:row-start-1"
        >
          <SectionMenu
            missionId={props.missionId}
            layout={props.layout}
            section={section}
            onAsk={() => setAsking(true)}
          />
        </span>
      </div>
      {asking ? (
        <div role="row" className="pb-3">
          <div role="cell">
            <AskMasterForm
              missionId={props.missionId}
              section={section}
              onDone={() => setAsking(false)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Removed, Hidden, or what Needs you pinned under the head while hidden. */
function SetAsideTag(props: { section: SectionEntry; pinned: number }) {
  const { section } = props;
  if (!section.hidden && !section.removed) return null;
  const Icon = section.removed ? Trash2Icon : props.pinned > 0 ? PinIcon : EyeOffIcon;
  const label = section.removed
    ? "Removed"
    : props.pinned > 0
      ? `${props.pinned} pinned`
      : "Hidden";
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs">
      <Icon aria-hidden className="size-3" />
      {label}
    </span>
  );
}

function ChangeLog(props: { changes: ReadonlyArray<LayoutChange>; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? props.changes : props.changes.slice(0, FIRST_CHANGES);
  return (
    <section aria-labelledby="views-changes" className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-h-7 items-center gap-2.5">
        <h2 id="views-changes" className="text-sm font-semibold">
          Changes
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">{props.changes.length}</span>
      </div>
      <ol className="flex min-w-0 flex-col">
        {shown.map((change) => (
          <li
            key={change.id}
            className="grid min-h-9 min-w-0 grid-cols-[72px_minmax(0,1fr)_16px] items-center gap-x-3 border-t border-border/60"
          >
            <time dateTime={change.at} className="text-xs text-muted-foreground tabular-nums">
              {formatRelative(change.at, props.nowMs)}
            </time>
            <span className="min-w-0 truncate text-sm">{change.summary}</span>
            <ByMarker by={change.by} />
          </li>
        ))}
      </ol>
      <FoldButton hidden={props.changes.length - shown.length} onShow={() => setOpen(true)} />
    </section>
  );
}
