import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CrosshairIcon, MessageCircleQuestionIcon, PauseIcon, PlayIcon } from "lucide-react";

import type { MissionId, MissionOverview, SubMissionId } from "@t3tools/contracts";
import {
  formatTimeOfDay,
  laneTotal,
  pageTabs,
  priorityStack,
  resolveMissionLayout,
  type MissionOverviewSnapshot,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../components/ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { Chip, StateGlyph } from "./cards/chips";
import { setMissionFocus, toggleMissionPaused } from "./missionCommands";
import { MISSION_TAB_LABEL, MISSION_TABS, type MissionTab } from "./missionSearch";
import { useMissionRooms, useMissionViews } from "./missionsStore";
import { RequestComposer, useRequestOpener } from "./sections/YourRequests";
import { useMissionsConnection } from "./useMissionsConnection";

/**
 * The mission toolbar: tabs on the left; the connection, focus, pause and
 * Ask the master on the right. The focus bar shows under it while a
 * sub-mission has the focus.
 */
export function MissionToolbar(props: { overview: MissionOverviewSnapshot; tab: MissionTab }) {
  const { overview } = props;
  const { mission } = overview;
  const paused = mission.status === "paused";
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* The board's greeting is its h1; other tabs name the mission for readers. */}
      {props.tab === "overview" ? null : <h1 className="sr-only">{mission.title}</h1>}
      <div className="flex min-w-0 items-center justify-between gap-6">
        <MissionTabs overview={overview} tab={props.tab} />
        <div className="flex shrink-0 items-center gap-1.5">
          <ConnectionChip />
          <FocusMenu overview={overview} />
          {paused ? <Chip>Paused</Chip> : null}
          <PauseButton missionId={mission.id} title={mission.title} paused={paused} />
          <AskTheMaster missionId={mission.id} />
        </div>
      </div>
      <FocusBar overview={overview} />
    </div>
  );
}

const ALL_TABS = MISSION_TABS.map((tab) => ({ tab, title: MISSION_TAB_LABEL[tab] }));

/** The layout's tabs in its order and names, with counts where the page knows them. */
function MissionTabs(props: { overview: MissionOverviewSnapshot; tab: MissionTab }) {
  const missionId = props.overview.mission.id;
  const views = useMissionViews(missionId);
  const rooms = useMissionRooms(missionId);
  const tabs = useMemo(
    () =>
      views
        ? pageTabs(resolveMissionLayout(views.snapshot), MISSION_TAB_LABEL, props.tab)
        : ALL_TABS,
    [views, props.tab],
  );
  const counts: Partial<Record<MissionTab, number>> = {
    // Removed rooms stay in the feed for Restore; the tab counts the open ones.
    ...(rooms ? { rooms: rooms.filter((entry) => !entry.room.archived).length } : {}),
    lanes: laneTotal(props.overview.lanes),
  };
  return (
    <nav
      aria-label="Mission sections"
      className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]"
    >
      <ul className="flex min-w-max gap-5.5">
        {tabs.map(({ tab, title }) => {
          const active = tab === props.tab;
          const count = counts[tab];
          return (
            <li key={tab}>
              <Link
                to="/missions/$missionId"
                params={{ missionId }}
                search={tab === "overview" ? {} : { tab }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9.5 items-center gap-1.5 border-b-2 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11",
                  active
                    ? "border-(--m-text) font-medium text-(--m-text)"
                    : "border-transparent text-(--m-muted) hover:text-(--m-text)",
                )}
              >
                {title}
                {count !== undefined && count > 0 ? (
                  <span className="text-xs font-normal text-(--m-muted) tabular-nums">{count}</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** "Reconnecting" with the last update time while the server is out of reach. */
function ConnectionChip() {
  const connection = useMissionsConnection();
  if (connection.label === null) return null;
  return (
    <span role="status" className="flex items-center gap-2.5">
      <span className="inline-flex h-8 items-center gap-2 rounded-full bg-(--m-surface) px-3.5 text-sm font-medium whitespace-nowrap">
        <StateGlyph kind="wait" />
        {connection.label}
      </span>
      {connection.lastUpdateAt !== null ? (
        <span className="text-xs whitespace-nowrap text-(--m-muted) max-sm:sr-only">
          Last update {formatTimeOfDay(new Date(connection.lastUpdateAt).toISOString())}
        </span>
      ) : null}
    </span>
  );
}

function FocusMenu(props: { overview: MissionOverview }) {
  const { mission } = props.overview;
  const rows = useMemo(
    () =>
      priorityStack(props.overview.subMissions).filter((row) => row.subMission.status === "active"),
    [props.overview.subMissions],
  );
  // Focus has no end time: it stays on until someone ends it (the focus bar or the master).
  const setFocus = (value: unknown) => {
    if (typeof value !== "string" || value === mission.focusSubMissionId) return;
    void setMissionFocus(mission.id, value as SubMissionId);
  };
  if (rows.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="sm" />}>
        <CrosshairIcon aria-hidden />
        <span className="max-sm:sr-only">Focus</span>
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <MenuGroup>
          <MenuGroupLabel>Focus on</MenuGroupLabel>
          <MenuRadioGroup value={mission.focusSubMissionId ?? ""} onValueChange={setFocus}>
            {rows.map((row) => (
              <MenuRadioItem key={row.subMission.id} value={row.subMission.id} closeOnClick>
                <span className="w-4 shrink-0 text-xs text-(--m-muted) tabular-nums">
                  {row.position}
                </span>
                {row.subMission.title}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/** Shown while one sub-mission is the only one taking new work. */
function FocusBar(props: { overview: MissionOverview }) {
  const { mission, subMissions } = props.overview;
  if (mission.focusSubMissionId === null) return null;
  const focused = subMissions.find((sub) => sub.id === mission.focusSubMissionId);
  return (
    <div
      role="status"
      className="mt-3.5 flex max-w-140 min-w-0 items-center gap-2.5 rounded-lg bg-(--m-band) py-1.5 ps-3 pe-1.5 text-sm"
    >
      <CrosshairIcon aria-hidden className="size-4 shrink-0 text-(--m-accent-text)" />
      <span className="min-w-0 flex-1 truncate font-medium">
        Focused on {focused?.title ?? "a closed sub-mission"}
      </span>
      <Button variant="outline" size="sm" onClick={() => void setMissionFocus(mission.id, null)}>
        End focus
      </Button>
    </div>
  );
}

function PauseButton(props: { missionId: MissionId; title: string; paused: boolean }) {
  return (
    <Button
      variant={props.paused ? "default" : "ghost-muted"}
      size="sm"
      onClick={() => void toggleMissionPaused(props)}
    >
      {props.paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
      <span className="max-sm:sr-only">{props.paused ? "Resume" : "Pause"}</span>
    </Button>
  );
}

/** A question to the master from any tab: it opens one of Your requests. */
function AskTheMaster(props: { missionId: MissionId }) {
  const [open, setOpen] = useState(false);
  const openRequest = useRequestOpener(props.missionId);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="secondary" size="sm" />}>
        <MessageCircleQuestionIcon aria-hidden />
        <span className="max-sm:sr-only">Ask the master</span>
      </PopoverTrigger>
      <PopoverPopup align="end" side="bottom" className="w-80">
        <PopoverTitle>Ask the master</PopoverTitle>
        <div className="mt-2">
          <RequestComposer
            missionId={props.missionId}
            autoFocus
            onOpened={(id) => {
              setOpen(false);
              openRequest(id);
            }}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
