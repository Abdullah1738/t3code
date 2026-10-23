import {
  OwnerRequestId,
  RoleId,
  ThreadId,
  WorkItemId,
  type MissionLink,
  type MissionProvenance,
  type OwnerRequestsInput,
  requestPlainText,
  requestTextParts,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as AsksService from "../asks/AsksService.ts";
import {
  agent,
  askInput,
  failureCode,
  governor,
  harness as asksHarness,
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
import { RequestImages } from "./requestImages.ts";

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
      // Role holders and live lanes belong to the mission, not the thread list.
      assert.includeMembers(
        [...(listed?.threadIds ?? [])],
        [masterThread, writerThread, laneThread],
      );
      // routing r21: only the master's own questions may reach the owner.
      assert.deepStrictEqual(listed?.masterThreadIds, [masterThread]);

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

  it.effect("images sit where his markers put them, as paths the master can open", () => {
    const h = harness();
    const stored: Array<{ requestId: string; image: unknown }> = [];
    const pathOf = (n: number) =>
      `/home/t3/attachments/mission-0000000${n}-0000-4000-8000-000000000000.png`;
    return Effect.gen(function* () {
      yield* seed;
      const registry = yield* RequestImages;
      yield* registry.register(({ requestId, images }) =>
        Effect.sync(() => ({
          images: images.map((image) => {
            stored.push({ requestId, image });
            return { assetId: `asset-${stored.length}`, path: pathOf(stored.length) };
          }),
          undo: Effect.void,
        })),
      );
      const router = yield* MissionRouter.MissionRouter;
      const shot = (attachmentId: string) => ({ _tag: "attachment", attachmentId }) as const;
      const request = yield* router.openRequest(
        {
          missionId,
          text: "The header in {image2} should match {image1}.",
          images: [shot("before"), shot("after")],
        },
        ownerApp,
      );
      const said = `The header in [image 2: ${pathOf(2)}] should match [image 1: ${pathOf(1)}].`;
      assert.deepStrictEqual(
        stored.map((each) => each.requestId),
        [request.id, request.id],
      );
      assert.strictEqual(request.title, "The header in [image 2] should match [image 1].");
      assert.include(wakesFor(h.sent, masterThread)[0]!.text, said);
      const one = yield* router.ownerRequests({ missionId, requestId: request.id }, ownerApp);
      assert.strictEqual(one.requests[0]!.messages[0]!.body, said);
      assert.strictEqual(
        one.requests[0]!.messages[0]!.message.summary,
        "The header in [image 2] should match [image 1].",
      );
      assert.include((yield* router.inbox(masterThread)).entries[0]!.body ?? "", said);

      // Without a marker the image goes after his words.
      yield* router.replyRequest(
        { requestId: request.id, text: "And this one.", images: [shot("third")] },
        ownerApp,
      );
      const thread = yield* router.ownerRequests({ missionId, requestId: request.id }, ownerApp);
      assert.strictEqual(
        thread.requests[0]!.messages[1]!.body,
        `And this one.\n\n[image 1: ${pathOf(3)}]`,
      );
      assert.strictEqual(thread.requests[0]!.request.lastReply, "And this one. [image 1]");

      // A refused reply stores none of its images.
      yield* router.settleRequest({ requestId: request.id }, ownerApp);
      assert.strictEqual(
        yield* failureCode(
          router.replyRequest(
            { requestId: request.id, text: "One more.", images: [shot("fourth")] },
            ownerApp,
          ),
        ),
        "conflict",
      );
      assert.lengthOf(stored, 3);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a write refused after its images were stored takes them back", () => {
    const h = harness();
    const undone: Array<string> = [];
    return Effect.gen(function* () {
      yield* seed;
      const registry = yield* RequestImages;
      let n = 0;
      yield* registry.register(({ images }) =>
        Effect.sync(() => {
          const batch = images.map(() => {
            n += 1;
            return { assetId: `asset-${n}`, path: `/assets/mission-${n}.png` };
          });
          return {
            images: batch,
            undo: Effect.sync(() => undone.push(...batch.map((image) => image.assetId))),
          };
        }),
      );
      const router = yield* MissionRouter.MissionRouter;
      const shot = (attachmentId: string) => ({ _tag: "attachment", attachmentId }) as const;
      const request = yield* router.openRequest(
        { missionId, text: "Status?", images: [shot("first")] },
        ownerApp,
      );
      yield* router.replyRequest({ requestId: request.id, text: "Also this.", key: "b" }, ownerApp);
      // The same key with other words is refused only after the images are stored.
      assert.strictEqual(
        yield* failureCode(
          router.replyRequest(
            {
              requestId: request.id,
              text: "Something else.",
              key: "b",
              images: [shot("second"), shot("third")],
            },
            ownerApp,
          ),
        ),
        "conflict",
      );
      assert.deepStrictEqual(undone, ["asset-2", "asset-3"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a ref he typed stays words, in every message he can write", () => {
    const h = harness();
    const typed = "[image 1: /tmp/mission-00000001-0000-4000-8000-000000000000.txt]";
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const request = yield* router.openRequest({ missionId, text: `open ${typed}` }, ownerApp);
      yield* router.replyRequest({ requestId: request.id, text: `reply ${typed}` }, ownerApp);
      yield* router.settleRequest({ requestId: request.id, note: `settle ${typed}` }, ownerApp);
      yield* router.reopenRequest({ requestId: request.id, note: `reopen ${typed}` }, ownerApp);
      const view = (yield* router.ownerRequests({ missionId, requestId: request.id }, ownerApp))
        .requests[0]!;
      const texts = view.messages.map((message) => message.body ?? "");
      assert.lengthOf(texts, 4);
      for (const text of texts) {
        assert.deepStrictEqual(
          requestTextParts(text).map((part) => part.type),
          ["text"],
        );
        assert.include(requestPlainText(text), typed);
      }
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a server without an image store refuses images, not the words", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const images = [{ _tag: "attachment", attachmentId: "shot" }] as const;
      assert.strictEqual(
        yield* failureCode(router.openRequest({ missionId, text: "Look", images }, ownerApp)),
        "invalid",
      );
      assert.deepStrictEqual(yield* requestEvents, []);
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

  it.effect("one iMessage writes to each request once, and to several requests", () => {
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
      const third = yield* router.openRequest({ missionId, text: "Tests?" }, ownerApp);
      yield* router.settled(masterThread);

      // "Go ahead on both": the same message answers two requests, once each.
      const both = "Go ahead on both.";
      yield* router.replyRequest({ requestId: other.id, text: both }, ownerIMessage);
      yield* router.replyRequest({ requestId: third.id, text: both }, ownerIMessage);
      yield* router.replyRequest({ requestId: other.id, text: both }, ownerIMessage);
      // It may open a request in another mission too.
      const elsewhere = yield* router.openRequest(
        { missionId: otherMissionId, text: "Status?" },
        ownerIMessage,
      );
      assert.notStrictEqual(elsewhere.id, opened.id);

      const refusals = [
        // Not a second request here...
        router.openRequest({ missionId, text: "Something else" }, ownerIMessage),
        // ...nor other words, or a settle, where it already wrote.
        router.replyRequest({ requestId: other.id, text: "Something else" }, ownerIMessage),
        router.settleRequest({ requestId: third.id, note: both }, ownerIMessage),
        router.replyRequest({ requestId: opened.id, text: "Something else" }, ownerIMessage),
      ];
      for (const refused of refusals) {
        assert.strictEqual(yield* failureCode(refused), "conflict");
      }
      assert.deepStrictEqual(
        (yield* requestEvents).map((event) => event.kind),
        [
          "request.opened",
          "request.opened",
          "request.opened",
          "request.replied",
          "request.replied",
        ],
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("one iMessage can discuss two records, once each", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const free = { kind: "work-item", id: "wi-free" } as const;
      const held = { kind: "work-item", id: "wi-held" } as const;
      // One record already has an open discussion; the message adds to it.
      const ongoing = yield* router.openRequest(
        { missionId, text: "Is this blocked?", subject: held },
        ownerApp,
      );
      const text = "Hold both until Monday.";
      const onFree = yield* router.openRequest({ missionId, text, subject: free }, ownerIMessage);
      const onHeld = yield* router.openRequest({ missionId, text, subject: held }, ownerIMessage);
      assert.notStrictEqual(onFree.id, onHeld.id);
      assert.strictEqual(onHeld.id, ongoing.id);
      // Retries land on what each already wrote.
      assert.strictEqual(
        (yield* router.openRequest({ missionId, text, subject: held }, ownerIMessage)).id,
        ongoing.id,
      );
      assert.strictEqual(
        (yield* router.openRequest({ missionId, text, subject: free }, ownerIMessage)).id,
        onFree.id,
      );
      assert.strictEqual(
        yield* failureCode(
          router.openRequest({ missionId, text: "Other words.", subject: free }, ownerIMessage),
        ),
        "conflict",
      );
      assert.deepStrictEqual(
        (yield* requestEvents).map((event) => event.kind),
        ["request.opened", "request.opened", "request.replied"],
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

  it.effect("a discussion counts on its record, never in his requests", () => {
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
      const plain = yield* router.openRequest({ missionId, text: "Status on CI?" }, ownerApp);
      const talk = yield* router.openRequest(
        { missionId, text: "Why is this item still free?", subject: ask },
        ownerApp,
      );
      // The room names the record, not his words.
      const page = yield* router.roomPage({ roomId: talk.roomId }, ownerApp);
      assert.strictEqual(page.room.title, "Discussion: Item wi-free");
      yield* masterReads(plain.roomId);
      yield* masterReads(talk.roomId);
      yield* router.replyRequest({ requestId: plain.id, text: "Green." }, master);
      yield* router.replyRequest(
        { requestId: talk.id, text: "Nobody took it.", status: "waiting-on-master" },
        master,
      );
      yield* router.replyRequest({ requestId: talk.id, text: "Lane 2 has it now." }, master);
      // Only the request about no record counts toward his requests.
      assert.deepStrictEqual(yield* counts, [1, 1, 1]);
      const ids = (input: Omit<OwnerRequestsInput, "missionId">) =>
        Effect.map(router.ownerRequests({ missionId, ...input }, ownerApp), (listed) =>
          listed.requests.map((view) => view.request.id),
        );
      assert.deepStrictEqual(yield* ids({ discussions: false }), [plain.id]);
      assert.deepStrictEqual(yield* ids({ discussions: true }), [talk.id]);
      assert.deepStrictEqual(yield* ids({ subject: ask }), [talk.id]);
      assert.deepStrictEqual(yield* ids({ subject: { kind: "work-item", id: "wi-held" } }), []);
      assert.strictEqual((yield* ids({ unread: true })).length, 2);
      assert.strictEqual((yield* ids({})).length, 2);
      // The counter on the record's discussion symbol: both unread replies.
      const about = yield* router.ownerRequests({ missionId, subject: ask }, ownerApp);
      assert.strictEqual(about.requests[0]?.unreadMessages, 2);
      // Reading it clears the counter and leaves his requests' count alone.
      const read = yield* router.roomPage({ roomId: talk.roomId }, ownerApp);
      yield* router.markRead({ roomId: talk.roomId, seq: read.room.lastSeq }, ownerApp);
      const after = yield* router.ownerRequests({ missionId, subject: ask }, ownerApp);
      assert.strictEqual(after.requests[0]?.unreadMessages, 0);
      assert.deepStrictEqual(yield* ids({ unread: true }), [plain.id]);
      assert.deepStrictEqual(yield* counts, [1, 1, 1]);
    }).pipe(Effect.provide(Layer.provideMerge(ViewStore.layer, h.layer)));
  });

  it.effect("one open request per record; the master reads the record and the whole talk", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const router = yield* MissionRouter.MissionRouter;
      // Only records of this mission, never another request.
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

  it.effect("a retraction in his newest message withdraws what came before it", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const request = yield* router.openRequest(
        { missionId, text: "Merge it if the tests pass.", subject: ask },
        ownerApp,
      );
      const conditions = yield* OwnerConditions;
      const verify = (quote: string) =>
        conditions.verify({ subject: ask, condition: { requestId: request.id, quote } });
      const say = (text: string) => router.replyRequest({ requestId: request.id, text }, ownerApp);
      yield* verify("Merge it if the tests pass");
      // Same message, taken back at its end: nothing in it stands.
      for (const text of [
        "Merge it if the tests pass. Scrap that.",
        "Merge it if the tests pass. Never mind",
        "Merge it if the tests pass. Actually, no.",
        "Merge it if the tests pass. I take that back!",
      ]) {
        yield* say(text);
        assert.strictEqual(yield* failureCode(verify("Merge it if the tests pass")), "forbidden");
      }
      // A message that only retracts stands for nothing, earlier ones included.
      yield* say("Merge it if the tests pass.");
      yield* say("Scrap that.");
      assert.strictEqual(yield* failureCode(verify("Merge it if the tests pass")), "forbidden");
      assert.strictEqual(yield* failureCode(verify("Scrap that")), "forbidden");
      // What follows a retraction stands; what came before it does not.
      yield* say("Merge it now. On second thought, hold it until Monday. Merge it after that.");
      assert.strictEqual(yield* failureCode(verify("Merge it now")), "forbidden");
      yield* verify("Merge it after that");
      // Not every "never mind" or "forget that" takes something back.
      yield* say("Never mind the docs. Don't forget that. Merge it if the tests pass.");
      yield* verify("Merge it if the tests pass");
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

  it.effect("an open discussion stays listed past the cap until someone settles it", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const talk = yield* router.openRequest(
        { missionId, text: "Why is this item still free?", subject: ask },
        ownerApp,
      );
      yield* masterReads(talk.roomId);
      yield* router.replyRequest({ requestId: talk.id, text: "Nobody took it." }, master);
      const old = yield* router.openRequest({ missionId, text: "Old question" }, ownerApp);
      yield* router.settleRequest({ requestId: old.id }, ownerApp);
      const fiftyNewer = Effect.forEach(
        Array.from({ length: 50 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            yield* TestClock.adjust("1 second");
            const done = yield* router.openRequest(
              { missionId, text: `Question ${index}` },
              ownerApp,
            );
            yield* router.settleRequest({ requestId: done.id }, ownerApp);
          }),
        { discard: true },
      );
      yield* fiftyNewer;
      const listed = (input: Omit<OwnerRequestsInput, "missionId"> = {}) =>
        Effect.map(router.ownerRequests({ missionId, ...input }, ownerApp), (each) =>
          each.requests.map((view) => view.request.id),
        );
      // Fifty newer requests: the settled one falls off, the answered talk stays, oldest last.
      const all = yield* listed();
      assert.strictEqual(all.length, 51);
      assert.strictEqual(all.at(-1), talk.id);
      assert.notInclude(all, old.id);
      assert.include(yield* listed({ status: "answered" }), talk.id);
      assert.notInclude(yield* listed({ status: "settled" }), old.id);
      // Read, it is still open, so it still outlives newer talk.
      const page = yield* router.roomPage({ roomId: talk.roomId }, ownerApp);
      yield* router.markRead({ roomId: talk.roomId, seq: page.room.lastSeq }, ownerApp);
      yield* fiftyNewer;
      assert.include(yield* listed(), talk.id);
      // Settled, by either side, it ages out like any other.
      yield* router.settleRequest({ requestId: talk.id, note: "Lane 2 has it." }, master);
      yield* fiftyNewer;
      assert.notInclude(yield* listed(), talk.id);
      assert.include(yield* listed({ subject: ask }), talk.id);
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

describe("owner conditions, sol boundary 4", () => {
  const ticket: MissionLink = { kind: "ticket", label: "CRP-1", url: null, ref: "CRP-1" };

  /** The router's conditions under the real asks service, one store between them. */
  const integrated = () => {
    const threads = fakeRouterThreads();
    const asks = asksHarness();
    // Fresh: the asks harness built one without the router's conditions.
    const layer = Layer.fresh(AsksService.layer).pipe(
      Layer.provideMerge(ownerConditionsOverRouter),
      Layer.provideMerge(routerOverFakes(threads)),
      Layer.provideMerge(asks.layer),
    );
    return { layer };
  };

  it.effect("a question never answers an ask or decides a draft, however it ends", () => {
    const h = integrated();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const router = yield* MissionRouter.MissionRouter;
      const ask = yield* asks.openAsk(askInput("Which migration?"), agent(laneThread));
      const askRef = { kind: "ask", id: ask.id } as const;
      const askTalk = yield* router.openRequest(
        { missionId, text: "Hmm.", subject: askRef },
        ownerApp,
      );
      const answerOn = (quote: string) =>
        asks.answerAsk(
          {
            askId: ask.id,
            optionId: "a",
            text: "",
            onOwnerCondition: { requestId: askTalk.id, quote },
          },
          master,
        );
      // Each one in turn is his newest message; none of them is a condition.
      for (const question of [
        'Should I select Online?"',
        "Can we merge it now？",
        "Should I select Online?)",
        "Should I select Online?' ",
        "Should I select Online?”",
        "Should I select Online?»",
        "¿Should I select Online",
        "Should I select Online؟",
        "Should I select Online⸮",
      ]) {
        yield* router.replyRequest({ requestId: askTalk.id, text: question }, ownerApp);
        assert.strictEqual(yield* failureCode(answerOn(question)), "forbidden", question);
      }
      assert.strictEqual((yield* asks.ask(ask.id)).status, "open");

      const draft = yield* asks.submitDraft(
        { missionId, audience: "Sami", channel: "linear", target: ticket, text: "Merged." },
        agent(writerThread),
      );
      const draftRef = { kind: "draft", id: draft.id } as const;
      const draftTalk = yield* router.openRequest(
        { missionId, text: "Can we send it now？", subject: draftRef },
        ownerApp,
      );
      const decideOn = (quote: string) =>
        asks.decideDraft(
          {
            draftId: draft.id,
            action: "approve",
            revision: 0,
            onOwnerCondition: { requestId: draftTalk.id, quote },
          },
          master,
        );
      assert.strictEqual(yield* failureCode(decideOn("Can we send it now？")), "forbidden");
      yield* router.replyRequest({ requestId: draftTalk.id, text: 'Send it?"' }, ownerApp);
      assert.strictEqual(yield* failureCode(decideOn('Send it?"')), "forbidden");
      assert.strictEqual((yield* asks.drafts({ missionId }))[0]!.status, "pending");

      // A plain condition still works for both.
      yield* router.replyRequest(
        { requestId: askTalk.id, text: "Use Online if tests pass." },
        ownerApp,
      );
      const answered = yield* answerOn("Use Online if tests pass.");
      assert.strictEqual(answered.ask.status, "answered");
      yield* router.replyRequest(
        { requestId: draftTalk.id, text: "Send it once CI is green." },
        ownerApp,
      );
      const decided = yield* decideOn("Send it once CI is green");
      assert.strictEqual(decided.draft.status, "approved");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("only his newest words in an open request stand as a condition", () => {
    const h = integrated();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const router = yield* MissionRouter.MissionRouter;
      const conditions = yield* OwnerConditions;
      const ask = yield* asks.openAsk(askInput("Which migration?"), agent(laneThread));
      const askRef = { kind: "ask", id: ask.id } as const;
      const talk = yield* router.openRequest(
        { missionId, text: "Use Online if tests pass.", subject: askRef },
        ownerApp,
      );
      const verify = (quote: string) =>
        conditions.verify({ subject: askRef, condition: { requestId: talk.id, quote } });
      // His newest message stands.
      yield* verify("Use Online if tests pass.");
      // Sol's steps: he withdraws it; the master quotes the first one anyway.
      yield* router.replyRequest(
        {
          requestId: talk.id,
          text: "I withdraw that condition. Do not answer this ask until I decide.",
        },
        ownerApp,
      );
      assert.strictEqual(
        yield* failureCode(
          asks.answerAsk(
            {
              askId: ask.id,
              optionId: "a",
              text: "",
              onOwnerCondition: { requestId: talk.id, quote: "Use Online if tests pass." },
            },
            master,
          ),
        ),
        "forbidden",
      );
      assert.strictEqual((yield* asks.ask(ask.id)).status, "open");
      // The master's reply after his words does not hide them.
      yield* router.replyRequest(
        { requestId: talk.id, text: "Understood, holding until you decide." },
        master,
      );
      yield* verify("Do not answer this ask until I decide.");

      // He settles: nothing he said there stands any more.
      yield* router.replyRequest({ requestId: talk.id, text: "Use Offline." }, ownerApp);
      yield* verify("Use Offline.");
      yield* router.settleRequest({ requestId: talk.id }, ownerApp);
      assert.strictEqual(yield* failureCode(verify("Use Offline.")), "forbidden");
      // Reopened by the master, his words from before still do not stand.
      yield* router.reopenRequest({ requestId: talk.id }, master);
      assert.strictEqual(yield* failureCode(verify("Use Offline.")), "forbidden");
      // Nor after his own bare reopen.
      yield* router.settleRequest({ requestId: talk.id }, ownerApp);
      yield* router.reopenRequest({ requestId: talk.id }, ownerApp);
      assert.strictEqual(yield* failureCode(verify("Use Offline.")), "forbidden");
      // His newest words after the reopen do.
      yield* router.replyRequest({ requestId: talk.id, text: "Use Online after all." }, ownerApp);
      yield* verify("Use Online after all.");
      // A reopen with his note: the note is his newest message.
      yield* router.settleRequest({ requestId: talk.id }, ownerApp);
      yield* router.reopenRequest(
        { requestId: talk.id, note: "Go with Offline tonight." },
        ownerApp,
      );
      assert.strictEqual(yield* failureCode(verify("Use Online after all.")), "forbidden");
      const answered = yield* asks.answerAsk(
        {
          askId: ask.id,
          optionId: "b",
          text: "",
          onOwnerCondition: { requestId: talk.id, quote: "Go with Offline tonight." },
        },
        master,
      );
      assert.strictEqual(answered.ask.status, "answered");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a settled request does not reopen over another open one about its record", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const router = yield* MissionRouter.MissionRouter;
      const subject = { kind: "work-item", id: "wi-free" } as const;
      const first = yield* router.openRequest(
        { missionId, text: "Why is this free?", subject },
        ownerApp,
      );
      yield* router.settleRequest({ requestId: first.id }, ownerApp);
      const second = yield* router.openRequest(
        { missionId, text: "Who has it now?", subject },
        ownerApp,
      );
      assert.notStrictEqual(second.id, first.id);
      for (const who of [ownerApp, master]) {
        const refused = yield* Effect.flip(router.reopenRequest({ requestId: first.id }, who));
        assert.strictEqual(refused.code, "conflict");
        assert.include(refused.detail, second.id);
      }
      const open = (yield* router.ownerRequests({ missionId }, ownerApp)).requests.filter(
        (view) => view.request.status !== "settled",
      );
      assert.deepStrictEqual(
        open.map((view) => view.request.id),
        [second.id],
      );
      // Once the other one settles, it reopens.
      yield* router.settleRequest({ requestId: second.id }, ownerApp);
      const reopened = yield* router.reopenRequest({ requestId: first.id }, ownerApp);
      assert.strictEqual(reopened.status, "waiting-on-master");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the master opens a discussion on a draft when the owner asked for one", () => {
    const h = integrated();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const router = yield* MissionRouter.MissionRouter;
      const draft = yield* asks.submitDraft(
        { missionId, audience: "Sami", channel: "linear", target: ticket, text: "Merged." },
        agent(writerThread),
      );
      const draftRef = { kind: "draft", id: draft.id } as const;
      const asked = "Approved, send it and keep me posted here.";
      const opening = { missionId, text: asked, subject: draftRef };
      // Only the master, and only quoting where he asked.
      assert.strictEqual(yield* failureCode(router.openRequest(opening, master)), "invalid");
      for (const other of [writerThread, laneThread]) {
        assert.strictEqual(
          yield* failureCode(
            router.openRequest({ ...opening, quotedFrom: "his thread" }, agent(other)),
          ),
          "forbidden",
        );
      }
      const first = { ...opening, quotedFrom: "iMessage, 22 Oct", key: "posted" };
      const talk = yield* router.openRequest(first, master);
      assert.strictEqual((yield* router.openRequest(first, master)).id, talk.id);
      assert.strictEqual(
        yield* failureCode(router.openRequest({ ...first, text: "Hold it." }, master)),
        "conflict",
      );
      assert.strictEqual(talk.subject?.kind, "draft");
      assert.strictEqual(talk.subject?.id, draft.id);
      assert.strictEqual(talk.status, "waiting-on-master");
      assert.isTrue(talk.unreadForOwner);
      const ids = (input: Omit<OwnerRequestsInput, "missionId">) =>
        Effect.map(router.ownerRequests({ missionId, ...input }, ownerApp), (listed) =>
          listed.requests.map((view) => view.request.id),
        );
      // On the draft and under his discussions, never in his own requests.
      assert.deepStrictEqual(yield* ids({ subject: draftRef }), [talk.id]);
      assert.deepStrictEqual(yield* ids({ discussions: true }), [talk.id]);
      assert.deepStrictEqual(yield* ids({ discussions: false }), []);

      // Asked again, the master's words join the open discussion, quote and all.
      const tellSami = {
        missionId,
        text: "Tell Sami too.",
        subject: draftRef,
        quotedFrom: "his thread",
        key: "tell-sami",
      };
      const again = yield* router.openRequest(tellSami, master);
      // A retry lands once; the same key saying something else conflicts.
      assert.strictEqual((yield* router.openRequest(tellSami, master)).id, talk.id);
      assert.strictEqual(
        yield* failureCode(router.openRequest({ ...tellSami, text: "Tell Ana." }, master)),
        "conflict",
      );
      assert.strictEqual(again.id, talk.id);
      assert.strictEqual(again.status, "waiting-on-master");
      assert.isTrue(again.unreadForOwner);
      assert.strictEqual((yield* ids({})).length, 1);
      const view = (yield* router.ownerRequests({ missionId, requestId: talk.id }, ownerApp))
        .requests[0]!;
      assert.strictEqual(view.unreadMessages, 2);
      assert.strictEqual(view.messages.length, 2);
      const [opened, added] = view.messages;
      assert.strictEqual(opened!.message.kind, "request");
      assert.include(opened!.body ?? "", "Opened by the master for the owner");
      assert.include(opened!.body ?? "", "quoting what he said in iMessage, 22 Oct");
      assert.include(opened!.body ?? "", asked);
      assert.strictEqual(added!.message.kind, "status");
      assert.include(added!.body ?? "", "Added by the master for the owner");
      assert.include(added!.body ?? "", "quoting what he said in his thread");
      assert.include(added!.body ?? "", "Tell Sami too.");

      // The master's quote of him never stands as his condition.
      assert.strictEqual(
        yield* failureCode(
          asks.decideDraft(
            {
              draftId: draft.id,
              action: "approve",
              revision: 0,
              onOwnerCondition: { requestId: talk.id, quote: asked },
            },
            master,
          ),
        ),
        "forbidden",
      );
      assert.strictEqual((yield* asks.drafts({ missionId }))[0]!.status, "pending");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a progress discussion opened after approval outlives the send", () => {
    const h = integrated();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const router = yield* MissionRouter.MissionRouter;
      const draft = yield* asks.submitDraft(
        {
          missionId,
          audience: "Sami",
          channel: "linear",
          target: ticket,
          text: "Merged.",
          workItemId: WorkItemId.make("wi-free"),
        },
        agent(writerThread),
      );
      const draftRef = { kind: "draft", id: draft.id } as const;
      yield* asks.decideDraft({ draftId: draft.id, action: "approve", revision: 0 }, ownerApp);
      const talk = yield* router.openRequest(
        {
          missionId,
          text: "Approved, send it and keep me posted.",
          subject: draftRef,
          quotedFrom: "iMessage",
        },
        master,
      );
      yield* asks.recordDraftSent({ draftId: draft.id }, agent(writerThread));
      // Its progress goes on the same discussion, linked to the draft's work item.
      const update = yield* router.replyRequest(
        {
          requestId: talk.id,
          text: "Posted on CRP-1; the lane is on the follow-up.",
          status: "waiting-on-master",
          links: [{ kind: "work-item", id: "wi-free" }],
        },
        master,
      );
      assert.strictEqual(update.status, "waiting-on-master");
      assert.deepStrictEqual(
        update.links.map((link) => [link.kind, link.id]),
        [["work-item", "wi-free"]],
      );
      assert.strictEqual((yield* asks.drafts({ missionId }))[0]!.status, "sent");
      const about = yield* router.ownerRequests({ missionId, subject: draftRef }, ownerApp);
      assert.deepStrictEqual(
        about.requests.map((view) => [view.request.id, view.request.status]),
        [[talk.id, "waiting-on-master"]],
      );
    }).pipe(Effect.provide(h.layer));
  });
});
