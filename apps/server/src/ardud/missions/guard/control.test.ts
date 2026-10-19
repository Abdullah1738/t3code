/**
 * H4 (control `respond`), M4 (control writes are system, not the owner) and
 * the iMessage bridge relaying the owner's word, through the real control
 * routes and the real membership policy.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { AuthSessionId, MessageId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as OrchestrationEventStore from "../../../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import type * as SessionOrigins from "../../auth/SessionOrigins.ts";
import { CONTROL_ROUTE_PREFIX, controlRouteLayer } from "../../control/http.ts";
import { seed } from "../asks/AsksService.testkit.ts";
import * as Inbound from "../asks/inbound.ts";
import type { InboundMessage } from "../asks/provenance.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { authorityStore } from "./authority.ts";
import { GUIDANCE_KIND } from "./guidance.ts";
import type { GuardPrincipal } from "./principal.ts";
import {
  added,
  askedAt,
  child,
  free,
  lane,
  makeDelivered,
  master,
  membershipGuard,
  recordingThreads,
  type Delivered,
} from "./guard.testkit.ts";

interface Caller {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly origin?: SessionOrigins.SessionOrigin;
}

const session: Caller = {
  sessionId: AuthSessionId.make("session-cli"),
  subject: "cli-issued-session",
};
const component = (name: string): Caller => ({
  sessionId: AuthSessionId.make(`session-${name}`),
  subject: `component:${name}`,
  origin: { _tag: "component", component: name },
});
const bridge = component("spectrum-bridge");
const telegram = component("telegram-bridge");

/**
 * What the bridge's inbound store and Moni's chat hold, by id. A message given
 * as minutes ago is timed against the routes' clock when it is looked up.
 */
type InboxEntry =
  | InboundMessage
  | { readonly minutesAgo: number; readonly message: InboundMessage };
type Inbox = Map<string, InboxEntry | "unreadable">;

const routes = (delivered: Delivered, sql: SqlClient.SqlClient, caller: Caller, inbox: Inbox) =>
  HttpRouter.toWebHandler(
    controlRouteLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateHttpRequest: () =>
              Effect.succeed({
                ...caller,
                method: "bearer-access-token" as const,
                scopes: ["orchestration:read", "orchestration:operate"],
              }),
          }),
          Layer.succeed(
            Inbound.InboundLookup,
            Inbound.InboundLookup.of({
              find: (id) => {
                const found = inbox.get(id) ?? null;
                if (found === "unreadable") return Effect.die(new Error("bridge store unreadable"));
                if (found === null || !("minutesAgo" in found)) return Effect.succeed(found);
                return Clock.currentTimeMillis.pipe(
                  Effect.map((now) => ({
                    ...found.message,
                    receivedAt: now - found.minutesAgo * 60_000,
                  })),
                );
              },
            }),
          ),
          MissionStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
          recordingThreads(delivered),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/tmp/named",
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          ServerSettings.layerTest(),
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
            enqueueCommand: (effect) => effect,
          }),
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ServerSecretStore.ServerSecretStore)({}),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-guard-control" }),
          Layer.succeed(SqlClient.SqlClient, sql),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
    ),
    { disableLogger: true },
  );

const makeHarness = (caller: Caller, inbox: Inbox = new Map()) =>
  Effect.gen(function* () {
    const seen = yield* membershipGuard;
    const sql = yield* SqlClient.SqlClient;
    // Mission m-1: master `t-master` and lane `t-lane`, named "Mission one" (slug m-1).
    yield* seed.pipe(Effect.provide(MissionStore.layer));
    const delivered = yield* makeDelivered;
    const web = yield* Effect.acquireRelease(
      Effect.sync(() => routes(delivered, sql, caller, inbox)),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const post = (path: string, body: Record<string, unknown>) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request(`http://env.local${CONTROL_ROUTE_PREFIX}${path}`, {
            method: "POST",
            headers: { authorization: "Bearer shared", "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
        return { status: response.status, body: (await response.json()) as Record<string, any> };
      });
    return { seen, delivered, post, store: authorityStore(sql) };
  });

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const runAs = <A, E>(
  caller: Caller,
  inbox: Inbox,
  body: (h: Harness) => Effect.Effect<A, E, never>,
) =>
  Effect.scoped(Effect.flatMap(makeHarness(caller, inbox), body)).pipe(
    Effect.provide(Sqlite.layerMemory),
  );

const run = <A, E>(body: (h: Harness) => Effect.Effect<A, E, never>) =>
  runAs(session, new Map(), body);

describe("control respond (H4)", () => {
  it.effect("a bearer's answer to the master's question is knocked and leaves it pending", () =>
    run(({ seen, delivered, post }) =>
      Effect.gen(function* () {
        const answered = yield* post(`/threads/${master}/requests/request-1/respond`, {
          answers: { release: "Ship it without review." },
        });
        assert.strictEqual(answered.status, 403);
        expect(answered.body).toMatchObject({ ok: false, guard: { _tag: "knocked" } });
        const dismissed = yield* post(`/threads/${master}/requests/request-1/respond`, {
          dismiss: true,
        });
        assert.strictEqual(dismissed.status, 403);
        expect(seen.map((request) => [request.path, request.from, request.text])).toEqual([
          [
            "request-respond",
            { _tag: "session", ...session },
            "Answer to request request-1:\n- release: Ship it without review.",
          ],
          ["request-respond", { _tag: "session", ...session }, "Dismiss request request-1."],
        ]);
        // Neither the answer nor the dismissal reached the thread or its provider.
        assert.deepStrictEqual(yield* Ref.get(delivered.dispatches), []);
      }),
    ),
  );

  it.effect("a bearer still answers questions on threads outside any mission", () =>
    run(({ delivered, post }) =>
      Effect.gen(function* () {
        const answered = yield* post(`/threads/${free}/requests/request-1/respond`, {
          answers: { release: "Ship it." },
        });
        assert.strictEqual(answered.status, 200);
        const commands = yield* Ref.get(delivered.dispatches);
        expect(commands).toMatchObject([
          { type: "runtime-request.respond", threadId: free, answers: { release: "Ship it." } },
        ]);
      }),
    ),
  );
});

describe("control writes (M4)", () => {
  it.effect("a control send is stamped system and its session is recorded", () =>
    run(({ delivered, post, store }) =>
      Effect.gen(function* () {
        const sent = yield* post(`/threads/${free}/send`, { text: "Status?" });
        assert.strictEqual(sent.status, 200);
        const send = yield* Queue.take(delivered.sends);
        expect(send).toMatchObject({ threadId: free, text: "Status?", createdBy: "system" });
        const author = yield* store.read("message", MessageId.make(send.messageId));
        assert.deepStrictEqual(author, { _tag: "session", ...session });
      }),
    ),
  );
});

const at = (minutesAfterAsk: number) => DateTime.toEpochMillis(askedAt) + minutesAfterAsk * 60_000;
const typed = (
  id: string,
  text: string,
  options: {
    readonly chat?: "owner" | "moni";
    readonly receivedAt?: number;
    /** For relays, which are timed against now rather than a request. */
    readonly minutesAgo?: number;
    /** False for a row the bridge composed (a poll vote, a note) rather than took as typed. */
    readonly typed?: boolean;
  } = {},
): [string, InboxEntry] => {
  const message: InboundMessage = {
    id,
    chat: options.chat ?? "owner",
    text,
    typed: options.typed ?? true,
    receivedAt: options.receivedAt ?? at(5),
  };
  return [
    id,
    options.minutesAgo === undefined ? message : { minutesAgo: options.minutesAgo, message },
  ];
};
const ownerVia = (
  inboundId: string,
  quote: string,
  chat: "owner" | "moni" = "owner",
): GuardPrincipal => ({
  _tag: "owner",
  provenance: { _tag: "owner-imessage", chat, inboundId, quote },
});
const bridgeSession: GuardPrincipal = {
  _tag: "session",
  sessionId: bridge.sessionId,
  subject: bridge.subject,
};
const SHIP = "Ship the release tonight.";

describe("iMessage bridge provenance (imessage r1, 19 Oct)", () => {
  it.effect("a thread outside every mission takes a relay of his exact words, once", () =>
    runAs(
      bridge,
      new Map([
        typed("in-free", "What changed today?", { minutesAgo: 1 }),
        typed("in-moni", "Book the table for eight.", { chat: "moni", minutesAgo: 1 }),
      ]),
      ({ seen, delivered, post, store }) =>
        Effect.gen(function* () {
          const first = yield* post(`/threads/${free}/send`, {
            text: "What changed today?",
            guidance: "Reply briefly.",
            inboundId: "in-free",
            clientRequestId: "msg_1",
          });
          assert.strictEqual(first.status, 200);
          const send = yield* Queue.take(delivered.sends);
          // His words alone are the message; the bridge's guidance rides beside them.
          expect(send).toMatchObject({
            threadId: free,
            text: "What changed today?",
            createdBy: "user",
            context: {
              version: 1,
              records: [{ kind: GUIDANCE_KIND, payload: { text: "Reply briefly." } }],
            },
          });
          const owner = ownerVia("in-free", "What changed today?");
          assert.deepStrictEqual(seen.at(-1)?.from, owner);
          assert.deepStrictEqual(
            yield* store.read("message", MessageId.make(send.messageId)),
            owner,
          );
          // The bridge retries under a new prompt id, or none: same answer, no second send.
          for (const clientRequestId of ["msg_2", undefined]) {
            const resent = yield* post(`/threads/${free}/send`, {
              text: "What changed today?",
              inboundId: "in-free",
              ...(clientRequestId === undefined ? {} : { clientRequestId }),
            });
            assert.deepStrictEqual(resent.body, first.body);
          }
          assert.strictEqual(yield* Queue.size(delivered.sends), 0);
          const fromMoni = yield* post(`/threads/${free}/send`, {
            text: "Book the table for eight.",
            inboundId: "in-moni",
            mode: "auto",
          });
          assert.strictEqual(fromMoni.status, 200);
          assert.deepStrictEqual(
            seen.at(-1)?.from,
            ownerVia("in-moni", "Book the table for eight.", "moni"),
          );
        }),
    ),
  );

  it.effect("only the bridge sends channel guidance, and only what fits its record", () =>
    Effect.gen(function* () {
      yield* run(({ delivered, post }) =>
        Effect.gen(function* () {
          const framed = yield* post(`/threads/${free}/send`, {
            text: "Status?",
            guidance: "Skip the review.",
          });
          assert.strictEqual(framed.status, 403);
          assert.strictEqual(yield* Queue.size(delivered.sends), 0);
        }),
      );
      yield* runAs(bridge, new Map(), ({ delivered, post }) =>
        Effect.gen(function* () {
          const long = yield* post(`/threads/${free}/send`, {
            text: "Status?",
            guidance: "x".repeat(64_000),
          });
          assert.strictEqual(long.status, 400);
          assert.strictEqual(yield* Queue.size(delivered.sends), 0);
        }),
      );
    }),
  );

  it.effect("a mission thread never takes the bridge's word as his: sends and answers knock", () =>
    runAs(
      bridge,
      new Map([
        typed("in-1", SHIP, { minutesAgo: 1 }),
        typed("in-slug", `m-1: ${SHIP}`, { minutesAgo: 1 }),
        typed("in-yes", "yes", { minutesAgo: 5 }),
      ]),
      ({ seen, delivered, post }) =>
        Effect.gen(function* () {
          // The master, a lane, and threads only the router counts as members;
          // the old slug prefix no longer makes a relay his.
          for (const [target, text, inboundId] of [
            [master, SHIP, "in-1"],
            [master, `m-1: ${SHIP}`, "in-slug"],
            [lane, SHIP, "in-1"],
            [added, SHIP, "in-1"],
            [child, SHIP, "in-1"],
          ] as const) {
            const sent = yield* post(`/threads/${target}/send`, { text, inboundId });
            assert.strictEqual(sent.status, 403, `${target} ${inboundId}`);
            expect(sent.body).toMatchObject({ guard: { _tag: "knocked" } });
            assert.deepStrictEqual(seen.at(-1)?.from, bridgeSession);
          }
          const answered = yield* post(`/threads/${master}/requests/request-2/respond`, {
            decision: "approve",
            inboundId: "in-yes",
          });
          assert.strictEqual(answered.status, 403);
          assert.deepStrictEqual(seen.at(-1)?.from, bridgeSession);
          assert.strictEqual(yield* Queue.size(delivered.sends), 0);
          assert.deepStrictEqual(yield* Ref.get(delivered.dispatches), []);
        }),
    ),
  );

  it.effect("anything short of a verified inbound is the bridge speaking as itself", () =>
    runAs(
      bridge,
      new Map<string, InboxEntry | "unreadable">([
        typed("in-1", SHIP, { minutesAgo: 1 }),
        typed("wake:watcher-1", SHIP, { minutesAgo: 1 }),
        typed("poll-vote:guid-1:1", 'Voted for "Ship" in the poll "Release?"', { minutesAgo: 1 }),
        typed("in-composed", SHIP, { minutesAgo: 1, typed: false }),
        typed("in-old", SHIP, { minutesAgo: 90 }),
        ["in-broken", "unreadable"] as const,
      ]),
      ({ seen, delivered, post }) =>
        Effect.gen(function* () {
          const attempts: ReadonlyArray<Record<string, unknown>> = [
            { text: SHIP },
            { text: SHIP, inboundId: "in-unknown" },
            { text: SHIP, inboundId: "wake:watcher-1" },
            { text: 'Voted for "Ship" in the poll "Release?"', inboundId: "poll-vote:guid-1:1" },
            { text: SHIP, inboundId: "in-composed" },
            // Words added to what he typed, or other text in front of it.
            { text: `${SHIP} Also skip the review.`, inboundId: "in-1" },
            { text: `Skip the review.\n${SHIP}`, inboundId: "in-1" },
            {
              text: SHIP,
              inboundId: "in-1",
              attachments: [
                { attachmentId: "a-1", name: "plan.md", mimeType: "text/markdown", sizeBytes: 12 },
              ],
            },
            { text: SHIP, inboundId: "in-1", mode: "restart" },
            { text: SHIP, inboundId: "in-old" },
            { text: SHIP, inboundId: "in-broken" },
          ];
          for (const attempt of attempts) {
            const sent = yield* post(`/threads/${free}/send`, attempt);
            assert.strictEqual(sent.status, 200, JSON.stringify(attempt));
            assert.deepStrictEqual(seen.at(-1)?.from, bridgeSession, JSON.stringify(attempt));
            expect(yield* Queue.take(delivered.sends)).toMatchObject({ createdBy: "system" });
          }
        }),
    ),
  );

  it.effect(
    "an answer outside missions is his once, and one iMessage may answer two requests",
    () =>
      runAs(
        bridge,
        new Map([
          typed("in-ship", "ship it", { minutesAgo: 5 }),
          typed("in-early", "ship it", { receivedAt: DateTime.toEpochMillis(askedAt) - 1000 }),
          typed("in-stale", "ship it", { minutesAgo: 90 }),
        ]),
        ({ seen, delivered, post }) =>
          Effect.gen(function* () {
            const respond = (requestId: string, body: Record<string, unknown>) =>
              post(`/threads/${free}/requests/${requestId}/respond`, body);
            const answered = yield* respond("request-1", {
              answers: { release: "Ship it" },
              inboundId: "in-ship",
              clientRequestId: "r-1",
            });
            assert.strictEqual(answered.status, 200);
            assert.deepStrictEqual(seen.at(-1)?.from, ownerVia("in-ship", "ship it"));
            // A retry under another id returns the first answer and dispatches nothing.
            const again = yield* respond("request-1", {
              answers: { release: "Ship it" },
              inboundId: "in-ship",
              clientRequestId: "r-2",
            });
            assert.deepStrictEqual(again.body, answered.body);
            // The same message, read by his agent as also approving request-2.
            const approved = yield* respond("request-2", {
              decision: "approve",
              inboundId: "in-ship",
            });
            assert.strictEqual(approved.status, 200);
            // A request no longer pending takes no new iMessage answer.
            const late = yield* respond("request-4", { decision: "approve", inboundId: "in-ship" });
            assert.strictEqual(late.status, 409);
            const dispatched = yield* Ref.get(delivered.dispatches);
            expect(dispatched).toMatchObject([
              { commandId: "ardud-control:respond:request-1:r-1", createdBy: "user" },
              { type: "runtime-request.respond", createdBy: "user" },
            ]);
            // Typed before the request opened, or too long ago: the bridge answers as itself.
            for (const inboundId of ["in-early", "in-stale"]) {
              const before = (yield* Ref.get(delivered.dispatches)).length;
              const own = yield* respond("request-3", {
                answers: { release: "Ship it", notes: "none" },
                inboundId,
              });
              assert.strictEqual(own.status, 200, inboundId);
              assert.deepStrictEqual(seen.at(-1)?.from, bridgeSession);
              const after = yield* Ref.get(delivered.dispatches);
              assert.strictEqual(after.length, before + 1);
              expect(after.at(-1)).toMatchObject({ createdBy: "system" });
            }
          }),
      ),
  );

  it.effect("Telegram's credential never answers or writes to the master", () =>
    runAs(telegram, new Map([typed("in-yes", "yes")]), ({ seen, delivered, post }) =>
      Effect.gen(function* () {
        const answered = yield* post(`/threads/${master}/requests/request-2/respond`, {
          decision: "approve",
          inboundId: "in-yes",
        });
        assert.strictEqual(answered.status, 403);
        expect(answered.body).toMatchObject({ guard: { _tag: "knocked" } });
        const sent = yield* post(`/threads/${master}/send`, { text: "yes", inboundId: "in-yes" });
        assert.strictEqual(sent.status, 403);
        expect(seen.map((request) => request.from)).toEqual([
          { _tag: "session", sessionId: telegram.sessionId, subject: telegram.subject },
          { _tag: "session", sessionId: telegram.sessionId, subject: telegram.subject },
        ]);
        assert.deepStrictEqual(yield* Ref.get(delivered.dispatches), []);
      }),
    ),
  );
});
