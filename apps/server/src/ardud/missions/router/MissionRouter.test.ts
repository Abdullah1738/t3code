import {
  KnockId,
  MissionId,
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
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import {
  agent,
  binding,
  failureCode,
  lane,
  laneThread,
  masterThread,
  mission,
  missionId,
  ownerApp,
  role,
  seed,
  strayThread,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { answerText } from "./answers.ts";
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
    h.creators.set(child, { _tag: "thread", threadId: masterThread, title: "Master" });
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

  // --- router additions: r3 ---
  it.effect("a fork counts as the master's only when the owner or the master created it", () => {
    const h = harness();
    const ownerFork = ThreadId.make("t-owner-fork");
    const laneFork = ThreadId.make("t-lane-fork");
    const legacyFork = ThreadId.make("t-legacy-fork");
    const strayFork = ThreadId.make("t-stray-fork");
    h.parents.set(ownerFork, masterThread);
    h.creators.set(ownerFork, { _tag: "owner", provenance: ownerApp });
    // The lane forked itself: its lineage is the mission's, its creator is not the master.
    h.parents.set(laneFork, laneThread);
    h.creators.set(laneFork, { _tag: "thread", threadId: laneThread, title: "Lane" });
    // Forked before creators were recorded.
    h.parents.set(legacyFork, masterThread);
    // Someone else forked the master.
    h.parents.set(strayFork, masterThread);
    h.creators.set(strayFork, { _tag: "thread", threadId: strayThread, title: "Stray" });
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const store = yield* MissionStore.MissionStore;
      const toMaster = (from: ThreadId) =>
        router.checkSend({
          path: "thread-send",
          targetThreadId: masterThread,
          from: fromThread(from),
        });
      assert.strictEqual((yield* toMaster(ownerFork))._tag, "route");
      for (const outsider of [laneFork, legacyFork, strayFork]) {
        const decision = yield* toMaster(outsider);
        assert.deepStrictEqual(decision, { _tag: "knock", missionId, reason: "outsider" });
      }
      // Not members, so a stranger's send to them is none of the guard's business.
      const toLegacy = yield* router.guard(guardRequest(fromThread(strayThread), legacyFork));
      assert.deepStrictEqual(toLegacy, { _tag: "pass" });
      // The master enrols the legacy fork with its member tool; then it is in.
      yield* router.setMember(
        { missionId, principal: { _tag: "thread", threadId: legacyFork }, member: true },
        agent(masterThread),
      );
      assert.strictEqual((yield* toMaster(legacyFork))._tag, "route");
      const changed = (yield* store.eventsSince(missionId, 0)).filter(
        (event) => event.kind === "member.changed",
      );
      assert.strictEqual(changed.length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("checkSend decides without posting, knocking, logging or ringing", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const store = yield* MissionStore.MissionStore;
      const before = yield* store.latestSeq(missionId);
      const check = (from: SendSender, target: ThreadId) =>
        router.checkSend({ path: "thread-send", targetThreadId: target, from });
      assert.deepStrictEqual(yield* check(fromThread(strayThread), masterThread), {
        _tag: "knock",
        missionId,
        reason: "outsider",
      });
      assert.deepStrictEqual(yield* check(fromThread(laneThread), masterThread), {
        _tag: "route",
        missionId,
        author: { _tag: "thread", threadId: laneThread },
        reason: "member",
      });
      assert.deepStrictEqual(yield* check({ _tag: "owner", provenance: ownerApp }, masterThread), {
        _tag: "allow",
        missionId,
        reason: "owner",
      });
      assert.deepStrictEqual(yield* check(fromThread(laneThread), ThreadId.make("t-elsewhere")), {
        _tag: "not-member",
      });
      assert.strictEqual(yield* store.latestSeq(missionId), before);
      assert.deepStrictEqual(yield* store.list("knock", { missionId }), []);
      // Nothing was posted: the control room was never even opened.
      assert.strictEqual(
        yield* failureCode(router.roomPage({ roomId: control }, ownerApp)),
        "not-found",
      );
      assert.deepStrictEqual(h.sent, []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("membership sees a mission older than the newest thousand", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const store = yield* MissionStore.MissionStore;
      const router = yield* MissionRouter.MissionRouter;
      // 1,001 newer live missions push mission one out of any capped listing.
      yield* store.commit({
        event: {
          missionId: MissionId.make("m-crowd-0"),
          kind: "mission.created",
          actor: { _tag: "system", component: "test" },
          provenance: { _tag: "system", component: "test" },
          summary: "crowd",
          subject: null,
        },
        upserts: Array.from({ length: 1_001 }, (_, index) => ({
          _tag: "mission" as const,
          record: {
            ...mission,
            id: MissionId.make(`m-crowd-${index}`),
            slug: `m-crowd-${index}`,
            updatedAt: "2026-10-18T08:00:00.000Z",
          },
        })),
      });
      const outcome = yield* router.guard(guardRequest(fromThread(strayThread), masterThread));
      assert.strictEqual(outcome._tag, "knocked");
      assert.deepStrictEqual(h.sent, []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("membership sees the master past a thousand newer bindings", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const store = yield* MissionStore.MissionStore;
      const router = yield* MissionRouter.MissionRouter;
      yield* store.commit({
        event: {
          missionId,
          kind: "role.bound",
          actor: { _tag: "system", component: "test" },
          provenance: { _tag: "system", component: "test" },
          summary: "crowd",
          subject: null,
        },
        upserts: Array.from({ length: 1_001 }, (_, index) => ({
          _tag: "role-binding" as const,
          record: {
            ...binding(`b-crowd-${index}`, "role-writer", ThreadId.make(`t-crowd-${index}`)),
            boundAt: "2026-10-18T08:00:00.000Z",
          },
        })),
      });
      const outcome = yield* router.guard(guardRequest(fromThread(strayThread), masterThread));
      assert.strictEqual(outcome._tag, "knocked");
      // The oldest crowd thread is a member too.
      const crowd = yield* router.checkSend({
        path: "thread-send",
        targetThreadId: masterThread,
        from: fromThread(ThreadId.make("t-crowd-0")),
      });
      assert.strictEqual(crowd._tag, "route");
    }).pipe(Effect.provide(h.layer));
  });
  // --- end router additions ---

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

/** A second live mission whose master is `t-other-master`. */
const otherMission = MissionId.make("m-2");
const otherMaster = ThreadId.make("t-other-master");
const seedOther = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  yield* store.commit({
    event: {
      missionId: otherMission,
      kind: "mission.created",
      actor: { _tag: "system", component: "test" },
      provenance: { _tag: "system", component: "test" },
      summary: "seed",
      subject: null,
    },
    upserts: [
      {
        _tag: "mission",
        record: {
          ...mission,
          id: otherMission,
          slug: "m-2",
          masterRoleId: RoleId.make("m2-master"),
        },
      },
      { _tag: "role", record: { ...role("m2-master", "master"), missionId: otherMission } },
      { _tag: "role-binding", record: binding("b-m2-master", "m2-master", otherMaster) },
    ],
  });
});

describe("mission boundaries", () => {
  it.effect("posts cannot address or deliver to a thread outside the mission", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const router = yield* MissionRouter.MissionRouter;
      for (const provenance of [agent(masterThread), ownerApp]) {
        const code = yield* failureCode(
          router.post(
            request("hello neighbour", { to: [{ _tag: "thread", threadId: otherMaster }] }),
            provenance,
          ),
        );
        assert.strictEqual(code, "forbidden");
      }
      const ghostRole = yield* failureCode(
        router.post(
          request("hello role", { to: [{ _tag: "role", roleId: RoleId.make("m2-master") }] }),
          agent(masterThread),
        ),
      );
      assert.strictEqual(ghostRole, "not-found");
      assert.deepStrictEqual(
        h.sent.filter((each) => each.threadId === otherMaster),
        [],
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the master cannot subscribe a foreign thread to wake it with room traffic", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const router = yield* MissionRouter.MissionRouter;
      const code = yield* failureCode(
        router.subscribe(
          {
            roomId: control,
            subscriber: { _tag: "thread", threadId: otherMaster },
            mode: "wake",
          },
          agent(masterThread),
        ),
      );
      assert.strictEqual(code, "forbidden");
      yield* router.post({ ...request("broadcast"), kind: "control" }, agent(masterThread));
      assert.deepStrictEqual(
        h.sent.filter((each) => each.threadId === otherMaster),
        [],
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("knocks are only forwarded to threads of the knock's mission", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const router = yield* MissionRouter.MissionRouter;
      const outcome = yield* router.guard(guardRequest(fromThread(strayThread), laneThread));
      if (outcome._tag !== "knocked") return assert.fail("expected a knock");
      for (const provenance of [agent(masterThread), ownerApp]) {
        const code = yield* failureCode(
          router.decideKnock(
            {
              knockId: outcome.knockId,
              action: "forward",
              forwardTo: { _tag: "thread", threadId: otherMaster },
            },
            provenance,
          ),
        );
        assert.strictEqual(code, "forbidden");
      }
      assert.deepStrictEqual(h.sent, []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("only the owner attaches another mission's thread", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const router = yield* MissionRouter.MissionRouter;
      const attach = (provenance: MissionProvenance) =>
        router.setMember(
          { missionId, principal: { _tag: "thread", threadId: otherMaster }, member: true },
          provenance,
        );
      assert.strictEqual(yield* failureCode(attach(agent(masterThread))), "forbidden");
      // The master manages its own mission's registrations.
      yield* router.setMember(
        { missionId, principal: { _tag: "thread", threadId: strayThread }, member: true },
        agent(masterThread),
      );
      yield* attach(ownerApp);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("an unreadable target thread fails the guard instead of passing", () => {
    const h = harness();
    const unknown = ThreadId.make("t-unreadable");
    h.unreadable.add(unknown);
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const code = yield* failureCode(router.guard(guardRequest(fromThread(strayThread), unknown)));
      assert.strictEqual(code, "conflict");
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

  it.effect("a blocker escalated to the master wakes it; one left in the room does not", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const master = { _tag: "role", roleId: RoleId.make("role-master") } as const;
      yield* router.subscribe(
        { roomId: control, subscriber: master, mode: "wake", wakeOn: ["blocker"] },
        ownerApp,
      );
      yield* router.post(
        { missionId, roomId: control, kind: "blocker", summary: "CI is red on main" },
        agent(laneThread),
      );
      assert.deepStrictEqual(wakesFor(h.sent, masterThread), []);
      yield* router.post(
        {
          missionId,
          roomId: control,
          kind: "blocker",
          summary: "Need a call on the schema change",
          to: [master],
        },
        agent(laneThread),
      );
      assert.strictEqual(wakesFor(h.sent, masterThread).length, 1);
      const inbox = yield* router.inbox(masterThread);
      assert.deepStrictEqual(
        inbox.entries.map((entry) => entry.message.summary),
        ["Need a call on the schema change"],
      );
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

  it.effect("a routed answer keeps the submitted values, and so does a knock", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const store = yield* MissionStore.MissionStore;
      const text = answerText({
        requestId: "req-1",
        questions: [
          {
            id: "env",
            header: "Environment",
            question: "Where should it deploy?",
            options: [{ label: "dev", description: "" }],
          },
        ],
        answers: { env: "dev", confirm: true },
      });
      const answer = (from: SendSender, key: string): SendGuardRequest => ({
        path: "request-respond",
        targetThreadId: masterThread,
        from,
        text,
        requestKey: key,
      });
      const routed = yield* router.guard(answer(fromThread(laneThread), "answer:1"));
      if (routed._tag !== "routed") return assert.fail("expected a routed answer");
      const body = yield* router.messageBody({ messageId: routed.messageId }, ownerApp);
      assert.include(body.body, "Environment (Where should it deploy?): dev");
      assert.include(body.body, "confirm: true");
      const knocked = yield* router.guard(answer(fromThread(strayThread), "answer:2"));
      if (knocked._tag !== "knocked") return assert.fail("expected a knock");
      const knock = Option.getOrThrow(yield* store.get("knock", knocked.knockId));
      assert.strictEqual(knock.body, text);
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

describe("room tuning", () => {
  const writerRule = {
    subscriber: { _tag: "role", roleId: RoleId.make("role-writer") },
    mode: "wake",
    wakeOn: ["request"],
  } as const;

  it.effect("a muted room wakes only the actors a message names", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const tuned = yield* router.tuneRoom(
        { roomId: control, muted: true, rules: [writerRule] },
        agent(masterThread),
      );
      assert.strictEqual(tuned.muted, true);
      assert.deepStrictEqual(
        tuned.subscriptions.map((sub) => [sub.subscriber, sub.mode, sub.wakeOn]),
        [[writerRule.subscriber, "wake", ["request"]]],
      );
      yield* router.post(request("anyone?"), agent(laneThread));
      assert.deepStrictEqual(wakesFor(h.sent, writerThread), []);
      yield* router.post(request("writer, this one", { to: toWriter }), agent(laneThread));
      assert.strictEqual(wakesFor(h.sent, writerThread).length, 1);
      yield* router.markRead({ roomId: control, seq: 2 }, agent(writerThread));
      yield* router.settled(writerThread);

      yield* router.tuneRoom({ roomId: control, muted: false }, ownerApp);
      yield* router.post(request("anyone now?"), agent(laneThread));
      assert.strictEqual(wakesFor(h.sent, writerThread).length, 2);

      const read = yield* router.roomTuning({ roomId: control }, agent(laneThread));
      assert.strictEqual(read.muted, false);
      assert.strictEqual(read.subscriptions.length, 1);
      const events = yield* (yield* MissionStore.MissionStore).eventsSince(missionId, 0);
      assert.deepStrictEqual(
        events.filter((event) => event.kind === "room.tuned").map((event) => event.payload),
        [
          { muted: true, rules: [{ ...writerRule, wakeOn: ["request"] }] },
          { muted: false, rules: [] },
        ],
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("only the owner or the master tunes, with one rule per subscriber", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      assert.strictEqual(
        yield* failureCode(router.tuneRoom({ roomId: control, muted: true }, agent(laneThread))),
        "forbidden",
      );
      assert.strictEqual(
        yield* failureCode(
          router.tuneRoom({ roomId: control, rules: [writerRule, writerRule] }, ownerApp),
        ),
        "invalid",
      );
      assert.strictEqual(
        yield* failureCode(router.tuneRoom({ roomId: control }, ownerApp)),
        "invalid",
      );
      assert.strictEqual(
        yield* failureCode(
          router.tuneRoom(
            {
              roomId: control,
              rules: [{ subscriber: { _tag: "thread", threadId: strayThread }, mode: "wake" }],
            },
            agent(masterThread),
          ),
        ),
        "forbidden",
      );
    }).pipe(Effect.provide(h.layer));
  });
});

describe("reminders", () => {
  const remindersFor = (sent: ReadonlyArray<Sent>, threadId: ThreadId) =>
    sent.filter((each) => each.threadId === threadId && each.key.startsWith("mission-remind:"));

  it.effect("an idle thread gets one reminder per delivery, then the master sees it", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      yield* router.post(request("review my draft", { to: toWriter }), agent(laneThread));
      assert.strictEqual(yield* router.remind, 0);

      yield* TestClock.adjust("31 minutes");
      h.activity.set(writerThread, "running");
      assert.strictEqual(yield* router.remind, 0);
      h.activity.set(writerThread, "idle");
      assert.strictEqual(yield* router.remind, 1);
      const [reminder] = remindersFor(h.sent, writerThread);
      assert.include(reminder?.text ?? "", "unread for over 30 minutes");
      assert.strictEqual(yield* router.remind, 0);

      yield* TestClock.adjust("31 minutes");
      assert.strictEqual(yield* router.remind, 0);
      assert.strictEqual(remindersFor(h.sent, writerThread).length, 1);

      const view = yield* router.attention({ missionId }, agent(masterThread));
      assert.deepStrictEqual(
        view.entries.map((entry) => [entry.threadId, entry.message.summary]),
        [[writerThread, "review my draft"]],
      );
      assert.strictEqual(
        yield* failureCode(router.attention({ missionId }, agent(laneThread))),
        "forbidden",
      );

      yield* router.markRead({ roomId: control, seq: 1 }, agent(writerThread));
      assert.deepStrictEqual((yield* router.attention({ missionId }, ownerApp)).entries, []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a thread is reminded at most once per 30 minutes", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      yield* router.post(request("first", { to: toWriter }), agent(laneThread));
      yield* TestClock.adjust("20 minutes");
      yield* router.post(request("second", { to: toWriter }), agent(laneThread));
      yield* TestClock.adjust("11 minutes");
      assert.strictEqual(yield* router.remind, 1);
      yield* TestClock.adjust("20 minutes");
      // "second" is now stale too, but the last reminder was 20 minutes ago.
      assert.strictEqual(yield* router.remind, 0);
      yield* TestClock.adjust("11 minutes");
      assert.strictEqual(yield* router.remind, 1);
      assert.strictEqual(remindersFor(h.sent, writerThread).length, 2);
      yield* TestClock.adjust("31 minutes");
      assert.strictEqual(yield* router.remind, 0);
    }).pipe(Effect.provide(h.layer));
  });
});

// --- router additions: r3 ---
describe("system delivery", () => {
  it.effect("readiness reads idle, busy and gone without failing", () => {
    const h = harness();
    const archived = ThreadId.make("t-archived");
    const gone = ThreadId.make("t-gone");
    const unreadable = ThreadId.make("t-unreadable");
    h.activity.set(laneThread, "running");
    h.archived.add(archived);
    h.gone.add(gone);
    h.unreadable.add(unreadable);
    return Effect.gen(function* () {
      const router = yield* MissionRouter.MissionRouter;
      assert.strictEqual(yield* router.readiness(masterThread), "idle");
      assert.strictEqual(yield* router.readiness(laneThread), "busy");
      assert.strictEqual(yield* router.readiness(archived), "gone");
      assert.strictEqual(yield* router.readiness(gone), "gone");
      assert.strictEqual(yield* router.readiness(unreadable), "busy");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a member's notice goes through its control room and rings its doorbell once", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const notice = {
        threadId: writerThread,
        text: "Your last turn was cut off by a restart. Pick up where you left off.",
        key: "incident-1:m-1:t-writer",
        producer: "stream-recovery",
      };
      const outcome = yield* router.notify(notice);
      if (outcome._tag !== "posted") return assert.fail("expected a posted notice");
      assert.strictEqual(outcome.missionId, missionId);
      const page = yield* router.roomPage({ roomId: control }, ownerApp);
      assert.strictEqual(page.messages.length, 1);
      assert.deepStrictEqual(page.messages[0]!.author, {
        _tag: "system",
        component: "stream-recovery",
      });
      assert.deepStrictEqual(page.messages[0]!.to, [{ _tag: "thread", threadId: writerThread }]);
      assert.strictEqual(wakesFor(h.sent, writerThread).length, 1);
      // A retry lands on the same message and rings nothing new.
      assert.deepStrictEqual(yield* router.notify(notice), outcome);
      assert.strictEqual(wakesFor(h.sent, writerThread).length, 1);
      assert.strictEqual(h.sent.length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a non-member's notice is queued directly; a gone thread is not found", () => {
    const h = harness();
    const gone = ThreadId.make("t-gone");
    h.gone.add(gone);
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const outcome = yield* router.notify({
        threadId: strayThread,
        text: "Resume.",
        key: "incident-1:none:t-stray",
        producer: "stream-recovery",
      });
      assert.deepStrictEqual(outcome, { _tag: "sent" });
      assert.deepStrictEqual(h.sent, [
        {
          threadId: strayThread,
          text: "Resume.",
          key: "recovery:incident-1:none:t-stray",
          asOwner: false,
        },
      ]);
      const code = yield* failureCode(
        router.notify({ threadId: gone, text: "Resume.", key: "k", producer: "stream-recovery" }),
      );
      assert.strictEqual(code, "not-found");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a retried notice rings the doorbell its first attempt failed to ring", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const notice = {
        threadId: writerThread,
        text: "Your last turn was cut off by a restart.",
        key: "incident-2:m-1:t-writer",
        producer: "stream-recovery",
      };
      // The message commits but the ring fails.
      h.refuseSend.add(writerThread);
      const first = yield* router.notify(notice);
      assert.strictEqual(first._tag, "posted");
      assert.deepStrictEqual(wakesFor(h.sent, writerThread), []);
      // Recovery retries the same notice: same message, and now the ring.
      h.refuseSend.delete(writerThread);
      assert.deepStrictEqual(yield* router.notify(notice), first);
      assert.strictEqual(wakesFor(h.sent, writerThread).length, 1);
      const page = yield* router.roomPage({ roomId: control }, ownerApp);
      assert.strictEqual(page.messages.length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a retried notice takes its first route, whatever the membership is by then", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const stray = { _tag: "thread", threadId: strayThread } as const;
      const direct = {
        threadId: strayThread,
        text: "Resume.",
        key: "incident-3:none:t-stray",
        producer: "stream-recovery",
      };
      // Queued directly; the thread joins; the retry is queued under the same key, not posted.
      assert.deepStrictEqual(yield* router.notify(direct), { _tag: "sent" });
      yield* router.setMember({ missionId, principal: stray, member: true }, ownerApp);
      assert.deepStrictEqual(yield* router.notify(direct), { _tag: "sent" });
      const keys = h.sent.filter((sent) => sent.text === "Resume.").map((sent) => sent.key);
      assert.deepStrictEqual(keys, [
        "recovery:incident-3:none:t-stray",
        "recovery:incident-3:none:t-stray",
      ]);
      // Posted while a member; the thread leaves; the retry lands on the same post.
      const posted = { ...direct, text: "Pick up.", key: "incident-4:m-1:t-stray" };
      const first = yield* router.notify(posted);
      assert.strictEqual(first._tag, "posted");
      yield* router.setMember({ missionId, principal: stray, member: false }, ownerApp);
      assert.deepStrictEqual(yield* router.notify(posted), first);
      assert.deepStrictEqual(
        h.sent.filter((sent) => sent.text === "Pick up."),
        [],
      );
    }).pipe(Effect.provide(h.layer));
  });
});
// --- end router additions ---

describe("router round 5", () => {
  it.effect("a removed actor stays out: the import and the actor cannot add it back", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const coordActor = { _tag: "coord", actor: "coord-reviewer" } as const;
      const legacy = { _tag: "thread", threadId: strayThread } as const;
      const importing: MissionProvenance = { _tag: "import", source: "coord.db" };
      // The import enrols a coord actor; the owner removes it; a re-import cannot undo that.
      yield* router.setMember({ missionId, principal: coordActor, member: true }, importing);
      yield* router.setMember({ missionId, principal: coordActor, member: false }, ownerApp);
      assert.strictEqual(
        yield* failureCode(
          router.setMember({ missionId, principal: coordActor, member: true }, importing),
        ),
        "forbidden",
      );
      // The owner detaches the master's own thread; the master cannot re-add itself.
      const self = { _tag: "thread", threadId: masterThread } as const;
      yield* router.setMember({ missionId, principal: self, member: true }, ownerApp);
      yield* router.setMember({ missionId, principal: self, member: false }, ownerApp);
      assert.strictEqual(
        yield* failureCode(
          router.setMember({ missionId, principal: self, member: true }, agent(masterThread)),
        ),
        "forbidden",
      );
      // The master still re-adds a thread it detached; the owner re-adds anyone.
      yield* router.setMember({ missionId, principal: legacy, member: true }, agent(masterThread));
      yield* router.setMember({ missionId, principal: legacy, member: false }, agent(masterThread));
      yield* router.setMember({ missionId, principal: legacy, member: true }, agent(masterThread));
      yield* router.setMember({ missionId, principal: coordActor, member: true }, ownerApp);
      yield* router.setMember({ missionId, principal: self, member: true }, ownerApp);
      const changed = (yield* (yield* MissionStore.MissionStore).eventsSince(missionId, 0)).filter(
        (event) => event.kind === "member.changed",
      );
      assert.strictEqual(changed.length, 9);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the room list counts every message and what the owner has not read", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      // More than one room page (50) of messages from the master, and two from the owner.
      for (let index = 0; index < 60; index += 1) {
        yield* router.post({ ...request(`status ${index}`), kind: "status" }, agent(masterThread));
      }
      yield* router.post(request("owner one"), ownerApp);
      yield* router.post(request("owner two"), ownerApp);
      const listed = (yield* router.rooms(missionId, ownerApp)).find((room) => room.id === control);
      assert.strictEqual(listed?.messageCount, 62);
      assert.strictEqual(listed?.unreadForOwner, 60);
      // Reading up to the 30th message leaves the rest unread.
      yield* router.markRead({ roomId: control, seq: 30 }, ownerApp);
      const after = (yield* router.rooms(missionId, ownerApp)).find((room) => room.id === control);
      assert.strictEqual(after?.messageCount, 62);
      assert.strictEqual(after?.unreadForOwner, 30);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a room page names everyone on it and lists who is in the room", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      // Nobody subscribed: the master wakes the lane by name, the lane answers.
      yield* router.post(
        request("API, rebase please", { to: [{ _tag: "lane", laneId: lane.id }] }),
        agent(masterThread),
      );
      yield* router.post({ ...request("rebased"), kind: "status" }, agent(laneThread));
      yield* router.post(request("thanks"), ownerApp);
      const page = yield* router.roomPage({ roomId: control }, ownerApp);
      assert.deepStrictEqual(page.subscriptions, []);
      assert.deepStrictEqual(page.members, [
        { _tag: "lane", laneId: lane.id },
        { _tag: "role", roleId: RoleId.make("role-master") },
      ]);
      assert.deepStrictEqual(page.names, {
        [`lane:${lane.id}`]: "API",
        "role:role-master": "role-master",
        [`thread:${masterThread}`]: "role-master",
        [`thread:${laneThread}`]: "API",
      });
    }).pipe(Effect.provide(h.layer));
  });
});
