import {
  ClaudeSettings,
  CodexSettings,
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { resolveSelection } from "@t3tools/client-runtime/ardud/models/harnessRouting";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Toml from "effect/encoding/Toml";

import * as ServerConfig from "../../config.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import { selectionProblem } from "../control/model.ts";

const Check = Schema.Struct({ ready: Schema.Boolean, reason: Schema.NonEmptyString });
const Evidence = Schema.Struct({
  version: Schema.Literal(1),
  buildCommit: Schema.NonEmptyString,
  checkedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  checks: Schema.Record(Schema.String, Check),
  models: Schema.Array(ModelSelection),
  routes: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      model: Schema.NonEmptyString,
      options: Schema.optionalKey(Schema.Array(ProviderOptionSelection)),
      route: Schema.NonEmptyString,
    }),
  ),
});
const decodeEvidence = Schema.decodeUnknownEffect(Schema.fromJsonString(Evidence));
const encodeSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaude = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodex = Schema.decodeUnknownEffect(CodexSettings);

const CommandHook = Schema.Struct({
  type: Schema.Literal("command"),
  command: Schema.NonEmptyString,
});
const Hooks = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Struct({ hooks: Schema.Array(CommandHook).check(Schema.isMinLength(1)) })),
);
const decodeHooks = Schema.decodeUnknownEffect(Schema.Struct({ hooks: Hooks }));
const decodeClaudeHome = Schema.decodeUnknownEffect(
  Schema.Struct({
    autoMemoryEnabled: Schema.Literal(false),
    autoDreamEnabled: Schema.Literal(false),
    disableAllHooks: Schema.optionalKey(Schema.Literal(false)),
    env: Schema.Struct({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: Schema.Literal("1"),
      CLAUDE_CODE_DISABLE_ORG_MEMORY: Schema.Literal("1"),
    }),
    hooks: Hooks,
  }),
);
const Mcp = Schema.Record(
  Schema.String,
  Schema.Union([
    Schema.Struct({ command: Schema.NonEmptyString }),
    Schema.Struct({ url: Schema.NonEmptyString }),
  ]),
);
const decodeClaudeMcp = Schema.decodeUnknownEffect(Schema.Struct({ mcpServers: Mcp }));
const decodeCodexHome = Schema.decodeUnknownEffect(
  Schema.Struct({
    features: Schema.Struct({
      memories: Schema.Literal(false),
      chronicle: Schema.Literal(false),
      hooks: Schema.Literal(true),
      computer_use: Schema.Boolean,
    }),
    memories: Schema.Struct({
      generate_memories: Schema.Literal(false),
      use_memories: Schema.Literal(false),
    }),
    mcp_servers: Mcp,
    hooks: Schema.Struct({
      state: Schema.Record(
        Schema.String,
        Schema.Struct({
          enabled: Schema.optionalKey(Schema.Boolean),
          trusted_hash: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  }),
);

const REQUIRED_CHECKS = [
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
] as const;
const REQUIRED_HOOKS = ["PreToolUse", "UserPromptSubmit", "PostToolUse", "Stop"] as const;
const HOMES = [
  { name: "claude", instanceId: "claudeAgent", driver: "claudeAgent" },
  { name: "codex", instanceId: "codex", driver: "codex" },
  { name: "codex-cu", instanceId: "codex-cu", driver: "codex" },
] as const;
const DAY_MS = 24 * 60 * 60 * 1_000;
const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const row = (id: string, ready: boolean, reason: string) => ({ id, ready, reason });
const orderedOptions = (selection: ModelSelection) =>
  [...(selection.options ?? [])]
    .map(({ id, value }) => ({ id, value }))
    .sort((a, b) => a.id.localeCompare(b.id) || String(a.value).localeCompare(String(b.value)));
const selectionKey = (selection: ModelSelection) =>
  encodeSelection({
    instanceId: selection.instanceId,
    model: selection.model,
    options: orderedOptions(selection),
  });
const selectionLabel = (selection: ModelSelection) => {
  const options = orderedOptions(selection);
  return `${selection.instanceId}/${selection.model}${options.length === 0 ? "" : `#${options.map(({ id, value }) => `${id}=${String(value)}`).join("&")}`}`;
};

export class CutoverReadiness extends Context.Service<
  CutoverReadiness,
  {
    /** Native instances must already be enabled; this read-only gate never enables them. */
    readonly check: (
      selections: readonly ModelSelection[],
    ) => Effect.Effect<
      readonly { readonly id: string; readonly ready: boolean; readonly reason: string }[]
    >;
  }
>()("t3/ardud/harness-migrate/CutoverReadiness") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;

  const readText = Effect.fn("CutoverReadiness.readText")(function* (file: string) {
    const base = yield* fs
      .realPath(config.baseDir)
      .pipe(Effect.mapError(() => "Cannot resolve the T3 home."));
    const real = yield* fs
      .realPath(file)
      .pipe(Effect.mapError(() => `Cannot resolve ${path.basename(file)}.`));
    if (real !== path.join(base, path.relative(config.baseDir, file))) {
      return yield* Effect.fail(
        `${path.basename(file)} must not redirect outside its generated location.`,
      );
    }
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(() => `Cannot read ${path.basename(file)}.`));
    if (text.trim().length === 0) return yield* Effect.fail(`${path.basename(file)} is empty.`);
    return text;
  });
  const readJson = Effect.fn("CutoverReadiness.readJson")(function* (file: string) {
    return yield* readText(file).pipe(
      Effect.flatMap(decodeJson),
      Effect.mapError(() => `Missing, unreadable or invalid ${path.basename(file)}.`),
    );
  });

  const homeCheck = Effect.fn("CutoverReadiness.homeCheck")(
    function* (home: (typeof HOMES)[number]) {
      const directory = path.join(config.baseDir, "harness-homes", home.name);
      const base = yield* fs
        .realPath(config.baseDir)
        .pipe(Effect.mapError(() => "Cannot resolve the T3 home."));
      const real = yield* fs
        .realPath(directory)
        .pipe(Effect.mapError(() => "Native home is missing or unreadable."));
      const stat = yield* fs
        .stat(directory)
        .pipe(Effect.mapError(() => "Cannot inspect the native home."));
      if (stat.type !== "Directory" || real !== path.join(base, "harness-homes", home.name)) {
        return yield* Effect.fail(
          "Native home must be an isolated directory, not a redirected home.",
        );
      }
      if (home.name === "claude") {
        const owned = yield* readJson(path.join(directory, "settings.json")).pipe(
          Effect.flatMap(decodeClaudeHome),
          Effect.mapError(() => "Claude memory must be disabled and command hooks configured."),
        );
        const mcp = yield* readJson(path.join(directory, ".claude.json")).pipe(
          Effect.flatMap(decodeClaudeMcp),
          Effect.mapError(() => "Claude MCP configuration is invalid."),
        );
        if (!mcp.mcpServers.dia || mcp.mcpServers["t3-code"]) {
          return yield* Effect.fail(
            "Dia must be configured and T3 must remain per-thread injected.",
          );
        }
        if (REQUIRED_HOOKS.some((event) => !owned.hooks[event]?.length)) {
          return yield* Effect.fail("Claude guard or recall hooks are missing.");
        }
        yield* readText(path.join(directory, "CLAUDE.md"));
        yield* readText(path.join(directory, "overlay.md"));
      } else {
        const text = yield* readText(path.join(directory, "config.toml"));
        const owned = yield* Effect.try(() => Toml.parse(text)).pipe(
          Effect.flatMap(decodeCodexHome),
          Effect.mapError(
            () => "Codex memory, hooks, trust state or MCP configuration is invalid.",
          ),
        );
        const hooks = yield* readJson(path.join(directory, "hooks.json")).pipe(
          Effect.flatMap(decodeHooks),
          Effect.mapError(() => "Codex hooks.json is invalid."),
        );
        if (
          !owned.mcp_servers.dia ||
          owned.mcp_servers["t3-code"] ||
          owned.features.computer_use !== (home.name === "codex-cu")
        ) {
          return yield* Effect.fail(
            "Codex Dia/T3 configuration or computer-use isolation is invalid.",
          );
        }
        if (REQUIRED_HOOKS.some((event) => !hooks.hooks[event]?.length)) {
          return yield* Effect.fail("Codex guard or recall hooks are missing.");
        }
        // A stored declaration hash is necessary, not proof of current trust; operator hooks evidence
        // must also come from hooks/list and a real denial on this build.
        for (const [event, groups] of Object.entries(hooks.hooks)) {
          const nativeEvent = event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
          for (const [groupIndex, group] of groups.entries()) {
            for (const hookIndex of group.hooks.keys()) {
              const key = `${path.join(directory, "hooks.json")}:${nativeEvent}:${groupIndex}:${hookIndex}`;
              const trust = owned.hooks.state[key];
              if (
                trust?.enabled !== true ||
                !/^sha256:[a-f0-9]{64}$/i.test(trust.trusted_hash ?? "")
              )
                return yield* Effect.fail("Codex command hook lacks enabled trust state.");
            }
          }
        }
        yield* readText(path.join(directory, "AGENTS.md"));
        yield* readJson(path.join(directory, "models.json"));
      }
      return row(
        `home:${home.name}`,
        true,
        "Native home artifacts passed; runtime proof is checked separately.",
      );
    },
    (effect, home) =>
      effect.pipe(
        Effect.catch((reason) => Effect.succeed(row(`home:${home.name}`, false, reason))),
      ),
  );

  const evidenceCheck = Effect.fn("CutoverReadiness.evidenceCheck")(
    function* (targets: readonly ModelSelection[], cu: boolean) {
      const file = path.join(config.baseDir, "harness-cutover-readiness.json");
      const evidence = yield* readText(file).pipe(
        Effect.flatMap(decodeEvidence),
        Effect.mapError(() => "Operator readiness evidence is missing, unreadable or invalid."),
      );
      if (!config.robobBuildCommit?.trim() || evidence.buildCommit !== config.robobBuildCommit) {
        return yield* Effect.fail(
          "Operator evidence must match the current robobBuildCommit exactly.",
        );
      }
      const now = yield* Clock.currentTimeMillis;
      const checked = DateTime.toEpochMillis(evidence.checkedAt);
      const expires = DateTime.toEpochMillis(evidence.expiresAt);
      if (
        checked > now + FUTURE_SKEW_MS ||
        now - checked > DAY_MS ||
        expires <= now ||
        expires <= checked ||
        expires - checked > DAY_MS
      ) {
        return yield* Effect.fail(
          "Operator evidence must be recent, unexpired and valid for at most 24 hours (5-minute future skew).",
        );
      }
      const names: readonly string[] = cu
        ? [...REQUIRED_CHECKS, "t3-codex-cu", "dia-codex-cu"]
        : REQUIRED_CHECKS;
      const results = names.map((name) => {
        const check = evidence.checks[name];
        return row(
          name,
          check?.ready === true,
          check?.reason ?? "Required operator check is missing.",
        );
      });
      const models = new Set(evidence.models.map(selectionKey));
      const routes = new Set(
        evidence.routes.filter((entry) => entry.route.trim().length > 0).map(selectionKey),
      );
      for (const selection of targets) {
        const key = selectionKey(selection);
        const label = selectionLabel(selection);
        results.push(
          row(
            `evidence-model:${label}`,
            models.has(key),
            models.has(key)
              ? "Exact model/options covered by operator evidence."
              : "Exact model/options absent from operator evidence.",
          ),
          row(
            `evidence-route:${label}`,
            routes.has(key),
            routes.has(key)
              ? "Exact model/options route covered by operator evidence."
              : "Exact model/options route absent from operator evidence.",
          ),
        );
      }
      return [row("evidence", true, "Fresh operator evidence matches this build."), ...results];
    },
    (effect) =>
      effect.pipe(Effect.catch((reason) => Effect.succeed([row("evidence", false, reason)]))),
  );

  const check = Effect.fn("CutoverReadiness.check")(function* (
    selections: readonly ModelSelection[],
  ) {
    const results: Array<{ id: string; ready: boolean; reason: string }> = [];
    const targetByKey = new Map<string, ModelSelection>();
    const seen = new Set<string>();
    for (const [index, selection] of selections.entries()) {
      const sourceKey = selectionKey(selection);
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      const resolved = resolveSelection(selection);
      if (resolved.kind === "conflict")
        results.push(row(`selection:${index}`, false, resolved.reason));
      else if (HOMES.some((home) => home.instanceId === resolved.selection.instanceId))
        targetByKey.set(selectionKey(resolved.selection), resolved.selection);
    }
    const targets = [...targetByKey.values()];
    const cu = targets.some((selection) => selection.instanceId === "codex-cu");
    const homes = HOMES.filter((home) => home.name !== "codex-cu" || cu);
    for (const home of homes) results.push(yield* homeCheck(home));
    results.push(...(yield* evidenceCheck(targets, cu)));
    const current = yield* settings.getSettings.pipe(Effect.catch(() => Effect.succeed(null)));
    if (current === null)
      return [...results, row("settings", false, "Cannot read server settings.")];
    const providers = yield* registry.getProviders;
    for (const home of homes) {
      const instance = current.providerInstances[ProviderInstanceId.make(home.instanceId)];
      const decoded =
        instance === undefined
          ? null
          : yield* home.name === "claude"
              ? decodeClaude(instance.config).pipe(
                  Effect.map((value) => ({
                    homePath: value.homePath,
                    shadowHomePath: "",
                    setupMode: "existing" as const,
                  })),
                  Effect.catch(() => Effect.succeed(null)),
                )
              : decodeCodex(instance.config).pipe(Effect.catch(() => Effect.succeed(null)));
      const provider = providers.find((candidate) => candidate.instanceId === home.instanceId);
      let problem: string | null = null;
      if (!instance || instance.driver !== home.driver || decoded === null)
        problem = "Configured native instance or driver configuration is missing/invalid.";
      else if (!resolveProviderInstanceEnabled(instance))
        problem =
          "Native instance is disabled; enable it before readiness and retain enabled through cutover.";
      else if (
        !path.isAbsolute(decoded.homePath) ||
        path.resolve(decoded.homePath) !== path.resolve(config.baseDir, "harness-homes", home.name)
      )
        problem = "Native instance must point directly at its absolute generated home.";
      else if (decoded.shadowHomePath || decoded.setupMode === "managed")
        problem =
          "Native cutover requires a direct existing home, not a shadow or managed runtime.";
      // A custom Codex provider can be ready with unknown account auth (requiresOpenaiAuth=false).
      // Runtime routes are proven by operator evidence, not an OpenAI account login.
      else if (
        !provider ||
        provider.driver !== home.driver ||
        !provider.enabled ||
        !provider.installed ||
        provider.status !== "ready" ||
        provider.auth.status === "unauthenticated"
      )
        problem =
          "Native registry status must be enabled, installed, ready and not unauthenticated.";
      else if (provider.models.length === 0) problem = "Native model catalog is empty.";
      results.push(
        row(
          `provider:${home.instanceId}`,
          problem === null,
          problem ?? "Configured native instance and registry are ready.",
        ),
      );
    }
    for (const [index, selection] of targets.entries()) {
      const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
      const present = provider?.models.some((model) => model.slug === selection.model) === true;
      const problem = present
        ? selectionProblem(providers, selection)
        : "Mapped model is absent from the native catalog.";
      results.push(
        row(
          `model:${index}:${selection.instanceId}/${selection.model}`,
          problem === null,
          problem ?? "Mapped model and options are offered by the native catalog.",
        ),
      );
    }
    return results;
  });
  return CutoverReadiness.of({ check });
});

export const layer = Layer.effect(CutoverReadiness, make);
