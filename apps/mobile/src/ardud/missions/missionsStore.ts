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
  type FeedFailure,
  type MissionInboxSnapshot,
  type MissionOverviewSnapshot,
  type MissionRoomEntry,
  type MissionsSource,
  type OwnerRequest,
  type SnapshotStore,
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
 * connection. `EXPO_PUBLIC_MISSIONS_FIXTURE=1` runs on the fixture alone;
 * `EXPO_PUBLIC_MISSIONS_FIXTURE_DELAY_MS` gives it a server-like first load.
 * Built on first use so app start stays cheap.
 */
export function missionsSource(): MissionsSource {
  if (source) return source;
  source =
    process.env.EXPO_PUBLIC_MISSIONS_FIXTURE === "1"
      ? createFixtureMissionsSource({
          surface: "mobile",
          latencyMs: Number(process.env.EXPO_PUBLIC_MISSIONS_FIXTURE_DELAY_MS) || 0,
        })
      : createRpcMissionsSource({
          transport: createAtomMissionsTransport({
            runtime: connectionAtomRuntime,
            registry: appAtomRegistry,
            environmentId: missionsEnvironmentIdAtom,
          }),
        });
  return source;
}

// One subscription per store, shared by every component that reads it.
const listStore = createSnapshotStore<MissionListSnapshot>((emit) =>
  missionsSource().subscribeList(emit),
);
// Switching missions or requests and coming back should not reopen the feed and
// wait on the server again, so per-mission feeds stay open a while after the
// screen that read them goes away.
export const MISSION_FEED_KEEP_ALIVE_MS = 2 * 60_000;
const warm = { keepAliveMs: MISSION_FEED_KEEP_ALIVE_MS };
const overviewStores = createKeyedSnapshotStores<MissionId, MissionOverviewSnapshot | null>(
  (id, emit) => missionsSource().subscribeOverview(id, emit),
  warm,
);
const inboxStores = createKeyedSnapshotStores<MissionId | null, MissionInboxSnapshot>(
  (id, emit, fail) => missionsSource().subscribeInbox(id, emit, fail),
  warm,
);
const historyStores = createKeyedSnapshotStores<MissionId | null, MissionInboxHistory>((id, emit) =>
  missionsSource().subscribeInboxHistory(id, emit),
);
const laneStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<Lane>>(
  (id, emit) => missionsSource().subscribeLanes(id, emit),
  warm,
);
const roomListStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<MissionRoomEntry>>(
  (id, emit, fail) => missionsSource().subscribeRooms(id, emit, fail),
);
const roomStores = createKeyedSnapshotStores<RoomId, RoomPage | null>((id, emit, fail) =>
  missionsSource().subscribeRoom(id, emit, fail),
);
const requestStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<OwnerRequest>>(
  (id, emit, fail) => missionsSource().subscribeRequests(id, emit, fail),
  warm,
);
const requestThreadStores = createKeyedSnapshotStores<string, OwnerRequest | null>((key, emit) => {
  const [missionId, requestId] = key.split("\n") as [MissionId, string];
  return missionsSource().subscribeRequest({ missionId, requestId }, emit);
}, warm);

/** The per-mission feeds a board reads, besides its views. */
export function missionBoardStores(missionId: MissionId): ReadonlyArray<SnapshotStore<unknown>> {
  return [
    overviewStores(missionId),
    inboxStores(missionId),
    requestStores(missionId),
    laneStores(missionId),
  ];
}

const NONE: SnapshotStore<never> = {
  get: () => undefined,
  subscribe: () => () => {},
  failure: () => undefined,
  retry: () => {},
};

/** A feed's read failure and how to retry it; `failure` is unset while it reads fine. */
export interface FeedState {
  readonly failure: FeedFailure | undefined;
  readonly retry: () => void;
}

function useFeedState(store: SnapshotStore<unknown>): FeedState {
  const failure = useSyncExternalStore(store.subscribe, store.failure);
  return useMemo(() => ({ failure, retry: store.retry }), [failure, store]);
}

/** Whether the inbox read failed; pairs with `useMissionInbox`. */
export function useMissionInboxFeed(missionId: MissionId | null): FeedState {
  return useFeedState(inboxStores(missionId));
}

/** Whether the owner requests read failed; pairs with `useOwnerRequests`. */
export function useOwnerRequestsFeed(missionId: MissionId | null): FeedState {
  return useFeedState(missionId === null ? NONE : requestStores(missionId));
}

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

// --- finish-b ---
/** Whether the room list read failed; pairs with `useMissionRooms`. */
export function useMissionRoomsFeed(missionId: MissionId | null): FeedState {
  return useFeedState(missionId === null ? NONE : roomListStores(missionId));
}

/** Whether the room's page read failed; pairs with `useRoomPage`. */
export function useRoomPageFeed(roomId: RoomId): FeedState {
  return useFeedState(roomStores(roomId));
}
// --- end finish-b ---

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

/**
 * One request's whole conversation; null once it is gone. Until the full read
 * lands it shows the request's row from the list, so opening one never waits
 * on a blank screen.
 */
export function useOwnerRequest(
  missionId: MissionId,
  requestId: string,
): OwnerRequest | null | undefined {
  const store = requestThreadStores(`${missionId}\n${requestId}`);
  const thread = useSyncExternalStore(store.subscribe, store.get);
  const requests = useOwnerRequests(missionId);
  if (thread !== undefined) return thread;
  return requests?.find((request) => request.id === requestId);
}

/**
 * A request's whole conversation, read only while `requestId` is set. List
 * reads clip each message to a summary, so an open discussion reads this.
 */
export function useFullOwnerRequest(
  missionId: MissionId | null,
  requestId: string | null,
): OwnerRequest | null | undefined {
  const store =
    missionId === null || requestId === null
      ? NONE
      : requestThreadStores(`${missionId}\n${requestId}`);
  return useSyncExternalStore(store.subscribe, store.get);
}
