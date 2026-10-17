import { useMemo, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";

import type { Mission, SubMission, SubMissionId } from "@t3tools/contracts";
import {
  effortNote,
  formatPercent,
  healthLabel,
  moveInOrder,
  priorityStack,
  type PriorityStackRow,
} from "@t3tools/client-runtime/ardud/missions";

import { cn } from "../../lib/utils";
import { runMissionAction } from "./missionActions";
import { missionsSource } from "./missionsStore";
import { HEALTH_DOT_CLASS } from "./missionTone";
import { MissionSection } from "./MissionSection";

/**
 * Sub-missions in the owner's order. The bar is the master's measured effort
 * over the last 24 hours; the tick is the share the owner intended. Dragging
 * reorders; the master works the queue top-down.
 */
export function PriorityStack(props: {
  mission: Mission;
  subMissions: ReadonlyArray<SubMission>;
  highlightId: string | null;
}) {
  const rows = useMemo(() => priorityStack(props.subMissions), [props.subMissions]);
  const sourceOrder = useMemo(() => rows.map((row) => row.subMission.id), [rows]);
  // Optimistic order while the source applies a drag; cleared when it lands.
  const [pendingOrder, setPendingOrder] = useState<ReadonlyArray<SubMissionId> | null>(null);
  const order = pendingOrder ?? sourceOrder;
  const rowsById = useMemo(
    () => new Map(rows.map((row) => [row.subMission.id, row] as const)),
    [rows],
  );
  const note = useMemo(() => effortNote(rows), [rows]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const next = moveInOrder(order, active.id as SubMissionId, over.id as SubMissionId);
    setPendingOrder(next);
    void runMissionAction(
      missionsSource.reorderSubMissions({ missionId: props.mission.id, order: next }),
      "Could not reorder sub-missions",
    ).then(() => setPendingOrder(null));
  };

  return (
    <MissionSection
      title="Priority stack"
      caption="Bar: master effort, last 24h. Tick: your intended share."
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={[...order]} strategy={verticalListSortingStrategy}>
          <ol aria-label="Sub-missions in priority order" className="flex flex-col">
            {order.map((id, index) => {
              const row = rowsById.get(id);
              if (!row) return null;
              return (
                <PriorityStackItem
                  key={id}
                  row={row}
                  position={index + 1}
                  focused={props.mission.focusSubMissionId === id}
                  highlighted={props.highlightId === id}
                />
              );
            })}
          </ol>
        </SortableContext>
      </DndContext>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <p className="text-xs text-muted-foreground/70">
        Drag to reorder. Lower sub-missions park first when capacity is short; "fills idle" ones
        only take what is left.
      </p>
    </MissionSection>
  );
}

function PriorityStackItem(props: {
  row: PriorityStackRow;
  position: number;
  focused: boolean;
  highlighted: boolean;
}) {
  const { row, position } = props;
  const sub = row.subMission;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sub.id });
  const paused = sub.status === "paused";
  const actual = row.actual;
  const intended = row.intended;
  const effortLabel =
    actual === null
      ? "Effort not measured yet"
      : `${formatPercent(actual)} of effort${intended === null ? "" : `, intended ${formatPercent(intended)}`}`;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-md py-1.5 pe-1",
        props.highlighted && "bg-accent/60",
        isDragging && "relative z-10 bg-background shadow-md",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${sub.title}, position ${position}`}
        className="row-span-2 flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing pointer-coarse:size-10"
      >
        <GripVerticalIcon aria-hidden className="size-3.5" />
      </button>
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="w-4 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
          {position}
        </span>
        <span
          role="img"
          aria-label={paused ? "Paused" : healthLabel(sub.health)}
          className={cn(
            "size-2 shrink-0 rounded-full",
            paused ? "bg-muted-foreground/25" : HEALTH_DOT_CLASS[sub.health],
          )}
        />
        <span className={cn("min-w-0 truncate font-medium", paused && "text-muted-foreground")}>
          {sub.title}
        </span>
        {props.focused ? (
          <span className="shrink-0 rounded-sm bg-info/10 px-1 text-2xs text-info-foreground">
            focus
          </span>
        ) : null}
        {sub.fillIdleCapacity ? (
          <span className="shrink-0 text-2xs text-muted-foreground">fills idle</span>
        ) : null}
        {paused ? <span className="shrink-0 text-2xs text-muted-foreground">paused</span> : null}
      </div>
      <span
        className={cn(
          "text-end text-xs tabular-nums",
          row.drift === "over"
            ? "text-warning-foreground"
            : row.drift === "under"
              ? "text-info-foreground"
              : "text-muted-foreground",
        )}
      >
        {actual === null ? "–" : formatPercent(actual)}
        {intended !== null ? (
          <span className="text-muted-foreground"> / {formatPercent(intended)}</span>
        ) : null}
      </span>
      <EffortBar actual={actual} intended={intended} label={effortLabel} drift={row.drift} />
    </li>
  );
}

function EffortBar(props: {
  actual: number | null;
  intended: number | null;
  label: string;
  drift: PriorityStackRow["drift"];
}) {
  return (
    <div
      role="img"
      aria-label={props.label}
      className="relative col-span-2 col-start-2 me-1 ms-6 h-1.5 rounded-full bg-muted"
    >
      {props.actual !== null ? (
        <div
          className={cn(
            "absolute inset-y-0 start-0 rounded-full",
            props.drift === "over" ? "bg-warning/70" : "bg-foreground/35",
          )}
          style={{ width: `${Math.min(props.actual, 1) * 100}%` }}
        />
      ) : null}
      {props.intended !== null ? (
        <div
          aria-hidden
          className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{ left: `${Math.min(props.intended, 1) * 100}%` }}
        />
      ) : null}
    </div>
  );
}
