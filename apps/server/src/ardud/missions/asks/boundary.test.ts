// Regressions for the boundary review (Sol, H8-H10 and M3) and the round 2
// self-review: each test walks one exploit chain end to end.
import { describe, expect, it } from "@effect/vitest";
import { DraftNoteId, type MissionLink } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import {
  agent,
  askInput,
  at,
  failureCode,
  governor,
  harness,
  masterThread,
  missionId,
  otherMasterThread,
  otherMissionId,
  ownerApp,
  seed,
  seedOther,
  writerThread,
} from "./AsksService.testkit.ts";
import * as Ports from "./ports.ts";
import type { InboundMessage } from "./provenance.ts";

const T0 = Date.parse(at);
const MINUTE = 60_000;
const relay = agent(masterThread);
const master = agent(masterThread);
const writer = agent(writerThread);
const owner = (id: string, text: string, receivedAt: number): InboundMessage => ({
  id,
  chat: "owner",
  text,
  receivedAt,
});
const link = (label: string): MissionLink => ({ kind: "url", label, url: null, ref: label });
const draftFor = (audience: string, text: string) => ({
  missionId,
  audience,
  channel: "cliq" as const,
  target: link(`dm-${audience}`),
  text,
});

describe("boundary review regressions", () => {
  it.effect("H8: an iMessage answer must name the chosen option and nothing against it", () => {
    const { layer } = harness([
      owner("msg-keep", "keep it safe", T0 + MINUTE),
      owner("msg-negated", "do not deploy", T0 + MINUTE),
      owner("msg-deploy", "deploy", T0 + MINUTE),
    ]);
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const risky = askInput("Deploy now?", {
        options: [
          { id: "deploy", label: "Deploy", detail: "" },
          { id: "hold", label: "Hold", detail: "" },
        ],
        recommendation: { optionId: "hold", reason: "Friday." },
      });
      const ask = yield* asks.openAsk(risky, master);

      // A real owner message that says something else can't stand in for an option.
      expect(
        yield* failureCode(
          asks.answerAsk(
            { askId: ask.id, optionId: "deploy", text: "", inboundId: "msg-keep" },
            relay,
          ),
        ),
      ).toBe("provenance-invalid");
      // Free text doesn't replace option verification either.
      expect(
        yield* failureCode(
          asks.answerAsk(
            { askId: ask.id, optionId: "deploy", text: "keep it safe", inboundId: "msg-keep" },
            relay,
          ),
        ),
      ).toBe("provenance-invalid");
      // A negated reply never matches the option it negates.
      expect(
        yield* failureCode(
          asks.answerAsk(
            { askId: ask.id, optionId: "deploy", text: "", inboundId: "msg-negated" },
            relay,
          ),
        ),
      ).toBe("provenance-invalid");
      // The master relaying without any inbound is not the owner.
      expect(
        yield* failureCode(asks.answerAsk({ askId: ask.id, optionId: "deploy", text: "" }, relay)),
      ).toBe("provenance-required");

      const answered = yield* asks.answerAsk(
        { askId: ask.id, optionId: "deploy", text: "", inboundId: "msg-deploy" },
        relay,
      );
      expect(answered.ask.answer?.optionId).toBe("deploy");
      expect(answered.ask.answer?.provenance).toMatchObject({ _tag: "owner-imessage" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("H9: an iMessage draft decision must say that decision and the edited text", () => {
    const { layer } = harness([
      owner("msg-line", "Do not send the line hello world.", T0 + MINUTE),
      owner("msg-dont", "do not approve", T0 + MINUTE),
      owner("msg-edit", "approve: hello world", T0 + MINUTE),
    ]);
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const draft = yield* asks.submitDraft(
        draftFor("Sami", "Hi Sami, the fix is merged."),
        writer,
      );

      expect(
        yield* failureCode(
          asks.decideDraft(
            {
              draftId: draft.id,
              action: "approve",
              editedText: "hello world",
              inboundId: "msg-line",
            },
            relay,
          ),
        ),
      ).toBe("provenance-invalid");
      expect(
        yield* failureCode(
          asks.decideDraft({ draftId: draft.id, action: "approve", inboundId: "msg-dont" }, relay),
        ),
      ).toBe("provenance-invalid");
      expect((yield* asks.drafts({ missionId }))[0]?.status).toBe("pending");

      const approved = yield* asks.decideDraft(
        { draftId: draft.id, action: "approve", editedText: "hello world", inboundId: "msg-edit" },
        relay,
      );
      expect(approved.draft.status).toBe("approved");
      expect(approved.draft.approvedText).toBe("hello world");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "H10: approvals bind to the draft's current revision; older evidence is refused",
    () => {
      const { layer } = harness([
        owner("msg-yes", "yes", T0 + MINUTE),
        owner("msg-yes-2", "ok send it", T0 + 2 * 60 * MINUTE + MINUTE),
        owner("msg-both", "approve", T0 + 5 * MINUTE),
      ]);
      return Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        yield* seed;
        const asks = yield* AsksService.AsksService;
        const draft = yield* asks.submitDraft(draftFor("Sami", "The fix is merged."), writer);
        expect(draft.revision).toBe(0);

        // The writer revises hours after the owner's "yes"; that yes was for other text.
        yield* TestClock.setTime(T0 + 2 * 60 * MINUTE);
        const revised = yield* asks.reviseDraft(
          { draftId: draft.id, text: "The fix is merged and deployed." },
          writer,
        );
        expect(revised.revision).toBe(1);
        expect(
          yield* failureCode(
            asks.decideDraft({ draftId: draft.id, action: "approve", inboundId: "msg-yes" }, relay),
          ),
        ).toBe("provenance-invalid");
        // An app decision made against the old revision is refused too.
        expect(
          yield* failureCode(
            asks.decideDraft({ draftId: draft.id, action: "approve", revision: 0 }, ownerApp),
          ),
        ).toBe("conflict");

        yield* TestClock.setTime(T0 + 2 * 60 * MINUTE + 2 * MINUTE);
        const approved = yield* asks.decideDraft(
          { draftId: draft.id, action: "approve", inboundId: "msg-yes-2" },
          relay,
        );
        expect(approved.draft.status).toBe("approved");

        // After a reopen, the approving inbound of the earlier epoch no longer counts.
        yield* TestClock.setTime(T0 + 3 * 60 * MINUTE);
        const reopened = yield* asks.reopenDraft({ draftId: draft.id }, ownerApp);
        expect(reopened.revision).toBe(2);
        expect(
          yield* failureCode(
            asks.decideDraft(
              { draftId: draft.id, action: "approve", inboundId: "msg-yes-2" },
              relay,
            ),
          ),
        ).toBe("provenance-invalid");
        expect(
          (yield* asks.decideDraft({ draftId: draft.id, action: "approve", revision: 2 }, ownerApp))
            .draft.status,
        ).toBe("approved");

        // One inbound may still approve two drafts that both existed when it arrived.
        yield* TestClock.setTime(T0);
        const first = yield* asks.submitDraft(draftFor("Lee", "Lee, it's live."), writer);
        const second = yield* asks.submitDraft(draftFor("Kim", "Kim, it's live."), writer);
        for (const each of [first, second]) {
          const decided = yield* asks.decideDraft(
            { draftId: each.id, action: "approve", inboundId: "msg-both" },
            relay,
          );
          expect(decided.draft.status).toBe("approved");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("N9: a reopened ask takes no iMessage from before the reopen", () => {
    const { layer } = harness([
      owner("msg-offline", "offline window", T0 + MINUTE),
      owner("msg-early", "offline window", T0 + 90_000),
      owner("msg-online", "online", T0 + 3 * MINUTE),
      owner("msg-both", "offline window", T0 + MINUTE),
    ]);
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const ask = yield* asks.openAsk(askInput("Which way?"), master);
      expect(ask.revision ?? 0).toBe(0);

      yield* TestClock.setTime(T0 + MINUTE + 10_000);
      const answered = yield* asks.answerAsk(
        { askId: ask.id, optionId: "b", text: "", inboundId: "msg-offline" },
        relay,
      );
      expect(answered.ask.status).toBe("answered");

      // He takes it back a minute later, well inside the usual clock skew.
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      const reopened = yield* asks.reopenAsk({ askId: ask.id, reason: "Not sure" }, ownerApp);
      expect(reopened.revision).toBe(1);
      expect(reopened.spentInboundIds).toEqual(["msg-offline"]);
      // The reply that answered the earlier epoch can't answer this one.
      expect(
        yield* failureCode(
          asks.answerAsk(
            { askId: ask.id, optionId: "b", text: "", inboundId: "msg-offline" },
            relay,
          ),
        ),
      ).toBe("provenance-invalid");
      // Nor can any other reply from before the reopen, even seconds before it.
      expect(
        yield* failureCode(
          asks.answerAsk({ askId: ask.id, optionId: "b", text: "", inboundId: "msg-early" }, relay),
        ),
      ).toBe("provenance-invalid");
      const again = yield* asks.answerAsk(
        { askId: ask.id, optionId: "a", text: "", inboundId: "msg-online" },
        relay,
      );
      expect(again.ask.answer?.optionId).toBe("a");

      // One reply may still answer two asks that were both open when it arrived.
      yield* TestClock.setTime(T0);
      const first = yield* asks.openAsk(askInput("Staging?"), master);
      const second = yield* asks.openAsk(askInput("Production?"), master);
      for (const each of [first, second]) {
        const decided = yield* asks.answerAsk(
          { askId: each.id, optionId: "b", text: "", inboundId: "msg-both" },
          relay,
        );
        expect(decided.ask.status).toBe("answered");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("M3: a master accepts a draft-note suggestion under its own name", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const store = yield* MissionStore.MissionStore;
      const proposed = yield* asks.proposeSuggestion(
        {
          missionId,
          targetKind: "draft-note",
          target: null,
          title: "Lead with the outcome",
          after: { missionId, scope: { _tag: "all" }, text: "Lead with the outcome." },
          diffText: "+ Lead with the outcome.",
          why: "Three edits in a row did this.",
          evidence: [{ kind: "lane", id: "lane-api" }],
        },
        governor,
      );
      expect(proposed.acceptor).toBe("owner");

      const decided = yield* asks.decideSuggestion(
        { suggestionId: proposed.id, action: "accept" },
        master,
      );
      expect(decided.outcome).toContain("Saved draft note");
      const note = (yield* asks.draftNotes(missionId)).find(
        (each) => each.text === "Lead with the outcome.",
      );
      expect(note?.writtenBy).toEqual({ _tag: "role", roleId: "role-master" });
      const events = yield* store.eventsSince(missionId, 0, 1000);
      expect(events.find((event) => event.kind === "suggestion.decided")?.actor).toEqual({
        _tag: "role",
        roleId: "role-master",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("a draft note a master writes says it came from the master", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const theirs = yield* asks.saveDraftNote(
        { missionId, scope: { _tag: "all" }, text: "No exclamation marks." },
        master,
      );
      expect(theirs.source).toBe("master");
      const his = yield* asks.saveDraftNote(
        { missionId, scope: { _tag: "all" }, text: "Sign with initials." },
        ownerApp,
      );
      expect(his.source).toBe("owner");
      // An edit keeps where the note started and records who changed it.
      const edited = yield* asks.saveDraftNote(
        { noteId: theirs.id, missionId, scope: { _tag: "all" }, text: "No exclamation marks!" },
        ownerApp,
      );
      expect(edited.source).toBe("master");
      expect(edited.writtenBy).toEqual({ _tag: "owner" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("R2: a master can't rewrite or move another mission's draft notes", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const asks = yield* AsksService.AsksService;
      const theirs = yield* asks.saveDraftNote(
        { missionId: otherMissionId, scope: { _tag: "all" }, text: "Sign off as the team." },
        ownerApp,
      );
      // Moving it into the master's own mission is refused...
      expect(
        yield* failureCode(
          asks.saveDraftNote(
            { noteId: theirs.id, missionId, scope: { _tag: "all" }, text: "Hijacked." },
            master,
          ),
        ),
      ).toBe("invalid");
      // ...and editing it in place needs that mission's master.
      expect(
        yield* failureCode(
          asks.saveDraftNote(
            { noteId: theirs.id, missionId: otherMissionId, scope: { _tag: "all" }, text: "x" },
            master,
          ),
        ),
      ).toBe("forbidden");
      // A suggestion in this mission can't write a note for the other one.
      const proposed = yield* asks.proposeSuggestion(
        {
          missionId,
          targetKind: "draft-note",
          target: { kind: "draft-note", id: theirs.id },
          title: "Retire their note",
          after: { missionId: otherMissionId, scope: { _tag: "all" }, text: "x", active: false },
          diffText: "- note",
          why: "It reads stiff.",
          evidence: [{ kind: "lane", id: "lane-api" }],
        },
        governor,
      );
      const decided = yield* asks.decideSuggestion(
        { suggestionId: proposed.id, action: "accept" },
        master,
      );
      expect(decided.outcome).toContain("Not applied");
      const still = (yield* asks.draftNotes(otherMissionId)).find((n) => n.id === theirs.id);
      expect(still).toMatchObject({ text: "Sign off as the team.", active: true });
      expect(DraftNoteId.make(theirs.id)).toBe(theirs.id);
    }).pipe(Effect.provide(layer));
  });

  it.effect("R3: an applier that crashes still leaves an outcome on the suggestion", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const registry = yield* Ports.SuggestionApplierRegistry;
      yield* registry.register(["lane"], () => Effect.die("boom"));
      const proposed = yield* asks.proposeSuggestion(
        {
          missionId,
          targetKind: "lane",
          target: { kind: "lane", id: "lane-api" },
          title: "Rename the lane",
          after: { name: "API v2" },
          diffText: "API -> API v2",
          why: "It grew.",
          evidence: [{ kind: "lane", id: "lane-api" }],
        },
        governor,
      );
      const decided = yield* asks.decideSuggestion(
        { suggestionId: proposed.id, action: "accept" },
        master,
      );
      expect(decided.status).toBe("accepted");
      expect(decided.outcome).toBe("Not applied: the applier failed unexpectedly.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("R4: suggestions about a custom master role go to the owner", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const asks = yield* AsksService.AsksService;
      const proposed = yield* asks.proposeSuggestion(
        {
          missionId: otherMissionId,
          targetKind: "role-model",
          target: { kind: "role", id: "role-lead-2" },
          title: "Move the lead to a cheaper model",
          after: { modelSelection: { instanceId: "opencode", model: "haiku" } },
          diffText: "opus -> haiku",
          why: "Mostly routing work.",
          evidence: [{ kind: "lane", id: "lane-other" }],
        },
        governor,
      );
      expect(proposed.acceptor).toBe("owner");
      // The other mission's master is still found through masterRoleId.
      const standing = yield* asks.standing(otherMissionId, agent(otherMasterThread));
      expect(standing.isMaster).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
