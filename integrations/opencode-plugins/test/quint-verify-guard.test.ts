import { afterAll, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import plugin, { classify, createGuardHook } from "../plugin/quint-verify-guard";

const suiteLogs = mkdtempSync(join(tmpdir(), "quint-guard-suite-"));
const originalLogRoot = process.env.TOOLLOG_ROOT;
process.env.TOOLLOG_ROOT = suiteLogs;
afterAll(() => {
  if (originalLogRoot === undefined) delete process.env.TOOLLOG_ROOT; else process.env.TOOLLOG_ROOT = originalLogRoot;
  rmSync(suiteLogs, { recursive: true });
});

const source = resolve(import.meta.dir, "../../harness-hooks/src/quint_verify_guard.py");
const fixture = join(suiteLogs, "fixture");
mkdirSync(join(fixture, "hook"), { recursive: true });
for (const directory of ["project", "project/node_modules/.bin", "project/sub", "project/sub/node_modules/.bin"]) {
  const executable = join(fixture, directory, "quint");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}
const cases: { command: string; denied: boolean; cwd?: string; approved?: string }[] = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../../harness-hooks/tests/quint_verify_cases.json"), "utf8").replaceAll("{{fixture}}", fixture));

test("OpenCode uses the shared matcher table and runs only refusal commands", async () => {
  const logs = mkdtempSync(join(tmpdir(), "quint-guard-logs-"));
  const before = process.env.TOOLLOG_ROOT;
  process.env.TOOLLOG_ROOT = logs;
  try {
    for (const row of cases) {
      const hook = createGuardHook("/repo", async (command, cwd) => {
        const result = spawnSync(process.env.HARNESS_TEST_PYTHON ?? "/opt/homebrew/bin/python3", [source], {
          input: JSON.stringify({ command, cwd, approved: row.approved ?? "" }), encoding: "utf8",
          cwd: join(fixture, "hook"),
        });
        expect(result.status).toBe(0);
        return JSON.parse(result.stdout);
      });
      const event = { tool: "shell", input: { command: row.command, cwd: row.cwd, background: true } };
      await hook(event);
      if (row.denied) {
        expect(event.input.command).toStartWith("printf '%s\\n'");
        expect(event.input.background).toBe(false);
        const refused = spawnSync("/bin/sh", ["-c", event.input.command], { encoding: "utf8" });
        expect(refused.status).toBe(3);
        expect(refused.stderr).toContain("/Users/ardud/.local/bin/quint");
      } else expect(event.input.command).toBe(row.command);
    }
  } finally {
    if (before === undefined) delete process.env.TOOLLOG_ROOT; else process.env.TOOLLOG_ROOT = before;
    rmSync(logs, { recursive: true });
  }
}, 60_000);

test("registration, shell shapes and async classifier transport", async () => {
  const hooks = new Map<string, unknown>();
  await plugin.setup({ tool: { hook: async (name, fn) => { hooks.set(name, fn); } } });
  expect(hooks.has("execute.before")).toBe(true);
  for (const tool of ["shell", "bash", "Bash", "exec_command", "shell_command"]) {
    const event = { tool, input: { cmd: "npx quint verify", cwd: "/repo", description: "kept" } };
    await createGuardHook("/repo", (command, cwd) => classify(command, cwd, source, process.env.HARNESS_TEST_PYTHON))(event);
    expect(event.input.cmd).toContain("exit 3");
    expect(event.input.description).toBe("kept");
  }
  expect((await classify("npx quint typecheck model.qnt", "/repo", source, process.env.HARNESS_TEST_PYTHON)).denied).toBe(false);
  const event = { tool: "read", input: { command: "npx quint verify" } };
  await createGuardHook("/repo")(event);
  expect(event.input.command).toBe("npx quint verify");
});
