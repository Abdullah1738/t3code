import {
  MISSIONS_ASKS_WS_METHODS as ASKS,
  MISSIONS_POLICY_WS_METHODS as POLICY,
  MISSIONS_VIEWS_WS_METHODS as VIEWS,
  DEFAULT_STARTER_LAYOUT,
  MissionError,
  VIEW_CATALOG_VERSION,
  viewPinnedStrip,
  WS_METHODS,
  type ApprovalId,
  type DraftId,
  type DraftNote,
  type Lane,
  type MissionActor,
  type MissionEvent,
  type MissionFeedItem,
  type MissionId,
  type MissionInbox,
  type MissionOverview,
  type MissionRecord,
  type MissionRecordKind,
  type MissionRecordRef,
  type MissionViewsSnapshot,
  type OwnerRequest as OwnerRequestRecord,
  type OwnerRequestId,
  type OwnerRequestView,
  type PoolView,
  type PoolsSnapshot,
  type Room,
  type RoomId,
  type RoomPage,
  type Rule,
  type RuleChangeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type { EnvironmentRpcSuccess, EnvironmentUnaryRpcTag } from "../../rpc/client.ts";
import type { WsRpcProtocolClient } from "../../rpc/protocol.ts";
import { latestFieldChanges } from "./changeLog.ts";
import { portfolioFromMissions } from "./portfolioViewModel.ts";
import { listedRoomUnread, pageUnread } from "./roomsViewModel.ts";
import type {
  FieldChange,
  Listener,
  MissionForkEntry,
  MissionInboxSnapshot,
  MissionPoolUsage,
  MissionRoomEntry,
  MissionViewChange,
  MissionViewsState,
  MissionsSource,
  OwnerRequest,
  OwnerRequestStatus,
  SampledFeed,
  Unsubscribe,
} from "./source.ts";

// The missions source over the server's WS RPCs. Everything with an RPC is
// live; the feeds the server does not serve yet come from the fallback (the
// fixture) and are listed in `sampled` so their sections can say so.
//
// The transport is injected so this file stays plain TypeScript: the web
// client passes the Effect/atom transport from `rpcTransport.ts`, tests pass a
// fake.

/** Streaming mission RPCs. Every other mission RPC is a plain request. */
export type MissionsStreamTag =
  | typeof WS_METHODS.missionsSubscribeList
  | typeof WS_METHODS.missionsSubscribe
  | typeof WS_METHODS.missionsInbox
  | typeof ASKS.subscribeRules
  | typeof ASKS.subscribeForks
  | typeof ASKS.subscribeDraftNotes
  | typeof ASKS.subscribeRouting
  | typeof VIEWS.subscribe;

export type MissionsRequestTag = Exclude<EnvironmentUnaryRpcTag, MissionsStreamTag>;

type RpcTag = keyof WsRpcProtocolClient & string;

export type MissionsRpcInput<TTag extends RpcTag> = Parameters<WsRpcProtocolClient[TTag]>[0];

export type MissionsStreamValue<TTag extends MissionsStreamTag> =
  WsRpcProtocolClient[TTag] extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export interface MissionsTransport {
  /**
   * Opens a server stream and calls `onValue` for every item in order. The
   * transport follows reconnects on its own; `onError` only sees failures the
   * server sent (a `MissionError`, an auth error).
   */
  stream<TTag extends MissionsStreamTag>(
    tag: TTag,
    input: MissionsRpcInput<TTag>,
    onValue: (value: MissionsStreamValue<TTag>) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe;
  /** One request. Rejects with what the server failed with (a `MissionError` for mission rules). */
  request<TTag extends MissionsRequestTag>(
    tag: TTag,
    input: MissionsRpcInput<TTag>,
  ): Promise<EnvironmentRpcSuccess<TTag>>;
}

export interface RpcMissionsSourceOptions {
  readonly transport: MissionsTransport;
  /** Serves the feeds the server has no RPC for yet. */
  readonly fallback: MissionsSource;
  readonly now?: () => number;
}

/** Feeds the RPC source fills from the fallback. */
export const RPC_SAMPLED_FEEDS: ReadonlySet<SampledFeed> = new Set<SampledFeed>([
  "work",
  "timeline",
  "portfolio",
  "suggestion-stats",
  "recovery",
]);

/** Newest events kept per mission feed, for change attribution and refresh triggers. */
const EVENT_LIMIT = 500;
/** Messages read per room page, and per room when counting unread. */
const ROOM_PAGE_SIZE = 50;
const ROOM_PAGE_MAX = 200;

// --- Small building blocks ---

/**
 * One upstream subscription per key, shared by every reader, replaying the
 * latest value to late readers and closing with the last one.
 */
function sharedFeeds<K, T>(open: (key: K, emit: (value: T) => void) => Unsubscribe) {
  interface Entry {
    has: boolean;
    value: T | undefined;
    readonly listeners: Set<Listener<T>>;
    close: Unsubscribe;
  }
  const entries = new Map<K, Entry>();
  return (key: K, listener: Listener<T>): Unsubscribe => {
    let entry = entries.get(key);
    if (entry === undefined) {
      const created: Entry = {
        has: false,
        value: undefined,
        listeners: new Set(),
        close: () => {},
      };
      entries.set(key, created);
      created.listeners.add(listener);
      created.close = open(key, (value) => {
        created.has = true;
        created.value = value;
        // Copied: a listener may unsubscribe or subscribe while this runs.
        for (const each of Array.from(created.listeners)) each(value);
      });
      entry = created;
    } else {
      entry.listeners.add(listener);
      if (entry.has) listener(entry.value as T);
    }
    const own = entry;
    return () => {
      own.listeners.delete(listener);
      if (own.listeners.size > 0 || entries.get(key) !== own) return;
      entries.delete(key);
      own.close();
    };
  };
}

/** Re-runs a request on demand; overlapping asks collapse into one more run. */
function refetching<T>(
  load: () => Promise<T>,
  emit: (value: T) => void,
  onError: (error: unknown) => void,
) {
  let inFlight = false;
  let again = false;
  let closed = false;
  const run = () => {
    if (closed) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    load()
      .then(
        (value) => {
          if (!closed) emit(value);
        },
        (error: unknown) => {
          if (!closed) onError(error);
        },
      )
      .finally(() => {
        inFlight = false;
        if (!again) return;
        again = false;
        run();
      });
  };
  return {
    run,
    close: () => {
      closed = true;
    },
  };
}

/** Same result for the same inputs, so snapshot stores see an unchanged value. */
function memoLast<A extends ReadonlyArray<unknown>, R>(
  compute: (...args: A) => R,
): (...args: A) => R {
  let lastArgs: A | null = null;
  let lastValue: R | undefined;
  return (...args) => {
    const previous = lastArgs;
    if (previous !== null && args.every((arg, index) => Object.is(arg, previous[index]))) {
      return lastValue as R;
    }
    lastArgs = args;
    lastValue = compute(...args);
    return lastValue;
  };
}

/** Local invalidation: a mutation names what it touched, readers of it refetch. */
function createBus() {
  const topics = new Map<string, Set<(detail: string | undefined) => void>>();
  return {
    on(topic: string, handler: (detail: string | undefined) => void): Unsubscribe {
      const handlers = topics.get(topic) ?? new Set();
      handlers.add(handler);
      topics.set(topic, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) topics.delete(topic);
      };
    },
    emit(topic: string, detail?: string) {
      for (const handler of Array.from(topics.get(topic) ?? [])) handler(detail);
    },
  };
}

const ignore = () => {};

const isMissionError = Schema.is(MissionError);
const isNotFound = (error: unknown) => isMissionError(error) && error.code === "not-found";

const notOnServer = (what: string) =>
  Promise.reject(
    new MissionError({ code: "invalid", detail: `${what} is not on the server yet.` }),
  );

const changesFor = (
  events: ReadonlyArray<MissionEvent>,
  kinds: ReadonlyArray<MissionRecordKind>,
): FieldChange[] =>
  latestFieldChanges(
    events.filter((event) => event.subject !== null && kinds.includes(event.subject.kind)),
  );

function payloadRoomId(event: MissionEvent): string | null {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || !("roomId" in payload)) return null;
  const roomId = (payload as { readonly roomId: unknown }).roomId;
  return typeof roomId === "string" ? roomId : null;
}

function holderName(actor: MissionActor): string {
  switch (actor._tag) {
    case "owner":
      return "you";
    case "role":
      return actor.roleId;
    case "lane":
      return actor.laneId;
    case "thread":
      return actor.threadId;
    case "system":
      return actor.component;
    case "person":
      return actor.name;
  }
}

/** A settle or reopen note goes over the wire only when it says something. */
const noteOf = (note: string | undefined) => {
  const text = note?.trim() ?? "";
  return text === "" ? {} : { note: text };
};

const REQUEST_STATUS: Record<OwnerRequestRecord["status"], OwnerRequestStatus> = {
  "waiting-on-master": "waiting",
  answered: "answered",
  settled: "settled",
};

/**
 * A router owner request as Your requests reads it. A list read carries the
 * newest few messages as summaries; a single-request read carries bodies.
 */
export function ownerRequestOf(
  request: OwnerRequestRecord,
  view?: Pick<OwnerRequestView, "messages" | "hasOlder" | "unreadForOwner">,
): OwnerRequest {
  return {
    id: request.id,
    missionId: request.missionId,
    title: request.title,
    status: REQUEST_STATUS[request.status],
    messages: (view?.messages ?? []).map(({ message, body }) => ({
      id: message.id,
      author: message.author._tag === "owner" ? "owner" : "master",
      text: body ?? message.summary,
      at: message.createdAt,
      refs: message.links,
    })),
    hasOlder: view?.hasOlder ?? false,
    links: request.links,
    subject: request.subject ?? null,
    unread: view?.unreadForOwner ?? request.unreadForOwner,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    settledAt: request.settledAt,
  };
}

/** A policy pool as the header usage line reads it. */
export function poolUsageOf(view: PoolView): MissionPoolUsage {
  const { pool } = view;
  const base = { id: pool.id, label: pool.name, sampledAt: pool.usage.sampledAt };
  if (pool.kind === "budget") {
    return {
      _tag: "budget",
      ...base,
      spent: pool.usage.used,
      cap: pool.capacity,
      currency: pool.unit,
    };
  }
  if (pool.kind === "lease" && pool.capacity === 1) {
    const hold = view.holds.find((each) => each.status === "active") ?? null;
    return {
      _tag: "lock",
      ...base,
      holder: hold === null ? null : holderName(hold.holder),
      since: hold?.takenAt ?? null,
    };
  }
  const used = pool.kind === "observed" ? pool.usage.used : view.inUse;
  return {
    _tag: "accounts",
    ...base,
    usable: Math.max(0, pool.capacity - used),
    total: pool.capacity,
  };
}

/** Records of one feed (rules, forks, draft notes), kept in server order. */
function feedRecords(apply: (records: ReadonlyArray<MissionRecord>) => void) {
  const records = new Map<string, MissionRecord>();
  const keyOf = (kind: string, id: string) => `${kind}:${id}`;
  const recordKey = (record: MissionRecord) =>
    keyOf(record._tag, "id" in record.record ? String(record.record.id) : record.record.missionId);
  return (item: MissionFeedItem) => {
    switch (item._tag) {
      case "snapshot":
        records.clear();
        for (const record of item.records) records.set(recordKey(record), record);
        break;
      case "upsert":
        records.set(recordKey(item.record), item.record);
        break;
      case "remove":
        records.delete(keyOf(item.ref.kind, item.ref.id));
        break;
    }
    apply([...records.values()]);
  };
}

const newestFirst = <T extends { readonly createdAt: string }>(items: ReadonlyArray<T>): T[] =>
  [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

// --- The source ---

interface MissionFeedState {
  /** `undefined` until the server answers, `null` when the mission is gone. */
  readonly overview: MissionOverview | null | undefined;
  readonly lanes: ReadonlyArray<Lane>;
  readonly events: ReadonlyArray<MissionEvent>;
  /** The event that caused this emission, if one did. */
  readonly latest: MissionEvent | null;
}

interface RuleRecords {
  readonly rules: ReadonlyArray<Rule>;
  readonly changeRequests: ReadonlyArray<RuleChangeRequest>;
}

/** The views record a server without the views track would hold: the starter layout. */
function starterViews(missionId: MissionId): MissionViewsSnapshot {
  const waiting = { ownerWaiting: 0, requestsUnread: 0 };
  const pinned = viewPinnedStrip(DEFAULT_STARTER_LAYOUT.layout, waiting);
  return {
    missionId,
    catalogVersion: VIEW_CATALOG_VERSION,
    revision: 0,
    templates: [],
    sections: [],
    layout: {
      missionId,
      layout: DEFAULT_STARTER_LAYOUT.layout,
      version: DEFAULT_STARTER_LAYOUT.version,
      changedBy: DEFAULT_STARTER_LAYOUT.changedBy,
      by: DEFAULT_STARTER_LAYOUT.by,
      changedAt: DEFAULT_STARTER_LAYOUT.changedAt,
      changeNote: null,
      seededFrom: DEFAULT_STARTER_LAYOUT.version,
    },
    starter: DEFAULT_STARTER_LAYOUT,
    ...waiting,
    pinnedStrip: pinned.needsYou || pinned.requests,
    pinned,
    changesToday: 0,
  };
}

/** The layout change log from the mission's `view.*` events, newest first. */
export function viewChangesOf(events: ReadonlyArray<MissionEvent>): MissionViewChange[] {
  const changes = events
    .filter((event) => event.kind.startsWith("view."))
    .map((event) => ({
      id: event.id,
      at: event.at,
      by: event.actor._tag === "owner" ? ("owner" as const) : ("master" as const),
      summary: event.summary,
    }));
  return [...changes].reverse();
}

export function createRpcMissionsSource(options: RpcMissionsSourceOptions): MissionsSource {
  const { transport, fallback } = options;
  const now = options.now ?? Date.now;
  const bus = createBus();

  // Sample feeds read a mission the fixture knows: the same id when it has
  // one, else its first mission.
  let sampleIds: ReadonlyArray<MissionId> = [];
  fallback.subscribeList((snapshot) => {
    sampleIds = snapshot.missions.map((mission) => mission.id);
  })();
  const sampleId = (missionId: MissionId): MissionId =>
    sampleIds.includes(missionId) ? missionId : (sampleIds[0] ?? missionId);

  // One `missions.subscribe` stream per mission, shared by every screen.
  const missionFeed = sharedFeeds<MissionId, MissionFeedState>((missionId, emit) => {
    let overview: MissionOverview | null | undefined;
    const laneById = new Map<string, Lane>();
    let lanes: ReadonlyArray<Lane> = [];
    let events: ReadonlyArray<MissionEvent> = [];
    const send = (latest: MissionEvent | null) => emit({ overview, lanes, events, latest });
    return transport.stream(
      WS_METHODS.missionsSubscribe,
      { missionId },
      (item) => {
        switch (item._tag) {
          case "overview":
            overview = item.overview;
            send(null);
            return;
          case "upsert": {
            const { record } = item;
            if (record._tag === "lane") {
              laneById.set(record.record.id, record.record);
              lanes = [...laneById.values()];
              send(null);
            } else if (record._tag === "event") {
              if (events.some((event) => event.id === record.record.id)) return;
              events = [...events, record.record].slice(-EVENT_LIMIT);
              send(record.record);
            }
            return;
          }
          case "remove":
            if (item.ref.kind === "lane" && laneById.delete(item.ref.id)) {
              lanes = [...laneById.values()];
              send(null);
            }
            return;
          case "list":
            return;
        }
      },
      () => {
        if (overview !== undefined) return;
        overview = null;
        send(null);
      },
    );
  });

  /** Calls `handler` for each event that arrives after subscribing. */
  const onNewEvents = (
    missionId: MissionId,
    handler: (event: MissionEvent) => void,
  ): Unsubscribe => {
    let primed = false;
    let seen: string | null = null;
    return missionFeed(missionId, (state) => {
      const id = state.latest?.id ?? null;
      if (!primed) {
        primed = true;
        seen = id;
        return;
      }
      if (state.latest === null || id === seen) return;
      seen = id;
      handler(state.latest);
    });
  };

  /** A request-backed feed, refetched on matching mission events and bus topics. */
  const requestFeed = <T>(config: {
    readonly missionId: MissionId;
    readonly load: () => Promise<T>;
    readonly refreshOn: (event: MissionEvent) => boolean;
    readonly topics: ReadonlyArray<string>;
    readonly emit: (value: T) => void;
    readonly onError?: (error: unknown) => void;
  }) => {
    const loader = refetching(config.load, config.emit, config.onError ?? ignore);
    loader.run();
    const stopEvents = onNewEvents(config.missionId, (event) => {
      if (config.refreshOn(event)) loader.run();
    });
    const stopTopics = config.topics.map((topic) => bus.on(topic, loader.run));
    return {
      refresh: loader.run,
      stop: () => {
        loader.close();
        stopEvents();
        for (const stop of stopTopics) stop();
      },
    };
  };

  const kindStarts =
    (...prefixes: ReadonlyArray<string>) =>
    (event: MissionEvent) =>
      prefixes.some((prefix) => event.kind.startsWith(prefix));

  const poolsFeed = sharedFeeds<MissionId, PoolsSnapshot>(
    (missionId, emit) =>
      requestFeed({
        missionId,
        load: () => transport.request(POLICY.pools, { missionId }),
        refreshOn: kindStarts("pool."),
        topics: ["pools"],
        emit,
      }).stop,
  );

  const inboxFeed = sharedFeeds<MissionId | null, MissionInbox>((missionId, emit) =>
    transport.stream(WS_METHODS.missionsInbox, { missionId }, emit),
  );

  const rulesFeed = sharedFeeds<MissionId, RuleRecords>((missionId, emit) =>
    transport.stream(
      ASKS.subscribeRules,
      { missionId },
      feedRecords((records) =>
        emit({
          rules: records.flatMap((record) => (record._tag === "rule" ? [record.record] : [])),
          changeRequests: newestFirst(
            records.flatMap((record) =>
              record._tag === "rule-change-request" ? [record.record] : [],
            ),
          ),
        }),
      ),
    ),
  );

  const roomsFeed = sharedFeeds<MissionId, ReadonlyArray<MissionRoomEntry>>((missionId, emit) => {
    // Unread counts come from the room list once the router sends them (r5);
    // until then from each room's newest page plus the gap back to the read
    // mark. A room is only read again when it has a newer message or the
    // owner read or posted in it.
    const counted = new Map<RoomId, { readonly lastSeq: number; readonly unread: number }>();
    const stale = new Set<RoomId>();
    const unreadOf = async (room: Room): Promise<number> => {
      const listed = listedRoomUnread(room);
      if (listed !== null) return room.archived ? 0 : listed;
      const known = counted.get(room.id);
      if (known !== undefined && known.lastSeq === room.lastSeq && !stale.has(room.id))
        return known.unread;
      stale.delete(room.id);
      if (room.archived || room.lastSeq === 0) {
        counted.set(room.id, { lastSeq: room.lastSeq, unread: 0 });
        return 0;
      }
      const page = await transport.request(WS_METHODS.missionsRoomPage, {
        roomId: room.id,
        limit: ROOM_PAGE_SIZE,
      });
      const unread = pageUnread(page);
      counted.set(room.id, { lastSeq: room.lastSeq, unread });
      return unread;
    };
    const feed = requestFeed({
      missionId,
      load: async () => {
        const rooms = await transport.request(WS_METHODS.missionsRooms, { missionId });
        return Promise.all(rooms.map(async (room) => ({ room, unread: await unreadOf(room) })));
      },
      refreshOn: (event) =>
        event.kind === "message.posted" ||
        event.kind.startsWith("room.") ||
        event.kind.startsWith("knock."),
      topics: [],
      emit,
    });
    const stopTouched = bus.on("rooms", (roomId) => {
      if (roomId !== undefined) stale.add(roomId as RoomId);
      feed.refresh();
    });
    return () => {
      stopTouched();
      feed.stop();
    };
  });

  const roomPageFeed = sharedFeeds<RoomId, RoomPage | null>((roomId, emit) => {
    let closed = false;
    let stopEvents: Unsubscribe | null = null;
    const loader = refetching(
      () => transport.request(WS_METHODS.missionsRoomPage, { roomId, limit: ROOM_PAGE_SIZE }),
      (page) => {
        emit(page);
        if (stopEvents !== null || closed) return;
        stopEvents = onNewEvents(page.room.missionId, (event) => {
          const touched =
            (event.kind === "message.posted" && payloadRoomId(event) === roomId) ||
            (event.subject?.kind === "room" && event.subject.id === roomId);
          if (touched) loader.run();
        });
      },
      (error) => {
        if (isNotFound(error)) emit(null);
      },
    );
    loader.run();
    const stopTouched = bus.on(`room:${roomId}`, loader.run);
    return () => {
      closed = true;
      loader.close();
      stopTouched();
      stopEvents?.();
    };
  });

  // Owner requests: the list and each open conversation refetch on request
  // events. The newest message seq per request is kept for marking it read.
  const requestReads = new Map<string, { readonly roomId: RoomId; readonly seq: number }>();
  const readView = (view: OwnerRequestView): OwnerRequest => {
    const last = view.messages.at(-1);
    if (last !== undefined) {
      requestReads.set(view.request.id, { roomId: view.request.roomId, seq: last.message.seq });
    }
    return ownerRequestOf(view.request, view);
  };
  const requestTouched = (event: MissionEvent, requestId: string) =>
    event.kind.startsWith("request.") &&
    event.subject?.kind === "owner-request" &&
    event.subject.id === requestId;
  const touchRequest = (request: OwnerRequestRecord) => {
    bus.emit(`requests:${request.missionId}`);
    bus.emit(`request:${request.id}`);
  };

  const requestsFeed = sharedFeeds<MissionId, ReadonlyArray<OwnerRequest>>(
    (missionId, emit) =>
      requestFeed({
        missionId,
        load: async () =>
          (await transport.request(WS_METHODS.missionsOwnerRequests, { missionId })).requests.map(
            readView,
          ),
        refreshOn: kindStarts("request."),
        topics: [`requests:${missionId}`],
        emit,
      }).stop,
  );

  const requestThreadFeed = sharedFeeds<string, OwnerRequest | null>((key, emit) => {
    const [missionId, requestId] = key.split("\n") as [MissionId, OwnerRequestId];
    return requestFeed({
      missionId,
      load: async () => {
        const read = await transport.request(WS_METHODS.missionsOwnerRequests, {
          missionId,
          requestId,
        });
        const view = read.requests.find((each) => each.request.id === requestId);
        return view === undefined ? null : readView(view);
      },
      refreshOn: (event) => requestTouched(event, requestId),
      topics: [`request:${requestId}`],
      emit,
      onError: (error) => {
        if (isNotFound(error)) emit(null);
      },
    }).stop;
  });

  const touchRoom = (roomId: RoomId) => {
    bus.emit(`room:${roomId}`);
    bus.emit("rooms", roomId);
  };

  return {
    sampled: RPC_SAMPLED_FEEDS,

    subscribeList: (listener) =>
      transport.stream(WS_METHODS.missionsSubscribeList, {}, (item) => {
        if (item._tag === "list") listener(item.snapshot);
      }),

    subscribeOverview(missionId, listener) {
      let feed: MissionFeedState | undefined;
      let pools: PoolsSnapshot | undefined;
      const snapshot = memoLast(
        (
          overview: MissionOverview,
          poolsSnapshot: PoolsSnapshot | undefined,
          events: ReadonlyArray<MissionEvent>,
        ) => ({
          ...overview,
          poolUsage: (poolsSnapshot?.pools ?? []).map(poolUsageOf),
          changes: changesFor(events, ["mission", "sub-mission"]),
        }),
      );
      const push = () => {
        if (feed === undefined || feed.overview === undefined) return;
        listener(feed.overview === null ? null : snapshot(feed.overview, pools, feed.events));
      };
      const stopFeed = missionFeed(missionId, (state) => {
        feed = state;
        push();
      });
      const stopPools = poolsFeed(missionId, (value) => {
        pools = value;
        push();
      });
      return () => {
        stopFeed();
        stopPools();
      };
    },

    subscribeLanes(missionId, listener) {
      let last: ReadonlyArray<Lane> | null = null;
      return missionFeed(missionId, (state) => {
        if (state.overview === undefined || state.lanes === last) return;
        last = state.lanes;
        listener(state.lanes);
      });
    },

    subscribeInbox(missionId, listener) {
      const snapshot = memoLast((inbox: MissionInbox): MissionInboxSnapshot => ({
        ...inbox,
        // The server's inbox carries only what is routed to the owner.
        masterCounts: { approve: 0, suggestions: 0 },
      }));
      return inboxFeed(missionId, (inbox) => listener(snapshot(inbox)));
    },

    subscribeRouting(missionId, listener) {
      let table: Parameters<typeof withChanges>[0] | undefined;
      let events: ReadonlyArray<MissionEvent> = [];
      const withChanges = memoLast(
        (
          current: MissionsStreamValue<typeof ASKS.subscribeRouting>,
          log: ReadonlyArray<MissionEvent>,
        ) => ({
          ...current,
          changes: latestFieldChanges(
            log.filter((event) => event.kind === "approval-routing.updated"),
          ),
        }),
      );
      const push = () => {
        if (table !== undefined) listener(withChanges(table, events));
      };
      const stopTable = transport.stream(
        ASKS.subscribeRouting,
        { missionId },
        (value) => {
          table = value;
          push();
        },
        (error) => {
          if (isNotFound(error)) listener(null);
        },
      );
      const stopFeed = missionFeed(missionId, (state) => {
        events = state.events;
        push();
      });
      return () => {
        stopTable();
        stopFeed();
      };
    },

    subscribeWork: (missionId, listener) => fallback.subscribeWork(sampleId(missionId), listener),

    subscribeRuleBook(missionId, listener) {
      let rules: RuleRecords | undefined;
      let inbox: MissionInbox | undefined;
      let events: ReadonlyArray<MissionEvent> = [];
      const book = memoLast(
        (
          records: RuleRecords,
          current: MissionInbox | undefined,
          log: ReadonlyArray<MissionEvent>,
        ) => ({
          missionId,
          rules: records.rules,
          changeRequests: records.changeRequests,
          // The conflict and stale audit has no RPC yet.
          audit: [],
          suggestions: (current?.suggestions ?? []).filter(
            (suggestion) => suggestion.targetKind === "rule",
          ),
          changes: changesFor(log, ["rule", "rule-change-request"]),
        }),
      );
      const push = () => {
        if (rules !== undefined) listener(book(rules, inbox, events));
      };
      const stops = [
        rulesFeed(missionId, (value) => {
          rules = value;
          push();
        }),
        inboxFeed(missionId, (value) => {
          inbox = value;
          push();
        }),
        missionFeed(missionId, (state) => {
          events = state.events;
          push();
        }),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },

    subscribeRoles(missionId, listener) {
      let events: ReadonlyArray<MissionEvent> = [];
      let roles: MissionsRoles | undefined;
      const snapshot = memoLast((current: MissionsRoles, log: ReadonlyArray<MissionEvent>) => ({
        ...current,
        changes: changesFor(log, ["role"]),
      }));
      const push = () => {
        if (roles !== undefined) listener(snapshot(roles, events));
      };
      const feed = requestFeed({
        missionId,
        load: () => transport.request(POLICY.roles, { missionId }),
        refreshOn: kindStarts("role."),
        topics: ["roles"],
        emit: (value) => {
          roles = value;
          push();
        },
      });
      const stopFeed = missionFeed(missionId, (state) => {
        events = state.events;
        push();
      });
      return () => {
        feed.stop();
        stopFeed();
      };
    },

    subscribeReviewPolicy(missionId, listener) {
      let events: ReadonlyArray<MissionEvent> = [];
      let policy: MissionsReviewPolicy | undefined;
      const snapshot = memoLast(
        (current: MissionsReviewPolicy, log: ReadonlyArray<MissionEvent>) => ({
          missionId,
          policy: current.policy,
          // Verdicts and reviews have no list RPC yet.
          verdicts: [],
          reviews: [],
          changes: changesFor(log, ["review-policy"]),
        }),
      );
      const push = () => {
        if (policy !== undefined) listener(snapshot(policy, events));
      };
      const feed = requestFeed({
        missionId,
        load: () => transport.request(POLICY.reviewPolicy, { missionId }),
        refreshOn: kindStarts("review", "criticality"),
        topics: [`review:${missionId}`],
        emit: (value) => {
          policy = value;
          push();
        },
        onError: (error) => {
          if (isNotFound(error)) listener(null);
        },
      });
      const stopFeed = missionFeed(missionId, (state) => {
        events = state.events;
        push();
      });
      return () => {
        feed.stop();
        stopFeed();
      };
    },

    subscribePools(missionId, listener) {
      let events: ReadonlyArray<MissionEvent> = [];
      let pools: PoolsSnapshot | undefined;
      const snapshot = memoLast((current: PoolsSnapshot, log: ReadonlyArray<MissionEvent>) => ({
        ...current,
        changes: changesFor(log, ["pool", "pool-hold"]),
      }));
      const push = () => {
        if (pools !== undefined) listener(snapshot(pools, events));
      };
      const stopPools = poolsFeed(missionId, (value) => {
        pools = value;
        push();
      });
      const stopFeed = missionFeed(missionId, (state) => {
        events = state.events;
        push();
      });
      return () => {
        stopPools();
        stopFeed();
      };
    },

    subscribeRecovery: (missionId, listener) =>
      fallback.subscribeRecovery(sampleId(missionId), listener),
    subscribeTimeline: (missionId, listener) =>
      fallback.subscribeTimeline(sampleId(missionId), listener),
    // Until core r6 serves the portfolio read, build it from the live missions:
    // the list names them and each overview carries shares and usage. Order,
    // pool draws and reorders need the read, so the feed stays marked sample.
    subscribePortfolio(listener) {
      const feeds = new Map<
        MissionId,
        { state: MissionFeedState | undefined; readonly close: Unsubscribe }
      >();
      const send = () => {
        const states = [...feeds.values()].map((feed) => feed.state);
        if (states.some((state) => state === undefined || state.overview === undefined)) return;
        const missions = states.flatMap((state) =>
          state?.overview
            ? [{ mission: state.overview.mission, usageShare: state.overview.usageShare }]
            : [],
        );
        const changes = changesFor(
          states.flatMap((state) => state?.events ?? []),
          ["mission"],
        );
        listener(portfolioFromMissions(missions, changes));
      };
      const stopList = transport.stream(WS_METHODS.missionsSubscribeList, {}, (item) => {
        if (item._tag !== "list") return;
        const ids = new Set(
          item.snapshot.missions
            .filter((mission) => mission.status !== "archived")
            .map((mission) => mission.id),
        );
        for (const [id, feed] of feeds) {
          if (ids.has(id)) continue;
          feed.close();
          feeds.delete(id);
        }
        for (const id of ids) {
          if (feeds.has(id)) continue;
          const feed: { state: MissionFeedState | undefined; close: Unsubscribe } = {
            state: undefined,
            close: () => {},
          };
          feeds.set(id, feed);
          feed.close = missionFeed(id, (state) => {
            feed.state = state;
            send();
          });
        }
        send();
      });
      return () => {
        stopList();
        for (const feed of feeds.values()) feed.close();
        feeds.clear();
      };
    },
    subscribeSuggestionStats: (listener) => fallback.subscribeSuggestionStats(listener),

    subscribeInboxHistory(missionId, listener) {
      const loader = refetching(
        () => transport.request(ASKS.inboxHistory, { missionId }),
        listener,
        ignore,
      );
      let revision: number | null = null;
      const stop = inboxFeed(missionId, (inbox) => {
        if (inbox.revision === revision) return;
        revision = inbox.revision;
        loader.run();
      });
      return () => {
        loader.close();
        stop();
      };
    },

    subscribeDraftNotes: (missionId, listener) =>
      transport.stream(
        ASKS.subscribeDraftNotes,
        { missionId },
        feedRecords((records) =>
          listener(
            records.flatMap((record): DraftNote[] =>
              record._tag === "draft-note" ? [record.record] : [],
            ),
          ),
        ),
      ),

    subscribeForks(missionId, listener) {
      // The server reads forks per mission; there is no all-missions feed.
      if (missionId === null) {
        listener([]);
        return ignore;
      }
      return transport.stream(
        ASKS.subscribeForks,
        { missionId },
        feedRecords((records) =>
          listener(
            newestFirst(
              records.flatMap((record) => (record._tag === "fork" ? [record.record] : [])),
            ).map((fork): MissionForkEntry => ({ fork, question: fork.question ?? null })),
          ),
        ),
      );
    },

    subscribeRules(missionId, listener) {
      let last: ReadonlyArray<Rule> | null = null;
      return rulesFeed(missionId, (records) => {
        if (records.rules === last) return;
        last = records.rules;
        listener(records.rules);
      });
    },

    subscribeRooms: (missionId, listener) => roomsFeed(missionId, listener),
    subscribeRoom: (roomId, listener) => roomPageFeed(roomId, listener),

    loadRoomPage: (input) =>
      transport.request(WS_METHODS.missionsRoomPage, {
        roomId: input.roomId,
        beforeSeq: Math.max(1, Math.floor(input.beforeSeq)),
        limit: Math.min(ROOM_PAGE_MAX, Math.max(1, Math.floor(input.limit))),
      }),

    // --- Mission ---

    reorderSubMissions: async (input) => {
      await transport.request(WS_METHODS.missionsReorderSubMissions, input);
    },
    setMissionPaused: async ({ missionId, paused }) => {
      await transport.request(WS_METHODS.missionsSetStatus, {
        missionId,
        status: paused ? "paused" : "active",
      });
    },
    setMissionFocus: async (input) => {
      await transport.request(WS_METHODS.missionsSetFocus, input);
    },
    setIntendedEffort: async ({ missionId, subMissionId, share }) => {
      await transport.request(WS_METHODS.missionsUpsertSubMission, {
        missionId,
        subMissionId,
        intendedEffort: share,
      });
    },
    reactToCall: async (input) => {
      await transport.request(WS_METHODS.missionsReactToCall, input);
    },
    markMissionSeen: async (input) => {
      await transport.request(WS_METHODS.missionsMarkSeen, input);
    },
    openFork: async ({ missionId, kind, origin, question }) => {
      const asked = question?.trim() ?? "";
      const fork = await transport.request(WS_METHODS.missionsStartFork, {
        missionId,
        kind,
        origin,
        ...(asked.length > 0 ? { question: asked } : {}),
      });
      return { fork, question: fork.question ?? (asked.length > 0 ? asked : null) };
    },
    archiveFork: async ({ forkId }) => {
      await transport.request(WS_METHODS.missionsUpdateFork, { forkId, action: "archive" });
    },

    // --- Inbox ---

    answerAsk: async (input) => {
      await transport.request(WS_METHODS.missionsAnswerAsk, input);
    },
    decideDraft: async (input) => {
      await transport.request(WS_METHODS.missionsDecideDraft, input);
    },
    decideSuggestion: async (input) => {
      await transport.request(WS_METHODS.missionsDecideSuggestion, input);
    },
    decideKnock: async (input) => {
      await transport.request(WS_METHODS.missionsDecideKnock, input);
    },
    decideApproval: async (input) => {
      await transport.request(WS_METHODS.missionsDecideApproval, input);
    },
    addDraftNote: ({ missionId, scope, text }) =>
      transport.request(WS_METHODS.missionsSaveDraftNote, { missionId, scope, text: text.trim() }),
    setDraftNoteActive: async (input) => {
      await transport.request(ASKS.setDraftNoteActive, input);
    },
    ackNote: async (input) => {
      await transport.request(WS_METHODS.missionsAckNote, input);
    },

    // --- Rooms and rules ---

    postRoomMessage: async (input) => {
      const message = await transport.request(WS_METHODS.missionsPostMessage, input);
      touchRoom(input.roomId);
      return message;
    },
    markRoomRead: async (input) => {
      await transport.request(WS_METHODS.missionsMarkRead, input);
      touchRoom(input.roomId);
    },
    upsertRule: (input) => transport.request(WS_METHODS.missionsUpsertRule, input),
    resolveRuleChange: async (input) => {
      await transport.request(WS_METHODS.missionsResolveRuleChange, input);
    },

    // --- Routing ---

    setApprovalRouting: async (input) => {
      await transport.request(WS_METHODS.missionsSetApprovalRouting, input);
      return {
        missionId: input.missionId,
        routes: input.routes,
        updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now())),
        changes: [],
      };
    },
    rerouteRecord: async ({ kind, id, approver, reason }) => {
      if (kind === "draft") {
        await transport.request(ASKS.routeDraft, { draftId: id as DraftId, approver, reason });
        return;
      }
      await transport.request(WS_METHODS.missionsRouteApproval, {
        approvalId: id as ApprovalId,
        approver,
        reason,
      });
    },

    // --- Lanes ---

    nudgeLane: () => notOnServer("Nudging a lane"),
    handOffLane: () => notOnServer("Handing off a lane"),
    setLaneParked: async ({ missionId, laneId, parked, reason }) => {
      await transport.request(WS_METHODS.missionsUpsertLane, {
        missionId,
        laneId,
        status: parked ? "parked" : "idle",
        statusReason: parked ? reason?.trim() || null : null,
      });
    },
    moveLane: async ({ missionId, laneId, subMissionId }) => {
      await transport.request(WS_METHODS.missionsUpsertLane, { missionId, laneId, subMissionId });
    },
    splitLane: async (input) => {
      await transport.request(WS_METHODS.missionsSplitLane, input);
    },
    mergeLanes: async (input) => {
      await transport.request(WS_METHODS.missionsMergeLanes, input);
    },

    // --- Policy ---

    setRoleModel: async (input) => {
      await transport.request(POLICY.setRoleModel, input);
      bus.emit("roles");
    },
    setCriticalityGuide: async (input) => {
      await transport.request(POLICY.setCriticalityGuide, input);
      bus.emit(`review:${input.missionId}`);
    },
    setPoolCapacity: async ({ poolId, capacity }) => {
      await transport.request(POLICY.setPoolCapacity, { poolId, capacity });
      bus.emit("pools");
    },
    // core r6 adds the owner's setPortfolioOrder; the live missions can't be reordered before it.
    setPortfolioOrder: () => notOnServer("Reordering missions"),

    subscribeViews(missionId, listener) {
      let snapshot: MissionViewsSnapshot | null | undefined;
      let events: ReadonlyArray<MissionEvent> = [];
      const state = memoLast(
        (current: MissionViewsSnapshot, log: ReadonlyArray<MissionEvent>): MissionViewsState => ({
          snapshot: current,
          changes: viewChangesOf(log),
        }),
      );
      const push = () => {
        if (snapshot === undefined) return;
        listener(snapshot === null ? null : state(snapshot, events));
      };
      const stopViews = transport.stream(
        VIEWS.subscribe,
        { missionId },
        (item) => {
          if (item._tag === "snapshot") {
            snapshot = item.snapshot;
          } else if (snapshot) {
            snapshot = {
              ...snapshot,
              ownerWaiting: item.ownerWaiting,
              requestsUnread: item.requestsUnread,
              pinnedStrip: item.pinnedStrip,
              pinned: item.pinned,
            };
          }
          push();
        },
        (error) => {
          if (snapshot !== undefined) return;
          // A server without the views track still shows the starter layout.
          snapshot = isNotFound(error) ? null : starterViews(missionId);
          push();
        },
      );
      const stopFeed = missionFeed(missionId, (feed) => {
        events = feed.events;
        push();
      });
      return () => {
        stopViews();
        stopFeed();
      };
    },
    changeView: async (request) => {
      switch (request.method) {
        case "editLayout":
          await transport.request(VIEWS.editLayout, request.input);
          return;
        case "remove":
          await transport.request(VIEWS.remove, request.input);
          return;
        case "restore":
          await transport.request(VIEWS.restore, request.input);
          return;
      }
    },

    // --- Owner requests ---

    subscribeRequests: (missionId, listener) => requestsFeed(missionId, listener),
    subscribeRequest: ({ missionId, requestId }, listener) =>
      requestThreadFeed(`${missionId}\n${requestId}`, listener),
    openRequest: async ({ missionId, text, subject }) => {
      // Router r5 adds `subject` (one open request per record); until then the
      // server drops it and Discuss opens a plain request.
      const input: { missionId: MissionId; text: string; subject?: MissionRecordRef } = {
        missionId,
        text: text.trim(),
        ...(subject === undefined ? {} : { subject }),
      };
      const request = await transport.request(WS_METHODS.missionsOpenOwnerRequest, input);
      touchRequest(request);
      return ownerRequestOf(request);
    },
    replyRequest: async ({ requestId, text }) => {
      touchRequest(
        await transport.request(WS_METHODS.missionsReplyOwnerRequest, {
          requestId: requestId as OwnerRequestId,
          text: text.trim(),
        }),
      );
    },
    settleRequest: async ({ requestId, note }) => {
      touchRequest(
        await transport.request(WS_METHODS.missionsSettleOwnerRequest, {
          requestId: requestId as OwnerRequestId,
          ...noteOf(note),
        }),
      );
    },
    reopenRequest: async ({ requestId, note }) => {
      touchRequest(
        await transport.request(WS_METHODS.missionsReopenOwnerRequest, {
          requestId: requestId as OwnerRequestId,
          ...noteOf(note),
        }),
      );
    },
    markRequestRead: async ({ requestId }) => {
      // Reading up to the newest message clears the request's unread mark.
      const read = requestReads.get(requestId);
      if (read === undefined) return;
      await transport.request(WS_METHODS.missionsMarkRead, read);
    },
  };
}

type MissionsRoles = EnvironmentRpcSuccess<typeof POLICY.roles>;
type MissionsReviewPolicy = EnvironmentRpcSuccess<typeof POLICY.reviewPolicy>;
