import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MissionId, type Ask } from "@t3tools/contracts";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { ScribeBatchInput, ScribeNoteDraft } from "./batch.ts";
import * as ScribeService from "./ScribeService.ts";
import * as ScribeStore from "./ScribeStore.ts";
import {
  LANE_THREAD,
  MASTER_THREAD,
  MISSION_ID,
  putRecord,
  seedMission,
  seedTranscript,
} from "./testFixtures.ts";

const TestLayer = ScribeService.layer.pipe(
  Layer.provideMerge(ScribeStore.layer),
  Layer.provideMerge(MissionStore.layer),
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
      const store = yield* MissionStore.MissionStore;
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

      const notes = yield* store.list("note", { missionId: MissionId.make(MISSION_ID) });
      assert.equal(notes.length, 3);
      const claim = notes.find((stored) => stored.type === "claim-of-done");
      assert.equal(claim?.evidence, "mismatch");
      assert.equal(notes.find((stored) => stored.type === "risk")?.citation, "failed");
      const seeded = 3;
      const events = (yield* store.eventsSince(MissionId.make(MISSION_ID), seeded)).filter(
        (event) => event.kind === "note.recorded",
      );
      // One event for the whole batch, naming its strongest verified note.
      const verifiedIds = notes
        .filter((stored) => stored.citation === "verified")
        .map((stored) => stored.id as string);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.subject?.id, claim?.id);
      assert.deepStrictEqual(
        ((events[0]?.payload as { noteIds?: string[] } | null)?.noteIds ?? []).toSorted(),
        verifiedIds.toSorted(),
      );

      const again = yield* service.ingest(posted);
      assert.isTrue(again.duplicate);
      assert.equal(
        (yield* store.list("note", { missionId: MissionId.make(MISSION_ID) })).length,
        3,
      );
      assert.equal((yield* store.eventsSince(MissionId.make(MISSION_ID), 0)).length, seeded + 1);

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

  it.effect("an overlapping batch only notes events past the cursor", () =>
    Effect.gen(function* () {
      const service = yield* ScribeService.ScribeService;
      const store = yield* MissionStore.MissionStore;
      yield* seedTranscript({
        threadId: LANE_THREAD,
        run: 4,
        requestedAt: "2026-10-17T04:00:00.000Z",
        items: [
          {
            ordinal: 4000001,
            type: "assistant_message",
            payload: { text: "Holding the backfill until the master answers about dev data." },
          },
        ],
      });
      const stored = yield* store.list("note", { missionId: MissionId.make(MISSION_ID) });
      const before = stored.length;
      const risksBefore = stored.filter((note) => note.type === "risk").length;
      // A second pass that started from an older cursor re-notes event 3000001.
      const result = yield* service.ingest(
        batch({
          fromEvent: 2000001,
          toEvent: 4000001,
          notes: [
            note({
              type: "risk",
              summary: "Backfill size unknown.",
              quote: "the ledger table has 40 rows",
              event: 3000001,
              fromEvent: 3000001,
              toEvent: 3000001,
            }),
            note({
              type: "blocker",
              summary: "Backfill waits on the master.",
              quote: "Holding the backfill until the master answers",
              event: 4000001,
              fromEvent: 4000001,
              toEvent: 4000001,
            }),
          ],
        }),
      );
      assert.isFalse(result.duplicate);
      assert.equal(result.accepted, 1);
      assert.equal(result.stats?.dropped, 1);
      const after = yield* store.list("note", { missionId: MissionId.make(MISSION_ID) });
      assert.equal(after.length, before + 1);
      assert.equal(after.filter((note) => note.type === "risk").length, risksBefore);
      assert.isTrue(after.some((note) => note.type === "blocker"));
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

it.layer(TestLayer)("scribe reports", (it) => {
  it.effect("saves a report and the next one closes out what it left open", () =>
    Effect.gen(function* () {
      yield* seedMission;
      const service = yield* ScribeService.ScribeService;
      const ask = {
        id: "ask-go",
        missionId: MISSION_ID,
        subMissionId: null,
        askedBy: { _tag: "lane", laneId: "lane-money" },
        question: "Ship the rewards backfill?",
        context: "",
        options: [{ id: "yes", label: "Yes", detail: "" }],
        recommendation: null,
        blocks: [],
        costOfWaiting: "",
        urgency: "normal",
        status: "open",
        answer: null,
        createdAt: "2026-10-17T05:00:00.000Z",
        updatedAt: "2026-10-17T05:00:00.000Z",
      } as unknown as Ask;
      yield* putRecord({ _tag: "ask", record: ask });

      const first = yield* service.report({
        missionId: MISSION_ID,
        kind: "update",
        to: "2026-10-17T08:00:00.000Z",
        save: true,
      });
      assert.equal(first.coversFrom, "2026-10-17T04:00:00.000Z");
      assert.include(first.text, "**Needs you:**\n- **Ship the rewards backfill?** Waiting 3h.");
      assert.deepStrictEqual(
        first.open.map((item) => item.ref),
        ["ask:ask-go"],
      );

      yield* putRecord({
        _tag: "ask",
        record: {
          ...ask,
          status: "answered",
          answer: {
            optionId: "yes",
            text: "go ahead",
            provenance: { _tag: "owner-app", surface: "web", sessionId: null },
            answeredAt: "2026-10-17T09:00:00.000Z",
          },
        } as unknown as Ask,
      });
      const second = yield* service.report({
        missionId: MISSION_ID,
        kind: "update",
        to: "2026-10-17T12:00:00.000Z",
        save: true,
      });
      assert.equal(second.coversFrom, "2026-10-17T08:00:00.000Z");
      assert.include(
        second.text,
        "**Left hanging from 08:00:**\n- **Ship the rewards backfill?:** **Done.** Answered: go ahead.",
      );
      assert.include(
        second.text,
        "**Your decisions since 08:00:**\n- Ship the rewards backfill? Yes: go ahead.",
      );
      assert.include(second.text, "**Needs you:** Nothing.");

      const daily = yield* service.report({
        missionId: MISSION_ID,
        kind: "daily",
        to: "2026-10-17T12:00:00.000Z",
        save: false,
      });
      assert.include(daily.text, "Behind this summary: 2 update(s) at 08:00, 12:00 UTC.");
      assert.include(daily.text, "- **Ship the rewards backfill?:** **Done.** Answered: go ahead.");

      const empty = yield* Effect.flip(
        service.report({
          missionId: MISSION_ID,
          kind: "update",
          from: "2026-10-17T12:00:00.000Z",
          to: "2026-10-17T12:00:00.000Z",
          save: false,
        }),
      );
      assert.equal(empty._tag === "MissionError" ? empty.code : empty._tag, "invalid");

      const garbage = yield* Effect.flip(
        service.report({ missionId: MISSION_ID, kind: "update", to: "x", save: false }),
      );
      assert.equal(garbage._tag === "MissionError" ? garbage.code : garbage._tag, "invalid");
      // A short ISO form is normalized, so it still lines up with saved windows.
      const short = yield* service.report({
        missionId: MISSION_ID,
        kind: "update",
        to: "2026-10-17T16:00Z",
        save: false,
      });
      assert.equal(short.coversFrom, "2026-10-17T12:00:00.000Z");
      assert.equal(short.coversTo, "2026-10-17T16:00:00.000Z");
    }),
  );
});

it.layer(TestLayer)("scribe editor", (it) => {
  it.effect(
    "applies an editor reply once: suggestion opened, candidate merged, FYI reordered",
    () =>
      Effect.gen(function* () {
        yield* seedMission;
        yield* seedTranscript({
          threadId: LANE_THREAD,
          run: 2,
          requestedAt: "2026-10-17T02:00:00.000Z",
          items,
        });
        const service = yield* ScribeService.ScribeService;
        const store = yield* MissionStore.MissionStore;
        const scribe = yield* ScribeStore.ScribeStore;
        yield* service.ingest(
          batch({
            notes: [
              note({}),
              note({
                type: "owner-must-know",
                severity: "high",
                summary: "Lane says rewards#216 is merged and live on dev.",
                quote: "Merged rewards#216 and the deploy is live on dev.",
                event: 2000004,
                fromEvent: 2000004,
                toEvent: 2000004,
              }),
            ],
            candidates: [
              {
                targetKind: "rule",
                title: "Masters give a deadline with every ask",
                proposal: "Every master ask names when it is needed.",
                why: "Lane had to guess the deadline.",
                quote: "Please finish the rewards backfill today.",
                event: 2000001,
              },
            ],
          }),
        );

        const input = yield* service.editorInput(MISSION_ID);
        assert.equal(input.notes.length, 2);
        assert.equal(input.candidates.length, 1);
        const [first, second] = input.notes;
        const candidateId = input.candidates[0]?.id ?? "";

        const reply = {
          bottomLine: "Money lane says the rewards fix is live; the PR still reads open.",
          // Editor puts the assumption first, ahead of the owner-must-know note.
          fyiOrder: [second?.id, first?.id],
          feed: [{ kind: "note", summary: "Rewards fix claimed live", ref: `note:${first?.id}` }],
          suggestions: [
            {
              targetKind: "rule",
              title: "Masters give a deadline with every ask",
              change: "Add a rule: every master ask names when it is needed.",
              why: "The money lane had to guess.",
              fromCandidates: [candidateId],
            },
          ],
        };
        const applied = yield* service.applyEditor({
          missionId: MISSION_ID,
          since: input.since,
          reply,
          model: "cc/claude-opus-5-5",
          usage: { input: 5000, output: 600 },
        });
        assert.equal(applied.opened.length, 1);
        assert.deepStrictEqual(applied.rejected, []);

        const suggestion = yield* store.get("suggestion", applied.opened[0] ?? "");
        assert.isTrue(suggestion._tag === "Some");
        if (suggestion._tag === "Some") {
          assert.equal(suggestion.value.author, "editor");
          assert.equal(suggestion.value.acceptor, "owner");
          assert.equal(suggestion.value.status, "open");
        }
        const merged = yield* scribe.candidates(MISSION_ID, "merged");
        assert.deepStrictEqual(
          merged.map((row) => [row.candidate.id, row.suggestionId]),
          [[candidateId, applied.opened[0] ?? null]],
        );

        const fyi = yield* service.fyi(MISSION_ID, 5);
        assert.deepStrictEqual(
          fyi.map((shown) => shown.id),
          [second?.id, first?.id],
        );
        const view = yield* service.editorView(MISSION_ID);
        assert.equal(view?.bottomLine, reply.bottomLine);
        assert.equal(view?.feed.length, 1);

        const kinds = (yield* store.eventsSince(MissionId.make(MISSION_ID), 0)).map(
          (event) => event.kind,
        );
        assert.deepStrictEqual(kinds.slice(-2), ["suggestion.opened", "editor.updated"]);

        // Replaying the same reply opens nothing and records no new event.
        const replay = yield* service.applyEditor({
          missionId: MISSION_ID,
          since: input.since,
          reply,
          model: "cc/claude-opus-5-5",
          usage: { input: 5000, output: 600 },
        });
        assert.deepStrictEqual(replay.opened, []);
        assert.equal(
          (yield* store.eventsSince(MissionId.make(MISSION_ID), 0)).length,
          kinds.length,
        );
      }),
  );
});
