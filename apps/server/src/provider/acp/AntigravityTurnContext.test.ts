import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import {
  antigravityInstructionsBlock,
  antigravityTurnContextPath,
  makeAntigravityPromptContext,
  parseHookContext,
} from "./AntigravityTurnContext.ts";

const input = (overrides: Partial<{ firstPromptInSession: boolean; text: string }> = {}) => ({
  threadId: ThreadId.make("thread-1"),
  nativeSessionId: "session-1",
  cwd: "/tmp",
  text: overrides.text ?? "what did we decide last time?",
  firstPromptInSession: overrides.firstPromptInSession ?? true,
});

const setup = Effect.fn("setup")(function* (config: (dir: string) => unknown) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agy-turn-context-" });
  const configPath = antigravityTurnContextPath(path, dir);
  yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
  yield* fileSystem.writeFileString(path.join(dir, "rules.md"), "Rule one.\n");
  yield* fileSystem.writeFileString(configPath, JSON.stringify(config(dir)));
  return {
    dir,
    context: makeAntigravityPromptContext({
      configPath,
      instanceId: "antigravity",
      fileSystem,
      spawner,
    }),
  };
});

const echoHook = (script: string, timeoutMs = 3_000) => ({
  command: "/bin/sh",
  args: ["-c", script],
  timeoutMs,
});

describe("Antigravity turn context", () => {
  it("parses the last hook result line", () => {
    assert.equal(
      parseHookContext(
        'noise\n{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<recall>\\nnote\\n</recall>"}}\n',
      ),
      "<recall>\nnote\n</recall>",
    );
    assert.isUndefined(parseHookContext(""));
    assert.isUndefined(parseHookContext("not json"));
    assert.isUndefined(parseHookContext('{"hookSpecificOutput":{"additionalContext":"  "}}'));
  });

  it.effect("sends the rules only on the first prompt and hook context on every prompt", () =>
    Effect.gen(function* () {
      const { context } = yield* setup((dir) => ({
        schemaVersion: 1,
        instructionsFile: `${dir}/rules.md`,
        hooks: {
          UserPromptSubmit: [
            echoHook(
              // The hook reads its stdin payload, as the recall hook does.
              'payload=$(cat); case "$payload" in *\'"first_prompt":true\'*) f=first;; *) f=later;; esac; ' +
                'printf \'{"hookSpecificOutput":{"additionalContext":"<recall>%s</recall>"}}\\n\' "$f"',
            ),
          ],
        },
      }));
      const first = yield* context(input());
      assert.deepEqual(first, [antigravityInstructionsBlock("Rule one."), "<recall>first</recall>"]);
      const later = yield* context(input({ firstPromptInSession: false }));
      assert.deepEqual(later, ["<recall>later</recall>"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("drops failing, slow and malformed hooks without failing the turn", () =>
    Effect.gen(function* () {
      const { context } = yield* setup(() => ({
        schemaVersion: 1,
        hooks: {
          UserPromptSubmit: [
            echoHook("cat >/dev/null; exit 3"),
            echoHook("cat >/dev/null; sleep 5", 200),
            echoHook("cat >/dev/null; echo not-json"),
            { command: "/nonexistent/hook" },
          ],
        },
      }));
      assert.deepEqual(yield* context(input()), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("yields nothing without a valid config", () =>
    Effect.gen(function* () {
      const { context } = yield* setup(() => ({ schemaVersion: 2 }));
      assert.deepEqual(yield* context(input()), []);
      const fileSystem = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const missing = makeAntigravityPromptContext({
        configPath: "/nonexistent/robob-turn-context.json",
        instanceId: "antigravity",
        fileSystem,
        spawner,
      });
      assert.deepEqual(yield* missing(input()), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
