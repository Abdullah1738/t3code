import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  GripVerticalIcon,
  RefreshCwIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";

import type { MissionId, ViewDataSourceId, ViewRegion } from "@t3tools/contracts";
import {
  dropLayoutGroups,
  fitsViewRegion,
  formatRelative,
  layoutGroups,
  viewDropGroups,
  viewDropRequest,
  viewDropTarget,
  ownerWaitingEntries,
  resolveMissionLayout,
  viewCardKit,
  viewCopyRequest,
  viewSourceCode,
  viewSourceHistoryInput,
  viewSourceItems,
  viewSourceRunInput,
  viewSourceToggleInput,
  viewStarterIsNewer,
  viewStarterRequest,
  viewTemplateRequest,
  type LayoutGroup,
  type LayoutRow,
  type MissionViewChange,
  type MissionViewsState,
  type ResolvedViewLayout,
  type ViewKitTemplate,
  type ViewSectionRequest,
  type ViewSourceItem,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/utils";
import { ByMarker } from "./cards/chips";
import { DESK_ROW, FoldRow, PanelCount, TabActions } from "./deskParts";
import { runMissionAction } from "./missionActions";
import { missionsSource, useMissionInbox, useMissionList, useMissionViews } from "./missionsStore";
import { OfflineLine } from "./sections/FeedError";
import { SectionFormRow, SectionMenu, TabMenu, type SectionForm } from "./sections/SectionShell";
import { useMissionsOffline } from "./useMissionsConnection";

// Views tab, Desk layout: the board's entries as tiles by region, what is set
// aside and the script sources, then the starter, the change log and the card
// kit on the side.

/** Changes shown before the fold. */
const FIRST_CHANGES = 6;
const PANEL = "flex min-w-0 flex-col gap-3 rounded-3xl bg-(--m-surface) p-4 sm:p-5";

const send = (request: ViewSectionRequest | null, failure: string) =>
  request === null
    ? Promise.resolve(true)
    : runMissionAction(missionsSource.changeView(request), failure);

export function ViewsTab(props: { missionId: MissionId; nowMs: number }) {
  const views = useMissionViews(props.missionId);
  const inbox = useMissionInbox(props.missionId);
  const offline = useMissionsOffline();
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
    // ardud missions: fix-p3 - offline, say so instead of loading forever
    if (offline !== null) return <OfflineLine />;
    return (
      <div aria-hidden className="flex flex-col gap-3">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  }
  const groups = layoutGroups(views.snapshot, layout);
  const shown = groups.map((group) => ({
    ...group,
    rows: group.rows.filter((row) => !setAside(row)),
  }));
  const aside = groups.flatMap((group) => group.rows.filter(setAside));
  const pinned = waiting ?? views.snapshot.ownerWaiting;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <TabActions>
        <CopyFrom missionId={props.missionId} />
      </TabActions>
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <section aria-labelledby="views-board" className={PANEL}>
            <h2 id="views-board" className="text-sm font-semibold">
              Board
            </h2>
            <BoardTiles missionId={props.missionId} views={views} layout={layout} groups={shown} />
          </section>
          {aside.length > 0 ? (
            <section aria-labelledby="views-hidden" className={PANEL}>
              <div className="flex items-center gap-2">
                <h2 id="views-hidden" className="text-sm font-semibold">
                  Hidden
                </h2>
                <PanelCount count={aside.length} />
              </div>
              <ul className="flex min-w-0 flex-col">
                {aside.map((row) => (
                  <EntryRow
                    key={row.key}
                    missionId={props.missionId}
                    views={views}
                    layout={layout}
                    row={row}
                    pinned={pinned}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          <SourcesPanel views={views} nowMs={props.nowMs} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <StarterPanel views={views} />
          {views.changes.length > 0 ? (
            <ChangeLog changes={views.changes} nowMs={props.nowMs} />
          ) : null}
          <CardKit views={views} nowMs={props.nowMs} />
        </div>
      </div>
    </div>
  );
}

const setAside = (row: LayoutRow) =>
  row.entry.hidden || (row.type === "section" && row.entry.removed);

// ardud missions: fix-p3 - tiles move by drag and drop (pointer or keyboard);
// the tile menu's Move stays as the fallback.
const regionDropId = (region: ViewRegion) => `region:${region}`;

interface DropData {
  readonly region: ViewRegion;
  readonly key: string | null;
}

function BoardTiles(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  groups: ReadonlyArray<LayoutGroup>;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlyArray<LayoutGroup> | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const groups = pending ?? props.groups;
  const rows = groups.flatMap((group) => group.rows);
  const active = rows.find((row) => row.key === dragging) ?? null;
  const shown = viewDropGroups(groups, active);

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const over = event.over?.data.current as DropData | undefined;
    const key = String(event.active.id);
    if (over === undefined || over.key === key) return;
    const target = viewDropTarget(groups, key, over);
    const request = viewDropRequest(props.views.snapshot, key, target.region, target.before);
    if (request === null) return;
    setPending(dropLayoutGroups(groups, key, target));
    void send(request, "Couldn't move it").then(() => setPending(null));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(event) => setDragging(String(event.active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
    >
      {shown.map((group) => (
        <RegionTiles
          key={group.region}
          missionId={props.missionId}
          views={props.views}
          layout={props.layout}
          group={group}
          disabled={active !== null && !fitsViewRegion(active, group.region)}
        />
      ))}
    </DndContext>
  );
}

function RegionTiles(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  group: LayoutGroup;
  disabled: boolean;
}) {
  const { region } = props.group;
  const { setNodeRef, isOver } = useDroppable({
    id: regionDropId(region),
    data: { region, key: null } satisfies DropData,
    // A filled region takes drops on its tiles; only an empty one is a target itself.
    disabled: props.disabled || props.group.rows.length > 0,
  });
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-xs text-(--m-muted)">{props.group.label}</h3>
      <SortableContext
        items={props.group.rows.map((row) => row.key)}
        strategy={rectSortingStrategy}
      >
        <ul
          ref={setNodeRef}
          className={cn(
            "grid min-h-11 min-w-0 gap-2 rounded-2xl sm:grid-cols-2 xl:grid-cols-3",
            isOver && "bg-(--m-active)",
          )}
        >
          {props.group.rows.map((row) => (
            <EntryTile
              key={row.key}
              missionId={props.missionId}
              views={props.views}
              layout={props.layout}
              row={row}
              region={region}
              disabled={props.disabled}
            />
          ))}
        </ul>
      </SortableContext>
    </div>
  );
}

function EntryMenu(props: {
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  row: LayoutRow;
  onForm: (form: SectionForm) => void;
}) {
  return props.row.type === "section" ? (
    <SectionMenu
      views={props.views}
      layout={props.layout}
      section={props.row.entry}
      onForm={props.onForm}
    />
  ) : (
    <TabMenu views={props.views} tab={props.row.entry} onForm={props.onForm} />
  );
}

function EntryTile(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  row: LayoutRow;
  region: ViewRegion;
  disabled: boolean;
}) {
  const { row } = props;
  const [form, setForm] = useState<SectionForm>(null);
  const by = row.type === "section" ? row.entry.by : null;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: row.key,
    data: { region: props.region, key: row.key } satisfies DropData,
    disabled: { draggable: false, droppable: props.disabled },
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-2xl bg-(--m-raised) py-2.5 ps-1.5 pe-2",
        form !== null && "sm:col-span-full",
        isDragging && "relative z-10 shadow-md",
      )}
    >
      <div className="flex min-h-7 min-w-0 items-center gap-1.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Move ${row.entry.title}`}
          className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-(--m-muted)/70 outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing pointer-coarse:size-10"
        >
          <GripVerticalIcon aria-hidden className="size-3.5" />
        </button>
        <span className="min-w-0 truncate text-sm font-medium">{row.entry.title}</span>
        {by === "owner" || by === "master" ? <ByMarker by={by} /> : null}
        <span className="ms-auto">
          <EntryMenu views={props.views} layout={props.layout} row={row} onForm={setForm} />
        </span>
      </div>
      {form ? (
        <SectionFormRow
          form={form}
          missionId={props.missionId}
          views={props.views}
          entryKey={row.key}
          title={row.entry.title}
          onDone={() => setForm(null)}
        />
      ) : null}
    </li>
  );
}

/** A hidden or removed entry; its menu has Show or Restore. */
function EntryRow(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  row: LayoutRow;
  /** Items Needs you pins under the head while it is hidden. */
  pinned: number;
}) {
  const { row } = props;
  const [form, setForm] = useState<SectionForm>(null);
  const removed = row.type === "section" && row.entry.removed;
  const pinned =
    row.type === "section" && row.entry.kind === "needs-you" && props.pinned > 0 ? props.pinned : 0;
  return (
    <li className={cn("flex min-w-0 flex-col", DESK_ROW)}>
      <div className="flex min-h-11 min-w-0 items-center gap-3">
        <span className="min-w-0 truncate text-sm">{row.entry.title}</span>
        <span className="shrink-0 text-xs text-(--m-muted)">
          {removed ? "Removed" : pinned > 0 ? `${pinned} pinned` : "Hidden"}
        </span>
        <span className="ms-auto">
          <EntryMenu views={props.views} layout={props.layout} row={row} onForm={setForm} />
        </span>
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

/** Shown only when the starter moved past what this mission started from. */
function StarterPanel(props: { views: MissionViewsState }) {
  const { snapshot } = props.views;
  const [busy, setBusy] = useState(false);
  if (!viewStarterIsNewer(snapshot)) return null;
  const use = () => {
    setBusy(true);
    void send(viewStarterRequest(snapshot), "Couldn't take the starter layout").finally(() =>
      setBusy(false),
    );
  };
  return (
    <section aria-labelledby="views-starter" className={PANEL}>
      <h2 id="views-starter" className="text-sm font-semibold">
        Starting layout
      </h2>
      <div className="flex min-w-0 items-center gap-3">
        <b className="text-sm font-semibold tabular-nums">v{snapshot.starter.version}</b>
        <span className="min-w-0 text-xs text-(--m-muted)">
          This mission is on v{snapshot.layout.seededFrom}.
        </span>
        <Button size="sm" variant="outline" className="ms-auto" disabled={busy} onClick={use}>
          Use it
        </Button>
      </div>
    </section>
  );
}

function ChangeLog(props: { changes: ReadonlyArray<MissionViewChange>; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? props.changes : props.changes.slice(0, FIRST_CHANGES);
  return (
    <section aria-labelledby="views-changes" className={PANEL}>
      <div className="flex items-center gap-2">
        <h2 id="views-changes" className="text-sm font-semibold">
          Changes
        </h2>
        <PanelCount count={props.changes.length} />
      </div>
      <ol className="flex min-w-0 flex-col">
        {shown.map((change) => (
          <li
            key={change.id}
            className={cn(
              "grid min-h-10 min-w-0 grid-cols-[64px_minmax(0,1fr)_16px] items-center gap-x-3 py-1.5",
              DESK_ROW,
            )}
          >
            <time dateTime={change.at} className="text-xs text-(--m-muted) tabular-nums">
              {formatRelative(change.at, props.nowMs)}
            </time>
            <span className="min-w-0 text-sm">{change.summary}</span>
            <ByMarker by={change.by} />
          </li>
        ))}
      </ol>
      <FoldRow hidden={props.changes.length - shown.length} onShow={() => setOpen(true)} />
    </section>
  );
}

function CardKit(props: { views: MissionViewsState; nowMs: number }) {
  const kit = useMemo(() => viewCardKit(props.views.snapshot), [props.views.snapshot]);
  return (
    <section aria-labelledby="views-kit" className={PANEL}>
      <h2 id="views-kit" className="text-sm font-semibold">
        Card kit
      </h2>
      <ul className="flex min-w-0 flex-col">
        <li className={cn("flex min-h-10 min-w-0 items-center gap-3 py-1.5", DESK_ROW)}>
          <span className="min-w-0 text-sm">{kit.builtIn.join(", ")}</span>
          <span className="ms-auto shrink-0 text-xs text-(--m-muted)">Built in</span>
        </li>
        {kit.custom.map((template) => (
          <KitRow key={template.id} views={props.views} template={template} nowMs={props.nowMs} />
        ))}
      </ul>
    </section>
  );
}

function KitRow(props: { views: MissionViewsState; template: ViewKitTemplate; nowMs: number }) {
  const { template } = props;
  const change = (kind: "remove" | "restore") =>
    void send(
      viewTemplateRequest(props.views.snapshot, template.id, kind),
      kind === "remove" ? "Couldn't remove the card" : "Couldn't restore the card",
    );
  return (
    <li className={cn("flex min-h-10 min-w-0 items-center gap-2 py-1.5", DESK_ROW)}>
      <span className={cn("min-w-0 truncate text-sm", template.removed && "text-(--m-muted)")}>
        {template.name}
      </span>
      {template.by === "owner" || template.by === "master" ? <ByMarker by={template.by} /> : null}
      <span className="ms-auto shrink-0 text-xs text-(--m-muted)">
        {template.removed ? "Removed" : formatRelative(template.changedAt, props.nowMs)}
      </span>
      <Menu>
        <MenuTrigger
          render={
            <Button size="icon-xs" variant="ghost-muted" aria-label={`${template.name} menu`} />
          }
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          {template.removed ? (
            <MenuItem onClick={() => change("restore")}>
              <Undo2Icon aria-hidden />
              Restore
            </MenuItem>
          ) : (
            <MenuItem onClick={() => change("remove")}>
              <Trash2Icon aria-hidden />
              Remove
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </li>
  );
}

function SourcesPanel(props: { views: MissionViewsState; nowMs: number }) {
  const items = viewSourceItems(props.views.snapshot);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="views-sources" className={PANEL}>
      <div className="flex items-center gap-2">
        <h2 id="views-sources" className="text-sm font-semibold">
          Sources
        </h2>
        <PanelCount count={items.length} />
      </div>
      <ul className="flex min-w-0 flex-col">
        {items.map((item) => (
          <SourceRow key={item.id} item={item} nowMs={props.nowMs} />
        ))}
      </ul>
    </section>
  );
}

const SOURCE_STATUS = { off: "Off", running: "Running", failed: "Failed" } as const;

function SourceRow(props: { item: ViewSourceItem; nowMs: number }) {
  const { item } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = (action: Promise<unknown>, failure: string) => {
    setBusy(true);
    void runMissionAction(action, failure).finally(() => setBusy(false));
  };
  const codeId = `views-source-${item.id}`;
  return (
    <li className={cn("flex min-w-0 flex-col", DESK_ROW)}>
      <div className="flex min-h-10 min-w-0 items-center gap-2 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? codeId : undefined}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 text-(--m-muted)", open && "rotate-90")}
          />
          <span className={cn("min-w-0 truncate", !item.enabled && "text-(--m-muted)")}>
            {item.title}
          </span>
        </button>
        {item.status ? (
          <span
            className={cn(
              "shrink-0 text-xs",
              item.status === "failed" ? "font-medium text-(--m-negative)" : "text-(--m-muted)",
            )}
          >
            {SOURCE_STATUS[item.status]}
          </span>
        ) : null}
        <span className="shrink-0 text-xs text-(--m-muted) tabular-nums">
          {[
            item.rows === null ? null : `${item.rows} ${item.rows === 1 ? "row" : "rows"}`,
            item.ranAt === null ? null : formatRelative(item.ranAt, props.nowMs),
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </span>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Refresh ${item.title}`}
          disabled={busy || !item.canRun}
          onClick={() =>
            act(
              missionsSource.runViewSource(viewSourceRunInput(item)),
              "Couldn't refresh the source",
            )
          }
        >
          <RefreshCwIcon aria-hidden />
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={busy}
          onClick={() =>
            act(
              missionsSource.setViewSource(viewSourceToggleInput(item)),
              item.enabled ? "Couldn't turn the source off" : "Couldn't turn the source on",
            )
          }
        >
          {item.enabled ? "Disable" : "Enable"}
        </Button>
      </div>
      {open ? (
        <div id={codeId} className="flex min-w-0 flex-col gap-2 pb-3 ps-5.5">
          {item.status === "failed" && item.error ? (
            <p className="text-xs break-words text-(--m-negative)">{item.error}</p>
          ) : null}
          <SourceCode missionId={item.missionId} sourceId={item.id} version={item.version} />
        </div>
      ) : null}
    </li>
  );
}

/** The listing leaves the script out, so it loads from history when the row opens. */
function SourceCode(props: { missionId: MissionId; sourceId: ViewDataSourceId; version: number }) {
  const { missionId, sourceId, version } = props;
  const [code, setCode] = useState<{ version: number; text: string | null }>();
  useEffect(() => {
    let live = true;
    missionsSource.loadViewHistory(viewSourceHistoryInput({ missionId, id: sourceId })).then(
      (history) => {
        if (live) setCode({ version, text: viewSourceCode(history, version) });
      },
      () => {
        if (live) setCode({ version, text: null });
      },
    );
    return () => {
      live = false;
    };
  }, [missionId, sourceId, version]);
  if (code?.version !== version) return <Skeleton className="h-4 w-2/5" />;
  if (code.text === null) {
    return <p className="text-xs text-(--m-muted)">Couldn't load the code</p>;
  }
  return (
    <pre
      aria-label="Source code"
      className="max-h-80 overflow-auto rounded-xl bg-(--m-raised) px-3 py-2 font-mono text-xs leading-5"
    >
      {code.text}
    </pre>
  );
}

/** Copies another mission's card templates and portable sections here. */
function CopyFrom(props: { missionId: MissionId }) {
  const list = useMissionList();
  const others = (list?.missions ?? []).filter(
    (mission) => mission.id !== props.missionId && mission.status !== "archived",
  );
  if (others.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" />}>
        <CopyIcon aria-hidden />
        Copy views from
      </MenuTrigger>
      <MenuPopup align="end">
        {others.map((mission) => (
          <MenuItem
            key={mission.id}
            onClick={() =>
              void send(viewCopyRequest(props.missionId, mission.id), "Couldn't copy the views")
            }
          >
            {mission.title}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
