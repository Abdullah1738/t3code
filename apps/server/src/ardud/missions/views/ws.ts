/**
 * Views WS handlers. Reads need orchestration:read; writes need
 * orchestration:operate and run as the owner, so they only work from a paired
 * Robob web, desktop or mobile session (`ownerAppProvenance`).
 */
import {
  MISSIONS_VIEWS_WS_METHODS as M,
  MissionError,
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

/** View changes (and starter changes) resend the snapshot; anything else may move the counts. */
const touches = (missionId: MissionId) => (item: MissionStreamItem) =>
  item._tag === "upsert" &&
  item.record._tag === "event" &&
  (item.record.record.missionId === missionId ||
    (item.record.record.missionId === GLOBAL_TIMELINE &&
      item.record.record.kind.startsWith("view.starter-layout")));

const isViewChange = (item: MissionStreamItem) =>
  item._tag === "upsert" &&
  item.record._tag === "event" &&
  item.record.record.kind.startsWith("view.");

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
   * lost. A view change resends the whole snapshot; other mission events only
   * recount what waits on the owner and send `waiting` when the counts or the
   * pinned strip changed.
   */
  const subscribe = (input: MissionViewsInput): Stream.Stream<MissionViewsFeedItem, MissionError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* store.subscribe;
        const first = yield* views.snapshot(input.missionId);
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter(touches(input.missionId)),
          Stream.mapAccumEffect(
            () => first,
            (last, item) =>
              Effect.gen(function* () {
                if (isViewChange(item)) {
                  const snapshot = yield* views.snapshot(input.missionId);
                  const next: MissionViewsFeedItem = { _tag: "snapshot", snapshot };
                  return [snapshot, [next]] as const;
                }
                const counts = yield* views.waiting(input.missionId);
                const pinned = viewPinnedStrip(last.layout.layout, counts);
                const snapshot: MissionViewsSnapshot = {
                  ...last,
                  ownerWaiting: counts.ownerWaiting,
                  requestsUnread: counts.requestsUnread,
                  pinnedStrip: pinned.needsYou || pinned.requests,
                  pinned,
                };
                return [
                  snapshot,
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
  } as const;
};

export const viewsWsHandlers = (connection: MissionWsConnection) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    const views = yield* ViewService;
    return makeViewsWsHandlers({ store, views }, connection);
  });
