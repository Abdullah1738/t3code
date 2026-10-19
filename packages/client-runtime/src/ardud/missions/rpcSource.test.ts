import {
  MISSIONS_ASKS_WS_METHODS as ASKS,
  MISSIONS_POLICY_WS_METHODS as POLICY,
  MISSIONS_VIEWS_WS_METHODS as VIEWS,
  DEFAULT_STARTER_LAYOUT,
  MissionError,
  WS_METHODS,
  type Lane,
  type MissionEvent,
  type MissionId,
  type MissionOverview,
  type PoolView,
  type RoomId,
  type RoomPage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import { createRpcMissionsSource, poolUsageOf, type MissionsTransport } from "./rpcSource.ts";
import type {
  MissionOverviewSnapshot,
  MissionRoomEntry,
  MissionViewsState,
  OwnerRequest,
  PortfolioSnapshot,
} from "./source.ts";
import { viewSectionRequest } from "./views/layout.ts";

const CRPKO = "crpko-engineering" as MissionId;
const LIVE = "live-only-mission" as MissionId;
const ROOM = "room-live" as RoomId;
const now = () => Date.parse(FIXTURE_NOW) + 60_000;

interface OpenStream {
  readonly tag: string;
  readonly input: unknown;
  readonly push: (value: unknown) => void;
  readonly fail: (error: unknown) => void;
  closed: boolean;
}

/** A transport the test drives: streams are pushed by hand, requests answered by `handlers`. */
function fakeTransport(handlers: Record<string, (input: never) => unknown> = {}) {
  const streams: OpenStream[] = [];
  const requests: Array<{ readonly tag: string; readonly input: unknown }> = [];
  const transport: MissionsTransport = {
    stream(tag, input, onValue, onError) {
      const open: OpenStream = {
        tag,
        input,
        push: (value) => onValue(value as never),
        fail: (error) => onError?.(error),
        closed: false,
      };
      streams.push(open);
      return () => {
        open.closed = true;
      };
    },
    request(tag, input) {
      requests.push({ tag, input });
      const handler = handlers[tag];
      if (handler === undefined) {
        return Promise.reject(new MissionError({ code: "not-found", detail: tag })) as never;
      }
      return Promise.resolve().then(() => handler(input as never)) as never;
    },
  };
  const live = (tag: string) => streams.filter((stream) => stream.tag === tag && !stream.closed);
  const asked = (tag: string) => requests.filter((request) => request.tag === tag);
  return { transport, live, asked };
}

/** Lets the fake transport's promise chains finish. */
async function settle() {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

function collect<T>(subscribe: (listener: (value: T) => void) => () => void) {
  const seen: T[] = [];
  const close = subscribe((value) => seen.push(value));
  return { seen, close, last: () => seen.at(-1) };
}

const fixture = () => createFixtureMissionsSource({ now });

function fixtureOverview(): MissionOverview {
  const seen = collect<MissionOverviewSnapshot | null>((listener) =>
    fixture().subscribeOverview(CRPKO, listener),
  );
  const overview = seen.last();
  if (overview == null) throw new Error("fixture has no overview");
  return overview;
}

let seq = 1000;
function event(
  kind: string,
  subject: { readonly kind: string; readonly id: string } | null,
  payload: unknown = null,
): MissionEvent {
  seq += 1;
  return {
    id: `ev-test-${seq}`,
    missionId: CRPKO,
    seq,
    kind,
    actor: { _tag: "owner" },
    provenance: { _tag: "owner-app", surface: "web", sessionId: null },
    summary: kind,
    subject,
    causedBy: null,
    payload,
    at: "2026-10-18T10:00:00.000Z",
  } as unknown as MissionEvent;
}

const pool = (fields: {
  readonly kind: "lease" | "budget" | "observed";
  readonly capacity: number;
  readonly used?: number;
  readonly unit?: string;
  readonly inUse?: number;
  readonly holds?: ReadonlyArray<unknown>;
}) =>
  ({
    pool: {
      id: `pool-${fields.kind}`,
      name: `Pool ${fields.kind}`,
      unit: fields.unit ?? "slot",
      capacity: fields.capacity,
      kind: fields.kind,
      usage: {
        used: fields.used ?? 0,
        window: null,
        resetsAt: null,
        runOutAt: null,
        sampledAt: "2026-10-18T09:00:00.000Z",
      },
    },
    holds: fields.holds ?? [],
    inUse: fields.inUse ?? 0,
    pressure: "ok",
    pressureReason: null,
    sourceConfigured: true,
  }) as unknown as PoolView;

describe("rpc missions source", () => {
  it("fills feeds without an RPC from the fixture and says which", () => {
    const { transport } = fakeTransport();
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });
    expect([...source.sampled].sort()).toEqual([
      "portfolio",
      "recovery",
      "suggestion-stats",
      "timeline",
      "work",
    ]);
    // A mission the fixture does not know reads the fixture's first mission.
    const work = collect<{ readonly missionId: MissionId }>((listener) =>
      source.subscribeWork(LIVE, listener),
    );
    expect(work.last()?.missionId).toBe(CRPKO);
    const own = collect<{ readonly missionId: MissionId }>((listener) =>
      source.subscribeWork(CRPKO, listener),
    );
    expect(own.last()?.missionId).toBe(CRPKO);
  });

  it("shares one mission stream between overview and lanes and folds lane and event deltas", async () => {
    const overview = fixtureOverview();
    const lanes = collect<ReadonlyArray<Lane>>((listener) =>
      fixture().subscribeLanes(CRPKO, listener),
    );
    const lane = lanes.last()?.[0];
    if (lane === undefined) throw new Error("fixture has no lanes");
    const { transport, live } = fakeTransport({
      [POLICY.pools]: () => ({
        pools: [pool({ kind: "budget", capacity: 200, used: 50, unit: "USD" })],
        at: "2026-10-18T09:00:00.000Z",
      }),
    });
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });

    const overviews = collect<MissionOverviewSnapshot | null>((listener) =>
      source.subscribeOverview(CRPKO, listener),
    );
    const laneLists = collect<ReadonlyArray<Lane>>((listener) =>
      source.subscribeLanes(CRPKO, listener),
    );
    expect(live(WS_METHODS.missionsSubscribe)).toHaveLength(1);
    expect(overviews.seen).toEqual([]);

    const [stream] = live(WS_METHODS.missionsSubscribe);
    stream?.push({ _tag: "overview", seq: 1, overview });
    stream?.push({
      _tag: "upsert",
      missionId: CRPKO,
      seq: 2,
      record: { _tag: "lane", record: lane },
    });
    await settle();
    expect(laneLists.last()?.map((each) => each.id)).toEqual([lane.id]);
    expect(overviews.last()?.poolUsage).toEqual([
      expect.objectContaining({ _tag: "budget", spent: 50, cap: 200, currency: "USD" }),
    ]);

    const renamed = event(
      "mission.updated",
      { kind: "mission", id: CRPKO },
      { changed: ["title"] },
    );
    stream?.push({
      _tag: "upsert",
      missionId: CRPKO,
      seq: 3,
      record: { _tag: "event", record: renamed },
    });
    // The same event twice is one change.
    stream?.push({
      _tag: "upsert",
      missionId: CRPKO,
      seq: 3,
      record: { _tag: "event", record: renamed },
    });
    expect(overviews.last()?.changes).toEqual([
      expect.objectContaining({
        field: "title",
        eventId: renamed.id,
        ref: { kind: "mission", id: CRPKO },
      }),
    ]);

    stream?.push({ _tag: "remove", missionId: CRPKO, seq: 4, ref: { kind: "lane", id: lane.id } });
    expect(laneLists.last()).toEqual([]);

    overviews.close();
    expect(live(WS_METHODS.missionsSubscribe)).toHaveLength(1);
    laneLists.close();
    expect(live(WS_METHODS.missionsSubscribe)).toHaveLength(0);
  });

  it("reports a mission the server does not have as missing", () => {
    const { transport, live } = fakeTransport();
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });
    const overviews = collect<MissionOverviewSnapshot | null>((listener) =>
      source.subscribeOverview(LIVE, listener),
    );
    live(WS_METHODS.missionsSubscribe)[0]?.fail(
      new MissionError({ code: "not-found", detail: "gone" }),
    );
    expect(overviews.seen).toEqual([null]);
  });

  it("refetches request-backed feeds on matching events after the first read", async () => {
    let reads = 0;
    const { transport, live } = fakeTransport({
      [POLICY.roles]: () => {
        reads += 1;
        return { missionId: CRPKO, roles: [], defaults: [], bindings: [], drift: [] };
      },
    });
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });
    const roles = collect<unknown>((listener) => source.subscribeRoles(CRPKO, listener));
    await settle();
    expect(reads).toBe(1);

    const [stream] = live(WS_METHODS.missionsSubscribe);
    stream?.push({ _tag: "overview", seq: 1, overview: fixtureOverview() });
    stream?.push({
      _tag: "upsert",
      missionId: CRPKO,
      seq: 2,
      record: { _tag: "event", record: event("lane.parked", { kind: "lane", id: "lane-a" }) },
    });
    await settle();
    expect(reads).toBe(1);

    stream?.push({
      _tag: "upsert",
      missionId: CRPKO,
      seq: 3,
      record: {
        _tag: "event",
        record: event("role.model-changed", { kind: "role", id: "role-a" }),
      },
    });
    await settle();
    expect(reads).toBe(2);
    expect(roles.seen.length).toBeGreaterThanOrEqual(2);
  });

  it("counts unread room messages from others and recounts after the owner reads", async () => {
    let readSeq = 1;
    const room = { id: ROOM, missionId: CRPKO, lastSeq: 3, archived: false };
    const page = (): RoomPage =>
      ({
        room,
        messages: [
          { seq: 1, author: { _tag: "role", roleId: "role-a" } },
          { seq: 2, author: { _tag: "owner" } },
          { seq: 3, author: { _tag: "role", roleId: "role-a" } },
        ],
        subscriptions: [],
        ownerReadSeq: readSeq,
        hasOlder: false,
      }) as unknown as RoomPage;
    const { transport, asked } = fakeTransport({
      [WS_METHODS.missionsRooms]: () => [room],
      [WS_METHODS.missionsRoomPage]: () => page(),
      [WS_METHODS.missionsMarkRead]: (input: { readonly seq: number }) => {
        readSeq = input.seq;
        return { roomId: ROOM, seq: input.seq };
      },
    });
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });
    const rooms = collect<ReadonlyArray<MissionRoomEntry>>((listener) =>
      source.subscribeRooms(CRPKO, listener),
    );
    await settle();
    expect(rooms.last()?.map((entry) => entry.unread)).toEqual([1]);

    // Same room, same newest message: no second page read.
    const pagesBefore = asked(WS_METHODS.missionsRoomPage).length;
    await source.markRoomRead({ roomId: ROOM, seq: 3 });
    await settle();
    expect(asked(WS_METHODS.missionsRoomPage).length).toBe(pagesBefore + 1);
    expect(rooms.last()?.map((entry) => entry.unread)).toEqual([0]);
  });

  it("builds the portfolio from the live missions until the server serves it", async () => {
    const overview = fixtureOverview();
    const { transport, live } = fakeTransport();
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });
    const portfolio = collect<PortfolioSnapshot>((listener) => source.subscribePortfolio(listener));

    const [list] = live(WS_METHODS.missionsSubscribeList);
    list?.push({
      _tag: "list",
      snapshot: {
        revision: 1,
        missions: [
          { id: CRPKO, status: "active" },
          { id: LIVE, status: "archived" },
        ],
      },
    });
    // Waits for every live mission's overview; archived missions are left out.
    expect(live(WS_METHODS.missionsSubscribe).map((stream) => stream.input)).toEqual([
      { missionId: CRPKO },
    ]);
    expect(portfolio.seen).toEqual([]);

    live(WS_METHODS.missionsSubscribe)[0]?.push({
      _tag: "overview",
      seq: 1,
      overview: { ...overview, usageShare: 0.5 },
    });
    const snapshot = portfolio.last();
    expect(snapshot?.order).toEqual([CRPKO]);
    expect(snapshot?.missions[0]).toMatchObject({
      missionId: CRPKO,
      title: overview.mission.title,
      guaranteedShare: overview.mission.guaranteedShare,
      usedShare: 0.5 * overview.mission.guaranteedShare,
      pools: [],
    });
    await expect(source.setPortfolioOrder({ order: [CRPKO] })).rejects.toBeInstanceOf(MissionError);

    portfolio.close();
    expect(live(WS_METHODS.missionsSubscribeList)).toHaveLength(0);
    expect(live(WS_METHODS.missionsSubscribe)).toHaveLength(0);
  });

  it("takes unread counts from the room list when the router sends them", async () => {
    const room = { id: ROOM, missionId: CRPKO, lastSeq: 400, archived: false, unreadForOwner: 312 };
    const { transport, asked } = fakeTransport({
      [WS_METHODS.missionsRooms]: () => [room],
    });
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });
    const rooms = collect<ReadonlyArray<MissionRoomEntry>>((listener) =>
      source.subscribeRooms(CRPKO, listener),
    );
    await settle();
    expect(rooms.last()?.map((entry) => entry.unread)).toEqual([312]);
    expect(asked(WS_METHODS.missionsRoomPage)).toHaveLength(0);
  });

  it("reads owner requests live, marks them read at the newest seq and refetches after a reply", async () => {
    const REQUEST_ROOM = `${CRPKO}:room:request:request-1` as RoomId;
    let unread = true;
    let replies = 0;
    const record = () => ({
      id: "request-1",
      missionId: CRPKO,
      subMissionId: null,
      title: "Park the e2e lane",
      status: unread ? "answered" : "waiting-on-master",
      roomId: REQUEST_ROOM,
      createdBy: { _tag: "owner" },
      lastOwnerAt: "2026-10-18T09:00:00.000Z",
      lastMasterAt: "2026-10-18T09:05:00.000Z",
      links: [{ kind: "work-item", id: "w-1", label: "e2e lane" }],
      unreadForOwner: unread,
      settledBy: null,
      settledAt: null,
      createdAt: "2026-10-18T09:00:00.000Z",
      updatedAt: "2026-10-18T09:05:00.000Z",
      subject: { kind: "ask", id: "ask-1", label: "Kafka capacity" },
    });
    const message = (seq: number, author: unknown, summary: string) => ({
      message: {
        id: `m-${seq}`,
        seq,
        author,
        summary,
        links: [],
        createdAt: `2026-10-18T09:0${seq}:00.000Z`,
      },
      body: null,
    });
    const view = () => ({
      request: record(),
      messages: [
        message(1, { _tag: "owner" }, "Park the e2e lane"),
        message(4, { _tag: "role", roleId: "master" }, "Parked."),
        ...Array.from({ length: replies }, (_, index) =>
          message(5 + index, { _tag: "owner" }, "Thanks"),
        ),
      ],
      hasOlder: false,
      unreadForOwner: unread,
    });
    const { transport, asked } = fakeTransport({
      [WS_METHODS.missionsOwnerRequests]: () => ({ missionId: CRPKO, requests: [view()] }),
      [WS_METHODS.missionsMarkRead]: (input: { readonly seq: number }) => {
        unread = false;
        return { roomId: REQUEST_ROOM, seq: input.seq };
      },
      [WS_METHODS.missionsReplyOwnerRequest]: () => {
        replies += 1;
        return record();
      },
      [WS_METHODS.missionsOpenOwnerRequest]: () => record(),
      [WS_METHODS.missionsSettleOwnerRequest]: () => record(),
      [WS_METHODS.missionsReopenOwnerRequest]: () => record(),
    });
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });
    const requests = collect<ReadonlyArray<OwnerRequest>>((listener) =>
      source.subscribeRequests(CRPKO, listener),
    );
    await settle();
    expect(requests.last()?.[0]).toMatchObject({
      id: "request-1",
      status: "answered",
      unread: true,
      links: [{ kind: "work-item", id: "w-1" }],
      subject: { kind: "ask", id: "ask-1" },
    });
    expect(requests.last()?.[0]?.messages.map((m) => [m.author, m.text])).toEqual([
      ["owner", "Park the e2e lane"],
      ["master", "Parked."],
    ]);

    await source.markRequestRead({ requestId: "request-1" });
    expect(asked(WS_METHODS.missionsMarkRead).map((call) => call.input)).toEqual([
      { roomId: REQUEST_ROOM, seq: 4 },
    ]);

    await source.replyRequest({ requestId: "request-1", text: "  Thanks  " });
    await settle();
    expect(asked(WS_METHODS.missionsReplyOwnerRequest).map((call) => call.input)).toEqual([
      { requestId: "request-1", text: "Thanks" },
    ]);
    expect(requests.last()?.[0]?.messages).toHaveLength(3);
    expect(requests.last()?.[0]?.unread).toBe(false);

    await source.openRequest({
      missionId: CRPKO,
      text: "Why?",
      subject: { kind: "ask", id: "ask-1" } as never,
    });
    expect(asked(WS_METHODS.missionsOpenOwnerRequest).at(-1)?.input).toEqual({
      missionId: CRPKO,
      text: "Why?",
      subject: { kind: "ask", id: "ask-1" },
    });

    // The settle note is the owner's closing words; a blank one stays off the wire.
    await source.settleRequest({ requestId: "request-1", note: "  Ship it Friday  " });
    await source.settleRequest({ requestId: "request-1", note: "   " });
    await source.reopenRequest({ requestId: "request-1", note: "One more thing" });
    await source.reopenRequest({ requestId: "request-1" });
    expect(asked(WS_METHODS.missionsSettleOwnerRequest).map((call) => call.input)).toEqual([
      { requestId: "request-1", note: "Ship it Friday" },
      { requestId: "request-1" },
    ]);
    expect(asked(WS_METHODS.missionsReopenOwnerRequest).map((call) => call.input)).toEqual([
      { requestId: "request-1", note: "One more thing" },
      { requestId: "request-1" },
    ]);
  });

  it("maps owner actions onto the server's RPCs", async () => {
    const fork = { id: "fork-1", missionId: CRPKO, question: null };
    const { transport, asked } = fakeTransport({
      [WS_METHODS.missionsSetStatus]: () => ({ seq: 1 }),
      [WS_METHODS.missionsUpsertLane]: () => ({ seq: 1 }),
      [WS_METHODS.missionsUpsertSubMission]: () => ({ seq: 1 }),
      [WS_METHODS.missionsReactToCall]: () => ({ id: "call-1", missionId: CRPKO }),
      [WS_METHODS.missionsStartFork]: () => fork,
      [WS_METHODS.missionsUpdateFork]: () => fork,
      [ASKS.routeDraft]: () => ({}),
      [WS_METHODS.missionsRouteApproval]: () => ({ seq: 1 }),
    });
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });

    await source.setMissionPaused({ missionId: CRPKO, paused: true });
    expect(asked(WS_METHODS.missionsSetStatus).at(-1)?.input).toEqual({
      missionId: CRPKO,
      status: "paused",
    });

    await source.setLaneParked({
      missionId: CRPKO,
      laneId: "lane-a" as Lane["id"],
      parked: true,
      reason: "  waiting on Dylan  ",
    });
    await source.setLaneParked({ missionId: CRPKO, laneId: "lane-a" as Lane["id"], parked: false });
    expect(asked(WS_METHODS.missionsUpsertLane).map((request) => request.input)).toEqual([
      { missionId: CRPKO, laneId: "lane-a", status: "parked", statusReason: "waiting on Dylan" },
      { missionId: CRPKO, laneId: "lane-a", status: "idle", statusReason: null },
    ]);

    await source.reactToCall({ callId: "call-1" as never, reaction: "ok" });
    expect(asked(WS_METHODS.missionsStartFork)).toHaveLength(0);
    // Discuss is an owner request about the call now, never a fork.
    await source.reactToCall({ callId: "call-1" as never, reaction: "discuss" });
    expect(asked(WS_METHODS.missionsReactToCall)).toHaveLength(2);
    expect(asked(WS_METHODS.missionsStartFork)).toHaveLength(0);

    const opened = await source.openFork({
      missionId: CRPKO,
      kind: "owner-question",
      origin: null,
      question: "  Why the rebase?  ",
    });
    expect(asked(WS_METHODS.missionsStartFork).at(-1)?.input).toEqual({
      missionId: CRPKO,
      kind: "owner-question",
      origin: null,
      question: "Why the rebase?",
    });
    expect(opened.question).toBe("Why the rebase?");

    await source.rerouteRecord({
      kind: "draft",
      id: "draft-1",
      approver: "master",
      reason: "routine",
    });
    await source.rerouteRecord({
      kind: "approval",
      id: "approval-1",
      approver: "owner",
      reason: "mine",
    });
    expect(asked(ASKS.routeDraft).at(-1)?.input).toEqual({
      draftId: "draft-1",
      approver: "master",
      reason: "routine",
    });
    expect(asked(WS_METHODS.missionsRouteApproval).at(-1)?.input).toEqual({
      approvalId: "approval-1",
      approver: "owner",
      reason: "mine",
    });

    await expect(
      source.nudgeLane({ laneId: "lane-a" as Lane["id"], note: "go" }),
    ).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("reads the views record live, logs view events and sends section changes", async () => {
    const { transport, live, asked } = fakeTransport({
      [VIEWS.editLayout]: () => ({ ok: true }),
    });
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });
    const views = collect<MissionViewsState | null>((listener) =>
      source.subscribeViews(CRPKO, listener),
    );
    const snapshot = {
      missionId: CRPKO,
      catalogVersion: 1,
      revision: 3,
      templates: [],
      sections: [],
      layout: {
        missionId: CRPKO,
        layout: DEFAULT_STARTER_LAYOUT.layout,
        version: 4,
        changedBy: { _tag: "owner" },
        by: "owner",
        changedAt: "2026-10-18T09:00:00.000Z",
        changeNote: null,
        seededFrom: 1,
      },
      starter: DEFAULT_STARTER_LAYOUT,
      ownerWaiting: 2,
      requestsUnread: 0,
      pinnedStrip: false,
      pinned: { needsYou: false, requests: false },
      changesToday: 0,
    };
    live(VIEWS.subscribe)[0]?.push({ _tag: "snapshot", snapshot });
    live(WS_METHODS.missionsSubscribe)[0]?.push({
      _tag: "upsert",
      record: {
        _tag: "event",
        record: {
          ...event("view.layout-changed", { kind: "view-layout", id: CRPKO }),
          summary: "The owner hid With the master",
        },
      },
    });
    live(VIEWS.subscribe)[0]?.push({
      _tag: "waiting",
      missionId: CRPKO,
      ownerWaiting: 5,
      requestsUnread: 1,
      pinnedStrip: false,
      pinned: { needsYou: false, requests: false },
    });
    const state = views.last();
    expect(state?.snapshot.layout.version).toBe(4);
    expect(state?.snapshot.ownerWaiting).toBe(5);
    expect(state?.changes.map((change) => [change.by, change.summary])).toEqual([
      ["owner", "The owner hid With the master"],
    ]);

    const request = viewSectionRequest(state!.snapshot, "with-the-master", { type: "hide" });
    await source.changeView(request!);
    expect(asked(VIEWS.editLayout)[0]?.input).toEqual({
      missionId: CRPKO,
      ops: [{ _tag: "hide", key: "with-the-master" }],
      expectedVersion: 4,
    });
  });

  it("shows the starter layout when the server has no views track", () => {
    const { transport, live } = fakeTransport();
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });
    const views = collect<MissionViewsState | null>((listener) =>
      source.subscribeViews(LIVE, listener),
    );
    live(VIEWS.subscribe)[0]?.fail(new Error("unknown method"));
    expect(views.last()?.snapshot.layout.layout).toBe(DEFAULT_STARTER_LAYOUT.layout);
    const gone = collect<MissionViewsState | null>((listener) =>
      source.subscribeViews("gone" as MissionId, listener),
    );
    live(VIEWS.subscribe)
      .find((stream) => (stream.input as { missionId: string }).missionId === "gone")
      ?.fail(new MissionError({ code: "not-found", detail: "gone" }));
    expect(gone.seen).toEqual([null]);
  });

  it("keeps master counts at zero and has no all-missions fork list", () => {
    const { transport, live } = fakeTransport();
    const source = createRpcMissionsSource({ transport, fallback: fixture(), now });
    const inbox = collect<{ readonly masterCounts: unknown }>((listener) =>
      source.subscribeInbox(null, listener),
    );
    live(WS_METHODS.missionsInbox)[0]?.push({
      revision: 1,
      counts: { decide: 0, approve: 0, knocks: 0, suggestions: 0, fyi: 0 },
      asks: [],
      drafts: [],
      approvals: [],
      knocks: [],
      suggestions: [],
      fyi: [],
    });
    expect(inbox.last()?.masterCounts).toEqual({ approve: 0, suggestions: 0 });

    const forks = collect<ReadonlyArray<unknown>>((listener) =>
      source.subscribeForks(null, listener),
    );
    expect(forks.seen).toEqual([[]]);
    expect(live(ASKS.subscribeForks)).toHaveLength(0);
  });
});

describe("poolUsageOf", () => {
  it("reads budgets, single-holder leases and shared pools", () => {
    expect(
      poolUsageOf(pool({ kind: "budget", capacity: 300, used: 120, unit: "USD" })),
    ).toMatchObject({
      _tag: "budget",
      spent: 120,
      cap: 300,
      currency: "USD",
    });
    expect(
      poolUsageOf(
        pool({
          kind: "lease",
          capacity: 1,
          inUse: 1,
          holds: [
            {
              status: "active",
              holder: { _tag: "lane", laneId: "lane-devops" },
              takenAt: "2026-10-18T08:00:00.000Z",
            },
          ],
        }),
      ),
    ).toMatchObject({ _tag: "lock", holder: "lane-devops", since: "2026-10-18T08:00:00.000Z" });
    expect(poolUsageOf(pool({ kind: "lease", capacity: 1 }))).toMatchObject({
      _tag: "lock",
      holder: null,
    });
    expect(poolUsageOf(pool({ kind: "lease", capacity: 4, inUse: 3 }))).toMatchObject({
      _tag: "accounts",
      usable: 1,
      total: 4,
    });
    expect(poolUsageOf(pool({ kind: "observed", capacity: 100, used: 140 }))).toMatchObject({
      _tag: "accounts",
      usable: 0,
      total: 100,
    });
  });
});
