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
  // Keyed on the gate, not the mission: coming back to a mission waits again.
  const [waited, setWaited] = useState<object | null>(null);

  useEffect(() => {
    if (missionId === null || ready) return;
    const timer = setTimeout(() => setWaited(feeds), BOARD_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [feeds, missionId, ready]);

  return ready || (missionId !== null && waited === feeds);
}

/**
 * Starts loading a mission's board ahead of a tap, as a row is pressed. The
 * feeds stay open for their keep-alive, so the board is there when it opens.
 * A press can be the start of a scroll, so views (which keep the mission's
 * view sources running) wait for the board itself.
 */
export function warmBoard(missionId: MissionId): void {
  createSnapshotGate(missionBoardStores(missionId)).subscribe(() => {})();
}

/**
 * Keeps the first few listed missions' boards loading while the mission picker
 * is up, so a tap opens a board that is already there. Not for the thread
 * list: it is up most of the time, and an open views feed keeps the mission's
 * view sources running.
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
