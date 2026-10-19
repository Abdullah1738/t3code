// Regressions for the boundary review (Sol, H8-H10 and M3) and the round 2
// self-review: each test walks one exploit chain end to end.
import { describe, expect, it } from "@effect/vitest";
import { DraftNoteId, type MissionLink, type Suggestion } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import {
  agent,
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

const T0 = Date.parse(at);
const MINUTE = 60_000;
const master = agent(masterThread);
const writer = agent(writerThread);
const link = (label: string): MissionLink => ({ kind: "url", label, url: null, ref: label });
const draftFor = (audience: string, text: string) => ({
  missionId,
  audience,
  channel: "cliq" as const,
  target: link(`dm-${audience}`),
  text,
});

describe("boundary review regressions", () => {
  // H8, H9 and N9 (iMessage words and epochs) moved with the redemption to the
  // desk transport; asks/http.test.ts and guard/inboundActions.test.ts cover them.
  it.effect("H10: an app approval binds to the draft's current revision", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const draft = yield* asks.submitDraft(draftFor("Sami", "The fix is merged."), writer);
      expect(draft.revision).toBe(0);
      yield* TestClock.setTime(T0 + 2 * 60 * MINUTE);
      const revised = yield* asks.reviseDraft(
        { draftId: draft.id, text: "The fix is merged and deployed." },
        writer,
      );
      expect(revised.revision).toBe(1);
      // An app decision made against the old revision is refused.
      expect(
        yield* failureCode(
          asks.decideDraft({ draftId: draft.id, action: "approve", revision: 0 }, ownerApp),
        ),
      ).toBe("conflict");
      expect(
        (yield* asks.decideDraft({ draftId: draft.id, action: "approve", revision: 1 }, ownerApp))
          .draft.status,
      ).toBe("approved");
    }).pipe(Effect.provide(harness().layer)),
  );

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
