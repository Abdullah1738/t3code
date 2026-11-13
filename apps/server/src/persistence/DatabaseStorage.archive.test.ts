import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import * as Sqlite from "./Sqlite.ts";

const archive = vi.hoisted(() => ({
  pass: vi.fn<() => boolean>(),
  contended: vi.fn<() => boolean>(() => false),
}));
vi.mock("../ardud/persistence/HistoryArchive.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ardud/persistence/HistoryArchive.ts")>()),
  archiveHistoryPass: () =>
    Effect.suspend(() =>
      archive.pass()
        ? Effect.succeed({ moved: 0, contended: archive.contended() === true })
        : Effect.fail({ _tag: "FixtureArchiveFailure" as const }),
    ),
}));

const layer = DatabaseStorage.layer.pipe(
  Layer.provide(
    Layer.succeed(ProjectionMaintenance.ProjectionMaintenanceV2, {
      compactEventStore: Effect.never,
      compactEventStoreWith: () => Effect.never,
      verify: Effect.never,
      rebuild: Effect.never,
    }),
  ),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "database-archive-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("delays archive work until after startup and paces passes, including failed ones", () =>
  Effect.gen(function* () {
    archive.pass.mockReset();
    archive.pass.mockReturnValue(true);
    archive.pass.mockReturnValueOnce(false);
    archive.contended.mockReset();
    archive.contended.mockReturnValue(false);
    // Acquiring the layer has returned before the first archive operation.
    yield* DatabaseStorage.DatabaseStorage;
    yield* TestClock.adjust("59999 millis");
    assert.equal(archive.pass.mock.calls.length, 0);
    yield* TestClock.adjust("1 millis");
    assert.equal(archive.pass.mock.calls.length, 1);
    // Passes never run back to back: the default minimum gap is 250 ms.
    yield* TestClock.adjust("249 millis");
    assert.equal(archive.pass.mock.calls.length, 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(archive.pass.mock.calls.length, 2);
    yield* TestClock.adjust("250 millis");
    assert.equal(archive.pass.mock.calls.length, 3);
  }).pipe(Effect.provide(layer)),
);

it.effect("backs off after contended passes, doubling until a clean pass", () =>
  Effect.gen(function* () {
    archive.pass.mockReset();
    archive.pass.mockReturnValue(true);
    archive.contended.mockReset();
    archive.contended.mockReturnValue(false);
    archive.contended.mockReturnValueOnce(true).mockReturnValueOnce(true);
    yield* DatabaseStorage.DatabaseStorage;
    yield* TestClock.adjust("60000 millis");
    assert.equal(archive.pass.mock.calls.length, 1);
    // First contended pass: the 10 s base backoff.
    yield* TestClock.adjust("9999 millis");
    assert.equal(archive.pass.mock.calls.length, 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(archive.pass.mock.calls.length, 2);
    // Second in a row: doubled.
    yield* TestClock.adjust("19999 millis");
    assert.equal(archive.pass.mock.calls.length, 2);
    yield* TestClock.adjust("1 millis");
    assert.equal(archive.pass.mock.calls.length, 3);
    // A clean pass resets to the paced gap.
    yield* TestClock.adjust("250 millis");
    assert.equal(archive.pass.mock.calls.length, 4);
  }).pipe(Effect.provide(layer)),
);
