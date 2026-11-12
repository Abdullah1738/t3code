import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import plugin, { classify, createGuardHook } from "../plugin/rootwide-search-guard";

const source = resolve(import.meta.dir, "../../harness-hooks/src/rootwide_search_guard.py");
const cases: { command: string; cwd: string; root: string | null; approved?: string }[] = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../harness-hooks/tests/rootwide_search_cases.json"), "utf8"),
);

for (const row of cases) test(`shared corpus: ${row.command} [${row.cwd}]`, async () => {
  const check = async (command: string, cwd: string) => {
    const result = spawnSync("/opt/homebrew/bin/python3", [source], {
      input: JSON.stringify({ command, cwd, approved: row.approved ?? "" }), encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  };
  const hook = createGuardHook("/tmp", check);
  for (const tool of ["shell", "bash", "exec_command"]) {
    const event = { tool, input: { command: row.command, workdir: row.cwd, background: true } };
    await hook(event);
    if (row.root) {
      expect(event.input.command).toStartWith("printf '%s\\n'");
      expect(event.input.command).toContain(row.root);
      expect(event.input.background).toBe(false);
      // Execute only the refusal, never the corpus's original search command.
      const refused = spawnSync("/bin/sh", ["-c", event.input.command], { encoding: "utf8" });
      expect(refused.status).toBe(3);
      expect(refused.stderr).toContain("Refused: recursive search over " + row.root);
    } else expect(event.input.command).toBe(row.command);
  }
});

test("registration, cwd fallback, cmd shape and non-shell text", async () => {
  const hooks = new Map<string, unknown>();
  await plugin.setup({ location: { directory: "/tmp" }, tool: { hook: async (name, fn) => { hooks.set(name, fn); } } });
  expect(hooks.has("execute.before")).toBe(true);
  const seen: string[] = [];
  const hook = createGuardHook("/checkout", async (_command, cwd) => { seen.push(cwd); return { root: "/", reason: "Refused: owner's root" }; });
  const event = { tool: "bash", input: { cmd: "rg --files /", description: "kept" } };
  await hook(event);
  expect(seen).toEqual(["/checkout"]);
  expect(event.input.cmd).toContain('exit 3');
  expect(event.input.description).toBe("kept");
  const text = { tool: "execute", input: { command: "rg --files /" } };
  await hook(text);
  expect(text.input.command).toBe("rg --files /");
});


test("async Python transport returns refusals and allowed verdicts", async () => {
  expect((await classify("rg --files /Users/ardud/checkouts", "/tmp", source)).root).toBe("/Users/ardud/checkouts");
  expect((await classify("rg foo /Users/ardud/checkouts/task-1", "/tmp", source)).root).toBeNull();
});

test("a classifier error does not turn non-search commands into refusals", async () => {
  const hook = createGuardHook("/tmp", async () => { throw new Error("missing classifier"); });
  const event = { tool: "shell", input: { command: "echo ok" } };
  await hook(event);
  expect(event.input.command).toBe("echo ok");
});
