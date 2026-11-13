import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollup, toolLog, toolError } from "../src/toollog.ts";

const before = process.env.TOOLLOG_DIR;
const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "toollog-")); dirs.push(dir); process.env.TOOLLOG_DIR = dir; return dir; };
const emptyBreakdown = {
  byWatcher: {}, watcherTotals: { watchers: 0, runs: 0, outcomes: { no_change: 0, fire: 0, fail: 0, timeout: 0 }, fires: 0 },
  byHelper: {}, helperTotals: { helpers: 0, runs: 0, failures: 0, exitCodes: {} }, errorsByTagAndSource: [],
  wake: { attempts: 0, sent: 0, failed: 0, replyGuard: { total: 0, blocked: 0, accepted: 0 } },
};
const day = () => new Date().toISOString().slice(0, 10);
const rows = (dir: string) => readFileSync(join(dir, `${day()}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line));
afterEach(() => { if (before === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = before; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("watcher and Telegram loggers share the same private, allowlisted format", async () => {
  const dir = fixture();
  const secret = "private subject OTP 123456 password=abcdef card 4111111111111111 /Users/private/message.txt";
  const entry = { component: "runner", kind: "perf" as const, name: "watch.run", durationMs: 2, ok: true,
    ids: { watcher: "fixture", key: secret, password: secret, path: secret },
    props: { outcome: "fire", exitCode: 0, subject: secret, health: 88, source: secret, severity: "info", path: secret, message: secret },
    error: { tag: "fixture.failure", message: secret } };
  toolLog(entry);
  for (const path of ["../../telegram-bridge/src/toollog.ts"]) {
    const copy = await import(path);
    copy.toolLog(entry);
  }
  const all = rows(dir);
  expect(all).toHaveLength(2);
  expect(all[1]).toEqual({ ...all[0], ts: all[1].ts });
  for (const row of all) {
    expect(row).toEqual({ ts: expect.any(String), tool: "watchers", component: "runner", kind: "perf", name: "watch.run", ok: true, durationMs: 2, ids: { watcher: "fixture", key: expect.stringMatching(/^[a-f0-9]{24}$/) }, props: { outcome: "fire", exitCode: 0, severity: "info" }, error: { tag: "fixture.failure", message: "fixture.failure" } });
    expect(row.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.ids.password).toBeUndefined();
    expect(row.props.subject).toBeUndefined();
    expect(row.props.health).toBeUndefined();
  }
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, `${day()}.ndjson`)).mode & 0o777).toBe(0o600);
});

test("logging drops IO and serialization failures without raising", () => {
  const dir = fixture(); process.env.TOOLLOG_DIR = join(dir, "blocked"); writeFileSync(process.env.TOOLLOG_DIR, "file");
  expect(() => toolLog({ component: "runner", kind: "event", name: "watch.run" })).not.toThrow();
  expect(() => toolLog({ get component(): string { throw new Error("private"); }, kind: "event", name: "watch.run" })).not.toThrow();
});

test("retention runs on first write and the shared cap keeps errors once event/perf stop", async () => {
  const dir = fixture();
  const old = "2000-01-01";
  writeFileSync(join(dir, `${old}.ndjson`), "old"); writeFileSync(join(dir, `rollup-${old}.json`), "old");
  writeFileSync(join(dir, "unrelated.txt"), "keep");
  toolLog({ component: "runner", kind: "event", name: "watch.run" });
  expect(readdirSync(dir)).not.toContain(`${old}.ndjson`); expect(readdirSync(dir)).not.toContain(`rollup-${old}.json`);
  expect(readdirSync(dir)).toContain("unrelated.txt");
  const file = join(dir, `${day()}.ndjson`), cap = 50 * 1024 * 1024 + 1;
  truncateSync(file, cap);
  const copy = await import("../../telegram-bridge/src/toollog.ts");
  toolLog({ component: "runner", kind: "event", name: "dropped.event" });
  copy.toolLog({ component: "wakes", kind: "perf", name: "dropped.perf" });
  toolLog({ component: "runner", kind: "error", name: "retained.error", ok: false, error: { tag: "fixture.failure" } });
  copy.toolLog({ component: "telegram", kind: "error", name: "retained.copy_error", ok: false, error: { tag: "fixture.failure" } });
  const tail = readFileSync(file).subarray(cap).toString();
  expect(tail.match(/"name":"log.cap"/g)).toHaveLength(1);
  if (process.env.TOOLLOG_SAMPLES) console.log("LOG_SAMPLE " + tail.trim().split("\n")[0]);
  expect(tail).toContain('"name":"retained.error"'); expect(tail).not.toContain("dropped.");
  expect(tail).toContain('"name":"retained.copy_error"');
});

test("rollup counts fixture names/kinds, rates, percentiles and top error tags, skipping malformed lines", async () => {
  const dir = fixture();
  for (const ms of [1, 2, 3, 4, 100]) toolLog({ component: "runner", kind: "perf", name: "watch.run", durationMs: ms, ok: true });
  toolLog({ component: "runner", kind: "error", name: "watch.run", durationMs: 8, ok: false, ids: { watcher: "fixture" }, error: { tag: "watch.timeout" } });
  const result = await rollup(day());
  expect(result).toMatchObject({ total: 6, counts: { "watch.run": 6 }, kinds: { perf: 5, error: 1 }, ok: 5, failed: 1, okRate: 5 / 6, errorRate: 1 / 6, durations: { "watch.run": { count: 6, p50: 3, p95: 100, max: 100 } }, errors: [{ tag: "watch.timeout", count: 1, sampleId: "fixture" }] });
  expect(statSync(join(dir, `rollup-${day()}.json`)).mode & 0o777).toBe(0o600);
  expect(await rollup("../../secret")).toBeUndefined();
  expect(await rollup("2026-02-30")).toBeUndefined();
});

test("a missing day writes and prints an empty rollup with exit 0", async () => {
  const dir = fixture(), emptyDay = "2000-01-01";
  const expected = { day: emptyDay, tool: "watchers", total: 0, counts: {}, kinds: {}, ok: 0, failed: 0, okRate: null, errorRate: 0, durations: {}, errors: [], ...emptyBreakdown };
  expect(await rollup(emptyDay)).toEqual(expected);
  const target = join(dir, `rollup-${emptyDay}.json`);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(expected);
  expect(statSync(target).mode & 0o777).toBe(0o600);
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "log-rollup", "--day", "2000-01-02"], {
    env: { ...process.env, ROBOB_WATCH_ROOT: join(dir, "watchers-root") },
  });
  expect(child.exitCode).toBe(0);
  const cliExpected = { ...expected, day: "2000-01-02" };
  expect(JSON.parse(child.stdout.toString())).toEqual(cliExpected);
  expect(JSON.parse(readFileSync(join(dir, "rollup-2000-01-02.json"), "utf8"))).toEqual(cliExpected);
  expect(statSync(join(dir, "rollup-2000-01-02.json")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(dir, `${emptyDay}.ndjson`))).toBe(false);
  expect(existsSync(join(dir, "2000-01-02.ndjson"))).toBe(false);
});

test.each(["logs", "new-parent/logs"])("CLI creates missing log directory %s for an empty day", relativeDir => {
  const root = fixture(), dir = join(root, relativeDir), emptyDay = "2000-01-01";
  expect(existsSync(dir)).toBe(false);
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "log-rollup", "--day", emptyDay], {
    env: { ...process.env, TOOLLOG_DIR: dir, ROBOB_WATCH_ROOT: join(root, "watchers-root") },
  });
  expect(child.exitCode).toBe(0);
  const expected = { day: emptyDay, tool: "watchers", total: 0, counts: {}, kinds: {}, ok: 0, failed: 0, okRate: null, errorRate: 0, durations: {}, errors: [], ...emptyBreakdown };
  expect(JSON.parse(child.stdout.toString())).toEqual(expected);
  const target = join(dir, `rollup-${emptyDay}.json`);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(expected);
  expect(statSync(target).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "..")).mode & 0o777).toBe(0o700);
  expect(existsSync(join(dir, `${emptyDay}.ndjson`))).toBe(false);
});

test.each(["../../secret", "2026-02-30", "2026-13-01"])("invalid day %s still fails", async invalidDay => {
  const dir = fixture();
  expect(await rollup(invalidDay)).toBeUndefined();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "log-rollup", "--day", invalidDay], {
    env: { ...process.env, ROBOB_WATCH_ROOT: join(dir, "watchers-root") },
  });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain("Could not roll up UTC day");
  expect(readdirSync(dir).some(name => name.startsWith("rollup-"))).toBe(false);
});

test.each(["empty file", "dangling symlink"])("a day with an %s gives an empty rollup", async source => {
  const dir = fixture(), fixtureDay = "2000-01-01", file = join(dir, `${fixtureDay}.ndjson`);
  if (source === "empty file") writeFileSync(file, "");
  else symlinkSync(join(dir, "missing.ndjson"), file);
  expect(await rollup(fixtureDay)).toMatchObject({ day: fixtureDay, total: 0, counts: {}, kinds: {}, durations: {}, errors: [] });
  expect(statSync(join(dir, `rollup-${fixtureDay}.json`)).mode & 0o777).toBe(0o600);
});

test.each(["read", "write", "symlink loop", "non-directory parent"])("rollup %s errors still fail", async operation => {
  const dir = fixture(), fixtureDay = "2000-01-01";
  const logDir = operation === "non-directory parent" ? join(dir, "blocked") : dir;
  if (operation === "read") mkdirSync(join(dir, `${fixtureDay}.ndjson`));
  else if (operation === "write") mkdirSync(join(dir, `rollup-${fixtureDay}.json`));
  else if (operation === "symlink loop") symlinkSync(`${fixtureDay}.ndjson`, join(dir, `${fixtureDay}.ndjson`));
  else writeFileSync(logDir, "file");
  expect(await rollup(fixtureDay, logDir)).toBeUndefined();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "log-rollup", "--day", fixtureDay], {
    env: { ...process.env, TOOLLOG_DIR: logDir, ROBOB_WATCH_ROOT: join(dir, "watchers-root") },
  });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain("Could not roll up UTC day");
});

test.skipIf(process.getuid?.() === 0)("an unreadable day file still fails", async () => {
  const dir = fixture(), fixtureDay = "2000-01-01", file = join(dir, `${fixtureDay}.ndjson`);
  writeFileSync(file, ""); chmodSync(file, 0o000);
  expect(await rollup(fixtureDay)).toBeUndefined();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "log-rollup", "--day", fixtureDay], {
    env: { ...process.env, ROBOB_WATCH_ROOT: join(dir, "watchers-root") },
  });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain("Could not roll up UTC day");
});

test.skipIf(process.getuid?.() === 0)("a missing log directory beneath an inaccessible parent still fails", async () => {
  const root = fixture(), parent = join(root, "blocked"), dir = join(parent, "logs"), emptyDay = "2000-01-01";
  mkdirSync(parent); chmodSync(parent, 0o000);
  try {
    expect(await rollup(emptyDay, dir)).toBeUndefined();
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "log-rollup", "--day", emptyDay], {
      env: { ...process.env, TOOLLOG_DIR: dir, ROBOB_WATCH_ROOT: join(root, "watchers-root") },
    });
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString()).toContain("Could not roll up UTC day");
  } finally { chmodSync(parent, 0o700); }
  expect(existsSync(dir)).toBe(false);
});


test("error helper emits only a stable tag for each component", () => {
  const dir = fixture();
  for (const component of ["runner", "cli", "telegram"]) toolError(component, "fixture.failed");
  expect(rows(dir).map(row => row.name)).toEqual(["runner.error", "cli.error", "telegram.error"]);
  expect(rows(dir).every(row => row.kind === "error" && row.ok === false && row.error.message === "fixture.failed")).toBe(true);
  if (process.env.TOOLLOG_SAMPLES) for (const row of rows(dir)) console.log("LOG_SAMPLE " + JSON.stringify(row));
});
