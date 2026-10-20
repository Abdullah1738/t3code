import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

import type {
  LaneId,
  MissionId,
  MissionMessage,
  MissionMessageKind,
  RoomId,
} from "@t3tools/contracts";
import {
  COMPOSER_TARGET_LABEL,
  composerState,
  formatTimeOfDay,
  groupRooms,
  MESSAGE_KIND_LABEL,
  messageParties,
  receiptNudgeLanes,
  receiptView,
  roomChipLabel,
  roomFigures,
  roomListLine,
  roomMembersLine,
  statusRunLine,
  type ActorNames,
  type ComposerTarget,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { DESK_ROW, DeskChip, FeedErrors, Segmented, TabLoading } from "./deskParts";
import { nudgePending } from "./deskCommands";
import { MissionLinkList } from "./MissionLinkText";
import {
  useMasterRoleId,
  useMissionRooms,
  useMissionRoomsFeed,
  useRoomPageFeed,
} from "./missionsStore";
import { RemovedRooms, RoomActions, RoomPanelView, type RoomPanel } from "./RoomTools";
import { useRoomScreen, type RoomScreen } from "./useRoomScreen";

// Rooms tab, Desk layout: the room list next to the open room. On a phone the
// list comes first and a room opens on its own with a way back. Grouping,
// names, folding, the read marker and composer rules come from client-runtime
// (roomsViewModel) through `useRoomScreen`.

const COUNT = new Intl.NumberFormat("en-US");

const roomTitle = (title: string) => title.replace(/^#/, "");

export function RoomsTab(props: { missionId: MissionId; roomId: RoomId | null; nowMs: number }) {
  const rooms = useMissionRooms(props.missionId);
  const feeds = [useMissionRoomsFeed(props.missionId)];
  const masterRoleId = useMasterRoleId(props.missionId);
  const wide = useMediaQuery({ min: "lg" });
  if (!rooms)
    return <TabLoading label="Loading rooms…" what="the rooms" feeds={feeds} nowMs={props.nowMs} />;
  const groups = groupRooms(rooms);
  // On a wide screen a room is always open: the first one until the owner picks.
  const openId = props.roomId ?? (wide ? (groups[0]?.rooms[0]?.room.id ?? null) : null);
  const openEntry = rooms.find((entry) => entry.room.id === openId) ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <FeedErrors what="the rooms" feeds={feeds} nowMs={props.nowMs} />
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <nav
          aria-label="Rooms"
          className={cn("flex min-w-0 flex-col gap-1", props.roomId !== null && "max-lg:hidden")}
        >
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col">
              <h2 className="flex items-center justify-between px-3 pt-3.5 pb-1.5 text-xs text-(--m-muted)">
                {group.label}
                {group.unread > 0 ? (
                  <span className="tabular-nums">{`${COUNT.format(group.unread)} unread`}</span>
                ) : null}
              </h2>
              <ul className="flex flex-col">
                {group.rooms.map(({ room, unread }) => {
                  const line = roomListLine(room, props.nowMs);
                  const active = room.id === openId;
                  return (
                    <li key={room.id}>
                      <Link
                        to="/missions/$missionId"
                        params={{ missionId: props.missionId }}
                        search={{ tab: "rooms", room: room.id }}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-xl px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset",
                          active ? "bg-(--m-active)" : "hover:bg-(--m-surface)",
                        )}
                      >
                        <span
                          className={cn(
                            "min-w-0 truncate text-(--m-text)",
                            unread > 0 ? "font-semibold" : "font-medium",
                          )}
                        >
                          {roomTitle(room.title)}
                        </span>
                        {unread > 0 ? (
                          <span className="text-xs font-semibold text-(--m-accent-text) tabular-nums">
                            <span aria-hidden>{COUNT.format(unread)}</span>
                            <span className="sr-only">{`${unread} unread`}</span>
                          </span>
                        ) : (
                          <span />
                        )}
                        {line ? (
                          <span className="col-span-2 min-w-0 truncate text-xs text-(--m-muted) tabular-nums">
                            {line}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <RemovedRooms rooms={rooms} />
        </nav>
        {openId !== null ? (
          <div className="flex min-w-0 flex-col gap-3">
            <Link
              to="/missions/$missionId"
              params={{ missionId: props.missionId }}
              search={{ tab: "rooms" }}
              className="self-start rounded-full text-sm text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset lg:hidden"
            >
              All rooms
            </Link>
            <OpenRoom
              key={openId}
              missionId={props.missionId}
              roomId={openId}
              masterRoleId={masterRoleId}
              messageCount={openEntry?.room.messageCount ?? null}
              nowMs={props.nowMs}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function OpenRoom(props: {
  missionId: MissionId;
  roomId: RoomId;
  masterRoleId: string | null;
  messageCount: number | null;
  nowMs: number;
}) {
  const screen = useRoomScreen(props.missionId, props.roomId, props.masterRoleId);
  const feeds = [useRoomPageFeed(props.roomId)];
  const [panel, setPanel] = useState<RoomPanel>(null);
  const { page, view } = screen;
  if (page === undefined)
    return <TabLoading label="Loading…" what="the room" feeds={feeds} nowMs={props.nowMs} />;
  if (page === null) return <p className="text-sm text-(--m-muted)">Room not found.</p>;
  const membersLine = roomMembersLine(screen.members);
  const stats = roomFigures(page.room.noise, props.messageCount);
  return (
    <section
      aria-labelledby="open-room-title"
      className="flex min-w-0 flex-col rounded-3xl bg-(--m-surface) px-4.5 pt-5 pb-5 text-(--m-text) sm:px-7 sm:pt-6 sm:pb-7"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <DeskChip>{roomChipLabel(page.room.kind)}</DeskChip>
        {membersLine ? (
          <span className="text-xs text-(--m-muted) tabular-nums">{membersLine}</span>
        ) : null}
        <RoomActions
          missionId={props.missionId}
          room={page.room}
          panel={panel}
          onPanel={setPanel}
        />
      </div>
      <h2 id="open-room-title" className="mt-2.5 text-2xl font-normal text-pretty">
        {roomTitle(page.room.title)}
      </h2>
      <FeedErrors what="the room" feeds={feeds} nowMs={props.nowMs} />
      {stats.length > 0 ? (
        <dl className="mt-4.5 grid max-w-160 grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col">
              <dt className="text-xs text-(--m-muted)">{stat.label}</dt>
              <dd className="text-xl tabular-nums">{stat.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <RoomPanelView
        missionId={props.missionId}
        room={page.room}
        subscriptions={page.subscriptions}
        masterRoleId={props.masterRoleId}
        panel={panel}
        onClose={() => setPanel(null)}
      />
      {view ? (
        <RoomStream screen={screen} masterRoleId={props.masterRoleId} names={page.names} />
      ) : null}
      <RoomComposer screen={screen} roomTitle={roomTitle(page.room.title)} />
    </section>
  );
}

function RoomStream(props: {
  screen: RoomScreen;
  masterRoleId: string | null;
  names: ActorNames | undefined;
}) {
  const { screen } = props;
  const view = screen.view;
  const scroller = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const firstSeq = view?.messages[0]?.seq ?? null;
  const lastSeq = view?.messages[view.messages.length - 1]?.seq ?? null;
  const anchor = useRef<{ firstSeq: number | null; height: number } | null>(null);

  // Open at the "new" divider (or the newest message); keep the reading
  // position when an older page is prepended; follow new messages at the bottom.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || lastSeq === null) return;
    const previous = anchor.current;
    if (previous === null) {
      const marker = element.querySelector("[data-read-marker]");
      if (marker instanceof HTMLElement) element.scrollTop = marker.offsetTop - element.offsetTop;
      else element.scrollTop = element.scrollHeight;
    } else if (previous.firstSeq !== firstSeq) {
      element.scrollTop += element.scrollHeight - previous.height;
    } else if (element.scrollHeight - element.scrollTop - element.clientHeight < 120) {
      element.scrollTop = element.scrollHeight;
    }
    anchor.current = { firstSeq, height: element.scrollHeight };
  }, [firstSeq, lastSeq]);

  const loadOlder = screen.loadOlder;
  const canLoadOlder = view?.olderRequest != null;
  useEffect(() => {
    const element = top.current;
    if (!element || !canLoadOlder) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadOlder();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [canLoadOlder, loadOlder]);

  if (!view) return null;
  const row = (message: MissionMessage) => (
    <MessageRow
      key={message.id}
      message={message}
      masterRoleId={props.masterRoleId}
      names={props.names}
    />
  );
  return (
    <div
      ref={scroller}
      className="mt-4.5 flex max-h-[65vh] min-h-48 max-w-[76ch] flex-col overflow-y-auto"
    >
      <div ref={top} className="min-h-px">
        {screen.ui.loadingOlder ? (
          <p className="h-9 text-sm text-(--m-muted)">Loading…</p>
        ) : canLoadOlder ? (
          <button
            type="button"
            onClick={loadOlder}
            className="flex h-9 w-full items-center text-start text-sm text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset"
          >
            Show earlier
          </button>
        ) : null}
      </div>
      <ol className="flex flex-col">
        {view.rows.map((item) => {
          switch (item.kind) {
            case "day":
              return (
                <li key={item.key} className="pt-4 pb-1.5 text-xs text-(--m-muted)">
                  {item.day}
                </li>
              );
            case "read-marker":
              return (
                <li
                  key={item.key}
                  data-read-marker
                  className="flex items-center gap-2.5 py-1.5 text-xs font-semibold text-(--m-accent-text) tabular-nums after:h-px after:flex-1 after:bg-(--m-accent)/45"
                >
                  {`${COUNT.format(item.unread)} new`}
                </li>
              );
            case "status-run":
              return (
                <li key={item.key} className={cn("flex flex-col", DESK_ROW)}>
                  <button
                    type="button"
                    aria-expanded={item.expanded}
                    onClick={() => screen.dispatch({ type: "toggle-run", key: item.key })}
                    className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-3 py-2.5 text-start text-sm text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset"
                  >
                    <span />
                    <span className="tabular-nums">{statusRunLine(item.messages)}</span>
                  </button>
                  {item.expanded ? (
                    <ol className="flex flex-col">{item.messages.map(row)}</ol>
                  ) : null}
                </li>
              );
            case "message":
              return row(item.message);
          }
        })}
      </ol>
    </div>
  );
}

const KIND_TONE: Partial<Record<MissionMessageKind, string>> = {
  decision: "text-(--m-accent-text)",
  blocker: "text-(--m-negative)",
};

function MessageRow(props: {
  message: MissionMessage;
  masterRoleId: string | null;
  names: ActorNames | undefined;
}) {
  const { message } = props;
  const receipt = receiptView(message.receipt);
  const nudgeLanes = receiptNudgeLanes(message.receipt);
  const parties = messageParties(message, props.masterRoleId, props.names);
  return (
    <li
      className={cn(
        "grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-x-3 py-2.5 text-sm max-sm:grid-cols-[38px_minmax(0,1fr)]",
        DESK_ROW,
      )}
    >
      <time dateTime={message.createdAt} className="pt-0.5 text-xs text-(--m-muted) tabular-nums">
        {formatTimeOfDay(message.createdAt)}
      </time>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <b className="font-semibold">{parties.from}</b>
          {parties.to ? <span className="text-xs text-(--m-muted)">to {parties.to}</span> : null}
          <span
            className={cn(
              "inline-flex h-5 items-center rounded-full bg-(--m-chip) px-2 text-xs",
              KIND_TONE[message.kind] ?? "text-(--m-muted)",
            )}
          >
            {MESSAGE_KIND_LABEL[message.kind].toLowerCase()}
          </span>
          {receipt ? (
            <span className="text-xs text-(--m-muted) tabular-nums">
              {receipt.label}
              {receipt.pending ? (
                <span className="text-(--m-warning)">{`, ${receipt.pending}`}</span>
              ) : null}
            </span>
          ) : null}
          {nudgeLanes.length > 0 ? <NudgeButton message={message} laneIds={nudgeLanes} /> : null}
        </div>
        <p className="text-pretty">{message.summary}</p>
        {message.links.length > 0 ? (
          <p className="text-xs text-(--m-muted)">
            <MissionLinkList links={message.links} />
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** Nudges the lanes a control post has not reached; once per open room. */
function NudgeButton(props: { message: MissionMessage; laneIds: ReadonlyArray<LaneId> }) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      disabled={state !== "idle"}
      onClick={async () => {
        setState("busy");
        setState((await nudgePending(props.message, props.laneIds)) ? "sent" : "idle");
      }}
    >
      {state === "sent" ? "Nudged" : "Nudge"}
    </Button>
  );
}

/** Characters left shows only near the limit. */
const NEAR_LIMIT = 40;

function RoomComposer(props: { screen: RoomScreen; roomTitle: string }) {
  const { screen } = props;
  const { target, text } = screen.ui;
  const [asRule, setAsRule] = useState(false);
  const state = composerState(text);
  const lanes = screen.members;
  const laneKey = target.kind === "lane" ? lanesKeyOf(lanes, target) : null;
  const kinds = (Object.keys(COMPOSER_TARGET_LABEL) as ComposerTarget["kind"][]).filter(
    (kind) => kind !== "lane" || lanes.length > 0,
  );
  const setKind = (kind: ComposerTarget["kind"]) => {
    if (kind === "lane") {
      const first = lanes[0];
      if (first) screen.dispatch({ type: "target", target: { kind: "lane", member: first } });
      return;
    }
    screen.dispatch({ type: "target", target: { kind } });
  };
  return (
    <form
      className="mt-4.5 flex max-w-[76ch] flex-col gap-2 rounded-3xl bg-(--m-raised) py-3 ps-4.5 pe-3.5 text-sm text-(--m-text)"
      onSubmit={(event) => {
        event.preventDefault();
        const saveAsRule = target.kind === "correction" && asRule;
        void screen.send(saveAsRule).then((sent) => {
          if (sent) setAsRule(false);
        });
      }}
    >
      <Textarea
        unstyled
        aria-label="Message"
        placeholder={
          target.kind === "correction" ? "Correct the master" : `Post to ${props.roomTitle}`
        }
        value={text}
        onChange={(event) => screen.dispatch({ type: "text", text: event.target.value })}
        className="w-full"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Who the post is for"
          value={target.kind}
          options={kinds.map((kind) => ({ value: kind, label: COMPOSER_TARGET_LABEL[kind] }))}
          onChange={setKind}
        />
        {target.kind === "lane" ? (
          <Select
            value={laneKey ?? ""}
            onValueChange={(value) => {
              const member = lanes.find((item) => item.key === value);
              if (member) screen.dispatch({ type: "target", target: { kind: "lane", member } });
            }}
          >
            <SelectTrigger aria-label="Lane" size="sm" className="w-40">
              <SelectValue>{target.member.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {lanes.map((member) => (
                <SelectItem key={member.key} value={member.key}>
                  {member.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        {target.kind === "correction" ? (
          <label className="flex items-center gap-2 text-sm text-(--m-muted)">
            <Checkbox checked={asRule} onCheckedChange={(checked) => setAsRule(checked)} />
            Save as a rule
          </label>
        ) : null}
        <span className="ms-auto flex items-center gap-3">
          {state.remaining < NEAR_LIMIT ? (
            <span
              className={cn(
                "text-xs tabular-nums",
                state.overLimit ? "text-(--m-negative)" : "text-(--m-muted)",
              )}
            >
              {state.remaining}
            </span>
          ) : null}
          <Button type="submit" size="sm" disabled={!state.canSend}>
            Send
          </Button>
        </span>
      </div>
    </form>
  );
}

function lanesKeyOf(
  lanes: RoomScreen["members"],
  target: Extract<ComposerTarget, { kind: "lane" }>,
): string | null {
  return lanes.find((member) => member.label === target.member.label)?.key ?? null;
}
