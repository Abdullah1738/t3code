import {
  MissionError,
  type CreateMissionInput,
  type LockFieldInput,
  type MarkMissionSeenInput,
  type MissionEvent,
  type MissionId,
  type MissionInbox,
  type MissionListItem,
  type MissionListSnapshot,
  type MissionMutationResult,
  type MissionOverview,
  type MissionProvenance,
  type MissionStreamItem,
  type MissionSubscribeItem,
  type ReorderSubMissionsInput,
  type SetMissionFocusInput,
  type SetMissionStatusInput,
  type SetSubMissionStatusInput,
  type UpdateMissionInput,
  type UpsertLaneInput,
  type UpsertMilestoneInput,
  type UpsertSubMissionInput,
  type UpsertWorkItemInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { MissionEditor } from "./core/ports.ts";
import { HEALTH_TTL_MS, makeReads } from "./core/reads.ts";
import { sameValue } from "./core/rules.ts";
import { makeWrites } from "./core/writes.ts";
import * as MissionStore from "./store/MissionStore.ts";
import type { MissionStoreKind } from "./store/recordIndex.ts";

/**
 * Missions core: owner and master mutations, bounded snapshots and their
 * streams. Transports (WS, HTTP, MCP) decide provenance and call one method.
 */

type Write<I> = (
  provenance: MissionProvenance,
  input: I,
) => Effect.Effect<MissionMutationResult, MissionError>;

export type MissionDigestSince =
  | { readonly _tag: "seq"; readonly seq: number }
  | { readonly _tag: "at"; readonly at: string }
  | { readonly _tag: "recent" };

/**
 * `mission digest`: what happened in one mission since a seq or a time. With
 * a time, the newest matching events are kept and `truncated` says older ones
 * were cut; with a seq, the oldest are kept and the caller pages forward.
 */
export interface MissionDigest {
  readonly mission: MissionListItem | null;
  readonly latestSeq: number;
  /** Oldest first. */
  readonly events: ReadonlyArray<MissionEvent>;
  /** More events matched than were returned; page with `since=<last seq>`. */
  readonly truncated: boolean;
}

const DIGEST_LIMIT = 200;
const DIGEST_RECENT = 50;
const INITIAL_LANES_LIMIT = 200;

/** Changes that alter a list row (counts, health inputs, order, titles). */
const LIST_KINDS: ReadonlySet<string> = new Set<MissionStoreKind>([
  "mission",
  "sub-mission",
  "lane",
  "milestone",
  "ask",
  "approval",
  "draft",
  "knock",
]);

/** Records a mission subscriber receives as deltas. No bodies, no inbox items. */
const MISSION_DELTA_KINDS: ReadonlySet<string> = new Set([
  "mission",
  "sub-mission",
  "milestone",
  "lane",
  "work-item",
  "call",
  "event",
]);

/** Changes that alter the overview without being forwarded themselves. */
const OVERVIEW_KINDS: ReadonlySet<string> = new Set([
  ...MISSION_DELTA_KINDS,
  "role",
  "ask",
  "approval",
  "draft",
  "note",
]);

const INBOX_KINDS: ReadonlySet<string> = new Set<MissionStoreKind>([
  "ask",
  "draft",
  "approval",
  "knock",
  "suggestion",
  "note",
]);

const itemKind = (item: MissionStreamItem): string | null => {
  switch (item._tag) {
    case "upsert":
      return item.record._tag;
    case "remove":
      return item.ref.kind;
    case "list":
      return null;
  }
};

const itemMission = (item: MissionStreamItem): string | null =>
  item._tag === "list" ? null : item.missionId;

const itemSeq = (item: MissionStreamItem): number => (item._tag === "list" ? 0 : item.seq);

/** Health is recomputed on this cadence too, so time-based changes reach open views. */
const healthTicks = Stream.tick(HEALTH_TTL_MS).pipe(Stream.drop(1));

export class MissionService extends Context.Service<
  MissionService,
  {
    readonly listSnapshot: Effect.Effect<MissionListSnapshot, MissionError>;
    readonly overview: (missionId: MissionId) => Effect.Effect<MissionOverview, MissionError>;
    readonly inbox: (missionId: MissionId | null) => Effect.Effect<MissionInbox, MissionError>;
    readonly digest: (
      missionId: MissionId,
      since: MissionDigestSince,
    ) => Effect.Effect<MissionDigest, MissionError>;
    readonly eventsSince: (
      missionId: MissionId,
      afterSeq: number,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<MissionEvent>, MissionError>;
    /** A `list` snapshot, then a fresh `list` whenever a row may have changed. */
    readonly subscribeList: Stream.Stream<MissionStreamItem, MissionError>;
    /** An `overview` and the mission's live lanes, then record deltas in seq order, each batch followed by a fresh overview. */
    readonly subscribe: (missionId: MissionId) => Stream.Stream<MissionSubscribeItem, MissionError>;
    /** The inbox, then a fresh one whenever an inbox item changes. */
    readonly subscribeInbox: (
      missionId: MissionId | null,
    ) => Stream.Stream<MissionInbox, MissionError>;
    /** Every committed change, for tracks that react to others' writes. */
    readonly changes: Stream.Stream<MissionStreamItem>;
    /** The scribe's editor; replaces core's own bottom line, feed and FYI ranking. */
    readonly registerEditor: (editor: MissionEditor) => Effect.Effect<void>;

    readonly createMission: Write<CreateMissionInput>;
    readonly updateMission: Write<UpdateMissionInput>;
    readonly setMissionStatus: Write<SetMissionStatusInput>;
    readonly setMissionFocus: Write<SetMissionFocusInput>;
    readonly upsertSubMission: Write<UpsertSubMissionInput>;
    readonly setSubMissionStatus: Write<SetSubMissionStatusInput>;
    readonly reorderSubMissions: Write<ReorderSubMissionsInput>;
    readonly upsertMilestone: Write<UpsertMilestoneInput>;
    readonly upsertLane: Write<UpsertLaneInput>;
    readonly upsertWorkItem: Write<UpsertWorkItemInput>;
    readonly lockField: Write<LockFieldInput>;
    readonly markSeen: Write<MarkMissionSeenInput>;
  }
>()("t3/ardud/missions/MissionService") {}

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  let editor: MissionEditor | null = null;
  const reads = makeReads(store, () => editor);
  const writes = yield* makeWrites(store);

  /** Subscribes before reading the snapshot so nothing between the two is lost. */
  const batches = (
    keep: (item: MissionStreamItem) => boolean,
  ): Effect.Effect<Stream.Stream<ReadonlyArray<MissionStreamItem> | "tick">, never, Scope.Scope> =>
    Effect.map(store.subscribe, (subscription) =>
      Stream.merge(
        Stream.fromSubscription(subscription).pipe(
          Stream.chunks,
          Stream.map((batch) => batch.filter(keep)),
          Stream.filter((batch) => batch.length > 0),
        ),
        Stream.as(healthTicks, "tick" as const),
      ),
    );

  const subscribeList: Stream.Stream<MissionStreamItem, MissionError> = Stream.unwrap(
    Effect.gen(function* () {
      const triggers = yield* batches((item) => LIST_KINDS.has(itemKind(item) ?? ""));
      const first = yield* reads.listSnapshot;
      const updates = triggers.pipe(
        Stream.mapAccumEffect(
          () => first,
          (last, _trigger) =>
            Effect.map(reads.listSnapshot, (next) =>
              sameValue(next.missions, last.missions)
                ? ([last, []] as const)
                : ([next, [{ _tag: "list" as const, snapshot: next }]] as const),
            ),
        ),
      );
      return Stream.concat(Stream.make({ _tag: "list" as const, snapshot: first }), updates);
    }),
  );

  const subscribe = (missionId: MissionId): Stream.Stream<MissionSubscribeItem, MissionError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const triggers = yield* batches(
          (item) => itemMission(item) === missionId && OVERVIEW_KINDS.has(itemKind(item) ?? ""),
        );
        const seq = yield* store.latestSeq(missionId);
        const first = yield* reads.overview(missionId);
        const lanes = yield* store.list("lane", {
          missionId,
          status: ["working", "stuck", "waiting", "idle", "parked"],
          limit: INITIAL_LANES_LIMIT,
        });
        const initial: Array<MissionSubscribeItem> = [
          { _tag: "overview", seq, overview: first },
          ...lanes.map((lane): MissionSubscribeItem => ({
            _tag: "upsert",
            missionId,
            seq,
            record: { _tag: "lane", record: lane },
          })),
        ];
        const updates = triggers.pipe(
          Stream.mapAccumEffect(
            () => ({ seq, overview: first }),
            (last, trigger) =>
              Effect.gen(function* () {
                const forwarded =
                  trigger === "tick"
                    ? []
                    : trigger.filter((item) => MISSION_DELTA_KINDS.has(itemKind(item) ?? ""));
                const nextSeq =
                  trigger === "tick"
                    ? last.seq
                    : trigger.reduce((max, item) => Math.max(max, itemSeq(item)), last.seq);
                const overview = yield* reads.overview(missionId);
                const items: Array<MissionSubscribeItem> = [...forwarded];
                if (!sameValue(overview, last.overview)) {
                  items.push({ _tag: "overview", seq: nextSeq, overview });
                }
                return [{ seq: nextSeq, overview }, items] as const;
              }),
          ),
        );
        return Stream.concat(Stream.fromIterable(initial), updates);
      }),
    );

  const subscribeInbox = (missionId: MissionId | null): Stream.Stream<MissionInbox, MissionError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const triggers = yield* batches(
          (item) =>
            INBOX_KINDS.has(itemKind(item) ?? "") &&
            (missionId === null || itemMission(item) === missionId),
        );
        const first = yield* reads.inbox(missionId);
        const updates = triggers.pipe(
          Stream.filter((trigger) => trigger !== "tick"),
          Stream.mapEffect(() => reads.inbox(missionId)),
        );
        return Stream.concat(Stream.make(first), updates);
      }),
    );

  const digest = (missionId: MissionId, since: MissionDigestSince) =>
    Effect.gen(function* () {
      if (Option.isNone(yield* store.get("mission", missionId))) {
        return yield* new MissionError({
          code: "not-found",
          detail: `Mission ${missionId} does not exist.`,
        });
      }
      const list = yield* reads.listSnapshot;
      const latestSeq = yield* store.latestSeq(missionId);
      let events: ReadonlyArray<MissionEvent>;
      let truncated: boolean;
      switch (since._tag) {
        case "seq": {
          const page = yield* store.eventsSince(missionId, since.seq, DIGEST_LIMIT + 1);
          events = page.slice(0, DIGEST_LIMIT);
          truncated = page.length > DIGEST_LIMIT;
          break;
        }
        case "at": {
          const recent = yield* store.recentEvents(missionId, DIGEST_LIMIT + 1);
          const matching = recent.filter((event) => event.at > since.at);
          events = matching.slice(0, DIGEST_LIMIT).toReversed();
          truncated = matching.length > DIGEST_LIMIT;
          break;
        }
        case "recent": {
          const recent = yield* store.recentEvents(missionId, DIGEST_RECENT + 1);
          events = recent.slice(0, DIGEST_RECENT).toReversed();
          truncated = recent.length > DIGEST_RECENT;
          break;
        }
      }
      return {
        mission: list.missions.find((item) => item.id === missionId) ?? null,
        latestSeq,
        events,
        truncated,
      } satisfies MissionDigest;
    });

  return MissionService.of({
    listSnapshot: reads.listSnapshot,
    overview: reads.overview,
    inbox: reads.inbox,
    digest,
    eventsSince: store.eventsSince,
    subscribeList,
    subscribe,
    subscribeInbox,
    changes: Stream.unwrap(Effect.map(store.subscribe, Stream.fromSubscription)),
    registerEditor: (next) =>
      Effect.sync(() => {
        editor = next;
      }),
    ...writes,
  });
});

export const layer = Layer.effect(MissionService, make);
