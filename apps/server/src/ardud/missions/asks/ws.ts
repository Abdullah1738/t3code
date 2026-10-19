/**
 * WS handlers for `MissionsAsksRpcs`: record feeds for rules, forks and draft
 * notes, the routing table, decided-item history, and the owner's draft
 * routing, draft note toggles and approval/draft annotations.
 *
 * Reads need only the read scope (any client may watch). Writes are owner
 * actions on a paired Robob client session (`ownerAppProvenance`) and call
 * the same service methods the master's MCP tools call.
 */
import {
  MISSIONS_ASKS_WS_METHODS,
  MissionError,
  type AnnotateApprovalInput,
  type AnnotateDraftInput,
  type Approval,
  type MissionFeedInput,
  type MissionFeedItem,
  type MissionId,
  type MissionInboxHistoryInput,
  type MissionMasterInbox,
  type MissionProvenance,
  type MissionRecord,
  type MissionRoutingTable,
  type MissionScopeInput,
  type MissionStreamItem,
  type RouteDraftInput,
  type SetDraftNoteActiveInput,
  type SuggestionStats,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ownerAppProvenance } from "../core/provenance.ts";
import * as RuleService from "../core/RuleService.ts";
import * as MissionService from "../MissionService.ts";
import type { MissionWsConnection } from "../ws.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { MissionStoreKind } from "../store/recordIndex.ts";
import * as AsksService from "./AsksService.ts";

const HISTORY_DAYS = 7;
const HISTORY_MAX_DAYS = 90;
const HISTORY_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

/** Statuses that mean the owner (or master) is done with an item. */
const DECIDED = {
  ask: ["answered", "withdrawn", "superseded"],
  draft: ["approved", "rewrite-requested", "dropped", "sent", "send-failed"],
  approval: ["approved", "rejected", "stale-closed"],
  knock: ["forwarded", "dropped"],
  suggestion: ["accepted", "edited", "dismissed"],
} as const;

export interface AsksWsServices {
  readonly store: MissionStore.MissionStore["Service"];
  readonly asks: AsksService.AsksService["Service"];
  readonly rules: RuleService.RuleService["Service"];
  readonly missions: MissionService.MissionService["Service"];
}

const recordMission = (record: MissionRecord): MissionId | null | undefined =>
  "missionId" in record.record ? (record.record.missionId as MissionId | null) : undefined;

/** Records of the mission plus global ones; a null mission means global only. */
const inScope = (missionId: MissionId | null, withGlobal: boolean) => (record: MissionRecord) => {
  const owner = recordMission(record);
  if (owner === undefined) return false;
  return owner === missionId || (withGlobal && owner === null);
};

export const makeAsksWsHandlers = (
  { store, asks, rules, missions }: AsksWsServices,
  connection: MissionWsConnection,
) => {
  const provenance = ownerAppProvenance(connection);
  const asOwner =
    <I, A>(write: (input: I, provenance: MissionProvenance) => Effect.Effect<A, MissionError>) =>
    (input: I): Effect.Effect<A, MissionError> =>
      provenance === null
        ? Effect.fail(
            new MissionError({
              code: "provenance-required",
              detail: "Owner actions need a paired Robob web, desktop or mobile session.",
            }),
          )
        : write(input, provenance);

  /**
   * Subscribes before reading the snapshot, so nothing committed in between
   * is lost; a delta may repeat what the snapshot holds.
   */
  const feed = (
    kinds: ReadonlySet<MissionStoreKind>,
    keep: (record: MissionRecord) => boolean,
    snapshot: Effect.Effect<ReadonlyArray<MissionRecord>, MissionError>,
  ): Stream.Stream<MissionFeedItem, MissionError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* store.subscribe;
        const revision = yield* store.revision;
        const records = yield* snapshot;
        const deltas = Stream.fromSubscription(subscription).pipe(
          Stream.filter((item: MissionStreamItem) => {
            if (item._tag === "upsert") {
              return kinds.has(item.record._tag as MissionStoreKind) && keep(item.record);
            }
            // A remove names no mission; clients apply it by id.
            return item._tag === "remove" && kinds.has(item.ref.kind as MissionStoreKind);
          }),
          Stream.map((item) => item as MissionFeedItem),
        );
        const first: MissionFeedItem = { _tag: "snapshot", revision, records };
        return Stream.concat(Stream.make(first), deltas);
      }),
    );

  const tagged =
    <K extends MissionStoreKind>(kind: K) =>
    (records: ReadonlyArray<unknown>) =>
      records.map((record) => ({ _tag: kind, record }) as MissionRecord);

  const subscribeRules = (input: MissionFeedInput) =>
    feed(
      new Set<MissionStoreKind>(["rule", "rule-change-request"]),
      inScope(input.missionId, true),
      Effect.gen(function* () {
        const ruleRecords = yield* rules.rules(input.missionId);
        const global = yield* rules.changeRequests(null);
        const own = input.missionId === null ? [] : yield* rules.changeRequests(input.missionId);
        return [
          ...tagged("rule")(ruleRecords),
          ...tagged("rule-change-request")([...own, ...global]),
        ];
      }),
    );

  /**
   * Forks have no global ones: null means every mission's forks. That
   * snapshot is the store's newest list (capped at its default limit).
   */
  const subscribeForks = (input: MissionScopeInput) =>
    feed(
      new Set<MissionStoreKind>(["fork"]),
      input.missionId === null ? () => true : inScope(input.missionId, false),
      Effect.map(
        store.list("fork", {
          ...(input.missionId === null ? {} : { missionId: input.missionId }),
          order: "newest",
        }),
        tagged("fork"),
      ),
    );

  const subscribeDraftNotes = (input: MissionFeedInput) =>
    feed(
      new Set<MissionStoreKind>(["draft-note"]),
      inScope(input.missionId, true),
      Effect.map(asks.draftNotes(input.missionId), tagged("draft-note")),
    );

  const routingTable = (missionId: MissionId) =>
    Effect.flatMap(store.get("mission", missionId), (found) =>
      Option.match(found, {
        onNone: () =>
          Effect.fail(new MissionError({ code: "not-found", detail: `No mission ${missionId}.` })),
        onSome: (mission): Effect.Effect<MissionRoutingTable> =>
          Effect.succeed({
            missionId,
            routes: mission.approvalRouting ?? [],
            updatedAt: mission.updatedAt,
          }),
      }),
    );

  const subscribeRouting = (input: { readonly missionId: MissionId }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* store.subscribe;
        const first = yield* routingTable(input.missionId);
        const routesOf = (table: MissionRoutingTable) => JSON.stringify(table.routes);
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (item) =>
              item._tag === "upsert" &&
              item.record._tag === "mission" &&
              item.record.record.id === input.missionId,
          ),
          Stream.mapEffect(() => routingTable(input.missionId)),
          Stream.mapAccum(
            () => routesOf(first),
            (last, table) => {
              const next = routesOf(table);
              return [next, next === last ? [] : [table]] as const;
            },
          ),
        );
        return Stream.concat(Stream.make(first), updates);
      }),
    );

  /**
   * A value recomputed once per commit that touched a record of `kinds` in
   * scope, sent first and then only when its content (ignoring a top-level
   * `revision`) changed.
   */
  const resent = <A>(
    kinds: ReadonlySet<MissionStoreKind>,
    missionId: MissionId | null,
    read: Effect.Effect<A, MissionError>,
  ): Stream.Stream<A, MissionError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* store.subscribe;
        const first = yield* read;
        const contentOf = (value: A) =>
          JSON.stringify(
            typeof value === "object" && value !== null && !Array.isArray(value)
              ? { ...value, revision: undefined }
              : value,
          );
        const touches = (item: MissionStreamItem) =>
          item._tag === "upsert"
            ? kinds.has(item.record._tag as MissionStoreKind) &&
              (missionId === null || item.missionId === missionId)
            : item._tag === "remove" && kinds.has(item.ref.kind as MissionStoreKind);
        const updates = Stream.fromSubscription(subscription).pipe(
          // A commit publishes its records and then its event: re-read once, on the event.
          Stream.mapAccum(
            () => false,
            (dirty, item) =>
              item._tag === "upsert" && item.record._tag === "event"
                ? ([false, dirty ? [item] : []] as const)
                : ([dirty || touches(item), []] as const),
          ),
          Stream.mapEffect(() => read),
          Stream.mapAccum(
            () => contentOf(first),
            (last, value) => {
              const next = contentOf(value);
              return [next, next === last ? [] : [value]] as const;
            },
          ),
        );
        return Stream.concat(Stream.make(first), updates);
      }),
    );

  const subscribeSuggestionStats = (
    input: MissionScopeInput,
  ): Stream.Stream<ReadonlyArray<SuggestionStats>, MissionError> =>
    resent(
      new Set<MissionStoreKind>(["suggestion"]),
      null,
      asks.missionSuggestionStats(input.missionId),
    );

  const subscribeMasterInbox = (
    input: MissionScopeInput,
  ): Stream.Stream<MissionMasterInbox, MissionError> =>
    resent(
      new Set<MissionStoreKind>(["draft", "approval", "suggestion"]),
      input.missionId,
      asks.masterInbox(input.missionId),
    );

  const inboxHistory = (input: MissionInboxHistoryInput) =>
    Effect.gen(function* () {
      const days = Math.min(input.days ?? HISTORY_DAYS, HISTORY_MAX_DAYS);
      const limit = Math.min(input.limit ?? HISTORY_LIMIT, HISTORY_MAX_LIMIT);
      const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days }));
      const scope = input.missionId === null ? {} : { missionId: input.missionId };
      const decided = <K extends keyof typeof DECIDED>(kind: K) =>
        store.list(kind, {
          ...scope,
          status: DECIDED[kind],
          updatedSince: since,
          order: "newest",
          limit,
        });
      return {
        since,
        asks: yield* decided("ask"),
        drafts: yield* decided("draft"),
        approvals: yield* decided("approval"),
        knocks: yield* decided("knock"),
        suggestions: yield* decided("suggestion"),
      };
    });

  /** Core owns approval writes (one writer); the reply is the annotated record. */
  const annotateApproval = (input: AnnotateApprovalInput, by: MissionProvenance) =>
    Effect.gen(function* () {
      yield* missions.annotateApproval(by, input);
      const found = yield* store.get("approval", input.approvalId);
      return yield* Option.match(found, {
        onNone: () =>
          Effect.fail(
            new MissionError({ code: "not-found", detail: `No approval ${input.approvalId}.` }),
          ),
        onSome: (approval): Effect.Effect<Approval> => Effect.succeed(approval),
      });
    });

  const M = MISSIONS_ASKS_WS_METHODS;
  return {
    [M.subscribeRules]: subscribeRules,
    [M.subscribeForks]: subscribeForks,
    [M.subscribeDraftNotes]: subscribeDraftNotes,
    [M.subscribeRouting]: subscribeRouting,
    [M.inboxHistory]: inboxHistory,
    [M.routeDraft]: asOwner((input: RouteDraftInput, by) => asks.routeDraft(input, by)),
    [M.setDraftNoteActive]: asOwner((input: SetDraftNoteActiveInput, by) =>
      asks.setDraftNoteActive(input, by),
    ),
    [M.annotateDraft]: asOwner((input: AnnotateDraftInput, by) => asks.annotateDraft(input, by)),
    [M.annotateApproval]: asOwner(annotateApproval),
    [M.subscribeSuggestionStats]: subscribeSuggestionStats,
    [M.subscribeMasterInbox]: subscribeMasterInbox,
  } as const;
};

/** The handler set for one connection, with the services from context. */
export const asksWsHandlers = (connection: MissionWsConnection) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    const asks = yield* AsksService.AsksService;
    const rules = yield* RuleService.RuleService;
    const missions = yield* MissionService.MissionService;
    return makeAsksWsHandlers({ store, asks, rules, missions }, connection);
  });
