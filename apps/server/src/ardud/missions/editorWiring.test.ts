import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MissionId } from "@t3tools/contracts";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { editorWiringLayer } from "./editorWiring.ts";
import * as MissionService from "./MissionService.ts";
import type { ScribeBatchInput, ScribeNoteDraft } from "./scribe/batch.ts";
import { ScribeLive } from "./scribe/layer.ts";
import * as ScribeService from "./scribe/ScribeService.ts";
import { LANE_THREAD, MISSION_ID, seedMission, seedTranscript } from "./scribe/testFixtures.ts";
import * as MissionStore from "./store/MissionStore.ts";

const TestLayer = editorWiringLayer.pipe(
  Layer.provideMerge(MissionService.layer),
  Layer.provideMerge(ScribeLive),
  Layer.provideMerge(MissionStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const items = [
  {
    ordinal: 2000001,
    type: "assistant_message",
    payload: { text: "Assuming the ledger table is empty on dev, so no backfill is needed." },
  },
  {
    ordinal: 2000002,
    type: "assistant_message",
    payload: { text: "Merged rewards#216 and the deploy is live on dev." },
  },
];

const note = (overrides: Partial<ScribeNoteDraft>): ScribeNoteDraft => ({
  type: "assumption",
  summary: "Lane assumes the dev ledger table is empty, so it skips the backfill.",
  quote: "Assuming the ledger table is empty on dev",
  event: 2000001,
  fromEvent: 2000001,
  toEvent: 2000001,
  basis: "claimed",
  severity: "high",
  confidence: 0.7,
  replaces: null,
  ...overrides,
});

const batch: ScribeBatchInput = {
  missionId: MISSION_ID,
  laneId: "lane-money",
  subMissionId: null,
  threadId: LANE_THREAD,
  fromEvent: 2000001,
  toEvent: 2000002,
  notes: [
    note({}),
    note({
      type: "owner-must-know",
      summary: "Lane says rewards#216 is merged and live on dev.",
      quote: "Merged rewards#216 and the deploy is live on dev.",
      event: 2000002,
      fromEvent: 2000002,
      toEvent: 2000002,
    }),
    // A paraphrase: the citation check fails, so it must never reach the FYI list.
    note({
      type: "owner-must-know",
      severity: "critical",
      summary: "Lane might have wiped the ledger.",
      quote: "the ledger was wiped on dev",
    }),
  ],
  candidates: [],
  droppedCount: 0,
  usage: { input: 1000, output: 200 },
  model: "cc/claude-haiku-5-5",
};

it.layer(TestLayer)("scribe as the missions editor", (it) => {
  it.effect("the overview shows the editor's bottom line and feed; the inbox its FYI", () =>
    Effect.gen(function* () {
      yield* seedMission;
      yield* seedTranscript({
        threadId: LANE_THREAD,
        run: 2,
        requestedAt: "2026-10-17T02:00:00.000Z",
        items,
      });
      const scribe = yield* ScribeService.ScribeService;
      const missions = yield* MissionService.MissionService;
      const store = yield* MissionStore.MissionStore;
      const missionId = MissionId.make(MISSION_ID);

      // Before the editor has written anything, core falls back to its own feed.
      const before = yield* missions.overview(missionId);
      assert.equal(before.bottomLine, "");
      assert.isNull(before.bottomLineAt);

      const ingested = yield* scribe.ingest(batch);
      assert.equal(ingested.failed, 1);
      const notes = yield* store.list("note", { missionId });
      const failed = notes.find((stored) => stored.citation === "failed");
      const verified = notes.filter((stored) => stored.citation === "verified");
      assert.isDefined(failed);
      assert.equal(verified.length, 2);

      const input = yield* scribe.editorInput(MISSION_ID);
      const reply = {
        bottomLine: "Money lane says the rewards fix is live; the PR still reads open.",
        fyiOrder: [verified[1]?.id, verified[0]?.id],
        feed: [
          { kind: "note", summary: "Rewards fix claimed live", ref: `note:${input.notes[0]?.id}` },
        ],
        suggestions: [],
      };
      yield* scribe.applyEditor({
        missionId: MISSION_ID,
        since: input.since,
        reply,
        model: "cc/claude-opus-5-5",
        usage: { input: 5000, output: 600 },
      });

      const overview = yield* missions.overview(missionId);
      assert.equal(overview.bottomLine, reply.bottomLine);
      assert.isNotNull(overview.bottomLineAt);
      assert.deepStrictEqual(
        overview.feed.map((item) => [item.kind, item.summary]),
        [["note", "Rewards fix claimed live"]],
      );

      const expected = [verified[1]?.id, verified[0]?.id];
      const inbox = yield* missions.inbox(missionId);
      assert.deepStrictEqual(
        inbox.fyi.map((shown) => shown.id),
        expected,
      );
      assert.equal(inbox.counts.fyi, 2);
      assert.isFalse(inbox.fyi.some((shown) => shown.id === failed?.id));

      // The all-missions inbox takes the same ranked list.
      const everywhere = yield* missions.inbox(null);
      assert.deepStrictEqual(
        everywhere.fyi.map((shown) => shown.id),
        expected,
      );
    }),
  );
});
