import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize, runCheck, triggerSig } from "../src/lib.ts";
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

test("missing trigger files include errno, watcher and kind without their path", () => {
  const dir = fixture();
  const watcher = normalize({ mode: "notify", id: "fixture", title: "PRIVATE", check: "true", triggers: [join(dir, "PRIVATE"), join(dir, "PRIVATE-wal")] });
  expect(triggerSig(watcher)).toBe("missing|missing");
  expect(rows().map(row => ({ ids: row.ids, props: row.props, error: row.error.tag }))).toEqual([
    { ids: { watcher: "fixture" }, props: { errnoCode: "ENOENT", triggerKind: "file" }, error: "watch.trigger_stat_failed" },
    { ids: { watcher: "fixture" }, props: { errnoCode: "ENOENT", triggerKind: "wal" }, error: "watch.trigger_stat_failed" },
  ]);
  expect(JSON.stringify(rows())).not.toContain("PRIVATE");
  expect(JSON.stringify(rows())).not.toContain(dir);
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
  toolLog({ component: "runner", kind: "error", name: "fixture.failed", props: { stderrClass: "PRIVATE", stderrHash: "PRIVATE", stderrLines: -1, errnoCode: "PRIVATE", triggerKind: "/PRIVATE", signal: "PRIVATE", timedOut: "PRIVATE", stderr: "PRIVATE" } });
  expect(rows()[0].props).toBeUndefined();
});

test("failed log writes preserve the helper's exit and stderr", async () => {
  const dir = fixture(); process.env.TOOLLOG_DIR = join(dir, "blocked"); writeFileSync(process.env.TOOLLOG_DIR, "file");
  const result = await runCheck(normalize({ mode: "notify", id: "fixture", title: "x", check: "print -u2 'PRIVATE permission denied'; exit 2" }), dir);
  expect(result).toMatchObject({ code: 2, stderr: "PRIVATE permission denied\n" });
});
