import type {
  MissionId,
  MissionInbox,
  MissionListSnapshot,
  MissionOverview,
} from "@t3tools/contracts";
import {
  createFixtureMissionsSource,
  createKeyedSnapshotStores,
  createSnapshotStore,
  type MissionRoomEntry,
  type MissionsSource,
} from "@t3tools/client-runtime/ardud/missions";
import { useSyncExternalStore } from "react";

let source: MissionsSource | null = null;

// The phone's one missions source. The fixture is built from real Crpko
// coordinator data and is created on first use so app start stays cheap; swap
// this for the server RPC source when it lands.
export function missionsSource(): MissionsSource {
  source ??= createFixtureMissionsSource({ surface: "mobile" });
  return source;
}

const ALL_MISSIONS = "*";

const listStore = createSnapshotStore<MissionListSnapshot>((emit) =>
  missionsSource().subscribeList(emit),
);

const overviewStores = createKeyedSnapshotStores<MissionId, MissionOverview | null>((id, emit) =>
  missionsSource().subscribeOverview(id, emit),
);

const inboxStores = createKeyedSnapshotStores<string, MissionInbox>((key, emit) =>
  missionsSource().subscribeInbox(key === ALL_MISSIONS ? null : (key as MissionId), emit),
);

const roomStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<MissionRoomEntry>>(
  (id, emit) => missionsSource().subscribeRooms(id, emit),
);

/** Undefined until the source answers. */
export function useMissionList(): MissionListSnapshot | undefined {
  return useSyncExternalStore(listStore.subscribe, listStore.get);
}

/** Undefined while loading, null when the mission does not exist. */
export function useMissionOverview(missionId: MissionId): MissionOverview | null | undefined {
  const store = overviewStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** One mission's inbox, or every mission's when `missionId` is null. */
export function useMissionInbox(missionId: MissionId | null): MissionInbox | undefined {
  const store = inboxStores(missionId ?? ALL_MISSIONS);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionRooms(missionId: MissionId): ReadonlyArray<MissionRoomEntry> | undefined {
  const store = roomStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}
