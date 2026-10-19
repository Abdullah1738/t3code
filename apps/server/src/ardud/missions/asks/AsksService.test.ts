import { describe, expect, it } from "@effect/vitest";
import { AskId, RoleId, type MissionProvenance } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import {
  agent,
  askInput,
  at,
  failureCode,
  governor,
  harness,
  lane,
  laneThread,
  masterThread,
  missionId,
  ownerApp,
  seed,
  strayThread,
  writerThread,
} from "./AsksService.testkit.ts";

describe("AsksService", () => {
  it.effect("holds only the blocked records and releases them on the owner's answer", () => {
    const { deliveries, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const store = yield* MissionStore.MissionStore;

      expect(
        yield* failureCode(
          asks.openAsk(askInput("Which way?", { default: "a" }), agent(laneThread)),
        ),
      ).toBe("invalid");
      expect(yield* failureCode(asks.openAsk(askInput("Which way?"), agent(strayThread)))).toBe(
        "forbidden",
      );

      const ask = yield* asks.openAsk(askInput("Which way?"), agent(laneThread));
      expect(ask.askedBy).toEqual({ _tag: "lane", laneId: lane.id });

      const held = Option.getOrThrow(yield* store.get("work-item", "wi-held"));
      const free = Option.getOrThrow(yield* store.get("work-item", "wi-free"));
      const heldLane = Option.getOrThrow(yield* store.get("lane", "lane-api"));
      expect(held.blockedBy).toEqual([{ kind: "ask", id: ask.id, label: "Which way?" }]);
      expect(free.blockedBy).toEqual([]);
      expect(heldLane.status).toBe("waiting");
      expect(heldLane.statusReason).toBe(`waiting on ask ${ask.id}: Which way?`);

      const desk = yield* asks.desk(missionId);
      expect(desk.held.map((entry) => entry.ref.id).toSorted()).toEqual(["lane-api", "wi-held"]);

      // Agents never answer, even when they say the owner told them to.
      expect(
        yield* failureCode(
          asks.answerAsk({ askId: ask.id, optionId: "a", text: "" }, agent(masterThread)),
        ),
      ).toBe("provenance-required");

      const answered = yield* asks.answerAsk({ askId: ask.id, optionId: "b", text: "" }, ownerApp);
      expect(answered.ask.status).toBe("answered");
      expect(answered.released.map((ref) => ref.id).toSorted()).toEqual(["lane-api", "wi-held"]);
      expect(Option.getOrThrow(yield* store.get("work-item", "wi-held")).blockedBy).toEqual([]);
      const freed = Option.getOrThrow(yield* store.get("lane", "lane-api"));
      expect(freed.status).toBe("idle");
      expect(freed.statusReason).toBeNull();
      expect(deliveries).toEqual([
        expect.objectContaining({ threadId: laneThread, asOwner: false }),
      ]);
      expect(deliveries[0]?.text).toContain("Offline window");

      const events = yield* asks.events(missionId, 0);
      expect(events.map((event) => event.kind)).toEqual([
        "mission.created",
        "ask.opened",
        "ask.answered",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("takes an iMessage answer only with a verified inbound from the owner or Moni", () => {
    const { layer } = harness([
      { id: "spc-msg-1", chat: "owner", text: "Go offline window", receivedAt: Date.parse(at) },
      { id: "moni-guid-1", chat: "moni", text: "online please", receivedAt: Date.parse(at) },
      { id: "wake:abc", chat: "owner", text: "offline window", receivedAt: Date.parse(at) },
    ]);
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const first = yield* asks.openAsk(askInput("Which way?"), agent(masterThread));
      const relay = agent(masterThread);

      expect(
        yield* failureCode(
          asks.answerAsk(
            { askId: first.id, optionId: "b", text: "", inboundId: "wake:abc" },
            relay,
          ),
        ),
      ).toBe("provenance-invalid");
      expect(
        yield* failureCode(
          asks.answerAsk(
            { askId: first.id, optionId: "a", text: "", inboundId: "spc-msg-1" },
            relay,
          ),
        ),
      ).toBe("provenance-invalid");
      expect(
        yield* failureCode(
          asks.answerAsk({ askId: first.id, optionId: "b", text: "", inboundId: "missing" }, relay),
        ),
      ).toBe("provenance-invalid");

      const viaOwner = yield* asks.answerAsk(
        { askId: first.id, optionId: "b", text: "", inboundId: "spc-msg-1" },
        relay,
      );
      expect(viaOwner.ask.answer?.provenance).toEqual({
        _tag: "owner-imessage",
        chat: "owner",
        inboundId: "spc-msg-1",
      });

      const second = yield* asks.openAsk(askInput("Which way for staging?"), agent(masterThread));
      const viaMoni = yield* asks.answerAsk(
        { askId: second.id, optionId: "a", text: "", inboundId: "moni-guid-1" },
        relay,
      );
      expect(viaMoni.ask.answer?.provenance).toMatchObject({
        _tag: "owner-imessage",
        chat: "moni",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("supersedes and withdraws without releasing early", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const store = yield* MissionStore.MissionStore;
      const first = yield* asks.openAsk(askInput("Which way?"), agent(laneThread));
      const second = yield* asks.openAsk(
        askInput("Which way, now with numbers?", { supersedes: first.id, blocks: [] }),
        agent(laneThread),
      );
      expect((yield* asks.ask(first.id)).status).toBe("superseded");
      expect(second.blocks.map((ref) => ref.id).toSorted()).toEqual(["lane-api", "wi-held"]);
      const heldBy = Option.getOrThrow(yield* store.get("work-item", "wi-held")).blockedBy;
      expect(heldBy.map((ref) => ref.id)).toEqual([second.id]);

      expect(
        yield* failureCode(
          asks.withdrawAsk({ askId: second.id, reason: "moot" }, agent(writerThread)),
        ),
      ).toBe("forbidden");
      const withdrawn = yield* asks.withdrawAsk(
        { askId: second.id, reason: "moot" },
        agent(laneThread),
      );
      expect(withdrawn.ask.status).toBe("withdrawn");
      expect(Option.getOrThrow(yield* store.get("lane", "lane-api")).status).toBe("idle");
      expect(yield* failureCode(asks.ask(AskId.make("nope")))).toBe("not-found");
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists unreacted calls for the direction check until the owner reacts", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const call = yield* asks.makeCall(
        {
          missionId,
          title: "Postgres over SQLite",
          decision: "Use Postgres for the ledger.",
          reason: "Concurrent writers.",
        },
        agent(masterThread),
      );
      expect(call.decidedBy).toEqual({ _tag: "role", roleId: RoleId.make("role-master") });
      expect(yield* asks.directionCheck(missionId, null)).toHaveLength(1);
      expect(
        yield* failureCode(
          asks.reactToCall({ callId: call.id, reaction: "ok" }, agent(masterThread)),
        ),
      ).toBe("provenance-required");
      const reacted = yield* asks.reactToCall({ callId: call.id, reaction: "ok" }, ownerApp);
      expect(reacted.ownerReaction).toBe("ok");
      expect(yield* asks.directionCheck(missionId, null)).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("turns repeated owner edits into a draft-note suggestion he can accept", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const target = { kind: "ticket" as const, label: "CRP-1", url: null, ref: "CRP-1" };
      expect(
        yield* failureCode(
          asks.submitDraft(
            { missionId, audience: "Sami", channel: "linear", target, text: "Hello" },
            agent(strayThread),
          ),
        ),
      ).toBe("forbidden");

      let suggestions: ReadonlyArray<{ readonly id: string; readonly author: string }> = [];
      for (const index of [1, 2, 3]) {
        const draft = yield* asks.submitDraft(
          {
            missionId,
            audience: "Sami",
            channel: "linear",
            target,
            text: `Hi Sami, hope you're well. Update ${index}: the fix is merged.`,
          },
          agent(writerThread),
        );
        expect(draft.writerRoleId).toBe(RoleId.make("role-writer"));
        expect(
          yield* failureCode(
            asks.decideDraft({ draftId: draft.id, action: "approve" }, agent(masterThread)),
          ),
        ).toBe("provenance-required");
        const decided = yield* asks.decideDraft(
          {
            draftId: draft.id,
            action: "approve",
            editedText: `Update ${index}: the fix is merged.`,
            revision: 0,
          },
          ownerApp,
        );
        expect(decided.draft.status).toBe("approved");
        expect(decided.draft.sentAt).toBeNull();
        suggestions = decided.suggestions;
      }
      expect(suggestions).toHaveLength(1);
      const suggestion = suggestions[0]!;
      expect(suggestion.author).toBe("owner-corrections");

      const accepted = yield* asks.decideSuggestion(
        { suggestionId: suggestion.id as never, action: "accept" },
        ownerApp,
      );
      expect(accepted.status).toBe("accepted");
      expect(accepted.outcome).toContain("Saved draft note");
      const notes = yield* asks.draftNotes(missionId);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.source).toBe("suggestion");

      const next = yield* asks.submitDraft(
        { missionId, audience: "Sami", channel: "linear", target, text: "The deploy is out." },
        agent(writerThread),
      );
      expect(next.appliedNoteIds).toEqual([notes[0]!.id]);
      const guide = yield* asks.draftGuide({ missionId, channel: "linear", audience: "Sami" });
      expect(guide.notes).toHaveLength(1);
      expect(guide.examples.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("raises the bar for an author whose suggestions keep getting dismissed", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const evidence = [{ kind: "lane" as const, id: "lane-api" }];
      const propose = (index: number, provenance: MissionProvenance) =>
        asks.proposeSuggestion(
          {
            missionId,
            targetKind: "pool",
            title: `Raise pool ${index}`,
            after: { size: index },
            diffText: `size -> ${index}`,
            why: "Lanes queue.",
            evidence,
          },
          provenance,
        );
      expect(yield* failureCode(propose(0, ownerApp))).toBe("forbidden");
      expect(yield* failureCode(propose(0, agent(laneThread)))).toBe("forbidden");
      for (const index of [1, 2, 3, 4, 5]) {
        const suggestion = yield* propose(index, governor);
        yield* asks.decideSuggestion(
          { suggestionId: suggestion.id, action: "dismiss", dismissReason: "no" },
          ownerApp,
        );
      }
      const stats = yield* asks.suggestionStats();
      expect(stats).toEqual([
        {
          author: "governor",
          targetKind: "pool",
          shown: 5,
          accepted: 0,
          dismissed: 5,
          bar: "high",
        },
      ]);
      expect(yield* failureCode(propose(6, governor))).toBe("invalid");

      const fromMaster = yield* propose(7, agent(masterThread));
      expect(fromMaster.author).toBe("master");
      const accepted = yield* asks.decideSuggestion(
        { suggestionId: fromMaster.id, action: "accept" },
        ownerApp,
      );
      expect(accepted.outcome).toContain("policy");
    }).pipe(Effect.provide(layer));
  });

  it.effect("forks the master thread and sends back one line", () => {
    const { deliveries, forks, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const origin = { kind: "lane" as const, id: "lane-api", label: "API lane" };
      expect(
        yield* failureCode(
          asks.startFork({ missionId, kind: "discuss", origin }, agent(laneThread)),
        ),
      ).toBe("forbidden");
      expect(
        yield* failureCode(
          asks.startFork(
            { missionId, kind: "owner-question", origin, question: "Ship today?" },
            agent(masterThread),
          ),
        ),
      ).toBe("provenance-required");

      const started = yield* asks.startFork(
        { missionId, kind: "discuss", origin, question: "Should the API lane pause?" },
        ownerApp,
      );
      expect(forks).toEqual([{ sourceThreadId: masterThread, title: "Discuss: API lane" }]);
      expect(started.fork.commitsMission).toBe(false);
      expect(deliveries).toEqual([
        { threadId: started.fork.forkThreadId, text: "Should the API lane pause?", asOwner: true },
      ]);
      const again = yield* asks.startFork({ missionId, kind: "discuss", origin }, ownerApp);
      expect(again.fork.id).toBe(started.fork.id);

      const forkThread = agent(started.fork.forkThreadId);
      expect(
        yield* failureCode(
          asks.closeFork(
            { forkId: started.fork.id, summaryLine: "Pause it.", commitsMission: true },
            forkThread,
          ),
        ),
      ).toBe("forbidden");
      const closed = yield* asks.closeFork(
        { forkId: started.fork.id, summaryLine: "Pause the API lane until Monday." },
        forkThread,
      );
      expect(closed.fork.status).toBe("answered");
      expect(closed.fork.commitsMission).toBe(false);
      expect(deliveries.at(-1)).toEqual({
        threadId: masterThread,
        text: "[Discussed: API lane] Pause the API lane until Monday.",
        asOwner: false,
      });

      const committed = yield* asks.updateFork(
        { forkId: started.fork.id, action: "commits-mission" },
        ownerApp,
      );
      expect(committed.fork.commitsMission).toBe(true);
      expect(committed.note?.type).toBe("decision");
      expect(deliveries.at(-1)?.text).toContain("This commits the mission");

      const acked = yield* asks.ackNote(committed.note!.id, agent(masterThread));
      expect(acked.ackedBy).toEqual([{ _tag: "role", roleId: RoleId.make("role-master") }]);
      expect(yield* failureCode(asks.ackNote(committed.note!.id, agent(laneThread)))).toBe(
        "forbidden",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses room posts until the router is wired", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const code = yield* failureCode(
        asks.post(
          { missionId, roomId: "room-1" as never, kind: "status", summary: "Halfway." },
          agent(laneThread),
        ),
      );
      expect(code).toBe("conflict");
    }).pipe(Effect.provide(layer));
  });
});
