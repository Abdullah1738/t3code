import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ModelSelection,
  RecordedModelSelection,
  standardModelSelection,
} from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);

it.effect("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    assert.strictEqual(parsed.model, "gpt-5-codex");
    assert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

it.effect("ModelSelection accepts an explicit instanceId routing key", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      assert.strictEqual(parsed.model, "llama3:70b");
    }),
);

it.effect("ModelSelection encodes to the canonical instanceId wire form", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeModelSelection({
      provider: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
    const encoded = yield* encodeModelSelection(decoded);
    assert.deepStrictEqual(encoded, {
      instanceId: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
  }),
);

it.effect("ModelSelection rejects malformed instance ids", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeModelSelection({
        instanceId: "1invalid",
        model: "x",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect(
  "normalizes legacy object-shaped options on decode and re-encodes as a canonical array",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeModelSelection({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,

          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      });
      assert.deepStrictEqual(decoded.options, [
        { id: "effort", value: "max" },
        { id: "fastMode", value: false },
      ]);
      const encoded = yield* encodeModelSelection(decoded);
      assert.deepStrictEqual(encoded.options, decoded.options);
    }),
);

it.effect("normalizes stale fast options on read for every transport", () =>
  Effect.gen(function* () {
    for (const instanceId of ["codex", "codex-cu", "custom-codex"]) {
      const parsed = yield* decodeModelSelection({
        instanceId,
        model: "gpt-6-sol",
        options: { serviceTier: "priority", reasoningEffort: "high" },
      });
      assert.deepStrictEqual(parsed.options, [
        { id: "serviceTier", value: "default" },
        { id: "reasoningEffort", value: "high" },
      ]);
    }
    const parsed = yield* decodeModelSelection({
      instanceId: "claudeAgent",
      model: "opus",
      options: { fastMode: true },
    });
    assert.deepStrictEqual(parsed.options, [{ id: "fastMode", value: false }]);
  }),
);

it("forces explicit standard defaults even for custom provider instances and priority-default models", () => {
  for (const model of ["gpt-6-sol", "gpt-6-luna"]) {
    const selection = standardModelSelection(
      { instanceId: ProviderInstanceId.make("custom"), model },
      "codex",
    );
    assert.deepStrictEqual(selection.options, [{ id: "serviceTier", value: "default" }]);
  }
  const selection = standardModelSelection(
    {
      instanceId: ProviderInstanceId.make("custom"),
      model: "opus",
      options: [{ id: "fastMode", value: true }],
    },
    "claudeAgent",
  );
  assert.deepStrictEqual(selection.options, [{ id: "fastMode", value: false }]);
});

it.effect("preserves parse failures for malformed persisted selections", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(decodeModelSelection({ instanceId: "codex", model: null }));
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("preserves recorded tiers for historical billing", () =>
  Effect.gen(function* () {
    const input = { instanceId: "codex", model: "gpt-6-sol", options: { serviceTier: "priority" } };
    const recorded = yield* Schema.decodeUnknownEffect(RecordedModelSelection)(input);
    const executable = yield* decodeModelSelection(input);
    assert.deepStrictEqual(recorded.options, [{ id: "serviceTier", value: "priority" }]);
    assert.deepStrictEqual(executable.options, [{ id: "serviceTier", value: "default" }]);
  }),
);


it.effect("validates option-free executable and recorded selections", () =>
  Effect.gen(function* () {
    for (const schema of [ModelSelection, RecordedModelSelection]) {
      const decode = Schema.decodeUnknownEffect(schema);
      const valid = yield* decode({ provider: "synthetic", model: "synthetic" });
      assert.deepStrictEqual(valid, {
        instanceId: ProviderInstanceId.make("synthetic"),
        model: "synthetic",
      });
      for (const input of [
        { instanceId: "1invalid", model: "synthetic" },
        { instanceId: "synthetic", model: null },
        { instanceId: "synthetic", model: " " },
        { provider: 42, model: "synthetic" },
      ]) {
        const result = yield* Effect.exit(decode(input));
        assert.strictEqual(result._tag, "Failure");
      }
    }
  }),
);
