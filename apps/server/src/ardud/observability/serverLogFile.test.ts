import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redactable from "effect/Redactable";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import * as ServerLogFile from "./serverLogFile.ts";

it.layer(NodeServices.layer)("server file logger", (it) => {
  // Every asynchronous filesystem step that can fail while reopening must let
  // subsequent timer and shutdown flushes initialize a fresh sink.
  it.effect.each([
    { operation: "makeDirectory", flush: "timer" },
    { operation: "makeDirectory", flush: "shutdown" },
    { operation: "readDirectory", flush: "timer" },
    { operation: "readDirectory", flush: "shutdown" },
    { operation: "stat", flush: "timer" },
    { operation: "stat", flush: "shutdown" },
  ] as const)(
    "recovers from maintenance $operation failure on $flush flush",
    ({ operation, flush }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "server-log-reopen-" });
        const filePath = path.join(root, "server.log");
        const written = yield* Deferred.make<void>();
        let failReopen = false;
        const failure = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: operation,
        });
        yield* Effect.gen(function* () {
          const { logger, withMaintenance } = yield* ServerLogFile.make({
            filePath,
            maxBytes: 1024,
          });
          const log = (text: string) =>
            Effect.logInfo(text).pipe(
              Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
            );
          yield* log("before-maintenance" + "x".repeat(600));
          const result = yield* withMaintenance(
            Effect.gen(function* () {
              assert.include(yield* fs.readFileString(filePath), "before-maintenance");
              yield* log("during-maintenance");
              yield* fs.writeFileString(filePath, "{}\n");
              failReopen = true;
            }),
          ).pipe(Effect.exit);
          assert.equal(result._tag, "Failure");
          failReopen = false;
          yield* log("after-disk-recovered" + "x".repeat(300));
          if (flush === "timer") {
            yield* TestClock.adjust("1 second");
            yield* Deferred.await(written);
            assert.include(yield* fs.readFileString(filePath), "after-disk-recovered");
          }
        }).pipe(
          Effect.scoped,
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            makeDirectory: (target, options) =>
              failReopen && operation === "makeDirectory"
                ? Effect.fail(failure)
                : fs.makeDirectory(target, options),
            readDirectory: (target) =>
              failReopen && operation === "readDirectory"
                ? Effect.fail(failure)
                : fs.readDirectory(target),
            stat: (target) =>
              failReopen && operation === "stat" ? Effect.fail(failure) : fs.stat(target),
            writeFile: (target, data, options) =>
              fs
                .writeFile(target, data, options)
                .pipe(
                  Effect.tap(() =>
                    Buffer.from(data).includes("after-disk-recovered")
                      ? Deferred.succeed(written, undefined)
                      : Effect.void,
                  ),
                ),
          }),
        );
        const text = yield* fs.readFileString(filePath);
        assert.include(text, "after-disk-recovered");
        assert.notInclude(text, "before-maintenance");
        assert.notInclude(text, "during-maintenance");
        assert.deepEqual(yield* fs.readDirectory(root), ["server.log"]);
      }),
  );

  it.effect("flushes while the server is alive and drains the tail on shutdown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "server-log-flush-" });
      const filePath = path.join(root, "server.log");
      const flushed = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const { logger } = yield* ServerLogFile.make({ filePath });
        yield* Effect.gen(function* () {
          yield* Effect.logInfo("before readiness timeout");
          yield* TestClock.adjust("1 second");
          yield* Deferred.await(flushed);
          assert.include(yield* fs.readFileString(filePath), "before readiness timeout");
          yield* Effect.logInfo("orchestration-v2.claude-steer-confirmed");
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      }).pipe(
        Effect.scoped,
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFile: (target, data, options) =>
            fs
              .writeFile(target, data, options)
              .pipe(Effect.tap(() => Deferred.succeed(flushed, undefined))),
        }),
      );
      assert.include(yield* fs.readFileString(filePath), "orchestration-v2.claude-steer-confirmed");
    }),
  );

  it.effect("bounds rotation, resumes existing logs, and keeps oversized records valid JSON", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "server-log-rotation-" });
      const filePath = path.join(root, "server.log");
      const write = Effect.gen(function* () {
        const { logger } = yield* ServerLogFile.make({ filePath, maxBytes: 1024, maxFiles: 2 });
        yield* Effect.forEach(
          Array.from({ length: 40 }, (_, i) => i),
          (i) =>
            Effect.logInfo(`record-${i}-${"x".repeat(150)}`).pipe(
              Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
            ),
        );
      }).pipe(Effect.scoped);
      yield* write;
      yield* Effect.gen(function* () {
        const { logger } = yield* ServerLogFile.make({ filePath, maxBytes: 1024, maxFiles: 2 });
        yield* Effect.logInfo("oversized-" + "x".repeat(2048)).pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
      }).pipe(Effect.scoped);
      const files = yield* fs.readDirectory(root);
      assert.isAtMost(files.length, 3);
      assert.include(files, "server.log.2");
      for (const file of files) {
        const text = yield* fs.readFileString(path.join(root, file));
        assert.isAtMost(Buffer.byteLength(text), 1024);
        for (const line of text.trimEnd().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
      }
      assert.include(
        yield* fs.readFileString(filePath),
        "server log record exceeded file size limit",
      );
    }),
  );

  it.effect("honors Effect redaction for messages and annotations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "server-log-redaction-" });
      const filePath = path.join(root, "server.log");
      yield* Effect.gen(function* () {
        const { logger } = yield* ServerLogFile.make({ filePath });
        yield* Effect.logInfo("redaction marker", {
          secret: Redacted.make("message-secret"),
          [Redactable.symbolRedactable]() {
            return { secret: "<redacted>" };
          },
        }).pipe(
          Effect.annotateLogs({ credential: Redacted.make("annotation-secret") }),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
        yield* Effect.logInfo(Redacted.make("standalone-secret")).pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
      }).pipe(Effect.scoped);
      const text = yield* fs.readFileString(filePath);
      assert.include(text, "redaction marker");
      assert.notInclude(text, "message-secret");
      assert.notInclude(text, "annotation-secret");
      assert.notInclude(text, "standalone-secret");
    }),
  );

  it.effect("repairs a tail left by an earlier process without losing complete records", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "server-log-tail-" });
      const filePath = path.join(root, "server.log");
      yield* fs.writeFileString(filePath, '{}\n{"partial":');
      yield* Effect.gen(function* () {
        const { logger } = yield* ServerLogFile.make({ filePath });
        yield* Effect.logInfo("new-process-record").pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
      }).pipe(Effect.scoped);
      const text = yield* fs.readFileString(filePath);
      assert.isTrue(text.startsWith("{}\n"));
      assert.notInclude(text, "partial");
      for (const line of text.trimEnd().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
    }),
  );

  it.effect("does not evaluate nested message or annotation getters", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "server-log-getters-" });
      const filePath = path.join(root, "server.log");
      let calls = 0;
      const value = {
        get detail() {
          calls++;
          return "getter-secret";
        },
      };
      yield* Effect.gen(function* () {
        const { logger } = yield* ServerLogFile.make({ filePath });
        yield* Effect.logInfo("getter marker", { nested: [value] }).pipe(
          Effect.annotateLogs({ nested: value }),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
      }).pipe(Effect.scoped);
      assert.equal(calls, 0);
      const text = yield* fs.readFileString(filePath);
      assert.include(text, "getter marker");
      assert.notInclude(text, "getter-secret");
    }),
  );

  it.effect("drains and pauses during maintenance, then refreshes the rewritten file size", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "server-log-maintenance-" });
      const filePath = path.join(root, "server.log");
      yield* Effect.gen(function* () {
        const { logger, withMaintenance } = yield* ServerLogFile.make({ filePath, maxBytes: 1024 });
        const log = (message: string) =>
          Effect.logInfo(message).pipe(
            Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          );
        yield* log("secret-before-maintenance" + "x".repeat(600));
        yield* withMaintenance(
          Effect.gen(function* () {
            assert.include(yield* fs.readFileString(filePath), "secret-before-maintenance");
            yield* log("secret-during-maintenance");
            yield* fs.writeFileString(filePath, "{}\n");
          }),
        );
        yield* log("after-maintenance" + "x".repeat(300));
        yield* withMaintenance(Effect.fail("fixture failure")).pipe(Effect.ignore);
        yield* log("after-failed-maintenance");
      }).pipe(Effect.scoped);
      const text = yield* fs.readFileString(filePath);
      assert.notInclude(text, "secret-before-maintenance");
      assert.notInclude(text, "secret-during-maintenance");
      assert.include(text, "after-maintenance");
      assert.include(text, "after-failed-maintenance");
      assert.deepEqual(yield* fs.readDirectory(root), ["server.log"]);
    }),
  );

  it.effect("repairs a partial append failure before writing a valid recovery record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const console = yield* Console.Console;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "server-log-failure-" });
      const filePath = path.join(root, "server.log");
      const failed = yield* Deferred.make<void>();
      let firstWrite = true;
      yield* Effect.gen(function* () {
        const { logger } = yield* ServerLogFile.make({ filePath });
        yield* Effect.gen(function* () {
          yield* Effect.logInfo("disk unavailable");
          yield* TestClock.adjust("1 second");
          yield* Deferred.await(failed);
          yield* Effect.logInfo("disk recovered");
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      }).pipe(
        Effect.scoped,
        Effect.provideService(Console.Console, {
          ...console,
          error: () => {
            Deferred.doneUnsafe(failed, Effect.void);
          },
        }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFile: (target, data, options) => {
            if (firstWrite) {
              firstWrite = false;
              return fs
                .writeFile(target, new TextEncoder().encode('{"message":"partial'), options)
                .pipe(Effect.andThen(fs.writeFile(root, data, options)));
            }
            return fs.writeFile(target, data, options);
          },
        }),
      );
      const text = yield* fs.readFileString(filePath);
      assert.include(text, "disk recovered");
      assert.notInclude(text, "partial");
      for (const line of text.trimEnd().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
    }),
  );
});
