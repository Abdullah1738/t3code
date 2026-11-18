import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import plugin, { classify, createGuardHook } from "../plugin/phone-adb-guard";

const source = resolve(import.meta.dir, "../../harness-hooks/src/phone_adb_guard.py");
const python = process.env.HARNESS_TEST_PYTHON ?? "/opt/homebrew/bin/python3";
const corpus: { command: string; deny: boolean }[] = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../harness-hooks/tests/phone_adb_cases.json"), "utf8"),
);
const roots: string[] = [];
const oldLockDir = process.env.PH_LOCK_DIR;
afterEach(() => {
  if (oldLockDir === undefined) delete process.env.PH_LOCK_DIR;
  else process.env.PH_LOCK_DIR = oldLockDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "phone-adb-plugin-"));
  roots.push(root);
  process.env.PH_LOCK_DIR = root;
  writeFileSync(join(root, "lease.json"), JSON.stringify({ owner: "holder", purpose: "release QA",
    acquired_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 120000).toISOString() }));
  return root;
}

test("shared corpus through OpenCode shell entry points", async () => {
  fixture();
  const verdicts = new Map<string, Awaited<ReturnType<typeof classify>>>();
  // Explicitly clear any host holder env; the corpus supplies its own tokens.
  const check = async (command: string) => {
    const cached = verdicts.get(command);
    if (cached) return cached;
    const result = spawnSync(python, [source], { input: JSON.stringify({ command }), encoding: "utf8",
      env: { ...process.env, PH_LEASE_OWNER: "", PHONE_HOLD_OWNER: "" } });
    expect(result.status).toBe(0);
    const verdict = JSON.parse(result.stdout);
    verdicts.set(command, verdict);
    return verdict;
  };
  const hook = createGuardHook("/checkout", check);
  for (const row of corpus) {
    for (const tool of ["shell", "bash", "Bash", "exec_command", "shell_command"]) {
      const event = { tool, input: { command: row.command, background: true } };
      await hook(event);
      if (row.deny) {
        expect(event.input.command).toStartWith("printf '%s\\n'");
        expect(event.input.background).toBe(false);
        expect(event.input.command).not.toContain(row.command);
        // Only execute the replacement refusal; never run corpus adb commands.
        const result = spawnSync("/bin/sh", ["-c", event.input.command], { encoding: "utf8" });
        expect(result.status).toBe(5);
        expect(result.stderr).toContain("Phone is held by holder (release QA)");
      } else expect(event.input.command).toBe(row.command);
    }
  }
}, 30000);

test("async classifier: hold privacy, corrupt lease, free phone and read-only", async () => {
  const root = fixture();
  const check = (command: string) => classify(command, source, python);
  const token = "private hold token 42";
  writeFileSync(join(root, "priority-hold"), token);
  const foreign = await check("adb shell svc wifi disable");
  expect(foreign.reason).toContain("an owner request");
  expect(JSON.stringify(foreign)).not.toContain(token);
  expect((await check(`PHONE_HOLD_OWNER='${token}' adb forward tcp:1 tcp:2`)).reason).toBeNull();
  expect((await check("adb shell dumpsys window")).matched).toBe(false);
  expect((await check("adb forward --list")).matched).toBe(false);
  rmSync(join(root, "priority-hold"));
  writeFileSync(join(root, "lease.json"), "{broken");
  const broken = await check("adb shell monkey -p com.android.chrome 1");
  expect(broken.reason).toBeNull();
  expect(broken.error).toBe("phone-lock-unavailable");
  rmSync(join(root, "lease.json"));
  expect((await check("adb forward tcp:1 tcp:2")).rule).toBe("phone-adb-forward-unleased");
});

test("registration, cmd shape, non-shell tools, classifier fail-open", async () => {
  const hooks = new Map<string, unknown>();
  await plugin.setup({ tool: { hook: async (name, fn) => { hooks.set(name, fn); } } });
  expect(hooks.has("execute.before")).toBe(true);
  fixture();
  const hook = createGuardHook("/checkout", (command) => classify(command, source, python));
  const event = { tool: "shell", input: { cmd: "adb forward tcp:9333 localabstract:chrome_devtools_remote", description: "kept" } };
  await hook(event);
  expect(event.input.cmd).toContain("exit 5");
  expect(event.input.description).toBe("kept");
  const nonShell = { tool: "execute", input: { command: "adb shell input tap 1 1" } };
  await hook(nonShell);
  expect(nonShell.input.command).toBe("adb shell input tap 1 1");
  const brokenHook = createGuardHook("/checkout", async () => { throw new Error("private transport details"); });
  const original = { tool: "bash", input: { command: "adb shell input tap 1 1" } };
  await brokenHook(original);
  expect(original.input.command).toBe("adb shell input tap 1 1");
  await expect(classify("adb reboot", "/missing/phone-classifier.py", python)).rejects.toThrow("phone classifier unavailable");
});
