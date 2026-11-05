import {
  ClaudeSettings,
  CodexSettings,
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { resolveSelection } from "@t3tools/client-runtime/ardud/models/harnessRouting";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- parity hashes are deterministic local byte digests.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
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
import { DEFAULT_HANDOFF_TOKEN_CAP } from "@t3tools/provider-core/server/handoffBudget";

const Check = Schema.Struct({ ready: Schema.Boolean, reason: Schema.NonEmptyString });
const Evidence = Schema.Struct({
  version: Schema.Literal(1),
  buildCommit: Schema.NonEmptyString,
  checkedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  checks: Schema.Record(Schema.String, Check),
  homesCheck: Schema.Struct({
    schemaVersion: Schema.Literal(1),
    ok: Schema.Boolean,
    failures: Schema.Array(Schema.String),
    homes: Schema.Array(
      Schema.Struct({
        harness: Schema.NonEmptyString,
        home: Schema.NonEmptyString,
        parityManifestPath: Schema.NonEmptyString,
      }),
    ),
  }),
  models: Schema.Array(ModelSelection),
  routes: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      model: Schema.NonEmptyString,
      options: Schema.optionalKey(Schema.Array(ProviderOptionSelection)),
      route: Schema.NonEmptyString,
    }),
  ),
  tools: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      scope: Schema.Literals(["ordinary", "board"]),
      names: Schema.Array(Schema.NonEmptyString),
    }),
  ),
});
const decodeEvidence = Schema.decodeUnknownEffect(Schema.fromJsonString(Evidence));
const encodeSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaude = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodex = Schema.decodeUnknownEffect(CodexSettings);
const SourceDigest = Schema.Struct({
  path: Schema.NonEmptyString,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const ArtifactDigest = Schema.Struct({
  ...SourceDigest.fields,
  format: Schema.optionalKey(Schema.Literal("claude-owned-json")),
});
const decodeClaudeOwnedJson = Schema.decodeUnknownEffect(
  Schema.Struct({
    mcpServers: Schema.JsonObject,
    hasCompletedOnboarding: Schema.Boolean,
  }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const codePointOrder = (left: string, right: string) => {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
};
const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);
const canonicalJson = (value: Schema.Json): string => {
  if (value === null || typeof value !== "object") return encodeJson(value);
  if (isJsonArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort(codePointOrder)
    .map((key) => `${encodeJson(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
};
const decodeGeneratorManifest = Schema.decodeUnknownEffect(
  Schema.Struct({
    skillRoots: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
    instructions: Schema.Struct({ canonical: Schema.NonEmptyString }),
    mcpServers: Schema.Array(
      Schema.Struct({ id: Schema.NonEmptyString, url: Schema.optionalKey(Schema.String) }),
    ),
  }),
);
const decodeHomeManifest = Schema.decodeUnknownEffect(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    harness: Schema.Literals(["claude", "codex", "codex-cu"]),
    generator: SourceDigest,
    artifacts: Schema.Array(ArtifactDigest),
    instructions: Schema.Struct({
      canonical: SourceDigest,
      overlays: Schema.Array(SourceDigest),
    }),
    mcpServers: Schema.Array(
      Schema.Struct({ id: Schema.NonEmptyString, url: Schema.optionalKey(Schema.String) }),
    ),
    skills: Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        source: Schema.NonEmptyString,
        sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      }),
    ),
    guards: Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyString,
        sources: Schema.Array(SourceDigest).check(Schema.isMinLength(1)),
      }),
    ),
  }),
);

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
  "statev2-guard",
  "offbox",
  "betterstack",
  "coord",
  "board-delegation",
  "recall-identity",
] as const;
const REQUIRED_MCP = [
  "betterstack",
  "perplexity",
  "inbody",
  "flighty",
  "cua-driver",
  "dia",
  "recall",
];
const REQUIRED_TOOLS = [
  "t3_thread_read",
  "delegate_task",
  "board_get",
  "board_open",
  "evaluator_start",
  "card_search",
  "card_get",
  "card_update",
  "card_move",
  "card_ask",
  "card_ask_change",
  "card_flag",
  "card_review_result",
  "card_create",
  "card_claim",
  "card_next",
  "card_edit",
  "card_thread",
];
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

  const sourceText = Effect.fn("CutoverReadiness.sourceText")(function* (file: string) {
    if (!path.isAbsolute(file))
      return yield* Effect.fail("Home manifest source paths must be absolute.");
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(() => "Home manifest source is unreadable."));
    if (!text.trim()) return yield* Effect.fail("Home manifest source is empty.");
    return text;
  });
  const verifyDigest = Effect.fn("CutoverReadiness.verifyDigest")(function* (
    source: typeof SourceDigest.Type,
  ) {
    if (!path.isAbsolute(source.path))
      return yield* Effect.fail("Parity source paths must be absolute.");
    const bytes = yield* fs
      .readFile(source.path)
      .pipe(Effect.mapError(() => "Parity source is unreadable."));
    if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== source.sha256)
      return yield* Effect.fail("Parity source hash differs from current source bytes.");
  });
  const verifyArtifact = Effect.fn("CutoverReadiness.verifyArtifact")(function* (
    artifact: typeof ArtifactDigest.Type,
  ) {
    const text = yield* readText(artifact.path);
    const owned = path.basename(artifact.path) === ".claude.json";
    if (
      (owned && artifact.format !== "claude-owned-json") ||
      (!owned && artifact.format !== undefined)
    ) {
      return yield* Effect.fail(
        "Only .claude.json must use the claude-owned-json artifact format.",
      );
    }
    if (!owned) return yield* verifyDigest(artifact);
    const value = yield* decodeJson(text).pipe(
      Effect.flatMap(decodeClaudeOwnedJson),
      Effect.mapError(() => "Claude generator-owned JSON fields are missing or invalid."),
    );
    const digest = NodeCrypto.createHash("sha256")
      .update(canonicalJson(value), "utf8")
      .digest("hex");
    if (digest !== artifact.sha256)
      return yield* Effect.fail("Claude generator-owned JSON fields differ from expected output.");
  });
  const sources = Effect.fn("CutoverReadiness.sources")(function* (cu: boolean) {
    const manifest = yield* readJson(
      path.join(config.baseDir, "harness-homes", "claude", "parity-manifest.json"),
    ).pipe(
      Effect.flatMap(decodeHomeManifest),
      Effect.mapError(() => "Generated homes source manifest is missing or invalid."),
    );
    if (REQUIRED_MCP.some((id) => !manifest.mcpServers.some((server) => server.id === id))) {
      return yield* Effect.fail(
        "Home manifest must include all seven required MCP servers, including recall.",
      );
    }
    const canonical = yield* sourceText(manifest.instructions.canonical.path);
    yield* verifyDigest(manifest.generator);
    const generatorFile = path.join(path.dirname(manifest.generator.path), "manifest.json");
    const generatorManifest = yield* sourceText(generatorFile).pipe(
      Effect.flatMap(decodeJson),
      Effect.flatMap(decodeGeneratorManifest),
      Effect.mapError(() => "Generator source manifest is missing or invalid."),
    );
    const declared = generatorManifest.instructions.canonical;
    const recall = generatorManifest.mcpServers.filter((server) => server.id === "recall");
    const recallUrl = recall[0]?.url;
    if (
      recall.length !== 1 ||
      !recallUrl ||
      recallUrl !== recallUrl.trim() ||
      !URL.canParse(recallUrl)
    ) {
      return yield* Effect.fail(
        "Generator manifest must define one valid recall URL for caller identity injection.",
      );
    }
    const endpoint = new URL(recallUrl);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    ) {
      return yield* Effect.fail(
        "Recall identity endpoint must be an HTTP(S) URL without credentials or fragment.",
      );
    }
    const actual = manifest.instructions.canonical.path;
    const userHome =
      declared.startsWith("~/") && actual.endsWith(declared.slice(1))
        ? actual.slice(0, -declared.length + 1)
        : null;
    const roots = generatorManifest.skillRoots.map((root) =>
      root.startsWith("~/") && userHome !== null ? `${userHome}${root.slice(1)}` : root,
    );
    if (declared !== actual && (userHome === null || `${userHome}${declared.slice(1)}` !== actual))
      return yield* Effect.fail("Canonical path does not match the generator source manifest.");
    const overlays = new Map<string, string>();
    const manifests = [];
    let codexOverlay: string | undefined;
    for (const home of HOMES.filter((home) => home.name !== "codex-cu" || cu)) {
      const parity =
        home.name === "claude"
          ? manifest
          : yield* readJson(
              path.join(config.baseDir, "harness-homes", home.name, "parity-manifest.json"),
            ).pipe(
              Effect.flatMap(decodeHomeManifest),
              Effect.mapError(() => "Generated parity manifest is missing or invalid."),
            );
      if (
        parity.harness !== home.name ||
        parity.instructions.canonical.path !== manifest.instructions.canonical.path ||
        REQUIRED_MCP.some((id) => !parity.mcpServers.some((server) => server.id === id)) ||
        parity.generator.path !== manifest.generator.path ||
        parity.generator.sha256 !== manifest.generator.sha256 ||
        parity.mcpServers.filter((server) => server.id === "recall").length !== 1 ||
        parity.mcpServers.find((server) => server.id === "recall")?.url !== recallUrl
      ) {
        return yield* Effect.fail(
          "Native parity manifests must share canonical instruction and skill sources.",
        );
      }
      const files = parity.instructions.overlays;
      if (files.length !== (home.name === "codex-cu" ? 2 : 1))
        return yield* Effect.fail("Native overlay source list is incomplete.");
      if (home.name === "codex") codexOverlay = files[0]!.path;
      if (home.name === "codex-cu" && files[0]!.path !== codexOverlay)
        return yield* Effect.fail("Codex CU must share the Codex overlay source.");
      overlays.set(home.name, yield* sourceText(files[files.length - 1]!.path));
      for (const source of [
        parity.instructions.canonical,
        ...files,
        ...parity.skills.map((skill) => ({
          path: path.join(skill.source, "SKILL.md"),
          sha256: skill.sha256,
        })),
        ...parity.guards.flatMap((guard) => guard.sources),
      ])
        yield* verifyDigest(source);
      if (
        ["live-database", "offbox", "betterstack-scope", "coord-haiku"].some(
          (id) => !parity.guards.some((guard) => guard.id === id),
        )
      )
        return yield* Effect.fail("Guard parity source categories are incomplete.");
      manifests.push(parity);
    }
    const skills = new Map<string, string>();
    const visited = new Set<string>();
    const pending = [...roots];
    while (pending.length) {
      const directory = pending.pop()!;
      if (!path.isAbsolute(directory)) return yield* Effect.fail("Skill roots must be absolute.");
      const real = yield* fs
        .realPath(directory)
        .pipe(Effect.mapError(() => "Canonical skill root cannot be resolved."));
      if (visited.has(real)) continue;
      visited.add(real);
      const names = yield* fs
        .readDirectory(directory)
        .pipe(Effect.mapError(() => "Canonical skill directory is unreadable."));
      if (names.includes("SKILL.md")) {
        const text = yield* sourceText(path.join(directory, "SKILL.md"));
        const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
        const name = (
          /^name:\s*(.*?)\s*$/m.exec(front ?? "")?.[1] ?? path.basename(directory)
        ).replace(/^(["'])(.*)\1$/, "$2");
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || skills.has(name))
          return yield* Effect.fail("Canonical skill names are invalid or collide.");
        skills.set(name, real);
      }
      for (const name of names) {
        const child = path.join(directory, name);
        const stat = yield* fs
          .stat(child)
          .pipe(Effect.mapError(() => "Canonical skill entry is unreadable."));
        if (stat.type === "Directory") pending.push(child);
      }
    }
    if (skills.size === 0) return yield* Effect.fail("Canonical skill roots contain no skills.");
    for (const parity of manifests) {
      if (parity.skills.length !== skills.size)
        return yield* Effect.fail("Parity manifest skill catalog differs from canonical roots.");
      const names = new Set<string>();
      for (const skill of parity.skills) {
        const target = yield* fs
          .realPath(skill.source)
          .pipe(Effect.mapError(() => "Parity skill source is missing."));
        if (names.has(skill.name) || target !== skills.get(skill.name))
          return yield* Effect.fail(
            "Parity manifest skill names/targets differ from canonical roots.",
          );
        names.add(skill.name);
      }
    }
    return { manifest, canonical, overlays, skills, recallUrl };
  });
  const sourceParity = Effect.fn("CutoverReadiness.sourceParity")(function* (
    home: (typeof HOMES)[number],
    source: Effect.Success<ReturnType<typeof sources>>,
  ) {
    const directory = path.join(config.baseDir, "harness-homes", home.name);
    const parity = yield* readJson(path.join(directory, "parity-manifest.json")).pipe(
      Effect.flatMap(decodeHomeManifest),
      Effect.mapError(() => "Generated parity manifest is missing or invalid."),
    );
    const required =
      home.name === "claude"
        ? ["settings.json", ".claude.json", "CLAUDE.md", "overlay.md"]
        : ["config.toml", "hooks.json", "AGENTS.md", "models.json"];
    const expectedPaths = new Set(required.map((file) => path.join(directory, file)));
    if (
      parity.artifacts.length !== expectedPaths.size ||
      new Set(parity.artifacts.map((artifact) => artifact.path)).size !== expectedPaths.size ||
      parity.artifacts.some((artifact) => !expectedPaths.has(artifact.path))
    ) {
      return yield* Effect.fail(
        "Parity artifact digests must cover every owned native home file exactly once.",
      );
    }
    for (const artifact of parity.artifacts) {
      // Runtime .claude.json counters/projects may change; generated MCP/onboarding fields may not.
      yield* verifyArtifact(artifact);
    }
    const farm = path.join(directory, "skills");
    const realDirectory = yield* fs
      .realPath(directory)
      .pipe(Effect.mapError(() => "Native home is missing."));
    const realFarm = yield* fs
      .realPath(farm)
      .pipe(Effect.mapError(() => "Native skill farm is missing."));
    if (realFarm !== path.join(realDirectory, "skills"))
      return yield* Effect.fail("Native skill farm must not be redirected.");
    const links = yield* fs
      .readDirectory(farm)
      .pipe(Effect.mapError(() => "Native skill farm is unreadable."));
    if (links.length !== source.skills.size || links.some((name) => !source.skills.has(name)))
      return yield* Effect.fail("Native skill names differ from canonical roots.");
    for (const name of links) {
      const link = path.join(farm, name);
      yield* fs
        .readLink(link)
        .pipe(Effect.mapError(() => "Every native skill must be a canonical symlink."));
      const target = yield* fs
        .realPath(link)
        .pipe(Effect.mapError(() => "Native skill symlink is broken."));
      if (target !== source.skills.get(name))
        return yield* Effect.fail("Native skill symlink points at the wrong source.");
    }
    if (home.name === "claude") {
      const expected = `@${source.manifest.instructions.canonical.path}\n@${path.join(directory, "overlay.md")}\n`;
      if (
        (yield* readText(path.join(directory, "CLAUDE.md"))) !== expected ||
        (yield* readText(path.join(directory, "overlay.md"))) !== source.overlays.get("claude")
      )
        return yield* Effect.fail("Claude instructions/overlay differ from canonical sources.");
    } else {
      const expected = `${source.canonical}\n\n${source.overlays.get("codex")}${home.name === "codex-cu" ? `\n\n${source.overlays.get("codex-cu")}` : ""}`;
      if ((yield* readText(path.join(directory, "AGENTS.md"))) !== expected)
        return yield* Effect.fail("Codex instructions/overlay differ from canonical sources.");
    }
  });

  const homeCheck = Effect.fn("CutoverReadiness.homeCheck")(
    function* (
      home: (typeof HOMES)[number],
      source: Effect.Success<ReturnType<typeof sources>> | null,
    ) {
      if (source === null)
        return yield* Effect.fail("Canonical homes source manifest did not pass.");
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
        if (REQUIRED_MCP.some((id) => !mcp.mcpServers[id]) || mcp.mcpServers["t3-code"]) {
          return yield* Effect.fail(
            "All seven MCP servers must be configured; T3 remains per-thread injected.",
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
          REQUIRED_MCP.some((id) => !owned.mcp_servers[id]) ||
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
      yield* sourceParity(home, source);
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
      const homesPassed =
        evidence.homesCheck.ok &&
        evidence.homesCheck.failures.length === 0 &&
        HOMES.filter((home) => home.name !== "codex-cu" || cu).every((home) =>
          evidence.homesCheck.homes.some(
            (entry) =>
              entry.harness === home.name &&
              entry.home === path.join(config.baseDir, "harness-homes", home.name) &&
              entry.parityManifestPath === path.join(entry.home, "parity-manifest.json"),
          ),
        );
      results.push(
        row(
          "homes-check-report",
          homesPassed,
          homesPassed
            ? "Generator check --json passed for the exact native homes."
            : "Operator evidence lacks a successful generator check --json report for these homes.",
        ),
      );
      for (const home of HOMES.filter((home) => home.name !== "codex-cu" || cu)) {
        for (const scope of ["ordinary", "board"] as const) {
          const inventories = evidence.tools.filter(
            (entry) => entry.instanceId === home.instanceId && entry.scope === scope,
          );
          const ready = inventories.some((entry) => {
            const names = new Set(
              entry.names.map((name) => name.replace(/^mcp__(?:t3-code|t3_code)__/, "")),
            );
            return REQUIRED_TOOLS.every((name) => names.has(name));
          });
          results.push(
            row(
              `tools:${home.instanceId}:${scope}`,
              ready,
              ready
                ? "Native test session exposed the required T3/board tools."
                : "Native test-session tool inventory is missing required T3/board tools.",
            ),
          );
        }
      }
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
    const budget = yield* Config.Int("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP").pipe(
      Config.withDefault(DEFAULT_HANDOFF_TOKEN_CAP),
      Effect.catch(() => Effect.succeed(null)),
    );
    const supported = budget !== null && budget >= 1_024 && budget <= 64_000;
    results.push(
      row(
        "handoff-budget",
        supported,
        supported
          ? `Native handoff cap is ${budget} bytes (48,000 recommended; setting is unchanged).`
          : "T3CODE_CONTEXT_HANDOFF_TOKEN_CAP must be an integer from 1,024 to 64,000 bytes.",
      ),
    );
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
    const source = yield* sources(cu).pipe(
      Effect.catch((reason) => {
        results.push(row("home-sources", false, reason));
        return Effect.succeed(null);
      }),
    );
    for (const home of homes) results.push(yield* homeCheck(home, source));
    results.push(...(yield* evidenceCheck(targets, cu)));
    const current = yield* settings.getSettings.pipe(Effect.catch(() => Effect.succeed(null)));
    if (current === null)
      return [...results, row("settings", false, "Cannot read server settings.")];
    const providers = yield* registry.getProviders;
    for (const home of homes) {
      const instance = current.providerInstances[ProviderInstanceId.make(home.instanceId)];
      const recallEntries =
        instance?.environment?.filter((entry) => entry.name === "ROBOB_RECALL_MCP_URL") ?? [];
      const recallReady =
        source !== null &&
        recallEntries.length === 1 &&
        recallEntries[0]!.valueRedacted !== true &&
        recallEntries[0]!.value === source.recallUrl;
      results.push(
        row(
          `recall-identity:${home.instanceId}`,
          recallReady,
          recallReady
            ? "Explicit instance recall URL matches the shared generated caller-identity endpoint."
            : "Configure exactly one non-redacted ROBOB_RECALL_MCP_URL matching the shared generated recall URL; host environment is not accepted.",
        ),
      );
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
