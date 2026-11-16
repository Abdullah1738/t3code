import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize, runCheck, TriggerError, triggerSig } from "../src/lib.ts";
import { StderrCause, stderrCause } from "../src/cause.ts";
import { toolLog } from "../src/toollog.ts";
import fixtures from "./stderr-fixtures.json";

const before = process.env.TOOLLOG_DIR;
const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "watch-error-")); dirs.push(dir); process.env.TOOLLOG_DIR = join(dir, "logs"); return dir; };
const rows = () => readFileSync(join(process.env.TOOLLOG_DIR!, `${new Date().toISOString().slice(0, 10)}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line));
afterEach(() => { if (before === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = before; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

for (const [i, input] of fixtures.entries()) for (const exitCode of [1, 2]) {
  test(`check helper cause ${i} (${input.class}) exit ${exitCode}`, async () => {
    const dir = fixture(), script = join(dir, "helper.ts");
    writeFileSync(script, `process.stderr.write(${JSON.stringify(input.stderr)}); process.exit(${exitCode});`);
    const result = await runCheck(normalize({ mode: "notify", id: "fixture", title: "PRIVATE title", check: `${process.execPath} ${script}` }), dir);
    expect(result).toMatchObject({ code: exitCode, signal: null, timedOut: false, stderr: input.stderr });
    const row = rows().find(row => row.name === "helper.run");
    expect(row.props).toMatchObject({ exitCode, stderrClass: input.class, stderrLines: input.lines, stderrHash: expect.stringMatching(/^[a-f0-9]{16}$/) });
    expect(JSON.stringify(rows())).not.toContain("PRIVATE");
    expect(JSON.stringify(rows())).not.toContain(dir);
  });
}

test.each(["PRIVATE", "PRIVATE-wal", "PRIVATE-parent/child"])("absent trigger %s contributes a missing signature", suffix => {
  const dir = fixture(), path = join(dir, suffix);
  const watcher = normalize({ mode: "notify", id: "fixture", title: "PRIVATE", check: "true", triggers: [path] });
  expect(triggerSig(watcher)).toBe("missing");
});

test.each(["PRIVATE", "PRIVATE-wal"])("dangling trigger symlink %s throws safe metadata for the runner", suffix => {
  const dir = fixture(), path = join(dir, suffix);
  symlinkSync(join(dir, "absent"), path);
  const watcher = normalize({ mode: "notify", id: "fixture", title: "PRIVATE", check: "true", triggers: [path] });
  let error: unknown;
  try { triggerSig(watcher); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(TriggerError);
  expect(error).toMatchObject({ errnoCode: "ENOENT", triggerKind: suffix.endsWith("-wal") ? "wal" : "file",
    triggerPathHash: expect.stringMatching(/^[a-f0-9]{16}$/) });
  expect(String(error)).not.toContain("PRIVATE");
  expect(String(error)).not.toContain(dir);
});

test.each(["/Users/private/a123", "\"/Users/private/a b123\"", "'../private/a b123'", "C:\\private\\a123", "~/private/a123"])("hash groups normalized paths %s and numbers", path => {
  const first = stderrCause(`PRIVATE failure 123 ${path}\n`);
  const next = stderrCause("PRIVATE failure 987 /different/private456\n");
  expect(first.stderrHash).toBe(next.stderrHash);
});

test("streaming summary handles chunks, unicode and stderr past the captured limit", async () => {
  const dir = fixture();
  const cause = new StderrCause();
  for (const text of ["usage", ": PRIVATE\r", "\n", "PRIVATE 🐈\n"]) cause.add(text);
  expect(cause.props()).toEqual(stderrCause("usage: PRIVATE\r\nPRIVATE 🐈\n"));
  expect(stderrCause("usage: PRIVATE " + "x".repeat(30000)).stderrClass).toBe("usage_error");
  const script = join(dir, "large.ts");
  writeFileSync(script, 'process.stderr.write("x".repeat(30000) + "\\nPRIVATE: Permission denied\\n"); process.exit(1);');
  await runCheck(normalize({ mode: "notify", id: "fixture", title: "x", check: `${process.execPath} ${script}` }), dir);
  expect(rows()[0].props).toMatchObject({ stderrClass: "permission", stderrLines: 2 });
});

test.each(["signal", "timeout"])("helper %s cause includes process outcome", async type => {
  const dir = fixture();
  const result = await runCheck(normalize({ mode: "notify", id: "fixture", title: "x", check: type === "signal" ? "kill -TERM $$" : "sleep 30" }), dir, {}, type === "timeout" ? 100 : 1000);
  expect(result).toMatchObject({ code: null, signal: type === "signal" ? "SIGTERM" : "SIGKILL", timedOut: type === "timeout" });
  expect(rows()[0].props).toMatchObject({ exitCode: null, signal: result.signal, timedOut: result.timedOut, stderrClass: type === "timeout" ? "timeout" : "unknown" });
});

test("CLI usage and missing-file failures have safe classes", () => {
  const dir = fixture();
  for (const args of [["show", "PRIVATE invalid id"], ["add", "--json", join(dir, "PRIVATE-missing.json")]]) {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], { env: { ...process.env, ROBOB_WATCH_ROOT: join(dir, "root") } });
    expect(child.exitCode).toBe(1);
  }
  expect(rows().filter(row => row.name === "cli.error").map(row => row.props.stderrClass)).toEqual(["usage_error", "missing_file"]);
  expect(JSON.stringify(rows())).not.toContain("PRIVATE");
});

test("cause fields reject free text and malformed metadata at the writer", () => {
  fixture();
  toolLog({ component: "runner", kind: "error", name: "fixture.failed", props: { stderrClass: "PRIVATE", stderrHash: "PRIVATE", stderrLines: -1, errnoCode: "PRIVATE", triggerKind: "/PRIVATE", signal: "PRIVATE", timedOut: "PRIVATE", stderr: "PRIVATE", triggerPathHash: "/PRIVATE", missingSince: "2026-02-30T00:00:00.000Z" } });
  expect(rows()[0].props).toBeUndefined();
});

test("collection source counts survive the metadata writer without free text", () => {
  fixture();
  toolLog({ component: "triage", kind: "error", name: "triage.error", ids: { helper: "mail-worker" },
    props: { failedSources: 2, totalSources: 6, stderr: "PRIVATE", ...stderrCause("PRIVATE authentication failed\n") },
    error: { tag: "collection.failed" } });
  expect(rows()[0]).toMatchObject({ ids: { helper: "mail-worker" },
    props: { failedSources: 2, totalSources: 6, stderrClass: "auth" } });
  expect(JSON.stringify(rows())).not.toContain("PRIVATE");
});

test("failed log writes preserve the helper's exit and stderr", async () => {
  const dir = fixture(); process.env.TOOLLOG_DIR = join(dir, "blocked"); writeFileSync(process.env.TOOLLOG_DIR, "file");
  const result = await runCheck(normalize({ mode: "notify", id: "fixture", title: "x", check: "print -u2 'PRIVATE permission denied'; exit 2" }), dir);
  expect(result).toMatchObject({ code: 2, stderr: "PRIVATE permission denied\n" });
});

test("trigger metadata writer keeps only a hash and canonical timestamp", () => {
  fixture();
  toolLog({ component: "runner", kind: "error", name: "runner.error.repeat", props: {
    triggerPathHash: "1234567890abcdef", missingSince: "2026-11-15T10:31:00.000Z", count: 12, path: "/PRIVATE",
  } });
  expect(rows()[0].props).toEqual({ triggerPathHash: "1234567890abcdef", missingSince: "2026-11-15T10:31:00.000Z", count: 12 });
});
