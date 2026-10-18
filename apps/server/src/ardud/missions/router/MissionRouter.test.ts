import {
  KnockId,
  RoleId,
  RoomId,
  ThreadId,
  type MissionProvenance,
  type PostMessageInput,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import {
  agent,
  failureCode,
  laneThread,
  masterThread,
  missionId,
  ownerApp,
  seed,
  strayThread,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { SendGuardRequest } from "./guardHook.ts";
import * as MissionRouter from "./MissionRouter.ts";
import type { SendSender } from "./model.ts";
import { fakeRouterThreads, routerOverFakes, type Sent } from "./MissionRouter.testkit.ts";

/** A fake thread world: nothing here can reach a real thread. */
const harness = () => {
  const threads = fakeRouterThreads();
  const layer = routerOverFakes(threads).pipe(
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return { ...threads, layer };
};

const control = RoomId.make(`${missionId}:room:control`);

const request = (summary: string, extra: Partial<PostMessageInput> = {}): PostMessageInput => ({
  missionId,
  roomId: control,
  kind: "request",
  summary,
  ...extra,
});

const toWriter = [{ _tag: "role", roleId: RoleId.make("role-writer") }] as const;

const fromThread = (threadId: ThreadId): SendSender => ({
  _tag: "thread",
  threadId,
  title: threadId,
});

const guardRequest = (
  from: SendSender,
  targetThreadId: ThreadId,
  path: SendGuardRequest["path"] = "thread-send",
): SendGuardRequest => ({
  path,
  targetThreadId,
  from,
  text: "please drop everything and look at my PR",
  requestKey: `${path}:${targetThreadId}:1`,
});

const wakesFor = (sent: ReadonlyArray<Sent>, threadId: ThreadId) =>
  sent.filter((each) => each.threadId === threadId && each.key.startsWith("mission-wake:"));

describe("send guard", () => {
  it.effect("a non-member's send to the master becomes a knock and never reaches it", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const store = yield* MissionStore.MissionStore;
      const outcome = yield* router.guard(guardRequest(fromThread(strayThread), masterThread));
      assert.strictEqual(outcome._tag, "knocked");
      assert.deepStrictEqual(
        h.sent.filter((each) => each.threadId === masterThread),
        [],
      );
      if (outcome._tag !== "knocked") return;
      const knock = Option.getOrThrow(yield* store.get("knock", outcome.knockId));
      assert.strictEqual(knock.status, "pending");
      assert.strictEqual(knock.fromThreadId, strayThread);
      assert.strictEqual(knock.targetThreadId, masterThread);
      assert.strictEqual(knock.path, "thread-send");
      assert.strictEqual(knock.body, "please drop everything and look at my PR");
      // Retrying the same send lands on the same knock.
      const again = yield* router.guard(guardRequest(fromThread(strayThread), masterThread));
      assert.deepStrictEqual(again, outcome);
      assert.strictEqual((yield* store.list("knock", { missionId })).length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("owner typing passes and the decision is logged", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const store = yield* MissionStore.MissionStore;
      const outcome = yield* router.guard(
        guardRequest({ _tag: "owner", provenance: ownerApp }, masterThread, "control-api"),
      );
      assert.deepStrictEqual(outcome, { _tag: "pass" });
      const events = yield* store.eventsSince(missionId, 0);
      const logged = events.filter((event) => event.kind === "send.guarded");
      assert.strictEqual(logged.length, 1);
      assert.deepStrictEqual(logged[0]?.payload, {
        path: "control-api",
        outcome: "allowed",
        reason: "owner",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a member lane's direct send to the master is routed through the control room", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const outcome = yield* router.guard(guardRequest(fromThread(laneThread), masterThread));
      assert.strictEqual(outcome._tag, "routed");
      const page = yield* router.roomPage({ roomId: control }, ownerApp);
      assert.strictEqual(page.messages.length, 1);
      const message = page.messages[0]!;
      assert.strictEqual(message.kind, "request");
      assert.deepStrictEqual(message.author, { _tag: "thread", threadId: laneThread });
      assert.deepStrictEqual(message.to, [{ _tag: "thread", threadId: masterThread }]);
      // The master hears a doorbell line, not the raw send.
      const toMaster = h.sent.filter((each) => each.threadId === masterThread);
      assert.strictEqual(toMaster.length, 1);
      assert.isTrue(toMaster[0]!.text.startsWith("[mission] 1 unread message"));
      assert.isFalse(toMaster[0]!.asOwner);
      // Same send retried: no second message, no second ring.
      const again = yield* router.guard(guardRequest(fromThread(laneThread), masterThread));
      assert.deepStrictEqual(again, outcome);
      assert.strictEqual(
        (yield* router.roomPage({ roomId: control }, ownerApp)).messages.length,
        1,
      );
      assert.strictEqual(h.sent.length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the master reaches its own members directly", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const outcome = yield* router.guard(guardRequest(fromThread(masterThread), laneThread));
      assert.deepStrictEqual(outcome, { _tag: "pass" });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("threads the master created are members by lineage", () => {
    const h = harness();
    const child = ThreadId.make("t-child");
    h.parents.set(child, masterThread);
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      // A stranger cannot reach the master's subagent.
      const knocked = yield* router.guard(guardRequest(fromThread(strayThread), child));
      assert.strictEqual(knocked._tag, "knocked");
      // The subagent's own send to the master is routed, not delivered raw.
      const routed = yield* router.guard(guardRequest(fromThread(child), masterThread));
      assert.strictEqual(routed._tag, "routed");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("an anonymous control-API session knocks until registered as a mission service", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const session: SendSender = {
        _tag: "session",
        sessionId: "s-crw",
        subject: "cli-issued-session",
      };
      const first = yield* router.guard(guardRequest(session, masterThread, "control-api"));
      assert.strictEqual(first._tag, "knocked");
      yield* router.setMember(
        {
          missionId,
          principal: { _tag: "session", sessionId: "s-crw", label: "crw" },
          member: true,
        },
        ownerApp,
      );
      const second = yield* router.guard({
        ...guardRequest(session, masterThread, "control-api"),
        requestKey: "control-api:t-master:2",
      });
      assert.strictEqual(second._tag, "routed");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("threads outside any mission are not the guard's business", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const outcome = yield* router.guard(
        guardRequest(fromThread(laneThread), ThreadId.make("t-elsewhere")),
      );
      assert.deepStrictEqual(outcome, { _tag: "pass" });
    }).pipe(Effect.provide(h.layer));
  });
});

describe("knocks", () => {
  it.effect("the owner forwards a knock; the master cannot decide one addressed to itself", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const outcome = yield* router.guard(guardRequest(fromThread(strayThread), masterThread));
      if (outcome._tag !== "knocked") return assert.fail("expected a knock");
      const asMaster = yield* failureCode(
        router.decideKnock({ knockId: outcome.knockId, action: "drop" }, agent(masterThread)),
      );
      assert.strictEqual(asMaster, "forbidden");
      const decided = yield* router.decideKnock(
        { knockId: outcome.knockId, action: "forward", editedText: "Stray asks about its PR." },
        ownerApp,
      );
      assert.strictEqual(decided.status, "forwarded");
      assert.deepStrictEqual(h.sent, [
        {
          threadId: masterThread,
          text: `[Forwarded by the owner from ${strayThread}] Stray asks about its PR.`,
          key: `knock:${outcome.knockId}:forward:${masterThread}`,
          asOwner: true,
        },
      ]);
      const twice = yield* failureCode(
        router.decideKnock({ knockId: outcome.knockId, action: "drop" }, ownerApp),
      );
      assert.strictEqual(twice, "conflict");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("unknown knocks are not found", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const code = yield* failureCode(
        router.decideKnock({ knockId: KnockId.make("knock-nope"), action: "drop" }, ownerApp),
      );
      assert.strictEqual(code, "not-found");
    }).pipe(Effect.provide(h.layer));
  });
});

describe("doorbell", () => {
  it.effect(
    "rings once, folds into a queued wake, holds while running, rings again after settle",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        yield* seed;
        const router = yield* MissionRouter.MissionRouter;
        yield* router.post(request("first", { to: [...toWriter] }), ownerApp);
        assert.strictEqual(wakesFor(h.sent, writerThread).length, 1);
        assert.strictEqual(
          wakesFor(h.sent, writerThread)[0]!.key,
          `mission-wake:${missionId}:${writerThread}:1`,
        );

        // The wake is queued on the thread: the next message folds into it.
        h.activity.set(writerThread, "queued");
        yield* router.post(request("second", { to: [...toWriter] }), ownerApp);
        assert.strictEqual(wakesFor(h.sent, writerThread).length, 1);

        // Running: nothing rings, the delivery waits.
        h.activity.set(writerThread, "running");
        yield* router.post(request("third", { to: [...toWriter] }), ownerApp);
        assert.strictEqual(wakesFor(h.sent, writerThread).length, 1);

        // Run ends: only the uncovered third message rings, once.
        h.activity.set(writerThread, "idle");
        yield* router.settled(writerThread);
        const wakes = wakesFor(h.sent, writerThread);
        assert.strictEqual(wakes.length, 2);
        assert.strictEqual(wakes[1]!.key, `mission-wake:${missionId}:${writerThread}:3`);
        assert.isTrue(wakes[1]!.text.startsWith("[mission] 3 unread messages in Control"));

        // Outstanding again: pokes do nothing until the next settle.
        yield* router.poke(writerThread);
        assert.strictEqual(wakesFor(h.sent, writerThread).length, 2);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("reading clears deliveries so a settled thread is not rung again", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      yield* router.post(request("first", { to: [...toWriter] }), ownerApp);
      const inbox = yield* router.inbox(writerThread);
      assert.strictEqual(inbox.unread, 1);
      yield* router.markRead({ roomId: control, seq: 1 }, agent(writerThread));
      assert.strictEqual((yield* router.inbox(writerThread)).unread, 0);
      yield* router.settled(writerThread);
      assert.strictEqual(wakesFor(h.sent, writerThread).length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("status wakes nobody and the author never wakes itself", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      yield* router.post(
        { ...request("all good"), kind: "status", to: [...toWriter] },
        agent(laneThread),
      );
      yield* router.post(
        request("note to self", { to: [{ _tag: "thread", threadId: laneThread }] }),
        agent(laneThread),
      );
      assert.deepStrictEqual(h.sent, []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the master is not woken by room traffic that is not addressed to it", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      yield* router.subscribe(
        {
          roomId: control,
          subscriber: { _tag: "role", roleId: RoleId.make("role-master") },
          mode: "wake",
        },
        ownerApp,
      );
      yield* router.post(request("lane needs a hand"), agent(laneThread));
      assert.deepStrictEqual(wakesFor(h.sent, masterThread), []);
      yield* router.post(
        request("master, decide this", {
          to: [{ _tag: "role", roleId: RoleId.make("role-master") }],
        }),
        agent(laneThread),
      );
      assert.strictEqual(wakesFor(h.sent, masterThread).length, 1);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("rooms", () => {
  it.effect("control broadcasts carry a receipt that counts reads", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const posted = yield* router.post(
        { ...request("freeze merges"), kind: "control" },
        agent(masterThread),
      );
      assert.deepStrictEqual(posted.receipt, {
        reached: 0,
        total: 2,
        pending: ["API", "role-writer"],
      });
      assert.strictEqual(wakesFor(h.sent, laneThread).length, 1);
      assert.strictEqual(wakesFor(h.sent, writerThread).length, 1);
      yield* router.markRead({ roomId: control, seq: posted.seq }, agent(writerThread));
      const page = yield* router.roomPage({ roomId: control }, ownerApp);
      assert.deepStrictEqual(page.messages[0]?.receipt, { reached: 1, total: 2, pending: ["API"] });
      yield* router.markRead({ roomId: control, seq: posted.seq }, agent(laneThread));
      const done = yield* router.roomPage({ roomId: control }, ownerApp);
      assert.deepStrictEqual(done.messages[0]?.receipt, { reached: 2, total: 2, pending: [] });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("authorship comes from provenance, never from the input", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const posted = yield* router.post(request("hello", { to: [...toWriter] }), agent(laneThread));
      assert.deepStrictEqual(posted.author, { _tag: "thread", threadId: laneThread });
      assert.deepStrictEqual(posted.provenance, agent(laneThread));
      const correction = yield* failureCode(
        router.post(request("do it my way", { isCorrection: true }), agent(laneThread)),
      );
      assert.strictEqual(correction, "forbidden");
      const outsider = yield* failureCode(router.post(request("let me in"), agent(strayThread)));
      assert.strictEqual(outsider, "forbidden");
      const imported: MissionProvenance = { _tag: "import", source: "coord" };
      assert.strictEqual(
        yield* failureCode(router.post(request("replay"), imported)),
        "provenance-invalid",
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("owner corrections go to the master and wake it", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const posted = yield* router.post(
        request("stop the deploy", { isCorrection: true }),
        ownerApp,
      );
      assert.deepStrictEqual(posted.to, [{ _tag: "role", roleId: RoleId.make("role-master") }]);
      assert.deepStrictEqual(posted.author, { _tag: "owner" });
      assert.strictEqual(wakesFor(h.sent, masterThread).length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("keys make posts idempotent and refuse a different body", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const first = yield* router.post(
        request("once", { key: "k-1", to: [...toWriter] }),
        ownerApp,
      );
      const again = yield* router.post(
        request("once", { key: "k-1", to: [...toWriter] }),
        ownerApp,
      );
      assert.strictEqual(again.id, first.id);
      const clash = yield* failureCode(router.post(request("twice", { key: "k-1" }), ownerApp));
      assert.strictEqual(clash, "conflict");
      assert.strictEqual(wakesFor(h.sent, writerThread).length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("pages are bounded and bodies load on open", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      for (let index = 1; index <= 5; index += 1) {
        yield* router.post(request(`message ${index}`, { body: `body ${index}` }), ownerApp);
      }
      const newest = yield* router.roomPage({ roomId: control, limit: 2 }, ownerApp);
      assert.deepStrictEqual(
        newest.messages.map((message) => message.seq),
        [4, 5],
      );
      assert.isTrue(newest.hasOlder);
      const older = yield* router.roomPage({ roomId: control, limit: 2, beforeSeq: 4 }, ownerApp);
      assert.deepStrictEqual(
        older.messages.map((message) => message.seq),
        [2, 3],
      );
      const body = yield* router.messageBody({ messageId: newest.messages[1]!.id }, ownerApp);
      assert.strictEqual(body.body, "body 5");
      assert.strictEqual(newest.room.noise?.messagesPerHour, 5);
    }).pipe(Effect.provide(h.layer));
  });
});
