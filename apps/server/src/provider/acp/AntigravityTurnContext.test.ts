import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import {
  antigravityHarnessHome,
  antigravityInstructionsBlock,
  antigravityTurnContextPath,
  linkAntigravityHarnessConfig,
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
      assert.deepEqual(first, {
        blocks: [antigravityInstructionsBlock("Rule one."), "<recall>first</recall>"],
        firstPromptContextIncluded: true,
      });
      const later = yield* context(input({ firstPromptInSession: false }));
      assert.deepEqual(later.blocks, ["<recall>later</recall>"]);
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
      // No instructions file is configured, so there is nothing left to deliver.
      assert.deepEqual(yield* context(input()), { blocks: [], firstPromptContextIncluded: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the first-prompt context pending while the rules cannot be read", () =>
    Effect.gen(function* () {
      const { context } = yield* setup((dir) => ({
        schemaVersion: 1,
        instructionsFile: `${dir}/missing-rules.md`,
      }));
      assert.deepEqual(yield* context(input()), { blocks: [], firstPromptContextIncluded: false });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("yields nothing without a valid config", () =>
    Effect.gen(function* () {
      const none = { blocks: [], firstPromptContextIncluded: false };
      const { context } = yield* setup(() => ({ schemaVersion: 2 }));
      assert.deepEqual(yield* context(input()), none);
      const fileSystem = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const missing = makeAntigravityPromptContext({
        configPath: "/nonexistent/robob-turn-context.json",
        instanceId: "antigravity",
        fileSystem,
        spawner,
      });
      assert.deepEqual(yield* missing(input()), none);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("links a profile's MCP and hook config to the harness home before start", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agy-profile-links-" });
      const harnessHome = antigravityHarnessHome(path, dir);
      yield* fileSystem.makeDirectory(path.join(harnessHome, "config"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(harnessHome, "config", "hooks.json"), "{}");
      yield* fileSystem.writeFileString(path.join(harnessHome, "config", "mcp_config.json"), "{}");
      const fresh = path.join(dir, "profiles", "fresh");
      const stale = path.join(dir, "profiles", "stale");
      yield* fileSystem.makeDirectory(path.join(stale, "config"), { recursive: true });
      yield* fileSystem.symlink(
        path.join(dir, "elsewhere.json"),
        path.join(stale, "config", "hooks.json"),
      );
      yield* fileSystem.writeFileString(path.join(stale, "config", "mcp_config.json"), '{"own":1}');
      for (const profileDirectory of [fresh, stale]) {
        yield* linkAntigravityHarnessConfig({ fileSystem, path, profileDirectory, harnessHome });
      }
      const target = (name: string) => path.join(harnessHome, "config", name);
      assert.equal(
        yield* fileSystem.readLink(path.join(fresh, "config", "hooks.json")),
        target("hooks.json"),
      );
      assert.equal(
        yield* fileSystem.readLink(path.join(fresh, "config", "mcp_config.json")),
        target("mcp_config.json"),
      );
      assert.equal(
        yield* fileSystem.readLink(path.join(stale, "config", "hooks.json")),
        target("hooks.json"),
      );
      // A real file is the user's own: it stays.
      assert.equal(
        yield* fileSystem.readFileString(path.join(stale, "config", "mcp_config.json")),
        '{"own":1}',
      );
      // Nothing generated yet: nothing linked.
      const empty = path.join(dir, "profiles", "empty");
      yield* linkAntigravityHarnessConfig({
        fileSystem,
        path,
        profileDirectory: empty,
        harnessHome: path.join(dir, "no-home"),
      });
      assert.isFalse(yield* fileSystem.exists(path.join(empty, "config")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("concurrent starts never leave a profile without its hook link", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agy-profile-race-" });
      const harnessHome = antigravityHarnessHome(path, dir);
      yield* fileSystem.makeDirectory(path.join(harnessHome, "config"), { recursive: true });
      for (const name of ["hooks.json", "mcp_config.json"]) {
        yield* fileSystem.writeFileString(path.join(harnessHome, "config", name), "{}");
      }
      const profileDirectory = path.join(dir, "profile");
      const hooks = path.join(profileDirectory, "config", "hooks.json");
      yield* fileSystem.makeDirectory(path.dirname(hooks), { recursive: true });
      let gaps = 0;
      for (let round = 0; round < 5; round += 1) {
        yield* fileSystem.remove(hooks).pipe(Effect.ignore);
        yield* fileSystem.symlink(path.join(dir, `stale-${round}.json`), hooks);
        const starts = Array.from({ length: 8 }, () =>
          linkAntigravityHarnessConfig({ fileSystem, path, profileDirectory, harnessHome }),
        );
        const probe = Effect.gen(function* () {
          for (let i = 0; i < 50; i += 1) {
            const present = yield* fileSystem.readLink(hooks).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (!present) gaps += 1;
            yield* Effect.yieldNow;
          }
        });
        yield* Effect.all([...starts, probe], { concurrency: "unbounded" });
        assert.equal(
          yield* fileSystem.readLink(hooks),
          path.join(harnessHome, "config", "hooks.json"),
        );
      }
      assert.equal(gaps, 0);
      const leftovers = (yield* fileSystem.readDirectory(path.dirname(hooks))).filter((name) =>
        name.includes(".robob-"),
      );
      assert.deepEqual(leftovers, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
