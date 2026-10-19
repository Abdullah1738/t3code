import { useMemo, useSyncExternalStore } from "react";

import type {
  DraftNote,
  Lane,
  MissionId,
  MissionInboxHistory,
  MissionListSnapshot,
  RoomId,
  RoomPage,
  Rule,
  SuggestionStats,
} from "@t3tools/contracts";
import {
  createAtomMissionsTransport,
  createFixtureMissionsSource,
  createKeyedSnapshotStores,
  createRpcMissionsSource,
  createSnapshotStore,
  yourRequests,
  type SampledFeed,
  type ApprovalRoutingTable,
  type MissionInboxSnapshot,
  type MissionOverviewSnapshot,
  type MissionViewsState,
  type OwnerRequest,
  type MissionPoolsSnapshot,
  type MissionReviewSnapshot,
  type MissionRolesSnapshot,
  type MissionRoomEntry,
  type MissionRuleBook,
  type MissionsSource,
  type MissionTimelineEvent,
  type MissionWorkSnapshot,
  type PortfolioSnapshot,
  type RecoveryIncident,
} from "@t3tools/client-runtime/ardud/missions";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";

// The web client's one missions source: the primary server over WS RPC, with
// fixture data filling the feeds the server does not serve yet (each listed in
// `missionsSource.sampled`). `?missionsFixture=1` runs on the fixture alone.
const useFixtureOnly =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("missionsFixture") === "1";
const fixtureSource = createFixtureMissionsSource({ surface: "web" });
export const missionsSource: MissionsSource = useFixtureOnly
  ? fixtureSource
  : createRpcMissionsSource({
      transport: createAtomMissionsTransport({
        runtime: connectionAtomRuntime,
        registry: appAtomRegistry,
        environmentId: primaryEnvironmentIdAtom,
      }),
      fallback: fixtureSource,
    });

/** True when a section's data comes from the fixture rather than the server. */
export function isSampleFeed(feed: SampledFeed): boolean {
  return missionsSource.sampled.has(feed);
}

// One subscription per screen-level store, shared by every component that
// reads it. Rows never subscribe on their own.
const listStore = createSnapshotStore<MissionListSnapshot>((emit) =>
  missionsSource.subscribeList(emit),
);
const overviewStores = createKeyedSnapshotStores<MissionId, MissionOverviewSnapshot | null>(
  (id, emit) => missionsSource.subscribeOverview(id, emit),
);
const laneStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<Lane>>((id, emit) =>
  missionsSource.subscribeLanes(id, emit),
);
const inboxStores = createKeyedSnapshotStores<MissionId | null, MissionInboxSnapshot>((id, emit) =>
  missionsSource.subscribeInbox(id, emit),
);
const routingStores = createKeyedSnapshotStores<MissionId, ApprovalRoutingTable | null>(
  (id, emit) => missionsSource.subscribeRouting(id, emit),
);
const workStores = createKeyedSnapshotStores<MissionId, MissionWorkSnapshot>((id, emit) =>
  missionsSource.subscribeWork(id, emit),
);
const ruleBookStores = createKeyedSnapshotStores<MissionId, MissionRuleBook>((id, emit) =>
  missionsSource.subscribeRuleBook(id, emit),
);
const roleStores = createKeyedSnapshotStores<MissionId, MissionRolesSnapshot>((id, emit) =>
  missionsSource.subscribeRoles(id, emit),
);
const reviewStores = createKeyedSnapshotStores<MissionId, MissionReviewSnapshot | null>(
  (id, emit) => missionsSource.subscribeReviewPolicy(id, emit),
);
const poolStores = createKeyedSnapshotStores<MissionId, MissionPoolsSnapshot>((id, emit) =>
  missionsSource.subscribePools(id, emit),
);
const recoveryStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<RecoveryIncident>>(
  (id, emit) => missionsSource.subscribeRecovery(id, emit),
);
const timelineStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<MissionTimelineEvent>>(
  (id, emit) => missionsSource.subscribeTimeline(id, emit),
);
const portfolioStore = createSnapshotStore<PortfolioSnapshot>((emit) =>
  missionsSource.subscribePortfolio(emit),
);
const historyStores = createKeyedSnapshotStores<MissionId | null, MissionInboxHistory>((id, emit) =>
  missionsSource.subscribeInboxHistory(id, emit),
);
const draftNoteStores = createKeyedSnapshotStores<MissionId | null, ReadonlyArray<DraftNote>>(
  (id, emit) => missionsSource.subscribeDraftNotes(id, emit),
);
const statsStore = createSnapshotStore<ReadonlyArray<SuggestionStats>>((emit) =>
  missionsSource.subscribeSuggestionStats(emit),
);
const ruleStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<Rule>>((id, emit) =>
  missionsSource.subscribeRules(id, emit),
);
const roomListStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<MissionRoomEntry>>(
  (id, emit) => missionsSource.subscribeRooms(id, emit),
);
const roomStores = createKeyedSnapshotStores<RoomId, RoomPage | null>((id, emit) =>
  missionsSource.subscribeRoom(id, emit),
);
const viewStores = createKeyedSnapshotStores<MissionId, MissionViewsState | null>((id, emit) =>
  missionsSource.subscribeViews(id, emit),
);
const requestStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<OwnerRequest>>(
  (id, emit) => missionsSource.subscribeRequests(id, emit),
);

/** The mission's views record (its layout of sections and tabs) and its change log. */
export function useMissionViews(missionId: MissionId): MissionViewsState | null | undefined {
  const store = viewStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

const requestThreadStores = createKeyedSnapshotStores<string, OwnerRequest | null>((key, emit) => {
  const [missionId, requestId] = key.split("\n") as [MissionId, string];
  return missionsSource.subscribeRequest({ missionId, requestId }, emit);
});

const NO_REQUESTS = { get: () => undefined, subscribe: () => () => {} };

/**
 * Every owner request, discussions included, newest activity first. A record
 * outside any mission (a global suggestion) has no requests.
 */
export function useOwnerRequests(
  missionId: MissionId | null,
): ReadonlyArray<OwnerRequest> | undefined {
  const store = missionId === null ? NO_REQUESTS : requestStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/**
 * Your requests: the owner's own asks. Discussions about a record are left
 * out; they live on that record's card.
 */
export function useYourRequests(missionId: MissionId): ReadonlyArray<OwnerRequest> | undefined {
  const requests = useOwnerRequests(missionId);
  return useMemo(() => (requests === undefined ? undefined : yourRequests(requests)), [requests]);
}

/** One request's whole conversation with full message bodies; null once gone. */
export function useOwnerRequest(
  missionId: MissionId,
  requestId: string,
): OwnerRequest | null | undefined {
  const store = requestThreadStores(`${missionId}\n${requestId}`);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** `undefined` until the source has answered once. */
export function useMissionList(): MissionListSnapshot | undefined {
  return useSyncExternalStore(listStore.subscribe, listStore.get);
}

/** `undefined` while loading, `null` when the mission does not exist. */
export function useMissionOverview(
  missionId: MissionId,
): MissionOverviewSnapshot | null | undefined {
  const store = overviewStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/**
 * The mission's master role id, so actor labels can say "master". `null` for
 * global records and missions without a master.
 */
export function useMasterRoleId(missionId: MissionId | null): string | null {
  const store = overviewStores(missionId ?? NO_MISSION);
  const overview = useSyncExternalStore(store.subscribe, store.get);
  return missionId === null ? null : (overview?.mission.masterRoleId ?? null);
}

export function useMissionLanes(missionId: MissionId): ReadonlyArray<Lane> | undefined {
  const store = laneStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Inbox for one mission, or across every mission when `missionId` is null. */
export function useMissionInbox(missionId: MissionId | null): MissionInboxSnapshot | undefined {
  const store = inboxStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The mission's approval routing table; `null` when it has none yet. */
export function useApprovalRouting(missionId: MissionId): ApprovalRoutingTable | null | undefined {
  const store = routingStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionWork(missionId: MissionId): MissionWorkSnapshot | undefined {
  const store = workStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionRuleBook(missionId: MissionId): MissionRuleBook | undefined {
  const store = ruleBookStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionRoles(missionId: MissionId): MissionRolesSnapshot | undefined {
  const store = roleStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** `null` when the mission has no review policy. */
export function useMissionReviewPolicy(
  missionId: MissionId,
): MissionReviewSnapshot | null | undefined {
  const store = reviewStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionPools(missionId: MissionId): MissionPoolsSnapshot | undefined {
  const store = poolStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Restart incidents that touched the mission, newest first. */
export function useMissionRecovery(
  missionId: MissionId,
): ReadonlyArray<RecoveryIncident> | undefined {
  const store = recoveryStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The mission's event log, newest first. */
export function useMissionTimeline(
  missionId: MissionId,
): ReadonlyArray<MissionTimelineEvent> | undefined {
  const store = timelineStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function usePortfolio(): PortfolioSnapshot | undefined {
  return useSyncExternalStore(portfolioStore.subscribe, portfolioStore.get);
}

/** What the owner decided in the last day, newest first. */
export function useMissionInboxHistory(
  missionId: MissionId | null,
): MissionInboxHistory | undefined {
  const store = historyStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Draft notes that apply to the mission, including global ones. */
export function useDraftNotes(missionId: MissionId | null): ReadonlyArray<DraftNote> | undefined {
  const store = draftNoteStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useSuggestionStats(): ReadonlyArray<SuggestionStats> | undefined {
  return useSyncExternalStore(statsStore.subscribe, statsStore.get);
}

export function useMissionRules(missionId: MissionId): ReadonlyArray<Rule> | undefined {
  const store = ruleStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionRooms(missionId: MissionId): ReadonlyArray<MissionRoomEntry> | undefined {
  const store = roomListStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The newest page of one room; older pages load through the source. */
export function useRoomPage(roomId: RoomId | null): RoomPage | null | undefined {
  const store = roomStores(roomId ?? NO_ROOM);
  const page = useSyncExternalStore(store.subscribe, store.get);
  return roomId === null ? null : page;
}

const NO_ROOM = "" as RoomId;
const NO_MISSION = "" as MissionId;

/** A mission error's detail, or a plain fallback for anything else. */
export function missionErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { readonly detail: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return "Something went wrong. Try again.";
}
