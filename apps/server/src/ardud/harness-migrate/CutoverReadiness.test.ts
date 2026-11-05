import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ProviderRegistry from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import * as CutoverReadiness from "./CutoverReadiness.ts";

const BUILD = "0123456789abcdef";
const CODEX = ProviderInstanceId.make("codex");
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-05T12:00:00.000Z"));
const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));
const CHECKS = [
  "homes",
  "routes",
  "t3-claude",
  "t3-codex",
  "dia-claude",
  "dia-codex",
  "hooks",
  "canaries-417",
  "pilot-246",
  "installer-245",
];
const HOOKS = Object.fromEntries(
  ["PreToolUse", "UserPromptSubmit", "PostToolUse", "Stop"].map((event) => [
    event,
    [{ hooks: [{ type: "command", command: "/fixture/guard.py" }] }],
  ]),
);
const selections: readonly ModelSelection[] = [
  {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "opus/claude-opus-5-5#xhigh",
  },
  {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "opus/cx/gpt-6.1-sol",
    options: [{ id: "variant", value: "high" }],
  },
];
const terra: ModelSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "opus/cx/gpt-6.1-terra",
};
const evidencedModels: readonly ModelSelection[] = [
  {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "xhigh" }],
  },
  {
    instanceId: CODEX,
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  {
    instanceId: ProviderInstanceId.make("codex-cu"),
    model: "gpt-6.1-terra",
  },
];
const provider = (id: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(id === "claudeAgent" ? "claudeAgent" : "codex"),
  enabled: true,
  installed: true,
  version: "fixture",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: iso(NOW),
  models: [
    {
      slug:
        id === "claudeAgent" ? "claude-opus-5-5" : id === "codex" ? "gpt-6.1-sol" : "gpt-6.1-terra",
      name: "Fixture",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: id === "claudeAgent" ? "effort" : "reasoningEffort",
            label: "Effort",
            type: "select",
            options: ["high", "xhigh"].map((id) => ({ id, label: id })),
          },
          {
            id: "serviceTier",
            label: "Service tier",
            type: "select",
            options: [{ id: "flex", label: "Flex" }],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
});
const providers = [provider("claudeAgent"), provider("codex"), provider("codex-cu")];
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "cutover-readiness-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
);

const fixture = Effect.fn("CutoverReadinessTest.fixture")(function* () {
  yield* TestClock.setTime(NOW);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const homes = Object.fromEntries(
    ["claude", "codex", "codex-cu"].map((name) => [
      name,
      path.join(config.baseDir, "harness-homes", name),
    ]),
  );
  const writeJson = Effect.fn("CutoverReadinessTest.writeJson")(function* (
    file: string,
    value: unknown,
  ) {
    yield* fs.writeFileString(file, JSON.stringify(value));
  });
  const codexConfig = (home: string, cu: boolean) =>
    [
      "[features]",
      "memories = false",
      "chronicle = false",
      "hooks = true",
      `computer_use = ${cu}`,
      "[memories]",
      "generate_memories = false",
      "use_memories = false",
      "[mcp_servers.dia]",
      'command = "/fixture/dia"',
      ...Object.keys(HOOKS).flatMap((event) => [
        `[hooks.state.${JSON.stringify(`${home}/hooks.json:${event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}:0:0`)}]`,
        "enabled = true",
        `trusted_hash = "sha256:${"a".repeat(64)}"`,
      ]),
    ].join("\n");
  for (const [name, directory] of Object.entries(homes)) {
    yield* fs.makeDirectory(directory, { recursive: true });
    if (name === "claude") {
      yield* writeJson(path.join(directory, "settings.json"), {
        autoMemoryEnabled: false,
        autoDreamEnabled: false,
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_ORG_MEMORY: "1" },
        hooks: HOOKS,
      });
      yield* writeJson(path.join(directory, ".claude.json"), {
        mcpServers: { dia: { command: "/fixture/dia" } },
      });
      yield* fs.writeFileString(path.join(directory, "CLAUDE.md"), "@/fixture/AGENTS.md\n");
      yield* fs.writeFileString(path.join(directory, "overlay.md"), "Fixture overlay\n");
    } else {
      yield* fs.writeFileString(
        path.join(directory, "config.toml"),
        codexConfig(directory, name === "codex-cu"),
      );
      yield* writeJson(path.join(directory, "hooks.json"), { hooks: HOOKS });
      yield* writeJson(path.join(directory, "models.json"), { models: [{ slug: "fixture" }] });
      yield* fs.writeFileString(path.join(directory, "AGENTS.md"), "Fixture instructions\n");
    }
  }
  yield* settings.updateSettings({
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        config: { homePath: homes.claude },
      },
      [CODEX]: {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { homePath: homes.codex, setupMode: "existing" },
      },
      [ProviderInstanceId.make("codex-cu")]: {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { homePath: homes["codex-cu"], setupMode: "existing" },
      },
    },
  });
  const evidenceFile = path.join(config.baseDir, "harness-cutover-readiness.json");
  const evidence = {
    version: 1,
    buildCommit: BUILD,
    checkedAt: iso(NOW - 60_000),
    expiresAt: iso(NOW + 60_000),
    checks: Object.fromEntries(
      CHECKS.map((name) => [name, { ready: true, reason: "Operator fixture passed." }]),
    ),
    models: evidencedModels,
    routes: evidencedModels.map((model) => ({ ...model, route: "Operator fixture native route." })),
  };
  const writeEvidence = Effect.fn("CutoverReadinessTest.writeEvidence")(function* (
    overrides: Record<string, unknown> = {},
  ) {
    yield* writeJson(evidenceFile, { ...evidence, ...overrides });
  });
  yield* writeEvidence();
  const check = Effect.fn("CutoverReadinessTest.check")(function* (
    selected: readonly ModelSelection[] = selections,
    catalog: readonly ServerProvider[] = providers,
    buildCommit: string | null = BUILD,
  ) {
    return yield* Effect.gen(function* () {
      return yield* (yield* CutoverReadiness.CutoverReadiness).check(selected);
    }).pipe(
      Effect.provide(
        CutoverReadiness.layer.pipe(
          Layer.provide(ProviderRegistry.layer(catalog)),
          Layer.provide(
            Layer.succeed(ServerConfig.ServerConfig, { ...config, robobBuildCommit: buildCommit }),
          ),
        ),
      ),
    );
  });
  return { fs, path, homes, settings, check, writeEvidence, writeJson, evidence, evidenceFile };
});

type Results = Effect.Success<ReturnType<CutoverReadiness.CutoverReadiness["Service"]["check"]>>;
const failed = (results: Results, id: string) => {
  const result = results.find((result) => result.id === id);
  assert.isDefined(result, `Expected readiness row ${id}`);
  assert.isFalse(result!.ready, result!.reason);
  return result!;
};

describe("CutoverReadiness", () => {
  it.effect(
    "accepts valid isolated artifacts, enabled registry and fresh build-matched evidence",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const results = yield* f.check();
        assert.deepEqual(
          results.filter((result) => !result.ready),
          [],
        );
        assert.isTrue(results.some((result) => result.id.includes("claude-opus-5-5")));
        assert.isTrue(results.some((result) => result.id === "installer-245"));
        assert.isFalse(results.some((result) => result.id.includes("codex-cu")));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "never infers runtime proof from valid homes, settings or an authenticated catalog",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.remove(f.evidenceFile);
        failed(yield* f.check(), "evidence");
        yield* f.fs.writeFileString(f.evidenceFile, "{broken");
        failed(yield* f.check(), "evidence");
        yield* f.writeEvidence({ version: 2 });
        failed(yield* f.check(), "evidence");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("requires exact build identity, including when the server has no stamped commit", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.writeEvidence({ buildCommit: `${BUILD}-other` });
      assert.include(failed(yield* f.check(), "evidence").reason, "robobBuildCommit");
      yield* f.writeEvidence();
      failed(yield* f.check(selections, providers, null), "evidence");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects expired, stale, future-dated, invalid and overlong evidence windows", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const iso = (delta: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + delta));
      for (const timestamps of [
        { expiresAt: iso(0) },
        { checkedAt: iso(-86_400_001), expiresAt: iso(1) },
        { checkedAt: iso(300_001), expiresAt: iso(600_000) },
        { checkedAt: "not a date" },
        { checkedAt: iso(0), expiresAt: iso(86_400_001) },
        { checkedAt: iso(1), expiresAt: iso(1) },
      ]) {
        yield* f.writeEvidence(timestamps);
        failed(yield* f.check(), "evidence");
      }
      yield* f.writeEvidence({ checkedAt: iso(300_000), expiresAt: iso(600_000) });
      assert.isTrue((yield* f.check()).every((result) => result.ready));
      yield* f.writeEvidence({ checkedAt: iso(-86_400_000 + 1), expiresAt: iso(1) });
      assert.isTrue((yield* f.check()).every((result) => result.ready));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports missing or failed operator checks without accepting truthy strings", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.writeEvidence({
        checks: { ...f.evidence.checks, hooks: { ready: false, reason: "Hook denial failed." } },
      });
      assert.equal(failed(yield* f.check(), "hooks").reason, "Hook denial failed.");
      yield* f.writeEvidence({
        checks: {
          ...f.evidence.checks,
          "canaries-417": { ready: false, reason: "Real native canary did not pass." },
          "pilot-246": { ready: false, reason: "Pilot did not pass." },
        },
      });
      const acceptance = yield* f.check();
      failed(acceptance, "canaries-417");
      failed(acceptance, "pilot-246");
      const { "pilot-246": _pilot, ...checks } = f.evidence.checks;
      yield* f.writeEvidence({ checks });
      failed(yield* f.check(), "pilot-246");
      yield* f.writeEvidence({
        checks: { ...checks, hooks: { ready: "true", reason: "Not a boolean." } },
      });
      failed(yield* f.check(), "evidence");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "refuses disabled instances even with successful evidence and a healthy cached registry",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const current = yield* f.settings.getSettings;
        yield* f.settings.updateSettings({
          providerInstances: {
            ...current.providerInstances,
            [CODEX]: { ...current.providerInstances[CODEX]!, enabled: false },
          },
        });
        assert.include(failed(yield* f.check(), "provider:codex").reason, "disabled");
        yield* f.settings.updateSettings({
          providerInstances: {
            ...current.providerInstances,
            [CODEX]: {
              ...current.providerInstances[CODEX]!,
              enabled: true,
              config: { homePath: f.homes.codex, enabled: false },
            },
          },
        });
        failed(yield* f.check(), "provider:codex");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("requires explicit matching driver/home and refuses managed or shadow runtimes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const current = yield* f.settings.getSettings;
      for (const config of [
        { homePath: "/fixture/personal" },
        { homePath: "harness-homes/codex" },
        { homePath: f.homes.codex, setupMode: "managed" },
        { homePath: f.homes.codex, shadowHomePath: "/fixture/shadow" },
      ]) {
        yield* f.settings.updateSettings({
          providerInstances: {
            ...current.providerInstances,
            [CODEX]: { ...current.providerInstances[CODEX]!, config },
          },
        });
        failed(yield* f.check(), "provider:codex");
      }
      yield* f.settings.updateSettings({
        providerInstances: {
          ...current.providerInstances,
          [CODEX]: {
            ...current.providerInstances[CODEX]!,
            driver: ProviderDriverKind.make("opencode"),
          },
        },
      });
      failed(yield* f.check(), "provider:codex");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "requires healthy native registry snapshots and permits custom-provider unknown account auth",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const override of [
          { enabled: false },
          { installed: false },
          { status: "warning" as const },
          { auth: { status: "unauthenticated" as const } },
          { models: [] },
          { driver: ProviderDriverKind.make("opencode") },
        ]) {
          failed(
            yield* f.check(selections, [providers[0]!, { ...providers[1]!, ...override }]),
            "provider:codex",
          );
        }
        failed(yield* f.check(selections, []), "provider:claudeAgent");
        failed(yield* f.check(selections, []), "model:0:claudeAgent/claude-opus-5-5");
        assert.isTrue(
          (yield* f.check(selections, [
            providers[0]!,
            { ...providers[1]!, auth: { status: "unknown" } },
          ])).every((result) => result.ready),
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "checks mapped model presence, native effort values, duplicate options and descriptor availability",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const unknown = { ...selections[0]!, model: "opus/claude-unmapped" };
        failed(yield* f.check([unknown]), "selection:0");
        const missing = {
          ...selections[0]!,
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "unknown",
        };
        failed(yield* f.check([missing]), "model:0:claudeAgent/unknown");
        const native = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
        for (const options of [
          [{ id: "reasoningEffort", value: "max" }],
          [
            { id: "reasoningEffort", value: "high" },
            { id: "reasoningEffort", value: "high" },
          ],
          [{ id: "variant", value: "high" }],
          [{ id: "unknownOption", value: "high" }],
        ]) {
          failed(yield* f.check([{ ...native, options }]), "model:0:codex/gpt-6.1-sol");
        }
        failed(
          yield* f.check(selections, [
            providers[0]!,
            {
              ...providers[1]!,
              models: [{ ...providers[1]!.models[0]!, capabilities: {} }],
            },
          ]),
          "model:1:codex/gpt-6.1-sol",
        );
        const unrelated = { instanceId: ProviderInstanceId.make("opencode"), model: "or/glm" };
        assert.isTrue((yield* f.check([unrelated])).every((result) => result.ready));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "fails closed on missing, malformed, redirected or unsafe generated home artifacts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const claudeSettings = f.path.join(f.homes.claude!, "settings.json");
        const original = yield* f.fs.readFileString(claudeSettings);
        yield* f.writeJson(claudeSettings, { autoMemoryEnabled: true });
        failed(yield* f.check(), "home:claude");
        yield* f.fs.writeFileString(claudeSettings, original);
        const codexConfig = f.path.join(f.homes.codex!, "config.toml");
        const originalToml = yield* f.fs.readFileString(codexConfig);
        yield* f.fs.writeFileString(
          codexConfig,
          originalToml.replace("enabled = true", "enabled = false"),
        );
        failed(yield* f.check(), "home:codex");
        yield* f.fs.writeFileString(codexConfig, "[broken");
        failed(yield* f.check(), "home:codex");
        yield* f.fs.writeFileString(
          codexConfig,
          originalToml.replaceAll("trusted_hash", "untrusted_hash"),
        );
        failed(yield* f.check(), "home:codex");
        yield* f.fs.remove(f.homes.codex!, { recursive: true });
        const elsewhere = yield* f.fs.makeTempDirectoryScoped({ prefix: "cutover-redirect-" });
        yield* f.fs.symlink(elsewhere, f.homes.codex!);
        failed(yield* f.check(), "home:codex");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("requires CU home, provider and T3/Dia evidence only when Terra is targeted", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const withTerra = [...selections, terra];
      failed(yield* f.check(withTerra), "t3-codex-cu");
      failed(yield* f.check(withTerra), "dia-codex-cu");
      yield* f.writeEvidence({
        checks: {
          ...f.evidence.checks,
          "t3-codex-cu": { ready: true, reason: "CU T3 passed." },
          "dia-codex-cu": { ready: true, reason: "CU Dia passed." },
        },
      });
      assert.isTrue((yield* f.check(withTerra)).every((result) => result.ready));
      yield* f.fs.remove(f.homes["codex-cu"]!, { recursive: true });
      failed(yield* f.check(withTerra), "home:codex-cu");
      assert.isTrue((yield* f.check()).every((result) => result.ready));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("requires model and route evidence even when the generic routes check passed", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const missing of [
        { models: undefined },
        { routes: undefined },
        { models: null },
        { routes: { "codex/gpt-6.1-sol": "Generic model route without effort." } },
      ]) {
        yield* f.writeEvidence(missing);
        failed(yield* f.check(), "evidence");
      }
      yield* f.writeEvidence({ models: [], routes: [] });
      failed(yield* f.check(), "evidence-model:claudeAgent/claude-opus-5-5#effort=xhigh");
      failed(yield* f.check(), "evidence-route:codex/gpt-6.1-sol#reasoningEffort=high");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "requires the exact evidenced model and option values on both the model and route",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const selected = [selections[1]!];
        const native = evidencedModels[1]!;
        for (const wrong of [
          { ...native, model: "unknown" },
          { ...native, options: [{ id: "reasoningEffort", value: "xhigh" }] },
          { ...native, options: [{ id: "unknownOption", value: "high" }] },
          { ...native, options: [] },
          { ...native, options: [...native.options!, { id: "serviceTier", value: "flex" }] },
        ]) {
          yield* f.writeEvidence({
            models: [wrong],
            routes: [{ ...wrong, route: "Different selection route." }],
          });
          const results = yield* f.check(selected);
          failed(results, "evidence-model:codex/gpt-6.1-sol#reasoningEffort=high");
          failed(results, "evidence-route:codex/gpt-6.1-sol#reasoningEffort=high");
        }
        yield* f.writeEvidence({ routes: [{ ...native, route: "   " }] });
        failed(yield* f.check(selected), "evidence-route:codex/gpt-6.1-sol#reasoningEffort=high");
        yield* f.writeEvidence({
          models: [native],
          routes: [{ ...native, route: "Exact high-effort route passed." }],
        });
        assert.isTrue((yield* f.check(selected)).every((result) => result.ready));
        failed(yield* f.check([{ ...native, options: [] }]), "evidence-model:codex/gpt-6.1-sol");
        failed(yield* f.check([{ ...native, options: [] }]), "evidence-route:codex/gpt-6.1-sol");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "deduplicates repeated mapped targets and option order without merging distinct efforts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const native: ModelSelection = {
          ...evidencedModels[1]!,
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "flex" },
          ],
        };
        const reversed = { ...native, options: native.options!.toReversed() };
        const legacy: ModelSelection = {
          ...selections[1]!,
          options: [
            { id: "serviceTier", value: "flex" },
            { id: "variant", value: "high" },
          ],
        };
        yield* f.writeEvidence({
          models: [native],
          routes: [{ ...reversed, route: "High flex route passed." }],
        });
        const results = yield* f.check(
          Array.from({ length: 3_000 }, (_, index) => [native, reversed, legacy][index % 3]!),
        );
        assert.isTrue(results.every((result) => result.ready));
        assert.lengthOf(
          results.filter((result) => result.id.startsWith("model:")),
          1,
        );
        assert.lengthOf(
          results.filter((result) => result.id.startsWith("evidence-model:")),
          1,
        );
        assert.lengthOf(
          results.filter((result) => result.id.startsWith("evidence-route:")),
          1,
        );
        const anotherEffort = {
          ...native,
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "flex" },
          ],
        };
        const distinct = yield* f.check([native, anotherEffort, native]);
        assert.lengthOf(
          distinct.filter((result) => result.id.startsWith("model:")),
          2,
        );
        failed(distinct, "evidence-model:codex/gpt-6.1-sol#reasoningEffort=xhigh&serviceTier=flex");
        failed(distinct, "evidence-route:codex/gpt-6.1-sol#reasoningEffort=xhigh&serviceTier=flex");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("turns a settings read error into a failed readiness row, not a failed effect", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const results = yield* f.check().pipe(
        Effect.provide(
          Layer.mock(ServerSettingsService.ServerSettingsService)({
            getSettings: Effect.fail(
              new ServerSettingsError({
                settingsPath: "fixture",
                operation: "read-file",
                cause: "fixture",
              }),
            ),
          }),
        ),
      );
      failed(results, "settings");
    }).pipe(Effect.provide(testLayer)),
  );
});
