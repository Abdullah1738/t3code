/**
 * Views WS handlers. Reads need orchestration:read; writes need
 * orchestration:operate and run as the owner, so they only work from a paired
 * Robob web, desktop or mobile session (`ownerAppProvenance`).
 */
import {
  MISSIONS_VIEWS_WS_METHODS as M,
  MissionError,
  type AddMissionAssetInput,
  type ApplyViewBundleInput,
  type RemoveMissionAssetInput,
  type DefineViewTemplateInput,
  type EditStarterLayoutInput,
  type EditViewLayoutInput,
  type MissionId,
  type MissionProvenance,
  type MissionStreamItem,
  type MissionViewsFeedItem,
  type MissionViewsInput,
  type MissionViewsSnapshot,
  type PlaceViewSectionInput,
  type PreviewViewInput,
  type RemoveViewInput,
  type RestoreStarterLayoutInput,
  type RestoreViewInput,
  type RestoreViewLayoutInput,
  type ViewHistoryInput,
  viewPinnedStrip,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { OWNER_SESSION_REQUIRED, ownerAppProvenance } from "../core/provenance.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { MissionWsConnection } from "../ws.ts";
import { queriedKinds, sectionData } from "./sectionRows.ts";
import { GLOBAL_TIMELINE, ViewService } from "./ViewService.ts";

export interface ViewsWsServices {
  readonly store: MissionStore.MissionStore["Service"];
  readonly views: ViewService["Service"];
}

const waitingItem = (snapshot: MissionViewsSnapshot): MissionViewsFeedItem => ({
  _tag: "waiting",
  missionId: snapshot.missionId,
  ownerWaiting: snapshot.ownerWaiting,
  requestsUnread: snapshot.requestsUnread,
  pinnedStrip: snapshot.pinnedStrip,
  pinned: snapshot.pinned,
});

const waitingKey = (snapshot: MissionViewsSnapshot) =>
  `${snapshot.ownerWaiting}:${snapshot.requestsUnread}:${snapshot.pinned.needsYou}:${snapshot.pinned.requests}`;

/**
 * The mission's records and events, plus starter changes. Records arrive
 * before the event of the same commit, so the event knows which kinds moved.
 */
const touches = (missionId: MissionId) => (item: MissionStreamItem) =>
  item._tag === "remove"
    ? item.missionId === missionId
    : item._tag === "upsert" &&
      (item.missionId === missionId ||
        (item.record._tag === "event" &&
          item.record.record.missionId === GLOBAL_TIMELINE &&
          item.record.record.kind.startsWith("view.starter-layout")));

const isViewChange = (item: MissionStreamItem) =>
  item._tag === "upsert" &&
  item.record._tag === "event" &&
  item.record.record.kind.startsWith("view.");

/** The record kind a non-event item changed, or null. */
const changedKind = (item: MissionStreamItem): string | null => {
  if (item._tag === "remove") return item.ref.kind;
  if (item._tag === "upsert" && item.record._tag !== "event") return item.record._tag;
  return null;
};

interface FeedState {
  readonly snapshot: MissionViewsSnapshot;
  /** Kinds changed since the last event. */
  readonly changed: ReadonlySet<string>;
}

export const makeViewsWsHandlers = (
  { store, views }: ViewsWsServices,
  connection: MissionWsConnection,
) => {
  const owner = ownerAppProvenance(connection);
  const asOwner =
    <I, A>(write: (provenance: MissionProvenance, input: I) => Effect.Effect<A, MissionError>) =>
    (input: I): Effect.Effect<A, MissionError> =>
      owner === null
        ? Effect.fail(
            new MissionError({ code: "provenance-required", detail: OWNER_SESSION_REQUIRED }),
          )
        : write(owner, input);

  /**
   * Subscribes before reading the snapshot, so nothing committed in between is
   * lost. A view change resends the whole snapshot. Another event recomputes
   * section rows when it changed a kind a section queries, resending the
   * snapshot when the rows moved; otherwise it only recounts what waits on the
   * owner and sends `waiting` when the counts or the pinned strip changed.
   */
  const subscribe = (input: MissionViewsInput): Stream.Stream<MissionViewsFeedItem, MissionError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* store.subscribe;
        const first = yield* views.snapshot(input.missionId);
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter(touches(input.missionId)),
          Stream.mapAccumEffect(
            (): FeedState => ({ snapshot: first, changed: new Set() }),
            (state, item) =>
              Effect.gen(function* () {
                const last = state.snapshot;
                const kind = changedKind(item);
                if (kind !== null) {
                  const next: FeedState = {
                    snapshot: last,
                    changed: new Set([...state.changed, kind]),
                  };
                  return [next, []] as const;
                }
                if (isViewChange(item)) {
                  const snapshot = yield* views.snapshot(input.missionId);
                  const next: MissionViewsFeedItem = { _tag: "snapshot", snapshot };
                  return [{ snapshot, changed: new Set<string>() }, [next]] as const;
                }
                const queried = queriedKinds(last.sections);
                const rowsMayMove = [...state.changed].some((changed) => queried.has(changed));
                const rows = rowsMayMove
                  ? yield* sectionData(store, input.missionId, last.sections)
                  : (last.sectionData ?? []);
                const counts = yield* views.waiting(input.missionId);
                const pinned = viewPinnedStrip(last.layout.layout, counts);
                const snapshot: MissionViewsSnapshot = {
                  ...last,
                  ownerWaiting: counts.ownerWaiting,
                  requestsUnread: counts.requestsUnread,
                  pinnedStrip: pinned.needsYou || pinned.requests,
                  pinned,
                  sectionData: rows,
                };
                const next: FeedState = { snapshot, changed: new Set() };
                if (JSON.stringify(rows) !== JSON.stringify(last.sectionData ?? [])) {
                  return [next, [{ _tag: "snapshot", snapshot } as MissionViewsFeedItem]] as const;
                }
                return [
                  next,
                  waitingKey(snapshot) === waitingKey(last) ? [] : [waitingItem(snapshot)],
                ] as const;
              }),
          ),
        );
        const head: MissionViewsFeedItem = { _tag: "snapshot", snapshot: first };
        return Stream.concat(Stream.make(head), updates);
      }),
    );

  return {
    [M.subscribe]: subscribe,
    [M.get]: (input: MissionViewsInput) => views.snapshot(input.missionId),
    [M.catalog]: (_input: Record<string, never>) => views.catalog,
    [M.history]: (input: ViewHistoryInput) => views.history(input),
    [M.preview]: (input: PreviewViewInput) => views.preview(input),
    [M.defineTemplate]: asOwner((provenance, input: DefineViewTemplateInput) =>
      views.defineTemplate(provenance, input),
    ),
    [M.placeSection]: asOwner((provenance, input: PlaceViewSectionInput) =>
      views.placeSection(provenance, input),
    ),
    [M.remove]: asOwner((provenance, input: RemoveViewInput) => views.remove(provenance, input)),
    [M.restore]: asOwner((provenance, input: RestoreViewInput) => views.restore(provenance, input)),
    [M.editLayout]: asOwner((provenance, input: EditViewLayoutInput) =>
      views.editLayout(provenance, input),
    ),
    [M.restoreLayout]: asOwner((provenance, input: RestoreViewLayoutInput) =>
      views.restoreLayout(provenance, input),
    ),
    [M.editStarter]: asOwner((provenance, input: EditStarterLayoutInput) =>
      views.editStarter(provenance, input),
    ),
    [M.restoreStarter]: asOwner((provenance, input: RestoreStarterLayoutInput) =>
      views.restoreStarter(provenance, input),
    ),
    [M.applyBundle]: asOwner((provenance, input: ApplyViewBundleInput) =>
      views.applyBundle(provenance, input),
    ),
    [M.addAsset]: asOwner((provenance, input: AddMissionAssetInput) =>
      views.addAsset(provenance, input),
    ),
    [M.removeAsset]: asOwner((provenance, input: RemoveMissionAssetInput) =>
      views.removeAsset(provenance, input),
    ),
  } as const;
};

export const viewsWsHandlers = (connection: MissionWsConnection) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    const views = yield* ViewService;
    return makeViewsWsHandlers({ store, views }, connection);
  });
