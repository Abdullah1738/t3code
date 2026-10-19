import { OwnerRequestId, RoleId, ThreadId, type MissionProvenance } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import {
  agent,
  failureCode,
  governor,
  laneThread,
  masterThread,
  missionId,
  otherMissionId,
  ownerApp,
  seed,
  seedOther,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import { makeReads } from "../core/reads.ts";
import { OwnerConditions } from "../discuss/OwnerConditions.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as ViewStore from "../views/ViewStore.ts";
import * as MissionRouter from "./MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes, type Sent } from "./MissionRouter.testkit.ts";

const harness = () => {
  const threads = fakeRouterThreads();
  const layer = routerOverFakes(threads).pipe(
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return { ...threads, layer };
};

const master = agent(masterThread);

/** The discuss port the way the server wires it, over the test router. */
const ownerConditionsOverRouter = Layer.effect(
  OwnerConditions,
  Effect.map(MissionRouter.MissionRouter, (router) =>
    OwnerConditions.of({
      verify: router.verifyOwnerCondition,
      settleFor: router.settleRequestsFor,
    }),
  ),
);
const masterRole = { _tag: "role", roleId: RoleId.make("role-master") } as const;
const ownerIMessage: MissionProvenance = {
  _tag: "owner-imessage",
  chat: "owner",
  inboundId: "msg-1",
};

const wakesFor = (sent: ReadonlyArray<Sent>, threadId: ThreadId) =>
  sent.filter((each) => each.threadId === threadId && each.key.startsWith("mission-wake:"));

const requestEvents = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const events = yield* store.eventsSince(missionId, 0);
  return events.filter((event) => event.kind.startsWith("request."));
});

/** The master reads its request room to the end, as it would before answering. */
const masterReads = (
  roomId: Parameters<MissionRouter.MissionRouter["Service"]["markRead"]>[0]["roomId"],
) =>
  Effect.gen(function* () {
    const router = yield* MissionRouter.MissionRouter;
    yield* router.markRead({ roomId, seq: 1_000_000 }, master);
    yield* router.settled(masterThread);
  });

describe("owner requests", () => {
  it.effect("the owner's request wakes the master with the whole request", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const text =
        "How is the API lane doing?\nAlso: can we fold the two release checks into one flow, and pick up the flaky deploy test?";
      const request = yield* router.openRequest({ missionId, text }, ownerApp);
      assert.strictEqual(request.status, "waiting-on-master");
      assert.strictEqual(request.title, "How is the API lane doing?");
      assert.isFalse(request.unreadForOwner);
      assert.deepStrictEqual(request.createdBy, ownerApp);

      const wakes = wakesFor(h.sent, masterThread);
      assert.strictEqual(wakes.length, 1);
      assert.include(wakes[0]!.text, `Owner request ${request.id}`);
      assert.include(wakes[0]!.text, "pick up the flaky deploy test?");
      assert.include(wakes[0]!.text, "mission_request_reply");
      // Nobody else hears about it.
      assert.deepStrictEqual(
        h.sent.filter((each) => each.threadId !== masterThread),
        [],
      );

      const events = yield* requestEvents;
      assert.deepStrictEqual(
        events.map((event) => [event.kind, event.actor]),
        [["request.opened", { _tag: "owner" }]],
      );
      // The request room is not one of the mission's rooms; it lives on the board.
      const rooms = yield* router.rooms(missionId, ownerApp);
      assert.isFalse(rooms.some((room) => room.id === request.roomId));
      const inbox = yield* router.inbox(masterThread);
      assert.strictEqual(inbox.unread, 1);
      assert.include(inbox.entries[0]!.requestContext ?? "", "flaky deploy test");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a reply after several rounds carries every earlier message to the master", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const request = yield* router.openRequest(
        { missionId, text: "Optimise the review flow: reviews wait hours." },
        ownerApp,
      );
      yield* masterReads(request.roomId);
      yield* router.replyRequest(
        {
          requestId: request.id,
          text: "Reviews wait on the writer lane; I can batch them twice a day.",
          status: "answered",
        },
        master,
      );
      yield* router.replyRequest(
        { requestId: request.id, text: "Batching is fine, but keep hotfixes immediate." },
        ownerIMessage,
      );
      yield* masterReads(request.roomId);
      yield* router.replyRequest(
        {
          requestId: request.id,
          text: "Hotfixes skip the batch. Starting now.",
          status: "waiting-on-master",
        },
        master,
      );
      yield* router.replyRequest(
        { requestId: request.id, text: "And tell me when the first batch ran." },
        ownerApp,
      );

      const wakes = wakesFor(h.sent, masterThread);
      assert.strictEqual(wakes.length, 3);
      const last = wakes[2]!.text;
      for (const said of [
        "Optimise the review flow: reviews wait hours.",
        "Reviews wait on the writer lane; I can batch them twice a day.",
        "Batching is fine, but keep hotfixes immediate.",
        "Hotfixes skip the batch. Starting now.",
        "And tell me when the first batch ran.",
      ]) {
        assert.include(last, said);
      }
      assert.notInclude(last, "elided");
      const latest = (yield* router.ownerRequests({ missionId, requestId: request.id }, ownerApp))
        .requests[0]!;
      assert.strictEqual(latest.request.status, "waiting-on-master");
      assert.strictEqual(latest.messages.length, 5);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the master's reply wakes nobody and waits, unread, for the owner", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const store = yield* MissionStore.MissionStore;
      const reads = makeReads(store, () => null);
      const request = yield* router.openRequest(
        { missionId, text: "Any suggestions for the next sprint?" },
        ownerApp,
      );
      yield* masterReads(request.roomId);
      const sentBefore = h.sent.length;
      const answered = yield* router.replyRequest(
        {
          requestId: request.id,
          text: "Two: split the API lane, and add a release rehearsal.",
          links: [
            { kind: "work-item", id: "wi-free", label: "Release rehearsal" },
            { kind: "work-item", id: "wi-free" },
          ],
        },
        master,
      );
      assert.strictEqual(h.sent.length, sentBefore);
      assert.strictEqual(answered.status, "answered");
      assert.isTrue(answered.unreadForOwner);
      assert.strictEqual(answered.links.length, 1);
      assert.strictEqual((yield* reads.overview(missionId)).requestsAnswered, 1);
      const listed = (yield* reads.listSnapshot).missions.find((each) => each.id === missionId);
      assert.strictEqual(listed?.requestsAnswered, 1);

      // Opening the request to its end clears it.
      const page = yield* router.roomPage({ roomId: request.roomId }, ownerApp);
      yield* router.markRead({ roomId: request.roomId, seq: page.room.lastSeq }, ownerApp);
      const [view] = (yield* router.ownerRequests({ missionId }, ownerApp)).requests;
      assert.isFalse(view!.unreadForOwner);
      assert.strictEqual((yield* reads.overview(missionId)).requestsAnswered, 0);
      const events = yield* requestEvents;
      assert.deepStrictEqual(
        events.map((event) => [event.kind, event.actor]),
        [
          ["request.opened", { _tag: "owner" }],
          ["request.replied", masterRole],
          ["request.seen", { _tag: "owner" }],
        ],
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("only the owner and the master touch requests", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const writer = agent(writerThread);
      const lane = agent(laneThread);
      assert.strictEqual(
        yield* failureCode(router.openRequest({ missionId, text: "Ship it today" }, writer)),
        "forbidden",
      );
      assert.strictEqual(
        yield* failureCode(
          router.openRequest({ missionId, text: "Ship it today", quotedFrom: "his thread" }, lane),
        ),
        "forbidden",
      );
      assert.strictEqual(
        yield* failureCode(router.openRequest({ missionId, text: "Ship it today" }, governor)),
        "provenance-required",
      );
      const request = yield* router.openRequest({ missionId, text: "Status?" }, ownerApp);
      for (const caller of [writer, lane]) {
        assert.strictEqual(
          yield* failureCode(
            router.replyRequest(
              { requestId: request.id, text: "All good", status: "answered" },
              caller,
            ),
          ),
          "forbidden",
        );
        assert.strictEqual(
          yield* failureCode(router.settleRequest({ requestId: request.id }, caller)),
          "forbidden",
        );
        assert.strictEqual(
          yield* failureCode(router.ownerRequests({ missionId }, caller)),
          "forbidden",
        );
        assert.strictEqual(
          yield* failureCode(router.roomPage({ roomId: request.roomId }, caller)),
          "forbidden",
        );
      }
      // Nobody posts into a request room around the request tools, the owner included.
      assert.strictEqual(
        yield* failureCode(
          router.post(
            { missionId, roomId: request.roomId, kind: "status", summary: "sneaking in" },
            master,
          ),
        ),
        "forbidden",
      );
      // The owner does not set status or links; that is the master's answer.
      assert.strictEqual(
        yield* failureCode(
          router.replyRequest(
            { requestId: request.id, text: "done", status: "answered" },
            ownerApp,
          ),
        ),
        "invalid",
      );
      assert.strictEqual(wakesFor(h.sent, writerThread).length, 0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("both sides settle and reopen, and the log says who", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const request = yield* router.openRequest(
        { missionId, text: "Pick up the docs fix" },
        ownerApp,
      );
      yield* masterReads(request.roomId);

      const settled = yield* router.settleRequest({ requestId: request.id }, ownerApp);
      assert.strictEqual(settled.status, "settled");
      assert.deepStrictEqual(settled.settledBy, { _tag: "owner" });
      // Settling twice changes nothing.
      yield* router.settleRequest({ requestId: request.id }, master);
      assert.strictEqual(
        yield* failureCode(
          router.replyRequest({ requestId: request.id, text: "one more thing" }, ownerApp),
        ),
        "conflict",
      );

      const reopened = yield* router.reopenRequest({ requestId: request.id }, master);
      assert.strictEqual(reopened.status, "waiting-on-master");
      assert.isNull(reopened.settledBy);
      const wakesBefore = wakesFor(h.sent, masterThread).length;
      yield* router.settleRequest(
        { requestId: request.id, note: "Docs fix merged; closing." },
        master,
      );
      const byMaster = (yield* router.ownerRequests({ missionId }, ownerApp)).requests[0]!;
      assert.strictEqual(byMaster.request.status, "settled");
      assert.deepStrictEqual(byMaster.request.settledBy, masterRole);
      assert.isTrue(byMaster.unreadForOwner);

      // The owner reopening is the owner speaking: the master wakes with it all.
      yield* router.reopenRequest(
        { requestId: request.id, note: "The merged fix missed the API page." },
        ownerApp,
      );
      const wakes = wakesFor(h.sent, masterThread);
      assert.strictEqual(wakes.length, wakesBefore + 1);
      assert.include(wakes.at(-1)!.text, "Pick up the docs fix");
      assert.include(wakes.at(-1)!.text, "Docs fix merged; closing.");
      assert.include(wakes.at(-1)!.text, "The merged fix missed the API page.");

      const events = yield* requestEvents;
      assert.deepStrictEqual(
        events.map((event) => [event.kind, event.actor]),
        [
          ["request.opened", { _tag: "owner" }],
          ["request.settled", { _tag: "owner" }],
          ["request.reopened", masterRole],
          ["request.settled", masterRole],
          ["request.reopened", { _tag: "owner" }],
        ],
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the master opens one for the owner, quoting him, without waking itself", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      assert.strictEqual(
        yield* failureCode(router.openRequest({ missionId, text: "Move the launch?" }, master)),
        "invalid",
      );
      assert.strictEqual(
        yield* failureCode(
          router.openRequest(
            { missionId, text: "Move the launch?", quotedFrom: "iMessage" },
            ownerApp,
          ),
        ),
        "invalid",
      );
      const request = yield* router.openRequest(
        { missionId, text: "Move the launch to Thursday?", quotedFrom: "iMessage, 19 Oct" },
        master,
      );
      assert.strictEqual(request.status, "waiting-on-master");
      assert.isTrue(request.unreadForOwner);
      assert.deepStrictEqual(request.createdBy, master);
      assert.strictEqual(wakesFor(h.sent, masterThread).length, 0);
      const view = (yield* router.ownerRequests({ missionId, requestId: request.id }, ownerApp))
        .requests[0]!;
      assert.include(view.messages[0]!.body ?? "", "quoting what he said in iMessage, 19 Oct");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("requests never carry a default or a deadline", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const request = yield* router.openRequest(
        { missionId, text: "Can we drop the beta?" },
        ownerApp,
      );
      assert.strictEqual(
        yield* failureCode(
          router.replyRequest(
            {
              requestId: request.id,
              text: "I will drop it tomorrow unless you say otherwise.",
            },
            master,
          ),
        ),
        "invalid",
      );
      assert.strictEqual((yield* requestEvents).length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a keyed open or reply lands once", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const first = yield* router.openRequest(
        { missionId, text: "Status?", key: "imessage:a" },
        ownerApp,
      );
      const again = yield* router.openRequest(
        { missionId, text: "Status?", key: "imessage:a" },
        ownerApp,
      );
      assert.strictEqual(again.id, first.id);
      assert.strictEqual(wakesFor(h.sent, masterThread).length, 1);
      yield* router.replyRequest(
        { requestId: first.id, text: "Also the docs?", key: "b" },
        ownerApp,
      );
      const afterReply = wakesFor(h.sent, masterThread).length;
      yield* router.replyRequest(
        { requestId: first.id, text: "Also the docs?", key: "b" },
        ownerApp,
      );
      assert.deepStrictEqual(
        (yield* requestEvents).map((event) => event.kind),
        ["request.opened", "request.replied"],
      );
      // The retry rings nothing new.
      assert.strictEqual(wakesFor(h.sent, masterThread).length, afterReply);
      assert.strictEqual(
        yield* failureCode(
          router.replyRequest(
            { requestId: OwnerRequestId.make("request-missing"), text: "?" },
            ownerApp,
          ),
        ),
        "not-found",
      );
      // A key retried with other words is refused, not dropped.
      assert.strictEqual(
        yield* failureCode(
          router.replyRequest(
            { requestId: first.id, text: "Actually, skip the docs.", key: "b" },
            ownerApp,
          ),
        ),
        "conflict",
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("one iMessage writes once: one request, one mission", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const router = yield* MissionRouter.MissionRouter;
      const opened = yield* router.openRequest({ missionId, text: "Status?" }, ownerIMessage);
      const retried = yield* router.openRequest({ missionId, text: "Status?" }, ownerIMessage);
      assert.strictEqual(retried.id, opened.id);
      assert.strictEqual(wakesFor(h.sent, masterThread).length, 1);
      const other = yield* router.openRequest({ missionId, text: "Docs?" }, ownerApp);
      yield* router.settled(masterThread);

      const refusals = [
        // The same message cannot open a request in another mission...
        router.openRequest({ missionId: otherMissionId, text: "Status?" }, ownerIMessage),
        // ...or a second request here...
        router.openRequest({ missionId, text: "Something else" }, ownerIMessage),
        // ...or be posted as the owner's reply on another request.
        router.replyRequest({ requestId: other.id, text: "Status?" }, ownerIMessage),
        router.settleRequest({ requestId: other.id, note: "Status?" }, ownerIMessage),
      ];
      for (const refused of refusals) {
        assert.strictEqual(yield* failureCode(refused), "conflict");
      }
      assert.strictEqual(wakesFor(h.sent, masterThread).length, 2);
      assert.deepStrictEqual(
        (yield* requestEvents).map((event) => event.kind),
        ["request.opened", "request.opened"],
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("every unread answer counts, however many read ones are newer", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const store = yield* MissionStore.MissionStore;
      const reads = makeReads(store, () => null);
      const request = yield* router.openRequest({ missionId, text: "Status?" }, ownerApp);
      const unread = yield* router.replyRequest({ requestId: request.id, text: "Fine." }, master);
      assert.isTrue(unread.unreadForOwner);
      // Answers the owner already read stay "answered" until settled, and pile up.
      yield* store.commit({
        event: {
          missionId,
          kind: "request.seen",
          actor: { _tag: "owner" },
          provenance: ownerApp,
          summary: "older answers the owner read",
          subject: null,
        },
        upserts: Array.from({ length: 205 }, (_, index) => ({
          _tag: "owner-request" as const,
          record: {
            ...unread,
            id: OwnerRequestId.make(`request-read-${index}`),
            unreadForOwner: false,
            updatedAt: "2999-01-01T00:00:00.000Z",
          },
        })),
      });
      assert.strictEqual((yield* reads.overview(missionId)).requestsAnswered, 1);
      const listed = (yield* reads.listSnapshot).missions.find((each) => each.id === missionId);
      assert.strictEqual(listed?.requestsAnswered, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a list carries summaries; one request asked for by id carries bodies", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const text = "How is the API lane doing?";
      const request = yield* router.openRequest({ missionId, text }, ownerApp);
      const listed = yield* router.ownerRequests({ missionId }, ownerApp);
      assert.strictEqual(listed.requests[0]?.messages[0]?.body, null);
      assert.strictEqual(listed.requests[0]?.messages[0]?.message.summary, text);
      const one = yield* router.ownerRequests({ missionId, requestId: request.id }, ownerApp);
      assert.strictEqual(one.requests[0]?.messages[0]?.body, text);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a reply links only records of the request's mission", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const router = yield* MissionRouter.MissionRouter;
      const request = yield* router.openRequest({ missionId, text: "Pick it up?" }, ownerApp);
      const answer = (
        links: ReadonlyArray<{
          kind: "work-item" | "lane" | "ask" | "mission" | "thread";
          id: string;
        }>,
      ) => router.replyRequest({ requestId: request.id, text: "On it.", links }, master);
      assert.strictEqual(
        yield* failureCode(answer([{ kind: "lane", id: "lane-other" }])),
        "invalid",
      );
      assert.strictEqual(
        yield* failureCode(answer([{ kind: "mission", id: otherMissionId }])),
        "invalid",
      );
      assert.strictEqual(
        yield* failureCode(answer([{ kind: "ask", id: "ask-missing" }])),
        "not-found",
      );
      const linked = yield* answer([
        { kind: "work-item", id: "wi-held" },
        { kind: "mission", id: missionId },
        { kind: "thread", id: "t-somewhere" },
      ]);
      assert.deepStrictEqual(
        linked.links.map((link) => link.id),
        ["wi-held", missionId, "t-somewhere"],
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the timeline never carries the owner's words", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const secret = "Quietly move the launch to Friday";
      const request = yield* router.openRequest({ missionId, text: secret }, ownerApp);
      yield* router.replyRequest({ requestId: request.id, text: "Moved." }, master);
      yield* router.markRead({ roomId: request.roomId, seq: 1_000 }, ownerApp);
      yield* router.settleRequest({ requestId: request.id }, ownerApp);
      yield* router.reopenRequest({ requestId: request.id }, ownerApp);
      const events = yield* requestEvents;
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        [
          "request.opened",
          "request.replied",
          "request.seen",
          "request.settled",
          "request.reopened",
        ],
      );
      for (const event of events) {
        assert.notInclude(event.summary, "launch");
        assert.notInclude(event.subject?.label ?? "", "launch");
      }
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a request room stays closed to agents other than the master", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const request = yield* router.openRequest({ missionId, text: "Status?" }, ownerApp);
      const writer = agent(writerThread);
      const page = yield* router.roomPage({ roomId: request.roomId }, master);
      const messageId = page.messages[0]!.id;
      const refusedForWriter = [
        failureCode(router.messageBody({ messageId }, writer)),
        failureCode(router.markRead({ roomId: request.roomId, seq: 1 }, writer)),
        failureCode(router.roomTuning({ roomId: request.roomId }, writer)),
        failureCode(
          router.subscribe(
            {
              roomId: request.roomId,
              subscriber: { _tag: "thread", threadId: writerThread },
              mode: "wake",
            },
            writer,
          ),
        ),
        failureCode(router.tuneRoom({ roomId: request.roomId, muted: true }, writer)),
      ];
      for (const refused of refusedForWriter) {
        assert.strictEqual(yield* refused, "forbidden");
      }
      // Its wake rules are fixed: the owner's words wake the master, nothing else does.
      assert.strictEqual(
        yield* failureCode(router.tuneRoom({ roomId: request.roomId, muted: true }, ownerApp)),
        "invalid",
      );
      assert.strictEqual(
        yield* failureCode(
          router.subscribe(
            {
              roomId: request.roomId,
              subscriber: { _tag: "thread", threadId: writerThread },
              mode: "wake",
            },
            master,
          ),
        ),
        "invalid",
      );
      assert.strictEqual((yield* router.messageBody({ messageId }, master)).body, "Status?");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a reminder about an owner request carries the conversation", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const request = yield* router.openRequest(
        { missionId, text: "Can we fold the release checks into one flow?" },
        ownerApp,
      );
      yield* router.settled(masterThread);
      yield* TestClock.adjust("31 minutes");
      assert.strictEqual(yield* router.remind, 1);
      const reminder = h.sent.find(
        (each) => each.threadId === masterThread && each.key.startsWith("mission-remind:"),
      );
      assert.include(reminder?.text ?? "", `Owner request ${request.id}`);
      assert.include(reminder?.text ?? "", "fold the release checks into one flow");
    }).pipe(Effect.provide(h.layer));
  });
});

describe("owner requests, router round 5", () => {
  it.effect("every post keeps the newest message on the request", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const opened = yield* router.openRequest(
        { missionId, text: "Can the   API lane\nship this week?" },
        ownerApp,
      );
      assert.strictEqual(opened.lastReply, "Can the API lane ship this week?");
      assert.deepStrictEqual(opened.lastReplyBy, { _tag: "owner" });
      const answered = yield* router.replyRequest(
        { requestId: opened.id, text: "x".repeat(400) },
        master,
      );
      assert.strictEqual(answered.lastReply?.length, 280);
      assert.isTrue(answered.lastReply?.endsWith("…"));
      assert.deepStrictEqual(answered.lastReplyBy, masterRole);
      const settled = yield* router.settleRequest(
        { requestId: opened.id, note: "Shipped Thursday." },
        master,
      );
      assert.strictEqual(settled.lastReply, "Shipped Thursday.");
      const reopened = yield* router.reopenRequest(
        { requestId: opened.id, note: "It missed the docs." },
        ownerApp,
      );
      assert.strictEqual(reopened.lastReply, "It missed the docs.");
      assert.deepStrictEqual(reopened.lastReplyBy, { _tag: "owner" });
      const [view] = (yield* router.ownerRequests({ missionId }, ownerApp)).requests;
      assert.strictEqual(view!.request.lastReply, "It missed the docs.");
      assert.strictEqual(view!.request.lastReplyAt, reopened.updatedAt);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the owner settling with a note wakes the master once; without one, nobody", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const quiet = yield* router.openRequest({ missionId, text: "Rename the lane" }, ownerApp);
      const noted = yield* router.openRequest({ missionId, text: "Drop the old flag" }, ownerApp);
      yield* masterReads(quiet.roomId);
      yield* masterReads(noted.roomId);
      const before = wakesFor(h.sent, masterThread).length;
      yield* router.settleRequest({ requestId: quiet.id }, ownerApp);
      assert.strictEqual(wakesFor(h.sent, masterThread).length, before);
      yield* router.settleRequest(
        { requestId: noted.id, note: "Done by hand, keep the flag doc." },
        ownerApp,
      );
      const wakes = wakesFor(h.sent, masterThread);
      assert.strictEqual(wakes.length, before + 1);
      assert.include(wakes.at(-1)!.text, "keep the flag doc");
      // Settling again does nothing and wakes nobody.
      yield* router.settleRequest({ requestId: noted.id, note: "again" }, ownerApp);
      assert.strictEqual(wakesFor(h.sent, masterThread).length, before + 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("unread counts follow unreadForOwner in every status, not 'answered'", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const store = yield* MissionStore.MissionStore;
      const reads = makeReads(store, () => null);
      const views = yield* ViewStore.ViewStore;
      const counts = Effect.gen(function* () {
        const overview = (yield* reads.overview(missionId)).requestsAnswered;
        const listed = (yield* reads.listSnapshot).missions.find((each) => each.id === missionId);
        return [overview, listed?.requestsAnswered, yield* views.requestsAnswered(missionId)];
      });
      const progress = yield* router.openRequest({ missionId, text: "Status on CI?" }, ownerApp);
      const closed = yield* router.openRequest({ missionId, text: "Close the spike" }, ownerApp);
      yield* masterReads(progress.roomId);
      yield* masterReads(closed.roomId);
      // A progress note (still waiting on the master) and a settle with a note are news.
      yield* router.replyRequest(
        { requestId: progress.id, text: "Half the jobs moved.", status: "waiting-on-master" },
        master,
      );
      yield* router.settleRequest({ requestId: closed.id, note: "Spike closed." }, master);
      assert.deepStrictEqual(yield* counts, [2, 2, 2]);
      // Reading one clears it.
      const page = yield* router.roomPage({ roomId: closed.roomId }, ownerApp);
      yield* router.markRead({ roomId: closed.roomId, seq: page.room.lastSeq }, ownerApp);
      assert.deepStrictEqual(yield* counts, [1, 1, 1]);
    }).pipe(Effect.provide(Layer.provideMerge(ViewStore.layer, h.layer)));
  });
});

describe("discuss", () => {
  const ask = { kind: "work-item", id: "wi-free" } as const;

  it.effect("one open request per record; the master reads the record and the whole talk", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const router = yield* MissionRouter.MissionRouter;
      // Only the owner, only records of this mission, never another request.
      assert.strictEqual(
        yield* failureCode(
          router.openRequest(
            { missionId, text: "About this", subject: ask, quotedFrom: "his thread" },
            master,
          ),
        ),
        "invalid",
      );
      assert.strictEqual(
        yield* failureCode(
          router.openRequest(
            { missionId, text: "Elsewhere", subject: { kind: "lane", id: "lane-other" } },
            ownerApp,
          ),
        ),
        "not-found",
      );
      assert.strictEqual(
        yield* failureCode(
          router.openRequest(
            { missionId, text: "Nothing", subject: { kind: "work-item", id: "wi-missing" } },
            ownerApp,
          ),
        ),
        "not-found",
      );
      const first = yield* router.openRequest(
        {
          missionId,
          text: "Why is this item still free?",
          subject: { ...ask, label: "a label the client made up" },
        },
        ownerApp,
      );
      // The label is the record's own, never the client's.
      assert.deepStrictEqual(first.subject, { ...ask, label: "Item wi-free" });
      const [opening] = (yield* router.roomPage({ roomId: first.roomId }, ownerApp)).messages;
      assert.strictEqual(
        yield* failureCode(
          router.openRequest(
            { missionId, text: "Meta", subject: { kind: "message", id: opening!.id } },
            ownerApp,
          ),
        ),
        "not-found",
      );
      assert.strictEqual(
        yield* failureCode(
          router.openRequest(
            { missionId, text: "Meta", subject: { kind: "owner-request", id: first.id } },
            ownerApp,
          ),
        ),
        "invalid",
      );
      yield* masterReads(first.roomId);
      yield* router.replyRequest({ requestId: first.id, text: "Nobody picked it." }, master);
      // Discuss again adds to the same request and wakes the master with all of it.
      const again = yield* router.openRequest(
        { missionId, text: "Then give it to the writer lane.", subject: ask },
        ownerApp,
      );
      assert.strictEqual(again.id, first.id);
      assert.strictEqual(again.status, "waiting-on-master");
      assert.strictEqual((yield* router.ownerRequests({ missionId }, ownerApp)).requests.length, 1);
      const wake = wakesFor(h.sent, masterThread).at(-1)!;
      assert.include(wake.text, "About: work-item wi-free (Item wi-free). Its status now: pr.");
      assert.include(wake.text, "Why is this item still free?");
      assert.include(wake.text, "Nobody picked it.");
      assert.include(wake.text, "Then give it to the writer lane.");
      // Settled, a new Discuss starts a new request.
      yield* router.settleRequest({ requestId: first.id }, ownerApp);
      const fresh = yield* router.openRequest(
        { missionId, text: "One more question on it.", subject: ask },
        ownerApp,
      );
      assert.notStrictEqual(fresh.id, first.id);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("verify needs the owner's own words in the request about that record", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const request = yield* router.openRequest(
        {
          missionId,
          text: "Fine to merge it,\n  as long as the  migration runs first. It's not fine to ship it today!",
          subject: ask,
        },
        ownerApp,
      );
      yield* router.replyRequest(
        { requestId: request.id, text: "Merge it whenever you like." },
        master,
      );
      // Moni's chat speaks as the owner, but her words are not his.
      yield* router.replyRequest(
        { requestId: request.id, text: "Ship it today." },
        { _tag: "owner-imessage", chat: "moni", inboundId: "moni-1" },
      );
      const conditions = yield* OwnerConditions;
      const verify = (quote: string, subject: typeof ask | { kind: "work-item"; id: string }) =>
        conditions.verify({ subject, condition: { requestId: request.id, quote } });
      // Whole sentences, whitespace and the closing mark aside.
      yield* verify("Fine to merge it, as long as the migration runs first", ask);
      yield* verify(
        "Fine to merge it, as long as the migration runs first. It's not fine to ship it today!",
        ask,
      );
      // A piece of a sentence can drop a "not".
      assert.strictEqual(yield* failureCode(verify("fine to ship it today", ask)), "forbidden");
      assert.strictEqual(
        yield* failureCode(verify("as long as the migration runs first", ask)),
        "forbidden",
      );
      // The master's words are not the owner's, nor are Moni's.
      assert.strictEqual(
        yield* failureCode(verify("Merge it whenever you like", ask)),
        "forbidden",
      );
      assert.strictEqual(yield* failureCode(verify("Ship it today.", ask)), "forbidden");
      // Not what he said.
      assert.strictEqual(yield* failureCode(verify("merge it now", ask)), "forbidden");
      // A question is not a condition; an ellipsis does not end his sentence.
      yield* router.replyRequest(
        { requestId: request.id, text: "Merge it now? Rebase it... no wait, leave it." },
        ownerApp,
      );
      assert.strictEqual(yield* failureCode(verify("Merge it now", ask)), "forbidden");
      assert.strictEqual(yield* failureCode(verify("Merge it now?", ask)), "forbidden");
      assert.strictEqual(yield* failureCode(verify("Rebase it", ask)), "forbidden");
      yield* verify("Rebase it... no wait, leave it", ask);
      // Another record.
      assert.strictEqual(
        yield* failureCode(
          verify("Fine to merge it, as long as the migration runs first", {
            kind: "work-item",
            id: "wi-held",
          }),
        ),
        "forbidden",
      );
      // No such request.
      assert.strictEqual(
        yield* failureCode(
          conditions.verify({
            subject: ask,
            condition: { requestId: OwnerRequestId.make("request-nope"), quote: "Fine" },
          }),
        ),
        "forbidden",
      );
    }).pipe(Effect.provide(Layer.provideMerge(ownerConditionsOverRouter, h.layer)));
  });

  it.effect("deciding the record settles its open request without waking anyone", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const conditions = yield* OwnerConditions;
      const request = yield* router.openRequest(
        { missionId, text: "Hold this until the audit.", subject: ask },
        ownerApp,
      );
      yield* masterReads(request.roomId);
      const sent = h.sent.length;
      // Nothing about another record settles.
      yield* conditions.settleFor({ subject: { kind: "work-item", id: "wi-held" }, note: null });
      assert.strictEqual(
        (yield* router.ownerRequests({ missionId }, ownerApp)).requests[0]!.request.status,
        "waiting-on-master",
      );
      yield* conditions.settleFor({ subject: ask, note: "Decided after the audit passed." });
      const [view] = (yield* router.ownerRequests({ missionId }, ownerApp)).requests;
      assert.strictEqual(view!.request.status, "settled");
      assert.deepStrictEqual(view!.request.settledBy, { _tag: "system", component: "discuss" });
      assert.strictEqual(view!.request.lastReply, "Decided after the audit passed.");
      // The note is news for the owner; nobody is woken.
      assert.strictEqual(view!.request.unreadForOwner, true);
      assert.strictEqual(h.sent.length, sent);
      // Again: nothing open, a no-op.
      yield* conditions.settleFor({ subject: ask, note: null });
      const events = yield* requestEvents;
      assert.strictEqual(events.filter((event) => event.kind === "request.settled").length, 1);
    }).pipe(Effect.provide(Layer.provideMerge(ownerConditionsOverRouter, h.layer)));
  });

  it.effect("a retried Discuss lands once, even after that request was settled", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const first = yield* router.openRequest(
        { missionId, text: "Why is this item still free?", subject: ask },
        ownerApp,
      );
      const discuss = { missionId, text: "Give it to the writer lane.", subject: ask, key: "k-1" };
      const added = yield* router.openRequest(discuss, ownerApp);
      assert.strictEqual(added.id, first.id);
      yield* router.settleRequest({ requestId: first.id }, ownerApp);
      // The retry finds the message it wrote; no second request with the same words.
      const retried = yield* router.openRequest(discuss, ownerApp);
      assert.strictEqual(retried.id, first.id);
      assert.strictEqual((yield* router.ownerRequests({ missionId }, ownerApp)).requests.length, 1);
      const opened = (yield* requestEvents).filter((event) => event.kind === "request.opened");
      assert.strictEqual(opened.length, 1);
      // The timeline names the record by kind and id, never by its words.
      assert.deepInclude(opened[0]!.payload, { requestId: first.id, about: ask });
    }).pipe(Effect.provide(h.layer));
  });
});

describe("who reads a request's words", () => {
  const wsClient: MissionProvenance = { _tag: "system", component: "ws-client" };
  const bridge: MissionProvenance = { _tag: "system", component: "spectrum-bridge" };

  it.effect("the owner, the master and the bridge; other readers see states only", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const text = "Is the migration safe to run?";
      const request = yield* router.openRequest({ missionId, text }, ownerApp);
      yield* router.replyRequest({ requestId: request.id, text: "Yes, it is." }, master);
      for (const reader of [ownerApp, master, bridge]) {
        const [view] = (yield* router.ownerRequests({ missionId }, reader)).requests;
        assert.strictEqual(view!.request.title, text);
        assert.strictEqual(view!.messages.length, 2);
      }
      const [stripped] = (yield* router.ownerRequests({ missionId }, wsClient)).requests;
      assert.strictEqual(stripped!.request.title, "Owner request");
      assert.strictEqual(stripped!.request.lastReply, null);
      assert.strictEqual(stripped!.request.lastReplyBy, null);
      assert.strictEqual(stripped!.request.lastReplyAt, null);
      assert.strictEqual(stripped!.request.status, "answered");
      assert.strictEqual(stripped!.unreadForOwner, true);
      assert.deepStrictEqual(stripped!.messages, []);
      assert.notInclude(JSON.stringify(stripped), "migration");
      // An owner-paired desk session reads them too.
      const desk = { _tag: "system", component: "control-api" } as const;
      assert.strictEqual(
        (yield* router.ownerRequests({ missionId }, desk, true)).requests[0]!.messages.length,
        2,
      );
      // The room itself is closed to them the same way.
      const page = yield* router.roomPage({ roomId: request.roomId }, bridge);
      assert.strictEqual(page.messages.length, 2);
      assert.strictEqual(
        yield* failureCode(router.roomPage({ roomId: request.roomId }, wsClient)),
        "forbidden",
      );
      assert.strictEqual(
        yield* failureCode(router.messageBody({ messageId: page.messages[0]!.id }, wsClient)),
        "forbidden",
      );
    }).pipe(Effect.provide(h.layer));
  });
});
