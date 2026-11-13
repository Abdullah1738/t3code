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
  'exec("crw tick")',
  'subprocess.run(["crw", "tick"])',
  "node /Volumes/x/crw.mjs tick",
  "crw review PR-1",
  "if true; then\n    crw tick\nfi",
  'subprocess.Popen(["crw", "tick"])',
  'subprocess.check_call(["crw", "tick"])',
  'await asyncio.create_subprocess_exec("crw", "tick")',
  'execFileSync("crw", ["tick"])',
  'await execa("crw", ["tick"])',
  "await $`crw tick`",
  'bash -lc "crw tick"',
  "timeout 60 crw tick",
  "nohup crw tick &",
  "/usr/bin/env crw tick",
  'cmd = ["crw", "tick"]; subprocess.run(cmd)',
  "zsh ~/.local/share/crw/tick.zsh",
  "launchctl kickstart -k gui/501/com.crpko.review-workflow",
  "out=$(crw status)",
])("refuses a concrete unverified dependency: %s", (text) => {
  assert.isNotNull(boardScriptDependencyProblem(text));
});

it.each([
  'echo "Read the agent documentation before starting"',
  'client.session.prompt({model: {providerID: "openai", modelID: "gpt-6.1-sol"}})',
  't3ctl send thread-id "Continue the task"',
  'const agentDocumentation = "native agent instructions"',
  '"""External PR cards (replaces the crw review loop)."""',
  '"""crw linkedIssues: which linked tickets decide readiness."""',
  "q = \"sqlite3 -json 'file:/Volumes/x/crpko-review-workflow/data/crw.db?immutable=1'\"",
  'CRW_HOLD = re.compile(r"(?m)^FAIL\\s+crw hold\\b.*$")',
  "For PR review asks, check crw state first (crpko-review-workflow skill).",
  "node /Volumes/ExternalSSD/crpko-review-workflow/reader.mjs pr Equicom-Crypto/x 1",
  "(crw review loop is retired)",
  "Do not call crw anymore",
  "never run crw tick here",
  "crw rules apply to external PRs only.",
  "| crw state | retired |",
  "See crpko-review-workflow/lib/review.mjs for the old prompt.",
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
