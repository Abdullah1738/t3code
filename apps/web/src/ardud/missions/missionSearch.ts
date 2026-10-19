import type { InboxTab } from "@t3tools/contracts";
import { isInboxTab } from "@t3tools/client-runtime/ardud/missions";

export const MISSION_TABS = [
  "overview",
  "rooms",
  "lanes",
  "work",
  "rules",
  "roles",
  "timeline",
  "views",
] as const;

export type MissionTab = (typeof MISSION_TABS)[number];

export const MISSION_TAB_LABEL: Record<MissionTab, string> = {
  overview: "Board",
  rooms: "Rooms",
  lanes: "Lanes",
  work: "Work",
  rules: "Rules",
  roles: "Roles",
  timeline: "Timeline",
  views: "Views",
};

export interface MissionSearch {
  /** Omitted for the overview so the plain mission URL stays the default. */
  readonly tab?: Exclude<MissionTab, "overview">;
  /** Sub-mission to highlight, set when opened from the sidebar. */
  readonly sub?: string;
  /** Open room on the rooms tab. */
  readonly room?: string;
  /** Open owner request on the overview. */
  readonly request?: string;
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export function parseMissionSearch(raw: Record<string, unknown>): MissionSearch {
  const tab = MISSION_TABS.find((candidate) => candidate === raw.tab);
  const sub = nonEmpty(raw.sub);
  const room = tab === "rooms" ? nonEmpty(raw.room) : undefined;
  const request = tab === undefined || tab === "overview" ? nonEmpty(raw.request) : undefined;
  return {
    ...(tab !== undefined && tab !== "overview" ? { tab } : {}),
    ...(sub !== undefined ? { sub } : {}),
    ...(room !== undefined ? { room } : {}),
    ...(request !== undefined ? { request } : {}),
  };
}

export interface MissionInboxSearch {
  /** Limits the inbox to one mission. */
  readonly mission?: string;
  /** Open tab. Omitted means "the first tab with something in it". */
  readonly tab?: InboxTab;
  /** "master" shows what is routed to the master; omitted is the owner's inbox. */
  readonly route?: "master";
}

export function parseMissionInboxSearch(raw: Record<string, unknown>): MissionInboxSearch {
  const mission = nonEmpty(raw.mission);
  return {
    ...(mission !== undefined ? { mission } : {}),
    ...(isInboxTab(raw.tab) ? { tab: raw.tab } : {}),
    ...(raw.route === "master" ? { route: "master" as const } : {}),
  };
}
