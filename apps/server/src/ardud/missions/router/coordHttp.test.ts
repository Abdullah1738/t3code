import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  MissionId,
  RoleId,
  RoomId,
  SubscriptionId,
  ThreadId,
  type MissionActor,
  type Room,
  type Subscription,
  type SubscriptionMode,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { HttpServerRequest } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import {
  agent,
  at,
  binding,
  failureCode,
  mission,
  ownerApp,
  role,
} from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { routerImportSink } from "./adapters.ts";
import { COORD_SHIM_PREFIX, coordShimRouteLayer } from "./coordHttp.ts";
import * as CoordShim from "./coordShim.ts";
import forward from "./fixtures/coord-forward.json" with { type: "json" };
import * as MissionRouter from "./MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "./MissionRouter.testkit.ts";
import { actorKey } from "./model.ts";
import * as RouterStore from "./RouterStore.ts";

/**
 * coord's forward mode against the real shim routes. The fixture is what
 * coord's own messaging script sent to (and got back from) coord's fake
 * shim, recorded with `integrations/coord`'s `post`/`inbox`/`ack` in robob
 * mode; replaying it here keeps both sides on one contract.
 */

const crpko = MissionId.make("crpko");
const T = {
  master: ThreadId.make("T-master"),
  a: ThreadId.make("T-a"),
  b: ThreadId.make("T-b"),
};
const roleOf = (name: string) =>
  name === "master"
    ? RoleId.make("crpko:master")
    : RoleId.make(`crpko:lane-lead:crpko:lane:${name}`);
const asRole = (name: string): MissionActor => ({ _tag: "role", roleId: roleOf(name) });
const crw: MissionActor = { _tag: "system", component: "crw" };

const seedCrpko = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const rooms = yield* RouterStore.RouterStore;
  const crpkoRole = (name: string) => ({
    ...role(roleOf(name), name === "master" ? "master" : "lane-lead"),
    missionId: crpko,
  });
  yield* store.commit({
    event: {
      missionId: crpko,
      kind: "mission.created",
      actor: { _tag: "system", component: "test" },
      provenance: { _tag: "system", component: "test" },
      summary: "seed",
      subject: null,
    },
    upserts: [
      {
        _tag: "mission",
        record: { ...mission, id: crpko, slug: "crpko", masterRoleId: roleOf("master") },
      },
      { _tag: "role", record: crpkoRole("master") },
      { _tag: "role", record: crpkoRole("cell-a") },
      { _tag: "role", record: crpkoRole("cell-b") },
      { _tag: "role-binding", record: binding("crpko-b-master", roleOf("master"), T.master) },
      { _tag: "role-binding", record: binding("crpko-b-a", roleOf("cell-a"), T.a) },
      { _tag: "role-binding", record: binding("crpko-b-b", roleOf("cell-b"), T.b) },
    ],
    alongside: Effect.gen(function* () {
      const room = (channel: string, kind: Room["kind"]): Room => ({
        id: RoomId.make(`crpko:room:${channel}`),
        missionId: crpko,
        subMissionId: null,
        kind,
        title: channel,
        workItemId: null,
        archived: false,
        lastSeq: 0,
        lastMessageAt: null,
        noise: null,
        createdAt: at,
      });
      const sub = (channel: string, subscriber: MissionActor, mode: SubscriptionMode) => {
        const value: Subscription = {
          id: SubscriptionId.make(`crpko:room:${channel}:sub:${actorKey(subscriber)}`),
          roomId: RoomId.make(`crpko:room:${channel}`),
          subscriber,
          mode,
          wakeOn: mode === "wake" ? ["request", "blocker", "control"] : [],
          createdAt: at,
        };
        return { subscription: value, key: actorKey(subscriber) };
      };
      yield* rooms.insertMissing({
        rooms: [room("delivery", "custom"), room("control", "control")],
        messages: [],
        subscriptions: [
          sub("delivery", asRole("master"), "wake"),
          sub("delivery", asRole("cell-a"), "wake"),
          sub("delivery", asRole("cell-b"), "read"),
          sub("control", asRole("master"), "wake"),
          sub("control", crw, "read"),
        ],
        readPositions: [],
      });
    }),
  });
  // The owner enrols the coord actors the forward-mode credential may speak for.
  const router = yield* MissionRouter.MissionRouter;
  for (const actor of ["master", "cell-a", "cell-b", "crw"]) {
    yield* enrol(router, actor, ownerApp);
  }
});

const enrol = (
  router: MissionRouter.MissionRouter["Service"],
  actor: string,
  provenance: Parameters<MissionRouter.MissionRouter["Service"]["setMember"]>[1],
  member = true,
) =>
  router.setMember({ missionId: crpko, principal: { _tag: "coord", actor }, member }, provenance);

/**
 * `test-token` is the coord component credential; `broad-token` is an
 * operate token with no component origin (the shared control token);
 * `crw-token` is another component's credential.
 */
const sessions: Record<string, { readonly subject: string; readonly component: string | null }> = {
  "Bearer test-token": { subject: "component:coord", component: "coord" },
  "Bearer broad-token": { subject: "control", component: null },
  "Bearer crw-token": { subject: "component:crw", component: "crw" },
};

const fakeAuth = {
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) => {
    const session = sessions[request.headers.authorization ?? ""];
    return session === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "none" }))
      : Effect.succeed({
          sessionId: AuthSessionId.make(`session-${session.subject}`),
          subject: session.subject,
          method: "bearer-access-token" as const,
          scopes: ["orchestration:read" as const, "orchestration:operate" as const],
          ...(session.component === null
            ? {}
            : { origin: { _tag: "component" as const, component: session.component } }),
        });
  },
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly status: number;
  readonly reply: unknown;
}

const toRequest = (
  entry: Pick<Recorded, "method" | "path" | "query" | "body">,
  token = "test-token",
) => {
  const url = new URL(`http://127.0.0.1${entry.path}`);
  for (const [name, value] of Object.entries(entry.query ?? {})) url.searchParams.set(name, value);
  return new Request(url, {
    method: entry.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(entry.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(entry.body === undefined ? {} : { body: encodeJson(entry.body) }),
  });
};

/** Timestamps differ between coord's fake clock and ours; their types must not. */
const withoutClock = (reply: unknown): unknown => {
  if (typeof reply !== "object" || reply === null) return reply;
  const value = reply as { events?: ReadonlyArray<Record<string, unknown>> };
  if (value.events === undefined) return reply;
  return {
    ...value,
    events: value.events.map(({ created_at, acked_at, ...rest }) => ({
      ...rest,
      created_at: typeof created_at,
      acked_at: acked_at === null ? null : typeof acked_at,
    })),
  };
};

type Handler = (request: Request) => Promise<Response>;

const harness = () => {
  const threads = fakeRouterThreads();
  const services = CoordShim.layer.pipe(
    Layer.provideMerge(routerOverFakes(threads)),
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return { threads, layer: services };
};

const withShim = <A>(use: (handler: Handler) => Promise<A>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<CoordShim.CoordShim>();
    const routes = coordShimRouteLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeedContext(context),
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, fakeAuth),
        ),
      ),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      ({ handler }) => Effect.tryPromise(() => use((input) => handler(input))),
      ({ dispose }) => Effect.promise(dispose),
    );
  });

const call = async (
  handle: Handler,
  entry: Pick<Recorded, "method" | "path" | "query" | "body">,
  token?: string,
) => {
  const response = await handle(toRequest(entry, token));
  return { status: response.status, reply: (await response.json()) as Record<string, any> };
};

const postBody = (fields: Record<string, unknown>) => ({
  mission: "crpko",
  channel: "delivery",
  as: "cell-a",
  kind: "status",
  hash: "h",
  summary: "s",
  to: null,
  work: null,
  env: null,
  rev: null,
  authority: null,
  body: null,
  replyTo: null,
  ...fields,
});
const shimPost = (fields: Record<string, unknown>) => ({
  method: "POST",
  path: `${COORD_SHIM_PREFIX}/post`,
  body: postBody(fields),
});

describe("coord forward shim", () => {
  it.live("answers coord's own forward traffic exactly as coord's fake does", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seedCrpko;
      const replies = yield* withShim(async (handle) => {
        const out: Array<{ status: number; reply: unknown }> = [];
        for (const entry of forward as ReadonlyArray<Recorded>) out.push(await call(handle, entry));
        return out;
      });
      expect(replies).toHaveLength(17);
      const recorded = (forward as ReadonlyArray<Recorded>).map((entry) => ({
        status: entry.status,
        reply: withoutClock(entry.reply),
      }));
      expect(
        replies.map((each) => ({ status: each.status, reply: withoutClock(each.reply) })),
      ).toEqual(recorded);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("rings Robob's doorbell for coord posts, and never the speaker's own thread", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seedCrpko;
      yield* withShim(async (handle) => {
        // cell-a posts a request to the master; the master wakes because it is addressed.
        await call(
          handle,
          shimPost({ key: "r1", kind: "request", to: ["master"], summary: "review?" }),
        );
      });
      expect(h.threads.sent.map((each) => each.threadId)).toEqual([T.master]);
      const router = yield* MissionRouter.MissionRouter;
      const inbox = yield* router.inbox(T.master);
      expect(inbox.entries.map((entry) => entry.message.summary)).toEqual(["review?"]);
      expect(inbox.entries[0]?.message.author).toEqual(asRole("cell-a"));
      expect(inbox.entries[0]?.message.provenance).toEqual({
        _tag: "system",
        component: "coord-shim",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.live("refuses a coord actor with no bound thread, and one the mission doesn't know", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seedCrpko;
      const store = yield* MissionStore.MissionStore;
      // cell-b's binding ends: it still exists as a role but nothing speaks for it.
      yield* store.commit({
        event: {
          missionId: crpko,
          kind: "role.unbound",
          actor: { _tag: "system", component: "test" },
          provenance: { _tag: "system", component: "test" },
          summary: "unbind",
          subject: null,
        },
        upserts: [
          {
            _tag: "role-binding",
            record: { ...binding("crpko-b-b", roleOf("cell-b"), T.b), endedAt: at },
          },
        ],
      });
      // Enrolled, but the mission has no actor by that name.
      yield* enrol(yield* MissionRouter.MissionRouter, "stranger", ownerApp);
      const { unbound, stranger, badToken } = yield* withShim(async (handle) => ({
        unbound: await call(handle, shimPost({ key: "u1", as: "cell-b" })),
        stranger: await call(handle, shimPost({ key: "u2", as: "stranger" })),
        badToken: await handle(toRequest(shimPost({ key: "u3" }), "wrong")).then(
          async (response) => ({
            status: response.status,
            reply: (await response.json()) as Record<string, any>,
          }),
        ),
      }));
      expect(unbound.reply.error.code).toBe("not_bound");
      expect(stranger).toEqual({
        status: 400,
        reply: { ok: false, error: { code: "unknown_actor", message: "no actor stranger" } },
      });
      expect(badToken.status).toBe(401);
      expect(badToken.reply.error.code).toBe("unauthorized");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("continues seqs above imported coord history and acks imported deliveries", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seedCrpko;
      const store = yield* MissionStore.MissionStore;
      const sink = yield* routerImportSink;
      const roomId = RoomId.make("crpko:room:delivery");
      const imported = (seq: number) => ({
        message: {
          id: `crpko:coord:${seq}` as never,
          missionId: crpko,
          roomId,
          seq,
          kind: "request" as const,
          author: asRole("master"),
          provenance: { _tag: "import" as const, source: "coord.db" },
          to: [asRole("cell-a")],
          summary: `old ${seq}`,
          hasBody: false,
          key: `old-${seq}`,
          workItemId: null,
          links: [],
          receipt: null,
          isCorrection: false,
          createdAt: at,
          coord: {
            channel: "delivery",
            sender: "master",
            bodyHash: `hash-${seq}`,
            workId: null,
            environment: null,
            expectedRevision: null,
            authorityRef: null,
            replyTo: null,
          },
        },
        body: null,
      });
      yield* store.commit({
        event: {
          missionId: crpko,
          kind: "import.applied",
          actor: { _tag: "system", component: "coord-import" },
          provenance: { _tag: "import", source: "coord.db" },
          summary: "import",
          subject: null,
        },
        alongside: sink.write({
          rooms: [],
          messages: [imported(40), imported(41)],
          subscriptions: [],
          // cell-a had acked up to 40 in coord.
          readPositions: [{ roomId, reader: asRole("cell-a"), seq: 40, updatedAt: at }],
        }),
      });
      const result = yield* withShim(async (handle) => {
        const posted = await call(handle, shimPost({ key: "n1", as: "master", to: ["cell-a"] }));
        const inbox = await call(handle, {
          method: "GET",
          path: `${COORD_SHIM_PREFIX}/inbox`,
          query: { mission: "crpko", as: "cell-a", unacked: "1", after: "0", limit: "100" },
        });
        const replayKey = await call(
          handle,
          shimPost({ key: "old-41", as: "master", to: ["cell-a"], hash: "hash-41" }),
        );
        return { posted, inbox, replayKey };
      });
      expect(result.posted.reply).toEqual({ ok: true, seq: 42, recipients: ["cell-a"] });
      expect(result.inbox.reply.events.map((row: { seq: number }) => row.seq)).toEqual([41, 42]);
      expect(result.replayKey.reply).toEqual({ ok: true, seq: 41, duplicate: true });
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a Robob post shows in coord's inbox, and reading the room acks it", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seedCrpko;
      const router = yield* MissionRouter.MissionRouter;
      const roomId = RoomId.make("crpko:room:delivery");
      yield* router.post(
        {
          missionId: crpko,
          roomId,
          kind: "request",
          summary: "native ask",
          to: [asRole("cell-a")],
        },
        { _tag: "agent", threadId: T.master, roleId: null },
      );
      const inboxQuery = {
        method: "GET",
        path: `${COORD_SHIM_PREFIX}/inbox`,
        query: { mission: "crpko", as: "cell-a", unacked: "1", after: "0", limit: "100" },
      };
      const before = yield* withShim((handle) => call(handle, inboxQuery));
      yield* router.markRead({ roomId, seq: 1 }, { _tag: "agent", threadId: T.a, roleId: null });
      const after = yield* withShim((handle) => call(handle, inboxQuery));
      expect(before.reply.events).toEqual([
        expect.objectContaining({
          seq: 1,
          channel_id: "delivery",
          sender: "master",
          summary: "native ask",
          delivery: "pending",
        }),
      ]);
      expect(after.reply.events).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
  it.live("only the coord component credential reaches the shim", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seedCrpko;
      const inboxOf = (as: string) => ({
        method: "GET",
        path: `${COORD_SHIM_PREFIX}/inbox`,
        query: { mission: "crpko", as, unacked: "0", after: "0", limit: "100" },
      });
      const ackOf = (as: string) => ({
        method: "POST",
        path: `${COORD_SHIM_PREFIX}/ack`,
        body: { mission: "crpko", as, refs: ["1"] },
      });
      const result = yield* withShim(async (handle) => {
        const out: Record<string, { status: number; reply: Record<string, any> }> = {};
        // A broad operate token tries to speak as a lane to the master, and as the master.
        out.broadAsLane = await call(
          handle,
          shimPost({ key: "x1", kind: "request", to: ["master"] }),
          "broad-token",
        );
        out.broadAsMaster = await call(
          handle,
          shimPost({ key: "x2", as: "master", to: ["cell-a"] }),
          "broad-token",
        );
        out.broadInbox = await call(handle, inboxOf("master"), "broad-token");
        out.broadAck = await call(handle, ackOf("master"), "broad-token");
        // Another component's credential is refused the same way.
        out.crwPost = await call(handle, shimPost({ key: "x3", as: "crw" }), "crw-token");
        out.crwInbox = await call(handle, inboxOf("crw"), "crw-token");
        return out;
      });
      for (const each of Object.values(result)) {
        expect(each.status).toBe(403);
        expect(each.reply.error.code).toBe("forbidden");
      }
      // Nothing was posted or rung.
      expect(h.threads.sent).toEqual([]);
      const router = yield* MissionRouter.MissionRouter;
      expect((yield* router.inbox(T.master)).entries).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.live(
    "coord speaks only for actors enrolled to it, and only the owner or master enrols",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        yield* seedCrpko;
        const router = yield* MissionRouter.MissionRouter;
        const masterAgent = agent(T.master);
        // The master drops cell-b's enrolment; a lane cannot add it back.
        yield* enrol(router, "cell-b", masterAgent, false);
        const laneTries = yield* failureCode(enrol(router, "cell-b", agent(T.a)));
        const refused = yield* withShim(async (handle) => ({
          post: await call(handle, shimPost({ key: "e1", as: "cell-b", to: ["master"] })),
          inbox: await call(handle, {
            method: "GET",
            path: `${COORD_SHIM_PREFIX}/inbox`,
            query: { mission: "crpko", as: "cell-b", unacked: "0", after: "0", limit: "100" },
          }),
          ack: await call(handle, {
            method: "POST",
            path: `${COORD_SHIM_PREFIX}/ack`,
            body: { mission: "crpko", as: "cell-b", refs: ["1"] },
          }),
        }));
        // The master enrols it again and coord may speak for it.
        yield* enrol(router, "cell-b", masterAgent);
        const allowed = yield* withShim((handle) =>
          call(handle, shimPost({ key: "e2", as: "cell-b", to: ["master"] })),
        );
        expect(laneTries).toBe("forbidden");
        for (const each of Object.values(refused)) {
          expect(each.status).toBe(403);
          expect(each.reply.error.code).toBe("forbidden");
        }
        expect(allowed.reply).toEqual({ ok: true, seq: 1, recipients: ["master"] });
        const store = yield* MissionStore.MissionStore;
        const changes = (yield* store.eventsSince(crpko, 0, 500)).filter(
          (event) =>
            event.kind === "member.changed" &&
            (event.payload as { principal?: string } | null)?.principal === "coord:cell-b",
        );
        expect(changes.map((event) => event.payload)).toEqual([
          { principal: "coord:cell-b", kind: "service", member: true },
          { principal: "coord:cell-b", kind: "service", member: false },
          { principal: "coord:cell-b", kind: "service", member: true },
        ]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live("an event key another actor posted is a conflict, not a replay", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seedCrpko;
      const result = yield* withShim(async (handle) => ({
        posted: await call(handle, shimPost({ key: "k-same", as: "cell-a", to: ["master"] })),
        // Same key and body hash, sent as another enrolled actor.
        asOther: await call(handle, shimPost({ key: "k-same", as: "cell-b", to: ["master"] })),
        replay: await call(handle, shimPost({ key: "k-same", as: "cell-a", to: ["master"] })),
      }));
      expect(result.posted.reply).toMatchObject({ ok: true, seq: 1 });
      expect(result.asOther.status).toBe(409);
      expect(result.asOther.reply.error.code).toBe("conflict");
      expect(result.replay.reply).toEqual({ ok: true, seq: 1, duplicate: true });
    }).pipe(Effect.provide(h.layer));
  });
});
