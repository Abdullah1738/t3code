import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KanbanBoardId, KanbanScriptId, type KanbanScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  BOARD_SCRIPT_BYTE_LIMIT,
  boardScriptDependencyProblem,
  checkBoardScripts,
} from "./BoardScriptReadiness.ts";

it.each([
  'subagent({agent: "crpko-reviewer"})',
  'import "lean-reviewer"',
  'subagent_type="security-reviewer"',
  'client.session.prompt({ agent: "custom-worker" })',
  "opencode run --agent reviewer",
  "cat ~/.config/opencode/agents/reviewer.md",
  "exec crw tick",
  "python3 /external/crpko-review-workflow/cli.py",
])("refuses a concrete unverified dependency: %s", (text) => {
  assert.isNotNull(boardScriptDependencyProblem(text));
});

it.each([
  'echo "Read the agent documentation before starting"',
  'client.session.prompt({model: {providerID: "openai", modelID: "gpt-6.1-sol"}})',
  't3ctl send thread-id "Continue the task"',
  'const agentDocumentation = "native agent instructions"',
])("does not mistake generic agent documentation for a named selector: %s", (text) => {
  assert.isNull(boardScriptDependencyProblem(text));
});

it.effect(
  "scans actual registered files read-only, including disabled, missing and oversized scripts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "board-script-scan-" });
        const script = (name: string, enabled = true): KanbanScript => ({
          id: KanbanScriptId.make(`script:${name}`),
          boardId: KanbanBoardId.make("board:fixture"),
          name,
          path: path.join(directory, `${name}.ts`),
          enabled,
          trigger: { _tag: "manual" },
          createdBy: { _tag: "owner" },
          createdAt: "2026-11-05T00:00:00Z",
          lastRun: null,
        });
        const clean = script("clean");
        const unsafe = script("disabled", false);
        const missing = script("missing");
        const oversized = script("oversized");
        yield* fs.writeFileString(clean.path, 'console.log("agent docs are not selectors")');
        const contents = 'subagent({ subagent_type: "unknown-reviewer" })';
        yield* fs.writeFileString(unsafe.path, contents);
        yield* fs.writeFileString(oversized.path, "x".repeat(BOARD_SCRIPT_BYTE_LIMIT + 1));
        const before = yield* fs.readDirectory(directory);
        const refusals = yield* checkBoardScripts([clean, unsafe, missing, oversized]);
        assert.lengthOf(refusals, 3);
        assert.include(refusals[0]!.reason, "unknown-reviewer");
        assert.include(refusals[0]!.reason, unsafe.path);
        assert.include(refusals[1]!.reason, "unreadable");
        assert.include(refusals[2]!.reason, "2 MiB");
        assert.equal(yield* fs.readFileString(unsafe.path), contents);
        assert.deepEqual(yield* fs.readDirectory(directory), before);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
