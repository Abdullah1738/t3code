import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollup, toolLog, toolError } from "../src/toollog.ts";

const before = process.env.TOOLLOG_DIR;
const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "toollog-")); dirs.push(dir); process.env.TOOLLOG_DIR = dir; return dir; };
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
  const copy = await import("../../robob-watch/src/toollog.ts");
  copy.toolLog(entry);
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
  const copy = await import("../../robob-watch/src/toollog.ts");
  toolLog({ component: "runner", kind: "event", name: "dropped.event" });
  copy.toolLog({ component: "wakes", kind: "perf", name: "dropped.perf" });
  toolLog({ component: "runner", kind: "error", name: "retained.error", ok: false, error: { tag: "fixture.failure" } });
  copy.toolLog({ component: "runner", kind: "error", name: "retained.copy_error", ok: false, error: { tag: "fixture.failure" } });
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
  expect(await rollup("2000-01-01")).toMatchObject({ day: "2000-01-01", total: 0 });
});


test("error helper emits only a stable tag for each component", () => {
  const dir = fixture();
  for (const component of ["runner", "cli", "telegram"]) toolError(component, "fixture.failed");
  expect(rows(dir).map(row => row.name)).toEqual(["runner.error", "cli.error", "telegram.error"]);
  expect(rows(dir).every(row => row.kind === "error" && row.ok === false && row.error.message === "fixture.failed")).toBe(true);
  if (process.env.TOOLLOG_SAMPLES) for (const row of rows(dir)) console.log("LOG_SAMPLE " + JSON.stringify(row));
});


test("cause classes never retain arbitrary codes, messages or unapproved fields", () => {
  const dir = fixture();
  const secret = "https://private.invalid/Users/private?token=OTP123456";
  const cases = [
    [{ status: 401, message: secret }, 401],
    [{ code: "ECONNREFUSED", path: secret }, "ECONNREFUSED"],
    [{ cause: { code: "ENOENT", path: secret } }, "ENOENT"],
    [{ code: "ETIMEDOUT" }, "ETIMEDOUT"],
    [new DOMException(secret, "AbortError"), "abort"],
    [new DOMException(secret, "TimeoutError"), "timeout"],
    [new SyntaxError(secret), "decode"],
    [{ causeClass: "timeout", message: secret }, "timeout"],
    [{ status: 0, code: secret, name: secret, causeClass: secret }, "unclassified"],
    [{ status: 999, code: "SECRET_TOKEN" }, "unclassified"],
    [undefined, "non_error"],
    [Object.defineProperty({}, "status", { get() { throw new Error(secret); } }), "unclassified"],
  ] as const;
  for (const [error] of cases) toolError("telegram", "fixture.failed", { directory: secret }, error);
  expect(rows(dir).map(row => row.props.cause)).toEqual(cases.map(([, cause]) => cause));
  expect(rows(dir).every(row => /^[a-f0-9]{24}$/.test(row.ids.directory))).toBe(true);
  toolLog({ component: "telegram", kind: "error", name: "fixture.props", props: { cause: secret, path: secret, url: secret, token: secret, message: secret } });
  expect(rows(dir).at(-1).props).toBeUndefined();
  expect(readFileSync(join(dir, `${day()}.ndjson`), "utf8")).not.toContain(secret);
});


test("stream end logs allow only lifecycle fields and obey the existing event cap", () => {
  const dir = fixture();
  toolLog({ component: "telegram", kind: "event", name: "tg.robob.streamEnd",
    props: { kind: "errorFrame", connectedMs: 85, code: "replica_lag", title: "PRIVATE_TITLE", threadId: "PRIVATE_ID", payload: "PRIVATE_PAYLOAD" } });
  expect(rows(dir)[0].props).toEqual({ kind: "errorFrame", connectedMs: 85, code: "replica_lag" });
  toolLog({ component: "telegram", kind: "event", name: "tg.robob.streamEnd", props: { kind: "PRIVATE_KIND", connectedMs: -1, code: "PRIVATE_CODE" } });
  expect(rows(dir)[1]).not.toHaveProperty("props");
  expect(JSON.stringify(rows(dir))).not.toContain("PRIVATE_");
  const file = join(dir, `${day()}.ndjson`), cap = 50 * 1024 * 1024 + 1;
  truncateSync(file, cap);
  toolLog({ component: "telegram", kind: "event", name: "tg.robob.streamEnd", props: { kind: "clean", connectedMs: 85, code: "none" } });
  const tail = readFileSync(file).subarray(cap).toString();
  expect(tail).toContain('"name":"log.cap"');
  expect(tail).not.toContain("tg.robob.streamEnd");
});
