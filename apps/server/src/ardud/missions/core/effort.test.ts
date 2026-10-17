import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { MissionId, ThreadId, type MissionProvenance } from "@t3tools/contracts";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { EFFORT_WINDOW_MS, effortShares, runTimeByThread } from "./effort.ts";

const TestLayer = MissionService.layer.pipe(
  Layer.provideMerge(MissionStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const owner: MissionProvenance = { _tag: "owner-app", surface: "web", sessionId: "session-1" };
const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const HOUR = 60 * 60 * 1000;

const run = (threadId: string, ordinal: number, from: number, to: number | null, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs ${sql.insert({
        run_id: `${threadId}-${ordinal}`,
        thread_id: threadId,
        ordinal,
        provider: "codex",
        status,
        requested_at: iso(from),
        completed_at: to === null ? null : iso(to),
        payload_json: "{}",
      })}
    `;
  });

it("counts only run time inside the window, open runs up to now", () => {
  const windowStart = NOW - EFFORT_WINDOW_MS;
  const byThread = runTimeByThread(
    [
      // Started before the window: only the part inside counts.
      {
        thread_id: "a",
        status: "completed",
        requested_at: iso(windowStart - HOUR),
        completed_at: iso(windowStart + HOUR),
      },
      // Still running: counts to now.
      { thread_id: "a", status: "running", requested_at: iso(NOW - HOUR), completed_at: null },
      // Ended without a completion time: nothing to count.
      { thread_id: "b", status: "failed", requested_at: iso(NOW - HOUR), completed_at: null },
    ],
    windowStart,
    NOW,
  );
  assert.equal(byThread.get("a"), 2 * HOUR);
  assert.isFalse(byThread.has("b"));

  const shares = effortShares(
    [
      { subMissionId: "s-1" as never, threadId: "a" as never },
      { subMissionId: "s-2" as never, threadId: "c" as never },
      { subMissionId: null, threadId: "a" as never },
    ],
    new Map([
      ["a", 3 * HOUR],
      ["c", HOUR],
    ]),
  );
  assert.deepStrictEqual(
    [...(shares ?? [])],
    [
      ["s-1", 0.75],
      ["s-2", 0.25],
    ],
  );
  assert.isNull(
    effortShares([{ subMissionId: "s-1" as never, threadId: "a" as never }], new Map()),
  );
});

it.layer(TestLayer)("attention ledger", (it) => {
  it.effect("fills actualEffort per sub-mission from its lanes' running time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const missions = yield* MissionService.MissionService;
      const missionId = MissionId.make("m-effort");
      yield* missions.createMission(owner, { missionId, slug: "effort", title: "Effort" });
      const api = yield* missions.upsertSubMission(owner, { missionId, title: "API" });
      const web = yield* missions.upsertSubMission(owner, { missionId, title: "Web" });
      const idle = yield* missions.upsertSubMission(owner, { missionId, title: "Idle" });
      for (const [name, subMissionId, threadId] of [
        ["api", api.ref.id, "t-api"],
        ["web", web.ref.id, "t-web"],
      ] as const) {
        yield* missions.upsertLane(owner, {
          missionId,
          name,
          subMissionId: subMissionId as never,
          threadId: ThreadId.make(threadId),
        });
      }
      yield* run("t-api", 1, NOW - 4 * HOUR, NOW - HOUR, "completed");
      yield* run("t-web", 1, NOW - HOUR, null, "running");
      // Outside the window: ignored.
      yield* run("t-web", 2, NOW - 3 * EFFORT_WINDOW_MS, NOW - 2 * EFFORT_WINDOW_MS, "completed");
      // A thread no lane owns: ignored.
      yield* run("t-other", 1, NOW - 4 * HOUR, NOW, "completed");

      const overview = yield* missions.overview(missionId);
      const effort = Object.fromEntries(
        overview.subMissions.map((subMission) => [subMission.title, subMission.actualEffort]),
      );
      assert.deepStrictEqual(effort, { API: 0.75, Web: 0.25, Idle: 0 });
      assert.equal(overview.subMissions.find((s) => s.id === idle.ref.id)?.actualEffort, 0);
    }),
  );
});
