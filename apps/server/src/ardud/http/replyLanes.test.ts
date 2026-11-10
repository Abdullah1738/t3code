// Starvation regression for the 10 Nov 2026 install (Robob 0.1.0-preview.20261110.1):
// slow thread lists and long reads held the one shared agent lane (~1.8 of 2
// permits) and identity, thread status, health and bridge message polls waited
// behind them until their clients timed out (499).
import { expect, it } from "@effect/vitest";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpClient, HttpRouter } from "effect/http";
import * as ServerHttp from "../../http.ts";
import { KanbanService } from "../kanban/engine/KanbanService.ts";
import { BoardsDatabase } from "../persistence/BoardsDatabase.ts";
import { jsonReply } from "./jsonReply.ts";
import * as ReplyBuilders from "./ReplyBuilders.ts";

const C = "/api/ardud/control";

it.effect(
  "slow lists and snapshot reads never block identity, status, health or message polls",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const entered = yield* Ref.make(0);
      const allEntered = yield* Deferred.make<void>();
      const HELD = 5;
      const enter = Ref.updateAndGet(entered, (n) => n + 1).pipe(
        Effect.flatMap((n) => (n === HELD ? Deferred.succeed(allEntered, undefined) : Effect.void)),
      );
      // Same lane calls as the real handlers: a list reads with no permit and
      // encodes on the agent lane; a message poll reads on the poll lane.
      const routes = HttpRouter.addAll([
        HttpRouter.route(
          "GET",
          "/api/orchestration/shell",
          enter.pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(jsonReply({ threads: [] })),
          ),
        ),
        HttpRouter.route(
          "GET",
          `${C}/threads`,
          enter.pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(ReplyBuilders.bounded(Effect.sync(() => jsonReply({ threads: [] })))),
          ),
        ),
        HttpRouter.route(
          "GET",
          `${C}/threads/:threadId/messages`,
          ReplyBuilders.bounded(Effect.succeed([{ id: "m1" }]), "poll").pipe(
            Effect.flatMap((messages) =>
              ReplyBuilders.bounded(Effect.sync(() => jsonReply({ messages }))),
            ),
          ),
        ),
        HttpRouter.route("GET", `${C}/threads/:threadId`, Effect.succeed(jsonReply({ ok: true }))),
        HttpRouter.route("GET", `${C}/identity/resolve`, Effect.succeed(jsonReply({ ok: true }))),
        HttpRouter.route("GET", `${C}/health`, Effect.succeed(jsonReply({ ok: true }))),
      ]);
      const services = yield* Layer.build(
        HttpRouter.serve(Layer.merge(routes, ServerHttp.layerHttpCompression), {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(NodeHttpPlatform.layer),
          Layer.provideMerge(ReplyBuilders.layer),
          Layer.provide(
            Layer.merge(
              Layer.mock(KanbanService)({ ready: Effect.void, attachmentPath: () => null }),
              Layer.mock(BoardsDatabase)({ ready: Effect.void, path: ":memory:" }),
            ),
          ),
        ),
      );
      const client = Context.get(services, HttpClient.HttpClient);
      const builders = Context.get(services, ReplyBuilders.ReplyBuilders);
      // Two snapshot reads fill the snapshot lane; three slow lists wait on their reads.
      const held = yield* Effect.forEach(
        [
          "/api/orchestration/shell",
          "/api/orchestration/shell",
          `${C}/threads`,
          `${C}/threads`,
          `${C}/threads`,
        ],
        (path) => client.get(path).pipe(Effect.forkScoped),
      );
      yield* Deferred.await(allEntered);
      // A slow list holds no reply builder while it reads.
      expect(yield* builders.agent.takeIfAvailable(ReplyBuilders.PERMITS.agent)).toBe(true);
      yield* builders.agent.release(ReplyBuilders.PERMITS.agent);
      for (const path of [
        `${C}/identity/resolve?nativeId=x`,
        `${C}/threads/thread-1`,
        `${C}/health`,
        `${C}/threads/thread-1/messages?all=true`,
      ]) {
        const response = yield* client.get(path).pipe(Effect.timeout("2 seconds"));
        expect(response.status).toBe(200);
      }
      yield* Deferred.succeed(release, undefined);
      for (const request of held) expect((yield* Fiber.join(request)).status).toBe(200);
    }).pipe(Effect.scoped),
);

it.effect("message polls queue only behind other polls", () =>
  Effect.gen(function* () {
    const builders = yield* ReplyBuilders.ReplyBuilders;
    // Snapshot and agent lanes saturated by others.
    yield* builders.snapshot.take(ReplyBuilders.PERMITS.snapshot);
    yield* builders.interactive.take(ReplyBuilders.PERMITS.interactive);
    const poll = yield* ReplyBuilders.bounded(Effect.succeed("read"), "poll").pipe(
      Effect.timeout("1 second"),
    );
    expect(poll).toBe("read");
    yield* builders.snapshot.release(ReplyBuilders.PERMITS.snapshot);
    yield* builders.interactive.release(ReplyBuilders.PERMITS.interactive);
  }).pipe(Effect.provide(ReplyBuilders.layer)),
);
