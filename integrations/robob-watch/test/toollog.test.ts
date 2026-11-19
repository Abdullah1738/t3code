import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { logDirectory, rollup, toolLog, toolError } from "../src/toollog.ts";

const before = process.env.TOOLLOG_DIR;

test("test default stays outside the home log tree when the override is absent", () => {
  const previous = process.env.TOOLLOG_DIR;
  delete process.env.TOOLLOG_DIR;
  try {
    const root = logDirectory();
    expect(root.startsWith(join(homedir(), ".robob"))).toBe(false);
    expect(relative(realpathSync(tmpdir()), realpathSync(root)).startsWith("..")).toBe(false);
    expect(logDirectory()).toBe(root);
  } finally {
    if (previous === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = previous;
  }
});
const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "toollog-")); dirs.push(dir); process.env.TOOLLOG_DIR = dir; return dir; };

const credentialErrors = [
  { form: "unquoted assignment", error: "failed password=alpha", expected: "failed password=[redacted]" },
  { form: "unquoted separators", error: "token=alpha, retry; secret=beta; done", expected: "token=[redacted], retry; secret=[redacted]; done" },
  { form: "double quoted whitespace", error: 'password="alpha beta" retry', expected: "password=[redacted] retry" },
  { form: "single quoted whitespace", error: "secret='alpha beta' retry", expected: "secret=[redacted] retry" },
  { form: "double quoted punctuation", error: 'api_key="alpha, beta; gamma" retry', expected: "api_key=[redacted] retry" },
  { form: "single quoted punctuation", error: "api-key='alpha, beta; gamma' retry", expected: "api-key=[redacted] retry" },
  { form: "JSON field", error: '{"token": "alpha beta, gamma; delta"}', expected: '{"token": [redacted]}' },
  { form: "single quoted field", error: "'secret': 'alpha beta'", expected: "'secret': [redacted]" },
  { form: "case and colon", error: 'APIKEY : "alpha beta"', expected: "APIKEY : [redacted]" },
  { form: "escaped double quote", error: 'password="alpha \\"beta, gamma" retry', expected: "password=[redacted] retry" },
  { form: "escaped single quote", error: "password='alpha \\'beta; gamma' retry", expected: "password=[redacted] retry" },
  { form: "empty quoted value", error: 'password="" retry', expected: "password=[redacted] retry" },
  { form: "unterminated double quote", error: 'password="alpha beta, gamma;', expected: "password=[redacted]" },
  { form: "unterminated single quote", error: "secret='alpha beta, gamma;", expected: "secret=[redacted]" },
  { form: "trailing escape", error: 'token="alpha beta\\', expected: "token=[redacted]" },
  { form: "authorization scheme", error: 'authorization="Bearer alpha beta" retry', expected: "authorization=[redacted] retry" },
];
test.each(credentialErrors)("probe logs redact credentials: $form", ({error, expected}) => {
  const dir = fixture();
  toolLog({ component: "runner", kind: "error", name: "watch.pause_probe", props: { error_first_line: error } });
  expect(rows(dir)[0].props).toEqual({ error_first_line: expected });
});

test("cleaned classifier errors survive both sinks only in the triage classifier scope", () => {
  const dir = fixture();
  const error = "TypeError: fixture shape mismatch; at classify:1234; endpoint=https://openrouter.ai/api/v1/chat/completions; elapsed_ms=2; attempts=1";
  const entries = [
    { component: "triage", name: "triage.classify", props: { classifier_error: error } },
    { component: "runner", name: "triage.classify", props: { classifier_error: error } },
    { component: "triage", name: "triage.run", props: { classifier_error: error } },
    ...[null, 1, {}, "x".repeat(401), "invalid\nmessage"].map(value => ({ component: "triage", name: "triage.classify", props: { classifier_error: value } })),
  ].map(entry => ({ ...entry, kind: "perf" as const }));
  for (const entry of entries) toolLog(entry);
  const script = `import json, sys\nsys.path.insert(0, "helpers")\nfrom toollog import tool_log\nfor entry in json.loads(sys.argv[1]): tool_log(entry)\n`;
  const result = Bun.spawnSync(["python3", "-I", "-B", "-c", script, JSON.stringify(entries)], { env: { ...process.env, TOOLLOG_DIR: dir } });
  expect(result.exitCode).toBe(0);
  const all = rows(dir);
  for (const offset of [0, entries.length]) {
    expect(all[offset].props).toEqual({ classifier_error: error });
    expect(all.slice(offset + 1, offset + entries.length).every(row => row.props === undefined)).toBe(true);
  }
});

test("auth log-only metadata is allowlisted identically in Python and TypeScript", () => {
  const dir = fixture();
  const entries = [
    { name: "triage.decision", props: { class: "otp", routed: "logged" } },
    { name: "fastpath.auth_logged", props: { source: "mail", senderLabel: "Claude", authKind: "signin_link" } },
    { name: "fastpath.auth_logged", props: { source: "sms", senderLabel: "an inbox sender", authKind: "otp" } },
    { name: "fastpath.auth_logged", props: { senderLabel: "private@example.test", authKind: "123456", body: "private", link: "https://example.test/private" } },
  ].map(entry => ({ ...entry, component: "triage", kind: "event" as const }));
  for (const entry of entries) toolLog(entry);
  const script = `import json, sys\nsys.path.insert(0, "helpers")\nfrom toollog import tool_log\nfor entry in json.loads(sys.argv[1]): tool_log(entry)\n`;
  const result = Bun.spawnSync(["python3", "-I", "-B", "-c", script, JSON.stringify(entries)], { env: { ...process.env, TOOLLOG_DIR: dir } });
  expect(result.exitCode).toBe(0);
  const all = rows(dir);
  for (const offset of [0, entries.length]) {
    for (let i = 0; i < 3; i++) expect(all[offset + i].props).toEqual(entries[i]!.props);
    expect(all[offset + 3].props).toBeUndefined();
  }
});

test.each(["data_read.retried", "data_read.failed", "data_write.retried", "data_write.failed", "runs_log.write_failed"])("%s retains only file fault metadata", name => {
  const dir = fixture();
  const props = { path: "/home/fixture/settings.json", errnoCode: "EDEADLK", attempts: 4, ms: 1750, dataless: true };
  toolLog({ component: "triage", kind: "error", name, props: { ...props, body: "private" } });
  expect(rows(dir)[0].props).toEqual(props);
  for (const path of ["private body", "/file\nprivate", "/" + "x".repeat(1024)]) {
    toolLog({ component: "triage", kind: "error", name, props: { path } });
  }
  expect(rows(dir).slice(1).every(row => row.props === undefined)).toBe(true);
});
const emptyBreakdown = {
  loadMode: { minutes: 0, switches: 0 },
  byDependency: {}, dependencyTotals: { dependencies: 0, busyRuns: 0 },
  slots: { allSlotsBusyMinutes: 0, topHolders: [] },
  byWatcher: {}, watcherTotals: { watchers: 0, runs: 0, outcomes: { no_change: 0, fire: 0, fail: 0, timeout: 0, busy: 0 }, fires: 0 },
  byHelper: {}, helperTotals: { helpers: 0, runs: 0, failures: 0, exitCodes: {} }, errorsByTagAndSource: [], hourly: [], markers: [],
  wake: { attempts: 0, sent: 0, failed: 0, replyGuard: { total: 0, blocked: 0, accepted: 0 } },
};
const day = () => new Date().toISOString().slice(0, 10);
const rows = (dir: string) => readFileSync(join(dir, `${day()}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line));
afterEach(() => { if (before === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = before; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test.each([
  ["msgs", true], ["9router", true], ["mail.archive-v2", true], ["a".repeat(64), true],
  ["a".repeat(65), false], ["", false], ["private text", false], ["/private/path", false],
  ["private12345", false], [12345, false], [null, false], [{ name: "msgs" }, false],
] as const)("dependency labels are validated by the writer and rollup: %s", async (dependency, valid) => {
  const dir = fixture();
  toolLog({ component: "runner", kind: "error", name: "watch.run", ids: { watcher: "fixture" },
    props: { outcome: "busy", stderrClass: "dependency_busy", dependency } });
  expect(rows(dir)[0].props.dependency).toBe(valid ? dependency : undefined);
  // An imported or older writer's row must pass the same validation at read time.
  writeFileSync(join(dir, `${day()}.ndjson`), JSON.stringify({ ts: new Date().toISOString(), tool: "watchers",
    component: "runner", kind: "error", name: "watch.run", ids: { watcher: "fixture" }, props: { outcome: "busy", dependency } }) + "\n");
  const result = await rollup(day(), dir);
  expect(result?.byWatcher.fixture?.outcomes.busy).toBe(1);
  expect(Object.keys(result!.byDependency)).toEqual(valid ? [dependency as string] : []);
});

test("slot snapshots retain only sanitized holder ids and valid elapsed times", () => {
  const dir = fixture();
  toolLog({ component: "runner", kind: "perf", name: "slot.backlog", props: { depth: 2, active: 2, cap: 2, oldestWaitMs: 60_000,
    holders: [{ watcher: "flighty-bookings", elapsedMs: 60_000, secret: "private" }, { watcher: null, elapsedMs: 1 },
      { watcher: {}, elapsedMs: 1 }, { watcher: "valid", elapsedMs: -1 }, { watcher: "valid", elapsedMs: Infinity }, null], request: { secret: "private" } } });
  expect(rows(dir)[0].props).toEqual({ depth: 2, active: 2, cap: 2, oldestWaitMs: 60_000, holders: [{ watcher: "flighty-bookings", elapsedMs: 60_000 }] });
});

test.each([
  ["named", "flighty-bookings", true],
  ["hexadecimal", "abcdefabcdefabcdefabcdef", true],
  ["24 digits", "123456789012345678901234", false],
  ["embedded digits", "watcher-12345", false],
  ["phone", "+971500000000", false],
  ["spaces", "private text", false],
  ["path", "/Users/private", false],
  ["empty", "", false],
  ["long", "a".repeat(81), false],
  ["unicode", "watcher-é", false],
  ["number", 1234567890, false],
] as const)("slot holder ids use the writer's watcher sanitizer: %s", (_shape, watcher, readable) => {
  const dir = fixture();
  for (const name of ["slot.wait", "slot.backlog"]) toolLog({ component: "runner", kind: "perf", name,
    ids: { watcher }, props: { holders: [{ watcher, elapsedMs: 30_000 }] } });
  const expected = readable ? String(watcher) : new Bun.CryptoHasher("sha256").update(String(watcher)).digest("hex").slice(0, 24);
  for (const row of rows(dir)) {
    expect(row.ids.watcher).toBe(expected);
    expect(row.props.holders).toEqual([{ watcher: expected, elapsedMs: 30_000 }]);
  }
});

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

test.each(["native", "status", "send"])("creator fallbacks retain stable %s fields and discard arbitrary reasons", step => {
  const dir = fixture();
  for (const reason of ["timeout", "exit:1", "exit:127", "invalid", "archived", "error", "private payload", "exit:1 secret"]) {
    toolLog({ component: "wakes", kind: "error", name: "wake.creator_fallback", ok: false,
      ids: { watcher: "fixture" }, props: { step, reason, durationMs: 12 } });
  }
  const all = rows(dir);
  expect(all.map(row => row.props.reason)).toEqual(["timeout", "exit:1", "exit:127", "invalid", "archived", "error", undefined, undefined]);
  expect(all.every(row => row.props.step === step && row.props.durationMs === 12)).toBe(true);
});

test.each(["native", "native_retry", "status", "status_retry", "send", "confirm"])("helper runs retain %s attribution and timeout fields", op => {
  const dir = fixture();
  const entries = [false, true].map(timedOut => ({ component: "helpers", kind: "error" as const, name: "helper.run", ok: false,
    ids: { helper: "t3ctl", watcher: "fixture" }, props: { op, timeoutMs: 10_000, timedOut, exitCode: 137 } }));
  for (const entry of entries) toolLog(entry);
  const script = `import json, sys\nsys.path.insert(0, "helpers")\nfrom toollog import tool_log\nfor entry in json.loads(sys.argv[1]): tool_log(entry)\n`;
  const result = Bun.spawnSync(["python3", "-I", "-B", "-c", script, JSON.stringify(entries)], { env: { ...process.env, TOOLLOG_DIR: dir } });
  expect(result.exitCode).toBe(0);
  expect(rows(dir).map(row => ({ ids: row.ids, props: row.props }))).toEqual([false, true, false, true].map(timedOut => ({
    ids: { helper: "t3ctl", watcher: "fixture" }, props: { op, timeoutMs: 10_000, timedOut, exitCode: 137 },
  })));
});

test("helper attribution drops arbitrary operations and invalid timeout fields", () => {
  const dir = fixture();
  const entry = { component: "helpers", kind: "error" as const, name: "helper.run",
    props: { op: "private payload", timeoutMs: Infinity, timedOut: "true", exitCode: 137 } };
  toolLog(entry);
  const script = `import json, sys\nsys.path.insert(0, "helpers")\nfrom toollog import tool_log\ntool_log(json.loads(sys.argv[1]))\n`;
  const result = Bun.spawnSync(["python3", "-I", "-B", "-c", script, JSON.stringify(entry)], { env: { ...process.env, TOOLLOG_DIR: dir } });
  expect(result.exitCode).toBe(0);
  expect(rows(dir).map(row => row.props)).toEqual([{ exitCode: 137 }, { exitCode: 137 }]);
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
  expect(result).toMatchObject({ total: 6, counts: { "watch.run": 6 }, kinds: { perf: 5, error: 1 }, ok: 5, failed: 1, okRate: 5 / 6, errorRate: 1 / 6, durations: { "watch.run": { count: 6, p50: 3, p95: 100, max: 100 } }, errors: [{ tag: "watch.timeout", count: 1, topSources: [{ source: "watcher", id: "fixture", count: 1 }] }] });
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

function canReadMode000(kind: "file" | "directory"): boolean {
  const root = mkdtempSync(join(tmpdir(), "toollog-permissions-"));
  const parent = join(root, "parent"), file = join(parent, "probe");
  mkdirSync(parent); writeFileSync(file, "probe");
  const target = kind === "file" ? file : parent;
  try {
    chmodSync(target, 0o000);
    try { readFileSync(file); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") return false;
      throw error;
    }
  } finally {
    chmodSync(target, kind === "file" ? 0o600 : 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

test.skipIf(canReadMode000("file"))("an unreadable day file still fails", async () => {
  const dir = fixture(), fixtureDay = "2000-01-01", file = join(dir, `${fixtureDay}.ndjson`);
  writeFileSync(file, ""); chmodSync(file, 0o000);
  expect(await rollup(fixtureDay)).toBeUndefined();
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "log-rollup", "--day", fixtureDay], {
    env: { ...process.env, ROBOB_WATCH_ROOT: join(dir, "watchers-root") },
  });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain("Could not roll up UTC day");
});

test.skipIf(canReadMode000("directory"))("a missing log directory beneath an inaccessible parent still fails", async () => {
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

test("relay metadata keeps bounded values and rejects text in every new field", () => {
  const dir = fixture();
  const secret = "private event and context must never be logged";
  const numeric = { events: 6, waitMs: 150000, spanMs: 150000, graceMs: 900000, relays: 1 };
  const flags = { batched: true, urgent: false, closing: true, archived: false, frozenContext: true, batchOpen: false, grace: false };
  toolLog({ component: "wakes", kind: "event", name: "wake.batch_sealed", props: { ...numeric, ...flags, route: "person", via: "wake" } });
  toolLog({ component: "cli", kind: "event", name: "watch.grace_ended", props: { reason: "resume", relays: 1 } });
  const props = Object.fromEntries([...Object.keys(numeric), ...Object.keys(flags), "route", "via", "reason"].map(key => [key, secret]));
  toolLog({ component: "wakes", kind: "event", name: "wake.sent", props });
  expect(rows(dir)[0].props).toEqual({ ...numeric, ...flags, route: "person", via: "wake" });
  expect(rows(dir)[1].props).toEqual({ reason: "resume", relays: 1 });
  expect(rows(dir)[2].props).toBeUndefined();
  expect(JSON.stringify(rows(dir))).not.toContain(secret);
});

test('queued wakes retain route and confirmation metadata and count as sent only after confirmation', async () => {
  const dir = fixture();
  toolLog({ component: 'wakes', kind: 'event', name: 'wake.sent', ok: false,
    props: { via: 'thread:abcd1234', confirmed: 'pending', accepted: true } });
  toolLog({ component: 'wakes', kind: 'event', name: 'wake.sent', ok: false,
    props: { via: 'wake:owner-fallback', meant_for: 'abcd1234', confirmed: 'pending', accepted: true } });
  expect(rows(dir).map(row => row.props)).toEqual([
    { via: 'thread:abcd1234', confirmed: 'pending', accepted: true },
    { via: 'wake:owner-fallback', meant_for: 'abcd1234', confirmed: 'pending', accepted: true },
  ]);
  expect((await rollup(day(), dir))?.wake).toMatchObject({ attempts: 2, sent: 0, failed: 0 });
  toolLog({ component: 'wakes', kind: 'event', name: 'wake.confirmed', ok: true, durationMs: 1_000 });
  toolLog({ component: 'wakes', kind: 'error', name: 'wake.unconfirmed', ok: false, durationMs: 600_000 });
  expect((await rollup(day(), dir))?.wake).toMatchObject({ attempts: 2, sent: 1, failed: 1 });
});
