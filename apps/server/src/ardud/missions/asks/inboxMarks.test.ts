import { describe, expect, it } from "@effect/vitest";
import {
  MISSIONS_ASKS_WS_METHODS,
  OwnerRequestId,
  RoomId,
  type OwnerRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as RuleService from "../core/RuleService.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import {
  agent,
  askInput,
  at,
  failureCode,
  harness,
  masterThread,
  missionId,
  ownerApp,
  seed,
  writerThread,
} from "./AsksService.testkit.ts";
import { asksWsHandlers } from "./ws.ts";

const M = MISSIONS_ASKS_WS_METHODS;
const T0 = Date.parse(at);
const MINUTE = 60_000;
const master = agent(masterThread);
const writer = agent(writerThread);
const ticket = { kind: "ticket" as const, label: "CRP-1", url: null, ref: "CRP-1" };
const paired = {
  sessionId: "session-app",
  subject: "one-time-token",
  origin: { _tag: "owner" as const, source: "cli" as const },
};
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

describe("inbox comments and snoozes", () => {
  it.effect("a comment decides nothing and wakes nobody unless the master decides the item", () => {
    const { posts, layer } = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const missions = yield* MissionService.MissionService;
      const ask = yield* asks.openAsk(askInput("Online or offline?"), master);

      // Only the owner writes.
      expect(
        yield* failureCode(
          asks.commentInboxItem({ subject: { kind: "ask", id: ask.id }, body: "Hm" }, master),
        ),
      ).toBe("forbidden");

      const mark = yield* asks.commentInboxItem(
        { subject: { kind: "ask", id: ask.id }, body: "Leaning online, checking with Sami." },
        ownerApp,
      );
      expect(mark.comments.map((comment) => comment.body)).toEqual([
        "Leaning online, checking with Sami.",
      ]);
      // Still open, nobody told.
      expect((yield* asks.ask(ask.id)).status).toBe("open");
      expect(posts).toEqual([]);
      // The master's view of the mission shows it.
      expect((yield* asks.desk(missionId)).marks.map((each) => each.id)).toEqual([`ask:${ask.id}`]);

      // A draft the master approves: one knock to the master per comment.
      yield* missions.setApprovalRouting(master, {
        missionId,
        routes: [{ id: "email", match: { _tag: "draft", channel: "email" }, approver: "master" }],
      });
      const draft = yield* asks.submitDraft(
        { missionId, audience: "Sami", channel: "email", target: ticket, text: "Merged." },
        writer,
      );
      expect(draft.approver).toBe("master");
      yield* asks.commentInboxItem(
        { subject: { kind: "draft", id: draft.id }, body: "Mention the deploy too." },
        ownerApp,
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        input: {
          missionId,
          roomId: `${missionId}:room:control`,
          to: [{ _tag: "role", roleId: "role-master" }],
          body: "Mention the deploy too.",
        },
        provenance: { _tag: "system", component: "asks" },
      });
      expect((yield* asks.drafts({ missionId }))[0]?.status).toBe("pending");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a snooze holds until its time, a change to the item, or a discussion reply", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const store = yield* MissionStore.MissionStore;
      const snoozed = () =>
        Effect.map(asks.inboxMarks(missionId), ({ marks }) =>
          marks.filter((mark) => mark.snooze !== null).map((mark) => mark.subject.id),
        );

      const timed = yield* asks.openAsk(askInput("Timed?"), master);
      const changed = yield* asks.openAsk(askInput("Changed?"), master);
      const discussed = yield* asks.openAsk(askInput("Discussed?"), master);
      const kept = yield* asks.openAsk(askInput("Kept?"), master);

      expect(
        yield* failureCode(
          asks.snoozeInboxItem(
            { subject: { kind: "ask", id: timed.id }, until: iso(T0 - MINUTE) },
            ownerApp,
          ),
        ),
      ).toBe("invalid");
      yield* asks.snoozeInboxItem(
        { subject: { kind: "ask", id: timed.id }, until: iso(T0 + 60 * MINUTE) },
        ownerApp,
      );
      for (const ask of [changed, discussed, kept]) {
        yield* asks.snoozeInboxItem(
          { subject: { kind: "ask", id: ask.id }, until: null },
          ownerApp,
        );
      }
      expect(yield* snoozed()).toEqual(
        expect.arrayContaining([timed.id, changed.id, discussed.id, kept.id]),
      );

      // The item changes: answered.
      yield* TestClock.setTime(T0 + MINUTE);
      yield* asks.answerAsk({ askId: changed.id, optionId: "a", text: "" }, ownerApp);
      // A discussion on the item moves after the snooze.
      const request: OwnerRequest = {
        id: OwnerRequestId.make("request-discuss"),
        missionId,
        subMissionId: null,
        title: "Discussed?",
        status: "answered",
        roomId: RoomId.make(`${missionId}:room:request-discuss`),
        createdBy: ownerApp,
        lastOwnerAt: iso(T0 - MINUTE),
        lastMasterAt: iso(T0 + MINUTE),
        links: [],
        unreadForOwner: true,
        settledBy: null,
        settledAt: null,
        createdAt: iso(T0 - MINUTE),
        updatedAt: iso(T0 + MINUTE),
        subject: { kind: "ask", id: discussed.id },
      };
      yield* store.commit({
        event: {
          missionId,
          kind: "request.replied",
          actor: { _tag: "role", roleId: "role-master" as never },
          provenance: master,
          summary: "Reply",
          subject: null,
        },
        upserts: [{ _tag: "owner-request", record: request }],
      });
      expect((yield* snoozed()).toSorted()).toEqual([timed.id, kept.id].toSorted());

      // The time passes.
      yield* TestClock.setTime(T0 + 61 * MINUTE);
      expect(yield* snoozed()).toEqual([kept.id]);

      // Unsnooze brings it back; a second unsnooze conflicts.
      yield* asks.unsnoozeInboxItem({ subject: { kind: "ask", id: kept.id } }, ownerApp);
      expect(yield* snoozed()).toEqual([]);
      expect(
        yield* failureCode(
          asks.unsnoozeInboxItem({ subject: { kind: "ask", id: kept.id } }, ownerApp),
        ),
      ).toBe("conflict");
      // Snoozing never touches the owner's inbox itself or the master's.
      const missions = yield* MissionService.MissionService;
      expect((yield* missions.inbox(missionId)).asks.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the feed resends the marks; only a paired session writes", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const ask = yield* asks.openAsk(askInput("Online or offline?"), master);
      const cli = yield* asksWsHandlers({
        surface: "cli",
        session: { sessionId: "session-cli", subject: "cli-issued-session" },
      });
      const app = yield* asksWsHandlers({ surface: "web", session: paired });
      expect(
        yield* failureCode(
          cli[M.snoozeInboxItem]({ subject: { kind: "ask", id: ask.id }, until: null }),
        ),
      ).toBe("provenance-required");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const pull = yield* Stream.toPull(cli[M.subscribeInboxMarks]({ missionId }));
          const [first] = yield* pull;
          expect(first?.marks).toEqual([]);
          yield* app[M.snoozeInboxItem]({ subject: { kind: "ask", id: ask.id }, until: null });
          const [next] = yield* pull;
          expect(next?.marks.map((mark) => mark.id)).toEqual([`ask:${ask.id}`]);
          // Answering the item ends the snooze: the feed drops the mark.
          yield* asks.answerAsk({ askId: ask.id, optionId: "a", text: "" }, ownerApp);
          const [after] = yield* pull;
          expect(after?.marks).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(RuleService.layer.pipe(Layer.provideMerge(layer))));
  });
});
