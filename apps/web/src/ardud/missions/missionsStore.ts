import { useEffect, useMemo, useSyncExternalStore } from "react";

import type {
  DraftNote,
  Lane,
  MissionId,
  MissionInboxHistory,
  MissionListSnapshot,
  MissionRoomActivity,
  MissionRoomActivityInput,
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
  createViewLongTexts,
  viewLongTextKey,
  type ViewLongTextState,
  withOptimisticDecisions,
  yourRequests,
  type FeedFailure,
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
  type SnapshotStore,
  type ViewLongTextRequest,
} from "@t3tools/client-runtime/ardud/missions";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";

// The web client's one missions source: the primary server over WS RPC.
// `?missionsFixture=1` runs on the fixture alone; nothing else falls back to it.
// The owner's decisions show at once and send in the background.
const useFixtureOnly =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("missionsFixture") === "1";
export const missionsSource: MissionsSource = withOptimisticDecisions(
  useFixtureOnly
    ? createFixtureMissionsSource({ surface: "web" })
    : createRpcMissionsSource({
        transport: createAtomMissionsTransport({
          runtime: connectionAtomRuntime,
          registry: appAtomRegistry,
          environmentId: primaryEnvironmentIdAtom,
        }),
      }),
);

/** True when a section's data comes from the fixture rather than the server. */
export function isSampleFeed(feed: SampledFeed): boolean {
  return missionsSource.sampled.has(feed);
}

// One subscription per screen-level store, shared by every component that
// reads it. Rows never subscribe on their own.
const listStore = createSnapshotStore<MissionListSnapshot>((emit) =>
  missionsSource.subscribeList(emit),
);
// Switching missions or requests and coming back should not wait on the server
// again, so a board's feeds stay open a while after the screen leaves.
const warm = { keepAliveMs: 2 * 60_000 };
const overviewStores = createKeyedSnapshotStores<MissionId, MissionOverviewSnapshot | null>(
  (id, emit) => missionsSource.subscribeOverview(id, emit),
  warm,
);
const laneStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<Lane>>(
  (id, emit) => missionsSource.subscribeLanes(id, emit),
  warm,
);
const inboxStores = createKeyedSnapshotStores<MissionId | null, MissionInboxSnapshot>(
  (id, emit, fail) => missionsSource.subscribeInbox(id, emit, fail),
  warm,
);
const routingStores = createKeyedSnapshotStores<MissionId, ApprovalRoutingTable | null>(
  (id, emit) => missionsSource.subscribeRouting(id, emit),
);
const workStores = createKeyedSnapshotStores<MissionId, MissionWorkSnapshot>((id, emit, fail) =>
  missionsSource.subscribeWork(id, emit, {}, fail),
);
const ruleBookStores = createKeyedSnapshotStores<MissionId, MissionRuleBook>((id, emit, fail) =>
  missionsSource.subscribeRuleBook(id, emit, fail),
);
const roleStores = createKeyedSnapshotStores<MissionId, MissionRolesSnapshot>((id, emit, fail) =>
  missionsSource.subscribeRoles(id, emit, fail),
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
  (id, emit, fail) => missionsSource.subscribeTimeline(id, emit, fail),
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
  (id, emit, fail) => missionsSource.subscribeRooms(id, emit, fail),
);
const roomStores = createKeyedSnapshotStores<RoomId, RoomPage | null>((id, emit, fail) =>
  missionsSource.subscribeRoom(id, emit, fail),
);
const viewStores = createKeyedSnapshotStores<MissionId, MissionViewsState | null>(
  (id, emit) => missionsSource.subscribeViews(id, emit),
  warm,
);
const requestStores = createKeyedSnapshotStores<MissionId, ReadonlyArray<OwnerRequest>>(
  (id, emit, fail) => missionsSource.subscribeRequests(id, emit, fail),
  warm,
);

/** The mission's views record (its layout of sections and tabs) and its change log. */
export function useMissionViews(missionId: MissionId): MissionViewsState | null | undefined {
  const store = viewStores(missionId);
  return useSyncExternalStore(store.subscribe, store.get);
}

// --- views additions ---
const longTexts = createViewLongTexts((input) => missionsSource.loadLongText(input));

/** A long row value (a report's text), loaded once its block shows; undefined until asked. */
export function useViewLongText(input: ViewLongTextRequest | null): ViewLongTextState | undefined {
  const key = input === null ? null : viewLongTextKey(input);
  const state = useSyncExternalStore(longTexts.subscribe, () =>
    key === null ? undefined : longTexts.get(key),
  );
  // Held while shown, so a value on screen never drops out of the store.
  useEffect(() => (input === null ? undefined : longTexts.hold(input)), [input]);
  return state;
}

export function retryViewLongText(input: ViewLongTextRequest): void {
  longTexts.request(input, { retry: true });
}
// --- end views additions ---

const requestThreadStores = createKeyedSnapshotStores<string, OwnerRequest | null>((key, emit) => {
  const [missionId, requestId] = key.split("\n") as [MissionId, string];
  return missionsSource.subscribeRequest({ missionId, requestId }, emit);
}, warm);

const NO_REQUESTS: SnapshotStore<ReadonlyArray<OwnerRequest>> = {
  get: () => undefined,
  subscribe: () => () => {},
  failure: () => undefined,
  retry: () => {},
};

/** A feed's read failure (and how to retry it); `failure` is unset while it reads fine. */
export interface FeedState {
  readonly failure: FeedFailure | undefined;
  readonly retry: () => void;
}

export function useFeedState(store: SnapshotStore<unknown>): FeedState {
  const failure = useSyncExternalStore(store.subscribe, store.failure);
  return useMemo(() => ({ failure, retry: store.retry }), [failure, store]);
}

/** Whether the inbox read failed; pairs with `useMissionInbox`. */
export function useMissionInboxFeed(missionId: MissionId | null): FeedState {
  return useFeedState(inboxStores(missionId));
}

/** Whether the owner requests read failed; pairs with `useOwnerRequests`. */
export function useOwnerRequestsFeed(missionId: MissionId | null): FeedState {
  return useFeedState(missionId === null ? NO_REQUESTS : requestStores(missionId));
}

/** Whether the mission's event log failed to load; pairs with `useMissionTimeline`. */
export function useMissionTimelineFeed(missionId: MissionId): FeedState {
  return useFeedState(timelineStores(missionId));
}

// --- finish-b --- read failures of the Desk tabs' feeds; each pairs with its data hook.
export function useMissionWorkFeed(missionId: MissionId): FeedState {
  return useFeedState(workStores(missionId));
}

export function useMissionRuleBookFeed(missionId: MissionId): FeedState {
  return useFeedState(ruleBookStores(missionId));
}

export function useMissionRolesFeed(missionId: MissionId): FeedState {
  return useFeedState(roleStores(missionId));
}

export function useMissionRoomsFeed(missionId: MissionId): FeedState {
  return useFeedState(roomListStores(missionId));
}

export function useRoomPageFeed(roomId: RoomId | null): FeedState {
  return useFeedState(roomStores(roomId ?? NO_ROOM));
}
// --- end finish-b ---

// --- fix-p3 --- room messages counted by the router, imported rooms included.
const roomActivityStores = createKeyedSnapshotStores<string, MissionRoomActivity>(
  (key, emit, fail) =>
    missionsSource.subscribeRoomActivity(JSON.parse(key) as MissionRoomActivityInput, emit, fail),
);

function roomActivityStore(input: MissionRoomActivityInput) {
  return roomActivityStores(
    JSON.stringify({ missionId: input.missionId, dayStart: input.dayStart, since: input.since }),
  );
}

/** Today's room activity and the tallies since `since`; undefined while it loads. */
export function useMissionRoomActivity(
  input: MissionRoomActivityInput,
): MissionRoomActivity | undefined {
  const store = roomActivityStore(input);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useMissionRoomActivityFeed(input: MissionRoomActivityInput): FeedState {
  return useFeedState(roomActivityStore(input));
}
// --- end fix-p3 ---

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
