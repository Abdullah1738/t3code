import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../config.ts";
import * as CutoverContext from "./CutoverContext.ts";

const item = {
  threadId: "thread:cutover/../safe",
  targetInstance: "codex",
  text: "Carry on with the same task.",
};
const claim = { ...item, runId: "run:first" };
const next = { ...claim, runId: "run:next" };
const layer = (stateDir: string) =>
  CutoverContext.layer.pipe(
    Layer.provide(
      Layer.mock(ServerConfig.ServerConfig)({ stateDir } as ServerConfig.ServerConfig["Service"]),
    ),
  );

it.effect(
  "stages lazily, binds the target run and persists acceptance across service recreation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-context-" });
      yield* Effect.gen(function* () {
        const context = yield* CutoverContext.CutoverContext;
        assert.isNull(yield* context.read(claim));
        assert.equal(yield* context.status(item.threadId), "missing");
        assert.deepEqual(yield* fs.readDirectory(stateDir), []);
        yield* context.put(item);
        yield* context.put(item);
        assert.equal(yield* context.status(item.threadId), "pending");
        assert.isNull(yield* context.read({ ...claim, targetInstance: "claudeAgent" }));
        assert.equal(yield* context.read(claim), item.text);
        assert.equal(yield* context.read(claim), item.text);
        assert.equal(yield* context.status(item.threadId), "claimed");
        assert.equal((yield* context.read(next).pipe(Effect.flip)).reason, "ambiguous");
        yield* context.accepted(claim);
        yield* context.accepted(claim);
        assert.equal(yield* context.status(item.threadId), "accepted");
      }).pipe(Effect.provide(layer(stateDir)));
      yield* Effect.gen(function* () {
        const context = yield* CutoverContext.CutoverContext;
        yield* context.put(item);
        assert.isNull(yield* context.read(next));
        assert.equal(
          (yield* context.put({ ...item, text: "different" }).pipe(Effect.flip)).reason,
          "conflict",
        );
        yield* context.remove(item.threadId);
        assert.equal(yield* context.status(item.threadId), "missing");
        yield* context.put({ ...item, text: "a new cutover" });
        assert.equal(yield* context.read(next), "a new cutover");
      }).pipe(Effect.provide(layer(stateDir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retains an ambiguous claim across restart; only proven refusal releases it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-context-" });
    yield* Effect.gen(function* () {
      const context = yield* CutoverContext.CutoverContext;
      yield* context.put(item);
      yield* context.read(claim);
    }).pipe(Effect.provide(layer(stateDir)));
    yield* Effect.gen(function* () {
      const context = yield* CutoverContext.CutoverContext;
      assert.equal((yield* context.read(next).pipe(Effect.flip)).reason, "ambiguous");
      assert.equal((yield* context.refused(next).pipe(Effect.flip)).reason, "ambiguous");
      yield* context.refused(claim);
      yield* context.refused(claim);
      assert.equal(yield* context.read(next), item.text);
      assert.equal(
        (yield* context.put({ ...item, targetInstance: "claudeAgent" }).pipe(Effect.flip)).reason,
        "conflict",
      );
    }).pipe(Effect.provide(layer(stateDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refreshes an unclaimed owner answer once and retries the enriched context idempotently", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-context-answers-" });
    yield* Effect.gen(function* () {
      const context = yield* CutoverContext.CutoverContext;
      yield* context.put(item);
      const enriched = { ...item, text: `${item.text}\nOwner answered: continue`, refreshPending: true };
      yield* context.put(enriched);
      yield* context.put(enriched);
      assert.equal(yield* context.read(claim), enriched.text);
      assert.equal((yield* context.put({ ...enriched, text: "late replacement" }).pipe(Effect.flip)).reason, "conflict");
    }).pipe(Effect.provide(layer(stateDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects oversized context without creating storage", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-context-" });
    yield* Effect.gen(function* () {
      const context = yield* CutoverContext.CutoverContext;
      assert.equal(
        (yield* context.put({ ...item, text: "🧪".repeat(5_000) }).pipe(Effect.flip)).reason,
        "budget",
      );
      assert.deepEqual(yield* fs.readDirectory(stateDir), []);
    }).pipe(Effect.provide(layer(stateDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not let concurrent puts replace a pending brief", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-context-" });
    yield* Effect.gen(function* () {
      const context = yield* CutoverContext.CutoverContext;
      const results = yield* Effect.all(
        [
          context.put(item).pipe(Effect.result),
          context.put({ ...item, text: "different concurrent brief" }).pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      const failure = results.find((result) => result._tag === "Failure");
      assert.equal(failure?._tag === "Failure" ? failure.failure.reason : null, "conflict");
      assert.oneOf(yield* context.read(claim), [item.text, "different concurrent brief"]);
    }).pipe(Effect.provide(layer(stateDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
