import { useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import type { MissionId, Room, SubMissionId, Subscription } from "@t3tools/contracts";
import {
  canRemoveRoom,
  removedRooms,
  wakeTable,
  type MissionRoomEntry,
  type WakeCell,
  type WakeColumn,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { Switch } from "../../components/ui/switch";
import { DESK_ROW } from "./deskParts";
import { moveRoom, removeRoom, renameRoom, restoreRoom, setRoomWake } from "./deskCommands";
import { PickForm, TextActionForm } from "./MissionForms";
import { useMissionOverview } from "./missionsStore";

// The open room's Tune / Rename / Move / Remove, the "Who each kind wakes"
// table, and the removed rooms with Restore. Owner or master only; the router
// refuses anyone else. Inputs are built in client-runtime (roomsViewModel).

export type RoomPanel = "tune" | "rename" | "move" | null;

const COUNT = new Intl.NumberFormat("en-US");
const NO_SUB_MISSION = "none";

/** Tune toggles the wake table; the menu holds the rest. */
export function RoomActions(props: {
  missionId: MissionId;
  room: Room;
  panel: RoomPanel;
  onPanel: (panel: RoomPanel) => void;
}) {
  const navigate = useNavigate();
  const toggle = (panel: Exclude<RoomPanel, null>) =>
    props.onPanel(props.panel === panel ? null : panel);
  if (props.room.kind === "owner-request") return null;
  return (
    <div className="ms-auto flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost-muted"
        aria-expanded={props.panel === "tune"}
        onClick={() => toggle("tune")}
      >
        Tune
      </Button>
      <Menu>
        <MenuTrigger
          render={<Button size="icon-xs" variant="ghost-muted" aria-label="Room menu" />}
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          <MenuItem onClick={() => toggle("rename")}>Rename</MenuItem>
          <MenuItem onClick={() => toggle("move")}>Move</MenuItem>
          {canRemoveRoom(props.room) && !props.room.archived ? (
            <>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                onClick={async () => {
                  if (!(await removeRoom(props.room))) return;
                  void navigate({
                    to: "/missions/$missionId",
                    params: { missionId: props.missionId },
                    search: { tab: "rooms" },
                  });
                }}
              >
                Remove
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** The panel the actions opened, under the room's figures. */
export function RoomPanelView(props: {
  missionId: MissionId;
  room: Room;
  subscriptions: ReadonlyArray<Subscription>;
  masterRoleId: string | null;
  panel: RoomPanel;
  onClose: () => void;
}) {
  if (props.panel === "tune") return <WakeTable {...props} />;
  if (props.panel === "rename") {
    return (
      <div className="mt-4">
        <TextActionForm
          label="Room name"
          submitLabel="Rename"
          initial={props.room.title.replace(/^#/, "")}
          onSubmit={async (title) => {
            const done = await renameRoom(props.room, title);
            if (done) props.onClose();
            return done;
          }}
        />
      </div>
    );
  }
  if (props.panel === "move") return <MoveForm {...props} />;
  return null;
}

function MoveForm(props: { missionId: MissionId; room: Room; onClose: () => void }) {
  const overview = useMissionOverview(props.missionId);
  const options = [
    { value: NO_SUB_MISSION, label: "No sub-mission" },
    ...(overview?.subMissions ?? [])
      .filter((sub) => sub.status !== "closed" || sub.id === props.room.subMissionId)
      .map((sub) => ({ value: sub.id, label: sub.title })),
  ];
  return (
    <div className="mt-4">
      <PickForm
        label="Sub-mission"
        options={options}
        submitLabel="Move"
        onSubmit={async (value) => {
          const target = value === NO_SUB_MISSION ? null : (value as SubMissionId);
          const done = await moveRoom(props.room, target);
          if (done) props.onClose();
          return done;
        }}
      />
    </div>
  );
}

function WakeTable(props: {
  room: Room;
  subscriptions: ReadonlyArray<Subscription>;
  masterRoleId: string | null;
}) {
  const rows = wakeTable(props.subscriptions, props.masterRoleId, props.room.noise);
  const [busy, setBusy] = useState(false);
  const cell = (row: (typeof rows)[number], column: WakeColumn, value: WakeCell) => {
    const who = column === "lanes" ? "lanes" : "the master";
    if (value.empty && (column === "lanes" || props.masterRoleId === null)) {
      return <span className="text-(--m-muted)">None</span>;
    }
    return (
      <Switch
        size="sm"
        aria-label={`${row.label} wakes ${who}`}
        checked={value.on}
        disabled={value.fixed || busy}
        onCheckedChange={async (on) => {
          setBusy(true);
          await setRoomWake(
            props.room,
            props.subscriptions,
            props.masterRoleId,
            column,
            row.kind,
            on,
          );
          setBusy(false);
        }}
      />
    );
  };
  return (
    <section aria-labelledby="room-wakes-title" className="mt-5 max-w-160">
      <h3 id="room-wakes-title" className="text-sm font-semibold">
        Who each kind wakes
      </h3>
      <table className="mt-2 w-full text-sm">
        <thead className="text-start text-xs text-(--m-muted)">
          <tr>
            <th scope="col" className="py-1.5 text-start font-normal">
              Kind
            </th>
            <th scope="col" className="py-1.5 text-end font-normal">
              24h
            </th>
            <th scope="col" className="py-1.5 ps-6 text-start font-normal">
              Lanes
            </th>
            <th scope="col" className="py-1.5 text-start font-normal">
              Master
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.kind} className={DESK_ROW}>
              <th scope="row" className="py-2 text-start font-normal">
                {row.label}
              </th>
              <td className="py-2 text-end tabular-nums">
                {row.lastDay === null ? "" : COUNT.format(row.lastDay)}
              </td>
              <td className="py-2 ps-6">{cell(row, "lanes", row.lanes)}</td>
              <td className="py-2">{cell(row, "master", row.master)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Removed rooms under the list, folded, each with Restore. */
export function RemovedRooms(props: { rooms: ReadonlyArray<MissionRoomEntry> }) {
  const removed = removedRooms(props.rooms);
  const [open, setOpen] = useState(false);
  if (removed.length === 0) return null;
  return (
    <div className="flex flex-col px-3 pt-3.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="self-start rounded-md text-xs text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset"
      >
        {`Removed ${removed.length}`}
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col">
          {removed.map((room) => (
            <li
              key={room.id}
              className={`flex items-center justify-between gap-3 py-1.5 text-sm ${DESK_ROW}`}
            >
              <span className="min-w-0 truncate text-(--m-muted)">
                {room.title.replace(/^#/, "")}
              </span>
              <Button size="xs" variant="ghost-muted" onClick={() => void restoreRoom(room)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
