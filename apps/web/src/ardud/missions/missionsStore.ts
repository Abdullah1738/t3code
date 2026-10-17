import { useSyncExternalStore } from "react";

import type {
  Lane,
  MissionId,
  MissionInbox,
  MissionListSnapshot,
  MissionOverview,
} from "@t3tools/contracts";
import {
  createFixtureMissionsSource,
  createKeyedSnapshotStores,
  createSnapshotStore,
  type MissionsSource,
} from "@t3tools/client-runtime/ardud/missions";

// The web client's one missions source. The fixture is built from real Crpko
// coordinator data; swap this line for the server RPC source when it lands.
export const missionsSource: MissionsSource = createFixtureMissionsSource({ surface: "web" });

// One subscription per screen-level store, shared by every component that
// reads it. Rows never subscribe on their own.
const listStore = createSnapshotStore<MissionListSnapshot>((emit) =>
  missionsSource.subscribeList(emit),
);
const overviewStores = createKeyedSnapshotStores<MissionId, MissionOverview | null>((id, emit) =>
  missionsSource.subscribeOverview(id, emit),
);
const laneStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<Lane>>((id, emit) =>
  missionsSource.subscribeLanes(id, emit),
);
const inboxStores = createKeyedSnapshotStores<MissionId | null, MissionInbox>((id, emit) =>
  missionsSource.subscribeInbox(id, emit),
);

/** `undefined` until the source has answered once. */
export function useMissionList(): MissionListSnapshot | undefined {
  return useSyncExternalStore(listStore.subscribe, listStore.get);
}

/** `undefined` while loading, `null` when the mission does not exist. */
export function useMissionOverview(missionId: MissionId): MissionOverview | null | undefined {
  const store = overviewStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionLanes(missionId: MissionId): ReadonlyArray<Lane> | undefined {
  const store = laneStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Inbox for one mission, or across every mission when `missionId` is null. */
export function useMissionInbox(missionId: MissionId | null): MissionInbox | undefined {
  const store = inboxStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** A mission error's detail, or a plain fallback for anything else. */
export function missionErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { readonly detail: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return "Something went wrong. Try again.";
}
