import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  Lane,
  MissionId,
  MissionInboxHistory,
  MissionListSnapshot,
  RoomId,
  RoomPage,
} from "@t3tools/contracts";
import {
  createAtomMissionsTransport,
  createFixtureMissionsSource,
  createKeyedSnapshotStores,
  createRpcMissionsSource,
  createSnapshotStore,
  yourRequests,
  type MissionInboxSnapshot,
  type MissionOverviewSnapshot,
  type MissionRoomEntry,
  type MissionsSource,
  type OwnerRequest,
} from "@t3tools/client-runtime/ardud/missions";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { Atom } from "effect/reactivity";
import { useMemo, useSyncExternalStore } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

/**
 * The server Missions reads from: the phone is paired to one server, so the
 * first enabled connection.
 */
export const missionsEnvironmentIdAtom = Atom.make((get): EnvironmentId | null => {
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    return environmentId;
  }
  return null;
}).pipe(Atom.withLabel("mobile-missions-environment-id"));

export function useMissionsEnvironmentId(): EnvironmentId | null {
  return useAtomValue(missionsEnvironmentIdAtom);
}

let source: MissionsSource | null = null;

/**
 * The phone's one missions source: the paired server over the environment
 * connection, with fixture data only for the feeds the server does not serve
 * (`sampled`). `EXPO_PUBLIC_MISSIONS_FIXTURE=1` runs on the fixture alone.
 * Built on first use so app start stays cheap.
 */
export function missionsSource(): MissionsSource {
  if (source) return source;
  const fixture = createFixtureMissionsSource({ surface: "mobile" });
  source =
    process.env.EXPO_PUBLIC_MISSIONS_FIXTURE === "1"
      ? fixture
      : createRpcMissionsSource({
          transport: createAtomMissionsTransport({
            runtime: connectionAtomRuntime,
            registry: appAtomRegistry,
            environmentId: missionsEnvironmentIdAtom,
          }),
          fallback: fixture,
        });
  return source;
}

// One subscription per store, shared by every component that reads it.
const listStore = createSnapshotStore<MissionListSnapshot>((emit) =>
  missionsSource().subscribeList(emit),
);
const overviewStores = createKeyedSnapshotStores<MissionId, MissionOverviewSnapshot | null>(
  (id, emit) => missionsSource().subscribeOverview(id, emit),
);
const inboxStores = createKeyedSnapshotStores<MissionId | null, MissionInboxSnapshot>((id, emit) =>
  missionsSource().subscribeInbox(id, emit),
);
const historyStores = createKeyedSnapshotStores<MissionId | null, MissionInboxHistory>((id, emit) =>
  missionsSource().subscribeInboxHistory(id, emit),
);
const laneStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<Lane>>((id, emit) =>
  missionsSource().subscribeLanes(id, emit),
);
const roomListStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<MissionRoomEntry>>(
  (id, emit) => missionsSource().subscribeRooms(id, emit),
);
const roomStores = createKeyedSnapshotStores<RoomId, RoomPage | null>((id, emit) =>
  missionsSource().subscribeRoom(id, emit),
);
const requestStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<OwnerRequest>>(
  (id, emit) => missionsSource().subscribeRequests(id, emit),
);
const requestThreadStores = createKeyedSnapshotStores<string, OwnerRequest | null>((key, emit) => {
  const [missionId, requestId] = key.split("\n") as [MissionId, string];
  return missionsSource().subscribeRequest({ missionId, requestId }, emit);
});

const NONE = { get: () => undefined, subscribe: () => () => {} };

/** Undefined until the source answers. */
export function useMissionList(): MissionListSnapshot | undefined {
  return useSyncExternalStore(listStore.subscribe, listStore.get);
}

/** Undefined while loading, null when the mission does not exist. */
export function useMissionOverview(
  missionId: MissionId | null,
): MissionOverviewSnapshot | null | undefined {
  const store = missionId === null ? NONE : overviewStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** One mission's inbox, or every mission's when `missionId` is null. */
export function useMissionInbox(missionId: MissionId | null): MissionInboxSnapshot | undefined {
  const store = inboxStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** What the owner decided in the last day, newest first. */
export function useMissionInboxHistory(
  missionId: MissionId | null,
): MissionInboxHistory | undefined {
  const store = historyStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionLanes(missionId: MissionId): ReadonlyArray<Lane> | undefined {
  const store = laneStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionRooms(
  missionId: MissionId | null,
): ReadonlyArray<MissionRoomEntry> | undefined {
  const store = missionId === null ? NONE : roomListStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The newest page of one room; older pages load through the source. */
export function useRoomPage(roomId: RoomId): RoomPage | null | undefined {
  const store = roomStores(roomId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Every owner request, discussions on records included. */
export function useOwnerRequests(
  missionId: MissionId | null,
): ReadonlyArray<OwnerRequest> | undefined {
  const store = missionId === null ? NONE : requestStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Your requests: the owner's own asks, without discussions on records. */
export function useYourRequests(missionId: MissionId): ReadonlyArray<OwnerRequest> | undefined {
  const requests = useOwnerRequests(missionId);
  return useMemo(() => (requests === undefined ? undefined : yourRequests(requests)), [requests]);
}

/** One request's whole conversation; null once it is gone. */
export function useOwnerRequest(
  missionId: MissionId,
  requestId: string,
): OwnerRequest | null | undefined {
  const store = requestThreadStores(`${missionId}\n${requestId}`);
  return useSyncExternalStore(store.subscribe, store.get);
}
