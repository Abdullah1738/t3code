export const MISSION_TABS = [
  "overview",
  "rooms",
  "lanes",
  "work",
  "rules",
  "roles",
  "timeline",
] as const;

export type MissionTab = (typeof MISSION_TABS)[number];

export const MISSION_TAB_LABEL: Record<MissionTab, string> = {
  overview: "Overview",
  rooms: "Rooms",
  lanes: "Lanes",
  work: "Work",
  rules: "Rules",
  roles: "Roles",
  timeline: "Timeline",
};

export interface MissionSearch {
  /** Omitted for the overview so the plain mission URL stays the default. */
  readonly tab?: Exclude<MissionTab, "overview">;
  /** Sub-mission to highlight, set when opened from the sidebar. */
  readonly sub?: string;
}

export function parseMissionSearch(raw: Record<string, unknown>): MissionSearch {
  const tab = MISSION_TABS.find((candidate) => candidate === raw.tab);
  const sub = typeof raw.sub === "string" && raw.sub.length > 0 ? raw.sub : undefined;
  return {
    ...(tab !== undefined && tab !== "overview" ? { tab } : {}),
    ...(sub !== undefined ? { sub } : {}),
  };
}

export interface MissionInboxSearch {
  /** Limits the inbox to one mission. */
  readonly mission?: string;
}

export function parseMissionInboxSearch(raw: Record<string, unknown>): MissionInboxSearch {
  return typeof raw.mission === "string" && raw.mission.length > 0 ? { mission: raw.mission } : {};
}
