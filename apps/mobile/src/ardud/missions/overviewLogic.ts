import type { CallId, MissionOverview, SubMissionId } from "@t3tools/contracts";
import { moveSubMissionInput } from "@t3tools/client-runtime/ardud/missions/mobile";

import { missionsSource } from "./missionsStore";
import { confirmAction, useMissionAction } from "./useMissionsLogic";

// Owner actions on the mission overview. The screen only wires these to buttons.

export interface OverviewActions {
  readonly pending: boolean;
  readonly togglePaused: () => void;
  readonly setFocus: (subMissionId: SubMissionId | null) => void;
  readonly react: (callId: CallId, reaction: "ok" | "discuss") => void;
  readonly markSeen: () => void;
  readonly move: (subMissionId: SubMissionId, direction: "up" | "down") => void;
}

export function useOverviewActions(overview: MissionOverview | null | undefined): OverviewActions {
  const action = useMissionAction();
  const run = (failureTitle: string, send: () => Promise<void>) => {
    void action.run(failureTitle, send);
  };
  return {
    pending: action.pending,
    togglePaused: () => {
      if (!overview) return;
      const { mission } = overview;
      if (mission.status === "paused") {
        run("Could not resume the mission", () =>
          missionsSource().setMissionPaused({ missionId: mission.id, paused: false }),
        );
        return;
      }
      confirmAction({
        title: `Pause ${mission.title}?`,
        message: "Lanes stop at their next safe point and nothing new starts until you resume.",
        confirmLabel: "Pause",
        onConfirm: () =>
          run("Could not pause the mission", () =>
            missionsSource().setMissionPaused({ missionId: mission.id, paused: true }),
          ),
      });
    },
    setFocus: (subMissionId) => {
      if (!overview) return;
      run("Could not change the focus", () =>
        missionsSource().setMissionFocus({ missionId: overview.mission.id, subMissionId }),
      );
    },
    react: (callId, reaction) => {
      if (!overview) return;
      run("Could not record your reaction", () =>
        missionsSource().reactToCall({ missionId: overview.mission.id, callId, reaction }),
      );
    },
    markSeen: () => {
      if (!overview) return;
      run("Could not mark as seen", () =>
        missionsSource().markMissionSeen({ missionId: overview.mission.id }),
      );
    },
    move: (subMissionId, direction) => {
      if (!overview) return;
      const input = moveSubMissionInput(overview, subMissionId, direction);
      if (!input) return;
      run("Could not reorder sub-missions", () => missionsSource().reorderSubMissions(input));
    },
  };
}
