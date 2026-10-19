import { useEffect, useLayoutEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";

import type { MissionId, MissionMessage, RoomId } from "@t3tools/contracts";
import {
  COMPOSER_TARGET_LABEL,
  composerState,
  formatRelative,
  groupRooms,
  MESSAGE_KIND_LABEL,
  MESSAGE_MAX_CHARS,
  messageAddressLine,
  noiseView,
  receiptView,
  ROOM_KIND_LABEL,
  roomName,
  statusRunLine,
  wakesFor,
  type ComposerTarget,
} from "@t3tools/client-runtime/ardud/missions";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { cn } from "../../lib/utils";
import { MetaRow } from "./cards/chips";
import { MissionLinkList } from "./MissionLinkText";
import { MissionSection } from "./MissionSection";
import { useMasterRoleId, useMissionRooms } from "./missionsStore";
import { useRoomScreen, type RoomScreen } from "./useRoomScreen";

// Rooms tab (design v3 §5). Layout only: grouping, noise, timeline folding,
// read marker, composer rules and the rule offer all come from client-runtime
// (roomsViewModel) through `useRoomScreen`. Restyle freely.

export function RoomsTab(props: { missionId: MissionId; roomId: RoomId | null; nowMs: number }) {
  const rooms = useMissionRooms(props.missionId);
  const masterRoleId = useMasterRoleId(props.missionId);
  if (!rooms) return <p className="text-sm text-muted-foreground">Loading rooms…</p>;
  const groups = groupRooms(rooms);
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
      <nav aria-label="Rooms" className="flex min-w-0 flex-col gap-3 lg:w-72 lg:shrink-0">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-1">
            <h2 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {group.label}
              {group.unread > 0 ? (
                <span className="tabular-nums text-foreground">
                  <span aria-hidden>{group.unread}</span>
                  <span className="sr-only">{`${group.unread} unread`}</span>
                </span>
              ) : null}
            </h2>
            <ul className="flex flex-col gap-1">
              {group.rooms.map(({ room, unread }) => {
                const noise = noiseView(room.noise);
                const active = room.id === props.roomId;
                return (
                  <li key={room.id}>
                    <Link
                      to="/missions/$missionId"
                      params={{ missionId: props.missionId }}
                      search={{ tab: "rooms", room: room.id }}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex flex-col rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        active ? "bg-accent" : "hover:bg-accent/50",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {roomName(room)}
                        </span>
                        {unread > 0 ? (
                          <span className="tabular-nums text-xs text-foreground">{unread}</span>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <MetaRow>
                          <span>{ROOM_KIND_LABEL[room.kind]}</span>
                          {noise ? <span>{noise.line}</span> : null}
                        </MetaRow>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {props.roomId ? (
          <OpenRoom
            key={props.roomId}
            missionId={props.missionId}
            roomId={props.roomId}
            masterRoleId={masterRoleId}
            nowMs={props.nowMs}
          />
        ) : null}
      </div>
    </div>
  );
}

function OpenRoom(props: {
  missionId: MissionId;
  roomId: RoomId;
  masterRoleId: string | null;
  nowMs: number;
}) {
  const screen = useRoomScreen(props.missionId, props.roomId, props.masterRoleId);
  const { page, view } = screen;
  if (page === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (page === null) return <p className="text-sm text-muted-foreground">Room not found.</p>;
  const noise = noiseView(page.room.noise);
  const waking = screen.members.filter((member) => member.mode === "wake").length;
  return (
    <MissionSection
      title={roomName(page.room)}
      caption={
        <MetaRow>
          <span>{ROOM_KIND_LABEL[page.room.kind]}</span>
          <span>{`${screen.members.length} members, ${waking} wake on posts`}</span>
          {noise ? <span>{noise.line}</span> : null}
        </MetaRow>
      }
    >
      {view ? (
        <RoomTimeline screen={screen} masterRoleId={props.masterRoleId} nowMs={props.nowMs} />
      ) : null}
      <RuleOffer screen={screen} />
      <RoomComposer screen={screen} />
    </MissionSection>
  );
}

function RoomTimeline(props: { screen: RoomScreen; masterRoleId: string | null; nowMs: number }) {
  const { screen } = props;
  const view = screen.view;
  const scroller = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const firstSeq = view?.messages[0]?.seq ?? null;
  const lastSeq = view?.messages[view.messages.length - 1]?.seq ?? null;
  const anchor = useRef<{ firstSeq: number | null; height: number } | null>(null);

  // Open at the read marker (or the newest message); keep the reading
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
  return (
    <div ref={scroller} className="flex max-h-[65vh] min-h-48 flex-col overflow-y-auto">
      <div ref={top} className="py-1 text-center text-xs text-muted-foreground">
        {screen.ui.loadingOlder
          ? "Loading older messages…"
          : view.hasOlder
            ? "Scroll up for older messages"
            : "Start of the room"}
      </div>
      <ol className="flex flex-col gap-2">
        {view.rows.map((row) => {
          switch (row.kind) {
            case "day":
              return (
                <li key={row.key} className="py-1 text-center text-xs text-muted-foreground">
                  {row.day}
                </li>
              );
            case "read-marker":
              return (
                <li
                  key={row.key}
                  data-read-marker
                  className="border-t border-destructive/60 pt-0.5 text-xs text-destructive-foreground"
                >
                  {row.unread} new since you last read
                </li>
              );
            case "status-run":
              return (
                <li key={row.key} className="flex flex-col gap-1">
                  <button
                    type="button"
                    aria-expanded={row.expanded}
                    onClick={() => screen.dispatch({ type: "toggle-run", key: row.key })}
                    className="self-start rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {statusRunLine(row.messages.length)} {row.expanded ? "Collapse" : "Expand"}
                  </button>
                  {row.expanded ? (
                    <ol className="flex flex-col gap-1">
                      {row.messages.map((message) => (
                        <MessageRow
                          key={message.id}
                          message={message}
                          masterRoleId={props.masterRoleId}
                          nowMs={props.nowMs}
                          compact
                        />
                      ))}
                    </ol>
                  ) : null}
                </li>
              );
            case "message":
              return (
                <MessageRow
                  key={row.key}
                  message={row.message}
                  masterRoleId={props.masterRoleId}
                  nowMs={props.nowMs}
                  compact={row.message.kind === "status"}
                />
              );
          }
        })}
      </ol>
    </div>
  );
}

const KIND_BADGE = {
  request: "info",
  decision: "success",
  status: "outline",
  evidence: "secondary",
  blocker: "error",
  control: "warning",
} as const;

function MessageRow(props: {
  message: MissionMessage;
  masterRoleId: string | null;
  nowMs: number;
  compact?: boolean;
}) {
  const { message } = props;
  const receipt = receiptView(message.receipt);
  return (
    <li className={cn("flex min-w-0 flex-col gap-0.5 text-sm", props.compact && "text-xs")}>
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <Badge variant={KIND_BADGE[message.kind]} size="sm">
          {MESSAGE_KIND_LABEL[message.kind]}
        </Badge>
        <span>{messageAddressLine(message, props.masterRoleId)}</span>
        <span className="tabular-nums">#{message.seq}</span>
        <span>{formatRelative(message.createdAt, props.nowMs)}</span>
        {receipt ? (
          <span className={receipt.complete ? undefined : "text-warning-foreground"}>
            {receipt.label}
          </span>
        ) : null}
        {receipt?.pending ? (
          <span className="text-warning-foreground">{receipt.pending}</span>
        ) : null}
      </div>
      <p className={cn("text-pretty", props.compact ? "text-muted-foreground" : "text-foreground")}>
        {message.summary}
      </p>
      {message.links.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          <MissionLinkList links={message.links} />
        </p>
      ) : null}
    </li>
  );
}

function RuleOffer(props: { screen: RoomScreen }) {
  const offer = props.screen.ruleOffer;
  if (offer === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2 text-sm">
      <span className="min-w-0 flex-1">Scribe: turn your correction into a standing rule?</span>
      <Button size="xs" onClick={() => void props.screen.saveRule(offer)}>
        Save as a rule
      </Button>
      <Button size="xs" variant="ghost" onClick={() => props.screen.skipRule(offer)}>
        Not now
      </Button>
    </div>
  );
}

function RoomComposer(props: { screen: RoomScreen }) {
  const { screen } = props;
  const { target, text } = screen.ui;
  const state = composerState(text);
  const lanes = screen.members;
  const laneKey = target.kind === "lane" ? lanesKeyOf(lanes, target) : null;
  const setKind = (kind: ComposerTarget["kind"]) => {
    if (kind === "lane") {
      const first = lanes[0];
      if (first) screen.dispatch({ type: "target", target: { kind: "lane", member: first } });
      return;
    }
    screen.dispatch({ type: "target", target: { kind } });
  };
  const wakes =
    target.kind === "room" ? wakesFor(lanes, "control").map((member) => member.label) : null;
  return (
    <form
      className="flex flex-col gap-2 border-t border-border/60 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void screen.send();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label="Who the message is for"
          value={[target.kind]}
          onValueChange={(next) => {
            const kind = next[0] as ComposerTarget["kind"] | undefined;
            if (kind) setKind(kind);
          }}
        >
          {(Object.keys(COMPOSER_TARGET_LABEL) as ComposerTarget["kind"][]).map((kind) => (
            <Toggle key={kind} value={kind} disabled={kind === "lane" && lanes.length === 0}>
              {COMPOSER_TARGET_LABEL[kind]}
            </Toggle>
          ))}
        </ToggleGroup>
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
      </div>
      <Textarea
        size="sm"
        aria-label="Message"
        placeholder={
          target.kind === "correction"
            ? "Correct the master. It arrives as your instruction."
            : "Message the room…"
        }
        value={text}
        onChange={(event) => screen.dispatch({ type: "text", text: event.target.value })}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("tabular-nums", state.overLimit && "text-destructive-foreground")}>
          {state.remaining} of {MESSAGE_MAX_CHARS} left
        </span>
        {wakes && wakes.length > 0 ? <span>Wakes {wakes.join(", ")}</span> : null}
        <Button type="submit" size="sm" className="ms-auto" disabled={!state.canSend}>
          Send
        </Button>
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
