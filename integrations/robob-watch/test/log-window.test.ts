import { afterEach, expect, setSystemTime, test } from "bun:test";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollup } from "../src/toollog.ts";

const dirs: string[] = [];
const day = "2026-11-13";
const window = { since: `${day}T17:30:00Z`, until: `${day}T18:30:00Z` };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rollup-window-")); dirs.push(dir);
  copyFileSync(join(import.meta.dir, "fixtures/rollup-window.ndjson"), join(dir, `${day}.ndjson`));
  return dir;
}
const cli = (dir: string, args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "log-rollup", ...args], {
  env: { ...process.env, TOOLLOG_DIR: dir, ROBOB_WATCH_ROOT: join(dir, "unused-root") },
});
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("window boundaries, dominant sources, UTC hours and 30-minute marker rates", async () => {
  const dir = fixture();
  const result = await rollup(window, dir);
  expect(result).toMatchObject({ since: `${day}T17:30:00.000Z`, until: `${day}T18:30:00.000Z`, total: 9, kinds: { error: 7, event: 1, perf: 1 } });
  expect(result?.errors[0]).toEqual({ tag: "helper.exit_failed", count: 3, topSources: [
    { source: "helper", id: "ride-card", count: 2 }, { source: "helper", id: "first-source", count: 1 },
  ] });
  expect(result?.hourly).toEqual([
    { hour: `${day}T17:00:00Z`, errors: [
      { tag: "helper.exit_failed", source: "helper", id: "ride-card", count: 2 },
      { tag: "helper.exit_failed", source: "helper", id: "first-source", count: 1 },
      { tag: "watch.check_failed", source: "watcher", id: "test-watch", count: 1 },
      { tag: "watch.timeout", source: "watcher", id: "test-watch", count: 1 },
    ], watchRun: { count: 2, fail: 1, timeout: 1, p95: 100 } },
    { hour: `${day}T18:00:00Z`, errors: [{ tag: "bridge.failed", source: "component", id: "telegram", count: 2 }], watchRun: { count: 1, fail: 0, timeout: 0, p95: 2 } },
  ]);
  expect(result?.markers).toEqual([{ ts: `${day}T18:00:00.000Z`, service: "robob-watch", sha: "abcdef1", step: "restart.complete",
    before: { errors: 5, minutes: 30, errorsPerMinute: 5 / 30, complete: true }, after: { errors: 2, minutes: 30, errorsPerMinute: 2 / 30, complete: true },
  }]);
  expect(readdirSync(dir)).toEqual([`${day}.ndjson`]);
  const narrow = await rollup({ since: `${day}T18:00:00Z`, until: `${day}T18:00:01Z` }, dir);
  expect(narrow?.total).toBe(2);
  expect(narrow?.markers).toEqual(result?.markers);
});

test("CLI stdout and private --out leave the daily report and watcher state untouched", async () => {
  const dir = fixture(), daily = join(dir, `rollup-${day}.json`);
  writeFileSync(daily, "daily sentinel");
  const args = ["--since", window.since, "--until", window.until];
  const child = cli(dir, args);
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString()).total).toBe(9);
  const out = join(dir, "nested/window.json"), saved = cli(dir, [...args, "--out", out]);
  expect(saved.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(JSON.parse(saved.stdout.toString()));
  expect(statSync(out).mode & 0o777).toBe(0o600);
  expect(cli(dir, [...args, "--out", daily]).exitCode).toBe(1);
  expect(cli(dir, [...args, "--out", join(dir, `ROLLUP-${day}.JSON`)]).exitCode).toBe(1);
  for (const kind of ["symlink", "hardlink"]) {
    const alias = join(dir, `${kind}.json`);
    if (kind === "symlink") symlinkSync(daily, alias); else linkSync(daily, alias);
    expect(cli(dir, [...args, "--out", alias]).exitCode).toBe(0);
    expect(readFileSync(daily, "utf8")).toBe("daily sentinel");
  }
  expect(readFileSync(daily, "utf8")).toBe("daily sentinel");
  expect(existsSync(join(dir, "unused-root"))).toBe(false);
});

test.each([
  ["--since", window.since], ["--until", window.until], ["--since", window.since, "--until", window.until, "--day", day],
  ["--since", window.until, "--until", window.since], ["--since", window.since, "--until", window.since],
  ...["bad", "2026-02-30T17:00:00Z", "2026-11-13", "2026-11-13T18:00:00", "2026-11-13T24:00:00Z", "2026-11-13T17:60:00Z", "2026-11-13T17:00:60Z", "2026-11-13T17:00:00+00:60"].map(since => ["--since", since, "--until", window.until]),
])("CLI rejects invalid window %j", (...args) => {
  const dir = fixture();
  expect(cli(dir, args).exitCode).toBe(1);
  expect(readdirSync(dir)).not.toContain(`rollup-${day}.json`);
});

test("offsets and multi-day windows; marker halo reads adjacent UTC days", async () => {
  const dir = fixture(), next = "2026-11-14";
  const event = (ts: string) => JSON.stringify({ ts, tool: "watchers", component: "runner", kind: "error", name: "runner.error", error: { tag: "watch.failed" } });
  writeFileSync(join(dir, `${day}.ndjson`), [event(`${day}T23:45:00Z`), JSON.stringify({ ts: `${day}T23:59:00Z`, tool: "watchers", kind: "event", name: "deploy.marker", props: { service: "robob-watch", sha: "abcdef1", step: "restart.complete" } })].join("\n"));
  writeFileSync(join(dir, `${next}.ndjson`), event(`${next}T00:05:00Z`));
  const result = await rollup({ since: "2026-11-14T03:45:00+04:00", until: `${next}T00:10:00Z` }, dir);
  expect(result?.total).toBe(3);
  expect(result?.hourly.map(row => row.hour)).toEqual([`${day}T23:00:00Z`, `${next}T00:00:00Z`]);
  const daily = await rollup(day, dir);
  expect(daily?.total).toBe(2);
  expect(daily?.markers[0]).toMatchObject({ before: { errors: 1 }, after: { errors: 1 } });
});

test("hourly pairs and topSources have bounded, deterministic rankings; no raw payloads", async () => {
  const dir = fixture(), rows = [];
  for (let i = 0; i < 20; i++) for (let n = 0; n <= i; n++) rows.push(JSON.stringify({ ts: `${day}T17:45:00Z`, tool: "watchers", component: "helper", kind: "error", name: "helper.run", ids: { helper: `helper-${i}` }, error: { tag: "helper.failed", message: "password=private" } }));
  rows.push(JSON.stringify({ ts: `${day}T17:46:00Z`, tool: "watchers", kind: "event", name: "deploy.marker", props: { service: "private password", sha: "abcdef1", step: "complete", payload: "private" } }));
  writeFileSync(join(dir, `${day}.ndjson`), rows.join("\n"));
  const result = await rollup(window, dir);
  expect(result?.hourly[0]?.errors).toHaveLength(10);
  expect(result?.hourly[0]?.errors[0]).toMatchObject({ id: "helper-19", count: 20 });
  expect(result?.errors[0]?.topSources).toHaveLength(3);
  expect(result?.markers).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("private");
});

test("empty window and broken input/output paths", async () => {
  const dir = fixture();
  expect(await rollup({ since: "2020-01-01T00:00:00Z", until: "2020-01-02T00:00:00Z" }, dir)).toMatchObject({ total: 0, hourly: [], markers: [] });
  const broken = join(dir, "2026-11-14.ndjson"); mkdirSync(broken);
  expect(await rollup({ since: window.since, until: "2026-11-15T00:00:00Z" }, dir)).toBeUndefined();
  expect(await rollup(window, dir, join(dir, `${day}.ndjson`))).toBeUndefined();
});


test.each(["2026-11-13.ndjson", "2026-11-13.NDJSON", "2026-11-13.NdJsOn", "rollup-2026-11-13.json", "ROLLUP-2026-11-13.JSON", "Rollup-2026-11-13.Json"])("window rejects reserved output filename %s", async name => {
  const dir = fixture(), source = join(dir, `${day}.ndjson`), original = readFileSync(source);
  expect(await rollup(window, dir, join(dir, name))).toBeUndefined();
  expect(readFileSync(source)).toEqual(original);
});

test("marker comparison declares an unelapsed post-release window incomplete", async () => {
  const dir = fixture();
  try {
    setSystemTime(new Date(`${day}T18:05:00Z`));
    const result = await rollup(window, dir);
    expect(result?.markers[0]).toMatchObject({ before: { complete: true }, after: { complete: false } });
    setSystemTime(new Date(`${day}T18:30:00Z`));
    expect((await rollup(window, dir))?.markers[0]?.after.complete).toBe(true);
  } finally { setSystemTime(); }
});
