import { RoomId, WS_METHODS } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import {
  failureCode,
  masterThread,
  missionId,
  seed,
  strayThread,
} from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as MissionRouter from "./MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "./MissionRouter.testkit.ts";
import { makeRouterWsHandlers } from "./ws.ts";

const paired = {
  sessionId: "session-app",
  subject: "one-time-token",
  origin: { _tag: "owner", source: "cli" },
} as const;
const cliIssued = { sessionId: "session-cli", subject: "cli-issued-session" };
const control = RoomId.make(`${missionId}:room:control`);

const harness = () => {
  const threads = fakeRouterThreads();
  const layer = routerOverFakes(threads).pipe(
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return { ...threads, layer };
};

describe("router WS handlers", () => {
  it.effect("writes need a paired app session; reads do not", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const app = makeRouterWsHandlers(router, { surface: "web", session: paired });
      const cli = makeRouterWsHandlers(router, { surface: "web", session: cliIssued });

      const post = { missionId, roomId: control, kind: "decision", summary: "Ship it" } as const;
      assert.strictEqual(
        yield* failureCode(cli[WS_METHODS.missionsPostMessage](post)),
        "provenance-required",
      );
      const message = yield* app[WS_METHODS.missionsPostMessage](post);
      assert.deepStrictEqual(message.author, { _tag: "owner" });
      assert.deepStrictEqual(message.provenance, {
        _tag: "owner-app",
        surface: "web",
        sessionId: "session-app",
      });

      // A non-owner client still reads the room, body included.
      const page = yield* cli[WS_METHODS.missionsRoomPage]({ roomId: control });
      assert.deepStrictEqual(
        page.messages.map((each) => each.summary),
        ["Ship it"],
      );
      const rooms = yield* cli[WS_METHODS.missionsRooms]({ missionId });
      assert.deepStrictEqual(
        rooms.map((room) => room.id),
        [control],
      );

      // Reading as the owner moves the owner's read position.
      yield* app[WS_METHODS.missionsMarkRead]({ roomId: control, seq: message.seq });
      const after = yield* app[WS_METHODS.missionsRoomPage]({ roomId: control });
      assert.strictEqual(after.ownerReadSeq, message.seq);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the owner decides knocks from the app", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const app = makeRouterWsHandlers(router, { surface: "mobile", session: paired });
      const cli = makeRouterWsHandlers(router, { surface: "web", session: cliIssued });
      const outcome = yield* router.guard({
        path: "thread-send",
        targetThreadId: masterThread,
        from: { _tag: "thread", threadId: strayThread, title: "Stray" },
        text: "look at my PR",
        requestKey: "ws-test:1",
      });
      if (outcome._tag !== "knocked") return assert.fail("expected a knock");
      assert.strictEqual(
        yield* failureCode(
          cli[WS_METHODS.missionsDecideKnock]({ knockId: outcome.knockId, action: "drop" }),
        ),
        "provenance-required",
      );
      const dropped = yield* app[WS_METHODS.missionsDecideKnock]({
        knockId: outcome.knockId,
        action: "drop",
      });
      assert.strictEqual(dropped.status, "dropped");
      assert.deepStrictEqual(h.sent, []);
    }).pipe(Effect.provide(h.layer));
  });
});
