import type { MissionListItem, MissionListSnapshot } from "@t3tools/contracts";

import { badgeCount, healthLabel } from "../viewModel.ts";
import { healthTone, type HealthTone } from "./overview.ts";

// The Missions group at the top of the phone's thread list: one row per
// mission with its health, one status line, the answered-unread requests and
// what needs the owner.

export interface MissionGroupRow {
  readonly id: MissionListItem["id"];
  readonly title: string;
  readonly tone: HealthTone;
  /** "At risk. 17 lanes working, 7 waiting", "Paused" */
  readonly statusLine: string;
  /** Needs-you badge text, or null for "Nothing needs you". */
  readonly needsYou: string | null;
  /** Answered requests the owner has not opened; 0 shows nothing. */
  readonly answered: number;
}

/** "17 lanes working, 7 waiting, 1 stuck" */
function lanesPhrase(lanes: MissionListItem["lanes"]): string {
  const [lead, ...rest] = (
    [
      ["working", lanes.working],
      ["waiting", lanes.waiting],
      ["stuck", lanes.stuck],
    ] as const
  ).filter(([, count]) => count > 0);
  if (!lead) return "No lanes working";
  const [state, count] = lead;
  return [
    `${count} ${count === 1 ? "lane" : "lanes"} ${state}`,
    ...rest.map(([label, n]) => `${n} ${label}`),
  ].join(", ");
}

export function missionGroupRows(list: MissionListSnapshot | undefined): MissionGroupRow[] {
  return (list?.missions ?? [])
    .filter((mission) => mission.status !== "archived")
    .map((mission) => {
      const paused = mission.status === "paused";
      return {
        id: mission.id,
        title: mission.title,
        tone: healthTone(mission.health, paused),
        statusLine: paused
          ? "Paused"
          : `${healthLabel(mission.health)}. ${lanesPhrase(mission.lanes)}`,
        needsYou: mission.needsYou > 0 ? badgeCount(mission.needsYou) : null,
        answered: mission.requestsAnswered ?? 0,
      };
    });
}

/** The group header's "Inbox N": everything waiting on the owner across missions. */
export function inboxTotal(list: MissionListSnapshot | undefined): number {
  return (list?.missions ?? [])
    .filter((mission) => mission.status !== "archived")
    .reduce((total, mission) => total + mission.needsYou, 0);
}
