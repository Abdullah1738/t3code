import type { InboxTab, MissionId } from "@t3tools/contracts";
import { INBOX_TABS } from "@t3tools/client-runtime/ardud/missions/mobile";

export type MissionsTab = "inbox" | "missions" | "rooms";

export const MISSIONS_TABS: ReadonlyArray<{ readonly value: MissionsTab; readonly label: string }> =
  [
    { value: "inbox", label: "Inbox" },
    { value: "missions", label: "Missions" },
    { value: "rooms", label: "Rooms" },
  ];

/** Route params for the Missions screen. Deep links deliver plain strings. */
export type MissionsRouteParams = {
  readonly tab?: string | undefined;
  readonly inboxTab?: string | undefined;
  readonly missionId?: string | undefined;
};

export interface MissionsRouteState {
  readonly tab: MissionsTab;
  /** `null` until the owner picks one; the inbox then opens where something waits. */
  readonly inboxTab: InboxTab | null;
  /** Inbox filter. `null` shows every mission. */
  readonly missionId: MissionId | null;
}

/** Reads route params, falling back for anything unknown. Opens on the inbox. */
export function missionsRouteState(params: MissionsRouteParams | undefined): MissionsRouteState {
  const tab = MISSIONS_TABS.find((entry) => entry.value === params?.tab)?.value ?? "inbox";
  const inboxTab = INBOX_TABS.find((entry) => entry === params?.inboxTab) ?? null;
  const missionId = params?.missionId?.trim() ? (params.missionId.trim() as MissionId) : null;
  return { tab, inboxTab, missionId };
}

/**
 * Params that open the inbox, optionally on one tab and one mission. Unset keys
 * are explicit so `setParams` clears an earlier pick instead of merging it in.
 */
export function inboxRouteParams(
  missionId: MissionId | null,
  inboxTab?: InboxTab,
): MissionsRouteParams {
  return { tab: "inbox", inboxTab: inboxTab ?? undefined, missionId: missionId ?? undefined };
}
