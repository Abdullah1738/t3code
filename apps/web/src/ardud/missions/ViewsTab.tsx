import { useMemo, useState } from "react";
import { EyeOffIcon, PinIcon, Trash2Icon } from "lucide-react";

import type { MissionId } from "@t3tools/contracts";
import {
  formatRelative,
  layoutGroups,
  ownerWaitingEntries,
  resolveMissionLayout,
  type LayoutGroup,
  type LayoutRow,
  type MissionViewChange,
  type MissionViewsState,
  type ResolvedViewLayout,
} from "@t3tools/client-runtime/ardud/missions";

import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/utils";
import { ByMarker } from "./cards/chips";
import { useMissionInbox, useMissionViews } from "./missionsStore";
import {
  FoldButton,
  SectionCount,
  SectionFormRow,
  SectionMenu,
  TabMenu,
  type SectionForm,
} from "./sections/SectionShell";

/** Changes shown before the fold. */
const FIRST_CHANGES = 6;

/**
 * The mission's layout record: board columns and tabs in page order, hidden
 * and removed entries kept in place with Show or Restore in their menu, then
 * who changed what.
 */
export function ViewsTab(props: { missionId: MissionId; nowMs: number }) {
  const views = useMissionViews(props.missionId);
  const inbox = useMissionInbox(props.missionId);
  const waiting = useMemo(() => (inbox ? ownerWaitingEntries(inbox).length : undefined), [inbox]);
  const layout = useMemo(
    () =>
      views
        ? resolveMissionLayout(
            views.snapshot,
            waiting === undefined ? undefined : { ownerWaiting: waiting },
          )
        : null,
    [views, waiting],
  );
  if (views === null) return null;
  if (!views || !layout) {
    return (
      <div aria-hidden className="flex flex-col gap-3">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  }
  const groups = layoutGroups(views.snapshot, layout);
  return (
    <div className="flex max-w-190 min-w-0 flex-col gap-10">
      {groups.map((group) => (
        <LayoutGroupList
          key={group.region}
          missionId={props.missionId}
          views={views}
          layout={layout}
          group={group}
          pinned={waiting ?? views.snapshot.ownerWaiting}
        />
      ))}
      {views.changes.length > 0 ? <ChangeLog changes={views.changes} nowMs={props.nowMs} /> : null}
    </div>
  );
}

function LayoutGroupList(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  group: LayoutGroup;
  /** Items Needs you pins under the head while hidden. */
  pinned: number;
}) {
  const headingId = `views-${props.group.region}`;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-h-7 items-center gap-2.5">
        <h2 id={headingId} className="text-sm font-semibold">
          {props.group.label}
        </h2>
        <SectionCount
          count={props.group.rows.length}
          label={`${props.group.rows.length} entries`}
        />
      </div>
      <ul className="flex min-w-0 flex-col">
        {props.group.rows.map((row) => (
          <LayoutRowItem
            key={row.key}
            missionId={props.missionId}
            views={props.views}
            layout={props.layout}
            row={row}
            pinned={props.pinned}
          />
        ))}
      </ul>
    </section>
  );
}

function LayoutRowItem(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  row: LayoutRow;
  pinned: number;
}) {
  const { row } = props;
  const [form, setForm] = useState<SectionForm>(null);
  const removed = row.type === "section" && row.entry.removed;
  const setAside = row.entry.hidden || removed;
  const pinned =
    row.type === "section" && row.entry.kind === "needs-you" && row.entry.hidden ? props.pinned : 0;
  return (
    <li className="flex min-w-0 flex-col border-t border-border/60">
      <div className="grid min-h-11 min-w-0 grid-cols-[minmax(0,1fr)_auto_1.75rem] items-center gap-x-3">
        <span
          className={cn(
            "min-w-0 truncate text-sm",
            setAside ? "text-muted-foreground" : "font-medium text-foreground",
          )}
        >
          {row.entry.title}
        </span>
        <SetAsideTag hidden={row.entry.hidden} removed={removed} pinned={pinned} />
        {row.type === "section" ? (
          <SectionMenu
            views={props.views}
            layout={props.layout}
            section={row.entry}
            onForm={setForm}
          />
        ) : (
          <TabMenu views={props.views} tab={row.entry} onForm={setForm} />
        )}
      </div>
      {form ? (
        <div className="pb-3">
          <SectionFormRow
            form={form}
            missionId={props.missionId}
            views={props.views}
            entryKey={row.key}
            title={row.entry.title}
            onDone={() => setForm(null)}
          />
        </div>
      ) : null}
    </li>
  );
}

/** Removed, Hidden, or what Needs you pins under the head while hidden. */
function SetAsideTag(props: { hidden: boolean; removed: boolean; pinned: number }) {
  if (!props.hidden && !props.removed) return <span />;
  const Icon = props.removed ? Trash2Icon : props.pinned > 0 ? PinIcon : EyeOffIcon;
  const label = props.removed ? "Removed" : props.pinned > 0 ? `${props.pinned} pinned` : "Hidden";
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <Icon aria-hidden className="size-3" />
      {label}
    </span>
  );
}

function ChangeLog(props: { changes: ReadonlyArray<MissionViewChange>; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? props.changes : props.changes.slice(0, FIRST_CHANGES);
  return (
    <section aria-labelledby="views-changes" className="flex min-w-0 flex-col gap-1">
      <div className="flex min-h-7 items-center gap-2.5">
        <h2 id="views-changes" className="text-sm font-semibold">
          Changes
        </h2>
        <SectionCount count={props.changes.length} label={`${props.changes.length} changes`} />
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
