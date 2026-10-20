import type { InboxTab, MissionId } from "@t3tools/contracts";
import { INBOX_TABS } from "@t3tools/client-runtime/ardud/missions/mobile";

/** The in-screen bar at the foot of the Missions area. */
export type MissionsTab = "inbox" | "missions" | "rooms";

export const MISSIONS_TABS: ReadonlyArray<{ readonly value: MissionsTab; readonly label: string }> =
  [
    { value: "inbox", label: "Inbox" },
    { value: "missions", label: "Missions" },
    { value: "rooms", label: "Rooms" },
  ];

/** Pages of one mission, scrolled sideways under the header. */
export type MissionPage = "board" | "requests" | "lanes";

export const MISSION_PAGES: ReadonlyArray<{ readonly value: MissionPage; readonly label: string }> =
  [
    { value: "board", label: "Board" },
    { value: "requests", label: "Your requests" },
    { value: "lanes", label: "Lanes" },
  ];

/** Route params for the Missions area. Deep links deliver plain strings. */
export type MissionsRouteParams = {
  readonly tab?: string | undefined;
  readonly missionId?: string | undefined;
  readonly page?: string | undefined;
  readonly inboxTab?: string | undefined;
};

export interface MissionsRouteState {
  readonly tab: MissionsTab;
  /** The mission the area is inside, or `null` for every mission. */
  readonly missionId: MissionId | null;
  readonly page: MissionPage;
  /** Inbox kind filter; `null` shows everything waiting on the owner. */
  readonly inboxTab: InboxTab | null;
}

function missionIdOf(value: string | undefined): MissionId | null {
  return value?.trim() ? (value.trim() as MissionId) : null;
}

/** Reads route params, falling back for anything unknown. Opens on the inbox. */
export function missionsRouteState(params: MissionsRouteParams | undefined): MissionsRouteState {
  return {
    tab: MISSIONS_TABS.find((entry) => entry.value === params?.tab)?.value ?? "inbox",
    missionId: missionIdOf(params?.missionId),
    page: MISSION_PAGES.find((entry) => entry.value === params?.page)?.value ?? "board",
    inboxTab: INBOX_TABS.find((entry) => entry === params?.inboxTab) ?? null,
  };
}

/**
 * Params for one place in the area. Every key is set, so `setParams` replaces
 * an earlier pick instead of merging it in.
 */
export function missionsRouteParams(state: Partial<MissionsRouteState>): MissionsRouteParams {
  return {
    tab: state.tab ?? "inbox",
    missionId: state.missionId ?? undefined,
    page: state.page ?? undefined,
    inboxTab: state.inboxTab ?? undefined,
  };
}

/** What a pushed record screen shows: an inbox item, a request or a room. */
export type MissionRecordKind = "item" | "request" | "room";

export type MissionRecordParams = {
  readonly kind: string;
  readonly id: string;
  readonly missionId?: string | undefined;
};

export interface MissionRecordState {
  readonly kind: MissionRecordKind;
  readonly id: string;
  readonly missionId: MissionId | null;
}

const RECORD_KINDS: ReadonlyArray<MissionRecordKind> = ["item", "request", "room"];

/** `null` for a link this screen cannot open. A request needs its mission. */
export function missionRecordState(
  params: MissionRecordParams | undefined,
): MissionRecordState | null {
  const kind = RECORD_KINDS.find((entry) => entry === params?.kind);
  const id = params?.id?.trim();
  const missionId = missionIdOf(params?.missionId);
  if (!kind || !id) return null;
  if (kind === "request" && missionId === null) return null;
  return { kind, id, missionId };
}
