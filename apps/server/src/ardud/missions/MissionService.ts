import {
  MissionError,
  type AnnotateApprovalInput,
  type Approval,
  type ApprovalStatus,
  type AttachThreadInput,
  type CloseStaleApprovalInput,
  type CreateMissionInput,
  type DecideApprovalInput,
  type MarkMissionSeenInput,
  type MergeLanesInput,
  type MergeSubMissionsInput,
  type MissionEvent,
  type MissionTimelineInput,
  type MissionTimelinePage,
  type MissionWorkItemsInput,
  type MissionWorkItemsPage,
  type MissionId,
  type MissionInbox,
  type MissionListItem,
  type MissionListSnapshot,
  type MissionMutationResult,
  type MissionOverview,
  type MissionProvenance,
  type MissionStreamItem,
  type MissionSubscribeItem,
  type OpenApprovalInput,
  type PortfolioSnapshot,
  type ReorderSubMissionsInput,
  type ReviseCallInput,
  type RouteApprovalInput,
  type SetApprovalRoutingInput,
  type SetMissionFocusInput,
  type SetMissionStatusInput,
  type SetPortfolioOrderInput,
  type SetSubMissionStatusInput,
  type SplitLaneInput,
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

import { makeEffort } from "./core/effort.ts";
import { MissionOwnerName } from "./core/ownerName.ts";
import type { MissionEditor, MissionRecoveryReader } from "./core/ports.ts";
import { HEALTH_TTL_MS, makeReads } from "./core/reads.ts";
import { makePages } from "./core/pages.ts";
import { makePortfolio, type PortfolioUsage } from "./core/portfolio.ts";
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
const APPROVALS_LIMIT = 200;
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
  // ardud missions: router
  "owner-request",
  // ardud missions: core - a reorder refreshes every client's portfolio
  "portfolio",
  // ardud missions: fix-p3 - a snooze or unsnooze changes needs-you counts
  "inbox-mark",
  // ardud missions: crw-threads - attached threads leave the clients' thread lists
  "thread-attachment",
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
  // ardud missions: router
  "owner-request",
  // ardud missions: crw-threads
  "thread-attachment",
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
    /** A page of a mission's work items, newest change first, by lane and stage. */
    readonly workItems: (
      input: MissionWorkItemsInput,
    ) => Effect.Effect<MissionWorkItemsPage, MissionError>;
    /** A page of the mission's timeline, newest first, each event with its filter family. */
    readonly timeline: (
      input: MissionTimelineInput,
    ) => Effect.Effect<MissionTimelinePage, MissionError>;
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
    // ardud missions: recovery
    /** The recovery track's overview badge (its cause and instant). */
    readonly registerRecovery: (reader: MissionRecoveryReader) => Effect.Effect<void>;

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
    readonly markSeen: Write<MarkMissionSeenInput>;
    readonly splitLane: Write<SplitLaneInput>;
    readonly mergeLanes: Write<MergeLanesInput>;
    readonly mergeSubMissions: Write<MergeSubMissionsInput>;

    /** Approvals of one mission, newest first; `ids` reads exact records (crw reads its decisions). */
    readonly approvals: (input: {
      readonly missionId: MissionId;
      readonly ids?: ReadonlyArray<string>;
      readonly status?: ReadonlyArray<ApprovalStatus>;
    }) => Effect.Effect<ReadonlyArray<Approval>, MissionError>;
    /** Systems (crw) open and stale-close approvals in their own component name. */
    readonly openApproval: Write<OpenApprovalInput>;
    readonly closeStaleApproval: Write<CloseStaleApprovalInput>;
    // ardud missions: crw-threads
    /** A component (crw) keeps a thread it runs inside the mission, or moves it on. */
    readonly attachThread: Write<AttachThreadInput>;
    /**
     * The owner decides any pending approval; the master those routed to it,
     * or any on a verified owner condition (`onOwnerCondition`).
     */
    readonly decideApproval: Write<DecideApprovalInput>;
    /** Owner or master: move one pending approval to the other approver, with a reason. */
    readonly routeApproval: Write<RouteApprovalInput>;
    /** Owner or master: replace the mission's approval routing table. */
    readonly setApprovalRouting: Write<SetApprovalRoutingInput>;
    // ardud missions: asks
    /** Owner or master: set the summary and flag chips on a pending approval. */
    readonly annotateApproval: Write<AnnotateApprovalInput>;
    /** The master revises its call on a verified owner condition. */
    readonly reviseCall: Write<ReviseCallInput>;
    // --- core additions ---
    /** Every listed mission in portfolio order, with pool use when policy measured it. */
    readonly portfolio: (
      usage: PortfolioUsage | null,
    ) => Effect.Effect<PortfolioSnapshot, MissionError>;
    /** Owner or any master: one portfolio order across missions. */
    readonly setPortfolioOrder: Write<SetPortfolioOrderInput>;
    // --- end core additions ---
  }
>()("t3/ardud/missions/MissionService") {}

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  let editor: MissionEditor | null = null;
  const effort = yield* makeEffort;
  // ardud missions: recovery
  let recovery: MissionRecoveryReader | null = null;
  // ardud missions: fix-p3
  const owner = yield* MissionOwnerName;
  const reads = makeReads(
    store,
    () => editor,
    effort,
    () => recovery,
    owner.name,
  );
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

  /** A portfolio reorder changes no list row, but clients refetch the portfolio on `list`. */
  const reordered = (trigger: ReadonlyArray<MissionStreamItem> | "tick") =>
    trigger !== "tick" && trigger.some((item) => itemKind(item) === "portfolio");

  const subscribeList: Stream.Stream<MissionStreamItem, MissionError> = Stream.unwrap(
    Effect.gen(function* () {
      const triggers = yield* batches((item) => LIST_KINDS.has(itemKind(item) ?? ""));
      const first = yield* reads.listSnapshot;
      const updates = triggers.pipe(
        Stream.mapAccumEffect(
          () => first,
          (last, trigger) =>
            Effect.map(reads.listSnapshot, (next) =>
              sameValue(next.missions, last.missions) && !reordered(trigger)
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
    ...makePages(store),
    ...makePortfolio(store),
    subscribeList,
    subscribe,
    subscribeInbox,
    changes: Stream.unwrap(Effect.map(store.subscribe, Stream.fromSubscription)),
    registerEditor: (next) =>
      Effect.sync(() => {
        editor = next;
      }),
    approvals: (input) =>
      store.list("approval", {
        missionId: input.missionId,
        ...(input.ids === undefined ? {} : { ids: input.ids }),
        ...(input.status === undefined ? {} : { status: input.status }),
        order: "newest",
        limit: APPROVALS_LIMIT,
      }),
    // ardud missions: recovery
    registerRecovery: (next) =>
      Effect.sync(() => {
        recovery = next;
      }),
    ...writes,
  });
});

export const layer = Layer.effect(MissionService, make);
