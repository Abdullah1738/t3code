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
import * as MissionStore from "../store/MissionStore.ts";
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
