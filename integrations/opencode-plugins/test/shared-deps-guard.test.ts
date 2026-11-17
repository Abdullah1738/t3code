import { afterAll, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import plugin, { classify, createGuardHook } from "../plugin/shared-deps-guard";

const temporary = mkdtempSync(join(tmpdir(), "shared-deps-plugin-"));
const before = process.env.TOOLLOG_ROOT;
process.env.TOOLLOG_ROOT = temporary;
afterAll(() => {
  if (before === undefined) delete process.env.TOOLLOG_ROOT;
  else process.env.TOOLLOG_ROOT = before;
  rmSync(temporary, { recursive: true });
});
const root = join(temporary, "work tree");
const store = join(temporary, "main/node_modules");
mkdirSync(root);
mkdirSync(store, { recursive: true });
symlinkSync(store, join(root, "node_modules"));
const source = resolve(import.meta.dir, "../../harness-hooks/src/shared_deps_guard.py");
const python = process.env.HARNESS_TEST_PYTHON ?? "python3";
const check = (command: string, cwd: string) => classify(command, cwd, source, python);

test("OpenCode refuses the same shared-store commands before shell execution", async () => {
  const cases: { command: string; denied: boolean }[] = JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../../harness-hooks/tests/shared_deps_cases.json"),
      "utf8",
    ),
  );
  for (const { command, denied } of cases) {
    for (const tool of ["shell", "bash", "Bash", "exec_command", "shell_command"]) {
      const event = { tool, input: { cmd: command, cwd: root, background: true } };
      await createGuardHook(root, check)(event);
      if (!denied) {
        expect(event.input.cmd).toBe(command);
        continue;
      }
      const result = spawnSync("/bin/sh", ["-c", event.input.cmd], { encoding: "utf8" });
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("shared dependencies");
      expect(result.stderr).toContain("offbox run -- pnpm install");
      expect(event.input.background).toBe(false);
    }
  }
  for (const command of [
    "vp fmt --check a.ts",
    "vp lint a.ts",
    "pnpm --version",
    "offbox run -- pnpm install",
  ]) {
    const event = { tool: "shell", input: { command, cwd: root } };
    await createGuardHook(root, check)(event);
    expect(event.input.command).toBe(command);
  }
}, 60_000);

test("registers execute.before and leaves unrelated tools alone", async () => {
  const hooks = new Map<string, unknown>();
  await plugin.setup({
    tool: {
      hook: async (name, fn) => {
        hooks.set(name, fn);
      },
    },
  });
  expect(hooks.has("execute.before")).toBe(true);
  const event = { tool: "read", input: { command: "pnpm install" } };
  await createGuardHook(root, check)(event);
  expect(event.input.command).toBe("pnpm install");
});
