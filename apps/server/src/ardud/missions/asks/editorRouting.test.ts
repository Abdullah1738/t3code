import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MissionId } from "@t3tools/contracts";

import * as ScribeService from "../scribe/ScribeService.ts";
import * as ScribeStore from "../scribe/ScribeStore.ts";
import { LANE_THREAD, MISSION_ID, seedMission, seedTranscript } from "../scribe/testFixtures.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { harness } from "./AsksService.testkit.ts";
import { routeEditorSuggestions } from "./wiring.ts";

const TestLayer = ScribeService.layer.pipe(
  Layer.provideMerge(ScribeStore.layer),
  Layer.provideMerge(harness().layer),
);

const items = [
  {
    ordinal: 2000001,
    type: "user_message",
    payload: { text: "Master here. Please finish the rewards backfill today.", createdBy: "user" },
  },
];

it.layer(TestLayer)("editor suggestions through asks", (it) => {
  it.effect("opens the editor's suggestion with asks' acceptor and replays to nothing", () =>
    Effect.gen(function* () {
      yield* seedMission;
      yield* seedTranscript({
        threadId: LANE_THREAD,
        run: 2,
        requestedAt: "2026-10-17T02:00:00.000Z",
        items,
      });
      yield* routeEditorSuggestions;
      const scribe = yield* ScribeService.ScribeService;
      const store = yield* MissionStore.MissionStore;
      const scribeStore = yield* ScribeStore.ScribeStore;
      yield* scribe.ingest({
        missionId: MISSION_ID,
        laneId: "lane-money",
        subMissionId: null,
        threadId: LANE_THREAD,
        fromEvent: 2000001,
        toEvent: 2000001,
        notes: [],
        candidates: [
          {
            targetKind: "rule",
            title: "Masters give a deadline with every ask",
            proposal: "Every master ask names when it is needed.",
            why: "Lane had to guess the deadline.",
            quote: "Please finish the rewards backfill today.",
            event: 2000001,
          },
          {
            targetKind: "lane",
            title: "Money lane takes the backfill",
            proposal: "Move the backfill into the money lane.",
            why: "It keeps asking for it.",
            quote: "Please finish the rewards backfill today.",
            event: 2000001,
          },
        ],
        droppedCount: 0,
        usage: { input: 1000, output: 200 },
        model: "cc/claude-haiku-5-5",
      });
      const input = yield* scribe.editorInput(MISSION_ID);
      assert.equal(input.candidates.length, 2);
      const [ruleCandidate, laneCandidate] = input.candidates;
      const reply = {
        bottomLine: "Money lane wants deadlines.",
        fyiOrder: [],
        feed: [],
        suggestions: [
          {
            targetKind: "rule",
            title: "Masters give a deadline with every ask",
            change: "Add a rule: every master ask names when it is needed.",
            why: "The money lane had to guess.",
            fromCandidates: [ruleCandidate?.id ?? ""],
          },
          {
            targetKind: "lane",
            target: "lane:lane-money",
            title: "Money lane takes the backfill",
            change: "Move the backfill into the money lane.",
            why: "It keeps asking for it.",
            fromCandidates: [laneCandidate?.id ?? ""],
          },
        ],
      };
      const request = {
        missionId: MISSION_ID,
        since: input.since,
        reply,
        model: "cc/claude-opus-5-5",
        usage: { input: 5000, output: 600 },
      };
      const applied = yield* scribe.applyEditor(request);
      assert.deepStrictEqual(applied.rejected, []);
      assert.equal(applied.opened.length, 2);
      assert.deepStrictEqual(applied.rejected, []);

      const opened = yield* store.list("suggestion", { missionId: MissionId.make(MISSION_ID) });
      const byKind = Object.fromEntries(opened.map((row) => [row.targetKind, row]));
      assert.equal(byKind.rule?.author, "editor");
      assert.equal(byKind.rule?.acceptor, "owner");
      // Lanes are the master's control surface, whatever the editor asked for.
      assert.equal(byKind.lane?.acceptor, "master");
      assert.deepStrictEqual(
        opened.map((row) => row.id).toSorted(),
        [...applied.opened].toSorted(),
      );

      const merged = yield* scribeStore.candidates(MISSION_ID, "merged");
      assert.equal(merged.length, 2);
      const events = yield* store.eventsSince(MissionId.make(MISSION_ID), 0);
      const openedEvents = events.filter((event) => event.kind === "suggestion.opened");
      assert.equal(openedEvents.length, 2);
      assert.deepStrictEqual(openedEvents[0]?.actor, { _tag: "system", component: "editor" });

      const replay = yield* scribe.applyEditor(request);
      assert.deepStrictEqual(replay.opened, []);
      assert.equal((yield* store.eventsSince(MissionId.make(MISSION_ID), 0)).length, events.length);
    }),
  );
});
