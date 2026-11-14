// @effect-diagnostics nodeBuiltinImport:off - benchmark reproduces the previous synchronous SHA-256 hit path.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeDecodeCache } from "./decodeCache.ts";

const counts = () => ({ hits: 0, misses: 0, evictions: 0 });
const row = { id: "large", cache_version: 1, json: JSON.stringify({ text: "a".repeat(8192) }) };

it.effect(
  "a large cache hit reads only the id and revision, without accessing JSON or hashing",
  () =>
    Effect.gen(function* () {
      let decodes = 0;
      const cache = makeDecodeCache(
        "test",
        (json) =>
          Effect.sync(() => {
            decodes++;
            return { jsonLength: json.length };
          }),
        (value: typeof row) => value.id,
        Effect.succeed({}),
      );
      const read = counts();
      const value = yield* cache.decode(row, read);
      const hit = {
        ...row,
        get json(): string {
          throw new Error("hit touched JSON");
        },
      };
      assert.strictEqual(yield* cache.decode(hit, read), value);
      assert.strictEqual(decodes, 1);
      assert.strictEqual(read.hits, 1);
      assert.strictEqual(read.misses, 1);
    }),
);

it.effect("transaction-local decodes neither consume nor replace shared entries", () =>
  Effect.gen(function* () {
    const cache = makeDecodeCache(
      "test",
      (json) => Effect.succeed({ json }),
      (value: typeof row) => value.id,
      Effect.succeed({}),
    );
    const read = counts();
    const shared = yield* cache.decode(row, read);
    const changed = { ...row, json: "changed", cache_version: 2 };
    assert.strictEqual((yield* cache.decode(changed, read, false)).json, "changed");
    assert.strictEqual(yield* cache.decode(row, read), shared);
    assert.strictEqual(cache.stats().entries, 1);
  }),
);

it.live("benchmarks 10000 cached hits on 8 KB rows against the previous SHA-256 cache", () =>
  Effect.gen(function* () {
    const cache = makeDecodeCache(
      "test",
      (json) => Effect.succeed({ jsonLength: json.length }),
      (value: typeof row) => value.id,
      Effect.succeed({}),
    );
    const read = counts();
    const value = yield* cache.decode(row, read);
    const previous = new Map([
      [
        row.id,
        {
          identity: NodeCrypto.createHash("sha256").update(row.json, "utf16le").digest("base64"),
          length: row.json.length,
          value,
        },
      ],
    ]);
    const oldCounts = counts();
    const oldHit = () =>
      Effect.suspend(() => {
        const identity =
          row.json.length > 1024
            ? NodeCrypto.createHash("sha256").update(row.json, "utf16le").digest("base64")
            : row.json;
        const entry = previous.get(row.id);
        if (entry?.length === row.json.length && entry.identity === identity) {
          oldCounts.hits++;
          read.hits++;
          return Effect.succeed(entry.value);
        }
        return Effect.die("expected a cached hit");
      });
    const hit = () => cache.decode(row, read);
    const measure = (operation: () => Effect.Effect<typeof value>) =>
      Effect.gen(function* () {
        const started = process.cpuUsage();
        for (let i = 0; i < 10000; i++) yield* operation();
        const elapsed = process.cpuUsage(started);
        return (elapsed.user + elapsed.system) / 1000;
      });
    for (let i = 0; i < 1000; i++) {
      yield* oldHit();
      yield* hit();
    }
    const oldCpuMs = yield* measure(oldHit);
    const newCpuMs = yield* measure(hit);
    yield* Effect.logInfo("KANBAN_CACHE_HIT_CPU", {
      hits: 10000,
      textCodeUnits: 8192,
      oldCpuMs,
      newCpuMs,
    });
  }),
);
