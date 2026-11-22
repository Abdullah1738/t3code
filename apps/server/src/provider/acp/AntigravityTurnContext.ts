/**
 * Turn context for Antigravity sessions.
 *
 * The Antigravity ACP runtime reads no global rules file and ignores context
 * from its own prompt hooks, so Robob supplies both around each turn from the
 * harness-homes generator's `robob-turn-context.json`:
 *
 * - `instructionsFile`: the standing rules (AGENTS.md plus the Antigravity
 *   overlay), sent once with the first prompt of each native session.
 * - `hooks.UserPromptSubmit`: Claude-compatible command hooks (recall). Each
 *   gets `{hook_event_name, session_id, prompt, cwd, first_prompt}` on stdin and
 *   may print `{hookSpecificOutput: {additionalContext}}`.
 *
 * A missing or broken file, a slow hook or bad output yields no context; a
 * turn is never delayed past the hook's own timeout or blocked.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import type { AcpPromptContextInput } from "@t3tools/provider-acp/server/adapter";

export const ANTIGRAVITY_TURN_CONTEXT_FILE = "robob-turn-context.json";
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
const MAX_HOOK_OUTPUT_BYTES = 256 * 1024;
const MAX_HOOK_TIMEOUT_MS = 15_000;
const DEFAULT_HOOK_TIMEOUT_MS = 3_000;

const TurnHook = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  timeoutMs: Schema.optional(Schema.Number),
});
const TurnContextConfig = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  instructionsFile: Schema.optional(Schema.String),
  hooks: Schema.optional(
    Schema.Struct({
      UserPromptSubmit: Schema.optional(Schema.Array(TurnHook)),
    }),
  ),
});
type TurnContextConfig = typeof TurnContextConfig.Type;
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(TurnContextConfig));
const HookOutput = Schema.Struct({
  hookSpecificOutput: Schema.optional(
    Schema.Struct({ additionalContext: Schema.optional(Schema.String) }),
  ),
});
const decodeHookOutput = Schema.decodeUnknownOption(Schema.fromJsonString(HookOutput));
const HookPayload = Schema.Struct({
  hook_event_name: Schema.Literal("UserPromptSubmit"),
  session_id: Schema.String,
  prompt: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  first_prompt: Schema.Boolean,
});
const encodeHookPayload = Schema.encodeSync(Schema.fromJsonString(HookPayload));

export function antigravityTurnContextPath(path: Path.Path, baseDir: string): string {
  return path.join(baseDir, "harness-homes", "antigravity", ANTIGRAVITY_TURN_CONTEXT_FILE);
}

export function antigravityInstructionsBlock(instructions: string): string {
  return `# AGENTS.md instructions (Robob standing rules for this session)\n\n${instructions.trim()}`;
}

/** The last stdout line that decodes as a hook result carries the context. */
export function parseHookContext(stdout: string): string | undefined {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const decoded = decodeHookOutput(lines[index]!);
    if (decoded._tag === "Some") {
      const text = decoded.value.hookSpecificOutput?.additionalContext;
      return text !== undefined && text.trim().length > 0 ? text : undefined;
    }
  }
  return undefined;
}

export interface AntigravityTurnContextOptions {
  readonly configPath: string;
  readonly instanceId: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly baseEnv?: NodeJS.ProcessEnv;
}

const readBounded = Effect.fn("AntigravityTurnContext.readBounded")(
  function* (fileSystem: FileSystem.FileSystem, file: string, maxBytes: number) {
    const info = yield* fileSystem.stat(file);
    if (info.type !== "File" || info.size > BigInt(maxBytes)) return undefined;
    return yield* fileSystem.readFileString(file);
  },
  Effect.orElseSucceed(() => undefined),
);

export function makeAntigravityPromptContext(options: AntigravityTurnContextOptions) {
  const loadConfig = readBounded(options.fileSystem, options.configPath, MAX_CONFIG_BYTES).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed<TurnContextConfig | undefined>(undefined)
        : decodeConfig(text).pipe(Effect.orElseSucceed(() => undefined)),
    ),
  );

  const runHook = Effect.fn("AntigravityTurnContext.runHook")(
    function* (hook: typeof TurnHook.Type, payload: string) {
      const timeoutMs = Math.min(
        Math.max(hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, 100),
        MAX_HOOK_TIMEOUT_MS,
      );
      const child = yield* options.spawner.spawn(
        ChildProcess.make(hook.command, [...(hook.args ?? [])], {
          stdin: Stream.make(new TextEncoder().encode(payload)),
          env: {
            ...(options.baseEnv ?? process.env),
            ROBOB_PROVIDER_INSTANCE_ID: options.instanceId,
            ROBOB_HARNESS: "antigravity",
          },
          extendEnv: false,
          shell: false,
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_HOOK_OUTPUT_BYTES }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: 4_096 }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout(Duration.millis(timeoutMs)));
      if (Number(exitCode) !== 0 || stdout.truncated) return undefined;
      return parseHookContext(stdout.text);
    },
    Effect.scoped,
    Effect.catchCause(() => Effect.succeed(undefined)),
  );

  return (input: AcpPromptContextInput): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      if (config === undefined) return [];
      const blocks: Array<string> = [];
      if (input.firstPromptInSession && config.instructionsFile !== undefined) {
        const instructions = yield* readBounded(
          options.fileSystem,
          config.instructionsFile,
          MAX_INSTRUCTIONS_BYTES,
        );
        if (instructions !== undefined && instructions.trim().length > 0) {
          blocks.push(antigravityInstructionsBlock(instructions));
        }
      }
      const payload = encodeHookPayload({
        hook_event_name: "UserPromptSubmit",
        session_id: input.nativeSessionId,
        prompt: input.text,
        cwd: input.cwd,
        first_prompt: input.firstPromptInSession,
      });
      const contexts = yield* Effect.all(
        (config.hooks?.UserPromptSubmit ?? []).map((hook) => runHook(hook, payload)),
        { concurrency: "unbounded" },
      );
      for (const context of contexts) {
        if (context !== undefined) blocks.push(context);
      }
      return blocks;
    }).pipe(Effect.catchCause(() => Effect.succeed([])));
}
