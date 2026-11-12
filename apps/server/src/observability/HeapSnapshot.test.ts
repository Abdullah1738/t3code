// @effect-diagnostics nodeBuiltinImport:off - tests fake a failed write at the native v8 boundary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as HeapSnapshot from "./HeapSnapshot.ts";

vi.mock("node:v8", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeV8>();
  return { ...actual, writeHeapSnapshot: vi.fn(actual.writeHeapSnapshot) };
});

it.layer(NodeServices.layer)("writeHeapSnapshot", (it) => {
  it.effect("removes the partial file when the write fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-heap-snapshot-test-" });
      let partialPath: string | undefined;
      vi.mocked(NodeV8.writeHeapSnapshot).mockImplementationOnce((path) => {
        partialPath = path;
        if (path) NodeFS.writeFileSync(path, "partial");
        throw new Error("ENOSPC: no space left on device");
      });

      yield* HeapSnapshot.writeHeapSnapshot(logsDir);

      assert.strictEqual(NodePath.dirname(partialPath ?? ""), logsDir);
      assert.deepEqual(yield* fs.readDirectory(logsDir), []);
    }),
  );
});

const GiB = 1024 ** 3;
const stats = (used: number, limit = 4 * GiB) => ({ used_heap_size: used, heap_size_limit: limit });
const monitor = (
  logsDir: string,
  readHeapStats: () => ReturnType<typeof stats>,
  freeBytes: NonNullable<Parameters<typeof HeapSnapshot.layerWith>[2]> = () =>
    Effect.succeed(10 * GiB),
  env: Record<string, string> = {},
) =>
  Layer.build(HeapSnapshot.layerWith(logsDir, readHeapStats, freeBytes)).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Effect.provideService(HostProcess.Platform, "win32"),
  );

it.layer(NodeServices.layer)("heap snapshot watcher", (it) => {
  it.effect("samples every 30 seconds and writes only once at 1.4 GiB on a 4 GiB limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped();
      const write = vi
        .mocked(NodeV8.writeHeapSnapshot)
        .mockReset()
        .mockImplementation((path) => path!);
      let used = 1.4 * GiB - 1;
      const read = vi.fn(() => stats(used));
      yield* monitor(logsDir, read);
      yield* TestClock.adjust("29 seconds");
      assert.strictEqual(read.mock.calls.length, 0);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(write.mock.calls.length, 0);
      used = 1.4 * GiB;
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(write.mock.calls.length, 1);
      assert.strictEqual(NodePath.dirname(write.mock.calls[0]![0]!), logsDir);
      yield* TestClock.adjust("60 seconds");
      assert.strictEqual(write.mock.calls.length, 1);
    }),
  );

  it.effect.each([undefined, "0.25", "1"])(
    "uses the configured fraction on a small heap (%s)",
    (fraction) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const logsDir = yield* fs.makeTempDirectoryScoped();
        const write = vi
          .mocked(NodeV8.writeHeapSnapshot)
          .mockReset()
          .mockImplementation((path) => path!);
        const boundary = (fraction === undefined ? 0.7 : Number(fraction)) * GiB;
        let used = boundary - 1;
        yield* monitor(
          logsDir,
          () => stats(used, GiB),
          undefined,
          fraction === undefined ? {} : { T3CODE_HEAP_SNAPSHOT_AT: fraction },
        );
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(write.mock.calls.length, 0);
        used = boundary;
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(write.mock.calls.length, 1);
      }),
  );

  it.effect("skips low disk and writes once when exactly twice the heap is available", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped();
      const write = vi
        .mocked(NodeV8.writeHeapSnapshot)
        .mockReset()
        .mockImplementation((path) => path!);
      let available = 2 * GiB - 1;
      const free = vi.fn(() => Effect.succeed(available));
      yield* monitor(logsDir, () => stats(GiB, GiB), free);
      yield* TestClock.adjust("60 seconds");
      assert.strictEqual(write.mock.calls.length, 0);
      assert.strictEqual(free.mock.calls.length, 2);
      available = 2 * GiB;
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(write.mock.calls.length, 1);
      yield* TestClock.adjust("60 seconds");
      assert.strictEqual(write.mock.calls.length, 1);
    }),
  );

  it.effect("does not write when the free-space check fails and retries the check later", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped();
      const write = vi
        .mocked(NodeV8.writeHeapSnapshot)
        .mockReset()
        .mockImplementation((path) => path!);
      const free = vi
        .fn<NonNullable<Parameters<typeof HeapSnapshot.layerWith>[2]>>()
        .mockReturnValueOnce(
          Effect.try(() => {
            throw new Error("statfs failed");
          }),
        )
        .mockReturnValue(Effect.succeed(10 * GiB));
      yield* monitor(logsDir, () => stats(GiB, GiB), free);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(write.mock.calls.length, 0);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(write.mock.calls.length, 1);
    }),
  );

  it.effect("does not retry a failed snapshot write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped();
      const write = vi
        .mocked(NodeV8.writeHeapSnapshot)
        .mockReset()
        .mockImplementation(() => {
          throw new Error("write failed");
        });
      yield* monitor(logsDir, () => stats(GiB, GiB));
      yield* TestClock.adjust("90 seconds");
      assert.strictEqual(write.mock.calls.length, 1);
    }),
  );

  it.effect(
    "a manual capture during the disk check prevents an automatic duplicate and releases its listener",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const logsDir = yield* fs.makeTempDirectoryScoped();
        const disk = yield* Deferred.make<number>();
        const checkingDisk = yield* Deferred.make<void>();
        const listeners = process.listeners("SIGUSR2");
        const write = vi.mocked(NodeV8.writeHeapSnapshot).mockReset();
        yield* Effect.gen(function* () {
          yield* Layer.build(
            HeapSnapshot.layerWith(
              logsDir,
              () => stats(GiB, GiB),
              () =>
                Deferred.succeed(checkingDisk, undefined).pipe(
                  Effect.andThen(Deferred.await(disk)),
                ),
            ),
          ).pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
            Effect.provideService(HostProcess.Platform, "darwin"),
          );
          const handler = process
            .listeners("SIGUSR2")
            .find((listener) => !listeners.includes(listener));
          assert.isDefined(handler);
          yield* TestClock.adjust("30 seconds");
          yield* Deferred.await(checkingDisk);
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                write.mockImplementation((path) => {
                  resolve();
                  return path!;
                });
                handler!("SIGUSR2");
              }),
          );
          yield* Deferred.succeed(disk, 10 * GiB);
          yield* TestClock.adjust("60 seconds");
          assert.strictEqual(write.mock.calls.length, 1);
        }).pipe(Effect.scoped);
        assert.deepEqual(process.listeners("SIGUSR2"), listeners);
      }),
  );

  it.effect.each(["-0.1", "1.1", "NaN", "Infinity", "invalid", ""])(
    "falls back to 0.70 for invalid config %j",
    (value) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const logsDir = yield* fs.makeTempDirectoryScoped();
        const write = vi
          .mocked(NodeV8.writeHeapSnapshot)
          .mockReset()
          .mockImplementation((path) => path!);
        let used = 0.7 * GiB - 1;
        yield* monitor(logsDir, () => stats(used, GiB), undefined, {
          T3CODE_HEAP_SNAPSHOT_AT: value,
        });
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(write.mock.calls.length, 0);
        used = 0.7 * GiB;
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(write.mock.calls.length, 1);
      }),
  );

  it.effect("0 disables sampling, but startup still removes only expired server snapshots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped();
      const now = Date.UTC(2026, 10, 12);
      yield* TestClock.setTime(now);
      assert.strictEqual(DateTime.toEpochMillis(yield* DateTime.now), now);
      const cutoff = now - 7 * 24 * 60 * 60 * 1_000;
      for (const [name, time] of [
        ["server-old.heapsnapshot", cutoff - 1],
        ["server-boundary.heapsnapshot", cutoff],
        ["server-new.heapsnapshot", now],
        ["other-old.heapsnapshot", cutoff - 1],
        ["server-old.log", cutoff - 1],
      ] as const) {
        const path = NodePath.join(logsDir, name);
        yield* fs.writeFileString(path, "test");
        yield* fs.utimes(path, time / 1_000, time / 1_000);
      }
      yield* fs.makeDirectory(NodePath.join(logsDir, "server-directory.heapsnapshot"));
      const read = vi.fn(() => stats(4 * GiB));
      const free = vi.fn(() => Effect.succeed(10 * GiB));
      yield* monitor(logsDir, read, free, { T3CODE_HEAP_SNAPSHOT_AT: "0" });
      yield* TestClock.adjust("90 seconds");
      assert.strictEqual(read.mock.calls.length, 0);
      assert.strictEqual(free.mock.calls.length, 0);
      assert.deepEqual((yield* fs.readDirectory(logsDir)).sort(), [
        "other-old.heapsnapshot",
        "server-boundary.heapsnapshot",
        "server-directory.heapsnapshot",
        "server-new.heapsnapshot",
        "server-old.log",
      ]);
    }),
  );

  it.effect("stops sampling when the layer's scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped();
      const read = vi.fn(() => stats(1));
      yield* Effect.gen(function* () {
        yield* monitor(logsDir, read);
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(read.mock.calls.length, 1);
      }).pipe(Effect.scoped);
      yield* TestClock.adjust("60 seconds");
      assert.strictEqual(read.mock.calls.length, 1);
    }),
  );
});
