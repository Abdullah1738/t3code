// Regressions for the boundary review (Sol, H8-H10 and M3) and the round 2
// self-review: each test walks one exploit chain end to end.
import { describe, expect, it } from "@effect/vitest";
import { DraftNoteId, type MissionLink, type Suggestion } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import {
  addressed,
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
  typedInbound,
  writerThread,
} from "./AsksService.testkit.ts";
import * as Ports from "./ports.ts";
import type { InboundMessage } from "./provenance.ts";

const T0 = Date.parse(at);
const MINUTE = 60_000;
const relay = agent(masterThread);
const master = agent(masterThread);
const writer = agent(writerThread);
/**
 * A harness whose inbox fills as the test goes: `say` files the owner's reply
 * to a record, addressed by its handle as P1 requires.
 */
const withInbox = () => {
  const inbox: Array<InboundMessage> = [];
  const { layer } = harness(inbox);
  const say = (id: string, recordId: string, text: string, receivedAt: number) => {
    inbox.push(typedInbound(id, addressed(recordId, text), receivedAt));
  };
  return { layer, say };
};
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
    const { layer, say } = withInbox();
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
      say("msg-keep", ask.id, "keep it safe", T0 + MINUTE);
      say("msg-negated", ask.id, "do not deploy", T0 + MINUTE);
      say("msg-deploy", ask.id, "deploy", T0 + MINUTE);

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
    const { layer, say } = withInbox();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const draft = yield* asks.submitDraft(
        draftFor("Sami", "Hi Sami, the fix is merged."),
        writer,
      );
      say("msg-line", draft.id, "Do not send the line hello world.", T0 + MINUTE);
      say("msg-dont", draft.id, "do not approve", T0 + MINUTE);
      say("msg-edit", draft.id, "approve: hello world", T0 + MINUTE);

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
      const { layer, say } = withInbox();
      return Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        yield* seed;
        const asks = yield* AsksService.AsksService;
        const draft = yield* asks.submitDraft(draftFor("Sami", "The fix is merged."), writer);
        expect(draft.revision).toBe(0);
        say("msg-yes", draft.id, "yes", T0 + MINUTE);
        say("msg-yes-2", draft.id, "ok send it", T0 + 2 * 60 * MINUTE + MINUTE);

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

        // Sol P1: one reply speaks for the one draft it names, even when two
        // were pending when it arrived.
        yield* TestClock.setTime(T0);
        const first = yield* asks.submitDraft(draftFor("Lee", "Lee, it's live."), writer);
        const second = yield* asks.submitDraft(draftFor("Kim", "Kim, it's live."), writer);
        say("msg-both", first.id, "approve", T0 + 5 * MINUTE);
        expect(
          (yield* asks.decideDraft(
            { draftId: first.id, action: "approve", inboundId: "msg-both" },
            relay,
          )).draft.status,
        ).toBe("approved");
        expect(
          yield* failureCode(
            asks.decideDraft(
              { draftId: second.id, action: "approve", inboundId: "msg-both" },
              relay,
            ),
          ),
        ).toBe("provenance-invalid");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("N9: a reopened ask takes no iMessage from before the reopen", () => {
    const { layer, say } = withInbox();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const ask = yield* asks.openAsk(askInput("Which way?"), master);
      expect(ask.revision ?? 0).toBe(0);
      say("msg-offline", ask.id, "offline window", T0 + MINUTE);
      say("msg-early", ask.id, "offline window", T0 + 90_000);
      say("msg-online", ask.id, "online", T0 + 3 * MINUTE);

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

      // Sol P1: one reply answers the one ask it names, even with two open.
      yield* TestClock.setTime(T0);
      const first = yield* asks.openAsk(askInput("Staging?"), master);
      const second = yield* asks.openAsk(askInput("Production?"), master);
      say("msg-both", first.id, "offline window", T0 + MINUTE);
      expect(
        (yield* asks.answerAsk(
          { askId: first.id, optionId: "b", text: "", inboundId: "msg-both" },
          relay,
        )).ask.status,
      ).toBe("answered");
      expect(
        yield* failureCode(
          asks.answerAsk(
            { askId: second.id, optionId: "b", text: "", inboundId: "msg-both" },
            relay,
          ),
        ),
      ).toBe("provenance-invalid");
    }).pipe(Effect.provide(layer));
  });

  it.effect("N9: an ask reopened before asks kept an epoch still takes nothing older", () => {
    const { layer, say } = withInbox();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const store = yield* MissionStore.MissionStore;
      const ask = yield* asks.openAsk(askInput("Which way?"), master);
      say("msg-early", ask.id, "offline window", T0 + 90_000);
      say("msg-late", ask.id, "online", T0 + 3 * MINUTE);
      // Stored by an older build: reopened at T0+2min, with no revision fields.
      const {
        revision: _revision,
        revisedAt: _revisedAt,
        spentInboundIds: _spent,
        ...legacy
      } = ask;
      yield* store.commit({
        event: {
          missionId,
          kind: "ask.reopened",
          actor: { _tag: "system", component: "missions" },
          provenance: ownerApp,
          summary: "Ask reopened",
          subject: { kind: "ask", id: ask.id },
        },
        upserts: [
          // T0 + 2 minutes.
          { _tag: "ask", record: { ...legacy, updatedAt: "2026-10-17T08:02:00.000Z" } },
        ],
      });

      yield* TestClock.setTime(T0 + 4 * MINUTE);
      // Within the old clock skew of the reopen, but before it.
      expect(
        yield* failureCode(
          asks.answerAsk({ askId: ask.id, optionId: "b", text: "", inboundId: "msg-early" }, relay),
        ),
      ).toBe("provenance-invalid");
      const answered = yield* asks.answerAsk(
        { askId: ask.id, optionId: "a", text: "", inboundId: "msg-late" },
        relay,
      );
      expect(answered.ask.answer?.optionId).toBe("a");
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

  it.effect("an accepted suggestion the last process never applied applies at startup", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* TestClock.setTime(T0 + MINUTE);
      const asks = yield* AsksService.AsksService;
      const store = yield* MissionStore.MissionStore;
      const propose = (title: string, after: unknown = { name: title }) =>
        asks.proposeSuggestion(
          {
            missionId,
            targetKind: "lane",
            target: { kind: "lane", id: "lane-api" },
            title,
            after,
            diffText: `API -> ${title}`,
            why: "It grew.",
            evidence: [{ kind: "lane", id: "lane-api" }],
          },
          governor,
        );
      const split = (title: string) => propose(title, { split: { name: title } });
      // The state a crash leaves: the decision committed, no outcome yet.
      const acceptedThenCrashed = (
        suggestion: Suggestion,
        options: { readonly global?: boolean; readonly decidedAt?: string } = {},
      ) =>
        store.commit({
          event: {
            missionId: options.global ? AsksService.GLOBAL_TIMELINE : missionId,
            kind: "suggestion.decided",
            actor: { _tag: "thread", threadId: masterThread },
            provenance: master,
            summary: `Suggestion accepted: ${suggestion.title}`,
            subject: { kind: "suggestion", id: suggestion.id, label: suggestion.title },
            payload: { action: "accept" },
          },
          upserts: [
            {
              _tag: "suggestion",
              record: {
                ...suggestion,
                ...(options.global ? { missionId: null } : {}),
                status: "accepted",
                decidedBy: master,
                decidedAt: options.decidedAt ?? at,
              },
            },
          ],
        });
      // What the applier committed before the crash, on the lane's mission.
      const appliedBeforeCrash = (
        decision: MissionStore.MissionCommitResult,
        kind: "lane.updated" | "lane.split",
      ) =>
        store.commit({
          event: {
            missionId,
            kind,
            actor: { _tag: "system", component: "missions" },
            provenance: master,
            summary: "Lane changed",
            subject: { kind: "lane", id: "lane-api" },
            causedBy: decision.event.id,
          },
        });

      const fresh = yield* propose("API v2");
      yield* acceptedThenCrashed(fresh);
      // Its rename committed, then the server stopped: setting it again is harmless.
      const halfDone = yield* propose("API v3");
      yield* appliedBeforeCrash(yield* acceptedThenCrashed(halfDone), "lane.updated");
      // Splitting again would add a second lane, so a split that left its
      // mark is not run again, even when it landed on another timeline.
      const splitDone = yield* split("API edge");
      yield* appliedBeforeCrash(yield* acceptedThenCrashed(splitDone), "lane.split");
      const globalSplitDone = yield* split("API batch");
      yield* appliedBeforeCrash(
        yield* acceptedThenCrashed(globalSplitDone, { global: true }),
        "lane.split",
      );
      const splitPending = yield* split("API admin");
      yield* acceptedThenCrashed(splitPending);
      // Decided two days ago: too late to apply quietly.
      const stale = yield* propose("API v0");
      yield* acceptedThenCrashed(stale, {
        decidedAt: "2026-10-15T08:00:00.000Z",
      });

      const applied: string[] = [];
      const registry = yield* Ports.SuggestionApplierRegistry;
      yield* registry.register(["lane"], (application) =>
        Effect.sync(() => {
          applied.push(application.suggestion.id);
          return `Applied: ${application.suggestion.title}.`;
        }),
      );

      yield* asks.applyPendingSuggestions;
      expect(applied.toSorted()).toEqual([fresh.id, halfDone.id, splitPending.id].toSorted());
      const outcomeOf = (id: string) =>
        store
          .get("suggestion", id)
          .pipe(Effect.map((found) => (found._tag === "Some" ? found.value.outcome : null)));
      expect(yield* outcomeOf(fresh.id)).toBe("Applied: API v2.");
      expect(yield* outcomeOf(halfDone.id)).toBe("Applied: API v3.");
      expect(yield* outcomeOf(splitPending.id)).toBe("Applied: API admin.");
      expect(yield* outcomeOf(splitDone.id)).toMatch(/^Applied before a restart:/);
      expect(yield* outcomeOf(globalSplitDone.id)).toMatch(/^Applied before a restart:/);
      expect(yield* outcomeOf(stale.id)).toMatch(/^Not applied: .*more than a day old/);
      const outcomes = [
        ...(yield* store.eventsSince(missionId, 0)),
        ...(yield* store.eventsSince(AsksService.GLOBAL_TIMELINE, 0)),
      ].filter((event) => event.kind === "suggestion.applied");
      expect(outcomes).toHaveLength(6);

      // A second sweep finds nothing left to do.
      yield* asks.applyPendingSuggestions;
      expect(applied).toHaveLength(3);
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
