import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import {
  cutoverAdmissionHeld,
  cutoverThreadReleased,
  preparedCutoverOwns,
  releaseCutoverThread,
} from "./cutoverClaim.ts";

const layerTest = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return ServerConfig.ServerConfig.of({
      ...config,
      stateDir: path.join(config.baseDir, "uncreated-state"),
    });
  }),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cutover-claim-" })),
  Layer.provideMerge(NodeServices.layer),
);

const preparationFile = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "harness-cutover-input.json");
});

const writePreparation = (interruptedThreads: ReadonlyArray<{ threadId: string; runId: string }>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      yield* preparationFile,
      JSON.stringify({ version: 1, stoppedCards: [], interruptedThreads }),
    );
  });

it.effect("claims only an exact prepared thread and run pair", () =>
  Effect.gen(function* () {
    yield* writePreparation([
      { threadId: "thread:claude", runId: "run:claude-interrupted" },
      { threadId: "thread:openai", runId: "run:openai-interrupted" },
    ]);

    assert.isTrue(yield* preparedCutoverOwns("thread:claude", "run:claude-interrupted"));
    assert.isTrue(yield* preparedCutoverOwns("thread:openai", "run:openai-interrupted"));
    assert.isFalse(yield* preparedCutoverOwns("thread:claude", "run:newer"));
    assert.isFalse(yield* preparedCutoverOwns("thread:other", "run:claude-interrupted"));
    assert.isFalse(yield* preparedCutoverOwns("thread:claude", "run:openai-interrupted"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves GLM and native harness runs absent from preparation unclaimed", () =>
  Effect.gen(function* () {
    yield* writePreparation([{ threadId: "thread:claude", runId: "run:interrupted" }]);

    for (const threadId of [
      "thread:glm",
      "thread:claude-native",
      "thread:codex",
      "thread:codex-cu",
    ]) {
      assert.isFalse(yield* preparedCutoverOwns(threadId, "run:interrupted"));
    }
    yield* writePreparation([]);
    assert.isFalse(yield* preparedCutoverOwns("thread:claude", "run:interrupted"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a missing preparation file claims nothing and is not created by a read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    assert.isFalse(yield* fs.exists(yield* preparationFile));
    assert.isFalse(yield* preparedCutoverOwns("thread:claude", "run:interrupted"));
    assert.isFalse(yield* fs.exists(yield* preparationFile));
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  ["invalid JSON", "{"],
  ["unsupported version", JSON.stringify({ version: 2, interruptedThreads: [] })],
  ["missing claims", JSON.stringify({ version: 1 })],
  [
    "missing run ID",
    JSON.stringify({ version: 1, interruptedThreads: [{ threadId: "thread:claude" }] }),
  ],
] as const)("an existing preparation with %s fails closed", ([, contents]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* preparationFile;
    yield* fs.writeFileString(file, contents);

    assert.isTrue(yield* preparedCutoverOwns("thread:claude", "run:interrupted"));
    assert.isTrue(yield* preparedCutoverOwns("thread:other", "run:other"));
    assert.equal(yield* fs.readFileString(file), contents);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an existing preparation path that cannot be read as a file fails closed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(yield* preparationFile);

    assert.isTrue(yield* preparedCutoverOwns("thread:claude", "run:interrupted"));
  }).pipe(Effect.provide(layerTest)),
);

const heldSelections: ReadonlyArray<ModelSelection> = [
  { instanceId: ProviderInstanceId.make("opencode"), model: "opus/claude-opus-5-5" },
  { instanceId: ProviderInstanceId.make("opencode"), model: "opus/cx/gpt-6.1-sol" },
  { instanceId: ProviderInstanceId.make("opencode"), model: "openai/future" },
  { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  { instanceId: ProviderInstanceId.make("codex-cu"), model: "gpt-6.1-terra" },
];
const glmSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "surplus/glm-5.3-flash",
};

const releaseFile = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "harness-cutover-released.json");
});

it.effect("missing preparation does not hold admission or create state paths", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    assert.isFalse(yield* fs.exists(config.stateDir));
    for (const selection of [...heldSelections, glmSelection]) {
      assert.isFalse(yield* cutoverAdmissionHeld("thread:source", selection));
    }
    assert.isFalse(yield* fs.exists(yield* preparationFile));
    assert.isFalse(yield* fs.exists(config.stateDir));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("prepared cutover holds native and legacy Claude/OpenAI admission but retains GLM", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* writePreparation([]);
    for (const selection of heldSelections) {
      assert.isTrue(yield* cutoverAdmissionHeld("thread:source", selection));
    }
    assert.isFalse(yield* cutoverAdmissionHeld("thread:source", glmSelection));
    assert.isFalse(yield* fs.exists(config.stateDir));
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  ["invalid JSON", "{"],
  ["unsupported version", JSON.stringify({ version: 2 })],
  ["missing version", "{}"],
] as const)("release marker with %s cannot release admission", ([, contents]) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* writePreparation([]);
    yield* fs.makeDirectory(config.stateDir);
    yield* fs.writeFileString(yield* releaseFile, contents);
    for (const selection of heldSelections) {
      assert.isTrue(yield* cutoverAdmissionHeld("thread:source", selection));
    }
    assert.isFalse(yield* cutoverAdmissionHeld("thread:source", glmSelection));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a valid release marker unblocks admission but keeps the exact source run claimed", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* writePreparation([{ threadId: "thread:source", runId: "run:interrupted" }]);
    yield* fs.makeDirectory(config.stateDir);
    const file = yield* releaseFile;
    yield* fs.writeFileString(file, JSON.stringify({ version: 1 }));

    for (const selection of [...heldSelections, glmSelection]) {
      assert.isFalse(yield* cutoverAdmissionHeld("thread:source", selection));
    }
    assert.isTrue(yield* preparedCutoverOwns("thread:source", "run:interrupted"));
    assert.isFalse(yield* preparedCutoverOwns("thread:source", "run:newer"));
    assert.equal(yield* fs.readFileString(file), JSON.stringify({ version: 1 }));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a malformed preparation remains held even when a valid release marker exists", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(yield* preparationFile, "{");
    yield* fs.makeDirectory(config.stateDir);
    yield* fs.writeFileString(yield* releaseFile, JSON.stringify({ version: 1 }));
    for (const selection of heldSelections) {
      assert.isTrue(yield* cutoverAdmissionHeld("thread:source", selection));
    }
    assert.isFalse(yield* cutoverAdmissionHeld("thread:source", glmSelection));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("fresh exemption reads create no files or state directories", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const before = yield* fs.readDirectory(config.baseDir);
    assert.isFalse(yield* cutoverThreadReleased("thread:rollback"));
    assert.isFalse(yield* preparedCutoverOwns("thread:rollback", "run:old"));
    for (const selection of heldSelections) {
      assert.isFalse(yield* cutoverAdmissionHeld("thread:rollback", selection));
    }
    assert.deepEqual(yield* fs.readDirectory(config.baseDir), before);
    assert.isFalse(yield* fs.exists(config.stateDir));
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rollback releases only its thread's inherited admission and old continuation without global finalization",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const threadId = "thread:rollback";
      yield* writePreparation([
        { threadId, runId: "run:old" },
        { threadId: "thread:other", runId: "run:other" },
      ]);
      const preparation = yield* fs.readFileString(yield* preparationFile);
      assert.isTrue(yield* preparedCutoverOwns(threadId, "run:old"));
      yield* releaseCutoverThread(threadId);

      assert.isTrue(yield* cutoverThreadReleased(threadId));
      assert.isFalse(yield* cutoverThreadReleased("thread:other"));
      assert.isFalse(yield* preparedCutoverOwns(threadId, "run:old"));
      assert.isFalse(yield* preparedCutoverOwns(threadId, "run:new"));
      assert.isTrue(yield* preparedCutoverOwns("thread:other", "run:other"));
      for (const selection of heldSelections) {
        assert.isFalse(yield* cutoverAdmissionHeld(threadId, selection));
        assert.isTrue(yield* cutoverAdmissionHeld("thread:other", selection));
      }
      assert.isFalse(yield* fs.exists(yield* releaseFile));
      assert.equal(yield* fs.readFileString(yield* preparationFile), preparation);
      yield* fs.writeFileString(yield* preparationFile, "{");
      assert.isFalse(yield* preparedCutoverOwns(threadId, "run:old"));
      assert.isFalse(yield* cutoverAdmissionHeld(threadId, heldSelections[0]!));
      assert.isTrue(yield* preparedCutoverOwns("thread:other", "run:other"));
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "release publishes a private fsynced hashed exemption atomically and retries without pending files",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = "thread:rollback/../../outside";
      const root = path.join(config.stateDir, "harness-cutover-exemptions");
      const stages: Array<string> = [];
      const observed: typeof fs = {
        ...fs,
        open: (file, options) =>
          fs.open(file, options).pipe(
            Effect.map(
              (handle) =>
                new Proxy(handle, {
                  get(target, property, receiver) {
                    if (property === "sync")
                      return target.sync.pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            stages.push(file === root ? "directory-sync" : "file-sync");
                          }),
                        ),
                      );
                    return Reflect.get(target, property, receiver);
                  },
                }),
            ),
          ),
        rename: (from, to) =>
          Effect.gen(function* () {
            assert.deepEqual(stages, ["file-sync"]);
            assert.isFalse(yield* fs.exists(to));
            assert.equal(path.dirname(to), root);
            assert.match(path.basename(to), /^[a-f0-9]{64}\.json$/);
            assert.deepEqual(JSON.parse(yield* fs.readFileString(from)), { version: 1, threadId });
            assert.equal((yield* fs.stat(from)).mode & 0o777, 0o600);
            stages.push("rename");
            yield* fs.rename(from, to);
          }),
      };
      yield* releaseCutoverThread(threadId).pipe(
        Effect.provideService(FileSystem.FileSystem, observed),
      );
      assert.deepEqual(stages, ["file-sync", "rename", "directory-sync"]);
      const files = yield* fs.readDirectory(root);
      assert.lengthOf(files, 1);
      const target = path.join(root, files[0]!);
      assert.equal((yield* fs.stat(target)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(yield* fs.readFileString(target)), { version: 1, threadId });
      yield* releaseCutoverThread(threadId);
      assert.deepEqual(yield* fs.readDirectory(root), files);
      assert.isTrue(yield* cutoverThreadReleased(threadId));
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  ["invalid JSON", "{"],
  ["unsupported version", JSON.stringify({ version: 2, threadId: "thread:rollback" })],
  ["missing identity", JSON.stringify({ version: 1 })],
  ["wrong identity", JSON.stringify({ version: 1, threadId: "thread:other" })],
] as const)("exemption with %s cannot release claims or admission", ([, contents]) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const threadId = "thread:rollback";
    yield* writePreparation([{ threadId, runId: "run:old" }]);
    yield* releaseCutoverThread(threadId);
    const root = path.join(config.stateDir, "harness-cutover-exemptions");
    const files = yield* fs.readDirectory(root);
    yield* fs.writeFileString(path.join(root, files[0]!), contents);
    assert.isFalse(yield* cutoverThreadReleased(threadId));
    assert.isTrue(yield* preparedCutoverOwns(threadId, "run:old"));
    for (const selection of heldSelections) {
      assert.isTrue(yield* cutoverAdmissionHeld(threadId, selection));
    }
    assert.isFalse(yield* cutoverAdmissionHeld(threadId, glmSelection));
  }).pipe(Effect.provide(layerTest)),
);
