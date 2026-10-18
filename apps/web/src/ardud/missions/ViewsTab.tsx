import { useMemo, useState } from "react";
import { EyeOffIcon, PinIcon, Trash2Icon, Undo2Icon } from "lucide-react";

import type { MissionId } from "@t3tools/contracts";
import {
  formatRelative,
  ownerWaitingEntries,
  SECTION_REGION_LABEL,
  sectionTitle,
  setAsideSections,
  visibleSections,
  type LayoutChange,
  type MissionLayout,
  type SectionEntry,
  type SectionRegion,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { ByMarker } from "./cards/chips";
import { changeSection } from "./missionCommands";
import { SampleMark } from "./MissionSection";
import { isSampleFeed, useMissionInbox, useMissionLayout } from "./missionsStore";
import { AskMasterForm, FoldButton, SectionCount, SectionMenu } from "./sections/SectionShell";

/** Changes shown before the fold. */
const FIRST_CHANGES = 6;

/**
 * The mission's layout: what the board shows and where, what was set aside
 * (with Restore), and every change with who made it.
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
  const aside = setAsideSections(layout);
  const sample = isSampleFeed("sections");
  return (
    <div className="flex min-w-0 flex-col gap-11">
      <section aria-labelledby="views-layout" className="flex min-w-0 flex-col gap-2.5">
        <div className="flex min-h-7 items-center gap-2.5">
          <h2 id="views-layout" className="text-sm font-semibold">
            Sections
          </h2>
          <SectionCount
            count={layout.entries.length - aside.length}
            label={`${layout.entries.length - aside.length} shown`}
          />
          {sample ? <SampleMark /> : null}
        </div>
        <RegionRows missionId={props.missionId} layout={layout} region="main" nowMs={props.nowMs} />
        <RegionRows missionId={props.missionId} layout={layout} region="rail" nowMs={props.nowMs} />
      </section>
      {aside.length > 0 ? (
        <section aria-labelledby="views-aside" className="flex min-w-0 flex-col gap-2.5">
          <div className="flex min-h-7 items-center gap-2.5">
            <h2 id="views-aside" className="text-sm font-semibold">
              Hidden
            </h2>
            <SectionCount count={aside.length} label={`${aside.length} hidden or removed`} />
          </div>
          <ul className="flex min-w-0 flex-col">
            {aside.map((section) => (
              <SetAsideRow
                key={section.key}
                missionId={props.missionId}
                section={section}
                pinned={section.kind === "needs-you" && waiting > 0 ? waiting : 0}
                nowMs={props.nowMs}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {layout.changes.length > 0 ? (
        <ChangeLog changes={layout.changes} nowMs={props.nowMs} />
      ) : null}
    </div>
  );
}

function RegionRows(props: {
  missionId: MissionId;
  layout: MissionLayout;
  region: SectionRegion;
  nowMs: number;
}) {
  const sections = visibleSections(props.layout, props.region);
  if (sections.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col">
      <h3 className="pb-1 text-xs font-medium text-muted-foreground">
        {SECTION_REGION_LABEL[props.region]}
      </h3>
      <ul className="flex min-w-0 flex-col">
        {sections.map((section) => (
          <LayoutRow
            key={section.key}
            missionId={props.missionId}
            layout={props.layout}
            section={section}
            nowMs={props.nowMs}
          />
        ))}
      </ul>
    </div>
  );
}

function LayoutRow(props: {
  missionId: MissionId;
  layout: MissionLayout;
  section: SectionEntry;
  nowMs: number;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <li className="flex min-w-0 flex-col border-t border-border/60">
      <div className="grid min-h-11 min-w-0 grid-cols-[minmax(0,1fr)_112px_28px] items-center gap-x-3">
        <span className="min-w-0 truncate text-sm font-medium">{sectionTitle(props.section)}</span>
        <Changed section={props.section} nowMs={props.nowMs} />
        <SectionMenu
          missionId={props.missionId}
          layout={props.layout}
          section={props.section}
          onAsk={() => setAsking(true)}
        />
      </div>
      {asking ? (
        <div className="pb-3">
          <AskMasterForm
            missionId={props.missionId}
            section={props.section}
            onDone={() => setAsking(false)}
          />
        </div>
      ) : null}
    </li>
  );
}

function SetAsideRow(props: {
  missionId: MissionId;
  section: SectionEntry;
  /** Items pinned under the head while this section is hidden. */
  pinned: number;
  nowMs: number;
}) {
  const { section } = props;
  const [busy, setBusy] = useState(false);
  const Icon = section.removed ? Trash2Icon : props.pinned > 0 ? PinIcon : EyeOffIcon;
  const state = section.removed
    ? "Removed"
    : props.pinned > 0
      ? `${props.pinned} pinned`
      : "Hidden";
  const restore = async () => {
    setBusy(true);
    await changeSection(props.missionId, section.key, { type: "restore" });
    setBusy(false);
  };
  return (
    <li className="grid min-h-11 min-w-0 grid-cols-[14px_minmax(0,1fr)_auto_112px_auto] items-center gap-x-3 border-t border-border/60">
      <Icon aria-hidden className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 truncate text-sm text-muted-foreground">
        {sectionTitle(section)}
      </span>
      <span className="text-xs text-muted-foreground">{state}</span>
      <Changed section={section} nowMs={props.nowMs} />
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void restore()}>
        <Undo2Icon aria-hidden />
        Restore
      </Button>
    </li>
  );
}

/** When the section last changed and who changed it; blank for the starting layout. */
function Changed(props: { section: SectionEntry; nowMs: number }) {
  const { changedAt, changedBy } = props.section;
  if (!changedAt || !changedBy) return <span />;
  return (
    <span className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground tabular-nums">
      <time dateTime={changedAt}>{formatRelative(changedAt, props.nowMs)}</time>
      <ByMarker by={changedBy} />
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
