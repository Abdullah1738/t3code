import { createSnapshotGate, type SnapshotStore } from "@t3tools/client-runtime/ardud/missions";
import type { MissionId } from "@t3tools/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { missionBoardStores } from "./missionsStore";
import { missionViewsStore } from "./viewsStore";

// A board reads five feeds. Opened one by one as its sections mount, they
// arrive one by one and the board redraws with each, false empties included.
// Opening them together from the screen lets the board appear once, whole.

/** How long a silent feed may hold the board back before it shows anyway. */
const BOARD_PATIENCE_MS = 1_500;
/** Missions on screen whose boards load ahead of a tap. */
const WARM_LIMIT = 4;

function boardStores(missionId: MissionId): ReadonlyArray<SnapshotStore<unknown>> {
  return [...missionBoardStores(missionId), missionViewsStore(missionId)];
}

/**
 * Opens every feed of a mission's board and says when the board can show:
 * once each feed has answered, or once the patience ran out.
 */
export function useBoardReady(missionId: MissionId | null): boolean {
  const feeds = useMemo(
    () => createSnapshotGate(missionId === null ? [] : boardStores(missionId)),
    [missionId],
  );
  const ready = useSyncExternalStore(feeds.subscribe, feeds.ready);
  const [waited, setWaited] = useState<MissionId | null>(null);

  useEffect(() => {
    if (missionId === null || ready) return;
    const timer = setTimeout(() => setWaited(missionId), BOARD_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [missionId, ready]);

  return ready || (missionId !== null && waited === missionId);
}

/**
 * Keeps the first few listed missions' boards loading while their rows are on
 * screen, so a tap opens a board that is already there.
 */
export function useWarmBoards(missionIds: ReadonlyArray<MissionId>, active: boolean): void {
  const key = active ? missionIds.slice(0, WARM_LIMIT).join("\n") : "";
  useEffect(() => {
    if (key === "") return;
    const stops = key
      .split("\n")
      .map((id) => createSnapshotGate(boardStores(id as MissionId)).subscribe(() => {}));
    return () => {
      for (const stop of stops) stop();
    };
  }, [key]);
}
