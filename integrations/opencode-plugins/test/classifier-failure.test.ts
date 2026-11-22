import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cmdKind } from "../lib/toollog";
import { runClassifier } from "../lib/classifier";
import * as rootwide from "../plugin/rootwide-search-guard";
import * as shared from "../plugin/shared-deps-guard";
import * as phone from "../plugin/phone-adb-guard";
import * as statev2 from "../plugin/statev2-guard";

const temp = mkdtempSync(join(tmpdir(), "classifier-failure-"));
process.env.TOOLLOG_ROOT = join(temp, "logs");
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const python = process.env.HARNESS_TEST_PYTHON ?? "/opt/homebrew/bin/python3";
const logFile = () => join(temp, "logs/agent-tools", new Date().toISOString().slice(0, 10) + ".ndjson");
const rows = () => readFileSync(logFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const script = (name: string, body: string) => { const path = join(temp, name); writeFileSync(path, body); return path; };
const secret = "fixture-secret-token-9f3";
const command = `cd /Volumes/ExternalSSD/repo && git log --format=${secret}`;
const messages = { timeout: "fixture classifier timed out", unavailable: "fixture classifier unavailable" };

const failures: [string, () => Promise<unknown>, string, string][] = [
  ["timeout", () => runClassifier(python, script("slow.py", "import time; time.sleep(5)"), {}, messages), "timeout", messages.timeout],
  ["non-zero exit", () => runClassifier(python, script("exit.py", "raise SystemExit(7)"), {}, messages), "exit:7", messages.unavailable],
  ["not JSON", () => runClassifier(python, script("text.py", `print("${secret}")`), {}, messages), "parse", messages.unavailable],
  ["missing interpreter", () => runClassifier(join(temp, "no-python"), "x.py", {}, messages), "spawn:ENOENT", messages.unavailable],
  ["output limit", () => runClassifier(python, script("big.py", "print('x' * 9000)"), {}, { ...messages, outputLimit: 4096 }), "output-limit", messages.unavailable],
  ["injected error", () => Promise.reject(new TypeError(secret)), "TypeError", "unclassified"],
];

for (const [label, guard, classifier, failMode] of [
  ["rootwide-search", rootwide, "rootwide_search_guard", "open"],
  ["shared-dependencies", shared, "shared_deps_guard", "open"],
  ["phone-adb", phone, "phone_adb_guard", "open"],
  ["statev2", statev2, "statev2_check", "fallback"],
] as const) {
  test(`${label}: classifier_failed rows say which classifier failed, how, and how long each phase took`, async () => {
    for (const [name, check, errorClass, errorMessage] of failures) {
      const hook = label === "statev2" ? statev2.createGuardHook("/checkout", check as never, () => "enforce")
        : guard.createGuardHook("/checkout", check as never);
      const event = { tool: "bash", sessionID: "fixture-session", input: { command } };
      await hook(event);
      expect(event.input.command).toBe(command);
      const row = rows().at(-1);
      expect(row.error.tag).toBe("hook.classifier_failed");
      expect(row.props.guard).toBe(label);
      expect(row.props).toMatchObject({ errorClass, errorMessage, failMode, cmdKind: "git", source: "test", classifier });
      expect(row.props.totalMs).toBeGreaterThanOrEqual(0);
      if (errorMessage !== "unclassified") {
        expect(row.props.spawnMs).toBeGreaterThanOrEqual(0);
        expect(row.props.classifyMs).toBeGreaterThanOrEqual(name === "timeout" ? 1990 : 0);
      }
    }
    const log = readFileSync(logFile(), "utf8");
    expect(log).not.toContain(secret);
    expect(log).not.toContain("/Volumes/ExternalSSD/repo");
  }, 30000);
}

test("statev2 classifier failures log the fallback decision and keep database reads blocked", async () => {
  for (const [, check, errorClass, errorMessage] of failures) {
    const event = { tool: "bash", sessionID: "fallback-session", input: { command: "sqlite3 ~/.local/share/opencode/opencode.db .tables" } };
    await statev2.createGuardHook("/checkout", check as never, () => "enforce")(event);
    expect(event.input.command).toContain("exit 3");
    const row = rows().at(-1);
    expect(row.error.tag).toBe("hook.classifier_failed");
    expect(row.ids.sessionId).toBe("fallback-session");
    expect(row.props).toMatchObject({ guard: "statev2", classifier: "statev2_check", failMode: "fallback",
      decision: "denied", rule: "live-database-read", cmdKind: "sqlite3", source: "test", errorClass, errorMessage });
  }
}, 30000);

test("phone-adb decision rows carry holder, adbVerb and source", async () => {
  const hook = phone.createGuardHook("/checkout", async () => ({ matched: true, reason: "held", rule: "phone-adb-state", error: null, holder: "other", adbVerb: "shell" }));
  await hook({ tool: "bash", input: { command: "adb shell input tap 1 1" } });
  expect(rows().at(-1).props).toMatchObject({ rule: "phone-adb-state", holder: "other", adbVerb: "shell", source: "test" });
  const lockDir = mkdtempSync(join(temp, "lock-"));
  process.env.PH_LOCK_DIR = lockDir;
  writeFileSync(join(lockDir, "priority-hold"), "");
  const real = phone.createGuardHook("/checkout", (c) => phone.classify(c, resolve(import.meta.dir, "../../harness-hooks/src/phone_adb_guard.py"), python));
  await real({ tool: "bash", input: { command: "adb -s EV214-NOSUCH forward tcp:1 tcp:2" } });
  delete process.env.PH_LOCK_DIR;
  expect(rows().at(-1).props).toMatchObject({ rule: "phone-adb-forward", holder: "orphan", adbVerb: "forward", source: "test" });
});

test("cmdKind keeps only the program word, past cd and assignments", () => {
  const cases: [unknown, string | undefined][] = [
    ["git status", "git"],
    ["cd /a/b && git status", "git"],
    ["cd '/a b' ; python3 x.py", "python3"],
    ['cd "/a b" && FOO=1 BAR="x y" node run.mjs', "node"],
    ["  /opt/homebrew/bin/python3 -I x.py", "python3"],
    ["X=1 offbox run -- make test", "offbox"],
    ["cd /a && cd /b && bun test", "bun"],
    ["./scripts/secret-tool --token abc", "other"],
    ["", "other"],
    [undefined, undefined],
  ];
  for (const [input, expected] of cases) expect(cmdKind(input)).toBe(expected);
});
