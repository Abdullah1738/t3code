import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import type { ScribeBatchInput, ScribeNoteDraft } from "./batch.ts";
import { MissionRecords, memoryLayer } from "./ports.ts";
import * as ScribeService from "./ScribeService.ts";
import * as ScribeStore from "./ScribeStore.ts";
import {
  LANE_THREAD,
  MASTER_THREAD,
  MISSION_ID,
  seedMission,
  seedTranscript,
} from "./testFixtures.ts";

const TestLayer = ScribeService.layer.pipe(
  Layer.provideMerge(ScribeStore.layer),
  Layer.provideMerge(memoryLayer(() => "2026-10-17T12:00:00.000Z")),
  Layer.provideMerge(Sqlite.layerMemory),
);

const items = [
  {
    ordinal: 2000001,
    type: "user_message",
    payload: { text: "Master here. Please finish the rewards backfill today.", createdBy: "user" },
  },
  {
    ordinal: 2000002,
    type: "assistant_message",
    payload: { text: "Assuming the ledger table is empty on dev, so no backfill is needed." },
  },
  {
    ordinal: 2000003,
    type: "command_execution",
    payload: { input: "gh pr view 216 --json state", output: '{"state":"OPEN"}', exitCode: 0 },
  },
  {
    ordinal: 2000004,
    type: "assistant_message",
    payload: { text: "Merged rewards#216 and the deploy is live on dev." },
  },
];

const note = (overrides: Partial<ScribeNoteDraft>): ScribeNoteDraft => ({
  type: "assumption",
  summary: "Lane assumes the dev ledger table is empty, so it skips the backfill.",
  quote: "Assuming the ledger table is empty on dev",
  event: 2000002,
  fromEvent: 2000002,
  toEvent: 2000002,
  basis: "claimed",
  severity: "medium",
  confidence: 0.7,
  replaces: null,
  ...overrides,
});

const batch = (overrides: Partial<ScribeBatchInput>): ScribeBatchInput => ({
  missionId: MISSION_ID,
  laneId: "lane-money",
  subMissionId: null,
  threadId: LANE_THREAD,
  fromEvent: 2000001,
  toEvent: 2000004,
  notes: [],
  candidates: [],
  droppedCount: 0,
  usage: { input: 1000, output: 200 },
  model: "cc/claude-haiku-5-5",
  ...overrides,
});

it.layer(TestLayer)("scribe service", (it) => {
  it.effect("lists lane and master threads with cursors from before they joined", () =>
    Effect.gen(function* () {
      yield* seedMission;
      yield* seedTranscript({
        threadId: LANE_THREAD,
        run: 1,
        requestedAt: "2026-10-16T23:00:00.000Z",
        items: [{ ordinal: 1000001, type: "assistant_message", payload: { text: "old work" } }],
      });
      yield* seedTranscript({
        threadId: LANE_THREAD,
        run: 2,
        requestedAt: "2026-10-17T02:00:00.000Z",
        items,
        threadPayload: {
          pullRequests: [
            {
              repository: "equicom-crypto/rewards",
              number: 216,
              url: "https://github.com/equicom-crypto/rewards/pull/216",
              snapshot: { state: "open" },
            },
          ],
        },
      });
      const service = yield* ScribeService.ScribeService;
      const lanes = yield* service.lanes(MISSION_ID);
      assert.deepStrictEqual(
        lanes.map((lane) => [lane.name, lane.threadId, lane.cursor]),
        [
          ["Money", LANE_THREAD, 1000001],
          ["master", MASTER_THREAD, 0],
        ],
      );
    }),
  );

  it.effect("stores checked notes once; a rerun of the same range posts nothing", () =>
    Effect.gen(function* () {
      const service = yield* ScribeService.ScribeService;
      const records = yield* MissionRecords;
      const posted = batch({
        notes: [
          note({}),
          // Paraphrase: fails the citation check but is kept for the pass rate.
          note({
            type: "risk",
            summary: "Lane might be wrong about the ledger.",
            quote: "the ledger is probably empty on dev",
          }),
          note({
            type: "claim-of-done",
            summary: "Lane says rewards#216 is merged and live on dev.",
            quote: "Merged rewards#216 and the deploy is live on dev.",
            event: 2000004,
            fromEvent: 2000004,
            toEvent: 2000004,
          }),
        ],
      });
      const first = yield* service.ingest(posted);
      assert.isFalse(first.duplicate);
      assert.equal(first.accepted, 2);
      assert.equal(first.failed, 1);
      assert.equal(first.cursor, 2000004);

      const notes = yield* records.list("note", { missionId: MISSION_ID });
      assert.equal(notes.length, 3);
      const claim = notes.find((stored) => stored.type === "claim-of-done");
      assert.equal(claim?.evidence, "mismatch");
      assert.equal(notes.find((stored) => stored.type === "risk")?.citation, "failed");
      const events = yield* records.eventsSince(MISSION_ID, 0, 100);
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        ["note.recorded", "note.recorded"],
      );

      const again = yield* service.ingest(posted);
      assert.isTrue(again.duplicate);
      assert.equal((yield* records.list("note", { missionId: MISSION_ID })).length, 3);
      assert.equal((yield* records.eventsSince(MISSION_ID, 0, 100)).length, 2);

      const lanes = yield* service.lanes(MISSION_ID);
      assert.equal(lanes[0]?.cursor, 2000004);

      const stats = yield* service.stats(MISSION_ID, null);
      assert.equal(stats.batches, 1);
      assert.equal(stats.citationPassRate, 2 / 3);
      assert.equal(stats.mismatch, 1);
    }),
  );

  it.effect("feeds open notes back to the scribe and ranks the FYI list", () =>
    Effect.gen(function* () {
      const service = yield* ScribeService.ScribeService;
      const open = yield* service.openNotes(MISSION_ID, LANE_THREAD);
      assert.deepStrictEqual(open.map((line) => line.type).toSorted(), [
        "assumption",
        "claim-of-done",
      ]);
      const fyi = yield* service.fyi(MISSION_ID, 10);
      assert.equal(fyi[0]?.type, "claim-of-done");
      assert.equal(fyi.length, 2);
    }),
  );

  it.effect("a replacing note retires the old one from open notes", () =>
    Effect.gen(function* () {
      const service = yield* ScribeService.ScribeService;
      yield* seedTranscript({
        threadId: LANE_THREAD,
        run: 3,
        requestedAt: "2026-10-17T03:00:00.000Z",
        items: [
          {
            ordinal: 3000001,
            type: "assistant_message",
            payload: {
              text: "Checked dev: the ledger table has 40 rows, so we do need a backfill.",
            },
          },
        ],
      });
      const old = (yield* service.openNotes(MISSION_ID, LANE_THREAD)).find(
        (line) => line.type === "assumption",
      );
      assert.isDefined(old);
      const result = yield* service.ingest(
        batch({
          fromEvent: 3000001,
          toEvent: 3000001,
          notes: [
            note({
              type: "deviation",
              summary: "Ledger is not empty on dev; the lane now plans a backfill.",
              quote: "the ledger table has 40 rows, so we do need a backfill",
              event: 3000001,
              fromEvent: 3000001,
              toEvent: 3000001,
              basis: "claimed",
              replaces: old?.id ?? null,
            }),
          ],
        }),
      );
      assert.equal(result.accepted, 1);
      const open = yield* service.openNotes(MISSION_ID, LANE_THREAD);
      assert.deepStrictEqual(open.map((line) => line.type).toSorted(), [
        "claim-of-done",
        "deviation",
      ]);
    }),
  );

  it.effect("refuses batches for unknown missions and backwards ranges", () =>
    Effect.gen(function* () {
      const service = yield* ScribeService.ScribeService;
      const unknown = yield* Effect.flip(service.ingest(batch({ missionId: "mission-nope" })));
      assert.equal(unknown._tag === "MissionError" ? unknown.code : unknown._tag, "not-found");
      const backwards = yield* Effect.flip(
        service.ingest(batch({ fromEvent: 9000002, toEvent: 9000001 })),
      );
      assert.equal(backwards._tag === "MissionError" ? backwards.code : backwards._tag, "invalid");
    }),
  );
});
