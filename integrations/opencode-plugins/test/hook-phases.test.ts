import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOKS_CAP_BYTES, HOOK_PHASES, HOOK_SAMPLE_RATE, emit, hook } from "../lib/toollog";
import { classifierPhases, runClassifier } from "../lib/classifier";
import * as rootwide from "../plugin/rootwide-search-guard";
import * as quint from "../plugin/quint-verify-guard";
import * as shared from "../plugin/shared-deps-guard";
import * as phone from "../plugin/phone-adb-guard";

const temp = mkdtempSync(join(tmpdir(), "hook-phases-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let sampling: ReturnType<typeof spyOn>;
beforeEach(() => { process.env.TOOLLOG_ROOT = join(temp, "logs"); sampling = spyOn(Math, "random").mockReturnValue(0); });
afterEach(() => sampling.mockRestore());
const python = process.env.HARNESS_TEST_PYTHON ?? "/opt/homebrew/bin/python3";
const logFile = () => join(temp, "logs/agent-tools", new Date().toISOString().slice(0, 10) + ".ndjson");
const parse = (line: string) => { try { return JSON.parse(line); } catch { return null; } };
const rows = () => readFileSync(logFile(), "utf8").split("\n").map(parse).filter((row) => row?.name === "hook.decision");
const script = (name: string, body: string) => { const path = join(temp, name); writeFileSync(path, body); return path; };
const phaseKeys = (props: Record<string, unknown>) => Object.keys(props).filter((key) => (HOOK_PHASES as readonly string[]).includes(key)).sort();
const secret = "phase-fixture-secret-7c1";
const command = `git log --format=${secret}`;
const messages = { timeout: "fixture classifier timed out", unavailable: "fixture classifier unavailable" };

test("a classifier timeout row names spawn and classify time, measured, for every guard", async () => {
  const slow = script("slow.py", "import time; time.sleep(5)");
  for (const [label, guard] of [["rootwide-search", rootwide], ["quint-verify", quint], ["shared-dependencies", shared], ["phone-adb", phone]] as const) {
    const run = guard.createGuardHook("/checkout", (() => runClassifier(python, slow, {}, messages)) as never);
    await run({ tool: "bash", sessionID: "fixture-session", input: { command } });
    const row = rows().at(-1);
    expect(row.props.guard).toBe(label);
    expect(row.durationMs).toBeGreaterThan(2000);
    expect(phaseKeys(row.props)).toEqual(["classify_ms", "spawn_ms"]);
    expect(Number.isInteger(row.props.classify_ms)).toBe(true);
    expect(row.props.classify_ms).toBeGreaterThanOrEqual(1990);
    expect(row.props.classify_ms + row.props.spawn_ms).toBeLessThanOrEqual(Math.ceil(row.durationMs));
    expect(row.props.sampleRate).toBeUndefined();
  }
  expect(readFileSync(logFile(), "utf8")).not.toContain(secret);
}, 30000);

test("fast classifier rows keep sampling and carry no phase fields", async () => {
  const fast = script("fast.py", 'print(\'{"root": null, "reason": null}\')');
  const run = rootwide.createGuardHook("/checkout", (() => runClassifier(python, fast, {}, messages)) as never);
  await run({ tool: "bash", sessionID: "fixture-session", input: { command } });
  const row = rows().at(-1);
  expect(row.durationMs).toBeLessThan(2000);
  expect(phaseKeys(row.props)).toEqual([]);
  expect(row.props.sampleRate).toBe(HOOK_SAMPLE_RATE);
});

test("successful verdicts carry their timings; injected verdicts and other errors carry none", async () => {
  const verdict = await runClassifier(python, script("ok.py", 'print(\'{"root": null}\')'), {}, messages);
  const phases = classifierPhases(verdict);
  expect(Object.keys(phases).sort()).toEqual(["classify_ms", "spawn_ms"]);
  expect(JSON.stringify(verdict)).toBe('{"root":null}');
  expect(classifierPhases({ root: null })).toEqual({});
  expect(classifierPhases(new TypeError(secret))).toEqual({});
  expect(classifierPhases(null)).toEqual({});
  // A slow row whose writer measured nothing stays unphased rather than estimated.
  hook("statev2", "allowed", "no-policy", performance.now() - 2500, command, undefined, { sessionId: "fixture-session" });
  const row = rows().at(-1);
  expect(row.durationMs).toBeGreaterThan(2000);
  expect(phaseKeys(row.props)).toEqual([]);
  expect(row.props.sampleRate).toBeUndefined();
});

test("phase fields keep only known names and non-negative numbers, rounded", () => {
  hook("shell", "allowed", "no-policy", performance.now() - 3000, command, undefined, {}, {}, {},
    { classify_ms: 2999.6, spawn_ms: -1, identity_ms: Number.NaN, mask_ms: secret, cmd: secret, log_write_ms: true });
  const row = rows().at(-1);
  expect(phaseKeys(row.props)).toEqual(["classify_ms"]);
  expect(row.props.classify_ms).toBe(3000);
  expect(JSON.stringify(row)).not.toContain(secret);
});

test("slow rows survive the hooks cap and the sampler; fast allowed rows do not", () => {
  emit("hooks", "perf", "fixture.fill");
  truncateSync(logFile(), HOOKS_CAP_BYTES);
  sampling.mockReturnValue(0.99);
  const before = rows().length;
  for (let i = 0; i < 3; i++) {
    hook("shell", "allowed", "no-policy", performance.now() - 5, command);
    hook("shell", "rewritten", "no-policy", performance.now() - 2600, command, undefined, {}, {}, {}, { classify_ms: 2590 });
  }
  const kept = rows().slice(before);
  expect(kept.length).toBe(3);
  for (const row of kept) {
    expect(row.durationMs).toBeGreaterThan(2000);
    expect(row.props.classify_ms).toBe(2590);
    expect(row.props.sampleRate).toBeUndefined();
  }
});
