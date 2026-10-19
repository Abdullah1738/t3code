import { describe, expect, it } from "@effect/vitest";
import {
  MissionError,
  OwnerRequestId,
  RoleId,
  type MissionLink,
  type MissionRecordRef,
  type OwnerCondition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OwnerConditions } from "../discuss/OwnerConditions.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import {
  agent,
  askInput,
  failureCode,
  harness,
  laneThread,
  masterThread,
  missionId,
  ownerApp,
  seed,
  writerThread,
} from "./AsksService.testkit.ts";

const master = agent(masterThread);
const writer = agent(writerThread);
const laneAgent = agent(laneThread);
const masterRole = { ...master, roleId: RoleId.make("role-master") };
const ticket: MissionLink = { kind: "ticket", label: "CRP-1", url: null, ref: "CRP-1" };

const condition: OwnerCondition = {
  requestId: OwnerRequestId.make("req-1"),
  quote: "fine if it stays online",
};

/** Verifies only `condition` about the subjects it was told about; records every call. */
const fakeConditions = (subjects: Array<MissionRecordRef>) => {
  const verified: Array<string> = [];
  const settled: Array<{ readonly subject: string; readonly note: string | null }> = [];
  const layer = Layer.succeed(
    OwnerConditions,
    OwnerConditions.of({
      verify: ({ subject, condition: given }) =>
        subjects.some((known) => known.kind === subject.kind && known.id === subject.id) &&
        given.requestId === condition.requestId &&
        given.quote === condition.quote
          ? Effect.sync(() => {
              verified.push(`${subject.kind}:${subject.id}`);
            })
          : Effect.fail(new MissionError({ code: "forbidden", detail: "Not what he said." })),
      settleFor: ({ subject, note }) =>
        Effect.sync(() => {
          settled.push({ subject: `${subject.kind}:${subject.id}`, note });
        }),
    }),
  );
  return { verified, settled, layer };
};

const withConditions = (subjects: Array<MissionRecordRef>) => {
  const fake = fakeConditions(subjects);
  const { layer, deliveries } = harness();
  return { ...fake, deliveries, layer: layer.pipe(Layer.provideMerge(fake.layer)) };
};

describe("discuss: asks", () => {
  it.effect("the master answers an ask only on the owner's verified condition", () => {
    const subjects: Array<MissionRecordRef> = [];
    const { verified, settled, deliveries, layer } = withConditions(subjects);
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const ask = yield* asks.openAsk(askInput("Which migration?"), laneAgent);
      subjects.push({ kind: "ask", id: ask.id });

      // Without a condition the master cannot answer; a wrong quote is refused too.
      expect(
        yield* failureCode(asks.answerAsk({ askId: ask.id, optionId: "a", text: "" }, master)),
      ).toBe("provenance-required");
      expect(
        yield* failureCode(
          asks.answerAsk(
            {
              askId: ask.id,
              optionId: "a",
              text: "",
              onOwnerCondition: { ...condition, quote: "do whatever" },
            },
            master,
          ),
        ),
      ).toBe("forbidden");
      // Only the master answers on a condition; the lane that asked cannot.
      expect(
        yield* failureCode(
          asks.answerAsk(
            { askId: ask.id, optionId: "a", text: "", onOwnerCondition: condition },
            laneAgent,
          ),
        ),
      ).toBe("forbidden");
      expect((yield* asks.ask(ask.id)).status).toBe("open");

      const answered = yield* asks.answerAsk(
        { askId: ask.id, optionId: "a", text: "", onOwnerCondition: condition },
        master,
      );
      expect(answered.ask.status).toBe("answered");
      expect(answered.ask.answer?.provenance).toEqual(masterRole);
      expect(answered.ask.answer?.onOwnerCondition).toEqual(condition);
      expect(answered.released.map((ref) => ref.id).toSorted()).toEqual(["lane-api", "wi-held"]);
      expect(verified).toEqual([`ask:${ask.id}`]);
      expect(settled).toEqual([
        { subject: `ask:${ask.id}`, note: "Answered on your condition: Online" },
      ]);

      const store = yield* MissionStore.MissionStore;
      const event = (yield* store.recentEvents(missionId, 20)).find(
        (candidate) => candidate.kind === "ask.answered",
      );
      expect(event?.actor).toEqual({ _tag: "role", roleId: "role-master" });
      expect(event?.payload).toMatchObject({ onOwnerCondition: condition });
      // The lane that asked hears whose answer it was.
      expect(deliveries.find((delivery) => delivery.threadId === laneThread)?.text).toContain(
        "answered by the master on the owner's condition",
      );

      // The owner takes the answer back: that condition is spent for this ask.
      const reopened = yield* asks.reopenAsk({ askId: ask.id, reason: "Not that one" }, ownerApp);
      expect(reopened.spentConditionIds).toEqual([condition.requestId]);
      expect(
        yield* failureCode(
          asks.answerAsk(
            { askId: ask.id, optionId: "a", text: "", onOwnerCondition: condition },
            master,
          ),
        ),
      ).toBe("provenance-invalid");
      expect((yield* asks.ask(ask.id)).status).toBe("open");
    }).pipe(Effect.provide(layer));
  });

  it.effect("without the router a condition is refused and the ask stays open", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const ask = yield* asks.openAsk(askInput("Which migration?"), laneAgent);
      expect(
        yield* failureCode(
          asks.answerAsk(
            { askId: ask.id, optionId: "a", text: "", onOwnerCondition: condition },
            master,
          ),
        ),
      ).toBe("forbidden");
      expect((yield* asks.ask(ask.id)).status).toBe("open");
    }).pipe(Effect.provide(layer));
  });

  it.effect("the master revises and withdraws a lane's ask; the lane keeps it and hears", () => {
    const { settled, deliveries, layer } = withConditions([]);
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const ask = yield* asks.openAsk(askInput("Which migration?"), laneAgent);

      const revised = yield* asks.openAsk(
        askInput("Which migration, given the freeze?", { supersedes: ask.id }),
        master,
      );
      expect(revised.askedBy).toEqual(ask.askedBy);
      expect((yield* asks.ask(ask.id)).status).toBe("superseded");
      // A discussion about the old ask ends; the owner sees the revised one.
      expect(settled).toEqual([
        { subject: `ask:${ask.id}`, note: `Revised as ask ${revised.id}.` },
      ]);
      // Another role in the mission (neither asker nor master) cannot withdraw it.
      expect(
        yield* failureCode(
          asks.withdrawAsk({ askId: revised.id, reason: "Not needed" }, agent(writerThread)),
        ),
      ).toBe("forbidden");

      const withdrawn = yield* asks.withdrawAsk(
        { askId: revised.id, reason: "The owner settled it in chat" },
        master,
      );
      expect(withdrawn.ask.status).toBe("withdrawn");
      expect(settled.at(-1)).toEqual({
        subject: `ask:${revised.id}`,
        note: "Ask withdrawn: The owner settled it in chat",
      });
      // The lane that asked is told; it did not withdraw the ask itself.
      expect(deliveries.map((delivery) => delivery.threadId)).toContain(laneThread);
    }).pipe(Effect.provide(layer));
  });
});

const draftFor = (channel: "email" | "linear", text: string) => ({
  missionId,
  audience: "Sami",
  channel,
  target: ticket,
  text,
});

describe("discuss: drafts", () => {
  it.effect(
    "the master decides an owner-routed draft only on the owner's verified condition",
    () => {
      const subjects: Array<MissionRecordRef> = [];
      const { verified, settled, layer } = withConditions(subjects);
      return Effect.gen(function* () {
        yield* seed;
        const asks = yield* AsksService.AsksService;
        const draft = yield* asks.submitDraft(draftFor("linear", "Merged, see CRP-1."), writer);
        expect(draft.approver).toBe("owner");
        subjects.push({ kind: "draft", id: draft.id });

        expect(
          yield* failureCode(
            asks.decideDraft({ draftId: draft.id, action: "approve", revision: 0 }, master),
          ),
        ).toBe("provenance-required");
        expect(
          yield* failureCode(
            asks.decideDraft(
              {
                draftId: draft.id,
                action: "approve",
                revision: 0,
                onOwnerCondition: { ...condition, requestId: OwnerRequestId.make("req-other") },
              },
              master,
            ),
          ),
        ).toBe("forbidden");
        expect(
          yield* failureCode(
            asks.decideDraft(
              { draftId: draft.id, action: "approve", revision: 0, onOwnerCondition: condition },
              laneAgent,
            ),
          ),
        ).toBe("forbidden");

        const decided = yield* asks.decideDraft(
          { draftId: draft.id, action: "approve", revision: 0, onOwnerCondition: condition },
          master,
        );
        expect(decided.draft.status).toBe("approved");
        expect(decided.draft.decidedBy).toEqual(masterRole);
        expect(decided.draft.onOwnerCondition).toEqual(condition);
        expect(verified).toEqual([`draft:${draft.id}`]);
        expect(settled).toEqual([
          { subject: `draft:${draft.id}`, note: "Draft approved on your condition." },
        ]);

        // Reopening puts it back in front of the owner, clears the condition
        // and spends it: the same condition cannot decide the draft again.
        const reopened = yield* asks.reopenDraft({ draftId: draft.id }, ownerApp);
        expect(reopened.onOwnerCondition).toBeNull();
        expect(reopened.spentConditionIds).toEqual([condition.requestId]);
        expect(
          yield* failureCode(
            asks.decideDraft(
              {
                draftId: draft.id,
                action: "approve",
                revision: reopened.revision ?? 0,
                onOwnerCondition: condition,
              },
              master,
            ),
          ),
        ).toBe("provenance-invalid");
        // A rewrite sends it back for another round; the conversation stays open.
        const settledBefore = settled.length;
        yield* asks.decideDraft(
          { draftId: draft.id, action: "rewrite", rewriteNote: "Shorter" },
          ownerApp,
        );
        expect(settled).toHaveLength(settledBefore);
        // The owner's own decision still settles the conversation.
        yield* asks.reviseDraft({ draftId: draft.id, text: "Merged." }, writer);
        yield* asks.decideDraft({ draftId: draft.id, action: "drop" }, ownerApp);
        expect(settled.at(-1)).toEqual({ subject: `draft:${draft.id}`, note: "Draft dropped." });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("the master revises a writer's draft and it keeps the replaced text", () => {
    const { layer } = withConditions([]);
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const draft = yield* asks.submitDraft(draftFor("linear", "Merged, see CRP-1."), writer);
      expect(
        yield* failureCode(
          asks.reviseDraft({ draftId: draft.id, text: "Merged and deployed." }, laneAgent),
        ),
      ).toBe("forbidden");
      const revised = yield* asks.reviseDraft(
        { draftId: draft.id, text: "Merged and deployed to dev." },
        master,
      );
      expect(revised.text).toBe("Merged and deployed to dev.");
      expect(revised.previousText).toBe("Merged, see CRP-1.");
      expect(revised.status).toBe("pending");
      expect(revised.approver).toBe("owner");
    }).pipe(Effect.provide(layer));
  });

  it.effect("without the router nothing verifies, so a condition is refused", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const draft = yield* asks.submitDraft(draftFor("linear", "Merged, see CRP-1."), writer);
      expect(
        yield* failureCode(
          asks.decideDraft(
            { draftId: draft.id, action: "approve", revision: 0, onOwnerCondition: condition },
            master,
          ),
        ),
      ).toBe("forbidden");
      expect((yield* asks.drafts({ missionId })).map((d) => d.status)).toEqual(["pending"]);
    }).pipe(Effect.provide(layer));
  });
});
