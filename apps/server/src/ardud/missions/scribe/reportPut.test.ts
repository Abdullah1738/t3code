import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  MissionId,
  ProviderInstanceId,
  type MissionProvenance,
  type Role,
  RoleId,
  ThreadId,
} from "@t3tools/contracts";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as ScribeService from "./ScribeService.ts";
import * as ScribeStore from "./ScribeStore.ts";
import {
  LANE_THREAD,
  MASTER_THREAD,
  MISSION_ID,
  mission,
  putRecord,
  seedMission,
} from "./testFixtures.ts";

const TestLayer = ScribeService.layer.pipe(
  Layer.provideMerge(ScribeStore.layer),
  Layer.provideMerge(MissionStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const fresh = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ScribeService.ScribeService | ScribeStore.ScribeStore | MissionStore.MissionStore
  >,
) => effect.pipe(Effect.provide(TestLayer));

const masterRole = {
  id: "role-master",
  missionId: MISSION_ID,
  kind: "master",
  name: "Master",
  description: "",
  modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "opus" },
  pendingModelSelection: null,
  laneId: null,
  writesPublicText: true,
  lockedFields: [],
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
} as unknown as Role;

const agent = (threadId: string): MissionProvenance => ({
  _tag: "agent",
  threadId: ThreadId.make(threadId),
  roleId: null,
});
const master = agent(MASTER_THREAD);
const owner: MissionProvenance = { _tag: "owner-app", surface: "web", sessionId: "s-1" };

/** The mission with its master role, the clock at 23 Oct 01:00 Dubai. */
const seed = Effect.gen(function* () {
  yield* seedMission;
  yield* putRecord({ _tag: "role", record: masterRole });
  yield* TestClock.setTime(Date.parse("2026-10-22T21:00:00.000Z"));
});

const inDubai = putRecord({
  _tag: "mission",
  record: { ...mission, reports: { dayBoundary: "Asia/Dubai" } },
});

const dubaiDay = {
  missionId: MISSION_ID,
  kind: "daily" as const,
  coversFrom: "2026-10-20T20:00:00.000Z",
  coversTo: "2026-10-21T20:00:00.000Z",
};

const reportEvents = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const events = yield* store.recentEvents(MissionId.make(MISSION_ID), 50);
  return events.filter((event) => event.kind === "report.saved");
});

const failureOf = <A, R>(effect: Effect.Effect<A, ScribeService.ScribeError, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => (error._tag === "MissionError" ? error.code : error._tag)),
  );

it.effect("the master saves a daily; a new text is a revision and the old text stays", () =>
  fresh(
    Effect.gen(function* () {
      yield* seed;
      yield* inDubai;
      const service = yield* ScribeService.ScribeService;
      const scribe = yield* ScribeStore.ScribeStore;

      const first = yield* service.putReport(master, {
        ...dubaiDay,
        text: "# Crpko daily, Wed 21 Oct 2026 (Dubai day)\n\nFirst take.",
        facts: { merged: 12, prs: ["crpko-api#1"] },
      });
      assert.deepStrictEqual(first, {
        reportId: "mission-crpko|daily|2026-10-21T20:00:00.000Z",
        kind: "daily",
        coversFrom: "2026-10-20T20:00:00.000Z",
        coversTo: "2026-10-21T20:00:00.000Z",
        revision: 1,
        author: "master",
        size: 55,
        saved: true,
        hides: [],
      });

      // The same text again changes nothing and says so.
      const again = yield* service.putReport(master, {
        ...dubaiDay,
        text: "# Crpko daily, Wed 21 Oct 2026 (Dubai day)\n\nFirst take.",
        facts: { merged: 12, prs: ["crpko-api#1"] },
      });
      assert.equal(again.saved, false);
      assert.equal(again.revision, 1);

      yield* TestClock.adjust("10 minutes");
      const second = yield* service.putReport(master, {
        ...dubaiDay,
        text: "# Crpko daily, Wed 21 Oct 2026 (Dubai day)\n\nSecond take.",
      });
      assert.equal(second.revision, 2);
      assert.equal(second.reportId, "mission-crpko|daily|2026-10-21T20:00:00.000Z|r2");
      assert.deepStrictEqual(second.hides, ["mission-crpko|daily|2026-10-21T20:00:00.000Z"]);

      const listed = yield* scribe.listReports(MISSION_ID, ["daily"], 10);
      assert.equal(listed.total, 1);
      assert.equal(listed.rows[0]?.reportId, second.reportId);
      assert.equal(listed.rows[0]?.author, "master");
      assert.equal(listed.rows[0]?.revision, 2);

      const latest = yield* scribe.lastReport(MISSION_ID, "daily");
      assert.equal(latest?.text.endsWith("Second take."), true);
      assert.equal(latest?.facts, null);
      const older = yield* scribe.reportText(MISSION_ID, first.reportId, 1000);
      assert.equal(older?.text.endsWith("First take."), true);

      const events = yield* reportEvents;
      assert.equal(events.length, 2);
      const newest = events[0]!;
      assert.deepStrictEqual(newest.actor, { _tag: "role", roleId: RoleId.make("role-master") });
      assert.deepStrictEqual(newest.subject, {
        kind: "report",
        id: second.reportId,
        label: "Crpko daily, Wed 21 Oct 2026 (Dubai day)",
      });
      assert.equal(
        newest.summary,
        'Master saved daily "Crpko daily, Wed 21 Oct 2026 (Dubai day)" for Wed 21 Oct (Dubai day), revision 2',
      );
      assert.deepStrictEqual(newest.payload, {
        reportId: second.reportId,
        kind: "daily",
        coversFrom: "2026-10-20T20:00:00.000Z",
        coversTo: "2026-10-21T20:00:00.000Z",
        revision: 2,
        author: "master",
        size: 56,
        hides: [first.reportId],
      });
    }),
  ),
);

it.effect("keeps facts as JSON and hands them back", () =>
  fresh(
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ScribeService.ScribeService;
      const scribe = yield* ScribeStore.ScribeStore;
      const facts = { merged: [{ repo: "crpko-api", number: 4 }], deploys: 2, note: null };
      yield* service.putReport(owner, { ...dubaiDay, text: "# Owner's day", facts });
      const saved = yield* scribe.lastReport(MISSION_ID, "daily");
      assert.deepStrictEqual(saved?.facts, facts);
      assert.equal(saved?.author, "owner");
      const [event] = yield* reportEvents;
      assert.deepStrictEqual(event?.actor, { _tag: "owner" });
    }),
  ),
);

it.effect(
  "a newer daily hides the dailies it overlaps; the scribe can't replace the master's",
  () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const service = yield* ScribeService.ScribeService;
        const scribe = yield* ScribeStore.ScribeStore;

        // The old 04:30Z scribe dailies, then the master's Dubai-day rewrite.
        const old21 = yield* service.putReport(ScribeService.SCRIBE_PROVENANCE, {
          missionId: MISSION_ID,
          kind: "daily",
          coversFrom: "2026-10-20T04:30:00.000Z",
          coversTo: "2026-10-21T04:30:00.000Z",
          text: "# Old daily 21",
        });
        const old22 = yield* service.putReport(ScribeService.SCRIBE_PROVENANCE, {
          missionId: MISSION_ID,
          kind: "daily",
          coversFrom: "2026-10-21T04:30:00.000Z",
          coversTo: "2026-10-22T04:30:00.000Z",
          text: "# Old daily 22",
        });
        const update = yield* service.putReport(ScribeService.SCRIBE_PROVENANCE, {
          missionId: MISSION_ID,
          kind: "update",
          coversFrom: "2026-10-21T08:00:00.000Z",
          coversTo: "2026-10-21T12:00:00.000Z",
          text: "# Update",
        });
        yield* TestClock.adjust("1 hour");
        const rewrite = yield* service.putReport(master, {
          ...dubaiDay,
          text: "# Crpko daily, Wed 21 Oct 2026 (Dubai day)",
        });
        assert.deepStrictEqual([...rewrite.hides].toSorted(), [old21.reportId, old22.reportId]);

        const dailies = yield* scribe.listReports(MISSION_ID, ["daily"], 10);
        assert.deepStrictEqual(
          dailies.rows.map((row) => row.reportId),
          [rewrite.reportId],
        );
        const updates = yield* scribe.listReports(MISSION_ID, ["update"], 10);
        assert.deepStrictEqual(
          updates.rows.map((row) => row.reportId),
          [update.reportId],
        );
        assert.equal((yield* scribe.lastReport(MISSION_ID, "daily"))?.reportId, rewrite.reportId);

        // A scribe daily over the master's day is refused, not silently hidden.
        const code = yield* failureOf(
          service.putReport(ScribeService.SCRIBE_PROVENANCE, {
            missionId: MISSION_ID,
            kind: "daily",
            coversFrom: "2026-10-21T04:30:00.000Z",
            coversTo: "2026-10-22T04:30:00.000Z",
            text: "# Old daily 22, again",
          }),
        );
        assert.equal(code, "conflict");

        // The next Dubai day doesn't touch it.
        yield* TestClock.adjust("1 hour");
        const next = yield* service.putReport(ScribeService.SCRIBE_PROVENANCE, {
          missionId: MISSION_ID,
          kind: "daily",
          coversFrom: "2026-10-21T20:00:00.000Z",
          coversTo: "2026-10-22T20:00:00.000Z",
          text: "# Thu",
        });
        assert.deepStrictEqual(next.hides, []);
        const after = yield* scribe.listReports(MISSION_ID, ["daily"], 10);
        assert.deepStrictEqual(
          after.rows.map((row) => row.reportId),
          [next.reportId, rewrite.reportId],
        );
      }),
    ),
);

it.effect("only the scribe, the owner and the master save reports", () =>
  fresh(
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ScribeService.ScribeService;
      const callers: ReadonlyArray<MissionProvenance> = [
        agent(LANE_THREAD),
        agent("thread-stray"),
        { _tag: "system", component: "crw" },
        { _tag: "system", component: "control-api" },
      ];
      for (const caller of callers) {
        assert.equal(
          yield* failureOf(service.putReport(caller, { ...dubaiDay, text: "# Nope" })),
          "forbidden",
        );
      }
      assert.equal(
        yield* failureOf(
          service.putReport(master, { ...dubaiDay, missionId: "mission-other", text: "# Nope" }),
        ),
        "not-found",
      );
      assert.deepStrictEqual(yield* reportEvents, []);
    }),
  ),
);

it.effect("refuses bad windows, empty or oversized text and facts that aren't JSON", () =>
  fresh(
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ScribeService.ScribeService;
      const bad = [
        { ...dubaiDay, coversFrom: dubaiDay.coversTo, text: "# Same" },
        { ...dubaiDay, coversFrom: "yesterday", text: "# Words" },
        { ...dubaiDay, text: "   \n" },
        { ...dubaiDay, text: "x".repeat(200_001) },
        { ...dubaiDay, text: "# Facts", facts: { big: 1n } },
      ];
      for (const input of bad) {
        assert.equal(yield* failureOf(service.putReport(master, input)), "invalid");
      }
      assert.deepStrictEqual(yield* reportEvents, []);
    }),
  ),
);

it.effect("a daily with a day boundary defaults to the last whole day there", () =>
  fresh(
    Effect.gen(function* () {
      yield* seed;
      yield* inDubai;
      yield* TestClock.setTime(Date.parse("2026-10-22T10:00:00.000Z"));
      const service = yield* ScribeService.ScribeService;
      const scribe = yield* ScribeStore.ScribeStore;

      const built = yield* service.report({ missionId: MISSION_ID, kind: "daily", save: true });
      assert.equal(built.coversFrom, "2026-10-20T20:00:00.000Z");
      assert.equal(built.coversTo, "2026-10-21T20:00:00.000Z");
      const saved = yield* scribe.lastReport(MISSION_ID, "daily");
      assert.equal(saved?.author, "scribe");
      assert.equal(saved?.reportId, "mission-crpko|daily|2026-10-21T20:00:00.000Z");
      const [event] = yield* reportEvents;
      assert.deepStrictEqual(event?.actor, { _tag: "system", component: "scribe" });

      // Saving the same day again with the same text is a no-op, not a failure.
      yield* service.report({ missionId: MISSION_ID, kind: "daily", save: true });
      assert.equal((yield* reportEvents).length, 1);

      // An explicit window still wins, and updates keep their 4h default.
      const explicit = yield* service.report({
        missionId: MISSION_ID,
        kind: "daily",
        from: "2026-10-21T04:30:00.000Z",
        to: "2026-10-22T04:30:00.000Z",
        save: false,
      });
      assert.equal(explicit.coversFrom, "2026-10-21T04:30:00.000Z");
      const update = yield* service.report({ missionId: MISSION_ID, kind: "update", save: false });
      assert.equal(update.coversTo, "2026-10-22T10:00:00.000Z");
      assert.equal(update.coversFrom, "2026-10-22T06:00:00.000Z");
    }),
  ),
);
