import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import plugin, { classify, createGuardHook, fallback, needsClassifier } from "../plugin/statev2-guard";
import { hook as toolLogHook } from "../lib/toollog";

const repo = resolve(import.meta.dir, "../../..");
const source = resolve(import.meta.dir, "../../harness-hooks/src/statev2_check.py");
const python = process.env.HARNESS_TEST_PYTHON ?? "/opt/homebrew/bin/python3";
const quiet: typeof toolLogHook = () => {};
const check = (command: string, cwd: string | null) => classify(command, cwd, source, python);

function shared(command: string, cwd: string) {
  const result = spawnSync(python, ["-c",
    "import json,sys;sys.path.insert(0,sys.argv[1]);from statev2_guard import classify_detail;e=json.load(sys.stdin);r,d=classify_detail(e['command'],e['cwd']);print(json.dumps({'rule':r,'detail':d}))",
    resolve(import.meta.dir, "../../harness-hooks/src")], {
    input: JSON.stringify({ command, cwd }), encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

const matrix = [
  ["sqlite3 ~/.robob/userdata/statev2.sqlite 'select 1'", "live-database-read"],
  ["sqlite3 ~/.local/share/opencode/opencode.db .tables", "live-database-read"],
  ["sqlite3 ~/.t3/userdata/state.sqlite .tables", "live-database-read"],
  ["grep -nE '\\.robob/userdata/statev2' somefile", null],
  ["python3 integrations/memory-system/tests/test_robob_readonly.py", undefined],
  ["python3 -m unittest integrations.memory-system.tests.test_robob_readonly", undefined],
  ["bun test integrations/spectrum-bridge/test/robob.test.ts", undefined],
  ["vp run migrate-dev-db --source /tmp/copy.sqlite --base-dir /tmp/dev-home", undefined],
  ["vp run migrate-dev-db", "live-database-read"],
  ["git rev-parse HEAD^{tree}", undefined],
  ["git log @{u}..HEAD", undefined],
  ["git stash show stash@{0}", undefined],
  ["env -S ''", "live-database-script-unresolved"],
] as const;

for (const [command, expectedRule] of matrix) test(`Python parity: ${command}`, async () => {
  const expected = shared(command, repo);
  if (expectedRule !== undefined) expect(expected.rule).toBe(expectedRule);
  expect(await check(command, repo)).toEqual(expected);
  const record = mock(quiet);
  const event = { tool: "shell", sessionID: "statev2-test", input: { command, workdir: repo, background: true } };
  await createGuardHook(repo, check, () => "enforce", record)(event);
  if (expected.rule) {
    expect(event.input.command).toContain("exit 3");
    expect(event.input.background).toBe(false);
    const refusal = spawnSync("/bin/sh", ["-c", event.input.command], { encoding: "utf8" });
    expect(refusal.status).toBe(3);
    expect(refusal.stderr).toContain("Why: " + expected.detail);
    expect(record.mock.calls[0]?.[2]).toBe(expected.rule);
  } else expect(event.input.command).toBe(command);
});

test("cd, Bun option values, preloads, globs and mkdtemp fixtures share Python decisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "statev2-parity-"));
  try {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub/probe.py"), "from pathlib import Path\n(Path.home() / '.robob/userdata/statev2.sqlite').read_bytes()");
    writeFileSync(join(root, "sub/probe.mjs"), "require('fs').readFileSync(process.env.HOME + '/.robob/userdata/statev2.sqlite')");
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "test/robob.test.ts"),
      "import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\nimport { tmpdir } from 'node:os';\n" +
      "const root = mkdtempSync(join(tmpdir(), 'robob-'));\n" +
      "mkdirSync(join(root, '.robob/userdata'), { recursive: true });\n" +
      "writeFileSync(join(root, '.robob/userdata/statev2.sqlite'), 'fixture');\n");
    for (const command of [
      "cd sub; python3 probe.py",
      "bun test -t 'matches anything' --reporter-outfile /tmp/report.xml test/robob.test.ts",
      "bun test test/robob.test.ts",
      "bun --preload ./sub/probe.mjs test test/robob.test.ts",
      "node --test sub/*.mjs",
    ]) {
      const expected = shared(command, root);
      expect(needsClassifier(command)).toBe(true);
      expect(await check(command, root)).toEqual(expected);
      const event = { tool: "bash", input: { command, cwd: root } };
      await createGuardHook(null, check, () => "enforce", quiet)(event);
      expect(event.input.command === command).toBe(expected.rule === null);
    }
  } finally { rmSync(root, { recursive: true }); }
});

test("ls and git status never invoke the subprocess classifier", async () => {
  const subprocess = mock(check);
  const hook = createGuardHook(repo, subprocess, () => "enforce", quiet);
  for (const command of ["ls", "git status"]) {
    expect(needsClassifier(command)).toBe(false);
    const event = { tool: "shell", input: { command } };
    await hook(event);
    expect(event.input.command).toBe(command);
  }
  expect(subprocess).not.toHaveBeenCalled();
});

test("extensionless sourced scripts reach Python across sourcing input forms", async () => {
  const root = mkdtempSync(join(tmpdir(), "statev2-source-"));
  try {
    writeFileSync(join(root, "probe"), "cat ~/.robob/userdata/statev2.sqlite\n");
    for (const prefix of ["source", ".", "builtin source", "builtin .", "command source", "command .",
      "source --", ". --", "X=1 source", "X=1 ."]) {
      for (const separator of [" ", "\t", "\n"]) {
        const command = prefix + separator + "probe";
        const expected = shared(command, root);
        expect(needsClassifier(command)).toBe(true);
        expect(await check(command, root)).toEqual(expected);
        const event = { tool: "shell", input: { command } };
        await createGuardHook(root, check, () => "enforce", quiet)(event);
        expect(event.input.command === command).toBe(expected.rule === null);
        if (separator !== "\n" && (prefix === "source" || prefix === ".")) {
          expect(expected.rule).toBe("live-database-script");
        }
      }
    }
  } finally { rmSync(root, { recursive: true }); }
}, 15_000);

test("the prefilter selects the fresh corpus of Python-denied commands without a subprocess", () => {
  const fixture: { sourceHashes: Record<string, string>; commands: string[] } = JSON.parse(
    readFileSync(resolve(import.meta.dir, "fixtures/statev2-denied-commands.json"), "utf8"));
  expect(Object.keys(fixture.sourceHashes).sort()).toEqual([
    "integrations/harness-hooks/src/statev2_guard.py",
    "integrations/harness-hooks/tests/test_statev2_guard.py",
  ]);
  for (const [source, hash] of Object.entries(fixture.sourceHashes)) {
    expect(createHash("sha256").update(readFileSync(resolve(repo, source))).digest("hex")).toBe(hash);
  }
  expect(fixture.commands.length).toBeGreaterThan(100);
  expect(fixture.commands.filter(command => !needsClassifier(command))).toEqual([]);
});

test("fallback retains every original reader and script check", () => {
  for (const path of ["~/.robob/userdata/statev2.sqlite", "/disk/robob-data/userdata/statev2.sqlite", "~/.robob/userdata/*.sqlite",
    "~/.local/share/opencode/opencode.db", "~/.t3/userdata/state.sqlite"]) {
    for (const reader of ["sqlite", "sqlite3", "python3", "node", "bun", "deno", "duckdb", "litecli",
      "datasette", "uv", "cp", "rsync", "ditto", "dd", "cat", "strings", "grep", "rg", "xxd", "hexdump", "tar", "zip", "restic"]) {
      const command = reader + " " + path;
      expect(needsClassifier(command)).toBe(true);
      expect(fallback(command, repo).rule).toBe("live-database-read");
    }
    expect(fallback("ls " + path, repo).rule).toBeNull();
  }
  const root = mkdtempSync(join(tmpdir(), "statev2-fallback-"));
  try {
    writeFileSync(join(root, "read.py"), "open('/Users/x/.robob/userdata/statev2.sqlite')");
    for (const command of ["python3 read.py", "./read.py", "bash read.py", "uv run python read.py"]) {
      expect(fallback(command, root).rule).toBe("live-database-read");
    }
  } finally { rmSync(root, { recursive: true }); }
});

test("missing wrapper and interpreter fall back and log attribution", async () => {
  for (const [script, executable] of [[source + ".missing", python], [source, python + ".missing"]]) {
    const record = mock(quiet);
    const hook = createGuardHook(repo, (command, cwd) => classify(command, cwd, script, executable), () => "enforce", record);
    const event = { tool: "shell", sessionID: "fallback-session", input: { command: "sqlite3 ~/.local/share/opencode/opencode.db .tables" } };
    await hook(event);
    expect(event.input.command).toContain("exit 3");
    expect(record.mock.calls[0]?.slice(0, 3)).toEqual(["statev2", "denied", "live-database-read"]);
    expect(record.mock.calls[0]?.[5]).toBe("classifier.fallback");
    expect(record.mock.calls[0]?.[6]).toEqual({ sessionId: "fallback-session" });
  }
});

test("2s timeout, nonzero exit and invalid verdicts use the fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "statev2-transport-"));
  const script = join(root, "classifier.py");
  try {
    for (const body of ["import time;time.sleep(60)", "raise SystemExit(1)", "print('bad json')", "print('{}')", "print('[]')",
      `print('{"rule":false,"detail":null}')`, `print('{"rule":null}')`]) {
      writeFileSync(script, body);
      const record = mock(quiet);
      const event = { tool: "bash", input: { command: "sqlite3 ~/.t3/userdata/statev2.sqlite .tables" } };
      const start = performance.now();
      await createGuardHook(repo, (command, cwd) => classify(command, cwd, script, python), () => "enforce", record)(event);
      if (body.includes("sleep")) {
        expect(performance.now() - start).toBeGreaterThanOrEqual(1900);
        expect(performance.now() - start).toBeLessThan(4000);
      }
      expect(event.input.command).toContain("exit 3");
      expect(record.mock.calls[0]?.[5]).toBe("classifier.fallback");
    }
  } finally { rmSync(root, { recursive: true }); }
}, 10_000);

test("off/audit modes, registration and non-shell events keep their behavior", async () => {
  let registered = "";
  await plugin.setup({ location: { directory: repo }, tool: { hook: async name => { registered = name; } } });
  expect(registered).toBe("execute.before");
  const deny = mock(async () => ({ rule: "live-database-script", detail: "Python detail" }));
  const command = "python3 read.py";
  const off = { tool: "shell", input: { command } };
  await createGuardHook(repo, deny, () => "off", quiet)(off);
  const nonShell = { tool: "read", input: { command } };
  await createGuardHook(repo, deny, () => "enforce", quiet)(nonShell);
  expect(deny).not.toHaveBeenCalled();
  const record = mock(quiet);
  const audit = { tool: "shell", input: { command } };
  await createGuardHook(repo, deny, () => "audit", record)(audit);
  expect(audit.input.command).toBe(command);
  expect(record.mock.calls[0]?.slice(0, 3)).toEqual(["statev2", "allowed", "live-database-script"]);
});
